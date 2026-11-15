import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1 } from "../db/pool.js";
import { scopeOf } from "../auth/request.js";
import { NotFoundError, requireOwner } from "../auth/scope.js";
import { postQuestion } from "../ai/employees.js";
import { checkAvailability, monthUsage } from "../ai/client.js";
import { audit } from "../lib/audit.js";
import { getOrgSettings } from "../lib/org.js";
import { config } from "../config.js";
import { roleCardStatus } from "./core.js";

export async function aiRoutes(app: FastifyInstance) {
  app.get("/api/ai/roles", async (req) => {
    const s = scopeOf(req);
    const roles = await q(`SELECT role_key, display_name, title, suit_color, appearance, instructions, updated_at FROM ai_roles WHERE org_id=$1 ORDER BY CASE role_key WHEN 'ops' THEN 1 WHEN 'sales' THEN 2 ELSE 3 END`, [s.orgId]);
    const status = await roleCardStatus(s);
    const avail = await checkAvailability(s.orgId);
    return { roles, status, ai: avail.ok ? { available: true } : { available: false, reason: avail.reason, message: avail.message } };
  });

  app.patch("/api/ai/roles/:key", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const key = z.enum(["ops", "sales", "strategy"]).parse((req.params as any).key);
    const body = z
      .object({
        display_name: z.string().min(1).max(30).optional(),
        title: z.string().min(1).max(30).optional(),
        suit_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        appearance: z.object({ hair: z.enum(["wave", "bob", "updo", "long", "ponytail"]).optional(), accent: z.string().max(20).optional() }).optional(),
        instructions: z.string().min(10).max(3000).optional(),
      })
      .parse(req.body);
    await q(
      `UPDATE ai_roles SET display_name=COALESCE($3,display_name), title=COALESCE($4,title), suit_color=COALESCE($5,suit_color),
         appearance=COALESCE($6,appearance), instructions=COALESCE($7,instructions), updated_at=now() WHERE org_id=$1 AND role_key=$2`,
      [s.orgId, key, body.display_name ?? null, body.title ?? null, body.suit_color ?? null, body.appearance ?? null, body.instructions ?? null],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "ai_role.update", targetType: "ai_role", targetId: key, detail: { fields: Object.keys(body) } });
    return { ok: true };
  });

  // 스레드는 본인 것만 (AI 대화는 요청자 권한 범위 안에서 생성되므로 공유하지 않음)
  app.get("/api/ai/threads", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ role: z.enum(["ops", "sales", "strategy", "meeting"]).optional() }).parse(req.query);
    return q(
      `SELECT id, role_key, title, kind, created_at, updated_at FROM ai_threads WHERE org_id=$1 AND owner_user_id=$2 ${qs.role ? "AND role_key=$3" : ""} ORDER BY (kind='feed') DESC, updated_at DESC LIMIT 50`,
      qs.role ? [s.orgId, s.userId, qs.role] : [s.orgId, s.userId],
    );
  });

  app.post("/api/ai/threads", async (req) => {
    const s = scopeOf(req);
    const body = z.object({ role_key: z.enum(["ops", "sales", "strategy", "meeting"]), title: z.string().max(100).optional(), message: z.string().min(1).max(4000) }).parse(req.body);
    const t = await q1<{ id: string }>(`INSERT INTO ai_threads(org_id, role_key, owner_user_id, title) VALUES ($1,$2,$3,$4) RETURNING id`, [
      s.orgId,
      body.role_key,
      s.userId,
      body.title ?? body.message.slice(0, 40),
    ]);
    await postQuestion(s, t!.id, body.message);
    return { id: t!.id };
  });

  app.get("/api/ai/threads/:id", async (req) => {
    const s = scopeOf(req);
    const t = await q1(`SELECT id, role_key, title, kind, created_at FROM ai_threads WHERE id=$1 AND org_id=$2 AND owner_user_id=$3`, [(req.params as any).id, s.orgId, s.userId]);
    if (!t) throw new NotFoundError();
    const messages = await q(
      `SELECT m.id, m.author, m.status, m.kind, m.actions, m.content, m.customer_draft, m.next_actions, m.meta, m.created_at, r.model, r.prompt_version, r.engine, r.error_kind
       FROM ai_messages m LEFT JOIN analysis_runs r ON r.id=m.analysis_run_id WHERE m.thread_id=$1 ORDER BY m.created_at`,
      [t.id],
    );
    return { thread: t, messages };
  });

  app.post("/api/ai/threads/:id/messages", async (req) => {
    const s = scopeOf(req);
    const body = z.object({ message: z.string().min(1).max(4000) }).parse(req.body);
    const id = await postQuestion(s, (req.params as any).id, body.message);
    if (!id) throw new NotFoundError();
    return { id };
  });

  app.get("/api/ai/usage", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const settings = await getOrgSettings(s.orgId);
    const usage = await monthUsage(s.orgId);
    const byKind = await q(
      `SELECT kind, engine, count(*) AS runs, COALESCE(sum(cost_usd),0) AS cost, COALESCE(sum(input_tokens),0) AS input_tokens, COALESCE(sum(output_tokens),0) AS output_tokens
       FROM analysis_runs WHERE org_id=$1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul' GROUP BY kind, engine ORDER BY cost DESC`,
      [s.orgId],
    );
    const errors = await q(
      `SELECT error_kind, count(*) AS n, max(finished_at) AS last_at FROM analysis_runs WHERE org_id=$1 AND status='failed' AND created_at > now() - interval '30 days' GROUP BY error_kind ORDER BY n DESC`,
      [s.orgId],
    );
    const lastOk = await q1(`SELECT finished_at, model FROM analysis_runs WHERE org_id=$1 AND engine='model' AND status='done' ORDER BY finished_at DESC LIMIT 1`, [s.orgId]);
    return {
      errors,
      lastSuccess: lastOk,
      dailyCallCap: settings.aiDailyCallCap,
      hourlyCallCap: settings.aiHourlyCallCap,
      billingNote: "실제 청구 금액은 앱에서 확인할 수 없습니다(결제 API 미연동). Claude Console의 Usage/Billing에서 확인하세요.",
      model: config.ai.model,
      configured: config.ai.enabled,
      priceInputPerMTok: config.ai.priceInputPerMTok,
      priceOutputPerMTok: config.ai.priceOutputPerMTok,
      budgetUsd: settings.aiMonthlyBudgetUsd,
      usage,
      byKind,
      note: "비용은 토큰 사용량 × 설정 단가로 추정한 값입니다. 실제 청구액은 Claude Console의 사용량/청구 화면을 기준으로 하세요.",
    };
  });
}
