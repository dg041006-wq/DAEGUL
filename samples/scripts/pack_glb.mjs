// glTF(.gltf + .bin + 텍스처) → 단일 GLB 패킹, 그리고 실제 형상 경계 상자(노드 변환 포함) 측정.
// 사용: node samples/scripts/pack_glb.mjs <input.gltf> <output.glb>
import fs from "node:fs";
import path from "node:path";

export function packGltf(input) {
  const dir = path.dirname(input);
  const gltf = JSON.parse(fs.readFileSync(input, "utf8"));
  const chunks = [];
  let offset = 0;
  const pad4 = (n) => (n + 3) & ~3;
  const push = (buf) => {
    const start = offset;
    chunks.push(buf);
    const padded = pad4(buf.length);
    if (padded > buf.length) chunks.push(Buffer.alloc(padded - buf.length));
    offset += padded;
    return start;
  };
  // 기존 버퍼들을 하나로 합치고 bufferView 오프셋 재배치
  const bufferStarts = gltf.buffers.map((b) => push(fs.readFileSync(path.join(dir, decodeURIComponent(b.uri)))));
  for (const bv of gltf.bufferViews) {
    bv.byteOffset = (bv.byteOffset ?? 0) + bufferStarts[bv.buffer];
    bv.buffer = 0;
  }
  for (const img of gltf.images ?? []) {
    if (!img.uri) continue;
    const data = fs.readFileSync(path.join(dir, decodeURIComponent(img.uri)));
    const start = push(data);
    gltf.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: data.length });
    img.bufferView = gltf.bufferViews.length - 1;
    img.mimeType = img.uri.endsWith(".png") ? "image/png" : "image/jpeg";
    delete img.uri;
  }
  const bin = Buffer.concat(chunks);
  gltf.buffers = [{ byteLength: bin.length }];
  let json = Buffer.from(JSON.stringify(gltf), "utf8");
  json = Buffer.concat([json, Buffer.alloc(pad4(json.length) - json.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(json.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, json, bh, bin]);
}

if (process.argv[2] && process.argv[3]) {
  const out = packGltf(process.argv[2]);
  fs.writeFileSync(process.argv[3], out);
  console.log(process.argv[3], out.length);
}
