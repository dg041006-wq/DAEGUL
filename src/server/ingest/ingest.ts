// 원본 이벤트 수신함 → 정규화 → 대화 저장소 반영.
// 원칙: 검증된 원본을 먼저 안전하게 저장하고(빠른 200 응답), 정규화/분석은 비동기로 처리한다.
// AI 장애나 한도 도달은 수신을 막지 않는다.
import type pg from "pg";
import { pool, q, q1, tx } from "../db/pool.js";
import { getAdapter, SAMPLE_PROVIDERS } from "../integrations/registry.js";
import type { NormalizedEvent, NormalizedMessageEvent, VerifyInput } from "../integrations/types.js";
import { enqueue } from "../jobs/queue.js";

export type ReceiveResult =
  | { status: "accepted"; eventId: string }
  | { status: "duplicate"; eventId: string }
  | { status: "rejected"; reason: string; httpStatus: number };

export async function receiveWebhook(orgId: string, provider: string, input: VerifyInput): Promise<ReceiveResult> {
  const adapter = getAdapter(provider);
  if (!adapter) return { status: "rejected", reason: "unknown provider", httpStatus: 404 };
  if (!adapter.implemented) return { status: "rejected", reason: "provider not implemented", httpStatus: 501 };
  if (!adapter.verify(input)) return { status: "rejected", reason: "signature verification failed", httpStatus: 401 };

  let payload: unknown;
  let eventId: string;
  try {
    payload = JSON.parse(input.rawBody);
    eventId = adapter.eventId(payload);
  } catch {
    return { status: "rejected", reason: "invalid payload", httpStatus: 400 };
  }

  const org = await q1("SELECT id FROM organizations WHERE id=$1", [orgId]);
  if (!org) return { status: "rejected", reason: "unknown org", httpStatus: 404 };

  const inserted = await q1<{ id: string }>(
    `INSERT INTO webhook_events(org_id, provider, external_event_id, payload)
     VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, provider, external_event_id) DO NOTHING RETURNING id`,
    [orgId, provider, eventId, payload],
  );
  if (!inserted) return { status: "duplicate", eventId };
  await enqueue("process_webhook_event", { id: inserted.id }, { dedupeKey: `wh:${inserted.id}` });
  return { status: "accepted", eventId };
}

export async function processWebhookEvent(id: string) {
  const ev = await q1<{ id: string; org_id: string; provider: string; payload: unknown; status: string }>(
    "SELECT id, org_id, provider, payload, status FROM webhook_events WHERE id=$1",
    [id],
  );
  if (!ev || ev.status === "processed") return;
  const adapter = getAdapter(ev.provider);
  try {
    if (!adapter) throw new Error("adapter missing");
    const events = adapter.normalize(ev.payload);
    for (const ne of events) await applyEvent(ev.org_id, ev.provider, ne);
    await q(
      `UPDATE webhook_events SET status=$2, processed_at=now(), attempts=attempts+1, error=NULL WHERE id=$1`,
      [id, events.length ? "processed" : "ignored"],
    );
    await q(
      `UPDATE integrations SET last_event_at=now(), last_sync_at=now(), last_error=NULL, updated_at=now()
       WHERE org_id=$1 AND provider=$2`,
      [ev.org_id, ev.provider],
    );
  } catch (e: any) {
    await q(`UPDATE webhook_events SET status='failed', attempts=attempts+1, error=$2 WHERE id=$1`, [id, String(e?.message ?? e).slice(0, 500)]);
    await q(
      `UPDATE integrations SET last_error=$3, last_error_at=now(), updated_at=now() WHERE org_id=$1 AND provider=$2`,
      [ev.org_id, ev.provider, "이벤트 처리 실패 — 재처리 대기열 확인 필요"],
    );
    throw e; // 큐가 재시도
  }
}

export interface ApplyResult {
  conversationId: string;
  messageId: string | null;
  duplicate: boolean;
  opportunityId: string | null;
  opportunityCreated: boolean;
}

export async function applyEvent(orgId: string, provider: string, ev: NormalizedEvent, opts: { importId?: string } = {}): Promise<ApplyResult> {
  const isSample = SAMPLE_PROVIDERS.has(provider);
  const result = await tx(async (c) => {
    const contact = await q1<{ id: string }>(
      `INSERT INTO contacts(org_id, provider, external_user_id, display_name, is_sample, import_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, provider, external_user_id)
       DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name)
       RETURNING id`,
      [orgId, provider, ev.contact.externalUserId, ev.contact.displayName ?? null, isSample, opts.importId ?? null],
      c,
    );
    const at = ev.kind === "message" ? ev.message.sentAt : ev.conversation.at;
    const conv = await q1<{ id: string }>(
      `INSERT INTO conversations(org_id, provider, external_conversation_id, contact_id, channel, opened_at, is_sample, import_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, provider, external_conversation_id)
       DO UPDATE SET opened_at = LEAST(conversations.opened_at, EXCLUDED.opened_at),
                     channel = COALESCE(conversations.channel, EXCLUDED.channel)
       RETURNING id`,
      [orgId, provider, ev.conversation.externalConversationId, contact!.id, ev.conversation.channel ?? null, at, isSample, opts.importId ?? null],
      c,
    );
    const conversationId = conv!.id;

    if (ev.kind === "conversation_status") {
      // 순서 역전 대비: 마지막 메시지보다 오래된 종료 이벤트는 상태를 덮어쓰지 않는다.
      if (ev.conversation.status === "closed") {
        await q(
          `UPDATE conversations SET status='closed', closed_at=$2
           WHERE id=$1 AND (last_message_at IS NULL OR last_message_at <= $2)`,
          [conversationId, ev.conversation.at],
          c,
        );
      } else {
        await q(`UPDATE conversations SET status='open', closed_at=NULL WHERE id=$1 AND (closed_at IS NULL OR closed_at <= $2)`, [conversationId, ev.conversation.at], c);
      }
      const link = await q1<{ opportunity_id: string }>("SELECT opportunity_id FROM opportunity_conversations WHERE conversation_id=$1", [conversationId], c);
      return { conversationId, messageId: null, duplicate: false, opportunityId: link?.opportunity_id ?? null, opportunityCreated: false };
    }

    return applyMessage(c, orgId, provider, isSample, contact!.id, conversationId, ev);
  });

  if (ev.kind === "message" && !result.duplicate && (ev.message.senderType === "customer" || ev.message.senderType === "staff")) {
    // 증분 분석 — 짧은 디바운스 후 1회 실행
    await enqueue(
      "analyze_conversation",
      { orgId, conversationId: result.conversationId },
      { dedupeKey: `analyze:${result.conversationId}`, runAt: new Date(Date.now() + 20_000) },
    );
    await q(`UPDATE conversations SET ai_status='queued' WHERE id=$1 AND ai_status NOT IN ('running')`, [result.conversationId]);
  }
  return result;
}

async function applyMessage(
  c: pg.PoolClient,
  orgId: string,
  provider: string,
  isSample: boolean,
  contactId: string,
  conversationId: string,
  ev: NormalizedMessageEvent,
): Promise<ApplyResult> {
  const m = ev.message;
  const msg = await q1<{ id: string }>(
    `INSERT INTO messages(org_id, conversation_id, provider, external_message_id, sender_type, sender_external_id, sender_name, body, attachments, sent_at, is_sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (org_id, provider, external_message_id) DO NOTHING RETURNING id`,
    [orgId, conversationId, provider, m.externalMessageId, m.senderType, m.senderExternalId ?? null, m.senderName ?? null, m.body, JSON.stringify(m.attachments ?? []), m.sentAt, isSample],
    c,
  );
  if (!msg) {
    const link = await q1<{ opportunity_id: string }>("SELECT opportunity_id FROM opportunity_conversations WHERE conversation_id=$1", [conversationId], c);
    return { conversationId, messageId: null, duplicate: true, opportunityId: link?.opportunity_id ?? null, opportunityCreated: false };
  }

  // 순서 역전에 안전한 GREATEST 갱신
  await q(
    `UPDATE conversations SET
       last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
       last_customer_message_at = CASE WHEN $3 = 'customer' THEN GREATEST(COALESCE(last_customer_message_at, $2), $2) ELSE last_customer_message_at END,
       last_staff_message_at = CASE WHEN $3 = 'staff' THEN GREATEST(COALESCE(last_staff_message_at, $2), $2) ELSE last_staff_message_at END,
       status = CASE WHEN $3 = 'customer' AND status = 'closed' AND (closed_at IS NULL OR closed_at < $2) THEN 'open' ELSE status END,
       closed_at = CASE WHEN $3 = 'customer' AND status = 'closed' AND (closed_at IS NULL OR closed_at < $2) THEN NULL ELSE closed_at END
     WHERE id=$1`,
    [conversationId, m.sentAt, m.senderType],
    c,
  );

  // 영업 기회 연결: 상담 종료/재개나 새 상담방만으로 신규 문의가 늘지 않도록
  let opportunityId: string | null = null;
  let created = false;
  const link = await q1<{ opportunity_id: string }>("SELECT opportunity_id FROM opportunity_conversations WHERE conversation_id=$1", [conversationId], c);
  if (link) {
    opportunityId = link.opportunity_id;
  } else {
    const active = await q1<{ id: string }>(
      `SELECT id FROM opportunities WHERE org_id=$1 AND contact_id=$2 AND merged_into_id IS NULL
         AND stage NOT IN ('won','lost') ORDER BY COALESCE(last_contact_at, opened_at) DESC LIMIT 1`,
      [orgId, contactId],
      c,
    );
    if (active) {
      opportunityId = active.id;
      await q(
        `INSERT INTO opportunity_conversations(opportunity_id, conversation_id, link_reason) VALUES ($1,$2,'auto_same_contact_active')`,
        [active.id, conversationId],
        c,
      );
    } else {
      const prior = await q1<{ id: string }>(
        `SELECT id FROM opportunities WHERE org_id=$1 AND contact_id=$2 AND merged_into_id IS NULL ORDER BY opened_at DESC LIMIT 1`,
        [orgId, contactId],
        c,
      );
      const opp = await q1<{ id: string }>(
        `INSERT INTO opportunities(org_id, contact_id, opened_at, last_contact_at, is_sample, duplicate_of_candidate, services)
         VALUES ($1,$2,$3,$3,$4,$5,'{}') RETURNING id`,
        [orgId, contactId, m.sentAt, isSample, prior?.id ?? null],
        c,
      );
      opportunityId = opp!.id;
      created = true;
      await q(`INSERT INTO opportunity_conversations(opportunity_id, conversation_id, link_reason) VALUES ($1,$2,'created')`, [opp!.id, conversationId], c);
      await q(
        `INSERT INTO stage_events(org_id, opportunity_id, from_stage, to_stage, actor_type, reason, occurred_at)
         VALUES ($1,$2,NULL,'new','system','상담 수신으로 생성',$3)`,
        [orgId, opp!.id, m.sentAt],
        c,
      );
    }
  }
  if (opportunityId) {
    await q(
      `UPDATE opportunities SET
         opened_at = CASE WHEN $3 = 'customer' THEN LEAST(opened_at, $2) ELSE opened_at END,
         last_contact_at = GREATEST(COALESCE(last_contact_at, $2), $2),
         updated_at = now()
       WHERE id=$1`,
      [opportunityId, m.sentAt, m.senderType],
      c,
    );
  }
  return { conversationId, messageId: msg.id, duplicate: false, opportunityId, opportunityCreated: created };
}

/** 실패한 원본 이벤트 재처리 (관리자) */
export async function requeueFailedEvents(orgId: string) {
  const rows = await q<{ id: string }>(`SELECT id FROM webhook_events WHERE org_id=$1 AND status='failed'`, [orgId]);
  for (const r of rows) {
    await q(`UPDATE webhook_events SET status='pending' WHERE id=$1`, [r.id]);
    await enqueue("process_webhook_event", { id: r.id }, { dedupeKey: `wh:${r.id}` });
  }
  return rows.length;
}

export { pool };
