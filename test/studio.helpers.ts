import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { q1 } from "../src/server/db/pool.js";
import { hashPassword } from "../src/server/auth/password.js";
import { resetCatalogFlag } from "../src/server/studio/sample.js";

export async function makeStudioUser(email: string, workspace: string, opts: { ops?: boolean; kind?: "vendor" | "internal" } = {}) {
  const ws = await q1<{ id: string }>(`INSERT INTO studio_workspaces(name, kind) VALUES ($1,$2) RETURNING id`, [workspace, opts.kind ?? "vendor"]);
  const u = await q1<{ id: string }>(`INSERT INTO studio_users(email,name,password_hash,is_ops) VALUES ($1,$2,$3,$4) RETURNING id`, [email, email.split("@")[0], hashPassword("studio-password"), !!opts.ops]);
  await q1(`INSERT INTO studio_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [ws!.id, u!.id]);
  return { workspaceId: ws!.id, userId: u!.id };
}

export function resetStudioStorage() {
  fs.rmSync("test-output/storage", { recursive: true, force: true });
  resetCatalogFlag();
}

export async function studioLogin(app: FastifyInstance, email: string) {
  const r = await app.inject({ method: "POST", url: "/api/studio/auth/login", headers: { "x-requested-with": "stayscene", "content-type": "application/json" }, payload: { email, password: "studio-password" } });
  if (r.statusCode !== 200) throw new Error(`studio login failed ${r.statusCode} ${r.body}`);
  return `sst_session=${r.cookies.find((c) => c.name === "sst_session")!.value}`;
}

export function sapi(app: FastifyInstance, cookie: string | null) {
  const call = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, contentType?: string) => {
    const headers: Record<string, string> = { "x-requested-with": "stayscene" };
    if (cookie) headers.cookie = cookie;
    if (payload !== undefined) headers["content-type"] = contentType ?? "application/json";
    const r = await app.inject({ method, url, headers, payload: payload as any });
    let body: any = null;
    const ct = String(r.headers["content-type"] ?? "");
    if (ct.includes("json")) body = r.body ? JSON.parse(r.body) : null;
    return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, p: unknown = {}) => call("POST", u, p),
    put: (u: string, p: unknown) => call("PUT", u, p),
    patch: (u: string, p: unknown) => call("PATCH", u, p),
    del: (u: string) => call("DELETE", u),
    upload: (u: string, data: Buffer, type = "image/jpeg") => call("POST", u, data, type),
  };
}
