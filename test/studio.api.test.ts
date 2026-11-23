// Styling Studio 인수 테스트 (요구사항 10절). 실제 헤드리스 Chromium 렌더 워커를 실행한다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";
import { pool, q, q1 } from "../src/server/db/pool.js";
import { buildApp } from "../src/server/app.js";
import { resetDb } from "./helpers.js";
import { makeStudioUser, resetStudioStorage, sapi, studioLogin } from "./studio.helpers.js";
import { runRenderQueueOnce } from "../src/server/studio/renderJobs.js";
import { closeRenderer } from "../src/server/studio/renderer.js";
import { project, type Camera } from "../src/shared/studio/geometry.js";

let app: FastifyInstance;
let A: ReturnType<typeof sapi>, B: ReturnType<typeof sapi>, OPS: ReturnType<typeof sapi>, ANON: ReturnType<typeof sapi>;
let roomId = "", projectId = "";
let photos: any[] = [];
let variants: any[] = [];
const log: string[] = [];

beforeAll(async () => {
  resetStudioStorage();
  await resetDb();
  await makeStudioUser("vendor-a@test.local", "A인테리어");
  await makeStudioUser("vendor-b@test.local", "B디자인");
  await makeStudioUser("ops@stayscene.local", "스테이신", { ops: true, kind: "internal" });
  app = await buildApp();
  await app.ready();
  A = sapi(app, await studioLogin(app, "vendor-a@test.local"));
  B = sapi(app, await studioLogin(app, "vendor-b@test.local"));
  OPS = sapi(app, await studioLogin(app, "ops@stayscene.local"));
  ANON = sapi(app, null);
}, 60000);

afterAll(async () => {
  fs.mkdirSync("test-output", { recursive: true });
  fs.writeFileSync("test-output/studio-acceptance-log.txt", log.join("\n") + "\n");
  await closeRenderer();
  await app.close();
  await pool.end();
});

async function reloadRoom() {
  const r = await A.get(`/api/studio/rooms/${roomId}`);
  photos = r.body.photos;
  variants = r.body.variants;
  return r.body;
}

async function drain() {
  for (let i = 0; i < 10; i++) if (!(await runRenderQueueOnce("test", 5))) break;
}

describe("샘플·보정", () => {
  it("샘플 프로젝트를 열면 실제 사진 3장, 기준점, 카탈로그 소파가 준비된다", async () => {
    const r = await A.post("/api/studio/samples/open");
    expect(r.status).toBe(200);
    roomId = r.body.roomId;
    projectId = r.body.projectId;
    const room = await reloadRoom();
    expect(photos.length).toBe(3);
    expect(room.room.ref_points.length).toBeGreaterThanOrEqual(8);
    expect(variants.map((v: any) => v.name)).toEqual(["A안", "B안"]);
    for (const p of photos) log.push(`[보정] ${p.label}: ${p.calib_status} rms=${p.calibration.result.rmsNormPx?.toFixed(2)}px(2000) hfov=${p.calibration.result.hfovDeg?.toFixed(1)} 카메라높이=${p.calibration.result.cameraHeightM?.toFixed(2)}m 이슈=${p.calibration.result.issues.map((i: any) => i.code).join(",")}`);
    expect(photos[0].calib_status).toBe("estimated"); // 실측 아님 → '실측 기준 확인' 불가
    expect(photos[0].calibration.result.issues.some((i: any) => i.code === "scale_estimated")).toBe(true);
    expect(photos[2].calibration.result.issues.some((i: any) => i.code === "no_redundancy")).toBe(true);
  });

  it("보정 실패: 초점 정보 없이 기준점 3개 → 무엇이 부족한지 표시, 다른 사진·배치는 유지", async () => {
    const v3 = photos[2];
    const r = await A.patch(`/api/studio/photos/${v3.id}`, { calibration: { points: v3.calibration.points, focalMode: "auto" } });
    expect(r.status).toBe(200);
    expect(r.body.calib_status).toBe("failed");
    const issue = r.body.calibration.result.issues[0];
    expect(issue.code).toBe("too_few_points");
    expect(issue.need).toMatch(/초점거리|기준점/);
    const room = await reloadRoom();
    expect(photos[0].calib_status).toBe("estimated");
    expect(room.variants[0].head.state.placements.length).toBe(1);
    // 되돌림
    await A.patch(`/api/studio/photos/${v3.id}`, { calibration: { points: v3.calibration.points, focalMode: "exif" } });
  });

  it("보정 실패: 바닥이 거의 안 보이는 사진(천장 쪽 크롭) — 업로드는 되고 필요한 점을 안내", async () => {
    const top = await sharp("samples/room/view1.jpg").extract({ left: 0, top: 0, width: 2400, height: 700 }).jpeg().toBuffer();
    const up = await A.upload(`/api/studio/rooms/${roomId}/photos?label=${encodeURIComponent("천장 쪽")}`, top);
    expect(up.status).toBe(200);
    expect(up.body.exif.focal35mm).toBeUndefined(); // 크롭본은 EXIF가 없음
    const pts = [{ refId: "P7", u: 1023.5, v: 855.4 }, { refId: "P8", u: 1291.2, v: 819 }, { refId: "P9", u: 1249.8, v: 44.2 }].map((p) => ({ ...p, v: Math.min(p.v, 699) }));
    const r = await A.patch(`/api/studio/photos/${up.body.id}`, { calibration: { points: pts, focalMode: "auto" } });
    expect(r.body.calib_status).toBe("failed");
    log.push(`[보정 실패 사례] 바닥 없는 사진: ${r.body.calibration.result.issues.map((i: any) => i.message).join(" / ")}`);
    await A.del(`/api/studio/photos/${up.body.id}`);
  });

  it("너무 작은 사진·사진이 아닌 파일은 거부한다", async () => {
    const small = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#888" } }).jpeg().toBuffer();
    expect((await A.upload(`/api/studio/rooms/${roomId}/photos`, small)).status).toBe(422);
    expect((await A.upload(`/api/studio/rooms/${roomId}/photos`, Buffer.from("not an image"))).status).toBe(415);
  });
});

describe("배치·버전·렌더", () => {
  let jobsA: any[] = [];

  it("첫 시점에서 소파를 30cm 옮기고 15° 돌리면 변경 요약에 실제 값이 남는다", async () => {
    const A0 = variants[0];
    const st = structuredClone(A0.head.state);
    st.placements[0].position.x += 0.3;
    st.placements[0].rotationDeg += 15;
    const r = await A.put(`/api/studio/variants/${A0.id}/draft`, { state: st, rev: A0.head.rev });
    expect(r.status).toBe(200);
    const texts = r.body.summary.map((s: any) => s.text).join(" | ");
    log.push(`[변경 요약] ${texts}`);
    expect(texts).toMatch(/이동 30cm/);
    expect(texts).toMatch(/회전 \+15°/);
    // 오래된 rev로 저장하면 충돌
    expect((await A.put(`/api/studio/variants/${A0.id}/draft`, { state: st, rev: A0.head.rev })).status).toBe(409);
    // 다시 열어도 같은 월드 상태
    await reloadRoom();
    expect(variants[0].head.state.placements[0].position.x).toBeCloseTo(st.placements[0].position.x, 9);
    expect(variants[0].head.state.placements[0].rotationDeg).toBe(15);
  });

  it("옵션에 없는 치수로 바꾸면 서버가 '비규격 크기'로 강제 표시한다", async () => {
    const A0 = variants[0];
    const st = structuredClone(A0.head.state);
    st.placements[0].dims.w = 200;
    const r = await A.put(`/api/studio/variants/${A0.id}/draft`, { state: st, rev: A0.head.rev });
    expect(r.body.state.placements[0].nonStandard).toBe(true);
    expect(r.body.state.placements[0].sizeOptionIndex).toBe(null);
    // 원래 옵션으로 복구
    const asset = await A.get(`/api/studio/assets/${st.placements[0].assetId}`);
    st.placements[0].dims = { w: asset.body.size_options[0].w, d: asset.body.size_options[0].d, h: asset.body.size_options[0].h };
    st.placements[0].sizeOptionIndex = 0;
    const r2 = await A.put(`/api/studio/variants/${A0.id}/draft`, { state: st, rev: r.body.rev });
    expect(r2.body.state.placements[0].nonStandard).toBe(false);
    await reloadRoom();
  });

  it("두 시점 렌더: 정확한 에셋 버전, 원본 크기, 마스크 밖 픽셀 동일(무손실 재검증), 같은 월드 위치", async () => {
    const head = variants[0].head;
    const r = await A.post("/api/studio/renders", { variantVersionId: head.id, photoIds: [photos[0].id, photos[1].id] });
    expect(r.status).toBe(200);
    expect(r.body.every((x: any) => x.job && !x.deduped)).toBe(true);
    for (const x of r.body) expect(x.job.assetVersions[0].versionId).toBe(head.state.placements[0].assetVersionId);
    // 같은 입력 재요청 → 진행 중인 작업 반환
    const again = await A.post("/api/studio/renders", { variantVersionId: head.id, photoIds: [photos[0].id] });
    expect(again.body[0].deduped).toBe(true);
    expect(again.body[0].job.id).toBe(r.body[0].job.id);
    const t0 = Date.now();
    await drain();
    log.push(`[렌더] 2시점 처리 ${(Date.now() - t0) / 1000}s (SwiftShader CPU 렌더)`);
    const list = await A.get(`/api/studio/renders?variantVersionId=${head.id}`);
    jobsA = list.body.filter((j: any) => j.status === "done");
    expect(jobsA.length).toBe(2);
    for (const j of jobsA) {
      const qa = j.outputs.qa;
      log.push(`[QA] ${j.photoId.slice(0, 8)} ${qa.width}x${qa.height} 허용픽셀 ${qa.allowedPixels} 변경 ${qa.changedPixels} 허용밖변경 ${qa.changedOutsideAllowed} 보호영역변경 ${qa.changedInProtected} 무손실재검증 ${JSON.stringify(qa.preservation)} grain σ=${qa.grainSigma} 근거=${j.evidenceLabel} 공개범위=${j.releaseLabel}`);
      expect(qa.changedOutsideAllowed).toBe(0);
      expect(qa.preservation.ok).toBe(true);
      expect(qa.width).toBe(2400);
      expect(qa.height).toBe(1600);
      expect(j.evidence).toBe("verified_model");
      expect(j.release).toBe("internal_test"); // 실물 비교 전에는 외부 납품 상태로 올리지 않음
      // 다운로드: 마스터 PNG는 원본 픽셀 크기
      const dl = await A.get(`/api/studio/renders/${j.id}/download?type=master`);
      expect(dl.status).toBe(200);
      const meta = await sharp(dl.raw).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([2400, 1600, "png"]);
      // 렌더된 가구 알파 영역 안에 월드 배치 중심의 투영점이 있어야 한다(시점 간 같은 위치)
      const ph = photos.find((p) => p.id === j.photoId);
      const cam: Camera = ph.calibration.result.camera;
      const pl = head.state.placements[0];
      const c = project(cam, [pl.position.x, pl.dims.h / 200, pl.position.z]);
      const alpha = await A.get(`/api/studio/files/${j.outputs.alphaFileId}`);
      const { data, info } = await sharp(alpha.raw).raw().toBuffer({ resolveWithObject: true });
      const u = Math.round(c.u), v = Math.round(c.v);
      if (u >= 0 && u < info.width && v >= 0 && v < info.height) {
        expect(data[(v * info.width + u) * 4 + 3]).toBeGreaterThan(200);
        log.push(`[시점 일치] ${ph.label}: 배치 중심 투영 (${u},${v}) 위치에 가구 알파 ${data[(v * info.width + u) * 4 + 3]}`);
      } else log.push(`[시점 일치] ${ph.label}: 배치 중심이 화면 밖`);
    }
    // 완료된 동일 입력은 재사용
    const again2 = await A.post("/api/studio/renders", { variantVersionId: head.id, photoIds: [photos[0].id] });
    expect(again2.body[0].deduped).toBe(true);
    fs.mkdirSync("test-output", { recursive: true });
    for (const j of jobsA) {
      const d = await A.get(`/api/studio/renders/${j.id}/download?type=delivery`);
      fs.writeFileSync(`test-output/A_${photos.find((p) => p.id === j.photoId).label.replace(/\s/g, "")}.jpg`, d.raw);
    }
  }, 240000);

  it("보호 영역: 가구와 겹쳐도 보호 영역 픽셀은 바뀌지 않고, 가림으로 숨겨진 픽셀이 기록된다", async () => {
    const ph = photos[0];
    const j = jobsA.find((x) => x.photoId === ph.id);
    const [x0, y0, x1, y1] = j.outputs.qa.bbox;
    const midX = Math.round((x0 + x1) / 2);
    const prot = [[midX, y0], [x1 + 1, y0], [x1 + 1, y1 + 1], [midX, y1 + 1]];
    const r = await A.patch(`/api/studio/photos/${ph.id}`, { masks: { occluders: [], protected: [{ id: "m1", points: prot }] } });
    expect(r.body.masks_rev).toBe(1);
    const rr = await A.post("/api/studio/renders", { variantVersionId: variants[0].head.id, photoIds: [ph.id] });
    expect(rr.body[0].deduped).toBe(false); // 마스크 버전이 달라 새 작업
    await drain();
    const done = await A.get(`/api/studio/renders/${rr.body[0].job.id}`);
    expect(done.body.status).toBe("done");
    expect(done.body.masksRev).toBe(1);
    expect(done.body.outputs.qa.changedInProtected).toBe(0);
    expect(done.body.outputs.qa.occludedFurniturePixels).toBeGreaterThan(1000);
    // 원본과 비교: 보호 사각형 내부 픽셀 동일
    const master = await A.get(`/api/studio/renders/${done.body.id}/download?type=master`);
    const orig = await A.get(`/api/studio/files/${ph.master_file_id}`);
    const a = await sharp(master.raw).raw().toBuffer(), b = await sharp(orig.raw).raw().toBuffer();
    let diff = 0;
    for (let y = y0; y <= y1; y += 3) for (let x = midX; x <= x1; x += 3) for (let c = 0; c < 3; c++) if (a[(y * 2400 + x) * 3 + c] !== b[(y * 2400 + x) * 3 + c]) diff++;
    expect(diff).toBe(0);
    log.push(`[보호 영역] 보호 사각형 내부 샘플 픽셀 차이 ${diff}, 가려진 가구 픽셀 ${done.body.outputs.qa.occludedFurniturePixels}, 공개범위=${done.body.releaseLabel}`);
    await A.patch(`/api/studio/photos/${ph.id}`, { masks: { occluders: [], protected: [] } });
  }, 120000);

  it("작업 취소·워커 실패·실패 시점만 재시도: 기존 성공 파일은 보존", async () => {
    const Bv = variants[1];
    const req = await A.post("/api/studio/renders", { variantVersionId: Bv.head.id, photoIds: [photos[0].id, photos[1].id] });
    const [j1, j2] = req.body.map((x: any) => x.job);
    expect((await A.post(`/api/studio/renders/${j1.id}/cancel`)).status).toBe(200);
    // 워커 사용 불가 상태를 만든다 (Chromium 경로 잘못 지정)
    await closeRenderer();
    process.env.STUDIO_CHROMIUM_PATH = "/nonexistent/chrome";
    await drain();
    const f2 = await A.get(`/api/studio/renders/${j2.id}`);
    expect(f2.body.status).toBe("failed");
    expect(f2.body.errorCode).toBe("renderer_unavailable");
    delete process.env.STUDIO_CHROMIUM_PATH;
    // 실패한 시점만 재시도
    const rt = await A.post(`/api/studio/renders/${j2.id}/retry`);
    expect(rt.status).toBe(200);
    expect((await A.post(`/api/studio/renders/${jobsA[0].id}/retry`)).status).toBe(409); // 성공 작업은 재시도 대상 아님
    // 취소된 작업 재시도
    const rt1 = await A.post(`/api/studio/renders/${j1.id}/retry`);
    await drain();
    expect((await A.get(`/api/studio/renders/${rt.body.job.id}`)).body.status).toBe("done");
    expect((await A.get(`/api/studio/renders/${rt1.body.job.id}`)).body.status).toBe("done");
    expect((await A.get(`/api/studio/renders/${j1.id}`)).body.status).toBe("canceled");
    // A안의 기존 성공 결과는 그대로
    expect((await A.get(`/api/studio/renders/${jobsA[0].id}/download?type=master`)).status).toBe(200);
    for (const j of [rt.body.job, rt1.body.job]) {
      const d = await A.get(`/api/studio/renders/${j.id}/download?type=delivery`);
      fs.writeFileSync(`test-output/B_${photos.find((p) => p.id === j.photoId).label.replace(/\s/g, "")}.jpg`, d.raw);
    }
  }, 240000);

  it("정면 사진만 있는 제품을 측면 시점에 놓으면 '제품 확인'으로 표시하지 않고 필요한 각도를 요청한다", async () => {
    const assets = (await A.get("/api/studio/assets")).body;
    const photoAsset = assets.find((a: any) => a.kind === "photo");
    expect(photoAsset).toBeTruthy();
    const vr = await A.post(`/api/studio/rooms/${roomId}/variants`, { name: "C안(사진 제품)" });
    const opt = photoAsset.size_options[0];
    const base = { id: "pp1", assetId: photoAsset.id, assetVersionId: photoAsset.current_version_id, sizeOptionIndex: 0, dims: { w: opt.w, d: opt.d, h: opt.h }, nonStandard: false, position: { x: 0.2, z: 0.55 }, rotationDeg: 0 };
    const st = { placements: [base], lighting: vr.body.head.state.lighting };
    let r = await A.put(`/api/studio/variants/${vr.body.variant.id}/draft`, { state: st });
    let rr = await A.post("/api/studio/renders", { variantVersionId: r.body.id, photoIds: [photos[0].id] });
    const front = rr.body[0].job.placementEvidence[0];
    log.push(`[경로 B] 정면 배치: ${front.evidence} 시선각 ${front.viewAzimuthDeg}° gap ${front.angleGapDeg}°`);
    expect(["appearance_estimate", "needs_reference"]).toContain(front.evidence);
    expect(front.evidence).not.toBe("verified_model");
    // 90° 회전 → 카메라에는 측면이 보임
    r = await A.put(`/api/studio/variants/${vr.body.variant.id}/draft`, { state: { ...st, placements: [{ ...base, rotationDeg: 90 }] }, rev: r.body.rev });
    rr = await A.post("/api/studio/renders", { variantVersionId: r.body.id, photoIds: [photos[0].id] });
    const side = rr.body[0].job.placementEvidence[0];
    log.push(`[경로 B] 측면 배치: ${side.evidence} — ${side.need}`);
    expect(side.evidence).toBe("needs_reference");
    expect(side.need).toMatch(/측면/);
    expect(rr.body[0].job.evidence).toBe("needs_reference");
    // 대기열에서 제거(테스트 시간 절약)
    for (const x of rr.body) await A.post(`/api/studio/renders/${x.job.id}/cancel`);
    await q(`UPDATE studio_render_jobs SET status='canceled' WHERE status='queued'`);
  });

  it("묶음 다운로드: 시점별 이미지 + 제품 목록 + 근거 기록", async () => {
    const z = await A.get(`/api/studio/variant-versions/${variants[0].head.id}/bundle.zip`);
    expect(z.status).toBe(200);
    const s = z.raw.toString("latin1");
    expect(s).toContain("PK");
    const csv = await A.get(`/api/studio/variant-versions/${variants[0].head.id}/products.csv`);
    const text = csv.raw.toString("utf8");
    expect(text).toContain("터프티드 가죽 3인 소파");
    expect(text).toContain("3D 모델 확인");
    const cmp = await A.get(`/api/studio/compare.jpg?a=${jobsA[0].id}&b=${(await A.get(`/api/studio/renders?variantVersionId=${variants[1].head.id}`)).body.find((j: any) => j.status === "done" && j.photoId === jobsA[0].photoId).id}`);
    expect(cmp.status).toBe(200);
    fs.writeFileSync("test-output/compare_AB.jpg", cmp.raw);
  });
});

describe("공유·승인·버전 고정", () => {
  let token = "", shareId = "";
  let bVersionId = "", bJob = "";
  it("A/B 두 안을 공유하면 해당 버전이 잠기고, 고객은 로그인 없이 선택 항목만 본다", async () => {
    await reloadRoom();
    const jobs = (await A.get(`/api/studio/renders?roomId=${roomId}`)).body.filter((j: any) => j.status === "done");
    const aJob = jobs.find((j: any) => j.variantVersionId === variants[0].head.id && j.photoId === photos[0].id);
    const b = jobs.find((j: any) => j.variantVersionId === variants[1].head.id && j.photoId === photos[0].id);
    bVersionId = variants[1].head.id;
    bJob = b.id;
    const r = await A.post("/api/studio/shares", { roomId, title: "거실 소파 제안", clientName: "김고객", items: [{ variantVersionId: variants[0].head.id, label: "A안", renderJobIds: [aJob.id] }, { variantVersionId: bVersionId, label: "B안", renderJobIds: [b.id] }] });
    expect(r.status).toBe(200);
    token = r.body.token;
    shareId = r.body.id;
    const pub = await ANON.get(`/api/studio/public/share/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.notice).toMatch(/배치 시뮬레이션/);
    expect(pub.body.items.length).toBe(2);
    expect(pub.body.items[0].images.length).toBe(1);
    expect(JSON.stringify(pub.body)).not.toMatch(/sourceUrl|master/);
    const img = await ANON.get(pub.body.items[1].images[0].url);
    expect(img.status).toBe(200);
    const meta = await sharp(img.raw).metadata();
    expect(meta.exif).toBeUndefined(); // 공개 파일은 메타데이터(위치 포함) 없음
    // 공유되지 않은 결과는 링크로 볼 수 없다
    const other = jobs.find((j: any) => j.photoId === photos[1].id);
    expect((await ANON.get(`/api/studio/public/share/${token}/image/${other.id}`)).status).toBe(404);
  });

  it("고객이 B안에 의견을 남기고 승인 → 업체의 다음 수정은 새 버전, 승인 버전·링크 내용은 그대로", async () => {
    expect((await ANON.post(`/api/studio/public/share/${token}/feedback`, { variantVersionId: bVersionId, kind: "comment", authorName: "김고객", body: "소파를 창 쪽으로 30cm만 옮겨 주세요" })).status).toBe(200);
    expect((await ANON.post(`/api/studio/public/share/${token}/feedback`, { variantVersionId: bVersionId, kind: "approve", authorName: "김고객" })).status).toBe(200);
    const vv = await A.get(`/api/studio/variant-versions/${bVersionId}`);
    expect(vv.body.locked_reason).toBe("approved");
    const before = JSON.stringify(vv.body.state);
    await reloadRoom();
    const Bv = variants[1];
    const st = structuredClone(Bv.head.state);
    st.placements[0].position.x += 0.3;
    const saved = await A.put(`/api/studio/variants/${Bv.id}/draft`, { state: st, rev: Bv.head.rev });
    expect(saved.body.id).not.toBe(bVersionId);
    expect(saved.body.version).toBe(Bv.head.version + 1);
    expect(saved.body.summary.map((s: any) => s.text).join()).toMatch(/이동 30cm/);
    const vv2 = await A.get(`/api/studio/variant-versions/${bVersionId}`);
    expect(JSON.stringify(vv2.body.state)).toBe(before);
    const pub = await ANON.get(`/api/studio/public/share/${token}`);
    expect(pub.body.items[1].version).toBe(Bv.head.version);
    expect(pub.body.items[1].approved).toBe(true);
    expect(pub.body.items[1].images[0].renderJobId).toBe(bJob);
    const shares = await A.get(`/api/studio/projects/${projectId}/shares`);
    expect(shares.body[0].feedback.length).toBe(2);
  });

  it("공유 중지·만료 후에는 링크와 이미지가 막힌다", async () => {
    const pub = await ANON.get(`/api/studio/public/share/${token}`);
    const imgUrl = pub.body.items[0].images[0].url;
    expect((await A.post(`/api/studio/shares/${shareId}/revoke`)).status).toBe(200);
    expect((await ANON.get(`/api/studio/public/share/${token}`)).status).toBe(410);
    expect((await ANON.get(imgUrl)).status).toBe(410);
    expect((await ANON.post(`/api/studio/public/share/${token}/feedback`, { variantVersionId: bVersionId, kind: "comment", authorName: "x", body: "y" })).status).toBe(410);
    // 만료
    const items = [{ variantVersionId: bVersionId, label: "B", renderJobIds: [bJob] }];
    const s2 = await A.post("/api/studio/shares", { roomId, title: "만료 테스트", items });
    await q(`UPDATE studio_share_links SET expires_at=now() - interval '1 minute' WHERE id=$1`, [s2.body.id]);
    expect((await ANON.get(`/api/studio/public/share/${s2.body.token}`)).status).toBe(410);
  });
});

describe("업체 간 권한 분리", () => {
  it("B 업체는 A의 방·사진·파일·렌더·안·공유·결과를 ID로 열 수 없다", async () => {
    const jobs = (await A.get(`/api/studio/renders?roomId=${roomId}`)).body;
    const job = jobs.find((j: any) => j.status === "done");
    const checks: [string, number][] = [];
    const push = async (label: string, p: Promise<any>) => checks.push([label, (await p).status]);
    await push("room", B.get(`/api/studio/rooms/${roomId}`));
    await push("project", B.get(`/api/studio/projects/${projectId}`));
    await push("photo file", B.get(`/api/studio/files/${photos[0].master_file_id}`));
    await push("original", B.get(`/api/studio/files/${photos[0].original_file_id}`));
    await push("render", B.get(`/api/studio/renders/${job.id}`));
    await push("render download", B.get(`/api/studio/renders/${job.id}/download?type=master`));
    await push("render list", B.get(`/api/studio/renders?roomId=${roomId}`));
    await push("layer file", B.get(`/api/studio/files/${job.outputs.alphaFileId}`));
    await push("variant edit", B.put(`/api/studio/variants/${variants[0].id}/draft`, { state: variants[0].head.state }));
    await push("render request", B.post("/api/studio/renders", { variantVersionId: variants[0].head.id, photoIds: [photos[0].id] }));
    await push("photo patch", B.patch(`/api/studio/photos/${photos[0].id}`, { label: "탈취" }));
    await push("photo upload", B.upload(`/api/studio/rooms/${roomId}/photos`, fs.readFileSync("samples/room/view1.jpg")));
    await push("shares", B.get(`/api/studio/projects/${projectId}/shares`));
    await push("bundle", B.get(`/api/studio/variant-versions/${variants[0].head.id}/bundle.zip`));
    await push("ops consults", B.get(`/api/studio/ops/consults`));
    await push("ops usage", B.get(`/api/studio/ops/usage`));
    log.push(`[권한 분리] ${checks.map(([l, s]) => `${l}=${s}`).join(", ")}`);
    for (const [l, s] of checks) expect([403, 404], l).toContain(s);
    expect((await ANON.get(`/api/studio/rooms/${roomId}`)).status).toBe(401);
    // B가 A의 에셋 버전(업체 소유)을 자기 안에 쓸 수 없음 — 카탈로그는 가능
    const own = await A.post("/api/studio/assets", { name: "A 전용 소파", kind: "model3d", sizeOptions: [{ label: "기본", w: 181, d: 82, h: 71 }] });
    const glb = await A.upload(`/api/studio/assets/${own.body.id}/versions/glb?confirmed=true&license=CC0&provenance=test`, fs.readFileSync("samples/assets/sofa_02.glb"), "model/gltf-binary");
    expect(glb.status).toBe(200);
    expect(glb.body.verification).toBe("verified");
    const bs = await B.post("/api/studio/samples/open");
    const broom = (await B.get(`/api/studio/rooms/${bs.body.roomId}`)).body;
    const st = structuredClone(broom.variants[0].head.state);
    st.placements[0] = { ...st.placements[0], assetId: own.body.id, assetVersionId: glb.body.id };
    expect((await B.put(`/api/studio/variants/${broom.variants[0].id}/draft`, { state: st })).status).toBe(400);
    expect((await B.get(`/api/studio/assets`)).body.some((a: any) => a.id === own.body.id)).toBe(false);
  });

  it("GLB 치수가 선언값과 다르면 '확인'으로 올리지 않는다", async () => {
    const own = await A.post("/api/studio/assets", { name: "치수 불일치", kind: "model3d", sizeOptions: [{ label: "기본", w: 220, d: 90, h: 80 }] });
    const glb = await A.upload(`/api/studio/assets/${own.body.id}/versions/glb?confirmed=true`, fs.readFileSync("samples/assets/sofa_02.glb"), "model/gltf-binary");
    expect(glb.body.verification).toBe("unverified");
    expect(glb.body.meta.dimensionMismatch.length).toBeGreaterThan(0);
    expect((await A.upload(`/api/studio/assets/${own.body.id}/versions/glb`, Buffer.from("garbage"), "model/gltf-binary")).status).toBe(415);
  });
});

describe("상담 요청·운영", () => {
  it("업체가 고른 자료만 운영자가 열 수 있다", async () => {
    const jobs = (await A.get(`/api/studio/renders?roomId=${roomId}`)).body.filter((j: any) => j.status === "done");
    const c = await A.post("/api/studio/consult", { projectId, purpose: "precision_composite", message: "가죽 질감이 실제보다 매끈해 보입니다", problemNote: "시점 1 렌더 후", included: { photoIds: [photos[0].id], variantVersionIds: [variants[0].head.id], renderJobIds: [jobs[0].id] } });
    expect(c.status).toBe(200);
    // 다른 업체 자료를 끼워 넣을 수 없음
    expect((await B.post("/api/studio/consult", { projectId, purpose: "other", included: { photoIds: [], variantVersionIds: [], renderJobIds: [] } })).status).toBe(404);
    const list = await OPS.get("/api/studio/ops/consults");
    expect(list.body.length).toBe(1);
    const detail = await OPS.get(`/api/studio/ops/consults/${c.body.id}`);
    expect(detail.body.photos.length).toBe(1);
    expect(detail.body.products[0].rows[0].name).toBeTruthy();
    expect((await OPS.get(`/api/studio/ops/consults/${c.body.id}/file/${photos[0].preview_file_id}`)).status).toBe(200);
    expect((await OPS.get(`/api/studio/ops/consults/${c.body.id}/file/${photos[1].master_file_id}`)).status).toBe(403);
    // 운영자라도 일반 파일 경로로는 업체 파일을 못 연다
    expect((await OPS.get(`/api/studio/files/${photos[0].master_file_id}`)).status).toBe(404);
    const usage = await OPS.get("/api/studio/ops/usage");
    expect(usage.status).toBe(200);
    const aws = usage.body.byWorkspace.find((w: any) => w.name === "A인테리어");
    log.push(`[운영] A인테리어 이번 달 렌더 ${aws.renders_month}회, 평균 ${aws.avg_render_ms}ms, 실패 ${aws.failed}; 실패 유형 ${JSON.stringify(usage.body.failures.map((f: any) => [f.error_code, f.n]))}`);
    expect(aws.renders_month).toBeGreaterThanOrEqual(4);
  });

  it("사진 교체: 새 사진은 다시 확인 전까지 미보정, 이전 사진·렌더는 보존", async () => {
    const old = photos[1];
    const r = await A.upload(`/api/studio/photos/${old.id}/replace`, fs.readFileSync("samples/room/view2.jpg"));
    expect(r.status).toBe(200);
    expect(r.body.calib_status).toBe("uncalibrated");
    expect(r.body.calibration.suggestedPoints.length).toBe(old.calibration.points.length);
    expect(r.body.calibration.result.issues[0].message).toMatch(/교체/);
    const room = await reloadRoom();
    expect(room.photos.find((p: any) => p.id === old.id)).toBeUndefined();
    // 이전 사진 기반 렌더는 여전히 내려받을 수 있다
    const jobs = (await A.get(`/api/studio/renders?roomId=${roomId}`)).body.filter((j: any) => j.status === "done" && j.photoId === old.id);
    expect(jobs.length).toBeGreaterThan(0);
    expect((await A.get(`/api/studio/renders/${jobs[0].id}/download?type=delivery`)).status).toBe(200);
    // 미보정 시점은 렌더 요청에서 건너뛰고 이유를 알린다
    const rr = await A.post("/api/studio/renders", { variantVersionId: variants[0].head.id, photoIds: [r.body.id] });
    expect(rr.body[0].skipped).toBe(true);
    expect(rr.body[0].code).toBe("not_calibrated");
  });
});
