// 가구 제품·에셋 버전 (버전은 불변 — 파일 교체 시 새 버전, 이전 시안은 이전 버전 유지)
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import sharp from "sharp";
import { q, q1 } from "../../db/pool.js";
import { getAsset, HttpError, logEvent, studioScope } from "../auth.js";
import { putFile } from "../storage.js";
import { dimsMismatch, inspectGlb } from "../glb.js";
import { autoCutout } from "../images.js";
import { studioConfig } from "../config.js";

const sizeOpt = z.object({ label: z.string().max(40), w: z.number().min(5).max(1000), d: z.number().min(5).max(1000), h: z.number().min(5).max(500) });

export async function nextAssetVersion(assetId: string) {
  return (await q1<any>(`SELECT COALESCE(max(version),0)+1 AS n FROM studio_asset_versions WHERE asset_id=$1`, [assetId]))!.n as number;
}

export async function studioAssetRoutes(app: FastifyInstance) {
  app.get("/api/studio/assets", async (req) => {
    const s = studioScope(req);
    return q(
      `SELECT a.*, row_to_json(v) AS current_version, (a.workspace_id IS NULL) AS is_catalog
         FROM studio_assets a LEFT JOIN studio_asset_versions v ON v.id=a.current_version_id
        WHERE (a.workspace_id=$1 OR a.workspace_id IS NULL) AND a.archived_at IS NULL
        ORDER BY (a.workspace_id IS NULL), a.created_at DESC`,
      [s.workspaceId],
    );
  });

  app.get("/api/studio/assets/:id", async (req) => {
    const s = studioScope(req);
    const a = await getAsset(s, (req.params as any).id);
    const versions = await q(`SELECT * FROM studio_asset_versions WHERE asset_id=$1 ORDER BY version DESC`, [a.id]);
    return { ...a, versions, is_catalog: a.workspace_id === null };
  });

  app.post("/api/studio/assets", async (req) => {
    const s = studioScope(req);
    const b = z
      .object({
        name: z.string().min(1).max(100),
        brand: z.string().max(60).optional(),
        modelCode: z.string().max(60).optional(),
        category: z.enum(["sofa", "chair", "table", "bed", "storage", "lighting", "other"]).default("sofa"),
        color: z.string().max(40).optional(),
        material: z.string().max(60).optional(),
        sourceUrl: z.string().url().max(500).optional().or(z.literal("")),
        kind: z.enum(["model3d", "photo", "concept"]),
        sizeOptions: z.array(sizeOpt).min(1).max(12),
        notes: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const a = await q1<any>(
      `INSERT INTO studio_assets(workspace_id, name, brand, model_code, category, color, material, source_url, kind, size_options, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [s.workspaceId, b.name, b.brand ?? null, b.modelCode ?? null, b.category, b.color ?? null, b.material ?? null, b.sourceUrl || null, b.kind, JSON.stringify(b.sizeOptions), b.notes ?? null, s.userId],
    );
    await logEvent(s, "asset_created", { kind: b.kind });
    return a;
  });

  app.patch("/api/studio/assets/:id", async (req) => {
    const s = studioScope(req);
    const a = await getAsset(s, (req.params as any).id);
    if (!a.workspace_id) throw new HttpError(403, "기본 카탈로그 제품은 수정할 수 없습니다. 내 제품으로 복제해 사용하세요.");
    const b = z.object({ name: z.string().min(1).max(100).optional(), color: z.string().max(40).nullable().optional(), material: z.string().max(60).nullable().optional(), sizeOptions: z.array(sizeOpt).min(1).max(12).optional(), notes: z.string().max(1000).nullable().optional(), archived: z.boolean().optional() }).parse(req.body);
    await q(
      `UPDATE studio_assets SET name=COALESCE($2,name), color=COALESCE($3,color), material=COALESCE($4,material), size_options=COALESCE($5,size_options), notes=COALESCE($6,notes),
         archived_at=CASE WHEN $7 THEN now() ELSE archived_at END WHERE id=$1`,
      [a.id, b.name ?? null, b.color ?? null, b.material ?? null, b.sizeOptions ? JSON.stringify(b.sizeOptions) : null, b.notes ?? null, b.archived === true],
    );
    return q1(`SELECT * FROM studio_assets WHERE id=$1`, [a.id]);
  });

  const binaryOpts = { bodyLimit: studioConfig.maxUploadBytes + 1024 };

  // 3D 모델(GLB) 업로드 → 새 버전. 선언 치수와 실제 모델 치수를 비교해 검증 상태를 정한다.
  app.post("/api/studio/assets/:id/versions/glb", binaryOpts, async (req) => {
    const s = studioScope(req);
    const a = await getAsset(s, (req.params as any).id);
    if (!a.workspace_id) throw new HttpError(403, "기본 카탈로그 제품에는 업로드할 수 없습니다.");
    if (a.kind !== "model3d") throw new HttpError(400, "3D 모델 제품에만 GLB를 올릴 수 있습니다.");
    const body = req.body as Buffer;
    const qs = req.query as any;
    const info = inspectGlb(body);
    const declared = a.size_options[0];
    const mismatch = dimsMismatch(declared, info.sizeCm);
    const frontAxis = ["+Z", "-Z", "+X", "-X"].includes(qs.frontAxis) ? qs.frontAxis : "+Z";
    const f = await putFile({ workspaceId: s.workspaceId, kind: "asset_glb", mime: "model/gltf-binary", data: body, ext: "glb" });
    const confirmed = qs.confirmed === "true"; // 작업자가 실물·제조사 자료와 치수·방향·재질을 대조했다고 표시
    const verification = confirmed && mismatch.length === 0 ? "verified" : "unverified";
    const meta = {
      units: "m",
      frontAxis,
      pivot: "floor-center",
      measuredBBoxCm: info.sizeCm,
      declaredCm: declared,
      dimensionMismatch: mismatch,
      textureStatus: info.textures > 0 ? "embedded" : "none",
      provenance: String(qs.provenance ?? "업체 업로드").slice(0, 200),
      license: String(qs.license ?? "미기재").slice(0, 100),
      glbIssues: info.issues,
      generator: info.generator ?? null,
    };
    const version = await nextAssetVersion(a.id);
    const v = await q1<any>(`INSERT INTO studio_asset_versions(asset_id, version, glb_file_id, meta, verification, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [a.id, version, f.id, meta, verification, s.userId]);
    await q(`UPDATE studio_assets SET current_version_id=$2 WHERE id=$1`, [a.id, v.id]);
    return v;
  });

  // 상품 사진 업로드(각도 지정) → 이전 참조 사진을 포함한 새 버전
  app.post("/api/studio/assets/:id/versions/photo", binaryOpts, async (req) => {
    const s = studioScope(req);
    const a = await getAsset(s, (req.params as any).id);
    if (!a.workspace_id) throw new HttpError(403, "기본 카탈로그 제품에는 업로드할 수 없습니다.");
    if (a.kind !== "photo" && a.kind !== "concept") throw new HttpError(400, "사진 기반 제품에만 참조 사진을 올릴 수 있습니다.");
    const body = req.body as Buffer;
    const qs = req.query as any;
    const az = Number(qs.azimuth ?? 0), el = Number(qs.elevation ?? 10);
    if (!Number.isFinite(az) || !Number.isFinite(el)) throw new HttpError(400, "촬영 각도를 숫자로 입력하세요.");
    let meta: sharp.Metadata;
    try {
      meta = await sharp(body).metadata();
    } catch {
      throw new HttpError(415, "이미지 파일이 아닙니다.");
    }
    if (!meta.width || meta.width * (meta.height ?? 0) > 40_000_000) throw new HttpError(413, "이미지가 너무 큽니다.");
    const orig = await putFile({ workspaceId: s.workspaceId, kind: "asset_ref", mime: `image/${meta.format}`, data: body, width: meta.width, height: meta.height, ext: meta.format === "jpeg" ? "jpg" : String(meta.format) });
    const cut = await autoCutout(body);
    const cutFile = cut.png ? await putFile({ workspaceId: s.workspaceId, kind: "asset_cutout", mime: "image/png", data: cut.png, width: cut.width, height: cut.height, ext: "png" }) : null;
    const prev = a.current_version_id ? await q1<any>(`SELECT ref_photos FROM studio_asset_versions WHERE id=$1`, [a.current_version_id]) : null;
    const ref = { fileId: orig.id, cutoutFileId: cutFile?.id ?? null, azimuthDeg: ((az % 360) + 360) % 360, elevationDeg: el, label: String(qs.label ?? `${az}°`).slice(0, 40), cutout: cut.method, note: cut.note };
    const refs = [...(prev?.ref_photos ?? []), ref];
    const version = await nextAssetVersion(a.id);
    const v = await q1<any>(
      `INSERT INTO studio_asset_versions(asset_id, version, ref_photos, meta, verification, created_by) VALUES ($1,$2,$3,$4,'appearance',$5) RETURNING *`,
      [a.id, version, JSON.stringify(refs), { provenance: String(qs.provenance ?? "업체 업로드").slice(0, 200), note: "상품 사진 기반 — 보이는 면만 근거. 다른 시점은 외관 추정" }, s.userId],
    );
    await q(`UPDATE studio_assets SET current_version_id=$2 WHERE id=$1`, [a.id, v.id]);
    return { version: v, cutout: { method: cut.method, note: cut.note } };
  });
}
