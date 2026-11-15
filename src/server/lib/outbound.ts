// 고객 발송 큐 — 대표 내부 보고·알림과 분리.
// 상태: pending_approval → (승인) → queued → sending → sent | failed | unknown
//       공급사 발송 미지원: blocked_no_provider (공급사 화면에서 직접 보낸 뒤 sent_manually로 기록)
// 원칙: idempotency_key로 중복 생성 방지. 'unknown'(응답 끊김 등)은 자동 재발송하지 않고 상태 확인 절차를 거친다.
import { q, q1 } from "../db/pool.js";
import { can, ForbiddenError, NotFoundError, type Scope } from "../auth/scope.js";
import { getAdapter } from "../integrations/registry.js";
import { enqueue } from "../jobs/queue.js";
import { audit } from "./audit.js";
import { getOrgSettings } from "./org.js";
import { toKstParts } from "./time.js";

/** 자동응답 템플릿 금지 표현: 가격·할인·확약 */
const FORBIDDEN = /(\d[\d,]*\s*(원|만원|만\s*원))|%|할인|무료|공짜|확정|보장|약속|환불\s*해/;
export function validateAutoTemplate(t: string) {
  if (FORBIDDEN.test(t)) return "자동응답에는 금액·할인·확정/보장 표현을 넣을 수 없습니다.";
  if (t.length > 500) return "500자 이하로 작성하세요.";
  return null;
}

export async function createOutbound(s: Scope | null, o: { orgId: string; conversationId: string; body: string; createdByType: "user" | "ai" | "auto_rule"; idempotencyKey: string; ruleId?: string | null }) {
  const conv = await q1<any>(
    `SELECT c.id, c.provider, c.contact_id, c.data_origin, c.assignee_user_id, ct.display_name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE c.id=$1 AND c.org_id=$2`,
    [o.conversationId, o.orgId],
  );
  if (!conv) throw new NotFoundError();
  const adapter = getAdapter(conv.provider);
  const channel = adapter?.send ? "provider" : "manual";
  const status = o.createdByType === "auto_rule" ? (adapter?.send ? "queued" : "blocked_no_provider") : "pending_approval";
  const row = await q1<any>(
    `INSERT INTO outbound_messages(org_id, conversation_id, contact_id, channel, provider, recipient_label, body, status, idempotency_key, created_by_type, created_by, rule_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING *`,
    [o.orgId, conv.id, conv.contact_id, channel, conv.provider, `${conv.display_name ?? "이름 미제공 고객"} (${conv.provider})`, o.body.slice(0, 4000), status, o.idempotencyKey, o.createdByType, s?.userId ?? null, o.ruleId ?? null],
  );
  if (!row) return q1<any>(`SELECT * FROM outbound_messages WHERE org_id=$1 AND idempotency_key=$2`, [o.orgId, o.idempotencyKey]);
  if (row.status === "queued") await enqueue("send_outbound", { id: row.id, orgId: o.orgId }, { dedupeKey: `send:${row.id}`, maxAttempts: 1 });
  return row;
}

async function load(s: Scope, id: string) {
  const m = await q1<any>(`SELECT o.*, c.assignee_user_id FROM outbound_messages o LEFT JOIN conversations c ON c.id=o.conversation_id WHERE o.id::text=$1 AND o.org_id=$2`, [id, s.orgId]);
  if (!m) throw new NotFoundError();
  if (!can(s, "view_all_conversations") && m.assignee_user_id !== s.userId) throw new NotFoundError();
  return m;
}

export async function decideOutbound(s: Scope, id: string, decision: "approve" | "cancel" | "sent_manually" | "retry" | "check_status") {
  const m = await load(s, id);
  if (decision !== "cancel" && !can(s, "send_messages")) throw new ForbiddenError("고객 발송 승인 권한이 없습니다.");
  const set = async (status: string, extra = "") =>
    q(`UPDATE outbound_messages SET status=$2, updated_at=now() ${extra} WHERE id=$1`, [m.id, status]);
  if (decision === "approve") {
    if (m.status !== "pending_approval") throw Object.assign(new Error("승인 대기 상태가 아닙니다."), { status: 409 });
    const adapter = getAdapter(m.provider);
    await q(`UPDATE outbound_messages SET approved_by=$2, approved_at=now() WHERE id=$1`, [m.id, s.userId]);
    if (adapter?.send) {
      await set("queued");
      await enqueue("send_outbound", { id: m.id, orgId: s.orgId }, { dedupeKey: `send:${m.id}`, maxAttempts: 1 });
    } else await set("blocked_no_provider");
  } else if (decision === "cancel") {
    if (!["pending_approval", "queued", "blocked_no_provider", "failed"].includes(m.status)) throw Object.assign(new Error("이미 전송 중이거나 전송된 메시지는 취소할 수 없습니다."), { status: 409 });
    await set("cancelled");
  } else if (decision === "sent_manually") {
    if (!["pending_approval", "blocked_no_provider", "failed", "unknown"].includes(m.status)) throw Object.assign(new Error("이 상태에서는 직접 발송 기록을 남길 수 없습니다."), { status: 409 });
    await set("sent_manually", ", sent_at=now()");
  } else if (decision === "retry") {
    // 명확한 실패(failed)만 재시도. unknown은 먼저 상태 확인.
    if (m.status !== "failed") throw Object.assign(new Error("명확히 실패한 메시지만 다시 보낼 수 있습니다. '확인 불가'는 상태 확인을 먼저 하세요."), { status: 409 });
    await set("queued");
    await enqueue("send_outbound", { id: m.id, orgId: s.orgId }, { dedupeKey: `send:${m.id}`, maxAttempts: 1 });
  } else if (decision === "check_status") {
    await checkOutboundStatus(m.id);
  }
  await audit({ orgId: s.orgId, actorUserId: s.userId, action: `outbound.${decision}`, targetType: "outbound", targetId: m.id });
  return q1(`SELECT * FROM outbound_messages WHERE id=$1`, [m.id]);
}

/** 워커: 실제 전송. 'sending'으로 원자적으로 잡은 경우에만 전송 시도 → 중복 전송 방지 */
export async function processOutbound(payload: { id: string }) {
  const m = await q1<any>(
    `UPDATE outbound_messages SET status='sending', attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='queued' RETURNING *`,
    [payload.id],
  );
  if (!m) return;
  const conv = await q1<any>(`SELECT external_conversation_id, data_origin FROM conversations WHERE id=$1`, [m.conversation_id]);
  const adapter = getAdapter(m.provider);
  if (!adapter?.send) {
    await q(`UPDATE outbound_messages SET status='blocked_no_provider', updated_at=now() WHERE id=$1`, [m.id]);
    return;
  }
  try {
    const r = await adapter.send({ conversationExternalId: conv.external_conversation_id, body: m.body, idempotencyKey: m.idempotency_key, isTest: conv.data_origin === "test" });
    await q(`UPDATE outbound_messages SET status=$2, provider_message_id=$3, last_error=$4, sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END, updated_at=now() WHERE id=$1`, [
      m.id,
      r.status,
      r.providerMessageId ?? null,
      r.error ?? null,
    ]);
  } catch (e: any) {
    // 응답이 끊겨 결과를 알 수 없음 → unknown. 자동 재전송하지 않는다.
    await q(`UPDATE outbound_messages SET status='unknown', last_error=$2, updated_at=now() WHERE id=$1`, [m.id, String(e?.message ?? e).slice(0, 300)]);
  }
}

export async function checkOutboundStatus(id: string) {
  const m = await q1<any>(`SELECT * FROM outbound_messages WHERE id=$1`, [id]);
  if (!m || m.status !== "unknown") return m;
  const adapter = getAdapter(m.provider);
  if (!adapter?.getSendStatus) {
    await q(`UPDATE outbound_messages SET last_error='공급사가 발송 상태 조회를 지원하지 않습니다. 공급사 화면에서 확인 후 직접 기록하세요.', updated_at=now() WHERE id=$1`, [id]);
    return m;
  }
  const r = await adapter.getSendStatus({ idempotencyKey: m.idempotency_key, providerMessageId: m.provider_message_id });
  await q(`UPDATE outbound_messages SET status=$2, provider_message_id=COALESCE($3, provider_message_id), updated_at=now() WHERE id=$1`, [id, r.status, r.providerMessageId ?? null]);
  return r;
}

/** 자동응답: 대표가 켠 규칙 + 영업시간 외 + 해당 상담의 첫 고객 메시지일 때만. 금지 표현 템플릿은 저장 단계에서 차단됨. */
export async function maybeAutoReply(orgId: string, conversationId: string, sentAt: Date) {
  const rule = await q1<any>(`SELECT * FROM auto_reply_rules WHERE org_id=$1 AND enabled AND trigger='outside_hours_first_message' ORDER BY created_at LIMIT 1`, [orgId]);
  if (!rule) return null;
  if (validateAutoTemplate(rule.template)) return null;
  const st = await getOrgSettings(orgId);
  const p = toKstParts(sentAt);
  const [sh, sm] = st.businessHours.start.split(":").map(Number);
  const [eh, em] = st.businessHours.end.split(":").map(Number);
  const inHours = st.businessHours.days.includes(p.dow) && p.minutes >= sh * 60 + sm && p.minutes < eh * 60 + em;
  if (inHours) return null;
  const cnt = await q1<{ n: number }>(`SELECT count(*) AS n FROM messages WHERE conversation_id=$1 AND sender_type='customer'`, [conversationId]);
  if ((cnt?.n ?? 0) !== 1) return null;
  return createOutbound(null, { orgId, conversationId, body: rule.template, createdByType: "auto_rule", idempotencyKey: `auto:${rule.id}:${conversationId}`, ruleId: rule.id });
}
