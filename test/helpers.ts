import type { FastifyInstance } from "fastify";
import { pool, q, q1 } from "../src/server/db/pool.js";
import { migrate } from "../src/server/db/migrate.js";
import { buildApp } from "../src/server/app.js";
import { hashPassword } from "../src/server/auth/password.js";
import { createOrganization } from "../src/server/lib/org.js";
import { signDemo } from "../src/server/integrations/demo.js";
import { runOnce } from "../src/server/jobs/queue.js";
import { handlers } from "../src/server/jobs/handlers.js";

export async function resetDb() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(false);
}

export interface Ctx {
  app: FastifyInstance;
  orgId: string;
  ownerId: string;
  staffId: string;
  ownerCookie: string;
  staffCookie: string;
}

export async function setup(): Promise<Ctx> {
  await resetDb();
  const orgId = await createOrganization("테스트 조직");
  const owner = await q1<{ id: string }>(`INSERT INTO users(email,name,password_hash) VALUES ('owner@t.local','대표',$1) RETURNING id`, [hashPassword("owner-password")]);
  const staff = await q1<{ id: string }>(`INSERT INTO users(email,name,password_hash) VALUES ('staff@t.local','직원',$1) RETURNING id`, [hashPassword("staff-password")]);
  await q(`INSERT INTO memberships(org_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'staff')`, [orgId, owner!.id, staff!.id]);
  const app = await buildApp();
  const ownerCookie = await login(app, "owner@t.local", "owner-password");
  const staffCookie = await login(app, "staff@t.local", "staff-password");
  return { app, orgId, ownerId: owner!.id, staffId: staff!.id, ownerCookie, staffCookie };
}

export async function login(app: FastifyInstance, email: string, password: string) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-requested-with": "stayscene", "content-type": "application/json" }, payload: { email, password } });
  if (r.statusCode !== 200) throw new Error(`login failed ${r.statusCode} ${r.body}`);
  const c = r.cookies.find((c) => c.name === "ss_session")!;
  return `ss_session=${c.value}`;
}

export function api(app: FastifyInstance, cookie: string) {
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { cookie, "x-requested-with": "stayscene", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, payload: payload as any });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p: unknown = {}) => call("POST", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
  };
}

let seq = 0;
export function demoEvent(o: {
  user: string;
  conv: string;
  sender?: "customer" | "staff" | "bot";
  text?: string;
  at: Date;
  eventId?: string;
  msgId?: string;
  type?: "message" | "conversation_status";
  status?: "open" | "closed";
}) {
  seq++;
  const payload: any = {
    event_id: o.eventId ?? `e-${seq}-${Math.random().toString(36).slice(2)}`,
    type: o.type ?? "message",
    occurred_at: o.at.toISOString(),
    user: { id: o.user, name: `고객 ${o.user}` },
    conversation: { id: o.conv, ...(o.status ? { status: o.status } : {}) },
  };
  if (payload.type === "message") payload.message = { id: o.msgId ?? `m-${seq}-${Math.random().toString(36).slice(2)}`, sender: o.sender ?? "customer", text: o.text ?? "문의드립니다" };
  return JSON.stringify(payload);
}

export async function postWebhook(app: FastifyInstance, orgId: string, raw: string, sig = signDemo(raw)) {
  const r = await app.inject({ method: "POST", url: `/api/webhooks/demo/${orgId}`, headers: { "content-type": "application/json", "x-demo-signature": sig }, payload: raw });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

/** 큐에 쌓인 작업을 모두 처리 (run_at 무시) */
export async function drainJobs() {
  for (let i = 0; i < 20; i++) {
    await q(`UPDATE jobs SET run_at=now() WHERE status='queued'`);
    const n = await runOnce(handlers, 50);
    if (!n) break;
  }
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
