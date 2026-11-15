import type { FastifyInstance } from "fastify";
import { receiveWebhook } from "../ingest/ingest.js";

export async function webhookRoutes(app: FastifyInstance) {
  // POST /api/webhooks/:provider/:orgId — 공급사 공식 검증 통과 시에만 원본 저장
  app.post("/api/webhooks/:provider/:orgId", async (req, reply) => {
    const { provider, orgId } = req.params as { provider: string; orgId: string };
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) return reply.code(404).send({ error: "not found" });
    const r = await receiveWebhook(orgId, provider, { rawBody: req.rawBody ?? "", headers: req.headers as any });
    if (r.status === "rejected") {
      // 원문은 로그에 남기지 않는다
      req.log.warn({ provider, reason: r.reason }, "webhook rejected");
      return reply.code(r.httpStatus).send({ error: r.reason });
    }
    return reply.code(200).send({ status: r.status });
  });
}
