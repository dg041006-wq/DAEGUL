// 안·버전·렌더·다운로드
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import sharp from "sharp";
import { q, q1, tx } from "../../db/pool.js";
import { getPhoto, getProject, getRoom, getVariant, getVariantVersion, HttpError, logEvent, studioScope, type StudioScope } from "../auth.js";
import { createVariant, lockVersion, saveDraft, stateSchema } from "../variants.js";
import { requestRender, releaseStatus } from "../renderJobs.js";
import { getFileRow, readFile } from "../storage.js";
import { makeZip } from "../zip.js";
import { EVIDENCE_LABEL, RELEASE_LABEL, type VariantState } from "../../../shared/studio/variant.js";

const pub = (j: any) => ({
  id: j.id,
  photoId: j.photo_id,
  variantVersionId: j.variant_version_id,
  status: j.status,
  evidence: j.evidence,
  evidenceLabel: EVIDENCE_LABEL[j.evidence] ?? j.evidence,
  release: j.outputs?.release ?? (j.status === "done" ? releaseStatus(j.evidence, j.outputs?.qa) : null),
  releaseLabel: j.outputs?.release ? RELEASE_LABEL[j.outputs.release] : null,
  placementEvidence: j.inputs?.evidence ?? [],
  assetVersions: Object.values(j.inputs?.assets ?? {}).map((a: any) => ({ assetId: a.assetId, versionId: a.versionId, version: a.version, name: a.name, kind: a.kind, verification: a.verification })),
  calibStatus: j.inputs?.photo?.calibStatus,
  masksRev: j.inputs?.photo?.masksRev,
  outputs: j.outputs ? { masterFileId: j.outputs.masterFileId, deliveryFileId: j.outputs.deliveryFileId, previewFileId: j.outputs.previewFileId, alphaFileId: j.outputs.alphaFileId, shadowFileId: j.outputs.shadowFileId, allowedMaskFileId: j.outputs.allowedMaskFileId, qa: j.outputs.qa } : null,
  errorCode: j.error_code,
  errorDetail: j.error_detail,
  attempts: j.attempts,
  durationMs: j.duration_ms,
  createdAt: j.created_at,
  finishedAt: j.finished_at,
});

export async function productRows(s: StudioScope | { workspaceId: string }, state: VariantState, jobs: any[] = []) {
  const rows: any[] = [];
  for (const p of state.placements) {
    const a = await q1<any>(
      `SELECT a.name, a.brand, a.model_code, a.color, a.material, a.source_url, a.kind, a.size_options, v.version, v.verification FROM studio_asset_versions v JOIN studio_assets a ON a.id=v.asset_id
       WHERE v.id=$1 AND (a.workspace_id=$2 OR a.workspace_id IS NULL)`,
      [p.assetVersionId, s.workspaceId],
    );
    if (!a) continue;
    const ev = jobs.flatMap((j) => (j.inputs?.evidence ?? []).filter((e: any) => e.placementId === p.id).map((e: any) => EVIDENCE_LABEL[e.evidence]));
    rows.push({
      name: a.name,
      brand: a.brand,
      model: a.model_code,
      color: a.color,
      material: a.material,
      dims: `${p.dims.w}×${p.dims.d}×${p.dims.h}cm`,
      sizeLabel: p.nonStandard ? "비규격 크기" : a.size_options?.[p.sizeOptionIndex ?? 0]?.label ?? "",
      assetVersion: a.version,
      verification: a.kind === "model3d" ? (a.verification === "verified" ? "3D 모델 확인" : "3D 모델(미확인)") : a.kind === "photo" ? "상품 사진(외관 참조)" : "콘셉트",
      perView: [...new Set(ev)].join(" / "),
      position: `X ${(p.position.x * 100).toFixed(0)}cm, Z ${(p.position.z * 100).toFixed(0)}cm, ${p.rotationDeg.toFixed(0)}°`,
      sourceUrl: a.source_url ?? "",
    });
  }
  return rows;
}

function csv(rows: any[]) {
  const head = ["제품명", "브랜드", "모델", "색상", "소재", "치수", "옵션", "에셋 버전", "제품 확인 상태", "시점별 근거", "위치", "출처 링크"];
  const keys = ["name", "brand", "model", "color", "material", "dims", "sizeLabel", "assetVersion", "verification", "perView", "position", "sourceUrl"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "﻿" + [head.map(esc).join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\r\n") + "\r\n";
}

export async function studioVariantRoutes(app: FastifyInstance) {
  app.post("/api/studio/rooms/:id/variants", async (req) => {
    const s = studioScope(req);
    const room = await getRoom(s, (req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(40), copyFromVariantId: z.string().uuid().optional() }).parse(req.body);
    return tx(async (c) => {
      let copy = null;
      if (b.copyFromVariantId) {
        const src = await getVariant(s, b.copyFromVariantId, c);
        if (src.room_id !== room.id) throw new HttpError(400, "같은 방의 안만 복제할 수 있습니다.");
        const head = await q1<any>(`SELECT * FROM studio_variant_versions WHERE id=$1`, [src.head_version_id], c);
        copy = { variantId: src.id, versionId: head.id, state: head.state, label: `${src.name} v${head.version}` };
      }
      return createVariant(s, room.id, b.name, copy, c);
    });
  });

  app.get("/api/studio/variants/:id/versions", async (req) => {
    const s = studioScope(req);
    const v = await getVariant(s, (req.params as any).id);
    return q(`SELECT * FROM studio_variant_versions WHERE variant_id=$1 ORDER BY version DESC`, [v.id]);
  });

  app.put("/api/studio/variants/:id/draft", async (req) => {
    const s = studioScope(req);
    const b = z.object({ state: stateSchema, rev: z.number().int().optional() }).parse(req.body);
    return tx(async (c) => {
      const v = await getVariant(s, (req.params as any).id, c);
      return saveDraft(s, v, b.state as VariantState, b.rev, c);
    });
  });

  app.post("/api/studio/variants/:id/lock", async (req) => {
    const s = studioScope(req);
    const v = await getVariant(s, (req.params as any).id);
    const b = z.object({ note: z.string().max(200).optional() }).parse(req.body ?? {});
    await lockVersion(v.head_version_id, "saved", undefined as any);
    if (b.note) await q(`UPDATE studio_variant_versions SET note=$2 WHERE id=$1`, [v.head_version_id, b.note]);
    return q1(`SELECT * FROM studio_variant_versions WHERE id=$1`, [v.head_version_id]);
  });

  app.get("/api/studio/variant-versions/:id", async (req) => {
    const s = studioScope(req);
    return getVariantVersion(s, (req.params as any).id);
  });

  // ───────── 렌더 ─────────
  app.post("/api/studio/renders", async (req) => {
    const s = studioScope(req);
    const b = z.object({ variantVersionId: z.string().uuid(), photoIds: z.array(z.string().uuid()).min(1).max(6) }).parse(req.body);
    const vv = await getVariantVersion(s, b.variantVersionId);
    const variant = await getVariant(s, vv.variant_id);
    const room = await getRoom(s, variant.room_id);
    const results: any[] = [];
    for (const pid of b.photoIds) {
      const ph = await getPhoto(s, pid);
      if (ph.room_id !== room.id) throw new HttpError(400, "다른 방의 사진입니다.");
      try {
        const r = await requestRender(s, room.project_id, vv, ph);
        results.push({ photoId: pid, deduped: r.deduped, job: pub(r.job) });
      } catch (e: any) {
        if (e instanceof HttpError && e.status !== 429) results.push({ photoId: pid, skipped: true, reason: e.message, code: e.code });
        else throw e;
      }
    }
    await logEvent(s, "render_requested", { n: results.length }, room.project_id);
    return results;
  });

  app.get("/api/studio/renders", async (req) => {
    const s = studioScope(req);
    const qs = z.object({ variantVersionId: z.string().uuid().optional(), roomId: z.string().uuid().optional() }).parse(req.query);
    if (qs.variantVersionId) {
      await getVariantVersion(s, qs.variantVersionId);
      return (await q(`SELECT * FROM studio_render_jobs WHERE variant_version_id=$1 AND workspace_id=$2 ORDER BY created_at DESC`, [qs.variantVersionId, s.workspaceId])).map(pub);
    }
    if (qs.roomId) {
      await getRoom(s, qs.roomId);
      return (
        await q(
          `SELECT j.* FROM studio_render_jobs j JOIN studio_variant_versions vv ON vv.id=j.variant_version_id JOIN studio_variants v ON v.id=vv.variant_id
           WHERE v.room_id=$1 AND j.workspace_id=$2 ORDER BY j.created_at DESC LIMIT 200`,
          [qs.roomId, s.workspaceId],
        )
      ).map(pub);
    }
    throw new HttpError(400, "variantVersionId 또는 roomId가 필요합니다.");
  });

  const ownedJob = async (s: StudioScope, id: string) => {
    const j = await q1<any>(`SELECT * FROM studio_render_jobs WHERE id=$1 AND workspace_id=$2`, [id, s.workspaceId]);
    if (!j) throw new HttpError(404, "렌더 작업을 찾을 수 없습니다.");
    return j;
  };

  app.get("/api/studio/renders/:id", async (req) => pub(await ownedJob(studioScope(req), (req.params as any).id)));

  app.post("/api/studio/renders/:id/cancel", async (req) => {
    const s = studioScope(req);
    const j = await ownedJob(s, (req.params as any).id);
    const r = await q1(`UPDATE studio_render_jobs SET status='canceled', finished_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING id`, [j.id]);
    if (!r) throw new HttpError(409, "이미 끝난 작업은 취소할 수 없습니다.");
    return { ok: true };
  });

  // 실패·취소된 시점만 다시: 같은 입력으로 새 작업 (기존 성공 결과는 그대로)
  app.post("/api/studio/renders/:id/retry", async (req) => {
    const s = studioScope(req);
    const j = await ownedJob(s, (req.params as any).id);
    if (!["failed", "canceled"].includes(j.status)) throw new HttpError(409, "실패하거나 취소된 작업만 다시 시도할 수 있습니다.");
    const vv = await getVariantVersion(s, j.variant_version_id);
    const ph = await getPhoto(s, j.photo_id);
    const r = await requestRender(s, j.project_id, vv, ph);
    return { deduped: r.deduped, job: pub(r.job) };
  });

  app.get("/api/studio/renders/:id/download", async (req, reply) => {
    const s = studioScope(req);
    const j = await ownedJob(s, (req.params as any).id);
    if (j.status !== "done") throw new HttpError(409, "완료된 렌더만 내려받을 수 있습니다.");
    const type = (req.query as any).type === "delivery" ? "delivery" : "master";
    const f = await getFileRow(type === "delivery" ? j.outputs.deliveryFileId : j.outputs.masterFileId);
    if (!f || f.workspace_id !== s.workspaceId) throw new HttpError(404, "파일이 없습니다.");
    const ph = await q1<any>(`SELECT label FROM studio_photos WHERE id=$1`, [j.photo_id]);
    const vv = await q1<any>(`SELECT vv.version, v.name FROM studio_variant_versions vv JOIN studio_variants v ON v.id=vv.variant_id WHERE vv.id=$1`, [j.variant_version_id]);
    const fname = `${vv.name}_v${vv.version}_${ph?.label ?? "view"}_${type === "master" ? "master.png" : "delivery.jpg"}`;
    reply.header("content-type", f.mime).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await logEvent(s, "download", { type, jobId: j.id }, j.project_id);
    return reply.send(await readFile(f));
  });

  app.get("/api/studio/variant-versions/:id/products.csv", async (req, reply) => {
    const s = studioScope(req);
    const vv = await getVariantVersion(s, (req.params as any).id);
    const jobs = await q(`SELECT * FROM studio_render_jobs WHERE variant_version_id=$1 AND status='done'`, [vv.id]);
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="products-v${vv.version}.csv"`);
    return csv(await productRows(s, vv.state, jobs));
  });

  app.get("/api/studio/variant-versions/:id/products", async (req) => {
    const s = studioScope(req);
    const vv = await getVariantVersion(s, (req.params as any).id);
    const jobs = await q(`SELECT * FROM studio_render_jobs WHERE variant_version_id=$1 AND status='done'`, [vv.id]);
    return productRows(s, vv.state, jobs);
  });

  // 묶음 다운로드: 시점별 최신 완료 결과 + 제품 목록 + 근거 기록
  app.get("/api/studio/variant-versions/:id/bundle.zip", async (req, reply) => {
    const s = studioScope(req);
    const vv = await getVariantVersion(s, (req.params as any).id);
    const kind = (req.query as any).type === "master" ? "master" : "delivery";
    const jobs = await q<any>(
      `SELECT DISTINCT ON (j.photo_id) j.*, p.label FROM studio_render_jobs j JOIN studio_photos p ON p.id=j.photo_id
       WHERE j.variant_version_id=$1 AND j.workspace_id=$2 AND j.status='done' ORDER BY j.photo_id, j.finished_at DESC`,
      [vv.id, s.workspaceId],
    );
    if (!jobs.length) throw new HttpError(409, "완료된 렌더가 없습니다.");
    const v = await q1<any>(`SELECT name FROM studio_variants WHERE id=$1`, [vv.variant_id]);
    const files: { name: string; data: Buffer }[] = [];
    for (const j of jobs) {
      const f = await getFileRow(kind === "master" ? j.outputs.masterFileId : j.outputs.deliveryFileId);
      if (f) files.push({ name: `${v.name}_v${vv.version}_${j.label}.${kind === "master" ? "png" : "jpg"}`, data: await readFile(f) });
    }
    files.push({ name: "제품목록.csv", data: Buffer.from(csv(await productRows(s, vv.state, jobs)), "utf8") });
    const manifest = {
      notice: "배치 시뮬레이션 — 실제 시공·제품 사진이 아닙니다.",
      variant: v.name,
      version: vv.version,
      lockedReason: vv.locked_reason,
      views: jobs.map((j) => ({ view: j.label, renderJobId: j.id, evidence: EVIDENCE_LABEL[j.evidence], release: RELEASE_LABEL[j.outputs.release], calibration: j.inputs.photo.calibStatus, assets: Object.values(j.inputs.assets).map((a: any) => `${a.name} v${a.version}`), qa: { changedOutsideAllowed: j.outputs.qa.changedOutsideAllowed, preservation: j.outputs.qa.preservation } })),
    };
    files.push({ name: "근거기록.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
    reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${v.name}_v${vv.version}.zip`)}`);
    await logEvent(s, "download", { type: "bundle", versionId: vv.id });
    return reply.send(makeZip(files));
  });

  // A/B 비교 한 장 (같은 시점 두 결과를 나란히)
  app.get("/api/studio/compare.jpg", async (req, reply) => {
    const s = studioScope(req);
    const { a, b } = z.object({ a: z.string().uuid(), b: z.string().uuid() }).parse(req.query);
    const ja = await ownedJob(s, a), jb = await ownedJob(s, b);
    if (ja.status !== "done" || jb.status !== "done") throw new HttpError(409, "두 결과가 모두 완료되어야 합니다.");
    if (ja.photo_id !== jb.photo_id) throw new HttpError(400, "같은 시점의 결과끼리 비교하세요.");
    reply.header("content-type", "image/jpeg").header("content-disposition", `attachment; filename="compare.jpg"`);
    return reply.send(await compareImage(ja, jb));
  });

  void getProject;
}

export async function compareImage(ja: any, jb: any) {
  const fa = await getFileRow(ja.outputs.deliveryFileId), fb = await getFileRow(jb.outputs.deliveryFileId);
  const W = 1400;
  const ia = await sharp(await readFile(fa!)).resize(W).toBuffer({ resolveWithObject: true });
  const ib = await sharp(await readFile(fb!)).resize(W).toBuffer({ resolveWithObject: true });
  const H = ia.info.height, band = 56;
  const label = (t: string) => Buffer.from(`<svg width="${W}" height="${band}"><rect width="100%" height="100%" fill="#2b2a28"/><text x="24" y="37" font-family="sans-serif" font-size="26" fill="#f4f1ec">${t}</text></svg>`);
  const name = async (j: any) => {
    const r = await q1<any>(`SELECT v.name, vv.version FROM studio_variant_versions vv JOIN studio_variants v ON v.id=vv.variant_id WHERE vv.id=$1`, [j.variant_version_id]);
    return `${/^[\x00-\x7f]*$/.test(r.name) ? r.name : r.name.replace(/[^\x00-\x7f]/g, "").trim() || "Plan"} v${r.version} - placement simulation`;
  };
  return sharp({ create: { width: W * 2 + 16, height: H + band, channels: 3, background: "#f4f1ec" } })
    .composite([
      { input: ia.data, left: 0, top: band },
      { input: ib.data, left: W + 16, top: band },
      { input: label(`A  ${await name(ja)}`), left: 0, top: 0 },
      { input: label(`B  ${await name(jb)}`), left: W + 16, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}
