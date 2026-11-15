// 사건 기록 → 담당 AI 직원이 대표 전용 대화방에 먼저 보고 → 알림함 → (중요도에 따라) 푸시.
// 같은 사건은 dedupe_key로 한 번만 보고한다. 사건 제목에는 상담 원문을 넣지 않는다.
import { q, q1, type Db, pool } from "../db/pool.js";
import { EVENT_KINDS } from "../../shared/domain.js";
import { getOrgSettings } from "./org.js";
import { sendPushToUser } from "./push.js";

export type Severity = "critical" | "important" | "info";
const RANK: Record<string, number> = { info: 1, important: 2, critical: 3, off: 99 };

export type FeedAction =
  | { label: string; type: "open"; link: string }
  | { label: string; type: "create_task"; title: string; conversation_id?: string | null; opportunity_id?: string | null; project_id?: string | null; contact_id?: string | null; due?: "today" | "tomorrow_am" | null }
  | { label: string; type: "snooze"; days: number }
  | { label: string; type: "resolve" }
  | { label: string; type: "draft_reply"; conversation_id: string }
  | { label: string; type: "assign_self"; conversation_id: string };

export async function ownerIds(orgId: string, db: Db = pool) {
  return (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE org_id=$1 AND role='owner' AND status='active'`, [orgId], db)).map((r) => r.user_id);
}

export async function ensureFeedThread(orgId: string, userId: string, roleKey: string) {
  const ex = await q1<{ id: string }>(`SELECT id FROM ai_threads WHERE org_id=$1 AND owner_user_id=$2 AND role_key=$3 AND kind='feed'`, [orgId, userId, roleKey]);
  if (ex) return ex.id;
  const r = await q1<{ id: string }>(
    `INSERT INTO ai_threads(org_id, role_key, owner_user_id, title, kind) VALUES ($1,$2,$3,'대표님 보고','feed')
     ON CONFLICT (org_id, owner_user_id, role_key) WHERE kind='feed' DO UPDATE SET updated_at=now() RETURNING id`,
    [orgId, roleKey, userId],
  );
  return r!.id;
}

/** 대표 전용 대화방(담당별 피드)에 AI 직원이 먼저 보고 */
export async function postFeed(
  orgId: string,
  roleKey: string,
  msg: { content: string; kind?: "alert" | "report" | "action_result"; actions?: FeedAction[]; eventId?: string | null; meta?: Record<string, unknown> },
  userIds?: string[],
) {
  const targets = userIds ?? (await ownerIds(orgId));
  const ids: string[] = [];
  for (const u of targets) {
    const t = await ensureFeedThread(orgId, u, roleKey);
    const r = await q1<{ id: string }>(
      `INSERT INTO ai_messages(thread_id, author, status, content, kind, actions, event_id, meta) VALUES ($1,'assistant','done',$2,$3,$4,$5,$6) RETURNING id`,
      [t, msg.content, msg.kind ?? "alert", JSON.stringify(msg.actions ?? []), msg.eventId ?? null, { engine: "rules", ...(msg.meta ?? {}) }],
    );
    await q(`UPDATE ai_threads SET updated_at=now() WHERE id=$1`, [t]);
    ids.push(r!.id);
  }
  return ids;
}

export async function notify(
  orgId: string,
  userId: string,
  n: { kind: string; title: string; link: string | null; severity?: Severity; dedupeKey?: string; eventId?: string | null },
) {
  const settings = await getOrgSettings(orgId);
  const sev = n.severity ?? "info";
  const wantPush = RANK[sev] >= RANK[settings.pushMinSeverity ?? "important"];
  const row = await q1<{ id: string }>(
    `INSERT INTO notifications(org_id, user_id, kind, title, link, dedupe_key, severity, push_status, event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [orgId, userId, n.kind, n.title, n.link, n.dedupeKey ?? null, sev, wantPush ? "pending" : "not_required", n.eventId ?? null],
  );
  if (!row || !wantPush) return row?.id ?? null;
  const r = await sendPushToUser(userId, { title: n.title, link: n.link, tag: n.dedupeKey ?? row.id });
  await q(`UPDATE notifications SET push_status=$2, push_error=$3 WHERE id=$1`, [row.id, r.status, r.error ?? null]);
  return row.id;
}

/**
 * 사건 기록. 처음 기록될 때만 true를 반환하며 보고·알림을 보낸다.
 * kind는 shared/domain EVENT_KINDS 참고. 중요도는 조직 설정(eventPush)으로 재정의 가능.
 */
export async function recordEvent(
  orgId: string,
  e: {
    kind: string;
    title: string;
    dedupeKey: string;
    entityType?: string;
    entityId?: string | null;
    link?: string | null;
    detail?: Record<string, unknown>;
    severity?: Severity;
    roleKey?: string;
    isTest?: boolean;
    feedText?: string; // 대표님 호칭 보고 문장
    actions?: FeedAction[];
    notifyFeed?: boolean;
  },
): Promise<string | null> {
  const def = EVENT_KINDS[e.kind];
  const settings = await getOrgSettings(orgId);
  const severity: Severity = (settings.eventPush?.[e.kind] as Severity) ?? e.severity ?? def?.severity ?? "info";
  const roleKey = e.roleKey ?? def?.role ?? "ops";
  const ev = await q1<{ id: string }>(
    `INSERT INTO events(org_id, kind, severity, role_key, title, entity_type, entity_id, link, detail, dedupe_key, is_test)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (org_id, dedupe_key) DO NOTHING RETURNING id`,
    [orgId, e.kind, severity, roleKey, e.title.slice(0, 200), e.entityType ?? null, e.entityId ?? null, e.link ?? null, e.detail ?? {}, e.dedupeKey, e.isTest ?? false],
  );
  if (!ev) return null;
  // 단순 상태 변화(info)는 활동 이력에만 남기고 대화방 보고는 생략 (설정으로 중요도 상향 가능)
  if (e.notifyFeed !== false && severity !== "info") {
    const prefix = e.isTest ? "[테스트] " : "";
    await postFeed(orgId, roleKey, {
      content: prefix + (e.feedText ?? `대표님, ${e.title}`),
      kind: "alert",
      eventId: ev.id,
      actions: e.actions ?? (e.link ? [{ label: "바로 보기", type: "open", link: e.link }] : []),
      meta: { event_kind: e.kind, severity, is_test: e.isTest ?? false },
    });
    for (const u of await ownerIds(orgId)) {
      await notify(orgId, u, { kind: e.kind, title: prefix + e.title, link: e.link ?? null, severity, dedupeKey: `ev:${ev.id}`, eventId: ev.id });
    }
    await q(`UPDATE events SET reported=true WHERE id=$1`, [ev.id]);
  }
  return ev.id;
}
