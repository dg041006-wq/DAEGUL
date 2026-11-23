// STAYSCENE Styling Studio — 사진 좌표·카메라 보정 수학 (서버·브라우저 공용, 의존성 없음)
//
// 좌표계
//  - 월드: 방마다 미터 단위, Y 위, 바닥 y=0. 화면 표시는 cm.
//  - 카메라(three.js 규약): x 오른쪽, y 위, -z 시선 방향.
//  - Camera.R = world_from_cam (열 = 카메라 축의 월드 방향), C = 카메라 중심(월드).
//  - 픽셀: 정규화(EXIF 방향 적용)된 마스터 이미지 기준, 좌상단 원점, u 오른쪽, v 아래.
//  - 렌즈 왜곡: 현재 핀홀 모델만 지원(k1=0). 광각 가장자리 잔차가 크면 이슈로 보고한다.

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

export interface Camera {
  width: number;
  height: number;
  f: number; // px
  cx: number;
  cy: number;
  R: Mat3; // world_from_cam
  C: Vec3;
}

// ───────── 기본 선형대수 ─────────
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / (norm(a) || 1));

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export function matTVec(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}
export function matMul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
export function fromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}
export const column = (m: Mat3, j: number): Vec3 => [m[j], m[3 + j], m[6 + j]];

export function rotY(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotX(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rodrigues(w: Vec3): Mat3 {
  const th = norm(w);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(w, 1 / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
export function rotvec(R: Mat3): Vec3 {
  const tr = R[0] + R[4] + R[8];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // 180° 근처: 대각 성분에서 축 추정
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), z = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    const ax: Vec3 = [x, R[1] >= 0 ? y : -y, R[2] >= 0 ? z : -z];
    return scale(normalize(ax), th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

/** 대칭 행렬 고유분해 (Jacobi). 반환: 고유값 오름차순, 고유벡터(열) */
export function symEig(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0) as number));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const idx = A.map((_, i) => i).sort((a, b) => A[a][a] - A[b][b]);
  return { values: idx.map((i) => A[i][i]), vectors: V.map((row) => idx.map((i) => row[i])) };
}

/** 가장 가까운 회전 행렬 (극분해: R = M (MᵀM)^-1/2) */
export function orthonormalize(M: Mat3): Mat3 {
  const MtM = matMul(transpose(M), M);
  const e = symEig([[MtM[0], MtM[1], MtM[2]], [MtM[3], MtM[4], MtM[5]], [MtM[6], MtM[7], MtM[8]]]);
  const inv = new Array(9).fill(0) as Mat3;
  for (let k = 0; k < 3; k++) {
    const l = 1 / Math.sqrt(Math.max(e.values[k], 1e-18));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) inv[i * 3 + j] += l * e.vectors[i][k] * e.vectors[j][k];
  }
  const R = matMul(M, inv);
  return R;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / M[i][i]);
}

// ───────── 투영 ─────────
export function project(cam: Camera, p: Vec3): { u: number; v: number; depth: number } {
  const pc = matTVec(cam.R, sub(p, cam.C));
  const depth = -pc[2];
  return { u: cam.cx + (cam.f * pc[0]) / depth, v: cam.cy - (cam.f * pc[1]) / depth, depth };
}

export function pixelRay(cam: Camera, u: number, v: number): { origin: Vec3; dir: Vec3 } {
  const dc: Vec3 = [(u - cam.cx) / cam.f, -(v - cam.cy) / cam.f, -1];
  return { origin: cam.C, dir: normalize(matVec(cam.R, dc)) };
}

/** 화면 포인터 → 바닥(y=h) 교점. 지평선 위면 null */
export function floorHit(cam: Camera, u: number, v: number, h = 0): Vec3 | null {
  const { origin, dir } = pixelRay(cam, u, v);
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (h - origin[1]) / dir[1];
  if (t <= 0) return null;
  return add(origin, scale(dir, t));
}

export function hfovDeg(cam: Pick<Camera, "f" | "width">) {
  return (2 * Math.atan(cam.width / 2 / cam.f) * 180) / Math.PI;
}

/** 35mm 환산 초점거리 → px (36x24mm 기준, 긴 변 대응) */
export function focalPxFrom35mm(f35: number, width: number, height: number) {
  return (f35 / 36) * Math.max(width, height);
}

// ───────── 호모그래피 ─────────
type P2 = [number, number];

function normalizer(pts: P2[]) {
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / pts.length || 1;
  const s = Math.SQRT2 / d;
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1] as Mat3, apply: (p: P2): P2 => [s * (p[0] - mx), s * (p[1] - my)] };
}

/** 정규화 DLT. src(평면 좌표) → dst(픽셀). 3x3 row-major */
export function homography(src: P2[], dst: P2[]): Mat3 | null {
  if (src.length < 4) return null;
  const ns = normalizer(src), nd = normalizer(dst);
  const AtA = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (let i = 0; i < src.length; i++) {
    const [x, y] = ns.apply(src[i]);
    const [u, v] = nd.apply(dst[i]);
    const rows = [
      [-x, -y, -1, 0, 0, 0, u * x, u * y, u],
      [0, 0, 0, -x, -y, -1, v * x, v * y, v],
    ];
    for (const r of rows) for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) AtA[a][b] += r[a] * r[b];
  }
  const e = symEig(AtA);
  const h = e.vectors.map((row) => row[0]) as unknown as Mat3;
  // H = Td^-1 Hn Ts
  const Tdi = invert3(nd.T)!;
  const H = matMul(matMul(Tdi, h), ns.T);
  const s = H[8] !== 0 ? H[8] : 1;
  return H.map((x) => x / s) as Mat3;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** 바닥 호모그래피(월드 X,Z → 픽셀)에서 초점거리 추정 (주점 = 이미지 중심, 정사각 픽셀 가정) */
export function focalFromFloorHomography(H: Mat3, cx: number, cy: number): number | null {
  const h1: Vec3 = [H[0] - cx * H[6], H[3] - cy * H[6], H[6]];
  const h2: Vec3 = [H[1] - cx * H[7], H[4] - cy * H[7], H[7]];
  const a1 = h1[0] * h2[0] + h1[1] * h2[1], b1 = h1[2] * h2[2];
  const a2 = h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2, b2 = h1[2] ** 2 - h2[2] ** 2;
  const den = a1 * a1 + a2 * a2;
  if (den < 1e-30) return null;
  const w = -(a1 * b1 + a2 * b2) / den;
  if (!(w > 0)) return null;
  return 1 / Math.sqrt(w);
}

const D: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // three.js 카메라 ↔ CV 카메라

/** 바닥 호모그래피 + 초점 → 카메라 자세 */
export function poseFromFloorHomography(H: Mat3, f: number, width: number, height: number): Camera | null {
  const cx = width / 2, cy = height / 2;
  const Ki: Mat3 = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const B = matMul(Ki, H);
  let r1 = column(B, 0), r3 = column(B, 1), t = column(B, 2);
  const lam = 2 / (norm(r1) + norm(r3));
  for (const sign of [1, -1]) {
    const a = scale(r1, lam * sign), c = scale(r3, lam * sign), tt = scale(t, lam * sign);
    if (tt[2] <= 0) continue; // 월드 원점이 카메라 앞
    const b = cross(c, a);
    const Rcv = orthonormalize(fromColumns(a, b, c)); // world → cv cam
    const R = matMul(transpose(Rcv), D); // world_from_cam (three)
    const C = scale(matTVec(Rcv, tt), -1);
    if (C[1] <= 0) continue;
    return { width, height, f, cx, cy, R, C };
  }
  return null;
}

// ───────── 보정 ─────────
export interface CalibPoint {
  id: string;
  world: Vec3;
  u: number;
  v: number;
  check?: boolean; // 검증점: 적합에 쓰지 않고 독립 오차만 계산
}

export type CalibIssueCode =
  | "too_few_points"
  | "collinear_points"
  | "small_image_spread"
  | "no_floor_points"
  | "focal_implausible"
  | "focal_fallback"
  | "camera_height_implausible"
  | "points_behind_camera"
  | "high_residual"
  | "high_check_error"
  | "no_redundancy"
  | "no_check_points"
  | "scale_estimated"
  | "lens_unverified"
  | "ill_conditioned"
  | "solve_failed";

export interface CalibIssue {
  code: CalibIssueCode;
  severity: "error" | "warning" | "info";
  message: string;
  need?: string; // 사용자가 무엇을 추가해야 하는지
}

export type CalibStatus = "uncalibrated" | "estimated" | "measured" | "failed";

export interface CalibResult {
  ok: boolean;
  status: CalibStatus;
  camera?: Camera;
  rmsPx?: number;
  rmsNormPx?: number; // 긴 변 2000px 기준
  perPoint?: { id: string; errPx: number; check: boolean }[];
  checkMedianNormPx?: number | null;
  checkMaxNormPx?: number | null;
  cameraHeightM?: number;
  hfovDeg?: number;
  focalSource?: "estimated" | "exif" | "manual" | "default";
  issues: CalibIssue[];
  dof?: number;
  sigmaFocalPct?: number | null; // 클릭 오차 1.5px 가정 시 초점 표준편차(%)
  sigmaCenterM?: number | null; // 카메라 중심 표준편차(m)
}

export interface CalibOptions {
  focalPx?: number; // EXIF/수동 입력값. 주어지면 고정
  focalSource?: "exif" | "manual";
  scaleMeasured?: boolean; // 기준점 좌표가 실측인지
}

function residuals(cam: Camera, pts: CalibPoint[]): number[] {
  const r: number[] = [];
  for (const p of pts) {
    const pr = project(cam, p.world);
    if (pr.depth <= 1e-6) {
      r.push(1e4, 1e4);
      continue;
    }
    r.push(pr.u - p.u, pr.v - p.v);
  }
  return r;
}

function camFromParams(x: number[], base: Camera, fixedF: boolean): Camera {
  return { ...base, R: rodrigues([x[0], x[1], x[2]]), C: [x[3], x[4], x[5]], f: fixedF ? base.f : x[6] };
}

/** Levenberg–Marquardt: 회전벡터(3) + 중심(3) [+ 초점(1)] */
export function refineCamera(init: Camera, pts: CalibPoint[], fixedF: boolean, iters = 200): Camera {
  let x = [...rotvec(init.R), ...init.C, ...(fixedF ? [] : [init.f])];
  const n = x.length;
  let cam = camFromParams(x, init, fixedF);
  let r = residuals(cam, pts);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J: number[][] = [];
    for (let j = 0; j < n; j++) {
      const h = j < 3 ? 1e-6 : j < 6 ? 1e-6 : 1e-3;
      const xp = x.slice();
      xp[j] += h;
      const rp = residuals(camFromParams(xp, init, fixedF), pts);
      J.push(rp.map((v, i) => (v - r[i]) / h));
    }
    const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
    const Jtr = Array.from({ length: n }, (_, a) => J[a].reduce((s, v, i) => s + v * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const dx = solveLinear(A, Jtr.map((v) => -v));
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + dx[i]);
      if (!fixedF && xn[6] <= 1) {
        lambda *= 10;
        continue;
      }
      const cn = camFromParams(xn, init, fixedF);
      const rn = residuals(cn, pts);
      const costn = rn.reduce((s, v) => s + v * v, 0);
      if (costn < cost) {
        const rel = (cost - costn) / (cost + 1e-30);
        x = xn;
        cam = cn;
        r = rn;
        cost = costn;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (rel < 1e-12) it = iters;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return cam;
}

function lookAtCamera(C: Vec3, target: Vec3, f: number, width: number, height: number): Camera {
  const back = normalize(sub(C, target)); // +z 카메라 축 = 시선 반대
  let right = cross([0, 1, 0], back);
  if (norm(right) < 1e-6) right = [1, 0, 0];
  right = normalize(right);
  const up = cross(back, right);
  return { width, height, f, cx: width / 2, cy: height / 2, R: fromColumns(right, up, back), C };
}

function spreadRatio(pts: P2[], width: number, height: number) {
  // 볼록 껍질 면적 / 이미지 면적
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return 0;
  const crossZ = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [], upper: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.slice().reverse()) {
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2 / (width * height);
}

/** 월드 점들의 퍼짐: 공선(rank<2) 여부 */
function worldRank(pts: Vec3[]) {
  if (pts.length < 2) return 0;
  const c = scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / pts.length);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += d[i] * d[j];
  }
  const e = symEig(M).values.map((v) => Math.sqrt(Math.max(0, v / pts.length)));
  const big = e[2];
  if (big < 1e-6) return 0;
  return e.filter((v) => v > 0.02 * big && v > 0.01).length; // 1cm 미만 퍼짐은 무시
}

/** 클릭 오차(σ px)를 가정한 매개변수 공분산 → 초점·중심 불확실성 */
export function poseUncertainty(cam: Camera, pts: CalibPoint[], fixedF: boolean, sigmaPx = 1.5) {
  const x = [...rotvec(cam.R), ...cam.C, ...(fixedF ? [] : [cam.f])];
  const n = x.length;
  const r0 = residuals(cam, pts);
  const J: number[][] = [];
  for (let j = 0; j < n; j++) {
    const h = j < 6 ? 1e-6 : 1e-3;
    const xp = x.slice();
    xp[j] += h;
    const rp = residuals(camFromParams(xp, cam, fixedF), pts);
    J.push(rp.map((v, i) => (v - r0[i]) / h));
  }
  const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)));
  const e = symEig(JtJ);
  if (e.values[0] <= 1e-12 * Math.max(1, e.values[n - 1])) return { sigmaFocalPct: Infinity, sigmaCenterM: Infinity };
  const cov = (a: number, b: number) => e.values.reduce((s, l, k) => s + (e.vectors[a][k] * e.vectors[b][k]) / l, 0) * sigmaPx * sigmaPx;
  const sC = Math.sqrt(Math.max(0, cov(3, 3) + cov(4, 4) + cov(5, 5)));
  const sF = fixedF ? 0 : (Math.sqrt(Math.max(0, cov(6, 6))) / cam.f) * 100;
  return { sigmaFocalPct: sF, sigmaCenterM: sC };
}

const FLOOR_EPS = 0.005;

export function calibrate(pointsIn: CalibPoint[], width: number, height: number, opts: CalibOptions = {}): CalibResult {
  const issues: CalibIssue[] = [];
  const fitPts = pointsIn.filter((p) => !p.check);
  const checkPts = pointsIn.filter((p) => p.check);
  const fixedF = !!opts.focalPx;
  const minPts = fixedF ? 3 : 4;
  const norm2000 = 2000 / Math.max(width, height);

  if (fitPts.length < minPts) {
    issues.push({
      code: "too_few_points",
      severity: "error",
      message: `적합용 기준점이 ${fitPts.length}개입니다. ${fixedF ? "초점거리를 알 때 최소 3개" : "최소 4개"}가 필요합니다.`,
      need: fixedF ? `이 사진에서 보이는 기준점을 ${minPts - fitPts.length}개 더 지정하세요.` : `기준점을 ${minPts - fitPts.length}개 더 지정하거나, 카메라 초점거리(EXIF 또는 35mm 환산값)를 입력하세요.`,
    });
    return { ok: false, status: fitPts.length === 0 ? "uncalibrated" : "failed", issues };
  }
  const rank = worldRank(fitPts.map((p) => p.world));
  if (rank < 2) {
    issues.push({ code: "collinear_points", severity: "error", message: "기준점이 한 줄 위에 있어 공간을 정할 수 없습니다.", need: "같은 선 위에 있지 않은 점(예: 반대쪽 벽 모서리, 바닥 안쪽 점)을 추가하세요." });
    return { ok: false, status: "failed", issues };
  }
  const spread = spreadRatio(fitPts.map((p) => [p.u, p.v]), width, height);
  if (spread < 0.01) {
    issues.push({ code: "small_image_spread", severity: "error", message: "기준점이 사진의 아주 작은 영역에 몰려 있습니다.", need: "사진의 좌우·앞뒤로 넓게 퍼진 기준점을 지정하세요." });
    return { ok: false, status: "failed", issues };
  } else if (spread < 0.04) {
    issues.push({ code: "small_image_spread", severity: "warning", message: "기준점이 좁은 영역에 몰려 있어 영역 밖 배치 정확도가 낮을 수 있습니다.", need: "가구를 놓을 범위를 감싸도록 기준점을 넓게 지정하세요." });
  }

  const floor = fitPts.filter((p) => Math.abs(p.world[1]) < FLOOR_EPS);
  const cx = width / 2, cy = height / 2;
  let init: Camera | null = null;
  let focalSource: CalibResult["focalSource"] = fixedF ? opts.focalSource ?? "manual" : "estimated";
  const defaultF = width / 2 / Math.tan((65 * Math.PI) / 360);

  if (floor.length >= 4 && worldRank(floor.map((p) => p.world)) >= 2) {
    const H = homography(floor.map((p) => [p.world[0], p.world[2]]), floor.map((p) => [p.u, p.v]));
    if (H) {
      let f = fixedF ? opts.focalPx! : focalFromFloorHomography(H, cx, cy);
      if (!fixedF && (!f || hfovDeg({ f, width }) < 15 || hfovDeg({ f, width }) > 140)) {
        f = defaultF;
        focalSource = "default";
      }
      init = poseFromFloorHomography(H, f!, width, height);
    }
  }
  const startF = fixedF ? opts.focalPx! : init?.f ?? defaultF;
  // 다중 시작 LM (바닥점 4개 미만 또는 호모그래피 실패 대비)
  const candidates: Camera[] = [];
  if (init) candidates.push(init);
  {
    const cen = scale(fitPts.reduce((s, p) => add(s, p.world), [0, 0, 0] as Vec3), 1 / fitPts.length);
    for (const dist of [2, 3.5, 6])
      for (let a = 0; a < 360; a += 45) {
        const C: Vec3 = [cen[0] + dist * Math.sin((a * Math.PI) / 180), 1.4, cen[2] + dist * Math.cos((a * Math.PI) / 180)];
        candidates.push(lookAtCamera(C, cen, startF, width, height));
      }
  }
  let best: { cam: Camera; cost: number } | null = null;
  // 자유 초점은 과적합 위험: 고정 초점으로 먼저 자세를 잡고 마지막에 초점을 풀어준다
  for (const c0 of candidates) {
    let c = refineCamera(c0, fitPts, true, 60);
    if (!fixedF && fitPts.length >= 4) c = refineCamera(c, fitPts, false, 200);
    const r = residuals(c, fitPts);
    const cost = r.reduce((s, v) => s + v * v, 0);
    const inFront = fitPts.every((p) => project(c, p.world).depth > 0);
    if (!inFront) continue;
    if (!best || cost < best.cost) best = { cam: c, cost };
    if (c0 === init && cost / fitPts.length < 1) break; // 호모그래피 초기값이 충분히 좋음
  }
  if (!best) {
    issues.push({ code: "solve_failed", severity: "error", message: "카메라 위치를 풀지 못했습니다.", need: "기준점 위치(사진상 클릭 위치와 실측 좌표)가 서로 맞는지 확인하세요." });
    return { ok: false, status: "failed", issues };
  }
  const cam = best.cam;
  const perPoint = pointsIn.map((p) => {
    const pr = project(cam, p.world);
    return { id: p.id, errPx: pr.depth > 0 ? Math.hypot(pr.u - p.u, pr.v - p.v) : Infinity, check: !!p.check };
  });
  const fitErr = perPoint.filter((p) => !p.check).map((p) => p.errPx);
  const rmsPx = Math.sqrt(fitErr.reduce((s, e) => s + e * e, 0) / fitErr.length);
  const checkErr = perPoint.filter((p) => p.check).map((p) => p.errPx * norm2000).sort((a, b) => a - b);
  const checkMedian = checkErr.length ? checkErr[Math.floor((checkErr.length - 1) / 2)] : null;
  const checkMax = checkErr.length ? checkErr[checkErr.length - 1] : null;
  const dof = fitPts.length * 2 - (fixedF ? 6 : 7);
  const camH = cam.C[1];
  const hfov = hfovDeg(cam);

  if (checkPts.some((p) => project(cam, p.world).depth <= 0)) {
    issues.push({ code: "points_behind_camera", severity: "error", message: "검증점이 카메라 뒤로 계산됩니다.", need: "검증점의 좌표 또는 클릭 위치를 확인하세요." });
  }
  if (hfov < 15 || hfov > 130) issues.push({ code: "focal_implausible", severity: "error", message: `계산된 화각 ${hfov.toFixed(0)}°가 일반 촬영 범위를 벗어납니다.`, need: "카메라 초점거리를 직접 입력하거나 기준점을 다시 확인하세요." });
  if (focalSource === "default") issues.push({ code: "focal_fallback", severity: "warning", message: "기준점만으로 초점거리를 정하기 어려워 기본 화각(65°)에서 시작했습니다.", need: "EXIF 초점거리 또는 높이를 아는 점(문 상단, 콘센트 등)을 추가하세요." });
  if (camH < 0.3 || camH > 3.5) issues.push({ code: "camera_height_implausible", severity: "error", message: `카메라 높이가 ${camH.toFixed(2)}m로 계산되었습니다.`, need: "기준점 실측 좌표(특히 높이)를 확인하세요." });
  if (rmsPx * norm2000 > 12) issues.push({ code: "high_residual", severity: rmsPx * norm2000 > 40 ? "error" : "warning", message: `기준점 재투영 오차 ${(rmsPx * norm2000).toFixed(1)}px(긴 변 2000px 기준)`, need: "클릭 위치가 정확한지, 같은 이름의 점을 지정했는지 확인하세요." });
  if (checkMedian !== null && checkMedian > 10) issues.push({ code: "high_check_error", severity: checkMedian > 40 ? "error" : "warning", message: `검증점 오차 중앙값 ${checkMedian.toFixed(1)}px(긴 변 2000px 기준)`, need: "기준점을 추가하거나 실측 좌표를 다시 확인하세요." });
  const unc = poseUncertainty(cam, fitPts, fixedF);
  if (unc.sigmaFocalPct > 3 || unc.sigmaCenterM > 0.1)
    issues.push({
      code: "ill_conditioned",
      severity: unc.sigmaFocalPct > 10 || unc.sigmaCenterM > 0.3 ? "error" : "warning",
      message: `기준점 배치로는 카메라가 한 가지로 정해지지 않습니다(초점 ±${isFinite(unc.sigmaFocalPct) ? unc.sigmaFocalPct.toFixed(1) : "∞"}%, 위치 ±${isFinite(unc.sigmaCenterM) ? (unc.sigmaCenterM * 100).toFixed(0) : "∞"}cm, 클릭 오차 1.5px 가정).`,
      need: fixedF ? "다른 방향·높이의 기준점을 추가하세요." : "카메라 초점거리(EXIF 35mm 환산)를 입력하거나, 기존 점들과 일직선이 아닌 기준점(높이를 아는 점 포함)을 추가하세요.",
    });
  if (dof <= 0) issues.push({ code: "no_redundancy", severity: "warning", message: "기준점 수가 미지수와 같아 오차를 스스로 검사할 수 없습니다.", need: "기준점 또는 검증점을 1개 이상 추가하세요." });
  if (!checkPts.length) issues.push({ code: "no_check_points", severity: "info", message: "독립 검증점이 없습니다. 재투영 오차는 적합에 쓴 점 기준입니다.", need: "적합에 쓰지 않을 검증점을 1개 이상 지정하면 '실측 기준 확인'이 가능합니다." });
  if (!opts.scaleMeasured) issues.push({ code: "scale_estimated", severity: "info", message: "기준점 좌표가 실측값이 아닙니다(추정 스케일). 치수 표시는 추정입니다.", need: "줄자로 잰 기준 길이를 입력하세요." });
  if (hfov > 85) issues.push({ code: "lens_unverified", severity: "info", message: `광각(화각 ${hfov.toFixed(0)}°)입니다. 렌즈 왜곡은 보정하지 않으므로 가장자리 배치는 오차가 클 수 있습니다.` });

  const hasError = issues.some((i) => i.severity === "error");
  let status: CalibStatus = hasError ? "failed" : "estimated";
  if (!hasError && opts.scaleMeasured && checkMedian !== null && checkMedian <= 10 && dof > 0 && !issues.some((i) => i.code === "ill_conditioned")) status = "measured";
  return {
    ok: !hasError,
    status,
    camera: cam,
    rmsPx,
    rmsNormPx: rmsPx * norm2000,
    perPoint,
    checkMedianNormPx: checkMedian,
    checkMaxNormPx: checkMax,
    cameraHeightM: camH,
    hfovDeg: hfov,
    focalSource,
    issues,
    dof,
    sigmaFocalPct: isFinite(unc.sigmaFocalPct) ? unc.sigmaFocalPct : null,
    sigmaCenterM: isFinite(unc.sigmaCenterM) ? unc.sigmaCenterM : null,
  };
}

// ───────── 배치(가구) ─────────
export interface Placement {
  id: string;
  assetId: string;
  assetVersionId: string;
  sizeOptionIndex: number | null; // null = 비규격 크기
  dims: { w: number; d: number; h: number }; // cm
  nonStandard: boolean;
  position: { x: number; z: number }; // m, 바닥 접점(중심)
  rotationDeg: number; // Y축 회전, 0 = 정면이 +Z
}

/** 가구 바닥 사각형 꼭짓점(월드) */
export function footprint(p: Placement): Vec3[] {
  const hw = p.dims.w / 200, hd = p.dims.d / 200;
  const R = rotY(p.rotationDeg);
  return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as P2[]).map(([x, z]) => {
    const r = matVec(R, [x, 0, z]);
    return [r[0] + p.position.x, 0, r[2] + p.position.z] as Vec3;
  });
}

export function boxCorners(p: Placement): Vec3[] {
  const fp = footprint(p);
  return [...fp, ...fp.map((c) => [c[0], p.dims.h / 100, c[2]] as Vec3)];
}

function polyOverlap(a: P2[], b: P2[]) {
  // 분리축 정리 (볼록 다각형)
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const n: P2 = [p2[1] - p1[1], p1[0] - p2[0]];
      const pa = a.map((p) => p[0] * n[0] + p[1] * n[1]), pb = b.map((p) => p[0] * n[0] + p[1] * n[1]);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false;
    }
  return true;
}

function pointInPoly(pt: P2, poly: P2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface PlacementWarning {
  placementId: string;
  photoId?: string;
  code: "collision" | "outside_room" | "out_of_frame" | "partially_out_of_frame" | "behind_camera" | "non_standard_size";
  message: string;
}

export function placementWarnings(placements: Placement[], floorBounds: P2[] | null, cams: { photoId: string; label: string; cam: Camera }[]): PlacementWarning[] {
  const w: PlacementWarning[] = [];
  const fps = placements.map((p) => footprint(p).map((c) => [c[0], c[2]] as P2));
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.nonStandard) w.push({ placementId: p.id, code: "non_standard_size", message: "등록된 옵션에 없는 크기입니다(비규격 크기)." });
    for (let j = i + 1; j < placements.length; j++)
      if (polyOverlap(fps[i], fps[j])) w.push({ placementId: p.id, code: "collision", message: "다른 가구와 바닥 영역이 겹칩니다." });
    if (floorBounds && floorBounds.length >= 3 && fps[i].some((c) => !pointInPoly(c, floorBounds)))
      w.push({ placementId: p.id, code: "outside_room", message: "입력된 방 경계(벽)를 벗어납니다. 벽 관통 여부를 확인하세요." });
    for (const { photoId, label, cam } of cams) {
      const pr = boxCorners(p).map((c) => project(cam, c));
      if (pr.every((q) => q.depth <= 0)) {
        w.push({ placementId: p.id, photoId, code: "behind_camera", message: `${label}: 카메라 뒤에 있어 보이지 않습니다.` });
        continue;
      }
      const inside = pr.map((q) => q.depth > 0 && q.u >= 0 && q.u < cam.width && q.v >= 0 && q.v < cam.height);
      if (inside.every((x) => !x)) w.push({ placementId: p.id, photoId, code: "out_of_frame", message: `${label}: 화면 밖에 있습니다.` });
      else if (inside.some((x) => !x)) w.push({ placementId: p.id, photoId, code: "partially_out_of_frame", message: `${label}: 일부가 화면 밖으로 잘립니다.` });
    }
  }
  return w;
}

/** 시선 방향과 가구 정면 사이 각도(방위각·고도각) — 사진 기반 에셋의 참조 각도 선택에 사용 */
export function viewAngleToPlacement(cam: Camera, p: Placement): { azimuthDeg: number; elevationDeg: number } {
  const center: Vec3 = [p.position.x, p.dims.h / 200, p.position.z];
  const toCam = sub(cam.C, center);
  // 가구 로컬 좌표로 회전
  const local = matTVec(rotY(p.rotationDeg), toCam);
  const az = (Math.atan2(local[0], local[2]) * 180) / Math.PI; // 0 = 정면, +90 = 가구의 오른쪽(+X)
  const el = (Math.atan2(local[1], Math.hypot(local[0], local[2])) * 180) / Math.PI;
  return { azimuthDeg: az, elevationDeg: el };
}

/** 캔버스 직렬화용 */
export function cameraToJSON(c: Camera) {
  return { width: c.width, height: c.height, f: c.f, cx: c.cx, cy: c.cy, R: c.R.map((v) => +v.toFixed(12)), C: c.C.map((v) => +v.toFixed(9)) };
}
