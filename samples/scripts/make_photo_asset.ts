// 경로 B 테스트용 '상품 사진': sofa_03 3D 모델을 정면(고도 8°)에서 흰 배경으로 렌더한 이미지 1장.
// 실행: npx tsx samples/scripts/make_photo_asset.ts
import fs from "node:fs";
import sharp from "sharp";
import { renderLayers, closeRenderer } from "../../src/server/studio/renderer.js";
import { matMul, rotX } from "../../src/shared/studio/geometry.js";

const W = 1600, H = 900, dist = 4.2, el = 8;
const f = 2100;
const R = matMul([1, 0, 0, 0, 1, 0, 0, 0, 1], rotX(-el));
const C = [0, 0.56 + dist * Math.sin((el * Math.PI) / 180), dist * Math.cos((el * Math.PI) / 180)];
const files = new Map([["/f/m", { mime: "model/gltf-binary", data: fs.readFileSync("samples/assets/sofa_03.glb") }]]);
const L = await renderLayers(
  {
    camera: { width: W, height: H, f, cx: W / 2, cy: H / 2, R, C },
    placements: [{ id: "p", kind: "model3d", url: "https://render.local/f/m", dims: { w: 273, d: 93, h: 112 }, position: { x: 0, z: 0 }, rotationDeg: 0, frontAxis: "+Z" }],
    lighting: { sunAzimuthDeg: 20, sunElevationDeg: 50, sunIntensity: 2, colorTempK: 5600, softness: 0.8, ambient: 1.3, shadowStrength: 0, contactShadow: 0 },
    exposure: 0.2,
    envUrl: null,
  },
  files as any,
);
const out = Buffer.alloc(W * H * 3);
for (let p = 0; p < W * H; p++) {
  const a = L.furniture[p * 4 + 3] / 255;
  for (let c = 0; c < 3; c++) out[p * 3 + c] = Math.min(255, Math.round(L.furniture[p * 4 + c] + 248 * (1 - a)));
}
await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile("samples/assets/sofa_03_front.png");
await closeRenderer();
console.log("samples/assets/sofa_03_front.png");
