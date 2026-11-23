// Studio 계정·세션·권한. 모든 조회·저장·파일·렌더·공유 API는 여기 함수로 서버에서 소유권을 검증한다.
import type { FastifyReply, FastifyRequest } from "fastify";
import { q, q1, type Db, pool } from "../db/pool.js";
import { randomToken, sha256 } from "../auth/password.js";
import { config } from "../config.js";

export const STUDIO_COOKIE = "sst_session";
const SESSION_DAYS = 30;

export interface StudioScope {
  userId: string;
  workspaceId: string;
  role: "owner" | "editor";
  isOps: boolean;
  workspaceKind: "vendor" | "internal";
}

declare module "fastify" {
  interface FastifyRequest {
    studio?: StudioScope | null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, msg: string, public code?: string) {
    super(msg);
  }
}
export const notFound = (m = "찾을 수 없습니다.") => new HttpError(404, m);
export const forbidden = (m = "권한이 없습니다.") => new HttpError(403, m);

export async function createStudioSession(userId: string, workspaceId: string) {
  const token = randomToken(32);
  await q(`INSERT INTO studio_sessions(id, user_id, workspace_id, expires_at) VALUES ($1,$2,$3, now() + interval '${SESSION_DAYS} days')`, [sha256(token), userId, workspaceId]);
  return token;
}

export async function resolveStudioSession(token: string | undefined): Promise<StudioScope | null> {
  if (!token) return null;
  const r = await q1<any>(
    `SELECT s.user_id, s.workspace_id, m.role, u.is_ops, w.kind
       FROM studio_sessions s
       JOIN studio_users u ON u.id=s.user_id AND u.disabled_at IS NULL
       JOIN studio_members m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id
       JOIN studio_workspaces w ON w.id=s.workspace_id
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!r) return null;
  return { userId: r.user_id, workspaceId: r.workspace_id, role: r.role, isOps: r.is_ops, workspaceKind: r.kind };
}

export function studioScope(req: FastifyRequest): StudioScope {
  if (!req.studio) throw new HttpError(401, "로그인이 필요합니다.");
  return req.studio;
}

export function requireOps(s: StudioScope) {
  if (!s.isOps) throw forbidden("스테이신 운영 권한이 필요합니다.");
}

export const studioCookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "lax" as const, secure: config.isProd, maxAge: SESSION_DAYS * 24 * 3600 });

// ───────── 소유권 조회 (모두 workspace_id 조건 포함) ─────────
export async function getProject(s: StudioScope, id: string, db: Db = pool) {
  const p = await q1<any>(`SELECT * FROM studio_projects WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [id, s.workspaceId], db);
  if (!p) throw notFound("프로젝트를 찾을 수 없습니다.");
  return p;
}
export async function getRoom(s: StudioScope, id: string, db: Db = pool) {
  const r = await q1<any>(`SELECT * FROM studio_rooms WHERE id=$1 AND workspace_id=$2`, [id, s.workspaceId], db);
  if (!r) throw notFound("방을 찾을 수 없습니다.");
  return r;
}
export async function getPhoto(s: StudioScope, id: string, db: Db = pool) {
  const r = await q1<any>(`SELECT * FROM studio_photos WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [id, s.workspaceId], db);
  if (!r) throw notFound("사진을 찾을 수 없습니다.");
  return r;
}
export async function getVariant(s: StudioScope, id: string, db: Db = pool) {
  const r = await q1<any>(`SELECT * FROM studio_variants WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL`, [id, s.workspaceId], db);
  if (!r) throw notFound("안을 찾을 수 없습니다.");
  return r;
}
export async function getVariantVersion(s: StudioScope, id: string, db: Db = pool) {
  const r = await q1<any>(`SELECT * FROM studio_variant_versions WHERE id=$1 AND workspace_id=$2`, [id, s.workspaceId], db);
  if (!r) throw notFound("안 버전을 찾을 수 없습니다.");
  return r;
}
/** 에셋: 자기 작업공간 또는 공용 카탈로그(workspace_id NULL) */
export async function getAsset(s: StudioScope, id: string, db: Db = pool) {
  const r = await q1<any>(`SELECT * FROM studio_assets WHERE id=$1 AND (workspace_id=$2 OR workspace_id IS NULL)`, [id, s.workspaceId], db);
  if (!r) throw notFound("가구를 찾을 수 없습니다.");
  return r;
}
export async function getAssetVersion(s: StudioScope, id: string, db: Db = pool) {
  const r = await q1<any>(
    `SELECT v.*, a.workspace_id AS asset_workspace_id, a.kind AS asset_kind, a.name AS asset_name FROM studio_asset_versions v JOIN studio_assets a ON a.id=v.asset_id
     WHERE v.id=$1 AND (a.workspace_id=$2 OR a.workspace_id IS NULL)`,
    [id, s.workspaceId],
    db,
  );
  if (!r) throw notFound("가구 버전을 찾을 수 없습니다.");
  return r;
}

/** 파일 접근: 파일이 이 작업공간 소유이거나 공용 카탈로그 파일일 때만 */
export async function getOwnedFile(s: StudioScope, fileId: string) {
  const f = await q1<any>(`SELECT * FROM studio_files WHERE id=$1 AND deleted_at IS NULL AND (workspace_id=$2 OR workspace_id IS NULL)`, [fileId, s.workspaceId]);
  if (!f) throw notFound("파일을 찾을 수 없습니다.");
  return f;
}

export async function logEvent(s: { workspaceId: string; userId?: string } | null, name: string, props: Record<string, unknown> = {}, projectId?: string | null) {
  await q(`INSERT INTO studio_events(workspace_id, project_id, user_id, name, props) VALUES ($1,$2,$3,$4,$5)`, [s?.workspaceId ?? null, projectId ?? null, s?.userId ?? null, name, props]);
}

export function sendError(reply: FastifyReply, e: HttpError) {
  return reply.code(e.status).send({ error: e.message, code: e.code });
}
