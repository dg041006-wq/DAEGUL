import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../db/pool.js";
import { hashPassword, sha256, verifyPassword } from "../auth/password.js";
import { createSession, revokeSession, SESSION_COOKIE } from "../auth/session.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { scopeOf } from "../auth/request.js";

const attempts = new Map<string, { n: number; until: number }>();
function rateLimited(key: string) {
  const a = attempts.get(key);
  return a && a.n >= 8 && a.until > Date.now();
}
function recordFail(key: string) {
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  a.n++;
  a.until = Date.now() + 15 * 60_000;
  attempts.set(key, a);
}

const cookieOpts = () => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.isProd,
  maxAge: 30 * 24 * 3600,
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const key = `${req.ip}:${body.email.toLowerCase()}`;
    if (rateLimited(key)) return reply.code(429).send({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요." });
    const u = await q1<{ id: string; password_hash: string; disabled_at: string | null }>(
      `SELECT id, password_hash, disabled_at FROM users WHERE lower(email)=lower($1)`,
      [body.email],
    );
    if (!u || u.disabled_at || !verifyPassword(body.password, u.password_hash)) {
      recordFail(key);
      return reply.code(401).send({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    }
    const m = await q1<{ org_id: string }>(`SELECT org_id FROM memberships WHERE user_id=$1 AND status='active' ORDER BY created_at LIMIT 1`, [u.id]);
    if (!m) return reply.code(403).send({ error: "활성화된 조직 멤버십이 없습니다." });
    attempts.delete(key);
    const token = await createSession(u.id, m.org_id, req.headers["user-agent"]);
    await audit({ orgId: m.org_id, actorUserId: u.id, action: "auth.login", ip: req.ip });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts());
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await revokeSession(t);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const s = scopeOf(req);
    const u = await q1(`SELECT id, email, name FROM users WHERE id=$1`, [s.userId]);
    const org = await q1(`SELECT id, name, timezone FROM organizations WHERE id=$1`, [s.orgId]);
    return { user: u, org, role: s.role, perms: s.perms };
  });

  app.get("/api/invitations/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const inv = await q1(
      `SELECT i.email, i.role, o.name AS org_name FROM invitations i JOIN organizations o ON o.id=i.org_id
       WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [sha256(token)],
    );
    if (!inv) return reply.code(404).send({ error: "유효하지 않거나 만료된 초대입니다." });
    return inv;
  });

  app.post("/api/invitations/accept", async (req, reply) => {
    const body = z.object({ token: z.string().min(10), name: z.string().min(1).max(50), password: z.string().min(10).max(200) }).parse(req.body);
    const result = await tx(async (c) => {
      const inv = await q1<any>(
        `SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(body.token)],
        c,
      );
      if (!inv) return null;
      let user = await q1<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1)`, [inv.email], c);
      if (!user) {
        user = await q1<{ id: string }>(`INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [inv.email, body.name, hashPassword(body.password)], c);
      }
      await q(
        `INSERT INTO memberships(org_id, user_id, role, perms) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role=EXCLUDED.role, perms=EXCLUDED.perms, status='active', revoked_at=NULL`,
        [inv.org_id, user!.id, inv.role, inv.perms],
        c,
      );
      await q(`UPDATE invitations SET accepted_at=now() WHERE id=$1`, [inv.id], c);
      await audit({ orgId: inv.org_id, actorUserId: user!.id, action: "invitation.accept", targetType: "invitation", targetId: inv.id }, c);
      return { userId: user!.id, orgId: inv.org_id };
    });
    if (!result) return reply.code(404).send({ error: "유효하지 않거나 만료된 초대입니다." });
    const token = await createSession(result.userId, result.orgId, req.headers["user-agent"]);
    reply.setCookie(SESSION_COOKIE, token, cookieOpts());
    return { ok: true };
  });
}
