// Styling Studio 서버 설정. 비밀값은 여기서 읽고 클라이언트·로그로 내보내지 않는다.
import path from "node:path";

function num(v: string | undefined, d: number) {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export const studioConfig = {
  get storageDir() {
    return path.resolve(process.env.STUDIO_STORAGE_DIR || "data/studio");
  },
  get chromiumPath() {
    // 미설정이면 playwright-core 기본 위치 탐색. 렌더 워커가 없으면 작업은 'renderer_unavailable'로 실패 처리.
    return process.env.STUDIO_CHROMIUM_PATH || "";
  },
  get renderInProcess() {
    return process.env.STUDIO_RENDER_IN_PROCESS !== "false";
  },
  maxUploadBytes: num(process.env.STUDIO_MAX_UPLOAD_MB, 40) * 1024 * 1024,
  maxPhotoPixels: num(process.env.STUDIO_MAX_PHOTO_MP, 60) * 1_000_000,
  minPhotoLongSide: 800,
  previewLongSide: 1600,
  shareDays: num(process.env.STUDIO_SHARE_DAYS, 14),
  get openaiEnabled() {
    return Boolean(process.env.OPENAI_API_KEY);
  },
  get openaiBaseUrl() {
    return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  },
  get openaiImageModel() {
    // gpt-image-1은 2026-10-23 종료(공식 문서). 마스크 편집 예시 모델 기준 기본값 — 실계정에서 확인 필요
    return process.env.STUDIO_IMAGE_MODEL || "gpt-image-2.5-sunburst";
  },
  rendererVersion: "three-r170/compose-v1",
};
