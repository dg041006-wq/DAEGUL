// 상담 자동 분석: 서비스 분류, 정보 추출(원문 메시지 ID 연결), 증분 요약, 누락 질문 후보.
// AI가 영업 단계/계약 확정을 바꾸지 않는다(후보만 제안). 사람이 입력한 값은 덮어쓰지 않는다.
import { q, q1 } from "../db/pool.js";
import { SERVICE_TYPES } from "../../shared/domain.js";
import { addEvidence, checkAvailability, createMessage, finishRun, startRun, SYSTEM_DATA_RULE, textOf } from "./client.js";
import { maskPII } from "./mask.js";

export const ANALYSIS_PROMPT_VERSION = "conv-analysis-v1";

const FIELDS = ["space_type", "region", "size_text", "room_count", "desired_work", "desired_schedule", "stated_budget", "quote_requested", "source_channel"] as const;

const fieldSchema = (t: "string" | "integer" | "boolean") => ({
  type: "object",
  properties: { value: { type: ["null", t] }, message_id: { type: ["null", "string"] } },
  required: ["value", "message_id"],
  additionalProperties: false,
});

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    services: { type: "array", items: { type: "string", enum: [...SERVICE_TYPES] } },
    category: { type: "string", enum: ["valid", "test", "spam", "existing_cs"] },
    fields: {
      type: "object",
      properties: {
        space_type: fieldSchema("string"),
        region: fieldSchema("string"),
        size_text: fieldSchema("string"),
        room_count: fieldSchema("integer"),
        desired_work: fieldSchema("string"),
        desired_schedule: fieldSchema("string"),
        stated_budget: fieldSchema("string"),
        quote_requested: fieldSchema("boolean"),
        source_channel: fieldSchema("string"),
      },
      required: [...FIELDS],
      additionalProperties: false,
    },
    missing_questions: { type: "array", items: { type: "string" } },
    stage_suggestion: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["none", "requirements", "quoted", "negotiating", "won", "on_hold", "lost", "waiting_contact"] },
        reason: { type: "string" },
        message_ids: { type: "array", items: { type: "string" } },
      },
      required: ["stage", "reason", "message_ids"],
      additionalProperties: false,
    },
    suspicious_instruction: { type: "boolean" },
  },
  required: ["summary", "services", "category", "fields", "missing_questions", "stage_suggestion", "suspicious_instruction"],
  additionalProperties: false,
};

export async function analyzeConversation(payload: { orgId: string; conversationId: string }) {
  const conv = await q1<any>(
    `SELECT c.*, oc.opportunity_id FROM conversations c LEFT JOIN opportunity_conversations oc ON oc.conversation_id=c.id WHERE c.id=$1 AND c.org_id=$2`,
    [payload.conversationId, payload.orgId],
  );
  if (!conv) return;
  const avail = await checkAvailability(payload.orgId);
  if (!avail.ok) {
    // 분석 대기 표시. 수신·기본 업무에는 영향 없음.
    await q(`UPDATE conversations SET ai_status=$2 WHERE id=$1`, [conv.id, avail.reason === "budget" ? "waiting_budget" : "waiting_no_api"]);
    return;
  }
  await q(`UPDATE conversations SET ai_status='running' WHERE id=$1`, [conv.id]);

  // 증분: 이전 요약 + 그 이후 새 메시지만 전송
  const newMsgs = await q<any>(
    `SELECT id, sender_type, sent_at, body FROM messages WHERE conversation_id=$1 AND ($2::timestamptz IS NULL OR sent_at > $2) ORDER BY sent_at, id LIMIT 150`,
    [conv.id, conv.ai_summary_through],
  );
  if (!newMsgs.length) {
    await q(`UPDATE conversations SET ai_status='done' WHERE id=$1`, [conv.id]);
    return;
  }
  const opp = conv.opportunity_id ? await q1<any>(`SELECT * FROM opportunities WHERE id=$1`, [conv.opportunity_id]) : null;
  const runId = await startRun({
    orgId: payload.orgId,
    kind: "conversation_analysis",
    engine: "model",
    promptVersion: ANALYSIS_PROMPT_VERSION,
    scope: { conversation_id: conv.id, new_messages: newMsgs.length },
  });
  try {
    const system = `당신은 스테이신(공간 촬영·스타일링·부분 시공·브랜딩)의 상담 분석기입니다. 상담을 분류·요약하고 정보를 추출합니다.
- 서비스 유형은 복수 선택 가능: ${SERVICE_TYPES.join(", ")}. 판단 불가 시 '기타/확인 필요'.
- 추출 값은 고객이 실제로 말한 경우에만 채우고, 근거 메시지의 message_id를 함께 넣는다. 없으면 value와 message_id 모두 null.
- source_channel(유입경로)은 고객이 직접 밝혔거나 캠페인 식별정보가 있을 때만.
- stage_suggestion은 '후보'일 뿐이다. 대화만으로 계약 확정(won)을 단정하지 말고, 견적 후 침묵을 이탈(lost)로 제안하지 않는다. 변화가 없으면 stage는 "none".
- missing_questions: 견적에 필요한데 아직 확인되지 않은 정보에 대해 직원이 물어볼 질문 후보(최대 5개).
- summary: 이전 요약이 있으면 새 메시지를 반영해 갱신한 전체 요약(5문장 이내).
${SYSTEM_DATA_RULE}`;
    const user = `이전 요약: ${conv.ai_summary ?? "(없음)"}
현재 기회 정보: ${JSON.stringify(opp ? Object.fromEntries(FIELDS.map((f) => [f, opp[f]])) : {})}
<customer_data>
${newMsgs.map((m) => `[message_id=${m.id}] [${m.sender_type}] ${new Date(m.sent_at).toISOString()} ${maskPII(m.body)}`).join("\n")}
</customer_data>`;
    const res = await createMessage({ system, messages: [{ role: "user", content: user }], outputSchema: OUTPUT_SCHEMA, effort: "low", maxTokens: 8000 });
    if (res.stop_reason === "refusal") throw new Error("model refusal");
    const out = JSON.parse(textOf(res));
    const validIds = new Set(newMsgs.map((m) => m.id));
    const evidence: Array<{ messageId: string; note: string }> = [];

    if (opp) {
      const sets: string[] = [];
      const vals: unknown[] = [opp.id];
      const fe = { ...(opp.field_evidence ?? {}) };
      for (const f of FIELDS) {
        const v = out.fields?.[f];
        if (!v || v.value === null || v.value === undefined) continue;
        if (fe[f]?.by === "user") continue; // 사람이 입력한 값 보존
        if (!v.message_id || !validIds.has(v.message_id)) continue; // 근거 없는 추출은 버림
        vals.push(v.value);
        sets.push(`${f}=$${vals.length}`);
        fe[f] = { message_id: v.message_id, by: "ai", at: new Date().toISOString(), run_id: runId };
        evidence.push({ messageId: v.message_id, note: `${f} 추출` });
      }
      const services: string[] = (out.services ?? []).filter((s: string) => (SERVICE_TYPES as readonly string[]).includes(s));
      if (services.length && !(opp.field_evidence?.services?.by === "user")) {
        vals.push(services);
        sets.push(`services=$${vals.length}`);
        fe.services = { by: "ai", at: new Date().toISOString(), run_id: runId };
      }
      if (out.category && out.category !== opp.category && !(opp.field_evidence?.category?.by === "user")) {
        vals.push(out.category);
        sets.push(`category=$${vals.length}`);
        fe.category = { by: "ai", at: new Date().toISOString(), run_id: runId };
      }
      vals.push(JSON.stringify(fe));
      sets.push(`field_evidence=$${vals.length}`);
      await q(`UPDATE opportunities SET ${sets.join(", ")}, updated_at=now() WHERE id=$1`, vals);

      // 단계 변경은 직접 적용하지 않고 승인 대기 제안으로 저장
      const sug = out.stage_suggestion;
      if (sug?.stage && sug.stage !== "none" && sug.stage !== opp.stage) {
        await q(
          `INSERT INTO approvals(org_id, kind, opportunity_id, conversation_id, payload, requested_by_type, analysis_run_id)
           VALUES ($1,'stage_change',$2,$3,$4,'ai',$5)`,
          [payload.orgId, opp.id, conv.id, { from: opp.stage, to: sug.stage, reason: sug.reason, message_ids: (sug.message_ids ?? []).filter((id: string) => validIds.has(id)) }, runId],
        );
      }
    }
    await addEvidence(runId, evidence.map((e) => ({ ...e, conversationId: conv.id })));
    await q(
      `UPDATE conversations SET ai_status='done', ai_summary=$2, ai_summary_through=$3, ai_missing_questions=$4, ai_analyzed_at=now(), ai_run_id=$5 WHERE id=$1`,
      [conv.id, String(out.summary ?? "").slice(0, 2000), newMsgs[newMsgs.length - 1].sent_at, JSON.stringify((out.missing_questions ?? []).slice(0, 5)), runId],
    );
    await finishRun(runId, { status: "done", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
  } catch (e: any) {
    await finishRun(runId, { status: "failed", error: String(e?.message ?? e).slice(0, 300) });
    await q(`UPDATE conversations SET ai_status='failed' WHERE id=$1`, [conv.id]);
    throw e;
  }
}

/** 답장 초안 — 승인된 최신 지식만 근거. 초안은 approvals(reply_draft)로 저장되며 자동 발송하지 않는다. */
export async function draftReply(orgId: string, conversationId: string, requestedBy: string) {
  const avail = await checkAvailability(orgId);
  if (!avail.ok) return { ok: false as const, message: avail.message };
  const knowledge = await q<any>(
    `SELECT DISTINCT ON (kind) id, kind, version, title, content FROM knowledge_versions WHERE org_id=$1 AND status='approved' ORDER BY kind, version DESC`,
    [orgId],
  );
  const msgs = await q<any>(`SELECT id, sender_type, sent_at, body FROM messages WHERE conversation_id=$1 ORDER BY sent_at DESC, id DESC LIMIT 40`, [conversationId]);
  msgs.reverse();
  const conv = await q1<any>(`SELECT ai_summary FROM conversations WHERE id=$1`, [conversationId]);
  const runId = await startRun({ orgId, kind: "reply_draft", roleKey: "cs", engine: "model", promptVersion: "reply-draft-v1", knowledgeVersionIds: knowledge.map((k) => k.id), requestedBy, scope: { conversation_id: conversationId } });
  try {
    const system = `당신은 스테이신 CS 팀장(AI)입니다. 고객에게 보낼 답장 '초안'을 작성합니다. 직원이 검토 후 공급사 상담 화면에서 직접 발송합니다.
- 아래 <approved_knowledge>의 승인 문서만 근거로 한다. 승인 문서에 없는 금액·할인·일정·환불·계약 조건은 쓰지 말고 "담당자가 확인 후 안내드리겠습니다" 식으로 처리한다.
- 과거 대화에 나온 할인율이나 오래된 가격을 현재 정책으로 쓰지 않는다.
- 말투는 승인된 말투 가이드를 따르고, 없으면 정중하고 간결한 존댓말.
- 출력은 초안 본문만.
${SYSTEM_DATA_RULE}`;
    const user = `<approved_knowledge>
${knowledge.length ? knowledge.map((k) => `## ${k.title} (v${k.version})\n${k.content}`).join("\n\n") : "(승인된 문서 없음)"}
</approved_knowledge>
상담 요약: ${conv?.ai_summary ?? "(없음)"}
<customer_data>
${msgs.map((m) => `[${m.sender_type}] ${maskPII(m.body)}`).join("\n")}
</customer_data>
위 상담의 마지막 고객 메시지에 대한 답장 초안을 작성하세요.`;
    const res = await createMessage({ system, messages: [{ role: "user", content: user }], effort: "low", maxTokens: 4000 });
    if (res.stop_reason === "refusal") throw new Error("model refusal");
    const draft = textOf(res);
    const a = await q1<{ id: string }>(
      `INSERT INTO approvals(org_id, kind, conversation_id, payload, requested_by_type, requested_by, analysis_run_id)
       VALUES ($1,'reply_draft',$2,$3,'ai',$4,$5) RETURNING id`,
      [orgId, conversationId, { body: draft, knowledge_versions: knowledge.map((k) => ({ id: k.id, kind: k.kind, version: k.version })) }, requestedBy, runId],
    );
    await finishRun(runId, { status: "done", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
    return { ok: true as const, approvalId: a!.id, body: draft, knowledgeCount: knowledge.length };
  } catch (e: any) {
    await finishRun(runId, { status: "failed", error: String(e?.message ?? e).slice(0, 300) });
    return { ok: false as const, message: "초안 생성 중 오류가 발생했습니다." };
  }
}
