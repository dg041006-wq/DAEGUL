// 정기 보고 (서버 실행, KST)
// - 일일: 매일 19:00. 집계 구간 = 직전 일일 보고 기준 시각(없으면 당일 00:00) ~ 당일 19:00.
//   전날 19:00 이후 ~ 당일 00:00 사이 발생분은 '전일 추가분'으로 따로 표시한다.
// - 주간: 금요일 19:10. 최근 7일(직전 금 19:10 ~ 이번 금 19:10)과 그 직전 7일 비교.
// - period_key 고유 인덱스로 중복 생성 방지. 재시작/장애 후에는 가장 최근 놓친 회차를 1회 보충 생성.
// - 테스트 실행은 같은 코드 경로를 쓰되 is_test=true 로 분리 저장.
import { q, q1 } from "../db/pool.js";
import type { Scope } from "../auth/scope.js";
import { getOrgSettings } from "../lib/org.js";
import { addDays, kstDateString, kstStartOfDay, toKstParts } from "../lib/time.js";
import { analyticsOverview, awaitingHuman, dataStatus, quoteAwaitingReply } from "../analytics/metrics.js";
import { deliveryRisks, receivables, schedule } from "../analytics/operations.js";
import { ownerIds, postFeed, notify } from "../lib/events.js";
import { checkAvailability, classifyAiError, createMessage, finishRun, startRun, SYSTEM_DATA_RULE, textOf } from "../ai/client.js";
import { generateIdeas, ideasForReport } from "./ideas.js";
import { audit } from "../lib/audit.js";
import { STAGE_LABELS, type Stage } from "../../shared/domain.js";

const hm = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
};
const won = (n: number | null | undefined) => (n == null ? "-" : `${Math.round(Number(n)).toLocaleString("ko-KR")}원`);
const fmtKst = (d: Date) => d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** now 기준으로 '이미 지난 가장 최근 회차' 계산 */
export function latestDueSlots(now: Date, s: { dailyTime: string; weeklyDay: number; weeklyTime: string }) {
  const today = kstDateString(now);
  const p = toKstParts(now);
  const dailyDate = p.minutes >= hm(s.dailyTime) ? today : addDays(today, -1);
  let wDate = today;
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, -i);
    const dow = toKstParts(kstStartOfDay(d)).dow;
    if (dow === s.weeklyDay && (i > 0 || p.minutes >= hm(s.weeklyTime))) {
      wDate = d;
      break;
    }
  }
  return {
    daily: { date: dailyDate, cutoff: new Date(kstStartOfDay(dailyDate).getTime() + hm(s.dailyTime) * 60000) },
    weekly: { date: wDate, cutoff: new Date(kstStartOfDay(wDate).getTime() + hm(s.weeklyTime) * 60000) },
  };
}

/** 워커 주기 점검에서 호출: 놓친 최근 회차가 있으면 생성 (중복은 DB가 막음) */
export async function runDueReports(orgId: string, now = new Date()) {
  const st = await getOrgSettings(orgId);
  const slots = latestDueSlots(now, st.reports);
  const made: string[] = [];
  if (st.reports.dailyEnabled) {
    const key = `daily:${slots.daily.date}`;
    const ex = await q1(`SELECT 1 FROM reports WHERE org_id=$1 AND period_key=$2 AND NOT is_test`, [orgId, key]);
    if (!ex) {
      const id = await generateDailyReport(orgId, { cutoff: slots.daily.cutoff, periodKey: key, isTest: false, lateCatchUp: now.getTime() - slots.daily.cutoff.getTime() > 3600_000 });
      if (id) made.push(id);
    }
  }
  if (st.reports.weeklyEnabled) {
    const key = `weekly:${slots.weekly.date}`;
    const ex = await q1(`SELECT 1 FROM reports WHERE org_id=$1 AND period_key=$2 AND NOT is_test`, [orgId, key]);
    if (!ex) {
      const id = await generateWeeklyReport(orgId, { cutoff: slots.weekly.cutoff, periodKey: key, isTest: false, lateCatchUp: now.getTime() - slots.weekly.cutoff.getTime() > 3600_000 });
      if (id) made.push(id);
    }
  }
  return made;
}

async function ownerScope(orgId: string): Promise<Scope> {
  const owners = await ownerIds(orgId);
  return { orgId, userId: owners[0] ?? "00000000-0000-0000-0000-000000000000", role: "owner", perms: {} };
}

/** 구간 내 사실 집계 (모두 DB) */
async function facts(orgId: string, start: Date, end: Date) {
  const valid = await q<any>(
    `SELECT o.id, o.services, o.stage, ct.display_name FROM opportunities o JOIN contacts ct ON ct.id=o.contact_id
     WHERE o.org_id=$1 AND o.merged_into_id IS NULL AND o.category='valid' AND o.data_origin <> 'test' AND o.opened_at >= $2 AND o.opened_at < $3`,
    [orgId, start, end],
  );
  const stageMoves = await q<any>(
    `SELECT se.to_stage, count(*) AS n FROM stage_events se JOIN opportunities o ON o.id=se.opportunity_id
     WHERE se.org_id=$1 AND se.occurred_at >= $2 AND se.occurred_at < $3 AND se.actor_type <> 'system' AND o.data_origin <> 'test' GROUP BY se.to_stage`,
    [orgId, start, end],
  );
  const contracts = await q1<any>(
    `SELECT count(*) AS n, COALESCE(sum(amount),0) AS amount FROM contracts k JOIN opportunities o ON o.id=k.opportunity_id
     WHERE k.org_id=$1 AND k.signed_at >= $2 AND k.signed_at < $3 AND o.data_origin <> 'test'`,
    [orgId, start, end],
  );
  const payments = await q1<any>(
    `SELECT count(*) FILTER (WHERE status='confirmed') AS n, COALESCE(sum(amount) FILTER (WHERE status='confirmed'),0) AS amount,
            count(*) FILTER (WHERE status='claimed') AS claimed
     FROM payments WHERE org_id=$1 AND created_at >= $2 AND created_at < $3`,
    [orgId, start, end],
  );
  // 매출(작업 완료 기준): 구간 내 완료/납품 처리된 작업의 확정 금액. 확정 금액이 없으면 '금액 미확정'으로 분리.
  const revenue = await q1<any>(
    `SELECT count(*) AS n, COALESCE(sum(COALESCE(p.agreed_amount,0)),0) AS amount, count(*) FILTER (WHERE p.agreed_amount IS NULL) AS unconfirmed
     FROM projects p WHERE p.org_id=$1 AND p.status IN ('delivered','done') AND p.updated_at >= $2 AND p.updated_at < $3 AND p.data_origin <> 'test'`,
    [orgId, start, end],
  );
  const tasksDone = await q<any>(`SELECT id, title FROM tasks WHERE org_id=$1 AND status='done' AND completed_at >= $2 AND completed_at < $3 ORDER BY completed_at LIMIT 30`, [orgId, start, end]);
  const tasksOpen = await q<any>(
    `SELECT id, title, due_at FROM tasks WHERE org_id=$1 AND status='open' ORDER BY due_at NULLS LAST LIMIT 50`,
    [orgId],
  );
  return { valid, stageMoves, contracts, payments, revenue, tasksDone, tasksOpen };
}

async function maybeInterpret(orgId: string, kind: string, metrics: unknown) {
  const avail = await checkAvailability(orgId);
  if (!avail.ok) return { text: `AI 해석: 대기 — ${avail.message}`, runId: null as string | null, engine: "rules" };
  const runId = await startRun({ orgId, kind: "report", roleKey: "strategy", engine: "model", promptVersion: `${kind}-report-v2` });
  try {
    const res = await createMessage({
      system: `스테이신 대표에게 보내는 ${kind === "daily" ? "일일" : "주간"} 보고의 'AI 해석' 문단을 씁니다. 대표님이라고 부르고 3~5문장으로 짧게. 주어진 집계값만 사용하고 새 수치를 만들지 않습니다. 확인되지 않은 원인은 '가능성'으로만 말합니다.\n${SYSTEM_DATA_RULE}`,
      messages: [{ role: "user", content: `집계값(JSON): ${JSON.stringify(metrics).slice(0, 12000)}` }],
      effort: "low",
      maxTokens: 2000,
    });
    await finishRun(runId, { status: "done", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
    return { text: `AI 해석 (모델):\n${textOf(res)}`, runId, engine: "model" };
  } catch (e: any) {
    const c = classifyAiError(e);
    await finishRun(runId, { status: "failed", error: c.message, errorKind: c.kind });
    return { text: `AI 해석: 생성 실패(${c.message}) — 집계값만 표시합니다.`, runId, engine: "rules" };
  }
}

async function saveReport(orgId: string, r: {
  kind: "daily" | "weekly";
  title: string;
  periodKey: string;
  isTest: boolean;
  start: Date;
  end: Date;
  cutoff: Date;
  body: string;
  metrics: Record<string, unknown>;
  nextActions: Array<{ title: string; link?: string }>;
  targetCount: number;
  runId: string | null;
  createdBy: string | null;
}) {
  const ds = await dataStatus(await ownerScope(orgId));
  const row = await q1<{ id: string }>(
    `INSERT INTO reports(org_id, role_key, kind, title, period_start, period_end, target_count, data_synced_at, body, metrics, next_actions, required_perms, analysis_run_id, created_by, period_key, is_test, cutoff_at)
     VALUES ($1,'ops',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (org_id, kind, period_key, is_test) WHERE period_key IS NOT NULL DO NOTHING RETURNING id`,
    [orgId, r.kind, r.title, r.start, r.end, r.targetCount, ds.lastSyncAt, r.body, r.metrics, JSON.stringify(r.nextActions), ["view_analytics", "view_finance"], r.runId, r.createdBy, r.periodKey, r.isTest, r.cutoff],
  );
  if (!row) return null; // 다른 워커가 이미 생성
  const label = r.kind === "daily" ? "일일 보고" : "주간 보고";
  const prefix = r.isTest ? "[테스트] " : "";
  await postFeed(orgId, "ops", {
    content: `${r.title.startsWith("[테스트]") ? "" : prefix}대표님, ${r.title}가 준비됐습니다. (${fmtKst(r.cutoff)} 기준 집계)\n${r.body.split("\n").slice(2, 7).join("\n")}`,
    kind: "report",
    actions: [{ label: "보고서 열기", type: "open", link: `/reports/${row.id}` }],
    meta: { report_id: row.id, is_test: r.isTest },
  });
  for (const u of await ownerIds(orgId)) {
    await notify(orgId, u, { kind: "report", title: `${prefix}${label}가 도착했습니다`, link: `/reports/${row.id}`, severity: r.isTest ? "info" : "important", dedupeKey: `report:${row.id}` });
  }
  await audit({ orgId, actorType: r.createdBy ? "user" : "system", actorUserId: r.createdBy, action: `report.${r.kind}${r.isTest ? ".test" : ""}`, targetType: "report", targetId: row.id });
  return row.id;
}

export async function generateDailyReport(orgId: string, o: { cutoff: Date; periodKey: string; isTest: boolean; lateCatchUp?: boolean; createdBy?: string | null }) {
  const scope = await ownerScope(orgId);
  const cutoffDay = kstDateString(new Date(o.cutoff.getTime() - 1));
  const dayStart = kstStartOfDay(cutoffDay);
  const prev = await q1<{ cutoff_at: string }>(
    `SELECT cutoff_at FROM reports WHERE org_id=$1 AND kind='daily' AND is_test=$2 AND cutoff_at < $3 ORDER BY cutoff_at DESC LIMIT 1`,
    [orgId, o.isTest, o.cutoff],
  );
  // 직전 보고 이후 놓친 구간(전일 19시 이후)을 포함. 단 최대 7일까지만 거슬러 올라간다.
  const prevCut = prev ? new Date(prev.cutoff_at) : dayStart;
  const start = new Date(Math.max(prevCut.getTime(), o.cutoff.getTime() - 7 * 86400000));
  await generateIdeas(orgId); // 정해진 주기(일 1회)에 경영 제안 갱신
  const f = await facts(orgId, start, o.cutoff);
  const carry = start < dayStart ? await facts(orgId, start, dayStart) : null;
  const awaiting = (await awaitingHuman(scope, 50)).filter((a: any) => o.isTest || a.data_origin !== "test");
  const quoteWait = await quoteAwaitingReply(scope);
  const recv = await receivables(scope);
  const risks = await deliveryRisks(scope, cutoffDay);
  const tomorrow = addDays(cutoffDay, 1);
  const sched = await schedule(scope, tomorrow, tomorrow);
  const overdue = f.tasksOpen.filter((t: any) => t.due_at && new Date(t.due_at) < o.cutoff);
  const decisions = await q<any>(
    `SELECT kind, count(*) AS n FROM approvals WHERE org_id=$1 AND status='draft' GROUP BY kind
     UNION ALL SELECT 'outbound', count(*) FROM outbound_messages WHERE org_id=$1 AND status='pending_approval'
     UNION ALL SELECT 'sheet_review', count(*) FROM sheet_import_rows r JOIN sheet_imports i ON i.id=r.import_id WHERE i.org_id=$1 AND i.status='previewed' AND r.decision='review'`,
    [orgId],
  );
  const ideas = await ideasForReport(orgId, 3);
  const st = Object.fromEntries(f.stageMoves.map((r: any) => [r.to_stage, Number(r.n)]));
  const L: string[] = [];
  L.push(`${o.isTest ? "[테스트] " : ""}일일 보고 · ${cutoffDay}`);
  L.push(`집계 구간: ${fmtKst(start)} ~ ${fmtKst(o.cutoff)} (${o.cutoff.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit" })} 시점까지 집계)${o.lateCatchUp ? " · 서버 지연으로 늦게 생성된 보충 보고" : ""}`);
  L.push("");
  L.push(`■ 신규 문의 ${f.valid.length}건 · 단계 진행: ${Object.entries(st).map(([k, v]) => `${STAGE_LABELS[k as Stage] ?? k} ${v}`).join(", ") || "없음"}`);
  if (carry && (carry.valid.length || Number(carry.contracts?.n) || Number(carry.payments?.n)))
    L.push(`  └ 전일 추가분(직전 보고 이후~자정): 문의 ${carry.valid.length}, 계약 ${carry.contracts.n}, 확인 입금 ${carry.payments.n}`);
  L.push(`■ 돈: 계약금액 ${won(f.contracts.amount)}(${f.contracts.n}건) · 매출(완료 기준 확정금액) ${won(f.revenue.amount)}(${f.revenue.n}건${Number(f.revenue.unconfirmed) ? `, 금액 미확정 ${f.revenue.unconfirmed}건` : ""}) · 확인 입금 ${won(f.payments.amount)}(${f.payments.n}건)${Number(f.payments.claimed) ? ` · 고객 주장/시트 기재 입금(미확인) ${f.payments.claimed}건` : ""}`);
  L.push(`■ 업무: 완료 ${f.tasksDone.length}건 · 남은 일 ${f.tasksOpen.length}건 (마감 지남 ${overdue.length})`);
  L.push(`■ 지연·누락: 답변 대기 ${awaiting.length}건 · 견적 후 회신 대기 ${quoteWait.length}건 · 납기 위험 ${risks.length}건`);
  if (!recv.restricted) L.push(`■ 미수금 확인 대상: ${recv.due.length}건 (합계 ${won(recv.due.reduce((a: number, r: any) => a + r.outstanding, 0))}) · 금액 미확정 ${recv.unconfirmedAmount.length}건`);
  L.push(`■ 내일(${tomorrow}) 일정: ${sched.projects.length ? sched.projects.map((p: any) => `${p.start_time ?? p.time_raw ?? "시간 미정"} ${p.title}`).join(" / ") : "작업 없음"}${sched.blocks.length ? ` · 팀 일정 ${sched.blocks.length}건` : ""}`);
  const dec = decisions.filter((d: any) => Number(d.n) > 0);
  L.push(`■ 대표 결정 필요: ${dec.length ? dec.map((d: any) => `${{ reply_draft: "답장 초안 검토", stage_change: "단계 변경 제안", content: "콘텐츠", outbound: "고객 발송 승인", sheet_review: "시트 가져오기 확인" }[d.kind as string] ?? d.kind} ${d.n}`).join(", ") : "없음"}`);
  L.push("");
  L.push("■ 오늘 실행할 만한 개선 제안 (최대 3개)");
  if (!ideas.length) L.push("- 새 제안 없음 (근거 데이터 부족 또는 이미 검토한 제안)");
  for (const i of ideas) L.push(`- ${i.is_hypothesis ? "[가설] " : ""}${i.title}\n  근거: ${i.evidence}\n  기대 효과(예상): ${i.expected_effect} · 필요: ${i.effort}\n  첫 행동: ${i.first_action}`);
  const metrics = {
    window: { start, cutoff: o.cutoff, carryFromPrevious: !!carry },
    newInquiries: f.valid.length,
    stageMoves: st,
    contracts: f.contracts,
    revenue: f.revenue,
    payments: f.payments,
    tasks: { done: f.tasksDone.length, open: f.tasksOpen.length, overdue: overdue.length },
    awaiting: awaiting.length,
    quoteAwaiting: quoteWait.length,
    deliveryRisks: risks.length,
    receivables: recv.restricted ? null : { count: recv.due.length, unconfirmed: recv.unconfirmedAmount.length },
    tomorrow: sched.projects.length,
    ideas: ideas.map((i) => i.id),
  };
  const ai = await maybeInterpret(orgId, "daily", metrics);
  L.push("", ai.text);
  const next = [
    ...(awaiting.length ? [{ title: `답변 대기 ${awaiting.length}건 처리`, link: "/inbox?filter=awaiting" }] : []),
    ...(recv.due.length ? [{ title: `미수금 확인 ${recv.due.length}건`, link: "/settlement" }] : []),
    ...(sched.projects.length ? [{ title: `내일 일정 ${sched.projects.length}건 준비 확인`, link: "/schedule" }] : []),
    ...(risks.length ? [{ title: `납기 위험 ${risks.length}건`, link: "/schedule" }] : []),
  ];
  if (!o.isTest) await q(`UPDATE ideas SET reported_at=now() WHERE id = ANY($1::uuid[])`, [ideas.map((i) => i.id)]);
  return saveReport(orgId, {
    kind: "daily",
    title: `${o.isTest ? "[테스트] " : ""}일일 보고 ${cutoffDay}`,
    periodKey: o.periodKey,
    isTest: o.isTest,
    start,
    end: o.cutoff,
    cutoff: o.cutoff,
    body: L.join("\n"),
    metrics,
    nextActions: next,
    targetCount: f.valid.length,
    runId: ai.runId,
    createdBy: o.createdBy ?? null,
  });
}

export async function generateWeeklyReport(orgId: string, o: { cutoff: Date; periodKey: string; isTest: boolean; lateCatchUp?: boolean; createdBy?: string | null }) {
  const scope = await ownerScope(orgId);
  const end = o.cutoff;
  const start = new Date(end.getTime() - 7 * 86400000);
  const prevStart = new Date(start.getTime() - 7 * 86400000);
  const cur = await facts(orgId, start, end);
  const prev = await facts(orgId, prevStart, start);
  const periodFrom = kstDateString(start);
  const periodTo = kstDateString(new Date(end.getTime() - 1));
  const ana = await analyticsOverview(scope, { from: periodFrom, to: periodTo, start, end });
  const bySource = await q<any>(
    `SELECT COALESCE(source_channel,'유입경로 미확인') AS source, count(*) AS n, count(*) FILTER (WHERE stage='won') AS won FROM opportunities
     WHERE org_id=$1 AND category='valid' AND merged_into_id IS NULL AND data_origin <> 'test' AND opened_at >= $2 AND opened_at < $3 GROUP BY 1 ORDER BY n DESC`,
    [orgId, start, end],
  );
  const profit = await q<any>(
    `SELECT p.id, p.title, p.agreed_amount, COALESCE(sum(c.amount) FILTER (WHERE c.category LIKE 'direct_%'),0) AS direct, count(c.id) AS cost_rows
     FROM projects p LEFT JOIN costs c ON c.project_id=p.id
     WHERE p.org_id=$1 AND p.status IN ('delivered','done') AND p.updated_at >= $2 AND p.updated_at < $3 GROUP BY p.id`,
    [orgId, start, end],
  );
  const complete = profit.filter((p: any) => p.agreed_amount != null && Number(p.cost_rows) > 0);
  const contrib = complete.reduce((a: number, p: any) => a + Number(p.agreed_amount) - Number(p.direct), 0);
  const repeated = await q<any>(
    `SELECT kw, count(DISTINCT conversation_id) AS n FROM (
       SELECT m.conversation_id, unnest(ARRAY['주차','가격','비용','일정','보정','원본','수정','컷','기간','계약금','환불']) AS kw, m.body
       FROM messages m WHERE m.org_id=$1 AND m.sender_type='customer' AND m.sent_at >= $2 AND m.sent_at < $3) x
     WHERE body ILIKE '%' || kw || '%' GROUP BY kw HAVING count(DISTINCT conversation_id) >= 2 ORDER BY n DESC LIMIT 5`,
    [orgId, start, end],
  );
  const next7 = await schedule(scope, kstDateString(end), addDays(kstDateString(end), 7));
  const recv = await receivables(scope);
  const delta = (a: number, b: number) => (b === 0 ? (a ? "신규" : "변화 없음") : `${a - b >= 0 ? "+" : ""}${a - b} (${Math.round(((a - b) / b) * 100)}%)`);
  const funnel = Object.fromEntries((ana.funnel as any[]).map((r) => [r.stage, Number(r.n)]));
  const L: string[] = [];
  L.push(`${o.isTest ? "[테스트] " : ""}주간 보고 · ${periodFrom} ~ ${periodTo}`);
  L.push(`집계 구간: ${fmtKst(start)} ~ ${fmtKst(end)} (최근 7일) · 비교: ${fmtKst(prevStart)} ~ ${fmtKst(start)}${o.lateCatchUp ? " · 서버 지연으로 늦게 생성된 보충 보고" : ""}`);
  L.push("");
  L.push(`■ 실적 (직전 7일 대비)`);
  L.push(`- 신규 문의 ${cur.valid.length}건 (${delta(cur.valid.length, prev.valid.length)})`);
  L.push(`- 계약 ${cur.contracts.n}건 / ${won(cur.contracts.amount)} (${delta(Number(cur.contracts.n), Number(prev.contracts.n))})`);
  L.push(`- 확인 입금 ${won(cur.payments.amount)} (${delta(Number(cur.payments.amount), Number(prev.payments.amount))})`);
  L.push(`- 완료 작업 ${cur.revenue.n}건, 확정금액 매출 ${won(cur.revenue.amount)}${Number(cur.revenue.unconfirmed) ? ` (금액 미확정 ${cur.revenue.unconfirmed}건)` : ""}`);
  L.push(`■ 전환: 문의 ${funnel.new ?? 0} → 견적 ${funnel.quoted ?? 0} → 계약 ${funnel.won ?? 0}${ana.conversion.note ? ` · ${ana.conversion.note}` : ""}`);
  const lossRows = ana.loss.rows as any[];
  L.push(`■ 이탈: 확인 ${lossRows.filter((r) => r.certainty === "confirmed").reduce((a, r) => a + Number(r.n), 0)} · 추정 ${lossRows.filter((r) => r.certainty === "estimated").reduce((a, r) => a + Number(r.n), 0)} · 사유 불명 ${ana.unknownShares.lossReasonUnknown} · 견적 후 회신 대기 ${(await quoteAwaitingReply(scope)).length}`);
  L.push(`■ 서비스별: ${(ana.conversionByService as any[]).map((r) => `${r.service} ${r.cohort}건/계약 ${r.won}`).join(", ") || "자료 없음"}`);
  L.push(`■ 유입경로별: ${bySource.map((r: any) => `${r.source} ${r.n}건/계약 ${r.won}`).join(", ") || "자료 없음"} (확인된 근거가 있는 경로만 귀속)`);
  L.push(`■ 수익성: 원가 입력 완료 ${complete.length}건 공헌이익(직접비 기준, 순이익 아님) ${won(contrib)} · 원가 미입력 ${profit.length - complete.length}건은 계산 제외`);
  L.push(`■ 반복 고객 요구(고객 메시지 키워드, 2개 이상 상담): ${repeated.map((r: any) => `${r.kw} ${r.n}`).join(", ") || "뚜렷한 반복 없음"}`);
  L.push(`■ 운영 병목: 첫 응답 중앙값(영업시간) ${ana.firstResponse.medianBusinessMinutes ?? "-"}분 · 마감 지난 할 일 ${ana.overdueFollowups}건 · 미수금 확인 ${recv.restricted ? "-" : recv.due.length}건`);
  L.push(`■ 다음 주 우선순위`);
  L.push(`- 예정 작업 ${next7.projects.length}건${next7.projects.filter((p: any) => !p.address || !p.start_time).length ? ` (주소/시간 미확정 ${next7.projects.filter((p: any) => !p.address || !p.start_time).length}건)` : ""}`);
  if (!recv.restricted && recv.due.length) L.push(`- 미수금 ${recv.due.length}건 확인`);
  const ideas = await q<any>(`SELECT title, first_action, is_hypothesis FROM ideas WHERE org_id=$1 AND status='proposed' ORDER BY importance DESC, created_at DESC LIMIT 3`, [orgId]);
  for (const i of ideas) L.push(`- 제안: ${i.is_hypothesis ? "[가설] " : ""}${i.title} → ${i.first_action}`);
  const metrics = { window: { start, end, prevStart }, cur: { inquiries: cur.valid.length, contracts: cur.contracts, payments: cur.payments, revenue: cur.revenue }, prev: { inquiries: prev.valid.length, contracts: prev.contracts, payments: prev.payments, revenue: prev.revenue }, funnel, bySource, profitComplete: complete.length, contribution: contrib, repeated, next7: next7.projects.length };
  const ai = await maybeInterpret(orgId, "weekly", metrics);
  L.push("", ai.text);
  return saveReport(orgId, {
    kind: "weekly",
    title: `${o.isTest ? "[테스트] " : ""}주간 보고 ${periodFrom}~${periodTo}`,
    periodKey: o.periodKey,
    isTest: o.isTest,
    start,
    end,
    cutoff: end,
    body: L.join("\n"),
    metrics,
    nextActions: [{ title: "다음 주 일정 확인", link: "/schedule" }],
    targetCount: cur.valid.length,
    runId: ai.runId,
    createdBy: o.createdBy ?? null,
  });
}

/** 테스트 실행: 실제 시간을 기다리지 않고 같은 경로로 생성, 운영 보고와 분리 */
export async function runTestReport(orgId: string, kind: "daily" | "weekly", userId: string, now = new Date()) {
  const st = await getOrgSettings(orgId);
  const slots = latestDueSlots(now, st.reports);
  const key = `test:${kind}:${now.toISOString()}`;
  return kind === "daily"
    ? generateDailyReport(orgId, { cutoff: slots.daily.cutoff, periodKey: key, isTest: true, createdBy: userId })
    : generateWeeklyReport(orgId, { cutoff: slots.weekly.cutoff, periodKey: key, isTest: true, createdBy: userId });
}
