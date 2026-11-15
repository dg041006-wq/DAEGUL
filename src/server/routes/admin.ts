// 설정: 구성원/권한, 영업시간·알림 기준, 승인 지식 버전, 연동 상태, 보관·삭제, 감사 로그, 과거 기록 가져오기
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../db/pool.js";
import { scopeOf } from "../auth/request.js";
import { ForbiddenError, NotFoundError, requireOwner } from "../auth/scope.js";
import { randomToken, sha256 } from "../auth/password.js";
import { revokeAllSessions } from "../auth/session.js";
import { audit } from "../lib/audit.js";
import { getOrgSettings } from "../lib/org.js";
import { config } from "../config.js";
import { requeueFailedEvents, applyEvent } from "../ingest/ingest.js";
import { purgeExpired } from "../jobs/automation.js";
import { KNOWLEDGE_KINDS, STAFF_PERMS } from "../../shared/domain.js";

const permsSchema = z.object(Object.fromEntries(STAFF_PERMS.map((p) => [p, z.boolean().optional()]))).strict();

export async function adminRoutes(app: FastifyInstance) {
  // ───── 구성원 ─────
  app.get("/api/members", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const members = await q(
      `SELECT u.id, u.email, u.name, m.role, m.perms, m.status, m.created_at, m.revoked_at,
              (SELECT max(last_seen_at) FROM sessions se WHERE se.user_id=u.id AND se.org_id=m.org_id) AS last_seen_at
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 ORDER BY m.status, m.role, u.name`,
      [s.orgId],
    );
    const invitations = await q(`SELECT id, email, role, perms, expires_at, accepted_at, revoked_at, created_at FROM invitations WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50`, [s.orgId]);
    return { members, invitations };
  });

  app.post("/api/invitations", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const body = z.object({ email: z.string().email(), role: z.enum(["owner", "staff"]).default("staff"), perms: permsSchema.default({}) }).parse(req.body);
    const token = randomToken(24);
    const inv = await q1<{ id: string }>(
      `INSERT INTO invitations(org_id, email, role, perms, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days', $6) RETURNING id`,
      [s.orgId, body.email.toLowerCase(), body.role, body.perms, sha256(token), s.userId],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "invitation.create", targetType: "invitation", targetId: inv!.id, detail: { email: body.email, role: body.role } });
    // 초대 링크는 이 응답에서 한 번만 표시 (DB에는 해시만 저장)
    return { id: inv!.id, inviteUrl: `${config.appBaseUrl}/invite/${token}`, expiresInDays: 7 };
  });

  app.delete("/api/invitations/:id", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    await q(`UPDATE invitations SET revoked_at=now() WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "invitation.revoke", targetType: "invitation", targetId: (req.params as any).id });
    return { ok: true };
  });

  app.patch("/api/members/:userId", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const userId = (req.params as any).userId;
    const body = z.object({ role: z.enum(["owner", "staff"]).optional(), perms: permsSchema.optional() }).parse(req.body);
    if (userId === s.userId && body.role === "staff") {
      const owners = await q1<{ n: number }>(`SELECT count(*) AS n FROM memberships WHERE org_id=$1 AND role='owner' AND status='active'`, [s.orgId]);
      if ((owners?.n ?? 0) <= 1) throw new ForbiddenError("마지막 대표 계정의 권한은 낮출 수 없습니다.");
    }
    const r = await q1(`UPDATE memberships SET role=COALESCE($3,role), perms=COALESCE($4,perms) WHERE org_id=$1 AND user_id=$2 RETURNING user_id`, [s.orgId, userId, body.role ?? null, body.perms ?? null]);
    if (!r) throw new NotFoundError();
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "member.update", targetType: "user", targetId: userId, detail: body });
    return { ok: true };
  });

  // 계정 회수: 멤버십 비활성 + 모든 세션 종료
  app.post("/api/members/:userId/revoke", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const userId = (req.params as any).userId;
    if (userId === s.userId) throw new ForbiddenError("본인 계정은 회수할 수 없습니다.");
    await q(`UPDATE memberships SET status='revoked', revoked_at=now() WHERE org_id=$1 AND user_id=$2`, [s.orgId, userId]);
    await revokeAllSessions(userId, s.orgId);
    await q(`DELETE FROM compose_locks WHERE user_id=$1`, [userId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "member.revoke", targetType: "user", targetId: userId });
    return { ok: true };
  });

  app.post("/api/members/:userId/sessions/revoke", async (req) => {
    const s = scopeOf(req);
    if ((req.params as any).userId !== s.userId) requireOwner(s);
    await revokeAllSessions((req.params as any).userId, s.orgId);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "sessions.revoke", targetType: "user", targetId: (req.params as any).userId });
    return { ok: true };
  });

  // ───── 조직 설정 ─────
  app.get("/api/settings", async (req) => {
    const s = scopeOf(req);
    const settings = await getOrgSettings(s.orgId);
    if (s.role !== "owner") return { businessHours: settings.businessHours };
    return settings;
  });

  app.patch("/api/settings", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const body = z
      .object({
        businessHours: z.object({ days: z.array(z.number().int().min(0).max(6)), start: hm, end: hm }).optional(),
        replyAlertMinutes: z.number().int().min(5).max(10080).optional(),
        quoteFollowupBusinessDays: z.number().int().min(1).max(60).optional(),
        reports: z.object({ dailyEnabled: z.boolean(), dailyTime: hm, weeklyEnabled: z.boolean(), weeklyDay: z.number().int().min(0).max(6), weeklyTime: hm }).optional(),
        aiMonthlyBudgetUsd: z.number().min(0).max(100000).optional(),
        retentionDays: z.number().int().min(30).max(3650).nullable().optional(),
        aiDailyCallCap: z.number().int().min(0).max(5000).optional(),
        aiHourlyCallCap: z.number().int().min(0).max(1000).optional(),
        pushMinSeverity: z.enum(["critical", "important", "info", "off"]).optional(),
        eventPush: z.record(z.enum(["critical", "important", "info"])).optional(),
        awaitingAlertRepeatHours: z.number().int().min(1).max(48).optional(),
      })
      .strict()
      .parse(req.body);
    const current = await getOrgSettings(s.orgId);
    const next = { ...current, ...body };
    await q(`UPDATE organizations SET settings=$2 WHERE id=$1`, [s.orgId, next]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "settings.update", detail: body });
    return next;
  });

  // ───── 승인된 지식(가격표·서비스 범위·수정 정책·말투) 버전 ─────
  app.get("/api/knowledge", async (req) => {
    const s = scopeOf(req);
    return q(
      `SELECT k.id, k.kind, k.version, k.title, k.content, k.status, k.approved_at, k.created_at, ua.name AS approved_by_name
       FROM knowledge_versions k LEFT JOIN users ua ON ua.id=k.approved_by WHERE k.org_id=$1 ${s.role === "owner" ? "" : "AND k.status='approved'"}
       ORDER BY k.kind, k.version DESC`,
      [s.orgId],
    );
  });

  app.post("/api/knowledge", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const body = z.object({ kind: z.enum(Object.keys(KNOWLEDGE_KINDS) as [keyof typeof KNOWLEDGE_KINDS]), title: z.string().min(1).max(100), content: z.string().min(1).max(20000) }).parse(req.body);
    const r = await q1(
      `INSERT INTO knowledge_versions(org_id, kind, version, title, content, created_by)
       VALUES ($1,$2,(SELECT COALESCE(max(version),0)+1 FROM knowledge_versions WHERE org_id=$1 AND kind=$2),$3,$4,$5) RETURNING id, version`,
      [s.orgId, body.kind, body.title, body.content, s.userId],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "knowledge.create", targetType: "knowledge", targetId: r.id });
    return r;
  });

  app.post("/api/knowledge/:id/approve", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const k = await q1<any>(`SELECT * FROM knowledge_versions WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!k) throw new NotFoundError();
    await tx(async (c) => {
      // 같은 종류의 이전 승인본은 보관 처리 — 최신 승인본만 답변 근거로 사용
      await q(`UPDATE knowledge_versions SET status='archived' WHERE org_id=$1 AND kind=$2 AND status='approved'`, [s.orgId, k.kind], c);
      await q(`UPDATE knowledge_versions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [k.id, s.userId], c);
    });
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "knowledge.approve", targetType: "knowledge", targetId: k.id, detail: { kind: k.kind, version: k.version } });
    return { ok: true };
  });

  // ───── 연동 상태 ─────
  app.get("/api/integrations", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const integrations = await q(`SELECT * FROM integrations WHERE org_id=$1 ORDER BY provider`, [s.orgId]);
    const events = await q(
      `SELECT provider, status, count(*) AS n, max(received_at) AS last_received FROM webhook_events WHERE org_id=$1 GROUP BY provider, status ORDER BY provider, status`,
      [s.orgId],
    );
    const recentFailures = await q(`SELECT id, provider, external_event_id, received_at, attempts, error FROM webhook_events WHERE org_id=$1 AND status='failed' ORDER BY received_at DESC LIMIT 20`, [s.orgId]);
    const deadJobs = await q(`SELECT id, kind, attempts, last_error, created_at FROM jobs WHERE status='dead' AND payload->>'orgId' = $1 ORDER BY created_at DESC LIMIT 20`, [s.orgId]);
    return {
      integrations,
      events,
      recentFailures,
      deadJobs,
      webhookUrlPattern: `${config.appBaseUrl.replace(/\/$/, "")}/api/webhooks/<provider>/${s.orgId}`,
      ai: { configured: config.ai.enabled, model: config.ai.model },
    };
  });

  app.post("/api/integrations/requeue-failed", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const n = await requeueFailedEvents(s.orgId);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "webhook.requeue", detail: { n } });
    return { requeued: n };
  });

  // ───── 사용자 제공 과거 기록 가져오기 ─────
  // 형식은 이 앱이 정의한 JSON. 출처와 기간을 기록하고 화면에 표시한다. (공급사 일괄 내보내기 기능을 가정하지 않음)
  app.post("/api/imports", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const body = z
      .object({
        source_label: z.string().min(2).max(200),
        conversations: z
          .array(
            z.object({
              external_conversation_id: z.string().min(1).max(200),
              customer_id: z.string().min(1).max(200),
              customer_name: z.string().max(100).nullish(),
              messages: z
                .array(z.object({ id: z.string().min(1).max(200), sender: z.enum(["customer", "staff", "bot"]), text: z.string().max(10000), sent_at: z.string().datetime({ offset: true }) }))
                .min(1)
                .max(2000),
            }),
          )
          .min(1)
          .max(500),
      })
      .parse(req.body);
    const all = body.conversations.flatMap((c) => c.messages.map((m) => m.sent_at)).sort();
    const imp = await q1<{ id: string }>(
      `INSERT INTO data_imports(org_id, source_label, period_start, period_end, message_count, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [s.orgId, body.source_label, all[0], all[all.length - 1], all.length, s.userId],
    );
    let inserted = 0;
    for (const c of body.conversations) {
      for (const m of c.messages) {
        const r = await applyEvent(
          s.orgId,
          "import",
          {
            kind: "message",
            externalEventId: `import:${c.external_conversation_id}:${m.id}`,
            contact: { externalUserId: c.customer_id, displayName: c.customer_name ?? null },
            conversation: { externalConversationId: c.external_conversation_id, channel: "import" },
            message: { externalMessageId: `${c.external_conversation_id}:${m.id}`, senderType: m.sender, body: m.text, sentAt: m.sent_at },
          },
          { importId: imp!.id },
        );
        if (!r.duplicate) inserted++;
      }
    }
    await q(`UPDATE data_imports SET message_count=$2 WHERE id=$1`, [imp!.id, inserted]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "import.create", targetType: "import", targetId: imp!.id, detail: { source: body.source_label, inserted } });
    return { id: imp!.id, inserted, periodStart: all[0], periodEnd: all[all.length - 1] };
  });

  // ───── 데이터 보관·삭제 ─────
  app.post("/api/retention/run", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    return { deletedConversations: await purgeExpired(s.orgId) };
  });

  // 샘플 데이터 일괄 삭제 (실연동 전환 시)
  app.post("/api/sample-data/delete", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const r = await tx(async (c) => {
      await q(`DELETE FROM tasks WHERE org_id=$1 AND (conversation_id IN (SELECT id FROM conversations WHERE org_id=$1 AND is_sample) OR opportunity_id IN (SELECT id FROM opportunities WHERE org_id=$1 AND is_sample))`, [s.orgId], c);
      await q(`DELETE FROM ai_messages WHERE thread_id IN (SELECT id FROM ai_threads WHERE org_id=$1)`, [s.orgId], c);
      await q(`DELETE FROM ai_threads WHERE org_id=$1`, [s.orgId], c);
      await q(`DELETE FROM reports WHERE org_id=$1`, [s.orgId], c);
      await q(`DELETE FROM events WHERE org_id=$1`, [s.orgId], c);
      await q(`DELETE FROM notifications WHERE org_id=$1`, [s.orgId], c);
      await q(`UPDATE opportunities SET merged_into_id=NULL, duplicate_of_candidate=NULL WHERE org_id=$1 AND is_sample`, [s.orgId], c);
      const o = await q(`DELETE FROM opportunities WHERE org_id=$1 AND is_sample RETURNING id`, [s.orgId], c);
      const cv = await q(`DELETE FROM conversations WHERE org_id=$1 AND is_sample RETURNING id`, [s.orgId], c);
      await q(`DELETE FROM contacts WHERE org_id=$1 AND is_sample`, [s.orgId], c);
      await q(`DELETE FROM webhook_events WHERE org_id=$1 AND provider='demo'`, [s.orgId], c);
      await q(`DELETE FROM integrations WHERE org_id=$1 AND provider='demo'`, [s.orgId], c);
      return { opportunities: o.length, conversations: cv.length };
    });
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "sample_data.delete", detail: r });
    return r;
  });

  app.get("/api/audit", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    return q(
      `SELECT a.id, a.action, a.actor_type, a.target_type, a.target_id, a.detail, a.created_at, u.name AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.org_id=$1 ORDER BY a.created_at DESC LIMIT 200`,
      [s.orgId],
    );
  });
}
