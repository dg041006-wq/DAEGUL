import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { config } from "./config.js";
import { resolveSession, SESSION_COOKIE } from "./auth/session.js";
import { authRoutes } from "./routes/auth.js";
import { coreRoutes } from "./routes/core.js";
import { salesRoutes } from "./routes/sales.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes } from "./routes/admin.js";
import { webhookRoutes } from "./routes/webhooks.js";

import "./auth/request.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.env === "test" ? false : { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  await app.register(cookie, { secret: config.sessionSecret || undefined });

  // 웹훅 서명 검증을 위해 원문 본문 보존
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (e: any) {
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (req.url.startsWith("/api/webhooks/")) return;
    // CSRF 완화: 상태 변경 요청은 커스텀 헤더 필수 (SameSite=Lax 쿠키와 함께)
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== "stayscene") {
      return reply.code(400).send({ error: "잘못된 요청 헤더" });
    }
    const s = await resolveSession(req.cookies[SESSION_COOKIE]);
    if (s) req.scope = s.scope;
  });

  app.setErrorHandler((err: any, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "입력값을 확인해 주세요.", issues: err.issues.map((i) => i.path.join(".") + ": " + i.message) });
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      app.log.error({ err: { message: err.message, stack: err.stack } }, "server error");
      if (config.env === "test") console.error(err);
    }
    reply.code(status).send({ error: status >= 500 ? "서버 오류가 발생했습니다." : err.message });
  });

  await app.register(authRoutes);
  await app.register(coreRoutes);
  await app.register(salesRoutes);
  await app.register(aiRoutes);
  await app.register(adminRoutes);
  await app.register(webhookRoutes);

  app.get("/api/health", async () => ({ ok: true }));

  // 프로덕션: 빌드된 프런트엔드 제공 (SPA)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = [path.resolve(here, "../../dist-web"), path.resolve(here, "../../../dist-web")].find((p) => fs.existsSync(p));
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
