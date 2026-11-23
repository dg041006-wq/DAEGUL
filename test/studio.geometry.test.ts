// 카메라 보정 수학: 합성 정답 + 실제 사진(파노라마 크롭) 정답으로 검증
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  calibrate,
  floorHit,
  footprint,
  matMul,
  placementWarnings,
  project,
  rotX,
  rotY,
  transpose,
  viewAngleToPlacement,
  type Camera,
  type CalibPoint,
  type Mat3,
  type Placement,
  type Vec3,
} from "../src/shared/studio/geometry.js";

function synthCam(yaw: number, pitch: number, C: Vec3, hfov = 70, width = 3000, height = 2000): Camera {
  const f = width / 2 / Math.tan((hfov * Math.PI) / 360);
  return { width, height, f, cx: width / 2, cy: height / 2, R: matMul(rotY(yaw), rotX(pitch)), C };
}

const worldPts: Record<string, Vec3> = {
  a: [0, 0, 0],
  b: [3.2, 0, 0],
  c: [3.2, 0, 2.5],
  d: [0, 0, 2.5],
  e: [1.6, 0, 1.2],
  door: [0.4, 2.0, 0],
  sock: [2.5, 0.3, 0],
};

function observe(cam: Camera, ids: string[], noise = 0, check: string[] = []): CalibPoint[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  return ids.map((id) => {
    const p = project(cam, worldPts[id]);
    return { id, world: worldPts[id], u: p.u + rnd() * noise, v: p.v + rnd() * noise, check: check.includes(id) };
  });
}

describe("카메라 보정 — 합성 정답", () => {
  const truth = synthCam(10, -12, [1.5, 1.45, 4.2]);
  it("바닥점 4개만으로 초점·자세를 복원한다 (잡음 없음)", () => {
    const r = calibrate(observe(truth, ["a", "b", "c", "d"]), 3000, 2000);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.camera!.f - truth.f) / truth.f).toBeLessThan(1e-3);
    expect(Math.abs(r.camera!.C[1] - 1.45)).toBeLessThan(1e-3);
    expect(r.status).toBe("estimated"); // 실측 아님 + 검증점 없음
  });

  it("1px 잡음 + 높이점 + 검증점: 검증점 오차 중앙값 10px 이내, 실측이면 '실측 기준 확인'", () => {
    const pts = observe(truth, ["a", "b", "c", "d", "door", "sock", "e"], 1, ["e", "sock"]);
    const r = calibrate(pts, 3000, 2000, { scaleMeasured: true });
    expect(r.ok).toBe(true);
    expect(r.checkMedianNormPx!).toBeLessThan(10);
    expect(r.status).toBe("measured");
  });

  it("일렬 기준점은 실패하고 필요한 입력을 알려준다", () => {
    const line: CalibPoint[] = [0, 1, 2, 3].map((i) => {
      const w: Vec3 = [i, 0, 0];
      const p = project(truth, w);
      return { id: "l" + i, world: w, u: p.u, v: p.v };
    });
    const r = calibrate(line, 3000, 2000);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("collinear_points");
    expect(r.issues[0].need).toBeTruthy();
  });

  it("점이 부족하면 무엇이 부족한지 반환한다 (초점 없으면 4개, 있으면 3개)", () => {
    const r = calibrate(observe(truth, ["a", "b", "c"]), 3000, 2000);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("too_few_points");
    const r2 = calibrate(observe(truth, ["a", "b", "door"]), 3000, 2000, { focalPx: truth.f, focalSource: "exif" });
    expect(r2.ok).toBe(true);
    expect(r2.issues.some((i) => i.code === "no_redundancy")).toBe(true);
  });

  it("클릭 오류(점 바꿔 찍기)는 높은 재투영 오차로 드러난다", () => {
    const pts = observe(truth, ["a", "b", "c", "d", "door"]);
    [pts[0].u, pts[1].u] = [pts[1].u, pts[0].u];
    [pts[0].v, pts[1].v] = [pts[1].v, pts[0].v];
    const r = calibrate(pts, 3000, 2000);
    expect(r.issues.some((i) => i.code === "high_residual" || i.code === "solve_failed" || i.code === "camera_height_implausible")).toBe(true);
  });

  it("포인터→바닥 교점은 투영의 역이다", () => {
    const w: Vec3 = [1.234, 0, 0.987];
    const p = project(truth, w);
    const h = floorHit(truth, p.u, p.v)!;
    expect(Math.hypot(h[0] - w[0], h[2] - w[2])).toBeLessThan(1e-9);
  });
});

describe("카메라 보정 — 실제 사진(Poly Haven 파노라마 크롭, 정답 카메라 기록)", () => {
  const gt = JSON.parse(fs.readFileSync("samples/room/ground_truth.json", "utf8"));
  for (const v of gt.views) {
    const ids = Object.keys(v.points);
    if (ids.length < 4) {
      it(`${v.file}: 기준점 ${ids.length}개 → 초점 미상이면 실패, 정답 초점을 주면 풀림`, () => {
        const pts: CalibPoint[] = ids.map((id) => ({ id, world: gt.points[id].world, u: v.points[id][0], v: v.points[id][1] }));
        expect(calibrate(pts, v.width, v.height).ok).toBe(false);
        const r = calibrate(pts, v.width, v.height, { focalPx: v.f, focalSource: "manual" });
        expect(r.ok).toBe(true);
        expect(Math.hypot(r.camera!.C[0] - v.center[0], r.camera!.C[1] - v.center[1], r.camera!.C[2] - v.center[2])).toBeLessThan(0.02);
      });
      continue;
    }
    it(`${v.file}: 초점 오차와 카메라 위치 오차`, () => {
      // 사용자가 클릭할 때의 오차를 흉내: 정답 픽셀에서 ±1.5px 반올림 오차
      const pts: CalibPoint[] = ids.map((id, i) => ({ id, world: gt.points[id].world, u: Math.round(v.points[id][0]) + (i % 2 ? 1 : -1), v: Math.round(v.points[id][1]) }));
      const free = calibrate(pts, v.width, v.height);
      const illFree = free.issues.some((i) => i.code === "ill_conditioned");
      // 초점 미상으로 풀리지 않는 배치는 반드시 '불확실'로 표시되어야 한다 → 그 경우 EXIF 초점으로 다시 푼다
      const r = illFree ? calibrate(pts, v.width, v.height, { focalPx: (v.exifFocal35mm / 36) * v.width, focalSource: "exif" }) : free;
      console.log(`[보정] ${v.file} 초점미상 풀이: ${illFree ? "불확실 표시됨 → EXIF 초점 사용" : "확정"} (σf ${free.sigmaFocalPct?.toFixed(1)}%)`);
      expect(r.ok).toBe(true);
      const fErr = Math.abs(r.camera!.f - v.f) / v.f;
      const cErr = Math.hypot(r.camera!.C[0] - v.center[0], r.camera!.C[1] - v.center[1], r.camera!.C[2] - v.center[2]);
      // 바닥 위 임의 점의 투영 오차 (가구가 놓일 영역)
      const truth: Camera = { width: v.width, height: v.height, f: v.f, cx: v.cx, cy: v.cy, R: v.R_world_cam.flat() as Mat3, C: v.center };
      let maxErr = 0;
      const errs: number[] = [];
      for (const x of [0.2, 0.8, 1.4]) for (const z of [0.3, 0.8]) for (const y of [0, 0.7]) {
        const a = project(truth, [x, y, z]), b = project(r.camera!, [x, y, z]);
        if (a.depth > 0 && a.u > 0 && a.u < v.width && a.v > 0 && a.v < v.height) { const e = Math.hypot(a.u - b.u, a.v - b.v); errs.push(e); maxErr = Math.max(maxErr, e); }
      }
      console.log(`[보정] ${v.file} f오차 ${(fErr * 100).toFixed(2)}% 위치오차 ${(cErr * 100).toFixed(1)}cm 소파영역 최대 투영오차 ${maxErr.toFixed(1)}px(${v.width}px)`);
      errs.sort((a, b) => a - b);
      const med = errs[Math.floor((errs.length - 1) / 2)] * (2000 / v.width);
      console.log(`[보정] ${v.file} 소파영역 투영오차 중앙값 ${med.toFixed(1)}px / 최대 ${(maxErr * 2000 / v.width).toFixed(1)}px (긴 변 2000px 기준)`);
      expect(med).toBeLessThan(10);
      expect(maxErr * (2000 / v.width)).toBeLessThan(20);
    });
  }
});

describe("배치 검사", () => {
  const sofa: Placement = { id: "s", assetId: "a", assetVersionId: "v", sizeOptionIndex: 0, dims: { w: 180, d: 82, h: 71 }, nonStandard: false, position: { x: 0.8, z: 0.5 }, rotationDeg: 0 };
  it("바닥 사각형·충돌·방 경계·화면 밖 경고", () => {
    expect(footprint(sofa).map((c) => +c[0].toFixed(2))).toEqual([-0.1, 1.7, 1.7, -0.1]);
    const chair = { ...sofa, id: "c", position: { x: 1.5, z: 0.6 }, dims: { w: 70, d: 70, h: 80 } };
    const cam = synthCam(180, -15, [0.8, 1.4, 3.5]);
    const w = placementWarnings([sofa, chair], [[0, 0], [1.8, 0], [1.8, 2.8], [0, 2.8]], [{ photoId: "p", label: "시점1", cam }]);
    expect(w.some((x) => x.code === "collision")).toBe(true);
    expect(w.some((x) => x.code === "outside_room" && x.placementId === "s")).toBe(true);
  });
  it("가구 정면 기준 시선 각도", () => {
    const front = synthCam(0, 0, [0.8, 0.355, 3]); // 카메라가 +Z 쪽(정면)
    expect(Math.abs(viewAngleToPlacement(front, sofa).azimuthDeg)).toBeLessThan(1e-6);
    const side = synthCam(90, 0, [3, 0.355, 0.5]);
    expect(Math.round(viewAngleToPlacement(side, sofa).azimuthDeg)).toBe(90);
    void transpose;
  });
});
