// AI 직원(마케팅 팀장 / CS 팀장 / 경영전략실장) 대화 처리.
// - 요청마다 필요한 역할만 호출한다. 3개 모델을 동시에 호출하지 않는다.
// - 전체 회의는 '공유 근거 묶음'을 1회 호출로 검토한다.
// - 모델 미연동/한도 도달 시 규칙 기반 DB 집계 결과를 '규칙 기반'으로 명확히 표시한다.
import type Anthropic from "@anthropic-ai/sdk";
import { q, q1 } from "../db/pool.js";
import { loadScope } from "../auth/session.js";
import { can, type Scope } from "../auth/scope.js";
import { analyticsOverview, awaitingHuman, dataStatus, quoteAwaitingReply } from "../analytics/metrics.js";
import { resolvePeriod } from "../lib/time.js";
import { STAGE_LABELS, LOSS_REASON_LABELS, CERTAINTY_LABELS, type Stage } from "../../shared/domain.js";
import { addEvidence, checkAvailability, createMessage, finishRun, startRun, SYSTEM_DATA_RULE, textOf } from "./client.js";
import { executeTool, filterEvidence, newToolContext, toolDefinitions, type ToolContext } from "./tools.js";
import { enqueue } from "../jobs/queue.js";

export const CHAT_PROMPT_VERSION = "chat-v1";

export async function getRole(orgId: string, roleKey: string) {
  return q1<{ role_key: string; display_name: string; title: string; instructions: string }>(
    `SELECT role_key, display_name, title, instructions FROM ai_roles WHERE org_id=$1 AND role_key=$2`,
    [orgId, roleKey],
  );
}

/** 사용자 질문 저장 → 응답 자리(pending) 생성 → 작업 큐 */
export async function postQuestion(scope: Scope, threadId: string, text: string) {
  const t = await q1<{ id: string; role_key: string }>(`SELECT id, role_key FROM ai_threads WHERE id=$1 AND org_id=$2 AND owner_user_id=$3`, [
    threadId,
    scope.orgId,
    scope.userId,
  ]);
  if (!t) return null;
  await q(`INSERT INTO ai_messages(thread_id, author, user_id, content) VALUES ($1,'user',$2,$3)`, [threadId, scope.userId, text.slice(0, 4000)]);
  const pending = await q1<{ id: string }>(
    `INSERT INTO ai_messages(thread_id, author, status, content) VALUES ($1,'assistant','pending','') RETURNING id`,
    [threadId],
  );
  await q(`UPDATE ai_threads SET updated_at=now() WHERE id=$1`, [threadId]);
  await enqueue("ai_chat", { messageId: pending!.id, orgId: scope.orgId, userId: scope.userId }, { maxAttempts: 1 });
  return pending!.id;
}

export async function runChatJob(payload: { messageId: string; orgId: string; userId: string }) {
  const msg = await q1<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM ai_messages WHERE id=$1 AND status='pending'`, [payload.messageId]);
  if (!msg) return;
  const thread = await q1<{ role_key: string; owner_user_id: string }>(`SELECT role_key, owner_user_id FROM ai_threads WHERE id=$1`, [msg.thread_id]);
  // 권한은 작업 실행 시점에 다시 확인 (그 사이 계정 회수 가능)
  const scope = await loadScope(payload.orgId, thread!.owner_user_id);
  if (!scope) {
    await q(`UPDATE ai_messages SET status='failed', content='요청자 권한이 회수되어 처리하지 않았습니다.' WHERE id=$1`, [msg.id]);
    return;
  }
  await q(`UPDATE ai_messages SET status='running' WHERE id=$1`, [msg.id]);
  const history = await q<{ author: string; content: string }>(
    `SELECT author, content FROM ai_messages WHERE thread_id=$1 AND id<>$2 AND status='done' ORDER BY created_at DESC LIMIT 10`,
    [msg.thread_id, msg.id],
  );
  history.reverse();
  const question = [...history].reverse().find((h) => h.author === "user")?.content ?? "";

  const avail = await checkAvailability(scope.orgId);
  try {
    if (!avail.ok) {
      const r = await rulesAnswer(scope, thread!.role_key, avail.message);
      await saveAnswer(msg.id, r);
      return;
    }
    const r = await modelAnswer(scope, thread!.role_key, history);
    await saveAnswer(msg.id, r);
  } catch (e: any) {
    console.error("ai_chat failed", e?.status ?? "", e?.name ?? "");
    const r = await rulesAnswer(scope, thread!.role_key, "모델 호출 중 오류가 발생해 규칙 기반 집계로 대신 답합니다.");
    await saveAnswer(msg.id, r);
  }
  void question;
}

interface Answer {
  content: string;
  customerDraft: string | null;
  nextActions: Array<{ title: string; due?: string | null }>;
  evidence: Array<{ message_id: string | null; conversation_id: string | null; opportunity_id: string | null; note: string }>;
  meta: Record<string, unknown>;
  runId: string;
}

async function saveAnswer(messageId: string, a: Answer) {
  await q(
    `UPDATE ai_messages SET status='done', content=$2, customer_draft=$3, next_actions=$4, meta=$5, analysis_run_id=$6 WHERE id=$1`,
    [messageId, a.content, a.customerDraft, JSON.stringify(a.nextActions), { ...a.meta, evidence: a.evidence }, a.runId],
  );
}

async function baseMeta(scope: Scope, ctx?: ToolContext) {
  const ds = await dataStatus(scope);
  return {
    data_synced_at: ds.lastSyncAt,
    sample_data: ds.usingSampleData,
    kakao_verified: ds.kakaoVerified,
    periods: ctx?.seen.periods ?? [],
    target_counts: ctx
      ? { conversations: ctx.seen.conversationIds.size, opportunities: ctx.seen.opportunityIds.size, messages: ctx.seen.messageIds.size }
      : undefined,
  };
}

const ROLE_SYSTEM_COMMON = `당신은 인테리어·공간 촬영/스타일링 회사 '스테이신'의 내부 업무용 AI 직원입니다. 사용자는 대표 또는 초대받은 직원입니다.
답변 원칙:
- 반드시 도구로 조회한 DB 자료만 근거로 삼고, 근거가 된 message_id/conversation_id/opportunity_id를 submit_answer의 evidence에 넣는다.
- 분석 기간, 대상 건수, 자료 부족 사항을 분명히 한다. 샘플 데이터일 수 있으므로 실제 고객 분석 완료라고 단정하지 않는다.
- 이탈 사유는 확인/추정/사유 불명을 구분한다. 견적 후 침묵은 '견적 후 회신 대기'이며 가격 이탈로 확정하지 않는다. 응대 지연과 이탈이 함께 있어도 원인으로 단정하지 않는다.
- 유입경로는 캠페인 식별정보나 고객의 직접 답변이 있을 때만 귀속한다. 광고비/클릭 자료가 없으면 획득 비용·수익률을 만들지 않는다.
- 고객에게 보낼 문장은 customer_draft에만 쓰고, 승인된 지식 문서(get_approved_knowledge)만 근거로 한다. 승인 문서가 없으면 금액·할인·일정을 쓰지 않는다.
- 답변은 한국어로 간결하게. 마지막에 반드시 submit_answer 도구를 한 번 호출해 제출한다.
${SYSTEM_DATA_RULE}`;

async function modelAnswer(scope: Scope, roleKey: string, history: Array<{ author: string; content: string }>): Promise<Answer> {
  let roleText: string;
  if (roleKey === "meeting") {
    const roles = await q<{ title: string; display_name: string; instructions: string }>(
      `SELECT title, display_name, instructions FROM ai_roles WHERE org_id=$1 ORDER BY role_key`,
      [scope.orgId],
    );
    roleText = `지금은 '전체 회의'입니다. 아래 세 팀장의 관점에서 같은 근거 묶음을 함께 검토하고, 관점별 의견을 짧게 정리한 뒤 대표가 먼저 할 일 3가지를 제안합니다.\n${roles
      .map((r) => `- ${r.title}(${r.display_name}): ${r.instructions}`)
      .join("\n")}`;
  } else {
    const role = await getRole(scope.orgId, roleKey);
    roleText = `당신의 역할: ${role!.title} (${role!.display_name}, AI)\n역할 지침: ${role!.instructions}`;
  }
  const system = `${ROLE_SYSTEM_COMMON}\n\n${roleText}\n\n요청자 권한: ${scope.role === "owner" ? "대표(전체)" : "직원"}${
    can(scope, "view_finance") ? "" : " — 금액/재무 자료 조회 불가"
  }. 오늘(KST): ${resolvePeriod().to}`;

  const ctx = newToolContext(scope);
  const runId = await startRun({
    orgId: scope.orgId,
    kind: roleKey === "meeting" ? "meeting" : "chat",
    roleKey,
    engine: "model",
    promptVersion: CHAT_PROMPT_VERSION,
    scope: { role: scope.role, perms: scope.perms },
    requestedBy: scope.userId,
  });
  const messages: Anthropic.MessageParam[] = history.map((h) => ({ role: h.author === "user" ? "user" : "assistant", content: h.content || "(빈 응답)" }));
  // 첫 메시지는 user여야 함
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
      if (res.stop_reason === "refusal") throw new Error("model refusal");
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
        } catch (e: any) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: "도구 실행 오류", is_error: true });
        }
      }
      if (submitted) break;
      messages.push({ role: "user", content: results });
    }
    const evidence = filterEvidence(ctx, submitted?.evidence ?? []);
    await addEvidence(
      runId,
      evidence.map((e) => ({ messageId: e.message_id, conversationId: e.conversation_id, opportunityId: e.opportunity_id, note: e.note })),
    );
    const meta = await baseMeta(scope, ctx);
    await finishRun(runId, { status: "done", inputTokens: inTok, outputTokens: outTok, scope: { periods: meta.periods, target_counts: meta.target_counts } });
    const gaps: string[] = Array.isArray(submitted?.data_gaps) ? submitted.data_gaps : [];
    return {
      content: (submitted?.answer ?? lastText ?? "답변을 생성하지 못했습니다.") + (gaps.length ? `\n\n자료 부족 / 확인 필요:\n${gaps.map((g) => `- ${g}`).join("\n")}` : ""),
      customerDraft: submitted?.customer_draft ?? null,
      nextActions: Array.isArray(submitted?.next_actions) ? submitted.next_actions.slice(0, 10) : [],
      evidence,
      meta: { ...meta, engine: "model" },
      runId,
    };
  } catch (e: any) {
    await finishRun(runId, { status: "failed", inputTokens: inTok, outputTokens: outTok, error: String(e?.message ?? e).slice(0, 300) });
    throw e;
  }
}

const fmtMin = (m: number | null | undefined) => (m == null ? "-" : m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);

/** 규칙 기반 답변: DB 집계만 사용. 질문 의도 해석 없이 역할별 표준 브리핑을 돌려준다. */
export async function rulesAnswer(scope: Scope, roleKey: string, reason: string): Promise<Answer> {
  const runId = await startRun({ orgId: scope.orgId, kind: roleKey === "meeting" ? "meeting" : "chat", roleKey, engine: "rules", promptVersion: "rules-v1", requestedBy: scope.userId });
  const lines: string[] = [`[규칙 기반 집계] ${reason}`, "질문 내용을 해석하지 않고 역할별 기본 브리핑을 DB 집계로 보여드립니다.", ""];
  const evidence: Answer["evidence"] = [];
  const nextActions: Answer["nextActions"] = [];
  const period = resolvePeriod(undefined, undefined, 30);
  const periods = [{ from: period.from, to: period.to }];
  let target = 0;

  const awaiting = roleKey === "cs" || roleKey === "meeting" ? await awaitingHuman(scope, 10) : [];
  const quoteWait = roleKey === "strategy" || roleKey === "meeting" ? await quoteAwaitingReply(scope) : [];
  const ana = can(scope, "view_analytics") && roleKey !== "cs" ? await analyticsOverview(scope, period) : null;

  if (roleKey === "cs" || roleKey === "meeting") {
    lines.push(`■ 사람 답변 대기 ${awaiting.length}건 (오래 기다린 순)`);
    for (const a of awaiting.slice(0, 5)) {
      lines.push(`- ${a.display_name ?? "이름 미제공"} · 경과 ${fmtMin(a.waiting_total_minutes)} (영업시간 ${fmtMin(a.waiting_business_minutes)}) · 담당 ${a.assignee_name ?? "미배정"}`);
      evidence.push({ message_id: null, conversation_id: a.id, opportunity_id: a.opportunity_id ?? null, note: "답변 대기 상담" });
    }
    if (awaiting[0]) nextActions.push({ title: `${awaiting[0].display_name ?? "가장 오래 기다린 고객"} 상담에 답변`, due: null });
    target += awaiting.length;
    const missing = await q<any>(
      `SELECT c.id, ct.display_name, jsonb_array_length(c.ai_missing_questions) AS n FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
       WHERE c.org_id=$1 AND jsonb_array_length(c.ai_missing_questions) > 0 ${can(scope, "view_all_conversations") ? "" : "AND c.assignee_user_id=$2"} LIMIT 5`,
      can(scope, "view_all_conversations") ? [scope.orgId] : [scope.orgId, scope.userId],
    );
    if (missing.length) {
      lines.push("", "■ 필수 정보 누락 질문 후보가 있는 상담");
      missing.forEach((m) => lines.push(`- ${m.display_name ?? "이름 미제공"}: 질문 후보 ${m.n}개`));
    }
    lines.push("");
  }
  if (roleKey === "strategy" || roleKey === "meeting") {
    lines.push(`■ 견적 후 회신 대기 ${quoteWait.length}건 — 가격 이탈로 확정하지 않음`);
    for (const qw of quoteWait.slice(0, 5) as any[]) {
      lines.push(`- ${qw.display_name ?? "이름 미제공"} · ${(qw.services ?? []).join(", ") || "서비스 미분류"} · 견적 발송 ${new Date(qw.quote_sent_at).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`);
      evidence.push({ message_id: null, conversation_id: null, opportunity_id: qw.id, note: "견적 후 회신 대기" });
    }
    if (quoteWait[0]) nextActions.push({ title: "견적 후 회신 대기 고객에게 후속 연락 여부 결정", due: null });
    target += quoteWait.length;
    if (ana) {
      lines.push("", `■ 최근 30일 전환 (${period.from} ~ ${period.to})`);
      const f = Object.fromEntries((ana.funnel as any[]).map((r) => [r.stage, Number(r.n)]));
      lines.push(["new", "requirements", "quoted", "negotiating", "won"].map((s) => `${STAGE_LABELS[s as Stage]} ${f[s] ?? 0}`).join(" → "));
      if (ana.conversion.note) lines.push(`※ ${ana.conversion.note}`);
      const lossRows = ana.loss.rows as any[];
      if (lossRows.length || ana.loss.lostWithoutAssessment) {
        lines.push("이탈 사유: " + lossRows.map((r) => `${CERTAINTY_LABELS[r.certainty as keyof typeof CERTAINTY_LABELS]}·${LOSS_REASON_LABELS[r.reason_code as keyof typeof LOSS_REASON_LABELS]} ${r.n}`).join(", ") + (ana.loss.lostWithoutAssessment ? ` / 평가 없음 ${ana.loss.lostWithoutAssessment}` : ""));
      }
    }
    lines.push("");
  }
  if (roleKey === "marketing" || roleKey === "meeting") {
    if (ana) {
      lines.push(`■ 최근 30일 유효 문의 ${ana.counts.valid}건 · 고객 ${ana.counts.unique_contacts}명`);
      lines.push("서비스별: " + (ana.byService as any[]).map((r) => `${r.service} ${r.n}`).join(", "));
      lines.push(`미분류 ${ana.unknownShares.unclassified}건 · 유입경로 미확인 ${ana.unknownShares.sourceUnknown}건 (분모 ${ana.unknownShares.denominator})`);
      target = Math.max(target, Number(ana.counts.valid));
      if (ana.unknownShares.sourceUnknown) nextActions.push({ title: "상담 시 '어떻게 알고 오셨는지' 질문을 정례화해 유입경로 근거 확보", due: null });
    } else {
      lines.push("■ 분석실 조회 권한이 없어 문의 분포를 보여드릴 수 없습니다.");
    }
    lines.push("콘텐츠 주제 제안·문구 초안은 모델 API 연동 후 제공됩니다.", "");
  }
  if (roleKey === "meeting" && can(scope, "view_analytics") && ana && ana.unknownShares.unclassified) {
    nextActions.push({ title: `미분류 문의 ${ana.unknownShares.unclassified}건 서비스 유형 지정`, due: null });
  }
  const meta = await baseMeta(scope);
  await finishRun(runId, { status: "done", scope: { periods, target_count: target } });
  return { content: lines.join("\n").trim(), customerDraft: null, nextActions: nextActions.slice(0, 3), evidence, meta: { ...meta, periods, target_count: target, engine: "rules" }, runId };
}
