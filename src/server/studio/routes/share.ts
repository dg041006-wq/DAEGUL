// 고객 공유 링크(선택한 버전 전용 읽기 + 의견), 스테이신 상담 요청, 운영 화면, 지표
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../../db/pool.js";
import { randomToken, sha256 } from "../../auth/password.js";
import { getProject, getRoom, getVariantVersion, HttpError, logEvent, requireOps, studioScope } from "../auth.js";
import { lockVersion } from "../variants.js";
import { getFileRow, readFile } from "../storage.js";
import { productRows } from "./variants.js";
import { studioConfig } from "../config.js";
import { EVIDENCE_LABEL, RELEASE_LABEL } from "../../../shared/studio/variant.js";

const SIM_NOTICE = "배치 시뮬레이션 — 실제 시공·제품 사진이 아니며, 색상·질감·크기는 실물과 다를 수 있습니다.";

async function activeShare(token: string) {
  const sh = await q1<any>(`SELECT * FROM studio_share_links WHERE token_hash=$1`, [sha256(token)]);
  if (!sh) throw new HttpError(404, "공유 링크를 찾을 수 없습니다.");
  if (sh.revoked_at) throw new HttpError(410, "공유가 중지된 링크입니다.");
  if (new Date(sh.expires_at) < new Date()) throw new HttpError(410, "만료된 링크입니다.");
  return sh;
}

export async function studioShareRoutes(app: FastifyInstance) {
  // ───────── 공유 만들기 (업체) ─────────
  app.post("/api/studio/shares", async (req) => {
    const s = studioScope(req);
    const b = z
      .object({
        roomId: z.string().uuid(),
        title: z.string().min(1).max(100),
        clientName: z.string().max(60).optional(),
        expiresDays: z.number().int().min(1).max(90).default(studioConfig.shareDays),
        showBranding: z.boolean().default(true),
        items: z.array(z.object({ variantVersionId: z.string().uuid(), label: z.string().min(1).max(40), renderJobIds: z.array(z.string().uuid()).min(1).max(6) })).min(1).max(4),
      })
      .parse(req.body);
    const room = await getRoom(s, b.roomId);
    const token = randomToken(24);
    const share = await tx(async (c) => {
      for (const it of b.items) {
        const vv = await getVariantVersion(s, it.variantVersionId, c);
        const v = await q1<any>(`SELECT room_id FROM studio_variants WHERE id=$1`, [vv.variant_id], c);
        if (v.room_id !== room.id) throw new HttpError(400, "같은 방의 안만 공유할 수 있습니다.");
        for (const jid of it.renderJobIds) {
          const j = await q1<any>(`SELECT status, variant_version_id, workspace_id FROM studio_render_jobs WHERE id=$1`, [jid], c);
          if (!j || j.workspace_id !== s.workspaceId || j.variant_version_id !== vv.id || j.status !== "done") throw new HttpError(400, "완료된 해당 버전의 렌더만 공유할 수 있습니다.");
        }
        // 공유된 버전은 잠긴다 → 이후 수정은 새 버전으로 저장, 링크 내용은 그대로
        await lockVersion(vv.id, "shared", c);
      }
      return q1<any>(
        `INSERT INTO studio_share_links(workspace_id, project_id, room_id, token_hash, title, client_name, items, show_branding, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' days')::interval, $10) RETURNING *`,
        [s.workspaceId, room.project_id, room.id, sha256(token), b.title, b.clientName ?? null, JSON.stringify(b.items), b.showBranding, String(b.expiresDays), s.userId],
        c,
      );
    });
    await logEvent(s, "share_created", { shareId: share.id }, room.project_id);
    return { ...share, token, path: `/s/${token}` };
  });

  app.get("/api/studio/projects/:id/shares", async (req) => {
    const s = studioScope(req);
    const p = await getProject(s, (req.params as any).id);
    return q(
      `SELECT sl.id, sl.title, sl.client_name, sl.items, sl.expires_at, sl.revoked_at, sl.created_at, sl.room_id,
         (SELECT json_agg(f ORDER BY f.created_at) FROM studio_share_feedback f WHERE f.share_id=sl.id) AS feedback
       FROM studio_share_links sl WHERE sl.project_id=$1 AND sl.workspace_id=$2 ORDER BY sl.created_at DESC`,
      [p.id, s.workspaceId],
    );
  });

  app.post("/api/studio/shares/:id/revoke", async (req) => {
    const s = studioScope(req);
    const r = await q1(`UPDATE studio_share_links SET revoked_at=now() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL RETURNING id`, [(req.params as any).id, s.workspaceId]);
    if (!r) throw new HttpError(404, "공유 링크를 찾을 수 없거나 이미 중지되었습니다.");
    return { ok: true };
  });

  // ───────── 공개(고객) — 승인된 항목만 읽기 ─────────
  app.get("/api/studio/public/share/:token", async (req) => {
    const { token } = req.params as any;
    const sh = await activeShare(token);
    const ws = await q1<any>(`SELECT name FROM studio_workspaces WHERE id=$1`, [sh.workspace_id]);
    const items = [];
    for (const it of sh.items) {
      const vv = await q1<any>(`SELECT id, version, state, locked_reason, approved_at FROM studio_variant_versions WHERE id=$1 AND workspace_id=$2`, [it.variantVersionId, sh.workspace_id]);
      const jobs = await q<any>(
        `SELECT j.id, j.evidence, j.outputs, j.photo_id, p.label, p.width, p.height FROM studio_render_jobs j JOIN studio_photos p ON p.id=j.photo_id WHERE j.id = ANY($1) AND j.workspace_id=$2 AND j.status='done'`,
        [it.renderJobIds, sh.workspace_id],
      );
      items.push({
        variantVersionId: vv.id,
        label: it.label,
        version: vv.version,
        approved: !!vv.approved_at,
        images: jobs.map((j) => ({ renderJobId: j.id, view: j.label, photoId: j.photo_id, evidence: EVIDENCE_LABEL[j.evidence], release: RELEASE_LABEL[j.outputs.release], url: `/api/studio/public/share/${token}/image/${j.id}` })),
        products: (await productRows({ workspaceId: sh.workspace_id }, vv.state, jobs)).map(({ sourceUrl, position, ...r }) => r),
      });
    }
    const feedback = await q(`SELECT variant_version_id, kind, author_name, body, created_at FROM studio_share_feedback WHERE share_id=$1 ORDER BY created_at`, [sh.id]);
    await logEvent({ workspaceId: sh.workspace_id }, "share_viewed", { shareId: sh.id }, sh.project_id);
    return { title: sh.title, clientName: sh.client_name, vendor: sh.show_branding ? ws?.name : null, notice: SIM_NOTICE, expiresAt: sh.expires_at, items, feedback };
  });

  app.get("/api/studio/public/share/:token/image/:jobId", async (req, reply) => {
    const { token, jobId } = req.params as any;
    const sh = await activeShare(token);
    const allowed = sh.items.some((it: any) => it.renderJobIds.includes(jobId));
    if (!allowed) throw new HttpError(404, "공유되지 않은 이미지입니다.");
    const j = await q1<any>(`SELECT outputs FROM studio_render_jobs WHERE id=$1 AND workspace_id=$2 AND status='done'`, [jobId, sh.workspace_id]);
    if (!j) throw new HttpError(404, "이미지가 없습니다.");
    const f = await getFileRow(j.outputs.deliveryFileId); // 전달용 JPEG: 위치 등 메타데이터 없음
    reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=300");
    return reply.send(await readFile(f!));
  });

  app.post("/api/studio/public/share/:token/feedback", async (req) => {
    const { token } = req.params as any;
    const sh = await activeShare(token);
    const b = z.object({ variantVersionId: z.string().uuid(), kind: z.enum(["comment", "select", "approve"]), authorName: z.string().min(1).max(40), body: z.string().max(2000).optional() }).parse(req.body);
    if (!sh.items.some((it: any) => it.variantVersionId === b.variantVersionId)) throw new HttpError(400, "이 링크에서 공유되지 않은 안입니다.");
    if (b.kind === "comment" && !b.body?.trim()) throw new HttpError(400, "의견을 입력해 주세요.");
    await tx(async (c) => {
      await q(`INSERT INTO studio_share_feedback(share_id, workspace_id, variant_version_id, kind, author_name, body) VALUES ($1,$2,$3,$4,$5,$6)`, [sh.id, sh.workspace_id, b.variantVersionId, b.kind, b.authorName, b.body ?? null], c);
      if (b.kind === "approve") await lockVersion(b.variantVersionId, "approved", c);
    });
    await logEvent({ workspaceId: sh.workspace_id }, b.kind === "comment" ? "client_comment" : "client_choice", { kind: b.kind, shareId: sh.id }, sh.project_id);
    return { ok: true };
  });

  // ───────── 상담 요청 (업체 → 스테이신) ─────────
  app.post("/api/studio/consult", async (req) => {
    const s = studioScope(req);
    const b = z
      .object({
        projectId: z.string().uuid(),
        purpose: z.enum(["precision_composite", "shooting", "styling", "other"]),
        message: z.string().max(2000).optional(),
        problemNote: z.string().max(1000).optional(),
        included: z.object({ photoIds: z.array(z.string().uuid()).max(10), variantVersionIds: z.array(z.string().uuid()).max(10), renderJobIds: z.array(z.string().uuid()).max(20) }),
      })
      .parse(req.body);
    const p = await getProject(s, b.projectId);
    // 포함 자료가 모두 이 프로젝트 소유인지 확인
    for (const id of b.included.photoIds) if (!(await q1(`SELECT 1 FROM studio_photos ph JOIN studio_rooms r ON r.id=ph.room_id WHERE ph.id=$1 AND r.project_id=$2`, [id, p.id]))) throw new HttpError(400, "다른 프로젝트의 사진은 포함할 수 없습니다.");
    for (const id of b.included.variantVersionIds) if (!(await q1(`SELECT 1 FROM studio_variant_versions vv JOIN studio_variants v ON v.id=vv.variant_id JOIN studio_rooms r ON r.id=v.room_id WHERE vv.id=$1 AND r.project_id=$2`, [id, p.id]))) throw new HttpError(400, "다른 프로젝트의 안은 포함할 수 없습니다.");
    for (const id of b.included.renderJobIds) if (!(await q1(`SELECT 1 FROM studio_render_jobs WHERE id=$1 AND project_id=$2`, [id, p.id]))) throw new HttpError(400, "다른 프로젝트의 결과는 포함할 수 없습니다.");
    const r = await q1(`INSERT INTO studio_consult_requests(workspace_id, project_id, purpose, message, problem_note, included, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [s.workspaceId, p.id, b.purpose, b.message ?? null, b.problemNote ?? null, b.included, s.userId]);
    await logEvent(s, "consult_requested", { purpose: b.purpose }, p.id);
    return r;
  });

  app.get("/api/studio/consult", async (req) => {
    const s = studioScope(req);
    return q(`SELECT c.*, p.name AS project_name FROM studio_consult_requests c JOIN studio_projects p ON p.id=c.project_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC`, [s.workspaceId]);
  });

  // ───────── 운영(스테이신) ─────────
  app.get("/api/studio/ops/consults", async (req) => {
    requireOps(studioScope(req));
    return q(
      `SELECT c.id, c.purpose, c.message, c.problem_note, c.status, c.created_at, c.included, p.name AS project_name, w.name AS workspace_name, u.name AS requester
         FROM studio_consult_requests c JOIN studio_projects p ON p.id=c.project_id JOIN studio_workspaces w ON w.id=c.workspace_id LEFT JOIN studio_users u ON u.id=c.created_by
        ORDER BY c.created_at DESC LIMIT 200`,
    );
  });

  app.get("/api/studio/ops/consults/:id", async (req) => {
    requireOps(studioScope(req));
    const c = await q1<any>(`SELECT c.*, p.name AS project_name, w.name AS workspace_name FROM studio_consult_requests c JOIN studio_projects p ON p.id=c.project_id JOIN studio_workspaces w ON w.id=c.workspace_id WHERE c.id=$1`, [(req.params as any).id]);
    if (!c) throw new HttpError(404, "요청을 찾을 수 없습니다.");
    const photos = await q(`SELECT id, label, width, height, preview_file_id, calib_status, calibration->'result'->'issues' AS issues FROM studio_photos WHERE id = ANY($1)`, [c.included.photoIds]);
    const versions = await q(`SELECT vv.id, vv.version, vv.state, vv.summary, v.name FROM studio_variant_versions vv JOIN studio_variants v ON v.id=vv.variant_id WHERE vv.id = ANY($1)`, [c.included.variantVersionIds]);
    const jobs = await q(`SELECT id, photo_id, status, evidence, error_code, error_detail, outputs, inputs->'evidence' AS placement_evidence, duration_ms FROM studio_render_jobs WHERE id = ANY($1)`, [c.included.renderJobIds]);
    const products = [];
    for (const v of versions as any[]) products.push({ versionId: v.id, rows: await productRows({ workspaceId: c.workspace_id }, v.state) });
    return { ...c, photos, versions, jobs, products };
  });

  // 운영자는 요청에 포함된 파일만 열 수 있다
  app.get("/api/studio/ops/consults/:id/file/:fileId", async (req, reply) => {
    requireOps(studioScope(req));
    const { id, fileId } = req.params as any;
    const c = await q1<any>(`SELECT * FROM studio_consult_requests WHERE id=$1`, [id]);
    if (!c) throw new HttpError(404, "요청을 찾을 수 없습니다.");
    const photoFiles = await q<any>(`SELECT preview_file_id, master_file_id FROM studio_photos WHERE id = ANY($1)`, [c.included.photoIds]);
    const jobFiles = await q<any>(`SELECT outputs FROM studio_render_jobs WHERE id = ANY($1) AND status='done'`, [c.included.renderJobIds]);
    const allowed = new Set<string>([...photoFiles.flatMap((p) => [p.preview_file_id, p.master_file_id]), ...jobFiles.flatMap((j) => [j.outputs.previewFileId, j.outputs.deliveryFileId, j.outputs.masterFileId, j.outputs.alphaFileId, j.outputs.shadowFileId, j.outputs.allowedMaskFileId])]);
    if (!allowed.has(fileId)) throw new HttpError(403, "상담 요청에 포함되지 않은 자료입니다.");
    const f = await getFileRow(fileId);
    if (!f || f.workspace_id !== c.workspace_id) throw new HttpError(404, "파일이 없습니다.");
    reply.header("content-type", f.mime).header("cache-control", "private, no-store");
    return reply.send(await readFile(f));
  });

  app.patch("/api/studio/ops/consults/:id", async (req) => {
    requireOps(studioScope(req));
    const b = z.object({ status: z.enum(["new", "in_review", "closed"]).optional(), opsNote: z.string().max(2000).optional() }).parse(req.body);
    await q(`UPDATE studio_consult_requests SET status=COALESCE($2,status), ops_note=COALESCE($3,ops_note), updated_at=now() WHERE id=$1`, [(req.params as any).id, b.status ?? null, b.opsNote ?? null]);
    return { ok: true };
  });

  app.get("/api/studio/ops/usage", async (req) => {
    requireOps(studioScope(req));
    const byWs = await q(
      `SELECT w.id, w.name, w.kind, w.limits,
         (SELECT count(*)::int FROM studio_usage u WHERE u.workspace_id=w.id AND u.kind='render' AND u.created_at > date_trunc('month', now())) AS renders_month,
         (SELECT COALESCE(sum(cost_usd),0) FROM studio_usage u WHERE u.workspace_id=w.id AND u.created_at > date_trunc('month', now())) AS cost_month,
         (SELECT COALESCE(avg(duration_ms),0)::int FROM studio_render_jobs j WHERE j.workspace_id=w.id AND j.status='done') AS avg_render_ms,
         (SELECT count(*)::int FROM studio_render_jobs j WHERE j.workspace_id=w.id AND j.status='failed') AS failed
       FROM studio_workspaces w ORDER BY w.created_at`,
    );
    const failures = await q(`SELECT error_code, count(*)::int AS n, max(error_detail) AS sample FROM studio_render_jobs WHERE status='failed' GROUP BY error_code ORDER BY n DESC`);
    const funnel = await q(
      `SELECT name, count(DISTINCT workspace_id)::int AS workspaces, count(*)::int AS events FROM studio_events
        WHERE name IN ('sample_opened','project_created','photo_uploaded','render_requested','review_done','share_created','share_viewed','client_choice','client_comment','consult_requested')
        GROUP BY name`,
    );
    const providers = await q(`SELECT provider, count(*)::int AS n, max(created_at) AS last FROM studio_provider_log GROUP BY provider`);
    return { byWorkspace: byWs, failures, funnel, providers };
  });

  app.get("/api/studio/ops/renders/failed", async (req) => {
    requireOps(studioScope(req));
    return q(`SELECT j.id, j.error_code, j.error_detail, j.attempts, j.created_at, w.name AS workspace_name FROM studio_render_jobs j JOIN studio_workspaces w ON w.id=j.workspace_id WHERE j.status='failed' ORDER BY j.created_at DESC LIMIT 100`);
  });

  // ───────── 지표 / 파일럿 기록 ─────────
  app.post("/api/studio/events", async (req) => {
    const s = studioScope(req);
    const b = z.object({ name: z.enum(["review_done", "edit_time", "compare_viewed"]), projectId: z.string().uuid().optional(), props: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional() }).parse(req.body);
    if (b.projectId) await getProject(s, b.projectId);
    await logEvent(s, b.name, b.props ?? {}, b.projectId);
    return { ok: true };
  });

  app.get("/api/studio/metrics", async (req) => {
    const s = studioScope(req);
    const funnel = await q(`SELECT name, min(created_at) AS first_at, count(*)::int AS n FROM studio_events WHERE workspace_id=$1 GROUP BY name`, [s.workspaceId]);
    const perProject = await q(
      `SELECT p.id, p.name,
         (SELECT count(*)::int FROM studio_render_jobs j WHERE j.project_id=p.id) AS renders,
         (SELECT count(*)::int FROM studio_render_jobs j WHERE j.project_id=p.id AND j.status='failed') AS failed,
         (SELECT COALESCE(sum(duration_ms),0)::int FROM studio_render_jobs j WHERE j.project_id=p.id AND j.status='done') AS render_ms,
         (SELECT COALESCE(sum((props->>'minutes')::numeric),0) FROM studio_events e WHERE e.project_id=p.id AND e.name='edit_time') AS human_minutes,
         (SELECT COALESCE(sum(cost_usd),0) FROM studio_usage u WHERE u.project_id=p.id) AS cost_usd
       FROM studio_projects p WHERE p.workspace_id=$1 ORDER BY p.created_at DESC`,
      [s.workspaceId],
    );
    return { funnel, perProject };
  });

  app.post("/api/studio/pilot-logs", async (req) => {
    const s = studioScope(req);
    const b = z
      .object({
        projectId: z.string().uuid(),
        beforeMethod: z.string().max(200).optional(),
        beforeMinutes: z.number().int().min(0).max(100000).optional(),
        neededExactProduct: z.boolean().optional(),
        deliveredToClient: z.boolean().optional(),
        reusedForRevision: z.boolean().optional(),
        wouldUseAgain: z.boolean().optional(),
        humanMinutes: z.number().int().min(0).max(100000).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    await getProject(s, b.projectId);
    return q1(
      `INSERT INTO studio_pilot_logs(workspace_id, project_id, before_method, before_minutes, needed_exact_product, delivered_to_client, reused_for_revision, would_use_again, human_minutes, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [s.workspaceId, b.projectId, b.beforeMethod ?? null, b.beforeMinutes ?? null, b.neededExactProduct ?? null, b.deliveredToClient ?? null, b.reusedForRevision ?? null, b.wouldUseAgain ?? null, b.humanMinutes ?? null, b.notes ?? null, s.userId],
    );
  });
}
