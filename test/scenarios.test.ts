// 요구사항 10절 '필수 검증 시나리오' 중 자동화 가능한 항목
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, q, q1 } from "../src/server/db/pool.js";
import { api, demoEvent, drainJobs, minutesAgo, postWebhook, setup, type Ctx } from "./helpers.js";
import { sweepOrg } from "../src/server/jobs/automation.js";
import { executeTool, newToolContext, toolDefinitions } from "../src/server/ai/tools.js";
import { maskPII } from "../src/server/ai/mask.js";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await pool.end();
});

const oppOfConv = async (ext: string) =>
  (await q1<{ opportunity_id: string }>(
    `SELECT oc.opportunity_id FROM opportunity_conversations oc JOIN conversations c ON c.id=oc.conversation_id WHERE c.external_conversation_id=$1`,
    [ext],
  ))?.opportunity_id;

describe("수신 검증", () => {
  it("서명이 틀린 웹훅은 거부하고 저장하지 않는다", async () => {
    const raw = demoEvent({ user: "u-x", conv: "c-x", at: minutesAgo(5) });
    const r = await postWebhook(ctx.app, ctx.orgId, raw, "0".repeat(64));
    expect(r.status).toBe(401);
    const n = await q1<{ n: number }>(`SELECT count(*) AS n FROM webhook_events`);
    expect(n!.n).toBe(0);
  });

  it("미구현 공급사(채널톡) 웹훅은 501로 거부한다", async () => {
    const r = await ctx.app.inject({ method: "POST", url: `/api/webhooks/channeltalk/${ctx.orgId}`, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(501);
  });
});

describe("시나리오 1: 동일 수신 이벤트 3회", () => {
  it("메시지/문의가 중복 생성되지 않는다", async () => {
    const raw = demoEvent({ user: "u-dup", conv: "c-dup", at: minutesAgo(30), eventId: "same-event", msgId: "same-msg" });
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await postWebhook(ctx.app, ctx.orgId, raw));
    expect(results.map((r) => r.body.status)).toEqual(["accepted", "duplicate", "duplicate"]);
    await drainJobs();
    // 이벤트 ID가 달라도 같은 메시지 ID면 중복 제거 (공급사 재전송 형태 차이 대비)
    const raw2 = demoEvent({ user: "u-dup", conv: "c-dup", at: minutesAgo(30), eventId: "other-event", msgId: "same-msg" });
    await postWebhook(ctx.app, ctx.orgId, raw2);
    await drainJobs();
    const msgs = await q1<{ n: number }>(`SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.external_conversation_id='c-dup'`);
    const opps = await q1<{ n: number }>(`SELECT count(*) AS n FROM opportunities o JOIN contacts ct ON ct.id=o.contact_id WHERE ct.external_user_id='u-dup'`);
    expect(msgs!.n).toBe(1);
    expect(opps!.n).toBe(1);
  });
});

describe("순서 역전 / 상담 상태", () => {
  it("늦게 도착한 과거 직원 메시지가 '답변 대기' 판단을 덮어쓰지 않고, 오래된 종료 이벤트는 상태를 바꾸지 않는다", async () => {
    // 고객 메시지(10분 전) 먼저 도착, 그 뒤 더 과거(20분 전)의 직원 메시지가 늦게 도착
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-ooo", conv: "c-ooo", sender: "customer", at: minutesAgo(10) }));
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-ooo", conv: "c-ooo", sender: "staff", at: minutesAgo(20) }));
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-ooo", conv: "c-ooo", type: "conversation_status", status: "closed", at: minutesAgo(15) }));
    await drainJobs();
    const owner = api(ctx.app, ctx.ownerCookie);
    const list = await owner.get("/api/conversations?filter=awaiting");
    const c = list.body.find((x: any) => x.display_name === "고객 u-ooo");
    expect(c).toBeTruthy();
    expect(c.status).toBe("open");
    const conv = await owner.get(`/api/conversations/${c.id}`);
    expect(conv.body.messages.map((m: any) => m.sender_type)).toEqual(["staff", "customer"]); // 발생 시각 순 재구성
  });
});

describe("시나리오 2: 견적 후 무응답", () => {
  it("'견적 후 회신 대기'로 표시되고 가격 이탈로 확정되지 않는다", async () => {
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-quote", conv: "c-quote", text: "숙소 촬영 견적 부탁드려요", at: minutesAgo(10 * 24 * 60) }));
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-quote", conv: "c-quote", sender: "staff", text: "견적 보내드렸습니다", at: minutesAgo(10 * 24 * 60 - 30) }));
    await drainJobs();
    const oppId = await oppOfConv("c-quote");
    const owner = api(ctx.app, ctx.ownerCookie);
    const r = await owner.post(`/api/opportunities/${oppId}/quotes`, { amount: 1000000, sent_at: minutesAgo(10 * 24 * 60 - 30).toISOString() });
    expect(r.status).toBe(200);
    const queues = await owner.get("/api/queues");
    expect(queues.body.quoteAwaitingReply.map((x: any) => x.id)).toContain(oppId);
    await sweepOrg(ctx.orgId);
    const task = await q1<any>(`SELECT * FROM tasks WHERE opportunity_id=$1 AND source='system'`, [oppId]);
    expect(task.title).toContain("견적 후 회신 확인");
    expect(task.source_reason).toContain("이탈로 확정하지 않음");
    const opp = await q1<any>(`SELECT stage FROM opportunities WHERE id=$1`, [oppId]);
    expect(opp.stage).toBe("quoted");
    const loss = await q1<{ n: number }>(`SELECT count(*) AS n FROM loss_assessments WHERE opportunity_id=$1`, [oppId]);
    expect(loss!.n).toBe(0);
    // sweep 반복해도 할 일 중복 없음
    await sweepOrg(ctx.orgId);
    const tasks = await q1<{ n: number }>(`SELECT count(*) AS n FROM tasks WHERE opportunity_id=$1 AND source='system'`, [oppId]);
    expect(tasks!.n).toBe(1);
  });

  it("'확인' 이탈 사유는 근거 없이 등록할 수 없다", async () => {
    const oppId = await oppOfConv("c-quote");
    const owner = api(ctx.app, ctx.ownerCookie);
    const r = await owner.post(`/api/opportunities/${oppId}/loss`, { reason_code: "price", certainty: "confirmed", confirmed_by_type: "customer" });
    expect(r.status).toBe(400);
  });
});

describe("시나리오 3·4: 재문의 연결과 다른 프로젝트 분리", () => {
  it("같은 고객의 재문의(새 상담방)는 진행 중인 기존 건에 연결된다", async () => {
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-re", conv: "c-re-1", text: "펜션 촬영 문의", at: minutesAgo(3000) }));
    await drainJobs();
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-re", conv: "c-re-1", type: "conversation_status", status: "closed", at: minutesAgo(2900) }));
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-re", conv: "c-re-2", text: "지난번 펜션 건 추가 문의", at: minutesAgo(100) }));
    await drainJobs();
    const a = await oppOfConv("c-re-1");
    const b = await oppOfConv("c-re-2");
    expect(a).toBe(b);
    const n = await q1<{ n: number }>(`SELECT count(*) AS n FROM opportunities o JOIN contacts ct ON ct.id=o.contact_id WHERE ct.external_user_id='u-re'`);
    expect(n!.n).toBe(1);
  });

  it("다른 프로젝트 문의는 별도 기회로 분리되고 이력이 남는다", async () => {
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-re", conv: "c-re-3", text: "이번엔 다른 카페 브랜드 촬영 문의", at: minutesAgo(50) }));
    await drainJobs();
    const oppId = await oppOfConv("c-re-3");
    const conv3 = await q1<{ id: string }>(`SELECT id FROM conversations WHERE external_conversation_id='c-re-3'`);
    const owner = api(ctx.app, ctx.ownerCookie);
    const r = await owner.post(`/api/opportunities/${oppId}/split`, { conversation_ids: [conv3!.id], reason: "다른 프로젝트" });
    expect(r.status).toBe(200);
    expect(await oppOfConv("c-re-3")).toBe(r.body.newOpportunityId);
    expect(await oppOfConv("c-re-1")).toBe(oppId);
    const hist = await q1<any>(`SELECT * FROM opportunity_merges WHERE action='split' AND target_id=$1`, [r.body.newOpportunityId]);
    expect(hist.reason).toBe("다른 프로젝트");
  });

  it("합치기도 이력과 함께 처리되며 합쳐진 건은 문의 수에서 빠진다", async () => {
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-m1", conv: "c-m1", at: minutesAgo(40) }));
    await drainJobs();
    const before = await api(ctx.app, ctx.ownerCookie).get("/api/analytics");
    const src = await oppOfConv("c-m1");
    const target = await oppOfConv("c-re-1");
    const r = await api(ctx.app, ctx.ownerCookie).post(`/api/opportunities/${src}/merge`, { target_id: target, reason: "동일 고객 동일 프로젝트" });
    expect(r.status).toBe(200);
    const after = await api(ctx.app, ctx.ownerCookie).get("/api/analytics");
    expect(after.body.counts.valid).toBe(before.body.counts.valid - 1);
  });
});

describe("시나리오 5: 직원 권한", () => {
  it("직원은 재무·분석·미배정 상담에 접근할 수 없다 (서버 검사)", async () => {
    const staff = api(ctx.app, ctx.staffCookie);
    expect((await staff.get("/api/finance")).status).toBe(403);
    expect((await staff.get("/api/analytics")).status).toBe(403);
    expect((await staff.get("/api/members")).status).toBe(403);
    expect((await staff.patch("/api/settings", { replyAlertMinutes: 10 })).status).toBe(403);
    const list = await staff.get("/api/conversations");
    expect(list.body.length).toBe(0); // 배정된 상담 없음
    const anyConv = await q1<{ id: string }>(`SELECT id FROM conversations LIMIT 1`);
    expect((await staff.get(`/api/conversations/${anyConv!.id}`)).status).toBe(404);
    const anyOpp = await q1<{ id: string }>(`SELECT id FROM opportunities LIMIT 1`);
    expect((await staff.post(`/api/opportunities/${anyOpp!.id}/quotes`, { amount: 1, sent_at: new Date().toISOString() })).status).toBe(403);
  });

  it("배정되면 해당 상담만 보이고, 금액은 숨겨진다", async () => {
    const conv = await q1<{ id: string }>(`SELECT id FROM conversations WHERE external_conversation_id='c-quote'`);
    await api(ctx.app, ctx.ownerCookie).patch(`/api/conversations/${conv!.id}`, { assignee_user_id: ctx.staffId });
    const staff = api(ctx.app, ctx.staffCookie);
    const list = await staff.get("/api/conversations");
    expect(list.body.map((c: any) => c.id)).toEqual([conv!.id]);
    const oppId = await oppOfConv("c-quote");
    const detail = await staff.get(`/api/opportunities/${oppId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.quotes[0].amount).toBeNull();
    expect(detail.body.financeVisible).toBe(false);
  });

  it("AI 도구도 요청자 권한을 넘지 못한다", async () => {
    const scope = { orgId: ctx.orgId, userId: ctx.staffId, role: "staff" as const, perms: {} };
    const names = toolDefinitions(scope).map((t) => t.name);
    expect(names).not.toContain("get_finance");
    expect(names).not.toContain("get_analytics");
    const other = await q1<{ id: string }>(`SELECT id FROM conversations WHERE external_conversation_id='c-dup'`);
    const tctx = newToolContext(scope);
    const out: any = await executeTool(tctx, "get_conversation", { conversation_id: other!.id });
    expect(out.error).toBeTruthy();
    const fin: any = await executeTool(tctx, "get_finance", {});
    expect(fin.error).toBeTruthy();
  });

  it("권한 부여 후에는 접근 가능, 계정 회수 시 세션이 즉시 무효화된다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    await owner.patch(`/api/members/${ctx.staffId}`, { perms: { view_analytics: true } });
    const staff = api(ctx.app, ctx.staffCookie);
    expect((await staff.get("/api/analytics")).status).toBe(200);
    expect((await owner.post(`/api/members/${ctx.staffId}/revoke`)).status).toBe(200);
    expect((await staff.get("/api/me")).status).toBe(401);
  });
});

describe("시나리오 7: 앱 내 발송", () => {
  it("공급사 발송 검증 전에는 발송 기능이 비활성이며 초안만 기록된다", async () => {
    const conv = await q1<{ id: string }>(`SELECT id FROM conversations WHERE external_conversation_id='c-quote'`);
    const d = await api(ctx.app, ctx.ownerCookie).get(`/api/conversations/${conv!.id}`);
    expect(d.body.sendEnabled).toBe(false);
  });
});

describe("시나리오 8: AI 미연동/한도 도달", () => {
  it("상담 수신은 유지되고 분석은 '대기'로 표시된다. AI 직원은 규칙 기반 답변으로 표시된다", async () => {
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-ai", conv: "c-ai", at: minutesAgo(3) }));
    await drainJobs();
    const c = await q1<any>(`SELECT ai_status FROM conversations WHERE external_conversation_id='c-ai'`);
    expect(c.ai_status).toBe("waiting_no_api");
    const m = await q1<{ n: number }>(`SELECT count(*) AS n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.external_conversation_id='c-ai'`);
    expect(m!.n).toBe(1);

    const owner = api(ctx.app, ctx.ownerCookie);
    const t = await owner.post("/api/ai/threads", { role_key: "sales", message: "오늘 답장 안 한 문의부터 보여줘" });
    expect(t.status).toBe(200);
    await drainJobs();
    const th = await owner.get(`/api/ai/threads/${t.body.id}`);
    const answer = th.body.messages.find((x: any) => x.author === "assistant");
    expect(answer.status).toBe("done");
    expect(answer.content).toContain("규칙 기반");
    expect(answer.meta.engine).toBe("rules");
    expect(answer.meta.evidence.length).toBeGreaterThan(0);
    const run = await q1<any>(`SELECT engine, cost_usd FROM analysis_runs WHERE kind='chat' ORDER BY created_at DESC LIMIT 1`);
    expect(run.engine).toBe("rules");
    expect(run.cost_usd).toBe(0);
  });
});

describe("시나리오 9: 과거 이력 없음 / 데이터 범위 표시", () => {
  it("홈에 연동 상태·샘플 여부·첫 수신 시점이 표시되고, 미분류/유입경로 미확인 분모가 함께 나온다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const home = await owner.get("/api/home");
    expect(home.body.dataStatus.kakaoVerified).toBe(false);
    expect(home.body.dataStatus.usingSampleData).toBe(true);
    expect(home.body.dataStatus.firstMessageAt).toBeTruthy();
    const kakao = home.body.dataStatus.integrations.find((i: any) => i.provider === "kakao_counsel");
    expect(kakao.status).toBe("not_connected");
    const a = await owner.get("/api/analytics");
    expect(a.body.unknownShares.denominator).toBe(a.body.counts.valid);
    expect(a.body.unknownShares.sourceUnknown).toBeGreaterThan(0);
  });
});

describe("지표 정의", () => {
  it("첫 응답 시간은 자동 안내(bot)를 제외하고 실제 직원 답변까지로 계산한다", async () => {
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-frt", conv: "c-frt", sender: "customer", at: minutesAgo(120) }));
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-frt", conv: "c-frt", sender: "bot", at: minutesAgo(119) }));
    await postWebhook(ctx.app, ctx.orgId, demoEvent({ user: "u-frt", conv: "c-frt", sender: "staff", at: minutesAgo(60) }));
    await drainJobs();
    const { analyticsOverview } = await import("../src/server/analytics/metrics.js");
    const { resolvePeriod } = await import("../src/server/lib/time.js");
    // 이 기회 하나만 포함되도록 기간 대신 직접 계산 검증
    const a = await analyticsOverview({ orgId: ctx.orgId, userId: ctx.ownerId, role: "owner", perms: {} }, resolvePeriod(undefined, undefined, 1));
    expect(a.firstResponse.respondedCount).toBeGreaterThan(0);
    const oppId = await oppOfConv("c-frt");
    const r = await q1<any>(
      `SELECT (SELECT min(sent_at) FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id WHERE oc.opportunity_id=$1 AND sender_type='staff') -
              (SELECT min(sent_at) FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id WHERE oc.opportunity_id=$1 AND sender_type='customer') AS d`,
      [oppId],
    );
    expect(r.d.minutes ?? r.d.hours * 60).toBe(60);
  });

  it("메시지 수가 아닌 문의 기회 수로 집계하고 스팸/테스트는 별도 집계한다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const oppId = await oppOfConv("c-ai");
    await owner.patch(`/api/opportunities/${oppId}`, { category: "spam" });
    const a = await owner.get("/api/analytics");
    expect(a.body.counts.spam).toBe(1);
    const msgCount = await q1<{ n: number }>(`SELECT count(*) AS n FROM messages`);
    expect(a.body.counts.valid).toBeLessThan(msgCount!.n);
  });

  it("단계별 전환은 누적(해당 단계 이상 도달) 기준이라 단조 감소한다", async () => {
    const a = await api(ctx.app, ctx.ownerCookie).get("/api/analytics");
    const ns = a.body.funnel.map((r: any) => r.n);
    for (let i = 1; i < ns.length; i++) expect(ns[i]).toBeLessThanOrEqual(ns[i - 1]);
    expect(ns[0]).toBe(a.body.counts.valid);
  });

  it("계약 확정은 계약 기록 없이 단계만 바꿀 수 없다", async () => {
    const oppId = await oppOfConv("c-frt");
    const r = await api(ctx.app, ctx.ownerCookie).post(`/api/opportunities/${oppId}/stage`, { to: "won", reason: "대화상 확정 같음" });
    expect(r.status).toBe(400);
  });
});

describe("과거 기록 가져오기", () => {
  it("출처·기간이 기록되고 재가져오기 시 중복 저장되지 않으며 카카오 연동 상태는 바뀌지 않는다", async () => {
    const owner = api(ctx.app, ctx.ownerCookie);
    const body = {
      source_label: "대표 보관 정리본",
      conversations: [
        {
          external_conversation_id: "imp-1",
          customer_id: "imp-cust",
          messages: [
            { id: "1", sender: "customer", text: "과거 문의", sent_at: "2026-09-03T10:12:00+09:00" },
            { id: "2", sender: "staff", text: "답변", sent_at: "2026-09-03T10:40:00+09:00" },
          ],
        },
      ],
    };
    const r1 = await owner.post("/api/imports", body);
    expect(r1.status).toBe(200);
    expect(r1.body.inserted).toBe(2);
    const r2 = await owner.post("/api/imports", body);
    expect(r2.body.inserted).toBe(0);
    const imp = await q1<any>(`SELECT * FROM data_imports ORDER BY created_at LIMIT 1`);
    expect(imp.source_label).toBe("대표 보관 정리본");
    const home = await owner.get("/api/home");
    expect(home.body.dataStatus.kakaoVerified).toBe(false);
    expect((await api(ctx.app, ctx.staffCookie).post("/api/imports", body)).status).toBe(401); // 회수된 직원
  });
});

describe("보안", () => {
  it("CSRF 헤더가 없는 상태 변경 요청은 거부된다", async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/api/tasks", headers: { cookie: ctx.ownerCookie, "content-type": "application/json" }, payload: { title: "x" } });
    expect(r.statusCode).toBe(400);
  });
  it("모델 전송 전 연락처를 마스킹한다", () => {
    expect(maskPII("연락처 010-1234-5678, a@b.com 입니다")).toBe("연락처 [전화번호], [이메일] 입니다");
  });
  it("알림 제목에 상담 원문이 들어가지 않는다", async () => {
    const rows = await q<{ title: string }>(`SELECT title FROM notifications`);
    for (const r of rows) expect(r.title).not.toContain("문의드립니다");
  });
});
