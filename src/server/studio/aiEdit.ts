// 이미지 편집 API 어댑터(선택): 렌더 합성본의 '접지·경계'만 다듬는 용도.
// 공식 문서상 GPT image 모델의 마스크는 '가이드'일 뿐 정확히 지켜지지 않는다 → API가 돌려준 전체 이미지는 절대 그대로 쓰지 않고,
// 파이프라인의 변경 허용 마스크 안에서만 결과를 받아들이고 그 밖은 원본 픽셀로 복원한다.
// 확인 필요(실계정 미검증): 마스크 알파 의미(투명=편집 영역으로 가정), 모델별 마스크 지원 여부.
import sharp from "sharp";
import { q, q1 } from "../db/pool.js";
import { studioConfig } from "./config.js";
import { getFileRow, putFile, readFile } from "./storage.js";
import { decodeRGB, encodeDelivery, encodeMaster, encodePreview } from "./images.js";
import { HttpError } from "./auth.js";

export interface AiEditResult {
  fileIds: { master: string; delivery: string; preview: string };
  qa: { changedOutsideAllowed: number; acceptedPixels: number; rejectedOutsidePixels: number; productCorePixelsKept: number };
  provider: string;
  model: string;
}

/** 편집 API 요청 크기: 16의 배수, 긴 변 최대 1536 (비용·지연 제한) */
function apiSize(w: number, h: number) {
  const s = Math.min(1, 1536 / Math.max(w, h));
  const r16 = (x: number) => Math.max(256, Math.round((x * s) / 16) * 16);
  return { w: r16(w), h: r16(h) };
}

/**
 * mode "edges": 가구 형상 내부(알파 ≥ 0.98, 3px 침식)는 3D 렌더 그대로 고정하고, 경계·그림자 띠만 API 결과를 받는다.
 */
export async function runAiEdit(job: any, opts: { prompt?: string } = {}): Promise<AiEditResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new HttpError(503, "이미지 편집 API 키(OPENAI_API_KEY)가 설정되지 않았습니다.", "ai_not_configured");
  if (job.status !== "done") throw new HttpError(409, "완료된 렌더에만 적용할 수 있습니다.");
  const ws = await q1<any>(`SELECT limits FROM studio_workspaces WHERE id=$1`, [job.workspace_id]);
  const limit = Number(ws?.limits?.monthlyAiEdits ?? 0);
  const used = (await q1<any>(`SELECT count(*)::int AS n FROM studio_usage WHERE workspace_id=$1 AND kind='ai_edit' AND created_at > date_trunc('month', now())`, [job.workspace_id]))!.n;
  if (used >= limit) throw new HttpError(429, `AI 보정 한도(${limit}회/월)를 넘었습니다. 운영자가 한도를 열어야 사용할 수 있습니다.`, "limit");

  const orig = await decodeRGB(await readFile((await getFileRow(job.inputs.photo.masterFileId))!));
  const master = await decodeRGB(await readFile((await getFileRow(job.outputs.masterFileId))!));
  const allowedRaw = await sharp(await readFile((await getFileRow(job.outputs.allowedMaskFileId))!)).greyscale().raw().toBuffer();
  const alphaRaw = await sharp(await readFile((await getFileRow(job.outputs.alphaFileId))!)).ensureAlpha().extractChannel(3).raw().toBuffer();
  const W = orig.width, H = orig.height;
  // 고정 영역: 가구 불투명 내부를 3px 침식
  // 주의: sharp(libvips)에서는 흰 영역을 줄이는 쪽이 dilate()다(검은색을 전경으로 취급). 테스트로 확인함.
  const core = await sharp(Buffer.from(alphaRaw.map((a) => (a >= 250 ? 255 : 0))), { raw: { width: W, height: H, channels: 1 } }).dilate(3).toColourspace("b-w").raw().toBuffer();
  const editable = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) editable[p] = allowedRaw[p] > 127 && core[p] < 128 ? 1 : 0;

  const sz = apiSize(W, H);
  const imagePng = await sharp(master.data, { raw: { width: W, height: H, channels: 3 } }).resize(sz.w, sz.h).png().toBuffer();
  // 마스크: 편집 허용 = 투명(알파 0), 나머지 = 불투명 (가정 — 실계정 확인 필요)
  const maskRGBA = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) maskRGBA[p * 4 + 3] = editable[p] ? 0 : 255;
  const maskPng = await sharp(maskRGBA, { raw: { width: W, height: H, channels: 4 } }).resize(sz.w, sz.h, { kernel: "nearest" }).png().toBuffer();

  const model = studioConfig.openaiImageModel;
  const form = new FormData();
  form.append("model", model);
  form.append("image[]", new Blob([imagePng], { type: "image/png" }), "image.png");
  form.append("mask", new Blob([maskPng], { type: "image/png" }), "mask.png");
  form.append("prompt", opts.prompt ?? "Refine only the contact shadows and edges where the furniture meets the floor so it looks naturally photographed in this room. Do not change the furniture design, the floor, walls, windows or any other part of the photo.");
  form.append("size", `${sz.w}x${sz.h}`);
  form.append("n", "1");
  // 보낸 자료 기록(본문·키·서명 URL 없이 파일 id와 용도만)
  await q(`INSERT INTO studio_provider_log(workspace_id, provider, job_id, sent) VALUES ($1,'openai',$2,$3)`, [job.workspace_id, job.id, { purpose: "edge_refine", model, renderMasterFileId: job.outputs.masterFileId, maskFrom: job.outputs.allowedMaskFileId, size: `${sz.w}x${sz.h}` }]);
  const t0 = Date.now();
  const res = await fetch(`${studioConfig.openaiBaseUrl}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 300);
    await q(`UPDATE studio_provider_log SET result=$2 WHERE id=(SELECT max(id) FROM studio_provider_log WHERE job_id=$1)`, [job.id, `error ${res.status}`]);
    throw new HttpError(502, `이미지 편집 API 오류(${res.status}): ${txt.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")}`, "provider_error");
  }
  const body: any = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new HttpError(502, "이미지 편집 API 응답에 이미지가 없습니다.", "provider_error");
  const out = await sharp(Buffer.from(b64, "base64")).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  // 복원: 편집 허용 영역만 API 픽셀, 나머지는 렌더 마스터(가구 내부) 또는 원본(마스크 밖)
  const final = Buffer.from(master.data);
  let accepted = 0, rejectedOutside = 0, coreKept = 0;
  for (let p = 0; p < W * H; p++) {
    const differs = out[p * 3] !== master.data[p * 3] || out[p * 3 + 1] !== master.data[p * 3 + 1] || out[p * 3 + 2] !== master.data[p * 3 + 2];
    if (editable[p]) {
      final[p * 3] = out[p * 3];
      final[p * 3 + 1] = out[p * 3 + 1];
      final[p * 3 + 2] = out[p * 3 + 2];
      accepted++;
    } else {
      if (differs) rejectedOutside++;
      if (allowedRaw[p] > 127) coreKept++;
      else {
        final[p * 3] = orig.data[p * 3];
        final[p * 3 + 1] = orig.data[p * 3 + 1];
        final[p * 3 + 2] = orig.data[p * 3 + 2];
      }
    }
  }
  let changedOutside = 0;
  for (let p = 0; p < W * H; p++) if (allowedRaw[p] <= 127 && (final[p * 3] !== orig.data[p * 3] || final[p * 3 + 1] !== orig.data[p * 3 + 1] || final[p * 3 + 2] !== orig.data[p * 3 + 2])) changedOutside++;
  const m = await putFile({ workspaceId: job.workspace_id, kind: "render_master", mime: "image/png", data: await encodeMaster(final, W, H), width: W, height: H, ext: "png" });
  const d = await putFile({ workspaceId: job.workspace_id, kind: "render_delivery", mime: "image/jpeg", data: await encodeDelivery(final, W, H), width: W, height: H, ext: "jpg" });
  const pv = await putFile({ workspaceId: job.workspace_id, kind: "render_preview", mime: "image/jpeg", data: await encodePreview(final, W, H), ext: "jpg" });
  const result: AiEditResult = { fileIds: { master: m.id, delivery: d.id, preview: pv.id }, qa: { changedOutsideAllowed: changedOutside, acceptedPixels: accepted, rejectedOutsidePixels: rejectedOutside, productCorePixelsKept: coreKept }, provider: "openai", model };
  await q(`UPDATE studio_render_jobs SET outputs = outputs || jsonb_build_object('aiEdit', $2::jsonb) WHERE id=$1`, [job.id, JSON.stringify({ ...result, at: new Date().toISOString(), ms: Date.now() - t0, note: "3D 렌더 원본은 비교 기준으로 보존됨. 이 결과는 경계 보정본이며 가구 내부는 3D 렌더 그대로." })]);
  await q(`UPDATE studio_provider_log SET result='ok' WHERE id=(SELECT max(id) FROM studio_provider_log WHERE job_id=$1)`, [job.id]);
  await q(`INSERT INTO studio_usage(workspace_id, project_id, kind, job_id, units, cost_usd, duration_ms) VALUES ($1,$2,'ai_edit',$3,1,$4,$5)`, [job.workspace_id, job.project_id, job.id, Number(process.env.STUDIO_AI_EDIT_COST_USD ?? 0), Date.now() - t0]);
  return result;
}
