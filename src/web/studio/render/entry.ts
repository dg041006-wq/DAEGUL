// 렌더 워커 페이지 진입점 (헤드리스 Chromium에서 실행). 편집기와 같은 scene.ts를 사용한다.
import { buildScene, makeRenderer, renderTile, setPass, type BuiltScene, type SceneSpec } from "./scene";

let built: BuiltScene | null = null;
let renderer: ReturnType<typeof makeRenderer> | null = null;
let current: SceneSpec | null = null;

function toB64(u8: Uint8Array) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  return btoa(s);
}

(window as any).__studioPrepare = async (spec: SceneSpec) => {
  built?.dispose();
  current = spec;
  built = await buildScene(spec);
  if (!renderer) {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    renderer = makeRenderer(canvas);
  }
  const gl = renderer.getContext();
  return { ok: true, maxSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), renderer: "three r170" };
};

(window as any).__studioTile = (pass: "furniture" | "shadow", x: number, y: number, w: number, h: number) => {
  if (!built || !renderer || !current) throw new Error("not prepared");
  setPass(built, pass);
  const px = renderTile(renderer, built, { width: current.camera.width, height: current.camera.height }, x, y, w, h, current.exposure);
  return toB64(px);
};

(window as any).__studioReady = true;
