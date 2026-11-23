// 브라우저 인수 테스트(요구사항 10절) — 실제 서버에 붙어 화면을 조작하고 스크린샷·다운로드를 남긴다.
// 준비: 서버 실행(npm run dev 또는 npm start) + 업체/운영 계정(studio:create-user)
// 실행: E2E_BASE=http://localhost:3000 E2E_VENDOR=vendor@test.local:비밀번호 E2E_OPS=ops@stayscene.local:비밀번호 node scripts/e2e-studio.mjs
import fs from "node:fs";
import { chromium, devices } from "playwright-core";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const [VE, VP] = (process.env.E2E_VENDOR ?? "vendor@test.local:vendor-pass-2026").split(":");
const [OE, OP] = (process.env.E2E_OPS ?? "ops@stayscene.local:stayscene-ops-2026").split(":");
const OUT = "test-output/e2e";
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.STUDIO_CHROMIUM_PATH || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const gt = JSON.parse(fs.readFileSync("samples/room/ground_truth.json", "utf8"));
const log = [];
const step = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  log.push(line);
  console.log(line);
};
const timer = () => {
  const t = Date.now();
  return () => ((Date.now() - t) / 1000).toFixed(1) + "s";
};

const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

async function login(page, email, pw) {
  await page.goto(`${BASE}/studio`);
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", pw);
  await page.click("button.btn.primary");
  await page.waitForSelector("text=프로젝트");
}

async function stagePoint(page, u, v, W, H) {
  const box = await page.locator(".stage .overlay").boundingBox();
  return { x: box.x + (u / W) * box.width, y: box.y + (v / H) * box.height };
}

async function waitJobsDone(page, n, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = await page.locator(".jobs .chip.ok", { hasText: "완료" }).count();
    const f = await page.locator(".jobs .chip.bad", { hasText: "실패" }).count();
    if (f) throw new Error("렌더 실패 표시됨");
    if (c >= n) return;
    await page.waitForTimeout(2000);
  }
  throw new Error("렌더 대기 시간 초과");
}

try {
  // ───────── 1. 한 장 시작 ─────────
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => step("pageerror: " + e.message));
  let t = timer();
  await login(page, VE, VP);
  await page.screenshot({ path: `${OUT}/01_home.png` });
  await page.fill("input[placeholder^='예: 성수동']", `E2E 한 장 시작 ${Date.now() % 100000}`);
  await page.click("button:has-text('만들기')");
  await page.waitForURL(/\/studio\/r\//);
  step("프로젝트 생성 " + t());
  t = timer();
  const v = gt.views[0];
  await page.setInputFiles(".side input[type=file]", "samples/room/view1.jpg");
  await page.waitForSelector(".view canvas");
  step("방 사진 업로드 " + t());
  // 기준점(방 좌표) 입력
  t = timer();
  await page.click("button:has-text('좌표 편집')");
  const ids = Object.keys(v.points);
  for (const id of ids) {
    await page.click("button:has-text('+ 점')");
    const blocks = page.locator(".side.right .col > .col");
    const blk = blocks.nth((await blocks.count()) - 1);
    const ins = blk.locator("input");
    await ins.nth(0).fill(id);
    await ins.nth(1).fill(gt.points[id].label);
    const w = gt.points[id].world;
    await ins.nth(2).fill(String(Math.round(w[0] * 1000) / 10));
    await ins.nth(3).fill(String(Math.round(w[1] * 1000) / 10));
    await ins.nth(4).fill(String(Math.round(w[2] * 1000) / 10));
  }
  await page.click("button:has-text('기준점 저장')");
  await page.waitForSelector(`.refpt:has-text('${ids[0]}')`);
  // 사진에서 기준점 클릭
  for (const id of ids) {
    await page.click(`.refpt:has(b:text-is('${id}'))`);
    const [u, vv] = v.points[id];
    const pt = await stagePoint(page, u, vv, v.width, v.height);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(150);
  }
  await page.waitForSelector(".side.right .chip.warn:has-text('추정')", { timeout: 15000 });
  step(`기준점 ${ids.length}개 입력·클릭 → 보정 '추정' ` + t());
  await page.screenshot({ path: `${OUT}/03_calibration.png` });
  // 가구 등록(카탈로그) 후 이동
  t = timer();
  await page.click(".tabs .tab:has-text('배치')");
  await page.click(".prod:has-text('터프티드 가죽 3인 소파')");
  await page.waitForFunction(() => window.__studioPreviewReady === true, null, { timeout: 120000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/04_placed.png` });
  step("가구 배치(카탈로그 클릭) " + t());
  // 드래그 이동: 가구 중심을 왼쪽으로
  const box = await page.locator(".stage .overlay").boundingBox();
  const fx = box.x + box.width * 0.5, fy = box.y + box.height * 0.86;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  await page.mouse.move(fx - 120, fy - 20, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/04b_dragged.png` });
  await page.click(".side.right .refpt:has-text('터프티드')");
  // 치수·회전 정밀 입력
  t = timer();
  const num = page.locator(".side.right .num label.f input");
  await num.nth(0).fill("200");
  await num.nth(0).press("Enter");
  await page.waitForSelector(".chip.bad:has-text('비규격 크기')");
  step("폭 200cm → '비규격 크기' 표시 확인");
  await page.locator(".side.right select.in").first().selectOption({ index: 0 });
  await page.waitForTimeout(300);
  await num.nth(5).fill("15");
  await num.nth(5).press("Enter");
  await num.nth(3).fill("70");
  await num.nth(3).press("Enter");
  await num.nth(4).fill("50");
  await num.nth(4).press("Enter");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/05_adjusted.png` });
  step("치수 옵션 복귀 · 위치 X70/Z50cm · 회전 15° " + t());
  // 렌더
  t = timer();
  await page.click(".side.right .tab:has-text('검수·렌더')");
  await page.click("button:has-text('보정된 모든 시점 렌더')");
  await waitJobsDone(page, 1);
  step("최종 합성 렌더 완료 (CPU SwiftShader) " + t());
  await page.click(".stage-tools .tab:has-text('합성')");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/06_composite.png` });
  await page.locator(".stage-tools input[type=range]").fill("50");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/07_compare_slider.png` });
  await page.locator(".stage-tools input[type=range]").fill("0");
  await page.click(".stage-tools .tab:has-text('100%')");
  await page.waitForTimeout(2500);
  const sc = page.locator(".stage-scroll");
  await sc.evaluate((el) => {
    el.scrollLeft = el.scrollWidth * 0.45;
    el.scrollTop = el.scrollHeight * 0.55;
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/08_zoom100.png` });
  await page.click(".stage-tools .tab:has-text('전체')");
  // 무손실 마스터 다운로드
  await page.click("button:has-text('다운로드')");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("a:has-text('마스터 PNG')")]);
  const masterPath = `${OUT}/09_master_${dl.suggestedFilename()}`;
  await dl.saveAs(masterPath);
  step(`무손실 마스터 다운로드: ${dl.suggestedFilename()} (${fs.statSync(masterPath).size} bytes)`);
  await page.keyboard.press("Escape");
  await page.click(".modal-bg", { position: { x: 5, y: 5 } });

  // ───────── 2. 샘플: 여러 시점·A/B·공유 ─────────
  t = timer();
  await page.goto(`${BASE}/studio`);
  await page.click("text=샘플 프로젝트 열기");
  await page.waitForURL(/\/studio\/r\//, { timeout: 60000 });
  await page.waitForFunction(() => window.__studioPreviewReady === true, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/10_sample_multiview.png` });
  step("샘플(3시점) 열기 " + t());
  // A안: 시점1 첫 가구 30cm 이동 + 15° (방향키 Shift 3번 = 30cm, Shift+E = 15°)
  await page.click(".side.right .refpt:has-text('터프티드')");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+E");
  await page.waitForFunction(() => /회전/.test(document.querySelector(".side.right ul.tiny")?.textContent ?? ""), null, { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/11_moved_30cm_15deg.png` });
  const summary = await page.locator(".side.right ul.tiny").innerText();
  step("A안 변경 요약: " + summary.replace(/\n/g, " | "));
  // 다른 시점에도 반영 확인(시점 2 선택)
  await page.click(".view:has-text('시점 2')");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/12_view2_reflects.png` });
  // 두 안 모두 2개 시점 렌더
  t = timer();
  await page.click(".side.right .tab:has-text('검수·렌더')");
  await page.click("button:has-text('보정된 모든 시점 렌더')");
  await page.click(".bar .tab:has-text('B안')");
  await page.waitForTimeout(500);
  await page.click(".side.right .tab:has-text('검수·렌더')");
  await page.click("button:has-text('보정된 모든 시점 렌더')");
  await waitJobsDone(page, 3, 400000);
  await page.click(".bar .tab:has-text('A안')");
  await page.click(".side.right .tab:has-text('검수·렌더')");
  await waitJobsDone(page, 3, 400000);
  step("A·B 각 3시점 렌더 완료 " + t());
  await page.screenshot({ path: `${OUT}/13_qa_panel.png` });
  await page.click("button:has-text('A/B 비교')");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/14_ab_compare.png` });
  await page.click(".modal button:has-text('닫기')");
  // 공유
  await page.click(".bar button:has-text('공유')");
  await page.fill(".modal input >> nth=1", "김고객");
  await page.click("button:has-text('공유 링크 만들기')");
  const link = await page.locator(".modal input[readonly]").inputValue();
  step("공유 링크 생성: " + link.replace(/\/s\/.+/, "/s/…"));
  await page.screenshot({ path: `${OUT}/15_share_dialog.png` });
  await page.click(".modal button:has-text('닫기')");
  // 고객(모바일, 로그인 없음)
  const mctx = await browser.newContext({ ...devices["iPhone 13"] });
  const m = await mctx.newPage();
  await m.goto(link);
  await m.waitForSelector("text=배치 시뮬레이션");
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${OUT}/16_client_mobile.png`, fullPage: true });
  await m.click(".tab:has-text('B안')");
  await m.fill("input[placeholder='이름']", "김고객");
  await m.fill("textarea", "B안 좋네요. 소파만 창 쪽으로 조금 옮겨 주세요");
  await m.click("button:has-text('B안에 의견 남기기')");
  await m.waitForSelector("text=의견이 전달되었습니다");
  await m.click("button:has-text('이 버전 승인')");
  await m.waitForSelector("text=승인됨");
  await m.screenshot({ path: `${OUT}/17_client_approved.png`, fullPage: true });
  step("고객: B안 의견 + 승인 (모바일)");
  // 업체: 승인 후 B안 수정 → 새 버전
  await page.click(".bar .tab:has-text('B안')");
  await page.waitForTimeout(800);
  const badgeBefore = await page.locator(".bar .chip").first().innerText();
  await page.click(".side.right .tab:has-text('배치')");
  await page.click(".side.right .refpt >> nth=0");
  await page.keyboard.press("Shift+ArrowUp");
  await page.waitForFunction(() => /v2/.test(document.querySelector(".bar .chip")?.textContent ?? ""), null, { timeout: 20000 });
  const badgeAfter = await page.locator(".bar .chip").first().innerText();
  step(`승인 후 수정: ${badgeBefore} → ${badgeAfter}`);
  await m.reload();
  await m.click(".tab:has-text('B안')");
  await m.waitForSelector("text=승인됨");
  const ver = await m.locator(".card h2 .tiny").first().innerText();
  step(`고객 링크는 승인 버전 그대로 유지 (${ver})`);
  // 상담 요청 → 운영자 확인
  await page.click("button:has-text('스테이신 상담')");
  await page.fill(".modal textarea", "B안 가죽 질감 정밀 합성 요청");
  await page.click("button:has-text('요청 보내기')");
  await page.waitForSelector("text=요청이 접수되었습니다");
  await page.click(".modal button:has-text('닫기')");
  // 공유 중지
  await page.click(".bar button:has-text('공유')");
  await page.click(".modal button:has-text('공유 중지') >> nth=0");
  await page.waitForTimeout(800);
  await m.reload();
  await m.waitForSelector("text=공유가 중지된 링크입니다");
  await m.screenshot({ path: `${OUT}/18_client_revoked.png` });
  step("공유 중지 후 고객 링크 차단 확인");
  await mctx.close();

  // ───────── 3. 운영자 ─────────
  const octx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const o = await octx.newPage();
  await login(o, OE, OP);
  await o.goto(`${BASE}/studio/ops`);
  await o.waitForSelector("text=상담 요청");
  await o.click("table.t tbody tr >> nth=0");
  await o.waitForTimeout(2500);
  await o.screenshot({ path: `${OUT}/19_ops_consult.png`, fullPage: true });
  step("운영: 상담 요청과 포함 자료만 열람");
  await octx.close();
  await ctx.close();
  step("완료");
} catch (e) {
  step("실패: " + (e?.stack ?? e));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/e2e-log.txt`, log.join("\n") + "\n");
  await browser.close();
}
