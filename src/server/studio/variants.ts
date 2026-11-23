// 안·버전 관리: 머리 버전(draft)만 수정 가능. 잠긴 버전(저장·공유·승인)은 절대 바뀌지 않는다.
import { z } from "zod";
import { q, q1, type Db } from "../db/pool.js";
import { diffStates, DEFAULT_LIGHTING, type VariantState } from "../../shared/studio/variant.js";
import { HttpError, type StudioScope } from "./auth.js";

export const placementSchema = z.object({
  id: z.string().min(1).max(64),
  assetId: z.string().uuid(),
  assetVersionId: z.string().uuid(),
  sizeOptionIndex: z.number().int().min(0).nullable(),
  dims: z.object({ w: z.number().min(5).max(1000), d: z.number().min(5).max(1000), h: z.number().min(5).max(500) }),
  nonStandard: z.boolean(),
  position: z.object({ x: z.number().min(-100).max(100), z: z.number().min(-100).max(100) }),
  rotationDeg: z.number().min(-720).max(720),
});
export const lightingSchema = z.object({
  sunAzimuthDeg: z.number().min(-360).max(720),
  sunElevationDeg: z.number().min(1).max(90),
  sunIntensity: z.number().min(0).max(10),
  colorTempK: z.number().min(1800).max(12000),
  softness: z.number().min(0).max(1),
  ambient: z.number().min(0).max(5),
  shadowStrength: z.number().min(0).max(1),
  contactShadow: z.number().min(0).max(1),
});
export const stateSchema = z.object({ placements: z.array(placementSchema).max(30), lighting: lightingSchema });

/** 배치의 에셋 버전·치수 규칙을 서버에서 강제 (다른 SKU에 실측값을 덮어쓰지 않음) */
export async function validateState(s: StudioScope, state: VariantState, db: Db) {
  for (const p of state.placements) {
    const v = await q1<any>(
      `SELECT v.id, v.asset_id, a.size_options, a.kind FROM studio_asset_versions v JOIN studio_assets a ON a.id=v.asset_id
       WHERE v.id=$1 AND v.asset_id=$2 AND (a.workspace_id=$3 OR a.workspace_id IS NULL)`,
      [p.assetVersionId, p.assetId, s.workspaceId],
      db,
    );
    if (!v) throw new HttpError(400, "배치에 사용할 수 없는 가구 버전입니다.");
    const opts: { w: number; d: number; h: number }[] = v.size_options ?? [];
    const matches = p.sizeOptionIndex !== null && opts[p.sizeOptionIndex] && opts[p.sizeOptionIndex].w === p.dims.w && opts[p.sizeOptionIndex].d === p.dims.d && opts[p.sizeOptionIndex].h === p.dims.h;
    // 옵션과 다르면 반드시 비규격으로 표시
    p.nonStandard = !matches;
    if (!matches) p.sizeOptionIndex = null;
  }
}

export async function assetNames(state: VariantState, db: Db) {
  const ids = [...new Set(state.placements.map((p) => p.assetVersionId))];
  if (!ids.length) return {};
  const rows = await q<any>(`SELECT v.id, a.name, v.version FROM studio_asset_versions v JOIN studio_assets a ON a.id=v.asset_id WHERE v.id = ANY($1)`, [ids], db);
  return Object.fromEntries(rows.map((r) => [r.id, `${r.name}${r.version > 1 ? ` v${r.version}` : ""}`]));
}

export async function createVariant(s: StudioScope, roomId: string, name: string, copyFrom: any | null, db: Db) {
  const v = await q1<any>(`INSERT INTO studio_variants(room_id, workspace_id, name, copied_from_variant_id) VALUES ($1,$2,$3,$4) RETURNING *`, [roomId, s.workspaceId, name, copyFrom?.variantId ?? null], db);
  const state: VariantState = copyFrom?.state ?? { placements: [], lighting: { ...DEFAULT_LIGHTING } };
  const summary = copyFrom ? [{ kind: "added", text: `${copyFrom.label} 복제` }] : [];
  const vv = await q1<any>(
    `INSERT INTO studio_variant_versions(variant_id, workspace_id, version, parent_version_id, state, base_state, summary, created_by) VALUES ($1,$2,1,$3,$4,$4,$5,$6) RETURNING *`,
    [v.id, s.workspaceId, copyFrom?.versionId ?? null, state, JSON.stringify(summary), s.userId],
    db,
  );
  await q(`UPDATE studio_variants SET head_version_id=$2 WHERE id=$1`, [v.id, vv.id], db);
  return { variant: { ...v, head_version_id: vv.id }, head: vv };
}

/** 머리 버전 저장. 잠겨 있으면 새 버전을 만든다. rev로 동시 편집 충돌 감지 */
export async function saveDraft(s: StudioScope, variant: any, state: VariantState, rev: number | undefined, db: Db) {
  await validateState(s, state, db);
  const head = await q1<any>(`SELECT * FROM studio_variant_versions WHERE id=$1 FOR UPDATE`, [variant.head_version_id], db);
  const names = await assetNames(state, db);
  if (!head.locked_at) {
    if (rev !== undefined && rev !== head.rev) throw new HttpError(409, "다른 곳에서 먼저 수정되었습니다. 새로고침 후 다시 시도하세요.", "conflict");
    const summary = diffStates(head.base_state ?? null, state, names);
    return q1<any>(`UPDATE studio_variant_versions SET state=$2, summary=$3, rev=rev+1, updated_at=now() WHERE id=$1 RETURNING *`, [head.id, state, JSON.stringify(summary)], db);
  }
  const summary = diffStates(head.state, state, names);
  const nv = await q1<any>(
    `INSERT INTO studio_variant_versions(variant_id, workspace_id, version, parent_version_id, state, base_state, summary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [variant.id, s.workspaceId, head.version + 1, head.id, state, head.state, JSON.stringify(summary), s.userId],
    db,
  );
  await q(`UPDATE studio_variants SET head_version_id=$2 WHERE id=$1`, [variant.id, nv.id], db);
  return nv;
}

export async function lockVersion(versionId: string, reason: "saved" | "shared" | "approved", db: Db) {
  await q(
    `UPDATE studio_variant_versions SET locked_at=COALESCE(locked_at, now()),
       locked_reason = CASE WHEN locked_reason='approved' THEN 'approved' WHEN $2='approved' THEN 'approved' WHEN locked_reason='shared' THEN 'shared' ELSE $2 END,
       approved_at = CASE WHEN $2='approved' THEN COALESCE(approved_at, now()) ELSE approved_at END
     WHERE id=$1`,
    [versionId, reason],
    db,
  );
}
