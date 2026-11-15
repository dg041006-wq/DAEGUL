// 홈 / 상담함 / 할 일 / 알림 — 모든 조회는 서버에서 Scope로 필터링한다.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1 } from "../db/pool.js";
import { scopeOf } from "../auth/request.js";
import { can, conversationAccessSql, ForbiddenError, isOwner, NotFoundError, opportunityAccessSql, requirePerm, type Scope } from "../auth/scope.js";
import { awaitingHuman, dataStatus, homeSummary, quoteAwaitingReply } from "../analytics/metrics.js";
import { resolvePeriod } from "../lib/time.js";
import { audit } from "../lib/audit.js";
import { enqueue } from "../jobs/queue.js";
import { draftReply } from "../ai/conversationAnalysis.js";
import { checkAvailability } from "../ai/client.js";

export async function getAccessibleConversation(s: Scope, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  const params: unknown[] = [];
  const acc = conversationAccessSql(s, "c", params);
  params.push(id);
  const c = await q1<any>(`SELECT c.* FROM conversations c WHERE ${acc} AND c.id=$${params.length}`, params);
  if (!c) throw new NotFoundError("상담을 찾을 수 없거나 권한이 없습니다.");
  return c;
}

export async function getAccessibleOpportunity(s: Scope, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  const params: unknown[] = [];
  const acc = opportunityAccessSql(s, "o", params);
  params.push(id);
  const o = await q1<any>(`SELECT o.* FROM opportunities o WHERE ${acc} AND o.id=$${params.length}`, params);
  if (!o) throw new NotFoundError("문의 건을 찾을 수 없거나 권한이 없습니다.");
  return o;
}

export async function coreRoutes(app: FastifyInstance) {
  // ───── 홈 / 대표실 ─────
  app.get("/api/home", async (req) => {
    const s = scopeOf(req);
    const today = resolvePeriod(undefined, undefined, 1);
    const summary = await homeSummary(s, today);
    const ds = await dataStatus(s);
    const params: unknown[] = [s.orgId];
    let tf = "";
    if (!isOwner(s)) {
      params.push(s.userId);
      tf = "AND (t.assignee_user_id=$2)";
    }
    const tasks = await q(
      `SELECT t.id, t.title, t.due_at, t.status, t.source, t.conversation_id, t.opportunity_id, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id=t.assignee_user_id
       WHERE t.org_id=$1 ${tf} AND (t.status='open' OR t.completed_at >= now() - interval '1 day')
       ORDER BY t.status, t.due_at NULLS LAST LIMIT 20`,
      params,
    );
    const roleStatus = await roleCardStatus(s);
    const ai = await checkAvailability(s.orgId);
    return {
      period: { from: today.from, to: today.to },
      summary,
      tasks,
      roles: roleStatus,
      ai: ai.ok ? { available: true } : { available: false, reason: ai.reason, message: ai.message },
      dataStatus: {
        kakaoVerified: ds.kakaoVerified,
        usingSampleData: ds.usingSampleData,
        lastSyncAt: ds.lastSyncAt,
        failedEvents: isOwner(s) ? ds.failedEvents : undefined,
        integrations: ds.integrations.map((i: any) => ({ provider: i.provider, status: i.status, last_sync_at: i.last_sync_at, coverage_start: i.coverage_start })),
        firstMessageAt: ds.messageCounts?.first_at ?? null,
      },
    };
  });

  // ───── 상담함 ─────
  app.get("/api/conversations", async (req) => {
    const s = scopeOf(req);
    const qs = z
      .object({
        filter: z.enum(["all", "awaiting", "mine", "unassigned", "closed"]).default("all"),
        service: z.string().optional(),
        stage: z.string().optional(),
        assignee: z.string().uuid().optional(),
        search: z.string().max(50).optional(),
      })
      .parse(req.query);
    const params: unknown[] = [];
    const acc = conversationAccessSql(s, "c", params);
    const where = [acc];
    if (qs.filter === "awaiting") where.push(`c.status='open' AND c.last_customer_message_at IS NOT NULL AND (c.last_staff_message_at IS NULL OR c.last_staff_message_at < c.last_customer_message_at)`);
    if (qs.filter === "mine") {
      params.push(s.userId);
      where.push(`c.assignee_user_id=$${params.length}`);
    }
    if (qs.filter === "unassigned") where.push(`c.assignee_user_id IS NULL`);
    if (qs.filter === "closed") where.push(`c.status='closed'`);
    if (qs.service) {
      params.push(qs.service);
      where.push(`$${params.length} = ANY(o.services)`);
    }
    if (qs.stage) {
      params.push(qs.stage);
      where.push(`o.stage = $${params.length}`);
    }
    if (qs.assignee) {
      params.push(qs.assignee);
      where.push(`c.assignee_user_id = $${params.length}`);
    }
    if (qs.search) {
      params.push(`%${qs.search}%`);
      where.push(`(ct.display_name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id=c.id AND mm.body ILIKE $${params.length}))`);
    }
    return q(
      `SELECT c.id, c.status, c.opened_at, c.last_message_at, c.last_customer_message_at, c.last_staff_message_at, c.is_sample, c.ai_status,
              c.assignee_user_id, u.name AS assignee_name, ct.display_name, o.id AS opportunity_id, o.services, o.stage, o.category,
              (c.status='open' AND c.last_customer_message_at IS NOT NULL AND (c.last_staff_message_at IS NULL OR c.last_staff_message_at < c.last_customer_message_at)) AS awaiting,
              (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY sent_at DESC, id DESC LIMIT 1) AS last_body,
              cl.user_id AS locked_by
       FROM conversations c
       JOIN contacts ct ON ct.id=c.contact_id
       LEFT JOIN users u ON u.id=c.assignee_user_id
       LEFT JOIN opportunity_conversations oc ON oc.conversation_id=c.id
       LEFT JOIN opportunities o ON o.id=oc.opportunity_id
       LEFT JOIN compose_locks cl ON cl.conversation_id=c.id AND cl.expires_at > now()
       WHERE ${where.join(" AND ")}
       ORDER BY c.last_message_at DESC NULLS LAST LIMIT 200`,
      params,
    );
  });

  app.get("/api/conversations/:id", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    const [contact, messages, notes, link, lock, drafts, assignee] = await Promise.all([
      q1(`SELECT id, display_name, provider, external_user_id, is_sample, created_at FROM contacts WHERE id=$1`, [c.contact_id]),
      q(`SELECT id, sender_type, sender_name, body, attachments, sent_at, received_at FROM messages WHERE conversation_id=$1 ORDER BY sent_at, id`, [c.id]),
      q(`SELECT n.id, n.body, n.created_at, u.name AS author_name FROM internal_notes n LEFT JOIN users u ON u.id=n.author_id WHERE conversation_id=$1 ORDER BY created_at`, [c.id]),
      q1<{ opportunity_id: string; link_reason: string }>(`SELECT opportunity_id, link_reason FROM opportunity_conversations WHERE conversation_id=$1`, [c.id]),
      q1(`SELECT cl.user_id, u.name, cl.expires_at FROM compose_locks cl JOIN users u ON u.id=cl.user_id WHERE conversation_id=$1 AND expires_at > now()`, [c.id]),
      q(`SELECT id, kind, payload, status, requested_by_type, created_at, decided_at FROM approvals WHERE conversation_id=$1 AND status IN ('draft','approved') ORDER BY created_at DESC LIMIT 10`, [c.id]),
      c.assignee_user_id ? q1(`SELECT id, name FROM users WHERE id=$1`, [c.assignee_user_id]) : null,
    ]);
    let opportunity: any = null;
    if (link) {
      opportunity = await q1(`SELECT * FROM opportunities WHERE id=$1`, [link.opportunity_id]);
    }
    const ds = await dataStatus(s);
    return {
      conversation: c,
      contact,
      messages,
      notes,
      opportunity,
      linkReason: link?.link_reason ?? null,
      lock,
      drafts,
      assignee,
      sendEnabled: false, // 공급사 발송 검증 전: 읽기·분석·초안 전용
      provider: { name: c.provider, sample: c.is_sample, kakaoVerified: ds.kakaoVerified },
    };
  });

  app.patch("/api/conversations/:id", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    const body = z.object({ assignee_user_id: z.string().uuid().nullable().optional() }).parse(req.body);
    if (body.assignee_user_id !== undefined) {
      if (!can(s, "view_all_conversations") && body.assignee_user_id !== s.userId) throw new ForbiddenError("다른 직원에게 배정할 권한이 없습니다.");
      if (body.assignee_user_id) {
        const m = await q1(`SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND status='active'`, [s.orgId, body.assignee_user_id]);
        if (!m) throw new NotFoundError("구성원을 찾을 수 없습니다.");
      }
      await q(`UPDATE conversations SET assignee_user_id=$2 WHERE id=$1`, [c.id, body.assignee_user_id]);
      await audit({ orgId: s.orgId, actorUserId: s.userId, action: "conversation.assign", targetType: "conversation", targetId: c.id, detail: { from: c.assignee_user_id, to: body.assignee_user_id }, ip: req.ip });
    }
    return { ok: true };
  });

  app.post("/api/conversations/:id/notes", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    const body = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    const n = await q1(`INSERT INTO internal_notes(org_id, conversation_id, author_id, body) VALUES ($1,$2,$3,$4) RETURNING id`, [s.orgId, c.id, s.userId, body.body]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "note.create", targetType: "conversation", targetId: c.id });
    return n;
  });

  // 작성 중 표시 / 중복 방지 잠금 (2분, 갱신 가능)
  app.post("/api/conversations/:id/lock", async (req, reply) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    const r = await q1<{ user_id: string }>(
      `INSERT INTO compose_locks(conversation_id, user_id, expires_at) VALUES ($1,$2, now() + interval '2 minutes')
       ON CONFLICT (conversation_id) DO UPDATE SET user_id=EXCLUDED.user_id, expires_at=EXCLUDED.expires_at
         WHERE compose_locks.user_id=EXCLUDED.user_id OR compose_locks.expires_at < now()
       RETURNING user_id`,
      [c.id, s.userId],
    );
    if (!r) {
      const holder = await q1(`SELECT u.name FROM compose_locks cl JOIN users u ON u.id=cl.user_id WHERE cl.conversation_id=$1`, [c.id]);
      return reply.code(409).send({ error: `${holder?.name ?? "다른 직원"}님이 작성 중입니다.`, holder });
    }
    return { ok: true };
  });
  app.delete("/api/conversations/:id/lock", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    await q(`DELETE FROM compose_locks WHERE conversation_id=$1 AND user_id=$2`, [c.id, s.userId]);
    return { ok: true };
  });

  app.post("/api/conversations/:id/analyze", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    await enqueue("analyze_conversation", { orgId: s.orgId, conversationId: c.id }, { dedupeKey: `analyze:${c.id}` });
    await q(`UPDATE conversations SET ai_status='queued' WHERE id=$1`, [c.id]);
    return { ok: true };
  });

  app.post("/api/conversations/:id/draft", async (req, reply) => {
    const s = scopeOf(req);
    const c = await getAccessibleConversation(s, (req.params as any).id);
    const r = await draftReply(s.orgId, c.id, s.userId);
    if (!r.ok) return reply.code(503).send({ error: r.message });
    await audit({ orgId: s.orgId, actorUserId: s.userId, actorType: "ai", action: "reply_draft.create", targetType: "approval", targetId: r.approvalId });
    return r;
  });

  // 초안/제안 결정: approve(검토 완료) / reject / sent_externally(공급사 화면에서 직접 발송했음 기록) / discard
  app.post("/api/approvals/:id/decision", async (req) => {
    const s = scopeOf(req);
    const body = z.object({ decision: z.enum(["approve", "reject", "sent_externally", "discard"]), editedBody: z.string().max(8000).optional() }).parse(req.body);
    const a = await q1<any>(`SELECT * FROM approvals WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!a) throw new NotFoundError();
    if (a.conversation_id) await getAccessibleConversation(s, a.conversation_id);
    if (a.opportunity_id) await getAccessibleOpportunity(s, a.opportunity_id);
    if (a.kind === "stage_change") {
      if (body.decision === "approve") {
        const { applyStageChange } = await import("./sales.js");
        await applyStageChange(s, a.opportunity_id, a.payload.to, `AI 제안 승인: ${a.payload.reason ?? ""}`, a.payload.message_ids ?? [], "ai");
      }
      await q(`UPDATE approvals SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [a.id, body.decision === "approve" ? "executed" : "rejected", s.userId]);
    } else {
      const status = { approve: "approved", reject: "rejected", sent_externally: "executed", discard: "discarded" }[body.decision];
      const payload = body.editedBody ? { ...a.payload, body: body.editedBody, edited: true } : a.payload;
      await q(`UPDATE approvals SET status=$2, payload=$3, decided_by=$4, decided_at=now(), executed_at=CASE WHEN $2='executed' THEN now() ELSE executed_at END WHERE id=$1`, [a.id, status, payload, s.userId]);
    }
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: `approval.${body.decision}`, targetType: "approval", targetId: a.id, detail: { kind: a.kind } });
    return { ok: true };
  });

  // 근거 메시지 → 상담 위치 (권한 범위 내에서만)
  app.get("/api/evidence/message/:id", async (req) => {
    const s = scopeOf(req);
    const m = await q1<{ conversation_id: string }>(`SELECT conversation_id FROM messages WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!m) throw new NotFoundError();
    await getAccessibleConversation(s, m.conversation_id);
    return { conversationId: m.conversation_id, messageId: (req.params as any).id };
  });

  app.get("/api/queues", async (req) => {
    const s = scopeOf(req);
    return { awaiting: await awaitingHuman(s, 100), quoteAwaitingReply: await quoteAwaitingReply(s) };
  });

  // ───── 할 일 ─────
  app.get("/api/tasks", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ status: z.enum(["open", "done", "all"]).default("open"), mine: z.coerce.boolean().optional() }).parse(req.query);
    const params: unknown[] = [s.orgId];
    const where = ["t.org_id=$1"];
    if (!can(s, "view_all_conversations") || qs.mine) {
      params.push(s.userId);
      where.push(`t.assignee_user_id=$${params.length}`);
    }
    if (qs.status !== "all") {
      params.push(qs.status);
      where.push(`t.status=$${params.length}`);
    }
    return q(
      `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_user_id WHERE ${where.join(" AND ")}
       ORDER BY t.status, t.due_at NULLS LAST, t.created_at DESC LIMIT 300`,
      params,
    );
  });

  app.post("/api/tasks", async (req) => {
    const s = scopeOf(req);
    const body = z
      .object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        assignee_user_id: z.string().uuid().nullable().optional(),
        due_at: z.string().datetime({ offset: true }).nullable().optional(),
        conversation_id: z.string().uuid().nullable().optional(),
        opportunity_id: z.string().uuid().nullable().optional(),
        source: z.enum(["manual", "ai"]).default("manual"),
        source_reason: z.string().max(500).optional(),
      })
      .parse(req.body);
    if (body.conversation_id) await getAccessibleConversation(s, body.conversation_id);
    if (body.opportunity_id) await getAccessibleOpportunity(s, body.opportunity_id);
    const assignee = body.assignee_user_id ?? s.userId;
    if (assignee !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError("다른 직원에게 할 일을 배정할 권한이 없습니다.");
    const t = await q1(
      `INSERT INTO tasks(org_id, title, description, assignee_user_id, due_at, conversation_id, opportunity_id, source, source_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [s.orgId, body.title, body.description ?? null, assignee, body.due_at ?? null, body.conversation_id ?? null, body.opportunity_id ?? null, body.source, body.source_reason ?? null, s.userId],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "task.create", targetType: "task", targetId: t.id });
    return t;
  });

  app.patch("/api/tasks/:id", async (req) => {
    const s = scopeOf(req);
    const t = await q1<any>(`SELECT * FROM tasks WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!t) throw new NotFoundError();
    if (t.assignee_user_id !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError();
    const body = z
      .object({ status: z.enum(["open", "done", "cancelled"]).optional(), title: z.string().min(1).max(200).optional(), due_at: z.string().datetime({ offset: true }).nullable().optional(), assignee_user_id: z.string().uuid().nullable().optional() })
      .parse(req.body);
    if (body.assignee_user_id !== undefined && body.assignee_user_id !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError();
    await q(
      `UPDATE tasks SET status=COALESCE($2,status), title=COALESCE($3,title),
         due_at=CASE WHEN $4::boolean THEN $5::timestamptz ELSE due_at END,
         assignee_user_id=CASE WHEN $6::boolean THEN $7::uuid ELSE assignee_user_id END,
         completed_at=CASE WHEN $2='done' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE completed_at END
       WHERE id=$1`,
      [t.id, body.status ?? null, body.title ?? null, body.due_at !== undefined, body.due_at ?? null, body.assignee_user_id !== undefined, body.assignee_user_id ?? null],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "task.update", targetType: "task", targetId: t.id, detail: body });
    return { ok: true };
  });

  // ───── 알림함 ─────
  app.get("/api/notifications", async (req) => {
    const s = scopeOf(req);
    return q(`SELECT id, kind, title, link, read_at, created_at FROM notifications WHERE user_id=$1 AND org_id=$2 ORDER BY created_at DESC LIMIT 100`, [s.userId, s.orgId]);
  });
  app.post("/api/notifications/read-all", async (req) => {
    const s = scopeOf(req);
    await q(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [s.userId]);
    return { ok: true };
  });

  app.get("/api/members/brief", async (req) => {
    const s = scopeOf(req);
    return q(`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.status='active' ORDER BY m.role, u.name`, [s.orgId]);
  });

  void requirePerm;
}

/** AI 직원 카드 상태: 실제 작업 결과와 연결 */
export async function roleCardStatus(s: Scope) {
  const out: Record<string, { newReports: number; pendingReview: number; running: boolean; dataGap: string | null; lastMessage: string | null }> = {};
  for (const role of ["marketing", "cs", "strategy"]) {
    const running = await q1<{ n: number }>(
      `SELECT count(*) AS n FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE t.org_id=$1 AND t.owner_user_id=$2 AND t.role_key=$3 AND m.status IN ('pending','running')`,
      [s.orgId, s.userId, role],
    );
    const last = await q1<{ content: string }>(
      `SELECT m.content FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE t.org_id=$1 AND t.owner_user_id=$2 AND t.role_key=$3 AND m.author='assistant' AND m.status='done' ORDER BY m.created_at DESC LIMIT 1`,
      [s.orgId, s.userId, role],
    );
    out[role] = { newReports: 0, pendingReview: 0, running: (running?.n ?? 0) > 0, dataGap: null, lastMessage: last?.content?.split("\n").find((l) => l.trim() && !l.startsWith("[규칙") && !l.startsWith("질문 내용을"))?.replace(/^■\s*/, "").slice(0, 80) ?? null };
  }
  if (can(s, "view_analytics") && can(s, "view_finance")) {
    const r = await q1<{ n: number }>(`SELECT count(*) AS n FROM reports WHERE org_id=$1 AND status='new'`, [s.orgId]);
    out.strategy.newReports = r?.n ?? 0;
  }
  const params: unknown[] = [];
  const acc = conversationAccessSql(s, "c", params);
  const drafts = await q1<{ n: number }>(`SELECT count(*) AS n FROM approvals a JOIN conversations c ON c.id=a.conversation_id WHERE ${acc} AND a.kind='reply_draft' AND a.status='draft'`, params);
  out.cs.pendingReview = drafts?.n ?? 0;
  const params2: unknown[] = [];
  const acc2 = opportunityAccessSql(s, "o", params2);
  const stageSug = await q1<{ n: number }>(`SELECT count(*) AS n FROM approvals a JOIN opportunities o ON o.id=a.opportunity_id WHERE ${acc2} AND a.kind='stage_change' AND a.status='draft'`, params2);
  out.strategy.pendingReview = stageSug?.n ?? 0;
  const params3: unknown[] = [];
  const acc3 = opportunityAccessSql(s, "o", params3);
  const src = await q1<{ total: number; unknown: number }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE source_channel IS NULL) AS unknown FROM opportunities o WHERE ${acc3} AND o.category='valid' AND o.merged_into_id IS NULL AND o.opened_at > now() - interval '30 days'`,
    params3,
  );
  if ((src?.total ?? 0) === 0) out.marketing.dataGap = "최근 30일 문의 자료 없음";
  else if ((src!.unknown ?? 0) / src!.total > 0.5) out.marketing.dataGap = "유입경로 미확인 비중 높음";
  const fin = await q1<{ n: number }>(`SELECT count(*) AS n FROM contracts k WHERE k.org_id=$1 AND NOT EXISTS (SELECT 1 FROM costs c WHERE c.contract_id=k.id AND c.category LIKE 'direct_%')`, [s.orgId]);
  if (can(s, "view_finance") && (fin?.n ?? 0) > 0) out.strategy.dataGap = `직접비 미입력 계약 ${fin!.n}건`;
  return out;
}
