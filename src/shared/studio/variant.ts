// 안(variant) 상태 · 조명 · 변경 요약 (서버·브라우저 공용)
import type { Placement } from "./geometry.js";

export interface Lighting {
  sunAzimuthDeg: number; // 월드 기준, 0 = +Z 방향에서 비춤
  sunElevationDeg: number;
  sunIntensity: number; // 0..5
  colorTempK: number; // 2700..7500
  softness: number; // 0..1 (그림자 가장자리 부드러움)
  ambient: number; // 0..3 (환경광)
  shadowStrength: number; // 0..1
  contactShadow: number; // 0..1 (접지 그림자)
}

export const DEFAULT_LIGHTING: Lighting = {
  sunAzimuthDeg: 90,
  sunElevationDeg: 40,
  sunIntensity: 1.8,
  colorTempK: 5600,
  softness: 0.7,
  ambient: 1.0,
  shadowStrength: 0.45,
  contactShadow: 0.7,
};

export interface ViewAdjust {
  exposure: number; // EV, 렌더된 가구에만 적용
  wb: [number, number, number]; // 채널 배율
  blurPx: number; // 원본 초점 심도에 맞춘 흐림(마스터 px)
  grain: number | null; // null = 원본에서 자동 추정
}
export const DEFAULT_VIEW_ADJUST: ViewAdjust = { exposure: 0, wb: [1, 1, 1], blurPx: 0.6, grain: null };

export interface VariantState {
  placements: Placement[];
  lighting: Lighting;
}

export interface ChangeItem {
  kind: "added" | "removed" | "product" | "moved" | "rotated" | "resized" | "lighting";
  placementId?: string;
  text: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function diffStates(prev: VariantState | null, next: VariantState, names: Record<string, string> = {}): ChangeItem[] {
  const out: ChangeItem[] = [];
  const nm = (p: Placement) => names[p.assetVersionId] ?? names[p.assetId] ?? "가구";
  const before = new Map((prev?.placements ?? []).map((p) => [p.id, p]));
  const after = new Map(next.placements.map((p) => [p.id, p]));
  for (const [id, p] of after) {
    const o = before.get(id);
    if (!o) {
      out.push({ kind: "added", placementId: id, text: `${nm(p)} 추가 (${p.dims.w}×${p.dims.d}×${p.dims.h}cm)` });
      continue;
    }
    if (o.assetVersionId !== p.assetVersionId) out.push({ kind: "product", placementId: id, text: `제품 변경: ${nm(o)} → ${nm(p)}` });
    const dx = (p.position.x - o.position.x) * 100, dz = (p.position.z - o.position.z) * 100;
    const dist = Math.hypot(dx, dz);
    if (dist >= 0.5) out.push({ kind: "moved", placementId: id, text: `${nm(p)} 이동 ${r1(dist)}cm (X ${dx >= 0 ? "+" : ""}${r1(dx)}, Z ${dz >= 0 ? "+" : ""}${r1(dz)})` });
    let dr = ((p.rotationDeg - o.rotationDeg + 540) % 360) - 180;
    if (Math.abs(dr) >= 0.5) out.push({ kind: "rotated", placementId: id, text: `${nm(p)} 회전 ${dr > 0 ? "+" : ""}${r1(dr)}° (→ ${r1(p.rotationDeg)}°)` });
    if (o.dims.w !== p.dims.w || o.dims.d !== p.dims.d || o.dims.h !== p.dims.h || o.nonStandard !== p.nonStandard)
      out.push({ kind: "resized", placementId: id, text: `${nm(p)} 치수 ${o.dims.w}×${o.dims.d}×${o.dims.h} → ${p.dims.w}×${p.dims.d}×${p.dims.h}cm${p.nonStandard ? " (비규격 크기)" : ""}` });
  }
  for (const [id, o] of before) if (!after.has(id)) out.push({ kind: "removed", placementId: id, text: `${nm(o)} 삭제` });
  if (prev) {
    const keys = Object.keys(next.lighting) as (keyof Lighting)[];
    const changed = keys.filter((k) => Math.abs((prev.lighting?.[k] ?? 0) - next.lighting[k]) > 1e-6);
    if (changed.length) out.push({ kind: "lighting", text: `조명 조정 (${changed.length}개 항목)` });
  }
  return out;
}

export const CALIB_STATUS_LABEL: Record<string, string> = {
  uncalibrated: "미보정",
  estimated: "추정",
  measured: "실측 기준 확인",
  failed: "보정 실패",
};

export const EVIDENCE_LABEL: Record<string, string> = {
  verified_model: "제품 3D 모델 렌더",
  unverified_model: "3D 모델(치수·재질 미확인)",
  appearance_estimate: "외관 추정 · 검수 필요",
  needs_reference: "추가 참조 필요",
  concept: "콘셉트 시안",
};

/** 공개 범위 상태 (UI·다운로드·보고서 공통) */
export const RELEASE_LABEL: Record<string, string> = {
  internal_test: "내부 테스트",
  needs_reference: "추가 참조 필요",
  manual_precision: "수동 정밀 합성 필요",
};
