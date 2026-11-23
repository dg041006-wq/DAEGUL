// 렌더 작업: 입력 스냅샷·중복 식별·큐·처리·QA·사용량
import crypto from "node:crypto";
import sharp from "sharp";
import { q, q1, tx, type Db, pool } from "../db/pool.js";
import { viewAngleToPlacement, type Camera, type Placement } from "../../shared/studio/geometry.js";
import { DEFAULT_VIEW_ADJUST, type VariantState, type ViewAdjust } from "../../shared/studio/variant.js";
import { studioConfig } from "./config.js";
import { getFileRow, putFile, readFile } from "./storage.js";
import { compose, decodeRGB, encodeDelivery, encodeMaster, encodePreview, estimateNoiseSigma, rasterizePolygons, verifyMasterPreservation } from "./images.js";
import { RendererUnavailable, renderLayers } from "./renderer.js";
import { HttpError } from "./auth.js";

export type Evidence = "verified_model" | "unverified_model" | "appearance_estimate" | "needs_reference" | "concept";
const EVIDENCE_RANK: Evidence[] = ["verified_model", "unverified_model", "appearance_estimate", "needs_reference", "concept"];

export interface PlacementEvidence {
  placementId: string;
  assetName: string;
  evidence: Evidence;
  viewAzimuthDeg?: number;
  viewElevationDeg?: number;
  chosenRefLabel?: string | null;
  angleGapDeg?: number | null;
  need?: string | null;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

function directionName(az: number) {
  const a = ((az % 360) + 360) % 360;
  if (a < 22.5 || a >= 337.5) return "정면(0°)";
  if (a < 67.5) return "오른쪽 사선(45°)";
  if (a < 112.5) return "오른쪽 측면(90°)";
  if (a < 157.5) return "오른쪽 뒤 사선(135°)";
  if (a < 202.5) return "뒷면(180°)";
  if (a < 247.5) return "왼쪽 뒤 사선(225°)";
  if (a < 292.5) return "왼쪽 측면(270°)";
  return "왼쪽 사선(315°)";
}

/** 시점별 제품 근거 상태: 3D 검증 모델 / 미검증 3D / 사진 외관(가까운 참조각) / 추가 참조 필요 */
export function placementEvidence(cam: Camera, p: Placement, av: any): PlacementEvidence {
  const base = { placementId: p.id, assetName: av.asset_name };
  if (av.asset_kind === "concept") return { ...base, evidence: "concept" };
  if (av.asset_kind === "model3d") return { ...base, evidence: av.verification === "verified" ? "verified_model" : "unverified_model" };
  const { azimuthDeg, elevationDeg } = viewAngleToPlacement(cam, p);
  const refs: any[] = av.ref_photos ?? [];
  let best: any = null, gap = Infinity;
  for (const r of refs) {
    const g = Math.hypot(angleDiff(azimuthDeg, r.azimuthDeg ?? 0), (elevationDeg - (r.elevationDeg ?? 10)) * 0.5);
    if (g < gap) {
      gap = g;
      best = r;
    }
  }
  const ok = best && gap <= 25;
  return {
    ...base,
    evidence: ok ? "appearance_estimate" : "needs_reference",
    viewAzimuthDeg: +azimuthDeg.toFixed(1),
    viewElevationDeg: +elevationDeg.toFixed(1),
    chosenRefLabel: best?.label ?? null,
    angleGapDeg: Number.isFinite(gap) ? +gap.toFixed(1) : null,
    need: ok ? null : `이 시점은 제품의 ${directionName(azimuthDeg)} 방향(고도 ${elevationDeg.toFixed(0)}°)이 보입니다. 해당 각도의 상품 사진 또는 실제 3D 모델이 필요합니다.`,
  };
}

export function worstEvidence(list: Evidence[]): Evidence {
  return list.reduce<Evidence>((w, e) => (EVIDENCE_RANK.indexOf(e) > EVIDENCE_RANK.indexOf(w) ? e : w), "verified_model");
}

/** 공개 범위 상태 — 실사 품질이 실물 비교로 입증되기 전에는 3D 경로도 '내부 테스트' */
export function releaseStatus(evidence: Evidence, qa: any | null): "internal_test" | "needs_reference" | "manual_precision" {
  if (evidence === "needs_reference") return "needs_reference";
  if (qa && (qa.changedOutsideAllowed > 0 || qa.preservation?.ok === false)) return "manual_precision";
  if (qa && qa.allowedPixels > 0 && qa.occludedFurniturePixels / Math.max(1, qa.allowedPixels) > 0.5) return "manual_precision";
  return "internal_test";
}

export interface JobInputs {
  rendererVersion: string;
  photo: { id: string; masterFileId: string; masterSha: string; width: number; height: number; previewFileId: string; calibRev: number; calibStatus: string; camera: any; masksRev: number; masks: any; viewAdjust: ViewAdjust };
  variant: { versionId: string; version: number; state: VariantState };
  assets: Record<string, { assetId: string; versionId: string; version: number; kind: string; verification: string; fileId: string | null; fileSha: string | null; refPhoto: any | null; frontAxis: string; name: string }>;
  evidence: PlacementEvidence[];
}

/** 렌더 입력 스냅샷 생성 (보정이 없는 시점은 거부) */
export async function buildInputs(variantVersion: any, photo: any, db: Db = pool): Promise<JobInputs> {
  if (!photo.calibration?.result?.ok || !photo.calibration?.result?.camera) throw new HttpError(422, `${photo.label}: 카메라 보정이 완료되지 않아 렌더할 수 없습니다.`, "not_calibrated");
  const cam: Camera = photo.calibration.result.camera;
  const master = await getFileRow(photo.master_file_id, db);
  const state: VariantState = variantVersion.state;
  const assets: JobInputs["assets"] = {};
  const evidence: PlacementEvidence[] = [];
  for (const p of state.placements) {
    const av = await q1<any>(
      `SELECT v.*, a.kind AS asset_kind, a.name AS asset_name FROM studio_asset_versions v JOIN studio_assets a ON a.id=v.asset_id WHERE v.id=$1`,
      [p.assetVersionId],
      db,
    );
    if (!av) throw new HttpError(400, "가구 버전을 찾을 수 없습니다.");
    const ev = placementEvidence(cam, p, av);
    evidence.push(ev);
    let fileId: string | null = av.glb_file_id;
    let refPhoto: any = null;
    if (av.asset_kind === "photo") {
      // 가장 가까운 참조 사진 선택 (컷아웃 우선)
      refPhoto = (av.ref_photos ?? []).find((r: any) => r.label === ev.chosenRefLabel) ?? av.ref_photos?.[0] ?? null;
      fileId = refPhoto?.cutoutFileId ?? refPhoto?.fileId ?? null;
    }
    const f = fileId ? await getFileRow(fileId, db) : null;
    assets[p.assetVersionId] = { assetId: av.asset_id, versionId: av.id, version: av.version, kind: av.asset_kind, verification: av.verification, fileId, fileSha: f?.sha256 ?? null, refPhoto, frontAxis: av.meta?.frontAxis ?? "+Z", name: av.asset_name };
  }
  return {
    rendererVersion: studioConfig.rendererVersion,
    photo: {
      id: photo.id,
      masterFileId: photo.master_file_id,
      masterSha: master!.sha256,
      width: photo.width,
      height: photo.height,
      previewFileId: photo.preview_file_id,
      calibRev: photo.calib_rev,
      calibStatus: photo.calib_status,
      camera: cam,
      masksRev: photo.masks_rev,
      masks: photo.masks,
      viewAdjust: { ...DEFAULT_VIEW_ADJUST, ...(photo.view_adjust ?? {}) },
    },
    variant: { versionId: variantVersion.id, version: variantVersion.version, state },
    assets,
    evidence,
  };
}

export function inputHash(i: JobInputs) {
  const key = {
    r: i.rendererVersion,
    photo: { sha: i.photo.masterSha, cam: i.photo.camera, masks: i.photo.masks, adj: i.photo.viewAdjust },
    state: i.variant.state,
    assets: Object.values(i.assets).map((a) => [a.versionId, a.fileSha]).sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

async function monthlyRenderCount(workspaceId: string, db: Db) {
  return (await q1<{ n: number }>(`SELECT count(*)::int AS n FROM studio_usage WHERE workspace_id=$1 AND kind='render' AND created_at > date_trunc('month', now())`, [workspaceId], db))!.n;
}

/** 요청: 같은 입력이 완료돼 있으면 재사용, 진행 중이면 그 작업을 반환, 아니면 새로 대기열에 넣는다 */
export async function requestRender(s: { workspaceId: string; userId: string }, projectId: string, variantVersion: any, photo: any) {
  const inputs = await buildInputs(variantVersion, photo);
  const hash = inputHash(inputs);
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [hash]);
    const existing = await q1<any>(
      `SELECT * FROM studio_render_jobs WHERE input_hash=$1 AND workspace_id=$2 AND variant_version_id=$3 AND photo_id=$4 AND status IN ('queued','running','done') ORDER BY created_at DESC LIMIT 1`,
      [hash, s.workspaceId, variantVersion.id, photo.id],
      c,
    );
    if (existing) return { job: existing, deduped: true };
    const ws = await q1<any>(`SELECT limits FROM studio_workspaces WHERE id=$1`, [s.workspaceId], c);
    const limit = Number(ws?.limits?.monthlyRenders ?? 300);
    if ((await monthlyRenderCount(s.workspaceId, c)) >= limit) throw new HttpError(429, `이번 달 렌더 한도(${limit}회)에 도달했습니다. 스테이신에 한도 조정을 요청하세요.`, "limit");
    const evidence = worstEvidence(inputs.evidence.map((e) => e.evidence));
    const job = await q1<any>(
      `INSERT INTO studio_render_jobs(workspace_id, project_id, variant_version_id, photo_id, input_hash, inputs, evidence, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [s.workspaceId, projectId, variantVersion.id, photo.id, hash, inputs, evidence, s.userId],
      c,
    );
    return { job, deduped: false };
  });
}

// ───────── 처리 ─────────
async function buildSpec(inputs: JobInputs, files: Map<string, { mime: string; data: Buffer }>) {
  const placements = [];
  for (const p of inputs.variant.state.placements) {
    const a = inputs.assets[p.assetVersionId];
    if (!a?.fileId) continue;
    const f = await getFileRow(a.fileId);
    if (!f) throw Object.assign(new Error("asset file missing"), { code: "asset_missing" });
    const url = `/f/${f.id}`;
    if (!files.has(url)) files.set(url, { mime: f.mime, data: await readFile(f) });
    placements.push({ id: p.id, kind: a.kind === "model3d" ? "model3d" : "photo", url: "https://render.local" + url, dims: p.dims, position: p.position, rotationDeg: p.rotationDeg, frontAxis: a.frontAxis as any });
  }
  const pv = await getFileRow(inputs.photo.previewFileId);
  if (pv) files.set(`/f/${pv.id}`, { mime: pv.mime, data: await readFile(pv) });
  return {
    camera: inputs.photo.camera,
    placements,
    lighting: inputs.variant.state.lighting,
    exposure: inputs.photo.viewAdjust.exposure ?? 0,
    envUrl: pv ? `https://render.local/f/${pv.id}` : null,
  };
}

export async function processRenderJob(job: any) {
  const inputs: JobInputs = job.inputs;
  const t0 = Date.now();
  const files = new Map<string, { mime: string; data: Buffer }>();
  const spec = await buildSpec(inputs, files);
  const masterRow = await getFileRow(inputs.photo.masterFileId);
  if (!masterRow) throw Object.assign(new Error("photo master missing"), { code: "photo_missing" });
  const masterPng = await readFile(masterRow);
  const base = await decodeRGB(masterPng);
  const W = base.width, H = base.height;
  if (W !== inputs.photo.width || H !== inputs.photo.height) throw Object.assign(new Error("photo size changed"), { code: "photo_changed" });
  const layers = await renderLayers(spec, files);
  // 초점 심도 맞춤: 가구 레이어(프리멀티플라이드)에 가우시안 흐림
  let furniture = layers.furniture;
  const blur = inputs.photo.viewAdjust.blurPx ?? 0;
  if (blur >= 0.3) furniture = await sharp(furniture, { raw: { width: W, height: H, channels: 4, premultiplied: true } as any }).blur(Math.max(0.3, blur)).raw().toBuffer();
  const occluder = rasterizePolygons((inputs.photo.masks?.occluders ?? []).map((m: any) => m.points), W, H);
  const protect = rasterizePolygons((inputs.photo.masks?.protected ?? []).map((m: any) => m.points), W, H);
  const grain = inputs.photo.viewAdjust.grain ?? estimateNoiseSigma(base.data, W, H);
  const seed = parseInt(job.input_hash.slice(0, 8), 16);
  const { rgb, allowed, qa } = compose({ base: base.data, width: W, height: H, furniture, shadow: layers.shadow, occluder, protect, grainSigma: grain, seed, wb: inputs.photo.viewAdjust.wb });
  const masterOut = await encodeMaster(rgb, W, H);
  const preservation = await verifyMasterPreservation(masterOut, base.data, allowed, W, H);
  const delivery = await encodeDelivery(rgb, W, H);
  const preview = await encodePreview(rgb, W, H);
  // 레이어 보관(재검수·수동 편집용)
  const alphaPng = await sharp(layers.furniture, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const shadowPng = await sharp(layers.shadow, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const allowedPng = await sharp(Buffer.from(allowed.map((v) => (v ? 255 : 0))), { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return { masterOut, delivery, preview, alphaPng, shadowPng, allowedPng, qa: { ...qa, preservation, grainSigma: +grain.toFixed(2), tiles: layers.tiles, renderMs: layers.ms }, ms: Date.now() - t0, W, H };
}

export async function claimNextJob(workerId: string) {
  return q1<any>(
    `UPDATE studio_render_jobs SET status='running', started_at=now(), attempts=attempts+1, locked_by=$1, locked_until=now() + interval '10 minutes'
     WHERE id = (SELECT id FROM studio_render_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [workerId],
  );
}

export async function runRenderJob(job: any) {
  try {
    const r = await processRenderJob(job);
    // 처리 중 취소되었으면 결과를 버린다(상태가 섞이지 않도록)
    const cur = await q1<any>(`SELECT status FROM studio_render_jobs WHERE id=$1`, [job.id]);
    if (cur?.status !== "running") return "discarded";
    const ws = job.workspace_id;
    const m = await putFile({ workspaceId: ws, kind: "render_master", mime: "image/png", data: r.masterOut, width: r.W, height: r.H, ext: "png" });
    const d = await putFile({ workspaceId: ws, kind: "render_delivery", mime: "image/jpeg", data: r.delivery, width: r.W, height: r.H, ext: "jpg" });
    const p = await putFile({ workspaceId: ws, kind: "render_preview", mime: "image/jpeg", data: r.preview, ext: "jpg" });
    const a = await putFile({ workspaceId: ws, kind: "render_layer", mime: "image/png", data: r.alphaPng, width: r.W, height: r.H, ext: "png" });
    const sh = await putFile({ workspaceId: ws, kind: "render_layer", mime: "image/png", data: r.shadowPng, width: r.W, height: r.H, ext: "png" });
    const al = await putFile({ workspaceId: ws, kind: "render_layer", mime: "image/png", data: r.allowedPng, width: r.W, height: r.H, ext: "png" });
    const outputs = { masterFileId: m.id, deliveryFileId: d.id, previewFileId: p.id, alphaFileId: a.id, shadowFileId: sh.id, allowedMaskFileId: al.id, qa: r.qa, release: releaseStatus(job.evidence, r.qa) };
    const upd = await q1<any>(
      `UPDATE studio_render_jobs SET status='done', outputs=$2, finished_at=now(), duration_ms=$3, error_code=NULL, error_detail=NULL WHERE id=$1 AND status='running' RETURNING id`,
      [job.id, outputs, r.ms],
    );
    if (!upd) return "discarded";
    await q(`INSERT INTO studio_usage(workspace_id, project_id, kind, job_id, units, cost_usd, duration_ms) VALUES ($1,$2,'render',$3,1,0,$4)`, [ws, job.project_id, job.id, r.ms]);
    return "done";
  } catch (e: any) {
    const code = e instanceof RendererUnavailable ? "renderer_unavailable" : e?.code ?? "render_error";
    const detail = String(e?.message ?? e).slice(0, 500);
    await q(`UPDATE studio_render_jobs SET status='failed', error_code=$2, error_detail=$3, finished_at=now() WHERE id=$1 AND status='running'`, [job.id, code, detail]);
    return "failed";
  }
}

export async function runRenderQueueOnce(workerId = "inproc", limit = 5) {
  let n = 0;
  await q(`UPDATE studio_render_jobs SET status='queued', locked_by=NULL WHERE status='running' AND locked_until < now()`);
  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob(workerId);
    if (!job) break;
    await runRenderJob(job);
    n++;
  }
  return n;
}

let loopStop = false;
export async function startStudioRenderLoop() {
  loopStop = false;
  while (!loopStop) {
    try {
      const n = await runRenderQueueOnce(`proc-${process.pid}`, 1);
      if (!n) await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      console.error("studio render loop", (e as Error).message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
export function stopStudioRenderLoop() {
  loopStop = true;
}
