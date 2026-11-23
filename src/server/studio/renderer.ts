// 3D 렌더 워커: 헤드리스 Chromium(SwiftShader WebGL2)에서 편집기와 같은 three.js 장면을 원본 해상도로 렌더.
// Chromium이 없으면 RendererUnavailable — 편집 화면의 배치 미리보기는 브라우저에서 계속 동작한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { studioConfig } from "./config.js";

export class RendererUnavailable extends Error {
  code = "renderer_unavailable";
}

let browserP: Promise<any> | null = null;
let bundleCache: string | null = null;

const CANDIDATE_PATHS = ["/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];

export function findChromium(): string | null {
  if (studioConfig.chromiumPath) return fs.existsSync(studioConfig.chromiumPath) ? studioConfig.chromiumPath : null;
  for (const p of CANDIDATE_PATHS) if (fs.existsSync(p)) return p;
  try {
    const dir = "/opt/pw-browsers";
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, "chrome-linux64", "chrome");
      if (d.startsWith("chromium-") && fs.existsSync(p)) return p;
    }
  } catch {
    /* none */
  }
  return null;
}

async function loadBundle(): Promise<string> {
  if (bundleCache) return bundleCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve("dist-render/render.js"), path.resolve(here, "../../../dist-render/render.js"), path.resolve(here, "../../../../dist-render/render.js")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found && process.env.NODE_ENV === "production") {
    bundleCache = fs.readFileSync(found, "utf8");
    return bundleCache;
  }
  // 개발·테스트: 소스에서 즉시 번들 (esbuild는 vite 의존성으로 설치됨)
  try {
    const { buildRenderBundle } = await import(path.resolve("scripts/build-render.mjs") as string);
    const out = await buildRenderBundle();
    bundleCache = fs.readFileSync(out, "utf8");
    return bundleCache;
  } catch (e) {
    if (found) {
      bundleCache = fs.readFileSync(found, "utf8");
      return bundleCache;
    }
    throw new RendererUnavailable("렌더 번들을 만들 수 없습니다: " + String((e as Error).message));
  }
}

async function getBrowser() {
  if (!browserP) {
    browserP = (async () => {
      const exe = findChromium();
      if (!exe) throw new RendererUnavailable("Chromium 실행 파일을 찾지 못했습니다(STUDIO_CHROMIUM_PATH 설정 필요).");
      let chromium: any;
      try {
        ({ chromium } = await import("playwright-core"));
      } catch {
        throw new RendererUnavailable("playwright-core가 설치되어 있지 않습니다.");
      }
      return chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"] });
    })().catch((e) => {
      browserP = null;
      throw e instanceof RendererUnavailable ? e : new RendererUnavailable(String(e?.message ?? e));
    });
  }
  return browserP;
}

export async function closeRenderer() {
  if (browserP) {
    const b = await browserP.catch(() => null);
    browserP = null;
    await b?.close().catch(() => {});
  }
}

export interface LayerResult {
  furniture: Buffer; // RGBA 프리멀티플라이드, width*height*4
  shadow: Buffer; // RGBA, 알파 = 그림자 농도
  tiles: number;
  ms: number;
}

/** files: URL 경로(/f/<id>) → 바이트 */
export async function renderLayers(spec: any, files: Map<string, { mime: string; data: Buffer }>): Promise<LayerResult> {
  const t0 = Date.now();
  const bundle = await loadBundle();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.route("https://render.local/**", async (route: any) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/" || u.pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body style='margin:0'></body></html>" });
      if (u.pathname === "/render.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
      const f = files.get(u.pathname);
      if (!f) return route.fulfill({ status: 404, body: "missing" });
      return route.fulfill({ contentType: f.mime, body: f.data });
    });
    await page.goto("https://render.local/index.html");
    await page.addScriptTag({ url: "https://render.local/render.js" });
    await page.waitForFunction(() => (globalThis as any).__studioReady === true, null, { timeout: 15000 });
    const prep = await page.evaluate((s: any) => (globalThis as any).__studioPrepare(s), spec);
    const W = spec.camera.width, H = spec.camera.height;
    const T = Math.min(2048, prep.maxSize || 2048);
    const furniture = Buffer.alloc(W * H * 4);
    const shadow = Buffer.alloc(W * H * 4);
    let tiles = 0;
    for (const pass of ["furniture", "shadow"] as const) {
      const target = pass === "furniture" ? furniture : shadow;
      for (let y = 0; y < H; y += T)
        for (let x = 0; x < W; x += T) {
          const w = Math.min(T, W - x), h = Math.min(T, H - y);
          const b64: string = await page.evaluate(([p, a, b, c, d]: any) => (globalThis as any).__studioTile(p, a, b, c, d), [pass, x, y, w, h]);
          const tile = Buffer.from(b64, "base64");
          for (let row = 0; row < h; row++) tile.copy(target, ((y + row) * W + x) * 4, row * w * 4, (row + 1) * w * 4);
          tiles++;
        }
    }
    return { furniture, shadow, tiles, ms: Date.now() - t0 };
  } finally {
    await page.close().catch(() => {});
  }
}
