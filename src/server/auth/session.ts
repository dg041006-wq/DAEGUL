import { q, q1 } from "../db/pool.js";
import { randomToken, sha256 } from "./password.js";
import type { Scope } from "./scope.js";

const SESSION_DAYS = 30;
export const SESSION_COOKIE = "ss_session";

export async function createSession(userId: string, orgId: string, userAgent?: string) {
  const token = randomToken(32);
  await q(
    `INSERT INTO sessions(id, user_id, org_id, user_agent, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId, orgId, userAgent?.slice(0, 200) ?? null],
  );
  return token;
}

export async function loadScope(orgId: string, userId: string): Promise<Scope | null> {
  const m = await q1<{ role: "owner" | "staff"; perms: any }>(
    `SELECT m.role, m.perms FROM memberships m JOIN users u ON u.id=m.user_id
     WHERE m.org_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL`,
    [orgId, userId],
  );
  if (!m) return null;
  return { orgId, userId, role: m.role, perms: m.perms ?? {} };
}

export async function resolveSession(token: string | undefined) {
  if (!token) return null;
  const s = await q1<{ id: string; user_id: string; org_id: string }>(
    `UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND revoked_at IS NULL AND expires_at > now() RETURNING id, user_id, org_id`,
    [sha256(token)],
  );
  if (!s) return null;
  const scope = await loadScope(s.org_id, s.user_id);
  if (!scope) return null; // 계정 회수/비활성화 시 즉시 무효
  return { sessionId: s.id, scope };
}

export async function revokeSession(token: string) {
  await q(`UPDATE sessions SET revoked_at=now() WHERE id=$1`, [sha256(token)]);
}

export async function revokeAllSessions(userId: string, orgId?: string) {
  await q(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL ${orgId ? "AND org_id=$2" : ""}`, orgId ? [userId, orgId] : [userId]);
}
