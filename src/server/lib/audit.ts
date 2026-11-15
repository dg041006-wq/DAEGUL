import { q, type Db, pool } from "../db/pool.js";

export async function audit(
  e: {
    orgId: string | null;
    actorUserId?: string | null;
    actorType?: "user" | "ai" | "system";
    action: string;
    targetType?: string;
    targetId?: string;
    detail?: Record<string, unknown>;
    ip?: string;
  },
  db: Db = pool,
) {
  await q(
    `INSERT INTO audit_logs(org_id, actor_user_id, actor_type, action, target_type, target_id, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.orgId, e.actorUserId ?? null, e.actorType ?? "user", e.action, e.targetType ?? null, e.targetId ?? null, e.detail ?? {}, e.ip ?? null],
    db,
  );
}
