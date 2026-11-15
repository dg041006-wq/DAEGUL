// AI 직원(운영비서 / 영업·상담 / 경영·전략) 대화와 업무 실행.
// - 필요한 역할만 호출. 전체 회의는 같은 근거 묶음으로 1회 호출.
// - 변경 요청(할 일 등록 등)은 권한 검사 후 실제로 실행하고, 실행 결과는 모델 문장이 아니라 서버 기록으로 표시한다.
// - 모델 미연동/장애/한도 시 규칙 기반 처리(명확히 표시). 규칙 기반에서도 '할 일 넣어줘', '미수금' 같은 명령은 실제 실행.
import type Anthropic from "@anthropic-ai/sdk";
import { q, q1 } from "../db/pool.js";
import { loadScope } from "../auth/session.js";
import { can, ForbiddenError, NotFoundError, type Scope } from "../auth/scope.js";
import { analyticsOverview, awaitingHuman, dataStatus, quoteAwaitingReply } from "../analytics/metrics.js";
import { deliveryRisks, receivables, schedule } from "../analytics/operations.js";
import { addDays, kstDateString, resolvePeriod } from "../lib/time.js";
import { ROLE_LABELS, STAGE_LABELS, type Stage } from "../../shared/domain.js";
import { addEvidence, checkAvailability, classifyAiError, createMessage, finishRun, startRun, SYSTEM_DATA_RULE, textOf } from "./client.js";
import { executeTool, filterEvidence, newToolContext, toolDefinitions, type ToolContext } from "./tools.js";
import { enqueue } from "../jobs/queue.js";
import { createTask, parseWhen, updateTask } from "../lib/tasks.js";
import { draftReply } from "./conversationAnalysis.js";
import { audit } from "../lib/audit.js";
import type { FeedAction } from "../lib/events.js";

export const CHAT_PROMPT_VERSION = "chat-v2";

export async function getRole(orgId: string, roleKey: string) {
  return q1<{ role_key: string; display_name: string; title: string; instructions: string }>(`SELECT role_key, display_name, title, instructions FROM ai_roles WHERE org_id=$1 AND role_key=$2`, [orgId, roleKey]);
}

/** 사용자 질문 저장 → 응답 자리(pending) 생성 → 작업 큐 */
export async function postQuestion(scope: Scope, threadId: string, text: string) {
  const t = await q1<{ id: string }>(`SELECT id FROM ai_threads WHERE id=$1 AND org_id=$2 AND owner_user_id=$3`, [threadId, scope.orgId, scope.userId]);
  if (!t) return null;
  await q(`INSERT INTO ai_messages(thread_id, author, user_id, content) VALUES ($1,'user',$2,$3)`, [threadId, scope.userId, text.slice(0, 4000)]);
  const pending = await q1<{ id: string }>(`INSERT INTO ai_messages(thread_id, author, status, content) VALUES ($1,'assistant','pending','') RETURNING id`, [threadId]);
  await q(`UPDATE ai_threads SET updated_at=now() WHERE id=$1`, [threadId]);
  await enqueue("ai_chat", { messageId: pending!.id, orgId: scope.orgId, userId: scope.userId }, { maxAttempts: 1 });
  return pending!.id;
}

interface Answer {
  content: string;
  customerDraft: string | null;
  nextActions: Array<{ title: string; due?: string | null }>;
  evidence: Array<{ message_id: string | null; conversation_id: string | null; opportunity_id: string | null; note: string }>;
  executed: ToolContext["executed"];
  actions: FeedAction[];
  meta: Record<string, unknown>;
  runId: string;
}

async function saveAnswer(messageId: string, a: Answer) {
  const exec = a.executed.length ? `\n\n실행한 작업 (서버 기록):\n${a.executed.map((e) => `${e.ok ? "✔" : "✖"} ${e.summary}`).join("\n")}` : "";
  await q(
    `UPDATE ai_messages SET status='done', content=$2, customer_draft=$3, next_actions=$4, meta=$5, analysis_run_id=$6, actions=$7, kind=$8 WHERE id=$1`,
    [messageId, a.content + exec, a.customerDraft, JSON.stringify(a.nextActions), { ...a.meta, evidence: a.evidence, executed: a.executed }, a.runId, JSON.stringify(a.actions), a.executed.length ? "action_result" : "reply"],
  );
}

export async function runChatJob(payload: { messageId: string; orgId: string; userId: string }) {
  const msg = await q1<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM ai_messages WHERE id=$1 AND status='pending'`, [payload.messageId]);
  if (!msg) return;
  const thread = await q1<{ role_key: string; owner_user_id: string; kind: string }>(`SELECT role_key, owner_user_id, kind FROM ai_threads WHERE id=$1`, [msg.thread_id]);
  const scope = await loadScope(payload.orgId, thread!.owner_user_id); // 실행 시점 권한 재확인
  if (!scope) {
    await q(`UPDATE ai_messages SET status='failed', content='요청자 권한이 회수되어 처리하지 않았습니다.' WHERE id=$1`, [msg.id]);
    return;
  }
  await q(`UPDATE ai_messages SET status='running' WHERE id=$1`, [msg.id]);
  const history = await q<{ author: string; content: string; meta: any }>(
    `SELECT author, content, meta FROM ai_messages WHERE thread_id=$1 AND id<>$2 AND status='done' ORDER BY created_at DESC LIMIT 12`,
    [msg.thread_id, msg.id],
  );
  history.reverse();
  const question = [...history].reverse().find((h) => h.author === "user")?.content ?? "";
  const context = await threadContext(msg.thread_id);
  const avail = await checkAvailability(scope.orgId);
  let answer: Answer;
  if (!avail.ok) answer = await rulesAnswer(scope, thread!.role_key, question, avail.message, context);
  else {
    try {
      answer = await modelAnswer(scope, thread!.role_key, history, context);
    } catch (e: any) {
      const c = classifyAiError(e);
      answer = await rulesAnswer(scope, thread!.role_key, question, `모델 호출 실패(${c.message}) — 규칙 기반으로 대신 처리합니다.`, context);
    }
  }
  await saveAnswer(msg.id, answer);
}

/** 대화방의 최근 보고가 가리키는 대상 ('이 고객', '이 건' 해석용) */
async function threadContext(threadId: string) {
  const ev = await q1<any>(
    `SELECT e.entity_type, e.entity_id, e.title FROM ai_messages m JOIN events e ON e.id=m.event_id WHERE m.thread_id=$1 AND e.entity_id IS NOT NULL ORDER BY m.created_at DESC LIMIT 1`,
    [threadId],
  );
  if (!ev) return null;
  const ctx: { conversation_id?: string; project_id?: string; opportunity_id?: string; label: string } = { label: ev.title };
  if (ev.entity_type === "conversation") ctx.conversation_id = ev.entity_id;
  if (ev.entity_type === "project") ctx.project_id = ev.entity_id;
  if (ev.entity_type === "opportunity") {
    ctx.opportunity_id = ev.entity_id;
    const c = await q1<{ conversation_id: string }>(`SELECT conversation_id FROM opportunity_conversations WHERE opportunity_id=$1 LIMIT 1`, [ev.entity_id]);
    if (c) ctx.conversation_id = c.conversation_id;
  }
  return ctx;
}

async function baseMeta(scope: Scope, ctx?: ToolContext) {
  const ds = await dataStatus(scope);
  return {
    data_synced_at: ds.lastSyncAt,
    sample_data: ds.usingSampleData,
    kakao_verified: ds.kakaoVerified,
    periods: ctx?.seen.periods ?? [],
    target_counts: ctx ? { conversations: ctx.seen.conversationIds.size, opportunities: ctx.seen.opportunityIds.size, messages: ctx.seen.messageIds.size } : undefined,
  };
}

const ROLE_SYSTEM_COMMON = `당신은 공간 촬영·스타일링·시공·브랜딩 회사 '스테이신'의 AI 직원입니다. 사용자를 '대표님'이라고 부르고 짧고 명확하게 보고합니다(핵심 3~6줄).
원칙:
- 도구로 조회한 DB 자료만 근거로 삼고, 근거 ID를 submit_answer의 evidence에 넣는다.
- 대표님이 할 일 등록·변경·답장 초안을 요청하면 반드시 해당 도구(create_task/update_task/draft_customer_reply)를 호출해 실제로 실행한다. 도구 결과가 실패면 실패라고 말한다. 실행하지 않은 일을 '처리했습니다'라고 말하지 않는다.
- 시각은 모두 한국 시간(Asia/Seoul). due_at은 '+09:00' 오프셋을 붙인 ISO 형식.
- 고객에게 보낼 문장은 customer_draft에만, 승인된 자료만 근거로. 새 가격·할인·일정 확약·계약 조건을 약속하지 않는다.
- 입금은 '확인된 입금'과 '고객 주장/시트 기재(미확인)'를 구분한다. 견적 후 침묵은 이탈로 확정하지 않는다.
- 담당 영역 밖의 내용은 한 줄로 담당자를 안내하고 반복 설명하지 않는다.
- 마지막에 submit_answer를 한 번 호출한다.
${SYSTEM_DATA_RULE}`;

async function modelAnswer(scope: Scope, roleKey: string, history: Array<{ author: string; content: string }>, context: Awaited<ReturnType<typeof threadContext>>): Promise<Answer> {
  let roleText: string;
  if (roleKey === "meeting") {
    const roles = await q<{ title: string; display_name: string; instructions: string }>(`SELECT title, display_name, instructions FROM ai_roles WHERE org_id=$1 ORDER BY role_key`, [scope.orgId]);
    roleText = `지금은 '전체 회의'입니다. 세 담당이 같은 근거로 각자 영역만 1~2줄씩 말하고, 마지막에 대표님이 먼저 할 일 3가지를 정리합니다. 같은 내용을 반복하지 않습니다.\n${roles.map((r) => `- ${r.title}(${r.display_name}): ${r.instructions}`).join("\n")}`;
  } else {
    const role = await getRole(scope.orgId, roleKey);
    roleText = `당신의 역할: ${role!.title} ${role!.display_name}(AI)\n담당 영역: ${role!.instructions}`;
  }
  const system = `${ROLE_SYSTEM_COMMON}\n\n${roleText}\n\n요청자: ${scope.role === "owner" ? "대표" : "직원"}${can(scope, "view_finance") ? "" : " — 금액/재무 조회 불가"}. 오늘(KST): ${kstDateString(new Date())}${
    context ? `\n이 대화방의 최근 보고 대상: ${context.label} (${JSON.stringify({ conversation_id: context.conversation_id, project_id: context.project_id, opportunity_id: context.opportunity_id })}) — '이 고객/이 건'은 이 대상을 뜻함` : ""
  }`;
  const ctx = newToolContext(scope);
  ctx.draftReply = async (cid) => {
    const r = await draftReply(scope.orgId, cid, scope.userId);
    return r.ok ? { ok: true, body: r.body, approvalId: r.approvalId } : { ok: false, message: r.message };
  };
  if (context?.conversation_id) ctx.seen.conversationIds.add(context.conversation_id);
  if (context?.opportunity_id) ctx.seen.opportunityIds.add(context.opportunity_id);
  const runId = await startRun({ orgId: scope.orgId, kind: roleKey === "meeting" ? "meeting" : "chat", roleKey, engine: "model", promptVersion: CHAT_PROMPT_VERSION, scope: { role: scope.role, perms: scope.perms }, requestedBy: scope.userId });
  const messages: Anthropic.MessageParam[] = history.map((h) => ({ role: h.author === "user" ? "user" : "assistant", content: h.content || "(빈 응답)" }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  const tools = toolDefinitions(scope);
  let inTok = 0;
  let outTok = 0;
  let submitted: any = null;
  let lastText = "";
  try {
    for (let i = 0; i < 10 && !submitted; i++) {
      const res = await createMessage({ system, messages, tools, effort: "medium" });
      inTok += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      outTok += res.usage.output_tokens;
      lastText = textOf(res) || lastText;
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "pause_turn") continue;
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        if (u.name === "submit_answer") {
          submitted = u.input;
          results.push({ type: "tool_result", tool_use_id: u.id, content: "제출됨" });
          continue;
        }
        try {
          const out = await executeTool(ctx, u.name, u.input);
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 60_000) });
        } catch {
          results.push({ type: "tool_result", tool_use_id: u.id, content: "도구 실행 오류", is_error: true });
        }
      }
      if (submitted) break;
      messages.push({ role: "user", content: results });
    }
    const evidence = filterEvidence(ctx, submitted?.evidence ?? []);
    await addEvidence(runId, evidence.map((e) => ({ messageId: e.message_id, conversationId: e.conversation_id, opportunityId: e.opportunity_id, note: e.note })));
    const meta = await baseMeta(scope, ctx);
    await finishRun(runId, { status: "done", inputTokens: inTok, outputTokens: outTok, scope: { periods: meta.periods, target_counts: meta.target_counts, executed: ctx.executed.length } });
    const gaps: string[] = Array.isArray(submitted?.data_gaps) ? submitted.data_gaps : [];
    return {
      content: (submitted?.answer ?? lastText ?? "답변을 생성하지 못했습니다.") + (gaps.length ? `\n\n자료 부족 / 확인 필요:\n${gaps.map((g) => `- ${g}`).join("\n")}` : ""),
      customerDraft: submitted?.customer_draft ?? null,
      nextActions: Array.isArray(submitted?.next_actions) ? submitted.next_actions.slice(0, 10) : [],
      evidence,
      executed: ctx.executed,
      actions: [],
      meta: { ...meta, engine: "model" },
      runId,
    };
  } catch (e: any) {
    const c = classifyAiError(e);
    await finishRun(runId, { status: "failed", inputTokens: inTok, outputTokens: outTok, error: c.message, errorKind: c.kind });
    if (ctx.executed.length) {
      // 일부 실행 후 실패: 실행 기록은 보존
      return { content: `대표님, 처리 중 모델 오류가 발생했습니다(${c.message}).`, customerDraft: null, nextActions: [], evidence: [], executed: ctx.executed, actions: [], meta: { engine: "model", error: c.kind }, runId };
    }
    throw e;
  }
}

const won = (n: number | null | undefined) => (n == null ? "-" : `${Math.round(Number(n)).toLocaleString("ko-KR")}원`);
const fmtMin = (m: number | null | undefined) => (m == null ? "-" : m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);

/**
 * 규칙 기반 처리: 모델 없이 DB와 명확한 명령 규칙으로만 동작.
 * 명령: '할 일 … 넣어/등록/추가', '미수금', '일정', '답장/견적 초안'. 그 외는 역할별 기본 브리핑.
 */
export async function rulesAnswer(scope: Scope, roleKey: string, question: string, reason: string, context: Awaited<ReturnType<typeof threadContext>> = null): Promise<Answer> {
  const runId = await startRun({ orgId: scope.orgId, kind: roleKey === "meeting" ? "meeting" : "chat", roleKey, engine: "rules", promptVersion: "rules-v2", requestedBy: scope.userId });
  const L: string[] = [`[규칙 기반] ${reason}`];
  const evidence: Answer["evidence"] = [];
  const executed: Answer["executed"] = [];
  const actions: FeedAction[] = [];
  const nextActions: Answer["nextActions"] = [];
  const text = question.trim();
  const period = resolvePeriod(undefined, undefined, 30);
  const today = kstDateString(new Date());

  if (/할\s*일|할일|일정\s*넣|알림/.test(text) && /(넣|등록|추가|만들|잡아)/.test(text)) {
    const due = parseWhen(text);
    const title =
      text
        .replace(/(할\s*일|할일)(로)?\s*(좀)?\s*(넣어|등록해|추가해|만들어|잡아)\s*(줘|주세요|줄래)?\.?/g, "")
        .replace(/(오늘|내일|모레)\s*(오전|오후|저녁)?\s*(\d{1,2}\s*시(\s*\d{1,2}\s*분|\s*반)?)?\s*(에|까지)?/g, "")
        .replace(/\s+/g, " ")
        .trim() || "대표님 요청 업무";
    try {
      const t = await createTask(scope, { title: title.slice(0, 120), due_at: due, conversation_id: context?.conversation_id ?? null, project_id: context?.project_id ?? null, opportunity_id: context?.opportunity_id ?? null, source: "ai", source_reason: "AI 직원 대화 요청(규칙 처리)" }, "ai");
      executed.push({ tool: "create_task", ok: true, summary: `할 일 등록: ${t.title}${due ? ` · 기한 ${new Date(due).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : " · 기한 없음(시점 표현을 찾지 못함)"}${context ? ` · 연결: ${context.label}` : ""}`, ref: { type: "task", id: t.id } });
      L.push(`대표님, 할 일로 등록했습니다.`);
      actions.push({ label: "할 일 보기", type: "open", link: "/tasks" });
    } catch (e: any) {
      executed.push({ tool: "create_task", ok: false, summary: `할 일 등록 실패: ${e.message}` });
    }
  } else if (/미수금|미입금|입금\s*확인/.test(text)) {
    const r = await receivables(scope);
    if (r.restricted) L.push("대표님, 금액 조회 권한이 없어 미수금을 보여드릴 수 없습니다.");
    else {
      L.push(`대표님, 미수금 확인 대상은 ${r.due.length}건입니다 (확정 금액 기준, 합계 ${won(r.due.reduce((a: number, x: any) => a + x.outstanding, 0))}).`);
      for (const x of r.due.slice(0, 8)) L.push(`- ${x.display_name ?? x.title} · ${x.scheduled_date ? String(x.scheduled_date).slice(0, 10) : "날짜 미정"} · 미수 ${won(x.outstanding)}${Number(x.claimed) ? " · 고객 주장 입금 있음(미확인)" : ""}`);
      if (r.unconfirmedAmount.length) L.push(`금액이 확정되지 않은 작업 ${r.unconfirmedAmount.length}건(시트 단가만 있음)은 금액 확정 후 판단할 수 있습니다.`);
      actions.push({ label: "정산 화면", type: "open", link: "/settlement" });
    }
  } else if (/(답장|견적).*(초안)|초안.*(답장|견적)/.test(text)) {
    if (!context?.conversation_id) L.push("대표님, 어느 상담의 초안인지 알 수 없습니다. 상담함에서 해당 상담을 열고 'AI 초안 만들기'를 눌러 주세요.");
    else {
      const r = await draftReply(scope.orgId, context.conversation_id, scope.userId);
      executed.push({ tool: "draft_customer_reply", ok: r.ok, summary: r.ok ? "답장 초안 생성(승인 대기, 미발송)" : `답장 초안 실패: ${r.message}` });
      actions.push({ label: "상담 열기", type: "open", link: `/inbox/${context.conversation_id}` });
    }
  } else if (/일정|내일|이번\s*주/.test(text)) {
    const to = /이번\s*주/.test(text) ? addDays(today, 7) : addDays(today, 1);
    const from = /내일/.test(text) ? addDays(today, 1) : today;
    const sch = await schedule(scope, from, to);
    L.push(`대표님, ${from}~${to} 작업 ${sch.projects.length}건입니다.`);
    for (const p of sch.projects.slice(0, 10) as any[]) L.push(`- ${String(p.scheduled_date).slice(0, 10)} ${p.start_time ?? p.time_raw ?? "시간 미정"} ${p.title}${!p.address ? " · 주소 미확인" : ""}`);
    actions.push({ label: "일정 화면", type: "open", link: "/schedule" });
  } else {
    // 역할별 기본 브리핑 (담당 영역이 겹치지 않게)
    if (roleKey === "ops" || roleKey === "meeting") {
      const sch = await schedule(scope, today, addDays(today, 1));
      const risks = await deliveryRisks(scope, today);
      const overdue = await q1<{ n: number }>(`SELECT count(*) AS n FROM tasks WHERE org_id=$1 AND status='open' AND due_at < now() ${can(scope, "view_all_conversations") ? "" : "AND assignee_user_id=$2"}`, can(scope, "view_all_conversations") ? [scope.orgId] : [scope.orgId, scope.userId]);
      const r = await receivables(scope);
      L.push(`[${ROLE_LABELS.ops}] 오늘·내일 작업 ${sch.projects.length}건 · 마감 지난 할 일 ${overdue?.n ?? 0}건 · 납기 위험 ${risks.length}건${r.restricted ? "" : ` · 미수금 확인 ${r.due.length}건`}`);
      for (const p of sch.projects.slice(0, 4) as any[]) L.push(`- ${String(p.scheduled_date).slice(0, 10)} ${p.start_time ?? p.time_raw ?? "시간 미정"} ${p.title}`);
      if (sch.projects.length) actions.push({ label: "일정 보기", type: "open", link: "/schedule" });
    }
    if (roleKey === "sales" || roleKey === "meeting") {
      const awaiting = await awaitingHuman(scope, 10);
      const qw = await quoteAwaitingReply(scope);
      L.push(`[${ROLE_LABELS.sales}] 답변 대기 ${awaiting.length}건 · 견적 후 회신 대기 ${qw.length}건(이탈 확정 아님)`);
      for (const a of awaiting.slice(0, 4)) {
        L.push(`- ${a.display_name ?? "이름 미제공"} · 대기 ${fmtMin(a.waiting_total_minutes)} (영업시간 ${fmtMin(a.waiting_business_minutes)})`);
        evidence.push({ message_id: null, conversation_id: a.id, opportunity_id: a.opportunity_id ?? null, note: "답변 대기 상담" });
      }
      if (awaiting[0]) {
        nextActions.push({ title: `${awaiting[0].display_name ?? "가장 오래 기다린 고객"} 상담에 답변` });
        actions.push({ label: "가장 오래된 상담", type: "open", link: `/inbox/${awaiting[0].id}` });
      }
    }
    if ((roleKey === "strategy" || roleKey === "meeting") && can(scope, "view_analytics")) {
      const ana = await analyticsOverview(scope, period);
      const f = Object.fromEntries((ana.funnel as any[]).map((r) => [r.stage, Number(r.n)]));
      L.push(`[${ROLE_LABELS.strategy}] 최근 30일 문의 ${ana.counts.valid}건 → ${["quoted", "won"].map((s) => `${STAGE_LABELS[s as Stage]} ${f[s] ?? 0}`).join(" → ")} · 유입경로 미확인 ${ana.unknownShares.sourceUnknown}건`);
      const ideas = await q<any>(`SELECT title FROM ideas WHERE org_id=$1 AND status='proposed' ORDER BY importance DESC, created_at DESC LIMIT 2`, [scope.orgId]);
      for (const i of ideas) L.push(`- 검토 대기 제안: ${i.title}`);
      if (ideas.length) actions.push({ label: "제안 보기", type: "open", link: "/ideas" });
    }
    L.push("자연어 해석·콘텐츠 제안은 모델 연동 시 제공됩니다.");
  }
  const meta = await baseMeta(scope);
  await finishRun(runId, { status: "done", scope: { periods: [{ from: period.from, to: period.to }], executed: executed.length } });
  return { content: L.join("\n"), customerDraft: null, nextActions, evidence, executed, actions, meta: { ...meta, engine: "rules" }, runId };
}

/**
 * 보고 메시지의 버튼 실행. 버튼 정의는 서버에 저장된 것만 사용(클라이언트가 임의 작업을 보낼 수 없음).
 * 실행할 때마다 현재 사용자 권한을 다시 검사한다.
 */
export async function executeFeedAction(scope: Scope, messageId: string, index: number) {
  const m = await q1<any>(
    `SELECT m.*, t.owner_user_id, t.org_id, t.role_key, e.entity_type, e.entity_id, e.title AS event_title FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id
     LEFT JOIN events e ON e.id=m.event_id WHERE m.id=$1`,
    [messageId],
  );
  if (!m || m.org_id !== scope.orgId || m.owner_user_id !== scope.userId) throw new NotFoundError();
  const action: FeedAction | undefined = (m.actions ?? [])[index];
  if (!action) throw new NotFoundError("버튼을 찾을 수 없습니다.");
  let result: { ok: boolean; summary: string; link?: string };
  switch (action.type) {
    case "open":
      return { ok: true, summary: "이동", link: action.link };
    case "create_task": {
      const due = action.due === "today" ? parseWhen("오늘 오후 6시") : action.due === "tomorrow_am" ? parseWhen("내일 오전") : null;
      const t = await createTask(scope, { title: action.title, due_at: due, conversation_id: action.conversation_id ?? null, opportunity_id: action.opportunity_id ?? null, project_id: action.project_id ?? null, contact_id: action.contact_id ?? null, source: "ai", source_reason: "AI 보고에서 등록" });
      result = { ok: true, summary: `할 일로 등록했습니다: ${t.title}`, link: "/tasks" };
      break;
    }
    case "snooze": {
      const remind = parseWhen(action.days >= 2 ? "모레 오전" : "내일 오전");
      if (m.meta?.task_id) await updateTask(scope, m.meta.task_id, { remind_at: remind });
      else await createTask(scope, { title: `다시 확인: ${m.event_title ?? m.content.split("\n")[0].slice(0, 80)}`, remind_at: remind, due_at: remind, source: "ai", source_reason: "보고 '다시 알림'" });
      result = { ok: true, summary: `${action.days >= 2 ? "모레" : "내일"} 오전 10시에 다시 알려드리겠습니다.` };
      break;
    }
    case "resolve": {
      if (m.meta?.task_id) await updateTask(scope, m.meta.task_id, { status: "done" });
      await q(`UPDATE ai_messages SET read_at=now(), meta = meta || '{"resolved":true}'::jsonb WHERE id=$1`, [m.id]);
      result = { ok: true, summary: "처리 완료로 표시했습니다." };
      break;
    }
    case "draft_reply": {
      const r = await draftReply(scope.orgId, action.conversation_id, scope.userId, scope);
      result = r.ok ? { ok: true, summary: "답장 초안을 만들었습니다(미발송, 검토 필요).", link: `/inbox/${action.conversation_id}` } : { ok: false, summary: r.message ?? "초안 실패", link: `/inbox/${action.conversation_id}` };
      break;
    }
    case "assign_self": {
      const { getAccessibleConversation } = await import("../routes/core.js");
      const c = await getAccessibleConversation(scope, action.conversation_id);
      if (c.assignee_user_id && c.assignee_user_id !== scope.userId && !can(scope, "view_all_conversations")) throw new ForbiddenError();
      await q(`UPDATE conversations SET assignee_user_id=$2 WHERE id=$1`, [c.id, scope.userId]);
      await audit({ orgId: scope.orgId, actorUserId: scope.userId, action: "conversation.assign", targetType: "conversation", targetId: c.id, detail: { via: "feed_action" } });
      result = { ok: true, summary: "담당자로 지정했습니다.", link: `/inbox/${c.id}` };
      break;
    }
    default:
      throw new NotFoundError();
  }
  await q(`INSERT INTO ai_messages(thread_id, author, status, content, kind, meta) VALUES ($1,'assistant','done',$2,'action_result',$3)`, [
    m.thread_id,
    `${result.ok ? "✔" : "✖"} ${result.summary}`,
    { engine: "rules", action: action.type, source_message: m.id },
  ]);
  return result;
}
