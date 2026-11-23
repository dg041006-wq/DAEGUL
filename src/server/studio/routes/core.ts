// 로그인·프로젝트·방·사진·파일
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../../db/pool.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../../auth/password.js";
import { STUDIO_COOKIE, createStudioSession, getOwnedFile, getPhoto, getProject, getRoom, HttpError, logEvent, requireOps, studioCookieOpts, studioScope } from "../auth.js";
import { normalizePhoto } from "../images.js";
import { putFile, readFile } from "../storage.js";
import { recalibratePhoto, recalibrateRoom } from "../calibration.js";
import { studioConfig } from "../config.js";
import { findChromium } from "../renderer.js";
import { openSampleProject } from "../sample.js";

const attempts = new Map<string, { n: number; until: number }>();

export async function studioCoreRoutes(app: FastifyInstance) {
  // ───────── 인증 ─────────
  app.post("/api/studio/auth/login", async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const key = `${req.ip}:${b.email.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.n >= 8 && a.until > Date.now()) return reply.code(429).send({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요." });
    const u = await q1<any>(`SELECT * FROM studio_users WHERE lower(email)=lower($1)`, [b.email]);
    if (!u || u.disabled_at || !verifyPassword(b.password, u.password_hash)) {
      attempts.set(key, { n: (a?.n ?? 0) + 1, until: Date.now() + 15 * 60_000 });
      return reply.code(401).send({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    }
    attempts.delete(key);
    const m = await q1<any>(`SELECT workspace_id FROM studio_members WHERE user_id=$1 ORDER BY created_at LIMIT 1`, [u.id]);
    if (!m) return reply.code(403).send({ error: "소속된 작업공간이 없습니다." });
    reply.setCookie(STUDIO_COOKIE, await createStudioSession(u.id, m.workspace_id), studioCookieOpts());
    return { ok: true };
  });

  app.post("/api/studio/auth/logout", async (req, reply) => {
    const t = req.cookies[STUDIO_COOKIE];
    if (t) await q(`UPDATE studio_sessions SET revoked_at=now() WHERE id=$1`, [sha256(t)]);
    reply.clearCookie(STUDIO_COOKIE, { path: "/" });
    return { ok: true };
  });

  // 초대 코드로 업체 가입 → 새 작업공간
  app.get("/api/studio/invites/:token", async (req, reply) => {
    const inv = await q1<any>(`SELECT email, workspace_name FROM studio_invites WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now()`, [sha256((req.params as any).token)]);
    if (!inv) return reply.code(404).send({ error: "유효하지 않거나 만료된 초대입니다." });
    return inv;
  });
  app.post("/api/studio/auth/signup", async (req, reply) => {
    const b = z.object({ token: z.string().min(10), name: z.string().min(1).max(50), email: z.string().email(), password: z.string().min(10).max(200), workspaceName: z.string().min(1).max(80) }).parse(req.body);
    const r = await tx(async (c) => {
      const inv = await q1<any>(`SELECT * FROM studio_invites WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(b.token)], c);
      if (!inv) throw new HttpError(404, "유효하지 않거나 만료된 초대입니다.");
      if (inv.email && inv.email.toLowerCase() !== b.email.toLowerCase()) throw new HttpError(403, "초대받은 이메일로 가입하세요.");
      if (await q1(`SELECT 1 FROM studio_users WHERE lower(email)=lower($1)`, [b.email], c)) throw new HttpError(409, "이미 가입된 이메일입니다.");
      const ws = await q1<any>(`INSERT INTO studio_workspaces(name, kind) VALUES ($1,'vendor') RETURNING id`, [b.workspaceName], c);
      const u = await q1<any>(`INSERT INTO studio_users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [b.email, b.name, hashPassword(b.password)], c);
      await q(`INSERT INTO studio_members(workspace_id, user_id, role) VALUES ($1,$2,'owner')`, [ws.id, u.id], c);
      await q(`UPDATE studio_invites SET accepted_at=now() WHERE id=$1`, [inv.id], c);
      return { userId: u.id, workspaceId: ws.id };
    });
    reply.setCookie(STUDIO_COOKIE, await createStudioSession(r.userId, r.workspaceId), studioCookieOpts());
    await logEvent({ workspaceId: r.workspaceId, userId: r.userId }, "signup");
    return { ok: true };
  });

  app.get("/api/studio/me", async (req) => {
    const s = studioScope(req);
    const u = await q1<any>(`SELECT id, email, name, is_ops FROM studio_users WHERE id=$1`, [s.userId]);
    const ws = await q1<any>(`SELECT id, name, kind, limits FROM studio_workspaces WHERE id=$1`, [s.workspaceId]);
    const usage = await q1<any>(`SELECT count(*) FILTER (WHERE kind='render')::int AS renders, COALESCE(sum(cost_usd),0) AS cost FROM studio_usage WHERE workspace_id=$1 AND created_at > date_trunc('month', now())`, [s.workspaceId]);
    return {
      user: u,
      workspace: ws,
      role: s.role,
      isOps: s.isOps,
      usage,
      capabilities: { renderer: !!findChromium(), aiEdit: studioConfig.openaiEnabled },
    };
  });

  app.post("/api/studio/ops/invites", async (req) => {
    const s = studioScope(req);
    requireOps(s);
    const b = z.object({ email: z.string().email().optional(), workspaceName: z.string().max(80).optional(), days: z.number().int().min(1).max(60).default(14) }).parse(req.body ?? {});
    const token = randomToken(24);
    await q(`INSERT INTO studio_invites(token_hash, email, workspace_name, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`, [sha256(token), b.email ?? null, b.workspaceName ?? null, s.userId, String(b.days)]);
    return { token, path: `/studio/join/${token}` };
  });

  // ───────── 프로젝트 ─────────
  app.get("/api/studio/projects", async (req) => {
    const s = studioScope(req);
    return q(
      `SELECT p.*, (SELECT count(*)::int FROM studio_rooms r WHERE r.project_id=p.id) AS rooms,
              (SELECT max(created_at) FROM studio_render_jobs j WHERE j.project_id=p.id) AS last_render_at
         FROM studio_projects p WHERE p.workspace_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at DESC`,
      [s.workspaceId],
    );
  });

  app.post("/api/studio/projects", async (req) => {
    const s = studioScope(req);
    const b = z.object({ name: z.string().min(1).max(100), clientName: z.string().max(100).optional(), roomName: z.string().max(60).optional() }).parse(req.body);
    const p = await q1<any>(`INSERT INTO studio_projects(workspace_id, name, client_name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [s.workspaceId, b.name, b.clientName ?? null, s.userId]);
    const room = await q1<any>(`INSERT INTO studio_rooms(project_id, workspace_id, name) VALUES ($1,$2,$3) RETURNING *`, [p.id, s.workspaceId, b.roomName ?? "거실"]);
    await logEvent(s, "project_created", {}, p.id);
    return { ...p, firstRoomId: room.id };
  });

  app.post("/api/studio/samples/open", async (req) => {
    const s = studioScope(req);
    const r = await openSampleProject(s);
    await logEvent(s, "sample_opened", {}, r.projectId);
    return r;
  });

  app.get("/api/studio/projects/:id", async (req) => {
    const s = studioScope(req);
    const p = await getProject(s, (req.params as any).id);
    const rooms = await q(`SELECT id, name, created_at FROM studio_rooms WHERE project_id=$1 ORDER BY created_at`, [p.id]);
    return { ...p, rooms };
  });

  app.patch("/api/studio/projects/:id", async (req) => {
    const s = studioScope(req);
    const p = await getProject(s, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(100).optional(), clientName: z.string().max(100).nullable().optional(), archived: z.boolean().optional() }).parse(req.body);
    await q(`UPDATE studio_projects SET name=COALESCE($2,name), client_name=CASE WHEN $3::boolean THEN $4 ELSE client_name END, archived_at=CASE WHEN $5 THEN now() ELSE archived_at END WHERE id=$1`, [p.id, b.name ?? null, b.clientName !== undefined, b.clientName ?? null, b.archived === true]);
    return { ok: true };
  });

  app.post("/api/studio/projects/:id/rooms", async (req) => {
    const s = studioScope(req);
    const p = await getProject(s, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    return q1(`INSERT INTO studio_rooms(project_id, workspace_id, name) VALUES ($1,$2,$3) RETURNING *`, [p.id, s.workspaceId, b.name]);
  });

  // ───────── 방 ─────────
  app.get("/api/studio/rooms/:id", async (req) => {
    const s = studioScope(req);
    const room = await getRoom(s, (req.params as any).id);
    const project = await getProject(s, room.project_id);
    const photos = await q(
      `SELECT id, label, sort, width, height, preview_width, preview_height, exif, calibration, calib_status, calib_rev, view_adjust, masks, masks_rev,
              preview_file_id, master_file_id, original_file_id, replaces_photo_id, created_at
         FROM studio_photos WHERE room_id=$1 AND deleted_at IS NULL AND replaced_at IS NULL ORDER BY sort, created_at`,
      [room.id],
    );
    const variants = await q(
      `SELECT v.id, v.name, v.copied_from_variant_id, v.created_at, row_to_json(h) AS head
         FROM studio_variants v JOIN studio_variant_versions h ON h.id=v.head_version_id
        WHERE v.room_id=$1 AND v.archived_at IS NULL ORDER BY v.created_at`,
      [room.id],
    );
    return { room, project, photos, variants };
  });

  const refPointSchema = z.object({ id: z.string().min(1).max(12), label: z.string().max(60), world: z.tuple([z.number().min(-100).max(100), z.number().min(-10).max(20), z.number().min(-100).max(100)]), measured: z.boolean().optional() });
  app.patch("/api/studio/rooms/:id", async (req) => {
    const s = studioScope(req);
    const room = await getRoom(s, (req.params as any).id);
    const b = z
      .object({
        rev: z.number().int(),
        name: z.string().min(1).max(60).optional(),
        refPoints: z.array(refPointSchema).max(40).optional(),
        scaleMeasured: z.boolean().optional(),
        scaleNote: z.string().max(200).nullable().optional(),
        floorBounds: z.array(z.tuple([z.number(), z.number()])).max(40).nullable().optional(),
      })
      .parse(req.body);
    if (b.rev !== room.rev) throw new HttpError(409, "방 정보가 다른 곳에서 먼저 수정되었습니다.", "conflict");
    if (b.refPoints && new Set(b.refPoints.map((r) => r.id)).size !== b.refPoints.length) throw new HttpError(400, "기준점 이름이 중복됩니다.");
    const upd = await q1<any>(
      `UPDATE studio_rooms SET name=COALESCE($2,name), ref_points=COALESCE($3,ref_points), scale_measured=COALESCE($4,scale_measured),
         scale_note=CASE WHEN $5::boolean THEN $6 ELSE scale_note END, floor_bounds=CASE WHEN $7::boolean THEN $8 ELSE floor_bounds END,
         rev=rev+1, updated_at=now() WHERE id=$1 RETURNING *`,
      [room.id, b.name ?? null, b.refPoints ? JSON.stringify(b.refPoints) : null, b.scaleMeasured ?? null, b.scaleNote !== undefined, b.scaleNote ?? null, b.floorBounds !== undefined, b.floorBounds ? JSON.stringify(b.floorBounds) : null],
    );
    if (b.refPoints || b.scaleMeasured !== undefined) await recalibrateRoom(room.id);
    return upd;
  });

  // ───────── 사진 ─────────
  const binaryOpts = { bodyLimit: studioConfig.maxUploadBytes + 1024 };
  async function storePhoto(s: any, roomId: string, label: string, body: Buffer, replaces?: any) {
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, "사진 파일을 본문으로 보내 주세요.");
    const n = await normalizePhoto(body);
    const orig = await putFile({ workspaceId: s.workspaceId, kind: "photo_original", mime: `image/${n.format}`, data: body, width: n.width, height: n.height, ext: n.format === "jpeg" ? "jpg" : n.format });
    const master = await putFile({ workspaceId: s.workspaceId, kind: "photo_master", mime: "image/png", data: n.master, width: n.width, height: n.height, ext: "png" });
    const prev = await putFile({ workspaceId: s.workspaceId, kind: "photo_preview", mime: "image/jpeg", data: n.preview, width: n.previewWidth, height: n.previewHeight, ext: "jpg" });
    const sort = (await q1<any>(`SELECT COALESCE(max(sort),0)+1 AS n FROM studio_photos WHERE room_id=$1`, [roomId]))!.n;
    const calibration = { points: [], focalMode: n.exif.focal35mm ? "exif" : "auto" };
    const ph = await q1<any>(
      `INSERT INTO studio_photos(room_id, workspace_id, label, sort, original_file_id, master_file_id, preview_file_id, width, height, preview_width, preview_height, exif, calibration, replaces_photo_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [roomId, s.workspaceId, label, replaces?.sort ?? sort, orig.id, master.id, prev.id, n.width, n.height, n.previewWidth, n.previewHeight, n.exif, calibration, replaces?.id ?? null],
    );
    return ph;
  }

  app.post("/api/studio/rooms/:id/photos", binaryOpts, async (req) => {
    const s = studioScope(req);
    const room = await getRoom(s, (req.params as any).id);
    const count = (await q1<any>(`SELECT count(*)::int AS n FROM studio_photos WHERE room_id=$1 AND deleted_at IS NULL AND replaced_at IS NULL`, [room.id]))!.n;
    if (count >= 6) throw new HttpError(422, "한 방에는 사진을 최대 6장까지 올릴 수 있습니다.");
    const label = String((req.query as any).label ?? `시점 ${count + 1}`).slice(0, 40);
    const ph = await storePhoto(s, room.id, label, req.body as Buffer);
    await logEvent(s, "photo_uploaded", { photoId: ph.id }, room.project_id);
    return ph;
  });

  // 사진 교체: 새 사진은 보정을 다시 해야 한다. 이전 사진과 기존 렌더는 그대로 보존.
  app.post("/api/studio/photos/:id/replace", binaryOpts, async (req) => {
    const s = studioScope(req);
    const old = await getPhoto(s, (req.params as any).id);
    if (old.replaced_at) throw new HttpError(409, "이미 교체된 사진입니다.");
    const ph = await storePhoto(s, old.room_id, old.label, req.body as Buffer, old);
    // 이전 클릭점은 '제안'으로만 넘긴다. 새 사진에서 작업자가 확인하기 전에는 보정 완료로 보지 않는다.
    if (old.calibration?.points?.length) {
      await q(`UPDATE studio_photos SET calibration=$2 WHERE id=$1`, [ph.id, { points: [], focalMode: ph.exif?.focal35mm ? "exif" : old.calibration.focalMode, suggestedPoints: old.calibration.points, carriedFrom: old.id }]);
    }
    await recalibratePhoto(ph.id);
    await q(`UPDATE studio_photos SET replaced_at=now() WHERE id=$1`, [old.id]);
    return q1(`SELECT * FROM studio_photos WHERE id=$1`, [ph.id]);
  });

  app.patch("/api/studio/photos/:id", async (req) => {
    const s = studioScope(req);
    const ph = await getPhoto(s, (req.params as any).id);
    const poly = z.object({ id: z.string().max(40), points: z.array(z.tuple([z.number(), z.number()])).min(3).max(400) });
    const b = z
      .object({
        label: z.string().min(1).max(40).optional(),
        calibration: z
          .object({
            points: z.array(z.object({ refId: z.string().max(12), u: z.number(), v: z.number(), check: z.boolean().optional() })).max(40),
            focalMode: z.enum(["auto", "exif", "manual"]),
            focal35: z.number().min(8).max(400).nullable().optional(),
          })
          .optional(),
        viewAdjust: z.object({ exposure: z.number().min(-3).max(3), wb: z.tuple([z.number().min(0.5).max(1.5), z.number().min(0.5).max(1.5), z.number().min(0.5).max(1.5)]), blurPx: z.number().min(0).max(8), grain: z.number().min(0).max(10).nullable() }).optional(),
        masks: z.object({ occluders: z.array(poly).max(30), protected: z.array(poly).max(30) }).optional(),
      })
      .parse(req.body);
    if (b.calibration) {
      for (const p of b.calibration.points) if (p.u < 0 || p.v < 0 || p.u > ph.width || p.v > ph.height) throw new HttpError(400, "기준점이 사진 밖에 있습니다.");
    }
    await q(
      `UPDATE studio_photos SET label=COALESCE($2,label), calibration=COALESCE($3,calibration), view_adjust=COALESCE($4,view_adjust),
         masks=COALESCE($5,masks), masks_rev = masks_rev + CASE WHEN $5::jsonb IS NULL THEN 0 ELSE 1 END WHERE id=$1`,
      [ph.id, b.label ?? null, b.calibration ?? null, b.viewAdjust ?? null, b.masks ?? null],
    );
    if (b.calibration) await recalibratePhoto(ph.id);
    return q1(`SELECT * FROM studio_photos WHERE id=$1`, [ph.id]);
  });

  app.delete("/api/studio/photos/:id", async (req) => {
    const s = studioScope(req);
    const ph = await getPhoto(s, (req.params as any).id);
    await q(`UPDATE studio_photos SET deleted_at=now() WHERE id=$1`, [ph.id]);
    return { ok: true };
  });

  // 파일: 작업공간 소유 또는 공용 카탈로그만. 원본은 다운로드 이름에 원본 표시
  app.get("/api/studio/files/:id", async (req, reply) => {
    const s = studioScope(req);
    const f = await getOwnedFile(s, (req.params as any).id);
    const data = await readFile(f);
    reply.header("content-type", f.mime).header("cache-control", "private, max-age=3600");
    if ((req.query as any).download) reply.header("content-disposition", `attachment; filename="${f.kind}-${f.id.slice(0, 8)}.${f.storage_key.split(".").pop()}"`);
    return reply.send(data);
  });
}
