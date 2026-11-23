// 사진 정규화·EXIF 정리·마스크 래스터화·합성·원본 보존 검사
import sharp from "sharp";
import { studioConfig } from "./config.js";
import { HttpError } from "./auth.js";

sharp.cache(false);

// ───────── EXIF (필요한 값만 읽는 최소 TIFF 파서) ─────────
export interface CleanExif {
  make?: string;
  model?: string;
  orientation?: number;
  focalLengthMm?: number;
  focal35mm?: number;
  hasGps: boolean;
}

export function parseExif(buf: Buffer | undefined): CleanExif {
  const out: CleanExif = { hasGps: false };
  if (!buf || buf.length < 14) return out;
  let off = buf.indexOf("Exif\0\0") === 0 ? 6 : 0;
  const tiff = buf.subarray(off);
  if (tiff.length < 8) return out;
  const le = tiff.toString("ascii", 0, 2) === "II";
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const readIfd = (o: number, cb: (tag: number, type: number, count: number, valOff: number) => void) => {
    if (o + 2 > tiff.length) return;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > tiff.length) return;
      cb(u16(e), u16(e + 2), u32(e + 4), e + 8);
    }
  };
  const str = (count: number, valOff: number) => {
    const p = count > 4 ? u32(valOff) : valOff;
    return tiff.toString("latin1", p, p + count).replace(/\0+$/, "").trim().slice(0, 60);
  };
  const rational = (valOff: number) => {
    const p = u32(valOff);
    const d = u32(p + 4);
    return d ? u32(p) / d : undefined;
  };
  try {
    let exifIfd = 0;
    readIfd(u32(4), (tag, type, count, v) => {
      if (tag === 0x010f) out.make = str(count, v);
      else if (tag === 0x0110) out.model = str(count, v);
      else if (tag === 0x0112) out.orientation = u16(v);
      else if (tag === 0x8769) exifIfd = u32(v);
      else if (tag === 0x8825) out.hasGps = true;
    });
    if (exifIfd)
      readIfd(exifIfd, (tag, type, _c, v) => {
        if (tag === 0x920a) out.focalLengthMm = rational(v);
        else if (tag === 0xa405) out.focal35mm = type === 3 ? u16(v) : u32(v);
      });
  } catch {
    /* 손상된 EXIF는 무시 */
  }
  return out;
}

// ───────── 업로드 정규화 ─────────
export interface NormalizedPhoto {
  master: Buffer; // 방향 적용, sRGB, 무손실 PNG, 메타데이터 없음
  preview: Buffer; // JPEG, 긴 변 1600
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  exif: CleanExif;
  format: string;
}

const ALLOWED = new Set(["jpeg", "png", "webp", "heif", "tiff"]);

export async function normalizePhoto(original: Buffer): Promise<NormalizedPhoto> {
  if (original.length > studioConfig.maxUploadBytes) throw new HttpError(413, `파일이 너무 큽니다(최대 ${Math.round(studioConfig.maxUploadBytes / 1048576)}MB).`, "too_large");
  let meta: sharp.Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: studioConfig.maxPhotoPixels }).metadata();
  } catch {
    throw new HttpError(415, "사진 파일로 읽을 수 없습니다. JPEG·PNG·WebP·HEIC를 올려 주세요.", "unsupported");
  }
  if (!meta.format || !ALLOWED.has(meta.format)) throw new HttpError(415, `지원하지 않는 형식(${meta.format ?? "알 수 없음"})입니다.`, "unsupported");
  if (!meta.width || !meta.height) throw new HttpError(415, "이미지 크기를 읽을 수 없습니다.", "unsupported");
  if (meta.width * meta.height > studioConfig.maxPhotoPixels) throw new HttpError(413, "픽셀 수가 너무 많습니다.", "too_many_pixels");
  if (Math.max(meta.width, meta.height) < studioConfig.minPhotoLongSide) throw new HttpError(422, `긴 변이 ${studioConfig.minPhotoLongSide}px 이상인 사진이 필요합니다.`, "too_small");
  const exif = parseExif(meta.exif);
  const base = sharp(original, { limitInputPixels: studioConfig.maxPhotoPixels }).rotate().toColorspace("srgb").removeAlpha();
  const { data: master, info } = await base.clone().png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  const scaleP = Math.min(1, studioConfig.previewLongSide / Math.max(info.width, info.height));
  const pw = Math.round(info.width * scaleP), ph = Math.round(info.height * scaleP);
  const preview = await sharp(master).resize(pw, ph, { kernel: "lanczos3" }).jpeg({ quality: 88 }).toBuffer();
  return { master, preview, width: info.width, height: info.height, previewWidth: pw, previewHeight: ph, exif, format: meta.format };
}

export async function decodeRGB(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function decodeRGBA(png: Buffer, width: number, height: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw new Error(`layer size mismatch ${info.width}x${info.height} vs ${width}x${height}`);
  return data;
}

// ───────── 마스크 래스터화 (다각형, 짝수-홀수 규칙, 1/4 서브샘플 안티앨리어싱 없음: 결정적) ─────────
export type Polygon = [number, number][];

export function rasterizePolygons(polys: Polygon[], width: number, height: number): Uint8Array {
  const m = new Uint8Array(width * height);
  for (const poly of polys) {
    if (poly.length < 3) continue;
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of poly) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (yi > sy !== yj > sy) xs.push(xi + ((sy - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
        for (let x = a; x <= b; x++) m[y * width + x] = 255;
      }
    }
  }
  return m;
}

// ───────── 합성 ─────────
export interface ComposeInput {
  base: Buffer; // 정규화 원본 RGB raw
  width: number;
  height: number;
  furniture: Buffer; // RGBA raw, 프리멀티플라이드 알파 (WebGL 출력 그대로)
  shadow: Buffer; // RGBA raw, 알파 = 그림자 농도
  occluder: Uint8Array; // 255 = 전경 가림(가구보다 앞)
  protect: Uint8Array; // 255 = 보호 영역(절대 변경 금지)
  grainSigma: number; // 0..
  seed: number;
  shadowTint?: [number, number, number]; // 그림자 채널별 감쇠 비율
  wb?: [number, number, number]; // 시점별 화이트밸런스(가구에만)
}

export interface ComposeQA {
  width: number;
  height: number;
  allowedPixels: number; // 변경 허용 픽셀 수
  changedPixels: number; // 실제 변경된 픽셀 수
  changedOutsideAllowed: number; // 허용 마스크 밖 변경 (반드시 0)
  changedInProtected: number; // 보호 영역 변경 (반드시 0)
  occludedFurniturePixels: number; // 가림·보호로 숨겨진 가구 픽셀
  bbox: [number, number, number, number] | null;
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 최종 합성: 변경 허용 마스크 = (가구 알파 ∪ 그림자) ∩ ¬가림 ∩ ¬보호.
 * 허용 마스크 밖은 원본 바이트를 그대로 복사한다(재계산 아님).
 */
export function compose(i: ComposeInput): { rgb: Buffer; allowed: Uint8Array; qa: ComposeQA } {
  const { width: W, height: H } = i;
  const n = W * H;
  const out = Buffer.from(i.base); // 복사본 — 기본값 = 원본
  const allowed = new Uint8Array(n);
  const rnd = mulberry32(i.seed);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const tint = i.shadowTint ?? [1, 1, 1];
  let occluded = 0, allowedCount = 0;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let p = 0; p < n; p++) {
    const fa = i.furniture[p * 4 + 3] / 255;
    const sa = i.shadow[p * 4 + 3] / 255;
    if (fa === 0 && sa === 0) continue;
    const blocked = i.occluder[p] || i.protect[p];
    if (blocked) {
      if (fa > 0) occluded++;
      continue;
    }
    allowed[p] = 1;
    allowedCount++;
    const x = p % W, y = (p / W) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const noise = i.grainSigma > 0 && fa > 0 ? gauss() * i.grainSigma : 0;
    for (let c = 0; c < 3; c++) {
      const b = i.base[p * 3 + c];
      // 그림자: 곱셈 (섀도 캐처와 같은 의미 — 바닥 원본 질감 유지). tint = 채널별 감쇠 비율(1 = 중립)
      const s2 = b * (1 - sa * tint[c]);
      const f = i.furniture[p * 4 + c] * (i.wb?.[c] ?? 1) + noise * fa;
      const v = f + s2 * (1 - fa);
      out[p * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  // 검사: 허용 밖 동일성 · 보호 영역 동일성
  let changed = 0, outside = 0, inProtected = 0;
  for (let p = 0; p < n; p++) {
    const d = out[p * 3] !== i.base[p * 3] || out[p * 3 + 1] !== i.base[p * 3 + 1] || out[p * 3 + 2] !== i.base[p * 3 + 2];
    if (!d) continue;
    changed++;
    if (!allowed[p]) outside++;
    if (i.protect[p]) inProtected++;
  }
  return {
    rgb: out,
    allowed,
    qa: {
      width: W,
      height: H,
      allowedPixels: allowedCount,
      changedPixels: changed,
      changedOutsideAllowed: outside,
      changedInProtected: inProtected,
      occludedFurniturePixels: occluded,
      bbox: maxX >= 0 ? [minX, minY, maxX, maxY] : null,
    },
  };
}

/** 저장된 무손실 마스터를 다시 디코드해 원본과 마스크 밖 동일성을 독립 검증 */
export async function verifyMasterPreservation(masterPng: Buffer, base: Buffer, allowed: Uint8Array, width: number, height: number) {
  const dec = await decodeRGB(masterPng);
  if (dec.width !== width || dec.height !== height) return { ok: false, sizeMatch: false, diffOutside: -1 };
  let diff = 0;
  for (let p = 0; p < width * height; p++) {
    if (allowed[p]) continue;
    if (dec.data[p * 3] !== base[p * 3] || dec.data[p * 3 + 1] !== base[p * 3 + 1] || dec.data[p * 3 + 2] !== base[p * 3 + 2]) diff++;
  }
  return { ok: diff === 0, sizeMatch: true, diffOutside: diff };
}

/** 노이즈 추정: 밝기 라플라시안의 중앙 절대편차(평탄 영역 위주) → 가우시안 σ (0..255) */
export function estimateNoiseSigma(rgb: Buffer, width: number, height: number): number {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 200000)));
  const L = (x: number, y: number) => {
    const p = (y * width + x) * 3;
    return 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
  };
  for (let y = 1; y < height - 1; y += step)
    for (let x = 1; x < width - 1; x += step) {
      const lap = 4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1);
      vals.push(Math.abs(lap));
    }
  vals.sort((a, b) => a - b);
  // 하위 50%(평탄 영역)의 중앙값 → σ 추정 (라플라시안 분산 = 20σ²)
  const flat = vals.slice(0, Math.max(1, Math.floor(vals.length / 2)));
  const med = flat[Math.floor(flat.length / 2)] ?? 0;
  return Math.min(8, (med / 0.6745) / Math.sqrt(20));
}

export async function encodeMaster(rgb: Buffer, width: number, height: number) {
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer();
}
export async function encodeDelivery(rgb: Buffer, width: number, height: number) {
  // 전달용 JPEG: 메타데이터(위치 포함) 제거, sRGB
  return sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
}
export async function encodePreview(rgb: Buffer, width: number, height: number) {
  const s = Math.min(1, 1600 / Math.max(width, height));
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(Math.round(width * s), Math.round(height * s))
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * 상품 사진 배경 제거(경로 B): 이미 투명 PNG면 그대로, 단색 배경이면 테두리에서 연결된 배경을 지운다.
 * 제품 픽셀은 바꾸지 않는다(알파만 생성). 배경이 복잡하면 실패로 알리고 투명 PNG를 요청한다.
 */
export async function autoCutout(input: Buffer): Promise<{ png: Buffer | null; method: "alpha" | "uniform_bg" | "failed"; note: string; width: number; height: number }> {
  const img = sharp(input).rotate().toColorspace("srgb");
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(0 * W + x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const transparentBorder = border.filter((p) => data[p * 4 + 3] < 20).length / border.length;
  const finish = async (buf: Buffer, method: "alpha" | "uniform_bg", note: string) => {
    const png = await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    return { png: png.data, method, note, width: png.info.width, height: png.info.height };
  };
  if (transparentBorder > 0.9) return finish(data, "alpha", "투명 배경 PNG를 그대로 사용했습니다.");
  // 테두리 색 통계
  const med = [0, 1, 2].map((c) => {
    const v = border.map((p) => data[p * 4 + c]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  });
  const dist = (p: number) => Math.hypot(data[p * 4] - med[0], data[p * 4 + 1] - med[1], data[p * 4 + 2] - med[2]);
  const uniform = border.filter((p) => dist(p) < 24).length / border.length;
  if (uniform < 0.85) return { png: null, method: "failed", note: "배경이 단색이 아니라 자동으로 지우지 못했습니다. 배경이 투명한 PNG를 올려 주세요.", width: W, height: H };
  const out = Buffer.from(data);
  const seen = new Uint8Array(W * H);
  const stack: number[] = border.filter((p) => dist(p) < 30);
  for (const p of stack) seen[p] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    out[p * 4 + 3] = 0;
    const x = p % W, y = (p / W) | 0;
    const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
    for (const n of nb) if (n >= 0 && !seen[n] && dist(n) < 30) {
      seen[n] = 1;
      stack.push(n);
    }
  }
  return finish(out, "uniform_bg", "단색 배경을 자동으로 지웠습니다. 가장자리를 확대해 확인하세요.");
}
