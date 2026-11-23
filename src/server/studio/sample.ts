// 기본 카탈로그와 샘플 프로젝트 (실제 촬영 파노라마에서 잘라낸 CC0 사진 + CC0 3D 소파)
import fs from "node:fs";
import path from "node:path";
import { q, q1, tx } from "../db/pool.js";
import { putFile } from "./storage.js";
import { inspectGlb } from "./glb.js";
import { normalizePhoto } from "./images.js";
import { recalibratePhoto } from "./calibration.js";
import { assetNames, createVariant } from "./variants.js";
import { DEFAULT_LIGHTING, diffStates } from "../../shared/studio/variant.js";
import type { StudioScope } from "./auth.js";
import { autoCutout } from "./images.js";

const SAMPLES = path.resolve("samples");

const CATALOG = [
  {
    code: "PH-SOFA-02",
    file: "assets/sofa_02.glb",
    name: "터프티드 가죽 3인 소파",
    brand: "Poly Haven (CC0)",
    color: "다크 브라운 가죽",
    material: "가죽 · 원목 프레임",
    provenance: "Poly Haven sofa_02 (Kirill Sannikov, CC0) — 데모용 3D 모델. 실제 판매 SKU 아님",
  },
  {
    code: "PH-SOFA-03",
    file: "assets/sofa_03.glb",
    name: "빅토리안 가죽 소파",
    brand: "Poly Haven (CC0)",
    color: "앤티크 브라운",
    material: "가죽 · 조각 원목 프레임",
    provenance: "Poly Haven sofa_03 (Fran Calvente, CC0) — 데모용 3D 모델. 실제 판매 SKU 아님",
  },
];

let catalogDone = false;
export async function ensureCatalog() {
  if (catalogDone) return;
  for (const c of CATALOG) {
    if (await q1(`SELECT 1 FROM studio_assets WHERE workspace_id IS NULL AND model_code=$1`, [c.code])) continue;
    const p = path.join(SAMPLES, c.file);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const info = inspectGlb(buf);
    const dims = { w: Math.round(info.sizeCm.w), d: Math.round(info.sizeCm.d), h: Math.round(info.sizeCm.h) };
    await tx(async (db) => {
      const f = await putFile({ workspaceId: null, kind: "asset_glb", mime: "model/gltf-binary", data: buf, ext: "glb" }, db);
      const a = await q1<any>(
        `INSERT INTO studio_assets(workspace_id, name, brand, model_code, category, color, material, kind, size_options, notes)
         VALUES (NULL,$1,$2,$3,'sofa',$4,$5,'model3d',$6,$7) RETURNING id`,
        [c.name, c.brand, c.code, c.color, c.material, JSON.stringify([{ label: "기본", ...dims }]), c.provenance],
        db,
      );
      const v = await q1<any>(
        `INSERT INTO studio_asset_versions(asset_id, version, glb_file_id, meta, verification) VALUES ($1,1,$2,$3,'verified') RETURNING id`,
        [a.id, f.id, { units: "m", frontAxis: "+Z", pivot: "floor-center", measuredBBoxCm: info.sizeCm, declaredCm: dims, dimensionMismatch: [], textureStatus: info.textures ? "embedded" : "none", provenance: c.provenance, license: "CC0", glbIssues: info.issues }],
        db,
      );
      await q(`UPDATE studio_assets SET current_version_id=$2 WHERE id=$1`, [a.id, v.id], db);
    });
  }
  // 경로 B 예시: 정면 상품 이미지 한 장만 있는 제품 (3D 모델에서 만든 정면 이미지 — 테스트용)
  const front = path.join(SAMPLES, "assets/sofa_03_front.png");
  if (fs.existsSync(front) && !(await q1(`SELECT 1 FROM studio_assets WHERE workspace_id IS NULL AND model_code='PH-SOFA-03-PHOTO'`))) {
    const buf = fs.readFileSync(front);
    const cut = await autoCutout(buf);
    await tx(async (db) => {
      const f = await putFile({ workspaceId: null, kind: "asset_ref", mime: "image/png", data: buf, ext: "png" }, db);
      const cf = cut.png ? await putFile({ workspaceId: null, kind: "asset_cutout", mime: "image/png", data: cut.png, width: cut.width, height: cut.height, ext: "png" }, db) : null;
      const a = await q1<any>(
        `INSERT INTO studio_assets(workspace_id, name, brand, model_code, category, color, material, kind, size_options, notes)
         VALUES (NULL,'빅토리안 소파 (정면 사진만 있음)','예시','PH-SOFA-03-PHOTO','sofa','앤티크 브라운','가죽','photo',$1,$2) RETURNING id`,
        [JSON.stringify([{ label: "기본", w: 273, d: 93, h: 112 }]), "정면 상품 이미지 1장만 있는 제품의 예시(3D 모델에서 만든 정면 이미지). 측면·후면은 근거가 없어 '추가 참조 필요'로 표시됩니다."],
        db,
      );
      const v = await q1<any>(
        `INSERT INTO studio_asset_versions(asset_id, version, ref_photos, meta, verification) VALUES ($1,1,$2,$3,'appearance') RETURNING id`,
        [a.id, JSON.stringify([{ fileId: f.id, cutoutFileId: cf?.id ?? null, azimuthDeg: 0, elevationDeg: 8, label: "정면", cutout: cut.method }]), { provenance: "sofa_03 3D 모델의 정면 렌더(테스트용 상품 이미지)" }],
        db,
      );
      await q(`UPDATE studio_assets SET current_version_id=$2 WHERE id=$1`, [a.id, v.id], db);
    });
  }
  catalogDone = true;
}

export function resetCatalogFlag() {
  catalogDone = false;
}

export async function openSampleProject(s: StudioScope) {
  await ensureCatalog();
  const gt = JSON.parse(fs.readFileSync(path.join(SAMPLES, "room/ground_truth.json"), "utf8"));
  const refPoints = Object.entries<any>(gt.points).map(([id, p]) => ({ id, label: p.label, world: p.world, measured: false }));
  const photos: { buf: Buffer; n: Awaited<ReturnType<typeof normalizePhoto>>; v: any }[] = [];
  for (const v of gt.views) {
    const buf = fs.readFileSync(path.join(SAMPLES, "room", v.file));
    photos.push({ buf, n: await normalizePhoto(buf), v });
  }
  const sofa2 = await q1<any>(`SELECT a.id, a.current_version_id, a.size_options FROM studio_assets a WHERE workspace_id IS NULL AND model_code='PH-SOFA-02'`);
  const sofa3 = await q1<any>(`SELECT a.id, a.current_version_id, a.size_options FROM studio_assets a WHERE workspace_id IS NULL AND model_code='PH-SOFA-03'`);
  return tx(async (db) => {
    const p = await q1<any>(`INSERT INTO studio_projects(workspace_id, name, client_name, is_sample, created_by) VALUES ($1,'샘플 · 작은 방 소파 제안','샘플 고객',true,$2) RETURNING *`, [s.workspaceId, s.userId], db);
    const room = await q1<any>(
      `INSERT INTO studio_rooms(project_id, workspace_id, name, ref_points, scale_measured, scale_note, floor_bounds, lighting) VALUES ($1,$2,'작은 방',$3,false,$4,$5,$6) RETURNING *`,
      [
        p.id,
        s.workspaceId,
        JSON.stringify(refPoints),
        "샘플: 실측값 없음. 문 높이 2.0m 가정으로 촬영 높이 1.40m를 역산한 추정 스케일.",
        JSON.stringify([[-2.15, 0], [1.8, 0], [1.8, 2.81], [-2.15, 2.81]]),
        DEFAULT_LIGHTING,
      ],
      db,
    );
    let i = 0;
    for (const { buf, n, v } of photos) {
      i++;
      const orig = await putFile({ workspaceId: s.workspaceId, kind: "photo_original", mime: "image/jpeg", data: buf, width: n.width, height: n.height, ext: "jpg" }, db);
      const master = await putFile({ workspaceId: s.workspaceId, kind: "photo_master", mime: "image/png", data: n.master, width: n.width, height: n.height, ext: "png" }, db);
      const prev = await putFile({ workspaceId: s.workspaceId, kind: "photo_preview", mime: "image/jpeg", data: n.preview, width: n.previewWidth, height: n.previewHeight, ext: "jpg" }, db);
      // 기준점 클릭 위치: 파노라마 원본에서 육안으로 지정한 특징점을 이 시점에 투영한 값(0.5px 반올림)
      const points = Object.entries<any>(v.points).map(([refId, [u, vv]]) => ({ refId, u: Math.round(u * 2) / 2, v: Math.round(vv * 2) / 2 }));
      const ph = await q1<any>(
        `INSERT INTO studio_photos(room_id, workspace_id, label, sort, original_file_id, master_file_id, preview_file_id, width, height, preview_width, preview_height, exif, calibration, view_adjust)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [room.id, s.workspaceId, `시점 ${i}`, i, orig.id, master.id, prev.id, n.width, n.height, n.previewWidth, n.previewHeight, n.exif, { points, focalMode: "exif" }, { exposure: 0, wb: [1, 1, 1], blurPx: 0.6, grain: null }],
        db,
      );
      await recalibratePhoto(ph.id, db);
    }
    const mk = (a: any, x: number, z: number, rot = 0) => {
      const o = a.size_options[0];
      return { id: `pl-${Math.random().toString(36).slice(2, 8)}`, assetId: a.id, assetVersionId: a.current_version_id, sizeOptionIndex: 0, dims: { w: o.w, d: o.d, h: o.h }, nonStandard: false, position: { x, z }, rotationDeg: rot };
    };
    const A = await createVariant(s, room.id, "A안", { variantId: null, versionId: null, state: { placements: sofa2 ? [mk(sofa2, 0.68, 0.47)] : [], lighting: DEFAULT_LIGHTING }, label: "샘플 시작" }, db);
    await q(`UPDATE studio_variants SET copied_from_variant_id=NULL WHERE id=$1`, [A.variant.id], db);
    await q(`UPDATE studio_variant_versions SET summary='[]'::jsonb WHERE id=$1`, [A.head.id], db);
    if (sofa3) {
      const B = await createVariant(s, room.id, "B안", { variantId: A.variant.id, versionId: A.head.id, state: { placements: [{ ...mk(sofa3, 0.1, 0.52), id: (A.head.state.placements[0]?.id ?? "pl-b") }], lighting: DEFAULT_LIGHTING }, label: "A안 v1" }, db);
      const names = { ...(await assetNames(A.head.state, db)), ...(await assetNames(B.head.state, db)) };
      await q(`UPDATE studio_variant_versions SET summary=$2 WHERE id=$1`, [B.head.id, JSON.stringify(diffStates(A.head.state, B.head.state, names))], db);
    }
    return { projectId: p.id, roomId: room.id };
  });
}
