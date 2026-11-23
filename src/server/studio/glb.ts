// GLB(glTF 2.0 바이너리) 검사: 형식 확인과 실제 형상 경계 상자(노드 변환 포함) 측정.
// 렌더 전 서버에서 선언 치수와 실제 모델 치수가 맞는지 비교하기 위해 사용.
import { HttpError } from "./auth.js";

type M4 = number[]; // column-major (glTF)

function mul(a: M4, b: M4): M4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k];
  return r;
}
function trs(n: any): M4 {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

export interface GlbInfo {
  bboxM: { min: [number, number, number]; max: [number, number, number] };
  sizeCm: { w: number; d: number; h: number }; // X 폭, Z 깊이, Y 높이
  meshes: number;
  textures: number;
  materials: number;
  generator?: string;
  floorOffsetCm: number; // 최저점 y (0이면 바닥 기준점이 맞음)
  centerOffsetCm: { x: number; z: number };
  issues: string[];
}

export function inspectGlb(buf: Buffer): GlbInfo {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new HttpError(415, "GLB(glTF 바이너리) 파일이 아닙니다.", "not_glb");
  if (buf.readUInt32LE(4) !== 2) throw new HttpError(415, "glTF 2.0만 지원합니다.", "not_glb");
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new HttpError(415, "GLB JSON 청크가 없습니다.", "not_glb");
  let gltf: any;
  try {
    gltf = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  } catch {
    throw new HttpError(415, "GLB JSON을 읽을 수 없습니다.", "not_glb");
  }
  const issues: string[] = [];
  if (gltf.extensionsRequired?.length) issues.push(`필수 확장 사용: ${gltf.extensionsRequired.join(", ")} (렌더러 지원 확인 필요)`);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const visit = (ni: number, parent: M4) => {
    const n = gltf.nodes[ni];
    const m = mul(parent, trs(n));
    if (n.mesh !== undefined) {
      for (const prim of gltf.meshes[n.mesh].primitives ?? []) {
        const acc = gltf.accessors?.[prim.attributes?.POSITION];
        if (!acc?.min || !acc?.max) {
          issues.push("POSITION 경계값(min/max)이 없는 메시가 있습니다.");
          continue;
        }
        for (let c = 0; c < 8; c++) {
          const p = [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]];
          for (let r = 0; r < 3; r++) {
            const v = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
            min[r] = Math.min(min[r], v);
            max[r] = Math.max(max[r], v);
          }
        }
      }
    }
    for (const ch of n.children ?? []) visit(ch, m);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const ni of scene?.nodes ?? []) visit(ni, I);
  if (!Number.isFinite(min[0])) throw new HttpError(422, "모델에서 형상을 찾지 못했습니다.", "empty_model");
  const sizeCm = { w: +((max[0] - min[0]) * 100).toFixed(1), d: +((max[2] - min[2]) * 100).toFixed(1), h: +((max[1] - min[1]) * 100).toFixed(1) };
  const floorOffsetCm = +(min[1] * 100).toFixed(1);
  if (Math.abs(floorOffsetCm) > 1) issues.push(`모델 최저점이 바닥(y=0)에서 ${floorOffsetCm}cm 떨어져 있습니다. 렌더 시 바닥에 맞춥니다.`);
  if (Math.max(sizeCm.w, sizeCm.d, sizeCm.h) > 1000) issues.push("모델 크기가 10m를 넘습니다. 단위(mm/cm)를 확인하세요.");
  if (Math.max(sizeCm.w, sizeCm.d, sizeCm.h) < 5) issues.push("모델 크기가 5cm 미만입니다. 단위를 확인하세요.");
  return {
    bboxM: { min: min as any, max: max as any },
    sizeCm,
    meshes: gltf.meshes?.length ?? 0,
    textures: gltf.textures?.length ?? 0,
    materials: gltf.materials?.length ?? 0,
    generator: gltf.asset?.generator,
    floorOffsetCm,
    centerOffsetCm: { x: +(((min[0] + max[0]) / 2) * 100).toFixed(1), z: +(((min[2] + max[2]) / 2) * 100).toFixed(1) },
    issues,
  };
}

/** 선언 치수 대비 측정 치수 차이(cm) */
export function dimsMismatch(declared: { w: number; d: number; h: number }, measured: { w: number; d: number; h: number }, tolCm = 2) {
  const out: string[] = [];
  for (const k of ["w", "d", "h"] as const) {
    if (Math.abs(declared[k] - measured[k]) > tolCm) out.push(`${{ w: "폭", d: "깊이", h: "높이" }[k]} 선언 ${declared[k]}cm / 모델 ${measured[k]}cm`);
  }
  return out;
}
