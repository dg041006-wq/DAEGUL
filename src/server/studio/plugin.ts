// Styling Studio 라우트 묶음. 기존 OFFICE 라우트와 독립(별도 세션 쿠키·테이블).
import type { FastifyInstance } from "fastify";
import { STUDIO_COOKIE, resolveStudioSession } from "./auth.js";
import { studioCoreRoutes } from "./routes/core.js";
import { studioAssetRoutes } from "./routes/assets.js";
import { studioVariantRoutes } from "./routes/variants.js";
import { studioShareRoutes } from "./routes/share.js";
import { ensureCatalog } from "./sample.js";

export async function studioPlugin(app: FastifyInstance) {
  // 사진·GLB 업로드는 원본 바이트 그대로 받는다(멀티파트 파서 불필요, 원본 보존)
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/tiff", "application/octet-stream", "model/gltf-binary"], { parseAs: "buffer", bodyLimit: 64 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/studio/")) return;
    req.studio = await resolveStudioSession(req.cookies[STUDIO_COOKIE]);
  });
  await app.register(studioCoreRoutes);
  await app.register(studioAssetRoutes);
  await app.register(studioVariantRoutes);
  await app.register(studioShareRoutes);
  app.addHook("onReady", async () => {
    await ensureCatalog().catch((e) => app.log.error({ err: e.message }, "studio catalog seed failed"));
  });
}
