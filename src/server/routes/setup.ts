// 최초 대표 계정 설정 — 공개 회원가입이 아니다.
// 조건: (1) 서버에 SETUP_TOKEN 환경변수가 있고 (2) 아직 활성 멤버십이 하나도 없을 때만 동작.
// 대표 계정이 만들어지면 즉시 닫힌다. 토큰은 배포 플랫폼 비밀 변수에서만 확인할 수 있다.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { createOrganization } from "../lib/org.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";

async function setupOpen() {
  if (!process.env.SETUP_TOKEN) return false;
  const r = await q1<{ n: number }>(`SELECT count(*) AS n FROM memberships WHERE status='active'`);
  return (r?.n ?? 0) === 0;
}

let failures = 0;

export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => ({ open: await setupOpen() }));

  app.post("/api/setup/owner", async (req, reply) => {
    if (!(await setupOpen())) return reply.code(404).send({ error: "최초 설정이 이미 완료되었거나 비활성화되어 있습니다." });
    if (failures >= 10) return reply.code(429).send({ error: "시도 횟수 초과 — 서버를 재시작해야 다시 시도할 수 있습니다." });
    const b = z
      .object({ token: z.string().min(8), email: z.string().email(), name: z.string().min(1).max(50), password: z.string().min(10).max(200), org_name: z.string().min(1).max(50).default("스테이신") })
      .parse(req.body);
    const expected = Buffer.from(process.env.SETUP_TOKEN!);
    const got = Buffer.from(b.token);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
      failures++;
      return reply.code(401).send({ error: "설정 토큰이 올바르지 않습니다." });
    }
    const r = await tx(async (c) => {
      const again = await q1<{ n: number }>(`SELECT count(*) AS n FROM memberships WHERE status='active'`, [], c);
      if ((again?.n ?? 0) > 0) return null;
      const org = await q1<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`, [], c);
      const orgId = org?.id ?? (await createOrganization(b.org_name, c));
      const u = await q1<{ id: string }>(
        `INSERT INTO users(email, name, password_hash) VALUES (lower($1),$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, name=EXCLUDED.name RETURNING id`,
        [b.email, b.name, hashPassword(b.password)],
        c,
      );
      await q(`INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT (org_id, user_id) DO UPDATE SET role='owner', status='active'`, [orgId, u!.id], c);
      await audit({ orgId, actorUserId: u!.id, action: "setup.owner_created", ip: req.ip }, c);
      return { orgId, userId: u!.id };
    });
    if (!r) return reply.code(409).send({ error: "이미 대표 계정이 있습니다." });
    const token = await createSession(r.userId, r.orgId, req.headers["user-agent"]);
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: config.isProd, maxAge: 30 * 24 * 3600 });
    return { ok: true };
  });
}
