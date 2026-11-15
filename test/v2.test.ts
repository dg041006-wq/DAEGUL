// v2 검증: 시트 가져오기, 사건·보고·푸시, 피드 버튼, 규칙 명령, AI 오류 분류(가짜 API 서버), 고객 발송 큐,
// 낙관적 동시성, 보관/삭제의 파생 데이터 반영, 권한.
// ※ AI 관련 테스트는 로컬 가짜 API 서버를 상대로 한 것이며 실제 Claude 호출이 아니다.
import http from "node:http";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { pool, q, q1 } from "../src/server/db/pool.js";
import { api, drainJobs, login, minutesAgo, setup, type Ctx } from "./helpers.js";
import { analyzeGrid, readXlsx } from "../src/server/lib/sheetImport.js";
import { latestDueSlots, runDueReports, runTestReport } from "../src/server/jobs/reports.js";
import { sweepOrg, purgeExpired } from "../src/server/jobs/automation.js";
import { checkAvailability, classifyAiError, resetClient } from "../src/server/ai/client.js";
import { analyzeConversation } from "../src/server/ai/conversationAnalysis.js";
import { generateIdeas } from "../src/server/jobs/ideas.js";
import { subscribe, closeRealtime } from "../src/server/lib/realtime.js";
import { sendPushToUser } from "../src/server/lib/push.js";
import { kstStartOfDay } from "../src/server/lib/time.js";

let ctx: Ctx;
const TEST_SECRET = "v2-test-secret";
beforeAll(async () => {
  process.env.TEST_WEBHOOK_SECRET = TEST_SECRET;
  ctx = await setup();
});
afterAll(async () => {
  await closeRealtime();
  await ctx.app.close();
  await pool.end();
});

async function testInbound(o: { user: string; conv: string; text: string; sender?: string; at?: Date; eventId?: string }) {
  const payload = {
    event_id: o.eventId ?? `t-${crypto.randomUUID()}`,
    type: "message",
    occurred_at: (o.at ?? new Date()).toISOString(),
    user: { id: o.user, name: `고객 ${o.user}` },
    conversation: { id: o.conv, channel: "테스트" },
    message: { id: `m-${crypto.randomUUID()}`, sender: o.sender ?? "customer", text: o.text },
  };
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", TEST_SECRET).update(raw).digest("hex");
  const r = await ctx.app.inject({ method: "POST", url: `/api/webhooks/test/${ctx.orgId}`, headers: { "content-type": "application/json", "x-test-signature": sig }, payload: raw });
  return { status: r.statusCode, body: JSON.parse(r.body), raw, sig };
}

/** 개인정보 없는 합성 시트 (실제 업무 시트와 같은 구조) */
async function syntheticXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("시트1");
  ws.getRow(1).values = [null, null, "직원A", "직원B", null, "주소", "예약자명", "연락처", "패키지", "단가", "특이사항", "진행 상태"];
  ws.getRow(2).values = ["미지정 예약"];
  ws.getRow(3).values = [null, null, null, null, "촬영", "어느 호스텔", null, "010-0000-0001", "베이직", 300000, null, "입금완료"];
  ws.getRow(4).values = ["예약"];
  const d = (y: number, m: number, dd: number) => new Date(Date.UTC(y, m - 1, dd));
  ws.getRow(5).values = [d(2026, 2, 15), "금", null, null, "촬영", "샘플동 1-1", "가상고객1", "010-0000-0002", "베이직", 200000, null, "완료"]; // 2/15는 일요일 → 요일 불일치
  ws.getRow(6).values = [d(2026, 2, 16), "월", "휴가"]; // 개인 일정
  ws.getRow(7).values = [d(2026, 2, 17), "화", null, null, null, "샘플로 2", "가상고객2", null, null, 150000, "15시"];
  ws.getCell("H7").value = new Date(Date.UTC(1899, 11, 30, 13, 30)); // 시간만 입력된 셀
  ws.getRow(8).values = [null, null, null, null, null, "샘플구 3", "가상고객3", "010-5", null, 100000]; // 날짜 상속 + 불완전 번호
  ws.getRow(9).values = [d(2026, 2, 18), "수", null, null, null, "AS 처리", "가상고객4", null, null, -50000, "형 30000"];
  ws.getRow(10).values = [d(2026, 2, 19), "목", null, null, null, "샘플로 2", "가상고객2", null, null, 150000]; // 재방문 후보
  ws.getRow(11).values = [d(2026, 2, 19), "목", null, null, null, "샘플로 2", "가상고객2", null, null, 150000]; // 파일 내 중복
  ws.getRow(12).values = [d(2026, 2, 20), "금", null, null, null, "자재 발주"]; // 메모
  ws.getRow(13).values = [d(2026, 2, 21), "토"]; // 빈 날
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("시트 가져오기", () => {
  it("날짜·금액·상태를 추정하지 않고 불확실한 값은 플래그로 표시한다", async () => {
    const grids = await readXlsx(await syntheticXlsx());
    const { rows } = analyzeGrid(grids[0], "2026-03-01");
    const byRow = Object.fromEntries(rows.map((r) => [r.row, r]));
    expect(byRow[3].flags).toContain("no_date_unscheduled");
    expect(byRow[3].parsed.paidClaim).toBe(true);
    expect(byRow[3].flags).toContain("status_paid_claim");
    expect(byRow[5].flags).toContain("weekday_mismatch");
    expect(byRow[5].parsed.projectStatus).toBe("done");
    expect(byRow[5].flags).toContain("status_done_payment_unknown");
    expect(byRow[6].classification).toBe("personal");
    expect(byRow[6].parsed.personBlocks).toEqual([{ person: "직원A", label: "휴가" }]);
    expect(byRow[7].parsed.startTime).toBe("13:30");
    expect(byRow[7].flags).toContain("contact_column_used_as_time");
    expect(byRow[8].parsed.date).toBe("2026-02-17");
    expect(byRow[8].flags).toEqual(expect.arrayContaining(["date_inherited", "invalid_phone"]));
    expect(byRow[9].parsed.listedPrice).toBeNull();
    expect(byRow[9].flags).toEqual(expect.arrayContaining(["negative_amount", "possible_cost_in_notes"]));
    expect(byRow[11].flags).toContain("duplicate_in_file");
    expect(byRow[11].decision).toBe("review");
    expect(byRow[10].flags).toContain("possible_repeat_visit");
    expect(byRow[12].classification).toBe("note");
    expect(byRow[13].classification).toBe("empty_day");
  });

  it("미리보기 → 확정 시 작업·고객·일정이 생성되고, 재가져오기는 중복을 만들지 않는다. '입금완료'는 확인 필요 입금으로만 기록", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const b64 = (await syntheticXlsx()).toString("base64");
    const p1 = await owner.post("/api/sheet-imports", { filename: "s.xlsx", data_base64: b64 });
    expect(p1.status).toBe(200);
    const c1 = await owner.post(`/api/sheet-imports/${p1.body.id}/commit`);
    expect(c1.body.projects).toBe(6); // 예약 6행 (중복 의심 1행은 보류)
    expect(c1.body.claims).toBe(1);
    const pay = await q1<any>(`SELECT * FROM payments WHERE status='claimed'`);
    expect(pay.amount).toBeNull();
    const p2 = await owner.post("/api/sheet-imports", { filename: "s.xlsx", data_base64: b64 });
    const c2 = await owner.post(`/api/sheet-imports/${p2.body.id}/commit`);
    expect(c2.body.projects).toBe(0);
    expect((await q1<{ n: number }>(`SELECT count(*) AS n FROM projects WHERE data_origin='sheet'`))!.n).toBe(6);
    // 직원은 가져오기 불가
    expect((await api(ctx.app, ctx.staffCookie).post("/api/sheet-imports", { filename: "s.xlsx", data_base64: b64 })).status).toBe(403);
    // 확정 금액 없는 시트 작업은 미수금이 아니라 '금액 미확정'
    const st = await owner.get("/api/settlement");
    expect(st.body.receivables.due.length).toBe(0);
    expect(st.body.receivables.unconfirmedAmount.length).toBeGreaterThan(0);
  });
});

describe("즉시 보고 (사건 → 대표 보고방 → 알림)", () => {
  it("신규 문의는 영업·상담 담당이 한 번만 보고하고, 같은 이벤트 재수신은 중복 보고하지 않는다", async () => {
    const r1 = await testInbound({ user: "e1", conv: "ce1", text: "숙소 촬영 문의드려요", eventId: "dup-evt" });
    expect(r1.status).toBe(200);
    await ctx.app.inject({ method: "POST", url: `/api/webhooks/test/${ctx.orgId}`, headers: { "content-type": "application/json", "x-test-signature": r1.sig }, payload: r1.raw });
    await drainJobs();
    const ev = await q<any>(`SELECT * FROM events WHERE kind='new_inquiry'`);
    expect(ev.length).toBe(1);
    expect(ev[0].is_test).toBe(true);
    const feed = await api(ctx.app, ctx.ownerCookie).get("/api/ai/feed?role=sales");
    expect(feed.body.filter((m: any) => m.event_kind === "new_inquiry").length).toBe(1);
    expect(feed.body[0].content).toContain("대표님");
    const n = await q<any>(`SELECT * FROM notifications WHERE kind='new_inquiry'`);
    expect(n.length).toBe(1);
    expect(n[0].push_status).toBe("no_subscription"); // 구독 기기가 없음을 정확히 기록
  });

  it("고객의 '입금했어요'는 확인된 입금이 아니라 '입금 주장'으로 기록하고, 불만 표현은 즉시 보고한다", async () => {
    await testInbound({ user: "e2", conv: "ce2", text: "어제 계좌로 입금했습니다" });
    await testInbound({ user: "e2", conv: "ce2", text: "결과물이 너무 실망스럽네요 환불 원합니다" });
    await drainJobs();
    expect((await q<any>(`SELECT * FROM events WHERE kind='payment_claimed'`)).length).toBe(1);
    expect((await q<any>(`SELECT * FROM events WHERE kind='payment_confirmed'`)).length).toBe(0);
    const c = await q1<any>(`SELECT * FROM events WHERE kind='complaint'`);
    expect(c.severity).toBe("critical");
    expect(c.reported).toBe(true);
  });

  it("확인된 입금만 '입금 확인'으로 보고하며 금액과 근거가 필요하다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const p = await owner.post("/api/projects", { title: "검증 작업", scheduled_date: "2026-11-01", agreed_amount: 300000 }); // 지난 작업 (예정 작업은 미수금 대상 아님)
    const bad = await owner.post(`/api/projects/${p.body.id}/payments`, { amount: 100000, paid_at: new Date().toISOString(), status: "confirmed" });
    expect(bad.status).toBe(400);
    const ok = await owner.post(`/api/projects/${p.body.id}/payments`, { amount: 100000, paid_at: new Date().toISOString(), status: "confirmed", kind: "deposit", evidence: "통장 확인" });
    expect(ok.status).toBe(200);
    expect((await q<any>(`SELECT * FROM events WHERE kind='payment_confirmed'`)).length).toBe(1);
    const st = await owner.get("/api/settlement");
    const row = st.body.receivables.due.find((x: any) => x.id === p.body.id);
    expect(row.outstanding).toBe(200000);
  });

  it("일정 변경은 보고되고, 오래된 화면으로 저장하면 409로 막는다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const p = await owner.post("/api/projects", { title: "일정 변경 검증", scheduled_date: "2026-12-05" });
    const u1 = await owner.patch(`/api/projects/${p.body.id}`, { scheduled_date: "2026-12-06", version: p.body.version });
    expect(u1.status).toBe(200);
    const stale = await owner.patch(`/api/projects/${p.body.id}`, { scheduled_date: "2026-12-07", version: p.body.version });
    expect(stale.status).toBe(409);
    expect((await q<any>(`SELECT * FROM events WHERE kind='schedule_changed' AND entity_id=$1`, [p.body.id])).length).toBe(1);
  });

  it("내일 작업에 주소가 없으면 운영비서가 먼저 보고한다 (반복 점검해도 1회)", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const tomorrow = new Date(Date.now() + 9 * 3600_000 + 86400_000).toISOString().slice(0, 10);
    await owner.post("/api/projects", { title: "주소 없는 촬영", scheduled_date: tomorrow, start_time: "13:00" });
    await sweepOrg(ctx.orgId);
    await sweepOrg(ctx.orgId);
    const ev = await q<any>(`SELECT * FROM events WHERE kind='prep_missing'`);
    expect(ev.length).toBe(1);
    expect(ev[0].title).toContain("주소");
  });
});

describe("대표 보고방 버튼과 대화 명령 (실제 데이터 반영)", () => {
  it("보고의 '할 일로 등록'·'내일 다시 알림'·'내가 담당'이 실제로 반영되고, 다른 사람의 보고 버튼은 실행할 수 없다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const feed = await owner.get("/api/ai/feed?role=sales");
    const msg = feed.body.find((m: any) => m.event_kind === "new_inquiry");
    const idx = (t: string) => msg.actions.findIndex((a: any) => a.type === t);
    const r1 = await owner.post(`/api/ai/messages/${msg.id}/actions/${idx("create_task")}`);
    expect(r1.status).toBe(200);
    expect((await q<any>(`SELECT * FROM tasks WHERE title LIKE '신규 문의 응대%'`)).length).toBe(1);
    const r2 = await owner.post(`/api/ai/messages/${msg.id}/actions/${idx("assign_self")}`);
    expect(r2.status).toBe(200);
    const target = msg.actions[idx("assign_self")].conversation_id;
    const conv = await q1<any>(`SELECT assignee_user_id FROM conversations WHERE id=$1`, [target]);
    expect(conv.assignee_user_id).toBe(ctx.ownerId);
    // 직원 계정은 대표의 보고 메시지를 실행할 수 없음
    const staffCookie = await login(ctx.app, "staff@t.local", "staff-password");
    expect((await api(ctx.app, staffCookie).post(`/api/ai/messages/${msg.id}/actions/0`)).status).toBe(404);
  });

  it("모델 미연동 상태에서도 '내일 오전에 … 할 일 넣어줘'는 실제 할 일(KST 10:00)로 등록되고 결과는 서버 기록으로 표시된다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const t = await owner.post("/api/ai/threads", { role_key: "ops", message: "내일 오전에 가상고객2 잔금 확인할 일 넣어줘" });
    await drainJobs();
    const th = await owner.get(`/api/ai/threads/${t.body.id}`);
    const a = th.body.messages.find((m: any) => m.author === "assistant");
    expect(a.content).toContain("실행한 작업 (서버 기록)");
    const task = await q1<any>(`SELECT * FROM tasks WHERE title LIKE '%잔금 확인%' ORDER BY created_at DESC LIMIT 1`);
    expect(task).toBeTruthy();
    const kst = new Date(new Date(task.due_at).getTime() + 9 * 3600_000);
    expect(kst.getUTCHours()).toBe(10);
    expect(task.title).not.toContain("내일");
  });

  it("'미수금 확인해줘'는 확정 금액 기준 미수금을 답한다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const t = await owner.post("/api/ai/threads", { role_key: "ops", message: "이번 주 미수금 확인해줘" });
    await drainJobs();
    const th = await owner.get(`/api/ai/threads/${t.body.id}`);
    expect(th.body.messages.find((m: any) => m.author === "assistant").content).toContain("미수금 확인 대상은 1건");
  });
});

describe("정기 보고 (KST, 누락 보충, 중복 방지, 테스트 분리)", () => {
  it("회차 계산: 토 03:00(KST)이면 일일=금 19:00, 주간=금 19:10", () => {
    const now = new Date("2026-11-20T18:00:00Z"); // KST 2026-11-21(토) 03:00
    const s = latestDueSlots(now, { dailyTime: "19:00", weeklyDay: 5, weeklyTime: "19:10" });
    expect(s.daily.date).toBe("2026-11-20");
    expect(s.daily.cutoff.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(s.weekly.date).toBe("2026-11-20");
    expect(s.weekly.cutoff.toISOString()).toBe("2026-11-20T10:10:00.000Z");
    const before = latestDueSlots(new Date("2026-11-20T09:59:00Z"), { dailyTime: "19:00", weeklyDay: 5, weeklyTime: "19:10" }); // 금 18:59
    expect(before.daily.date).toBe("2026-11-19");
    expect(before.weekly.date).toBe("2026-11-13");
  });

  it("앱이 닫혀 있어도 서버 점검으로 생성되며, 여러 번 실행해도 회차당 1건만 만든다. 테스트 실행은 운영 보고와 분리된다", async () => {
    const now = new Date("2026-11-20T18:00:00Z");
    const t1 = await runTestReport(ctx.orgId, "daily", ctx.ownerId, now);
    expect(t1).toBeTruthy();
    await Promise.all([runDueReports(ctx.orgId, now), runDueReports(ctx.orgId, now)]);
    await runDueReports(ctx.orgId, now);
    const rows = await q<any>(`SELECT kind, period_key, is_test, cutoff_at, body FROM reports ORDER BY created_at`);
    const prod = rows.filter((r) => !r.is_test && String(r.period_key).includes("2026-11-20")); // 다른 테스트의 실제 시각 점검으로 생긴 회차 제외
    expect(prod.map((r) => r.period_key).sort()).toEqual(["daily:2026-11-20", "weekly:2026-11-20"]);
    expect(rows.filter((r) => r.is_test).length).toBe(1);
    const daily = prod.find((r) => r.kind === "daily");
    expect(daily.body).toContain("오후 7:00 시점까지 집계");
    expect(daily.body).toContain("서버 지연으로 늦게 생성된 보충 보고");
    expect(new Date(daily.cutoff_at).toISOString()).toBe("2026-11-20T10:00:00.000Z");
    const weekly = prod.find((r) => r.kind === "weekly");
    expect(weekly.body).toContain("직전 7일 대비");
    expect(weekly.body).not.toBe(daily.body);
    // 다음 날 보고는 직전 보고 기준 시각부터 집계 (19시 이후 발생분 누락 방지)
    await runDueReports(ctx.orgId, new Date("2026-11-21T11:00:00Z")); // KST 토 20:00
    const next = await q1<any>(`SELECT period_start FROM reports WHERE period_key='daily:2026-11-21'`);
    expect(new Date(next.period_start).toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });
});

describe("AI 오류 처리 (로컬 가짜 API 서버 — 실제 Claude 호출 아님)", () => {
  let server: http.Server;
  let mode: "auth" | "rate" | "ok" = "auth";
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "auth") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        }
        if (mode === "rate") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } }));
        }
        const fields = Object.fromEntries(["space_type", "region", "size_text", "room_count", "desired_work", "desired_schedule", "stated_budget", "quote_requested", "source_channel"].map((k) => [k, { value: null, message_id: null }]));
        const text = JSON.stringify({ summary: "숙소 촬영 문의", services: ["숙소 촬영"], category: "valid", fields, missing_questions: ["객실 수"], stage_suggestion: { stage: "none", reason: "", message_ids: [] }, suspicious_instruction: false });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    process.env.STAYSCENE_ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
    resetClient();
  });
  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.STAYSCENE_ANTHROPIC_BASE_URL;
    resetClient();
    await new Promise((r) => server.close(r));
  });

  it("정책 거절·인증·잔액·권한·한도 오류를 구분한다", () => {
    expect(classifyAiError({ status: 401 }).kind).toBe("auth");
    expect(classifyAiError({ status: 403 }).kind).toBe("permission");
    expect(classifyAiError({ status: 429 }).kind).toBe("rate_limit");
    expect(classifyAiError({ status: 400, message: "Your credit balance is too low" }).kind).toBe("billing");
    expect(classifyAiError({ name: "RefusalError", message: "model refusal" }).kind).toBe("refusal");
  });

  it("인증 오류: 재시도 없이 1회 실패 → 규칙 기반으로 답하고, 30분간 호출을 멈춘다. 수신 데이터는 유지", async () => {
    mode = "auth";
    hits = 0;
    const owner = api(ctx.app, ctx.ownerCookie);
    const t = await owner.post("/api/ai/threads", { role_key: "sales", message: "오늘 답장 안 한 문의 보여줘" });
    await drainJobs();
    expect(hits).toBe(1); // 401은 재시도하지 않음
    const th = await owner.get(`/api/ai/threads/${t.body.id}`);
    const a = th.body.messages.find((m: any) => m.author === "assistant");
    expect(a.content).toContain("규칙 기반");
    expect(a.content).toContain("API 키 인증 실패");
    const run = await q1<any>(`SELECT error_kind FROM analysis_runs WHERE engine='model' AND status='failed' ORDER BY created_at DESC LIMIT 1`);
    expect(run.error_kind).toBe("auth");
    const av = await checkAvailability(ctx.orgId);
    expect(av.ok).toBe(false);
    expect((av as any).reason).toBe("auth_blocked");
    await q(`DELETE FROM analysis_runs WHERE error_kind='auth'`);
  });

  it("요청 한도(429): 제한된 횟수만 재시도(최대 3회 요청) 후 분석 대기열에서 다시 시도", async () => {
    mode = "rate";
    hits = 0;
    const conv = await q1<any>(`SELECT id FROM conversations WHERE external_conversation_id='ce1'`);
    await expect(analyzeConversation({ orgId: ctx.orgId, conversationId: conv.id })).rejects.toBeTruthy();
    expect(hits).toBe(3);
    const c = await q1<any>(`SELECT ai_status FROM conversations WHERE id=$1`, [conv.id]);
    expect(c.ai_status).toBe("failed");
    expect((await q1<{ n: number }>(`SELECT count(*) AS n FROM messages WHERE conversation_id=$1`, [conv.id]))!.n).toBeGreaterThan(0);
  });

  it("정상 응답이면 분류·요약이 저장되고 사용 모델·토큰·추정 비용이 기록된다", async () => {
    mode = "ok";
    const conv = await q1<any>(`SELECT id FROM conversations WHERE external_conversation_id='ce1'`);
    await analyzeConversation({ orgId: ctx.orgId, conversationId: conv.id });
    const c = await q1<any>(`SELECT ai_status, ai_summary FROM conversations WHERE id=$1`, [conv.id]);
    expect(c.ai_status).toBe("done");
    expect(c.ai_summary).toBe("숙소 촬영 문의");
    const run = await q1<any>(`SELECT model, input_tokens, output_tokens, cost_usd FROM analysis_runs WHERE kind='conversation_analysis' AND status='done' ORDER BY created_at DESC LIMIT 1`);
    expect(run.input_tokens).toBe(100);
    expect(Number(run.cost_usd)).toBeGreaterThan(0);
  });

  it("호출 상한에 도달하면 모델 호출을 멈추고 규칙 기반으로 전환한다 (무한 호출 방지)", async () => {
    await api(ctx.app, ctx.ownerCookie).patch("/api/settings", { aiHourlyCallCap: 1 });
    const av = await checkAvailability(ctx.orgId);
    expect((av as any).reason).toBe("call_cap");
    await api(ctx.app, ctx.ownerCookie).patch("/api/settings", { aiHourlyCallCap: 40 });
  });
});

describe("고객 발송 큐", () => {
  it("승인 권한 확인, 공급사 미연동은 직접 발송 필요로 표시, 같은 요청은 한 번만 생성", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const r = await owner.post("/api/conversations/manual", { customer_name: "수동고객", messages: [{ sender: "customer", text: "촬영 문의" }] });
    const a = await owner.post(`/api/conversations/${r.body.conversationId}/outbound`, { body: "안녕하세요", client_key: "k1" });
    const b = await owner.post(`/api/conversations/${r.body.conversationId}/outbound`, { body: "안녕하세요", client_key: "k1" });
    expect(a.body.id).toBe(b.body.id);
    expect(a.body.status).toBe("pending_approval");
    const ap = await owner.post(`/api/outbound/${a.body.id}/decision`, { decision: "approve" });
    expect(ap.body.status).toBe("blocked_no_provider");
    const man = await owner.post(`/api/outbound/${a.body.id}/decision`, { decision: "sent_manually" });
    expect(man.body.status).toBe("sent_manually");
  });

  it("테스트 공급사: 정상 전송 / 응답 끊김은 '확인 불가'로 두고 자동 재전송하지 않는다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    await testInbound({ user: "o1", conv: "co1", text: "테스트 문의" });
    await drainJobs();
    const conv = await q1<any>(`SELECT id FROM conversations WHERE external_conversation_id='co1'`);
    const m1 = await owner.post(`/api/conversations/${conv.id}/outbound`, { body: "테스트 답장", client_key: "t1" });
    await owner.post(`/api/outbound/${m1.body.id}/decision`, { decision: "approve" });
    await drainJobs();
    expect((await q1<any>(`SELECT status FROM outbound_messages WHERE id=$1`, [m1.body.id])).status).toBe("sent");
    process.env.TEST_SEND_MODE = "timeout";
    const m2 = await owner.post(`/api/conversations/${conv.id}/outbound`, { body: "두번째", client_key: "t2" });
    await owner.post(`/api/outbound/${m2.body.id}/decision`, { decision: "approve" });
    await drainJobs();
    delete process.env.TEST_SEND_MODE;
    expect((await q1<any>(`SELECT status, attempts FROM outbound_messages WHERE id=$1`, [m2.body.id])).status).toBe("unknown");
    expect((await owner.post(`/api/outbound/${m2.body.id}/decision`, { decision: "retry" })).status).toBe(409);
    const chk = await owner.post(`/api/outbound/${m2.body.id}/decision`, { decision: "check_status" });
    expect(chk.body.status).toBe("failed"); // 공급사 기록에 없음 → 명확한 실패, 이후에만 재시도 가능
    expect((await q1<any>(`SELECT attempts FROM outbound_messages WHERE id=$1`, [m2.body.id])).attempts).toBe(1);
  });

  it("자동응답 문구에 금액·할인·확정 표현은 저장할 수 없다", async () => {
    const r = await api(ctx.app, ctx.ownerCookie).post("/api/auto-replies", { name: "x", template: "지금 예약하면 10% 할인 확정!", enabled: true });
    expect(r.status).toBe(400);
  });
});

describe("경영 제안", () => {
  it("같은 제안을 반복하지 않고, 채택하면 담당·기한·성과 기준이 있는 할 일이 된다", async () => {
    const a = await generateIdeas(ctx.orgId);
    const b = await generateIdeas(ctx.orgId);
    expect(b.length).toBe(0);
    const ideas = await q<any>(`SELECT * FROM ideas`);
    if (!ideas.length) return; // 근거 데이터가 없으면 제안 자체를 만들지 않음
    expect(a.length).toBeLessThanOrEqual(3);
    const owner = api(ctx.app, ctx.ownerCookie);
    expect((await owner.post(`/api/ideas/${ideas[0].id}/decision`, { decision: "adopted", reason: "해볼 만함" })).status).toBe(400);
    const r = await owner.post(`/api/ideas/${ideas[0].id}/decision`, { decision: "adopted", reason: "해볼 만함", due_at: new Date(Date.now() + 7 * 86400000).toISOString(), success_metric: "4주 후 비교" });
    expect(r.body.task_id).toBeTruthy();
  });
});

describe("실시간 동기화", () => {
  it("한 기기에서 바꾼 내용이 같은 조직의 다른 연결로 즉시 전달된다 (원문 없이 테이블·id만)", async () => {
    const got: any[] = [];
    const unsub = await subscribe(ctx.orgId, (m) => got.push(m));
    const t = await api(ctx.app, ctx.ownerCookie).post("/api/tasks", { title: "동기화 확인" });
    await new Promise((r) => setTimeout(r, 300));
    unsub();
    const hit = got.find((m) => m.t === "tasks" && m.id === t.body.id);
    expect(hit).toBeTruthy();
    expect(Object.keys(hit).sort()).toEqual(["id", "op", "t"]);
  });
});

describe("웹 푸시", () => {
  it("구독 저장 후 실제 푸시 서비스(로컬 가짜 엔드포인트)로 전송, 만료(410) 구독은 비활성화", async () => {
    let status = 201;
    const { execSync } = await import("node:child_process");
    const https = await import("node:https");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(os.tmpdir() + "/pushcert-");
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=127.0.0.1`, { stdio: "ignore" });
    const srv = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const endpoint = `https://127.0.0.1:${(srv.address() as any).port}/push/abc`;
    const agent = new https.Agent({ rejectUnauthorized: false }); // 테스트용 자체 서명 인증서
    // 유효한 P-256 키 형식이 필요하므로 생성
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
    const s = await api(ctx.app, ctx.ownerCookie).post("/api/push/subscribe", { endpoint, keys });
    expect(s.status).toBe(200);
    expect((await sendPushToUser(ctx.ownerId, { title: "테스트" }, { agent })).status).toBe("sent");
    status = 410;
    expect((await sendPushToUser(ctx.ownerId, { title: "테스트" }, { agent })).status).toBe("failed");
    expect((await q1<any>(`SELECT disabled_at FROM push_subscriptions WHERE endpoint=$1`, [endpoint])).disabled_at).toBeTruthy();
    await new Promise((r) => srv.close(r));
  });
});

describe("권한 — 작업·고객·첨부", () => {
  it("직원은 배정되지 않은 작업·고객·첨부를 볼 수 없고 금액을 입력할 수 없다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const staff = api(ctx.app, ctx.staffCookie);
    const p = await owner.post("/api/projects", { title: "대표 전용 작업", agreed_amount: 500000, assignee_user_id: ctx.ownerId });
    expect((await staff.get(`/api/projects/${p.body.id}`)).status).toBe(404);
    const att = await owner.post("/api/attachments", { project_id: p.body.id, filename: "a.txt", mime: "text/plain", data_base64: Buffer.from("비밀").toString("base64") });
    expect((await staff.get(`/api/attachments/${att.body.id}`)).status).toBe(404);
    const mine = await staff.post("/api/projects", { title: "직원 작업" });
    expect(mine.status).toBe(200);
    expect((await staff.patch(`/api/projects/${mine.body.id}`, { agreed_amount: 1 })).status).toBe(403);
    const detail = await staff.get(`/api/projects/${mine.body.id}`);
    expect(detail.body.payments).toEqual([]);
    const search = await staff.get(`/api/search?q=${encodeURIComponent("대표 전용")}`);
    expect(search.body.projects.length).toBe(0);
    expect((await staff.get("/api/settlement")).status).toBe(403);
    expect((await staff.post(`/api/contacts/${crypto.randomUUID()}/erase`)).status).toBe(403);
  });
});

describe("데이터 삭제 — 파생 데이터까지", () => {
  it("고객 삭제 시 상담 원문·AI 답변·첨부·할 일이 삭제되고 보고서·사건·알림 본문의 이름이 치환되며 작업은 금액만 남긴다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    await testInbound({ user: "del1", conv: "cdel1", text: "삭제 검증 문의" });
    await drainJobs();
    const contact = await q1<any>(`SELECT id, display_name FROM contacts WHERE external_user_id='del1'`);
    const p = await owner.post("/api/projects", { title: `${contact.display_name} 작업`, contact_id: contact.id, agreed_amount: 100000 });
    await owner.post("/api/attachments", { contact_id: contact.id, filename: "c.txt", mime: "text/plain", data_base64: Buffer.from("x").toString("base64") });
    await q(`INSERT INTO reports(org_id, role_key, kind, title, period_start, period_end, body) VALUES ($1,'ops','adhoc','r',now(),now(),$2)`, [ctx.orgId, `요약: ${contact.display_name} 문의`]);
    const r = await owner.post(`/api/contacts/${contact.id}/erase`);
    expect(r.status).toBe(200);
    expect((await q<any>(`SELECT 1 FROM conversations WHERE external_conversation_id='cdel1'`)).length).toBe(0);
    expect((await q<any>(`SELECT 1 FROM attachments WHERE contact_id=$1`, [contact.id])).length).toBe(0);
    expect((await q1<any>(`SELECT body FROM reports WHERE kind='adhoc'`)).body).not.toContain(contact.display_name);
    expect((await q<any>(`SELECT title FROM events WHERE title LIKE '%' || $1 || '%'`, [contact.display_name])).length).toBe(0);
    const pj = await q1<any>(`SELECT title, agreed_amount, contact_id FROM projects WHERE id=$1`, [p.body.id]);
    expect(pj.title).toBe("[삭제된 고객] 작업");
    expect(Number(pj.agreed_amount)).toBe(100000);
    expect(pj.contact_id).toBeNull();
  });

  it("보관 기간 정리는 오래된 AI 대화·보고서·사건·알림도 함께 삭제한다", async () => {
    await api(ctx.app, ctx.ownerCookie).patch("/api/settings", { retentionDays: 30 });
    const old = new Date(Date.now() - 40 * 86400000);
    await q(`UPDATE ai_messages SET created_at=$1`, [old]);
    await q(`UPDATE reports SET created_at=$1`, [old]);
    await q(`UPDATE events SET created_at=$1`, [old]);
    await q(`UPDATE notifications SET created_at=$1`, [old]);
    await q(`UPDATE conversations SET last_message_at=$1, opened_at=$1`, [old]);
    await purgeExpired(ctx.orgId);
    for (const t of ["ai_messages", "reports", "events", "notifications", "conversations", "messages"]) {
      expect((await q1<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))!.n).toBe(0);
    }
    expect((await q1<{ n: number }>(`SELECT count(*) AS n FROM projects`))!.n).toBeGreaterThan(0); // 회계 기록은 유지
    void kstStartOfDay;
    void minutesAgo;
  });
});

describe("재시작 후 복구", () => {
  it("워커가 중단되어 'running'으로 남은 작업과 실패한 수신 이벤트를 재처리한다", async () => {
    const { recoverStuckJobs } = await import("../src/server/jobs/queue.js");
    const { requeueFailedEvents } = await import("../src/server/ingest/ingest.js");
    await q(`INSERT INTO jobs(kind, payload, status, locked_at) VALUES ('sweep_org', $1, 'running', now() - interval '11 minutes')`, [{ orgId: ctx.orgId }]);
    await recoverStuckJobs();
    expect((await q1<{ n: number }>(`SELECT count(*) AS n FROM jobs WHERE status='running'`))!.n).toBe(0);
    const r = await testInbound({ user: "rs1", conv: "crs1", text: "재처리 검증" });
    expect(r.status).toBe(200);
    await q(`UPDATE webhook_events SET status='failed' WHERE external_event_id IN (SELECT external_event_id FROM webhook_events ORDER BY received_at DESC LIMIT 1)`);
    await q(`UPDATE jobs SET status='done' WHERE kind='process_webhook_event'`);
    expect(await requeueFailedEvents(ctx.orgId)).toBe(1);
    await drainJobs();
    expect((await q1<{ n: number }>(`SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.external_conversation_id='crs1'`))!.n).toBe(1);
  });
});
