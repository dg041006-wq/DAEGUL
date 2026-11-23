// 사진별 카메라 보정(서버가 권위값 계산). 방 기준점(월드) + 사진 클릭점(픽셀) → 카메라
import { calibrate, cameraToJSON, focalPxFrom35mm, type CalibPoint, type CalibResult, type Vec3 } from "../../shared/studio/geometry.js";
import { q, q1, type Db, pool } from "../db/pool.js";

export interface RefPoint {
  id: string;
  label: string;
  world: Vec3;
  measured?: boolean;
}
export interface PhotoCalibration {
  points: { refId: string; u: number; v: number; check?: boolean }[];
  focalMode: "auto" | "exif" | "manual";
  focal35?: number | null;
  result?: any;
  suggestedPoints?: { refId: string; u: number; v: number; check?: boolean }[];
  carriedFrom?: string;
}

export function computeCalibration(room: { ref_points: RefPoint[]; scale_measured: boolean }, photo: { width: number; height: number; exif: any; calibration: PhotoCalibration }) {
  const refs = new Map(room.ref_points.map((r) => [r.id, r]));
  const cal = photo.calibration;
  const missingRefs = cal.points.filter((p) => !refs.has(p.refId)).map((p) => p.refId);
  const pts: CalibPoint[] = cal.points.filter((p) => refs.has(p.refId)).map((p) => ({ id: p.refId, world: refs.get(p.refId)!.world, u: p.u, v: p.v, check: !!p.check }));
  let focalPx: number | undefined;
  let focalSource: "exif" | "manual" | undefined;
  if (cal.focalMode === "exif" && photo.exif?.focal35mm) {
    focalPx = focalPxFrom35mm(photo.exif.focal35mm, photo.width, photo.height);
    focalSource = "exif";
  } else if (cal.focalMode === "manual" && cal.focal35) {
    focalPx = focalPxFrom35mm(cal.focal35, photo.width, photo.height);
    focalSource = "manual";
  }
  const r: CalibResult = calibrate(pts, photo.width, photo.height, { focalPx, focalSource, scaleMeasured: room.scale_measured });
  if (cal.focalMode === "exif" && !photo.exif?.focal35mm)
    r.issues.unshift({ code: "focal_fallback", severity: "warning", message: "사진에 EXIF 초점거리가 없어 자동 추정으로 계산했습니다.", need: "35mm 환산 초점거리를 직접 입력하세요." });
  if (cal.suggestedPoints?.length && !cal.points.length)
    r.issues.unshift({ code: "too_few_points", severity: "error", message: `사진이 교체되었습니다. 이전 사진의 기준점 ${cal.suggestedPoints.length}개를 새 사진에서 다시 확인해야 합니다.`, need: "'이전 기준점 불러오기'로 위치를 옮긴 뒤 각 점을 새 사진에 맞게 확인하세요." });
  if (missingRefs.length) r.issues.push({ code: "too_few_points", severity: "warning", message: `삭제된 기준점(${missingRefs.join(", ")}) 클릭은 무시했습니다.` });
  // 초점 미상 + 불확실 → EXIF가 있으면 그 값을 쓰라고 안내
  if (cal.focalMode === "auto" && photo.exif?.focal35mm && r.issues.some((i) => i.code === "ill_conditioned"))
    r.issues.push({ code: "focal_fallback", severity: "info", message: `이 사진에는 EXIF 35mm 환산 초점거리 ${photo.exif.focal35mm}mm가 있습니다. '초점: EXIF 사용'으로 바꾸면 위치가 확정됩니다.` });
  const result = {
    ok: r.ok,
    status: r.status,
    camera: r.camera ? cameraToJSON(r.camera) : null,
    rmsPx: r.rmsPx ?? null,
    rmsNormPx: r.rmsNormPx ?? null,
    perPoint: r.perPoint ?? [],
    checkMedianNormPx: r.checkMedianNormPx ?? null,
    checkMaxNormPx: r.checkMaxNormPx ?? null,
    cameraHeightM: r.cameraHeightM ?? null,
    hfovDeg: r.hfovDeg ?? null,
    focalSource: r.focalSource ?? null,
    sigmaFocalPct: r.sigmaFocalPct ?? null,
    sigmaCenterM: r.sigmaCenterM ?? null,
    dof: r.dof ?? null,
    issues: r.issues,
    computedAt: new Date().toISOString(),
  };
  return result;
}

export async function recalibratePhoto(photoId: string, db: Db = pool) {
  const ph = await q1<any>(`SELECT p.*, r.ref_points, r.scale_measured FROM studio_photos p JOIN studio_rooms r ON r.id=p.room_id WHERE p.id=$1`, [photoId], db);
  if (!ph) return null;
  const result = computeCalibration({ ref_points: ph.ref_points, scale_measured: ph.scale_measured }, ph);
  const calibration = { ...ph.calibration, result };
  await q(`UPDATE studio_photos SET calibration=$2, calib_status=$3, calib_rev=calib_rev+1 WHERE id=$1`, [photoId, calibration, result.status], db);
  return result;
}

export async function recalibrateRoom(roomId: string, db: Db = pool) {
  const photos = await q<{ id: string }>(`SELECT id FROM studio_photos WHERE room_id=$1 AND deleted_at IS NULL AND replaced_at IS NULL`, [roomId], db);
  for (const p of photos) await recalibratePhoto(p.id, db);
}
