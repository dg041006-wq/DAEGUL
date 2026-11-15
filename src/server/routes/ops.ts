// 운영 업무 API: 작업(촬영·스타일링·시공·브랜딩) → 일정 → 납품 → 정산, 고객 이력, 검색, 첨부,
// 경영 제안, 고객 발송 큐, 자동응답 규칙, 푸시, 실시간 동기화, 시트 가져오기, 대표 보고 피드.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../db/pool.js";
import { scopeOf } from "../auth/request.js";
import { can, contactAccessSql, conversationAccessSql, ForbiddenError, NotFoundError, projectAccessSql, requireOwner, requirePerm, type Scope } from "../auth/scope.js";
import { audit } from "../lib/audit.js";
import { recordEvent } from "../lib/events.js";
import { getVapid, sendPushToUser } from "../lib/push.js";
import { subscribe } from "../lib/realtime.js";
import { addDays, kstDateString } from "../lib/time.js";
import { deliveryRisks, prepMissing, receivables, schedule } from "../analytics/operations.js";
import { awaitingHuman, quoteAwaitingReply } from "../analytics/metrics.js";
import { createTask } from "../lib/tasks.js";
import { applyEvent } from "../ingest/ingest.js";
import { createOutbound, decideOutbound, validateAutoTemplate } from "../lib/outbound.js";
import { commitImport, createPreview, FLAG_LABELS, readXlsx } from "../lib/sheetImport.js";
import { fetchSheetGrid, sheetsConfigured } from "../lib/sheetsSync.js";
import { generateIdeas } from "../jobs/ideas.js";
import { eraseContact } from "../jobs/automation.js";
import { executeFeedAction } from "../ai/employees.js";
import { DEFAULT_CHECKLIST, PROJECT_STATUSES } from "../../shared/domain.js";
import { BUILD_ID } from "../version.js";

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export async function getAccessibleProject(s: Scope, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  const params: unknown[] = [];
  const acc = projectAccessSql(s, "p", params);
  params.push(id);
  const p = await q1<any>(`SELECT p.* FROM projects p WHERE ${acc} AND p.id=$${params.length}`, params);
  if (!p) throw new NotFoundError("작업을 찾을 수 없거나 권한이 없습니다.");
  if (!can(s, "view_finance")) {
    p.listed_price = null;
    p.agreed_amount = null;
  }
  return p;
}

async function getAccessibleContact(s: Scope, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  const params: unknown[] = [];
  const acc = contactAccessSql(s, "ct", params);
  params.push(id);
  const c = await q1<any>(`SELECT ct.* FROM contacts ct WHERE ${acc} AND ct.id=$${params.length}`, params);
  if (!c) throw new NotFoundError("고객을 찾을 수 없거나 권한이 없습니다.");
  return c;
}

const checklistFrom = () => [
  ...DEFAULT_CHECKLIST.pre.map((label, i) => ({ id: `pre${i}`, phase: "pre", label, done: false, done_at: null })),
  ...DEFAULT_CHECKLIST.post.map((label, i) => ({ id: `post${i}`, phase: "post", label, done: false, done_at: null })),
];

const projectBody = z.object({
  title: z.string().min(1).max(200).optional(),
  contact_id: uuid.nullable().optional(),
  opportunity_id: uuid.nullable().optional(),
  work_type: z.string().max(20).nullable().optional(),
  package: z.string().max(20).nullable().optional(),
  scheduled_date: dateStr.nullable().optional(),
  start_time: timeStr.nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  listed_price: z.number().int().nonnegative().nullable().optional(),
  agreed_amount: z.number().int().nonnegative().nullable().optional(),
  delivery_due: dateStr.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  cash_receipt: z.string().max(200).nullable().optional(),
  assignee_user_id: uuid.nullable().optional(),
  version: z.number().int().optional(),
});

export async function opsRoutes(app: FastifyInstance) {
  // ───── 버전 (새 버전 반영 확인용, 로그인 불필요) ─────
  app.get("/api/version", async () => ({ build: BUILD_ID }));

  // ───── 실시간 동기화 (SSE) ─────
  app.get("/api/stream", async (req, reply) => {
    const s = scopeOf(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ build: BUILD_ID, at: new Date().toISOString() })}\n\n`);
    const unsub = await subscribe(s.orgId, (m) => res.write(`data: ${JSON.stringify(m)}\n\n`));
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.raw.on("close", () => {
      clearInterval(ping);
      unsub();
    });
  });

  // ───── 오늘 보드 (대표용 한 화면) ─────
  app.get("/api/today", async (req) => {
    const s = scopeOf(req);
    const today = kstDateString(new Date());
    const params: unknown[] = [s.orgId];
    const mine = can(s, "view_all_conversations") ? "" : "AND t.assignee_user_id=$2";
    if (mine) params.push(s.userId);
    const tasks = await q(
      `SELECT t.id, t.title, t.due_at, t.status, t.source, t.conversation_id, t.opportunity_id, t.project_id, t.version, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id=t.assignee_user_id
       WHERE t.org_id=$1 ${mine} AND t.status='open' AND (t.due_at IS NULL OR t.due_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') + interval '2 day') AT TIME ZONE 'Asia/Seoul')
       ORDER BY t.due_at NULLS LAST LIMIT 40`,
      params,
    );
    const sch = await schedule(s, today, addDays(today, 1));
    const recv = await receivables(s);
    const decisions = await q<any>(
      `SELECT 'stage_change' AS kind, count(*) AS n FROM approvals WHERE org_id=$1 AND kind='stage_change' AND status='draft'
       UNION ALL SELECT 'reply_draft', count(*) FROM approvals WHERE org_id=$1 AND kind='reply_draft' AND status='draft'
       UNION ALL SELECT 'outbound', count(*) FROM outbound_messages WHERE org_id=$1 AND status IN ('pending_approval','unknown','failed')
       UNION ALL SELECT 'ideas', count(*) FROM ideas WHERE org_id=$1 AND status='proposed'
       UNION ALL SELECT 'sheet_review', count(*) FROM sheet_import_rows r JOIN sheet_imports i ON i.id=r.import_id WHERE i.org_id=$1 AND i.status='previewed' AND r.decision='review'`,
      [s.orgId],
    );
    const reports = await q(
      `SELECT id, kind, title, created_at, status, is_test FROM reports WHERE org_id=$1 ${can(s, "view_analytics") && can(s, "view_finance") ? "" : "AND false"} ORDER BY created_at DESC LIMIT 5`,
      [s.orgId],
    );
    const awaiting = await awaitingHuman(s, 20);
    return {
      today,
      tasks,
      schedule: sch,
      awaiting,
      quoteAwaiting: (await quoteAwaitingReply(s)).length,
      deliveryRisks: await deliveryRisks(s, today),
      prepMissingTomorrow: await prepMissing(s, addDays(today, 1)),
      receivables: recv.restricted ? null : { count: recv.due.length, total: recv.due.reduce((a: number, r: any) => a + r.outstanding, 0), unconfirmed: recv.unconfirmedAmount.length },
      decisions: decisions.filter((d) => Number(d.n) > 0),
      reports,
    };
  });

  // ───── 작업 ─────
  app.get("/api/projects", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ status: z.string().optional(), contact: uuid.optional(), from: dateStr.optional(), to: dateStr.optional(), flagged: z.coerce.boolean().optional(), origin: z.string().optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = [projectAccessSql(s, "p", params)];
    if (qs.status) {
      params.push(qs.status);
      where.push(`p.status=$${params.length}`);
    }
    if (qs.contact) {
      params.push(qs.contact);
      where.push(`p.contact_id=$${params.length}`);
    }
    if (qs.from) {
      params.push(qs.from);
      where.push(`p.scheduled_date >= $${params.length}::date`);
    }
    if (qs.to) {
      params.push(qs.to);
      where.push(`p.scheduled_date <= $${params.length}::date`);
    }
    if (qs.flagged) where.push(`cardinality(p.flags) > 0`);
    if (qs.origin) {
      params.push(qs.origin);
      where.push(`p.data_origin=$${params.length}`);
    }
    const fin = can(s, "view_finance");
    return q(
      `SELECT p.id, p.title, p.work_type, p.package, p.scheduled_date, p.start_time, p.time_raw, p.address, p.status, p.flags, p.data_origin, p.delivery_due,
              p.contact_id, ct.display_name, u.name AS assignee_name, p.version,
              ${fin ? "p.listed_price, p.agreed_amount, (SELECT COALESCE(sum(amount),0) FROM payments pm WHERE pm.project_id=p.id AND pm.status='confirmed') AS paid, (SELECT count(*) FROM payments pm WHERE pm.project_id=p.id AND pm.status='claimed') AS claimed" : "NULL AS listed_price, NULL AS agreed_amount, NULL AS paid, NULL AS claimed"}
       FROM projects p LEFT JOIN contacts ct ON ct.id=p.contact_id LEFT JOIN users u ON u.id=p.assignee_user_id
       WHERE ${where.join(" AND ")} ORDER BY p.scheduled_date DESC NULLS FIRST, p.created_at DESC LIMIT 500`,
      params,
    );
  });

  app.get("/api/projects/:id", async (req) => {
    const s = scopeOf(req);
    const p = await getAccessibleProject(s, (req.params as any).id);
    const fin = can(s, "view_finance");
    const [contact, payments, costs, attachments, tasks, activity, events] = await Promise.all([
      p.contact_id ? q1(`SELECT id, display_name, phone, email FROM contacts WHERE id=$1`, [p.contact_id]) : null,
      fin ? q(`SELECT * FROM payments WHERE project_id=$1 ORDER BY paid_at`, [p.id]) : [],
      fin ? q(`SELECT * FROM costs WHERE project_id=$1 ORDER BY incurred_at`, [p.id]) : [],
      q(`SELECT id, filename, mime, size_bytes, created_at FROM attachments WHERE project_id=$1 ORDER BY created_at DESC`, [p.id]),
      q(`SELECT id, title, status, due_at, version FROM tasks WHERE project_id=$1 ORDER BY status, due_at NULLS LAST`, [p.id]),
      q(`SELECT a.action, a.detail, a.created_at, u.name AS actor_name, a.actor_type FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.org_id=$1 AND a.target_id=$2 ORDER BY a.created_at DESC LIMIT 50`, [s.orgId, p.id]),
      q(`SELECT kind, title, severity, created_at FROM events WHERE org_id=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 20`, [s.orgId, p.id]),
    ]);
    return { project: p, contact, payments, costs, attachments, tasks, activity, events, financeVisible: fin, flagLabels: Object.fromEntries((p.flags ?? []).map((f: string) => [f, FLAG_LABELS[f] ?? f])) };
  });

  app.post("/api/projects", async (req) => {
    const s = scopeOf(req);
    const b = projectBody.extend({ title: z.string().min(1).max(200) }).parse(req.body);
    if ((b.listed_price != null || b.agreed_amount != null) && !can(s, "view_finance")) throw new ForbiddenError("금액 입력 권한이 없습니다.");
    let contactId = b.contact_id ?? null;
    if (b.opportunity_id) {
      const o = await q1<any>(`SELECT contact_id FROM opportunities WHERE id=$1 AND org_id=$2`, [b.opportunity_id, s.orgId]);
      if (!o) throw new NotFoundError();
      contactId ??= o.contact_id;
    }
    if (contactId) await getAccessibleContact(s, contactId);
    const p = await q1<any>(
      `INSERT INTO projects(org_id, contact_id, opportunity_id, title, work_type, package, scheduled_date, start_time, address, status, listed_price, agreed_amount, delivery_due, notes, assignee_user_id, checklist, data_origin, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual',$17) RETURNING *`,
      [s.orgId, contactId, b.opportunity_id ?? null, b.title, b.work_type ?? null, b.package ?? null, b.scheduled_date ?? null, b.start_time ?? null, b.address ?? null, b.status ?? (b.scheduled_date ? "scheduled" : "unscheduled"), b.listed_price ?? null, b.agreed_amount ?? null, b.delivery_due ?? null, b.notes ?? null, b.assignee_user_id ?? s.userId, JSON.stringify(checklistFrom()), s.userId],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "project.create", targetType: "project", targetId: p.id });
    return p;
  });

  app.patch("/api/projects/:id", async (req) => {
    const s = scopeOf(req);
    const p = await getAccessibleProject(s, (req.params as any).id);
    const b = projectBody.parse(req.body);
    if (b.version !== undefined && b.version !== p.version) throw Object.assign(new Error("다른 기기에서 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 시도하세요."), { status: 409 });
    if ((b.listed_price !== undefined || b.agreed_amount !== undefined) && !can(s, "view_finance")) throw new ForbiddenError("금액 수정 권한이 없습니다.");
    if (b.assignee_user_id !== undefined && b.assignee_user_id !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError();
    if (b.contact_id) await getAccessibleContact(s, b.contact_id);
    const fields = Object.keys(b).filter((k) => k !== "version") as Array<keyof typeof b>;
    if (!fields.length) return p;
    const sets: string[] = [];
    const vals: unknown[] = [p.id];
    for (const k of fields) {
      vals.push(b[k] as unknown);
      sets.push(`${k}=$${vals.length}`);
    }
    if (b.status === "delivered" && !p.delivered_at) sets.push(`delivered_at=now()`);
    if (b.status === "revision" && p.status !== "revision") sets.push(`revision_count=revision_count+1`);
    // 사람이 확인해 수정한 항목은 확인 필요 표시에서 제거
    if (b.scheduled_date !== undefined) sets.push(`flags=array_remove(array_remove(array_remove(flags,'date_inherited'),'weekday_mismatch'),'no_date_unscheduled')`);
    const r = await q1<any>(`UPDATE projects SET ${sets.join(", ")}, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, vals);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "project.update", targetType: "project", targetId: p.id, detail: Object.fromEntries(fields.map((k) => [k, { from: (p as any)[k] ?? null, to: b[k] ?? null }])) });
    const isTest = p.data_origin === "test";
    if ((b.scheduled_date !== undefined && b.scheduled_date !== (p.scheduled_date ? kstDateString(new Date(p.scheduled_date)) : null)) || (b.start_time !== undefined && b.start_time !== p.start_time))
      await recordEvent(s.orgId, {
        kind: "schedule_changed",
        title: `일정 변경: ${p.title} → ${b.scheduled_date ?? (p.scheduled_date ? kstDateString(new Date(p.scheduled_date)) : "날짜 미정")} ${b.start_time ?? p.start_time ?? ""}`.trim(),
        dedupeKey: `sched:${p.id}:${r.version}`,
        entityType: "project",
        entityId: p.id,
        link: `/projects/${p.id}`,
        isTest,
      });
    if (b.status === "cancelled" && p.status !== "cancelled")
      await recordEvent(s.orgId, { kind: "cancelled", title: `작업 취소: ${p.title}`, dedupeKey: `pcancel:${p.id}:${r.version}`, entityType: "project", entityId: p.id, link: `/projects/${p.id}`, isTest });
    if (b.status && b.status !== p.status && b.status !== "cancelled")
      await recordEvent(s.orgId, { kind: "status_change", title: `작업 상태: ${p.title} → ${b.status}`, dedupeKey: `pstatus:${p.id}:${r.version}`, entityType: "project", entityId: p.id, link: `/projects/${p.id}`, isTest });
    return r;
  });

  app.post("/api/projects/:id/checklist", async (req) => {
    const s = scopeOf(req);
    const p = await getAccessibleProject(s, (req.params as any).id);
    const b = z.object({ item_id: z.string().max(40).optional(), done: z.boolean().optional(), add: z.object({ phase: z.enum(["pre", "post"]), label: z.string().min(1).max(100) }).optional() }).parse(req.body);
    let list: any[] = Array.isArray(p.checklist) && p.checklist.length ? p.checklist : checklistFrom();
    if (b.add) list = [...list, { id: `c${crypto.randomBytes(3).toString("hex")}`, phase: b.add.phase, label: b.add.label, done: false, done_at: null }];
    if (b.item_id) list = list.map((c) => (c.id === b.item_id ? { ...c, done: !!b.done, done_at: b.done ? new Date().toISOString() : null, done_by: s.userId } : c));
    const r = await q1(`UPDATE projects SET checklist=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING checklist, version`, [p.id, JSON.stringify(list)]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "project.checklist", targetType: "project", targetId: p.id, detail: b });
    return r;
  });

  // 입금: confirmed(통장 등으로 확인) / claimed(고객 주장·시트 기재, 미확인)
  app.post("/api/projects/:id/payments", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const p = await getAccessibleProject(s, (req.params as any).id);
    const b = z
      .object({ amount: z.number().int().nullable(), paid_at: z.string().datetime({ offset: true }), kind: z.enum(["deposit", "balance", "full", "refund", "other"]).default("other"), status: z.enum(["confirmed", "claimed"]), evidence: z.string().max(500).optional() })
      .parse(req.body);
    if (b.status === "confirmed" && (b.amount == null || !b.evidence?.trim())) throw Object.assign(new Error("확인된 입금은 금액과 확인 근거(예: 통장 입금 내역 확인)가 필요합니다."), { status: 400 });
    const r = await q1<any>(`INSERT INTO payments(org_id, project_id, amount, paid_at, kind, status, evidence, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [s.orgId, p.id, b.amount, b.paid_at, b.kind, b.status, b.evidence ?? null, s.userId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: `payment.${b.status}`, targetType: "project", targetId: p.id });
    if (b.status === "confirmed")
      await recordEvent(s.orgId, {
        kind: "payment_confirmed",
        title: `입금 확인: ${p.title} · ${b.amount!.toLocaleString("ko-KR")}원`,
        dedupeKey: `payment:${r.id}`,
        entityType: "project",
        entityId: p.id,
        link: `/projects/${p.id}`,
        isTest: p.data_origin === "test",
        feedText: `대표님, 입금이 확인됐습니다. ${p.title} · ${b.amount!.toLocaleString("ko-KR")}원 (근거: ${b.evidence})`,
      });
    return r;
  });

  app.post("/api/payments/:id/confirm", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const pm = await q1<any>(`SELECT * FROM payments WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!pm || !pm.project_id) throw new NotFoundError();
    const p = await getAccessibleProject(s, pm.project_id);
    const b = z.object({ amount: z.number().int().positive(), paid_at: z.string().datetime({ offset: true }), evidence: z.string().min(2).max(500) }).parse(req.body);
    await q(`UPDATE payments SET status='confirmed', amount=$2, paid_at=$3, evidence=$4 WHERE id=$1`, [pm.id, b.amount, b.paid_at, b.evidence]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "payment.confirm", targetType: "project", targetId: p.id });
    await recordEvent(s.orgId, { kind: "payment_confirmed", title: `입금 확인: ${p.title} · ${b.amount.toLocaleString("ko-KR")}원`, dedupeKey: `payment:${pm.id}`, entityType: "project", entityId: p.id, link: `/projects/${p.id}` });
    return { ok: true };
  });

  app.post("/api/projects/:id/costs", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const p = await getAccessibleProject(s, (req.params as any).id);
    const b = z
      .object({ category: z.enum(["direct_material", "direct_outsourcing", "direct_other", "internal_labor", "fixed"]), amount: z.number().int().nonnegative(), incurred_at: z.string().datetime({ offset: true }), payee: z.string().max(100).optional(), note: z.string().max(300).optional() })
      .parse(req.body);
    const r = await q1(`INSERT INTO costs(org_id, project_id, category, amount, incurred_at, payee, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [s.orgId, p.id, b.category, b.amount, b.incurred_at, b.payee ?? null, b.note ?? null, s.userId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "cost.create", targetType: "project", targetId: p.id });
    return r;
  });

  // ───── 일정 ─────
  app.get("/api/schedule", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
    const from = qs.from ?? kstDateString(new Date());
    const to = qs.to ?? addDays(from, 30);
    return { from, to, ...(await schedule(s, from, to)) };
  });
  app.post("/api/schedule-blocks", async (req) => {
    const s = scopeOf(req);
    const b = z.object({ date: dateStr, label: z.string().min(1).max(200), person_label: z.string().max(50).optional(), kind: z.enum(["personal", "business"]).default("business") }).parse(req.body);
    const r = await q1(`INSERT INTO schedule_blocks(org_id, date, label, person_label, kind, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [s.orgId, b.date, b.label, b.person_label ?? null, b.kind, s.userId]);
    return r;
  });
  app.delete("/api/schedule-blocks/:id", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    await q(`DELETE FROM schedule_blocks WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    return { ok: true };
  });

  // ───── 정산 ─────
  app.get("/api/settlement", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const r = await receivables(s);
    const monthly = await q(
      `SELECT to_char(paid_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month, COALESCE(sum(amount) FILTER (WHERE status='confirmed'),0) AS confirmed, count(*) FILTER (WHERE status='claimed') AS claimed
       FROM payments WHERE org_id=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
      [s.orgId],
    );
    const listed = await q(
      `SELECT to_char(scheduled_date, 'YYYY-MM') AS month, count(*) AS jobs, COALESCE(sum(listed_price),0) AS listed, COALESCE(sum(agreed_amount),0) AS agreed, count(*) FILTER (WHERE agreed_amount IS NULL) AS unconfirmed
       FROM projects WHERE org_id=$1 AND scheduled_date IS NOT NULL AND status <> 'cancelled' AND data_origin NOT IN ('test','sample') GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
      [s.orgId],
    );
    const claims = await q(
      `SELECT pm.id, pm.amount, pm.paid_at, pm.evidence, p.id AS project_id, p.title FROM payments pm JOIN projects p ON p.id=pm.project_id WHERE pm.org_id=$1 AND pm.status='claimed' ORDER BY pm.paid_at DESC LIMIT 100`,
      [s.orgId],
    );
    return {
      receivables: r,
      monthly,
      listedByMonth: listed,
      claims,
      notes: [
        "확인 입금: 담당자가 통장 등으로 확인해 기록한 입금만 합산합니다.",
        "고객 주장/시트 기재 입금은 '확인 필요'로 따로 표시하며 합계에 넣지 않습니다.",
        "시트 단가는 기록된 단가일 뿐 확정 계약 금액이 아닙니다. 확정 금액을 입력하면 미수금 계산에 반영됩니다.",
      ],
    };
  });

  // ───── 고객 ─────
  app.get("/api/contacts", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ q: z.string().max(50).optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = [contactAccessSql(s, "ct", params)];
    if (qs.q) {
      params.push(`%${qs.q}%`);
      where.push(`(ct.display_name ILIKE $${params.length} OR ct.phone ILIKE $${params.length} OR ct.email ILIKE $${params.length})`);
    }
    return q(
      `SELECT ct.id, ct.display_name, ct.phone IS NOT NULL AS has_phone, ct.data_origin, ct.created_at,
         (SELECT count(*) FROM projects p WHERE p.contact_id=ct.id) AS projects,
         (SELECT count(*) FROM conversations c WHERE c.contact_id=ct.id) AS conversations,
         (SELECT max(scheduled_date) FROM projects p WHERE p.contact_id=ct.id) AS last_project_date,
         (SELECT max(last_message_at) FROM conversations c WHERE c.contact_id=ct.id) AS last_message_at
       FROM contacts ct WHERE ${where.join(" AND ")} ORDER BY GREATEST(COALESCE((SELECT max(last_message_at) FROM conversations c WHERE c.contact_id=ct.id), ct.created_at), ct.created_at) DESC LIMIT 300`,
      params,
    );
  });

  app.post("/api/contacts", async (req) => {
    const s = scopeOf(req);
    const b = z.object({ display_name: z.string().min(1).max(100), phone: z.string().max(30).optional(), email: z.string().email().optional(), memo: z.string().max(1000).optional() }).parse(req.body);
    const r = await q1(
      `INSERT INTO contacts(org_id, provider, external_user_id, display_name, phone, email, memo, data_origin) VALUES ($1,'manual',$2,$3,$4,$5,$6,'manual') RETURNING *`,
      [s.orgId, `manual:${crypto.randomUUID()}`, b.display_name, b.phone ?? null, b.email ?? null, b.memo ?? null],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "contact.create", targetType: "contact", targetId: r.id });
    return r;
  });

  app.get("/api/contacts/:id", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleContact(s, (req.params as any).id);
    const fin = can(s, "view_finance");
    const [opps, convs, projects, attachments, tasks] = await Promise.all([
      q(`SELECT id, title, stage, services, opened_at FROM opportunities WHERE contact_id=$1 AND merged_into_id IS NULL ORDER BY opened_at DESC`, [c.id]),
      q(`SELECT id, status, opened_at, last_message_at, ai_summary, data_origin FROM conversations WHERE contact_id=$1 ORDER BY opened_at DESC`, [c.id]),
      q(
        `SELECT p.id, p.title, p.work_type, p.scheduled_date, p.status, p.delivery_due, p.flags, ${fin ? "p.listed_price, p.agreed_amount, (SELECT COALESCE(sum(amount),0) FROM payments pm WHERE pm.project_id=p.id AND pm.status='confirmed') AS paid" : "NULL AS listed_price, NULL AS agreed_amount, NULL AS paid"}
         FROM projects p WHERE p.contact_id=$1 ORDER BY p.scheduled_date DESC NULLS FIRST`,
        [c.id],
      ),
      q(`SELECT id, filename, mime, size_bytes, created_at FROM attachments WHERE contact_id=$1 ORDER BY created_at DESC`, [c.id]),
      q(`SELECT id, title, status, due_at FROM tasks WHERE contact_id=$1 OR project_id IN (SELECT id FROM projects WHERE contact_id=$1) OR conversation_id IN (SELECT id FROM conversations WHERE contact_id=$1) ORDER BY status, due_at NULLS LAST LIMIT 50`, [c.id]),
    ]);
    const quotes = fin ? await q(`SELECT qq.amount, qq.sent_at, qq.opportunity_id FROM quotes qq JOIN opportunities o ON o.id=qq.opportunity_id WHERE o.contact_id=$1 ORDER BY sent_at`, [c.id]) : [];
    const contracts = fin ? await q(`SELECT k.amount, k.signed_at, k.channel, k.opportunity_id FROM contracts k JOIN opportunities o ON o.id=k.opportunity_id WHERE o.contact_id=$1 ORDER BY signed_at`, [c.id]) : [];
    // 시간순 이력: 문의·견적·계약·작업·납품·입금
    const timeline = [
      ...convs.map((x: any) => ({ at: x.opened_at, kind: "문의", label: x.ai_summary?.slice(0, 80) ?? "상담 시작", link: `/inbox/${x.id}` })),
      ...quotes.map((x: any) => ({ at: x.sent_at, kind: "견적", label: x.amount != null ? `${Number(x.amount).toLocaleString("ko-KR")}원` : "금액 미기재", link: `/pipeline/${x.opportunity_id}` })),
      ...contracts.map((x: any) => ({ at: x.signed_at, kind: "계약", label: `${x.amount != null ? Number(x.amount).toLocaleString("ko-KR") + "원" : ""} (${x.channel})`, link: `/pipeline/${x.opportunity_id}` })),
      ...projects.map((x: any) => ({ at: x.scheduled_date, kind: "작업", label: `${x.title} · ${x.status}`, link: `/projects/${x.id}` })),
    ]
      .filter((x) => x.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { contact: { ...c, phone: c.phone, email: c.email }, opportunities: opps, conversations: convs, projects, attachments, tasks, timeline, financeVisible: fin };
  });

  app.patch("/api/contacts/:id", async (req) => {
    const s = scopeOf(req);
    const c = await getAccessibleContact(s, (req.params as any).id);
    const b = z.object({ display_name: z.string().min(1).max(100).optional(), phone: z.string().max(30).nullable().optional(), email: z.string().email().nullable().optional(), memo: z.string().max(2000).nullable().optional() }).parse(req.body);
    await q(
      `UPDATE contacts SET display_name=COALESCE($2,display_name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END, email=CASE WHEN $5::boolean THEN $6 ELSE email END, memo=CASE WHEN $7::boolean THEN $8 ELSE memo END, updated_at=now() WHERE id=$1`,
      [c.id, b.display_name ?? null, b.phone !== undefined, b.phone ?? null, b.email !== undefined, b.email ?? null, b.memo !== undefined, b.memo ?? null],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "contact.update", targetType: "contact", targetId: c.id, detail: { fields: Object.keys(b) } });
    return { ok: true };
  });

  app.post("/api/contacts/:id/erase", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const c = await getAccessibleContact(s, (req.params as any).id);
    return eraseContact(s.orgId, c.id, s.userId);
  });

  // ───── 통합 검색 ─────
  app.get("/api/search", async (req) => {
    const s = scopeOf(req);
    const { q: term } = z.object({ q: z.string().min(1).max(50) }).parse(req.query);
    const like = `%${term}%`;
    const p1: unknown[] = [];
    const ca = contactAccessSql(s, "ct", p1);
    p1.push(like);
    const contacts = await q(`SELECT ct.id, ct.display_name FROM contacts ct WHERE ${ca} AND (ct.display_name ILIKE $${p1.length} OR ct.phone ILIKE $${p1.length} OR ct.email ILIKE $${p1.length}) LIMIT 10`, p1);
    const p2: unknown[] = [];
    const pa = projectAccessSql(s, "p", p2);
    p2.push(like);
    const projects = await q(`SELECT p.id, p.title, p.scheduled_date, p.status FROM projects p WHERE ${pa} AND (p.title ILIKE $${p2.length} OR p.address ILIKE $${p2.length} OR p.notes ILIKE $${p2.length}) ORDER BY p.scheduled_date DESC NULLS LAST LIMIT 10`, p2);
    const p3: unknown[] = [];
    const cv = conversationAccessSql(s, "c", p3);
    p3.push(like);
    const messages = await q(
      `SELECT m.id, m.conversation_id, left(m.body, 120) AS snippet, m.sent_at, ct.display_name FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id
       WHERE ${cv} AND m.body ILIKE $${p3.length} ORDER BY m.sent_at DESC LIMIT 10`,
      p3,
    );
    const reports = can(s, "view_analytics") && can(s, "view_finance") ? await q(`SELECT id, title, created_at FROM reports WHERE org_id=$1 AND (title ILIKE $2 OR body ILIKE $2) ORDER BY created_at DESC LIMIT 5`, [s.orgId, like]) : [];
    const tasks = await q(`SELECT id, title, status, due_at FROM tasks WHERE org_id=$1 AND title ILIKE $2 ${can(s, "view_all_conversations") ? "" : "AND assignee_user_id=$3"} ORDER BY created_at DESC LIMIT 10`, can(s, "view_all_conversations") ? [s.orgId, like] : [s.orgId, like, s.userId]);
    return { contacts, projects, messages, reports, tasks };
  });

  // ───── 첨부 (10MB, DB 저장) ─────
  app.post("/api/attachments", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const s = scopeOf(req);
    const b = z
      .object({ contact_id: uuid.optional(), project_id: uuid.optional(), conversation_id: uuid.optional(), filename: z.string().min(1).max(200), mime: z.string().max(100), data_base64: z.string().min(1) })
      .refine((v) => v.contact_id || v.project_id || v.conversation_id, "연결 대상이 필요합니다.")
      .parse(req.body);
    if (b.project_id) await getAccessibleProject(s, b.project_id);
    if (b.contact_id) await getAccessibleContact(s, b.contact_id);
    if (b.conversation_id) {
      const { getAccessibleConversation } = await import("./core.js");
      await getAccessibleConversation(s, b.conversation_id);
    }
    const data = Buffer.from(b.data_base64, "base64");
    if (data.length > 10 * 1024 * 1024) throw Object.assign(new Error("첨부는 10MB 이하만 가능합니다."), { status: 413 });
    const r = await q1(
      `INSERT INTO attachments(org_id, contact_id, project_id, conversation_id, filename, mime, size_bytes, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, filename, size_bytes`,
      [s.orgId, b.contact_id ?? null, b.project_id ?? null, b.conversation_id ?? null, b.filename, b.mime || "application/octet-stream", data.length, data, s.userId],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "attachment.upload", targetType: "attachment", targetId: r.id });
    return r;
  });
  app.get("/api/attachments/:id", async (req, reply) => {
    const s = scopeOf(req);
    const a = await q1<any>(`SELECT * FROM attachments WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!a) throw new NotFoundError();
    if (a.project_id) await getAccessibleProject(s, a.project_id);
    if (a.contact_id) await getAccessibleContact(s, a.contact_id);
    if (a.conversation_id) {
      const { getAccessibleConversation } = await import("./core.js");
      await getAccessibleConversation(s, a.conversation_id);
    }
    reply.header("content-type", a.mime).header("cache-control", "private, no-store").header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    return reply.send(a.data);
  });
  app.delete("/api/attachments/:id", async (req) => {
    const s = scopeOf(req);
    const a = await q1<any>(`SELECT * FROM attachments WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!a) throw new NotFoundError();
    if (a.uploaded_by !== s.userId) requireOwner(s);
    await q(`DELETE FROM attachments WHERE id=$1`, [a.id]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "attachment.delete", targetType: "attachment", targetId: a.id });
    return { ok: true };
  });

  // ───── 경영 제안 ─────
  app.get("/api/ideas", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_analytics");
    return q(`SELECT i.*, u.name AS decided_by_name, t.status AS task_status FROM ideas i LEFT JOIN users u ON u.id=i.decided_by LEFT JOIN tasks t ON t.id=i.task_id WHERE i.org_id=$1 ORDER BY (i.status='proposed') DESC, i.created_at DESC`, [s.orgId]);
  });
  app.post("/api/ideas/run", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    return { created: await generateIdeas(s.orgId) };
  });
  app.post("/api/ideas/:id/decision", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const b = z
      .object({ decision: z.enum(["adopted", "held", "rejected"]), reason: z.string().min(1).max(500), assignee_user_id: uuid.optional(), due_at: z.string().datetime({ offset: true }).optional(), success_metric: z.string().max(300).optional(), actual_result: z.string().max(1000).optional() })
      .parse(req.body);
    const idea = await q1<any>(`SELECT * FROM ideas WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!idea) throw new NotFoundError();
    let taskId: string | null = idea.task_id;
    if (b.decision === "adopted" && !taskId) {
      if (!b.due_at || !b.success_metric) throw Object.assign(new Error("채택하려면 기한과 성과 기준이 필요합니다."), { status: 400 });
      const t = await createTask(s, { title: `[제안 실행] ${idea.first_action}`, description: `${idea.title}\n성과 기준: ${b.success_metric}`, assignee_user_id: b.assignee_user_id ?? s.userId, due_at: b.due_at, source: "ai", source_reason: "경영 제안 채택" });
      taskId = t.id;
    }
    await q(`UPDATE ideas SET status=$2, decision_reason=$3, decided_by=$4, decided_at=now(), task_id=$5, success_metric=COALESCE($6, success_metric), actual_result=COALESCE($7, actual_result) WHERE id=$1`, [
      idea.id,
      b.decision,
      b.reason,
      s.userId,
      taskId,
      b.success_metric ?? null,
      b.actual_result ?? null,
    ]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: `idea.${b.decision}`, targetType: "idea", targetId: idea.id, detail: { reason: b.reason } });
    return { ok: true, task_id: taskId };
  });

  // ───── 고객 발송 큐 ─────
  app.get("/api/outbound", async (req) => {
    const s = scopeOf(req);
    const params: unknown[] = [];
    const acc = conversationAccessSql(s, "c", params);
    return q(
      `SELECT o.id, o.conversation_id, o.recipient_label, o.body, o.status, o.channel, o.provider, o.created_by_type, o.attempts, o.last_error, o.created_at, o.sent_at, o.approved_at, ua.name AS approved_by_name
       FROM outbound_messages o JOIN conversations c ON c.id=o.conversation_id LEFT JOIN users ua ON ua.id=o.approved_by WHERE ${acc} ORDER BY o.created_at DESC LIMIT 200`,
      params,
    );
  });
  app.post("/api/conversations/:id/outbound", async (req) => {
    const s = scopeOf(req);
    const { getAccessibleConversation } = await import("./core.js");
    const c = await getAccessibleConversation(s, (req.params as any).id);
    const b = z.object({ body: z.string().min(1).max(4000), approval_id: uuid.optional(), client_key: z.string().max(80).optional() }).parse(req.body);
    const key = b.client_key ? `user:${s.userId}:${b.client_key}` : b.approval_id ? `draft:${b.approval_id}` : `user:${crypto.createHash("sha1").update(c.id + b.body).digest("hex")}`;
    const r = await createOutbound(s, { orgId: s.orgId, conversationId: c.id, body: b.body, createdByType: b.approval_id ? "ai" : "user", idempotencyKey: key });
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "outbound.create", targetType: "outbound", targetId: r.id });
    return r;
  });
  app.post("/api/outbound/:id/decision", async (req) => {
    const s = scopeOf(req);
    const b = z.object({ decision: z.enum(["approve", "cancel", "sent_manually", "retry", "check_status"]) }).parse(req.body);
    return decideOutbound(s, (req.params as any).id, b.decision);
  });

  // ───── 자동응답 규칙 (대표만, 금지 표현 차단) ─────
  app.get("/api/auto-replies", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    return q(`SELECT * FROM auto_reply_rules WHERE org_id=$1 ORDER BY created_at`, [s.orgId]);
  });
  app.post("/api/auto-replies", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const b = z.object({ id: uuid.optional(), name: z.string().min(1).max(50), template: z.string().min(1).max(500), enabled: z.boolean() }).parse(req.body);
    const err = validateAutoTemplate(b.template);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    const r = b.id
      ? await q1(`UPDATE auto_reply_rules SET name=$3, template=$4, enabled=$5, updated_at=now() WHERE id=$1 AND org_id=$2 RETURNING *`, [b.id, s.orgId, b.name, b.template, b.enabled])
      : await q1(`INSERT INTO auto_reply_rules(org_id, name, trigger, template, enabled, created_by) VALUES ($1,$2,'outside_hours_first_message',$3,$4,$5) RETURNING *`, [s.orgId, b.name, b.template, b.enabled, s.userId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "auto_reply.save", targetType: "auto_reply", targetId: (r as any)?.id, detail: { enabled: b.enabled } });
    return r;
  });

  // ───── 푸시 ─────
  app.get("/api/push/vapid", async (req) => {
    const s = scopeOf(req);
    const v = await getVapid();
    const subs = await q(`SELECT id, user_agent, created_at, last_success_at, last_error, disabled_at FROM push_subscriptions WHERE user_id=$1 ORDER BY created_at DESC`, [s.userId]);
    return { publicKey: v.publicKey, subscriptions: subs };
  });
  app.post("/api/push/subscribe", async (req) => {
    const s = scopeOf(req);
    const b = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }).parse(req.body);
    await q(
      `INSERT INTO push_subscriptions(org_id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (endpoint) DO UPDATE SET org_id=EXCLUDED.org_id, user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, disabled_at=NULL, last_error=NULL`,
      [s.orgId, s.userId, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers["user-agent"] ?? "").slice(0, 200)],
    );
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "push.subscribe" });
    return { ok: true };
  });
  app.post("/api/push/unsubscribe", async (req) => {
    const s = scopeOf(req);
    const b = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await q(`DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2`, [b.endpoint, s.userId]);
    return { ok: true };
  });
  app.post("/api/push/test", async (req) => {
    const s = scopeOf(req);
    const r = await sendPushToUser(s.userId, { title: "[테스트] STAYSCENE 알림이 정상 동작합니다", link: "/notifications", tag: `test-${Date.now()}` });
    await q(`INSERT INTO notifications(org_id, user_id, kind, title, link, severity, push_status, push_error) VALUES ($1,$2,'push_test','[테스트] 푸시 알림 확인','/notifications','info',$3,$4)`, [
      s.orgId,
      s.userId,
      r.status,
      r.error ?? null,
    ]);
    return r;
  });

  // ───── 상담 수동 등록 / 테스트 수신 ─────
  app.post("/api/conversations/manual", async (req) => {
    const s = scopeOf(req);
    const b = z
      .object({
        customer_name: z.string().min(1).max(100),
        phone: z.string().max(30).optional(),
        channel_label: z.string().max(30).default("수동 등록"),
        test: z.boolean().default(false),
        messages: z.array(z.object({ sender: z.enum(["customer", "staff"]), text: z.string().min(1).max(4000), sent_at: z.string().datetime({ offset: true }).optional() })).min(1).max(50),
      })
      .parse(req.body);
    const provider = b.test ? "test" : "manual";
    const convExt = `${provider}:${crypto.randomUUID()}`;
    const userExt = b.phone ? `phone:${b.phone.replace(/\D/g, "")}` : `name:${b.customer_name}`;
    let result: any = null;
    for (const [i, m] of b.messages.entries()) {
      result = await applyEvent(s.orgId, provider, {
        kind: "message",
        externalEventId: `${convExt}:${i}`,
        contact: { externalUserId: userExt, displayName: b.customer_name },
        conversation: { externalConversationId: convExt, channel: b.channel_label },
        message: { externalMessageId: `${convExt}:${i}`, senderType: m.sender, senderName: m.sender === "staff" ? undefined : null, body: m.text, sentAt: m.sent_at ?? new Date(Date.now() + i).toISOString() },
      });
    }
    if (b.phone) await q(`UPDATE contacts SET phone=COALESCE(phone,$2) WHERE id=(SELECT contact_id FROM conversations WHERE id=$1)`, [result.conversationId, b.phone]);
    await q(`UPDATE conversations SET assignee_user_id=COALESCE(assignee_user_id,$2) WHERE id=$1`, [result.conversationId, s.userId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: b.test ? "conversation.test_inbound" : "conversation.manual_create", targetType: "conversation", targetId: result.conversationId });
    return { conversationId: result.conversationId, opportunityId: result.opportunityId };
  });

  // ───── 시트 가져오기 ─────
  app.post("/api/sheet-imports", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const b = z.object({ filename: z.string().max(200), data_base64: z.string().min(1) }).parse(req.body);
    const buf = Buffer.from(b.data_base64, "base64");
    if (buf.length > 10 * 1024 * 1024) throw Object.assign(new Error("10MB 이하 파일만 가능합니다."), { status: 413 });
    let grids;
    try {
      grids = await readXlsx(buf);
    } catch {
      throw Object.assign(new Error("엑셀(.xlsx) 파일을 읽을 수 없습니다. 구글시트에서 '파일 → 다운로드 → Microsoft Excel'로 받은 파일을 올려 주세요."), { status: 400 });
    }
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const r = await createPreview(s.orgId, s.userId, grids, "xlsx_upload", `${b.filename} (업로드 ${kstDateString(new Date())})`, sha);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "sheet_import.preview", targetType: "sheet_import", targetId: r.id });
    return r;
  });
  app.get("/api/sheet-imports", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    return q(`SELECT id, source_kind, source_label, status, summary, created_at, committed_at FROM sheet_imports WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20`, [s.orgId]);
  });
  app.get("/api/sheet-imports/:id", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const imp = await q1(`SELECT * FROM sheet_imports WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!imp) throw new NotFoundError();
    const rows = await q(`SELECT id, sheet_name, row_number, classification, raw, parsed, flags, decision, duplicate_of, created_refs FROM sheet_import_rows WHERE import_id=$1 AND classification <> 'empty_day' ORDER BY row_number`, [imp.id]);
    return { import: imp, rows, flagLabels: FLAG_LABELS };
  });
  app.patch("/api/sheet-import-rows/:id", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const b = z.object({ decision: z.enum(["import", "skip", "review"]) }).parse(req.body);
    const r = await q1(
      `UPDATE sheet_import_rows r SET decision=$3 FROM sheet_imports i WHERE r.id=$1 AND i.id=r.import_id AND i.org_id=$2 AND i.status='previewed' RETURNING r.id`,
      [(req.params as any).id, s.orgId, b.decision],
    );
    if (!r) throw new NotFoundError();
    return { ok: true };
  });
  app.post("/api/sheet-imports/:id/commit", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const r = await commitImport(s.orgId, s.userId, (req.params as any).id);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "sheet_import.commit", targetType: "sheet_import", targetId: (req.params as any).id, detail: r });
    return r;
  });
  app.post("/api/sheet-imports/:id/discard", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    await q(`UPDATE sheet_imports SET status='discarded' WHERE id=$1 AND org_id=$2 AND status='previewed'`, [(req.params as any).id, s.orgId]);
    return { ok: true };
  });
  app.get("/api/sheet-sync", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const cfg = await q1(`SELECT * FROM sheet_sync_config WHERE org_id=$1`, [s.orgId]);
    return { config: cfg ?? { status: "not_connected", enabled: false }, ...sheetsConfigured() };
  });
  app.put("/api/sheet-sync", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const b = z.object({ spreadsheet_id: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/), sheet_name: z.string().max(100).nullable().optional() }).parse(req.body);
    await q(
      `INSERT INTO sheet_sync_config(org_id, spreadsheet_id, sheet_name, status) VALUES ($1,$2,$3,'configured')
       ON CONFLICT (org_id) DO UPDATE SET spreadsheet_id=EXCLUDED.spreadsheet_id, sheet_name=EXCLUDED.sheet_name, status='configured', last_error=NULL, updated_at=now()`,
      [s.orgId, b.spreadsheet_id, b.sheet_name ?? null],
    );
    return { ok: true };
  });
  // 읽기 전용 동기화: 원본 시트를 읽어 '미리보기'만 만든다(자동 반영 안 함). 확정은 대표가 미리보기에서.
  app.post("/api/sheet-sync/pull", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const cfg = await q1<any>(`SELECT * FROM sheet_sync_config WHERE org_id=$1`, [s.orgId]);
    if (!cfg?.spreadsheet_id) throw Object.assign(new Error("스프레드시트 ID를 먼저 저장하세요."), { status: 400 });
    if (!sheetsConfigured().configured) throw Object.assign(new Error("서버에 GOOGLE_SERVICE_ACCOUNT_JSON이 설정되지 않아 구글시트에 연결할 수 없습니다."), { status: 503 });
    try {
      const grids = await fetchSheetGrid(cfg.spreadsheet_id, cfg.sheet_name);
      const r = await createPreview(s.orgId, s.userId, grids, "google_sheets", `구글시트 읽기 ${kstDateString(new Date())}`, null);
      await q(`UPDATE sheet_sync_config SET status='verified', last_sync_at=now(), last_error=NULL WHERE org_id=$1`, [s.orgId]);
      return r;
    } catch (e: any) {
      await q(`UPDATE sheet_sync_config SET status='error', last_error=$2 WHERE org_id=$1`, [s.orgId, String(e?.message ?? e).slice(0, 300)]);
      throw Object.assign(new Error(String(e?.message ?? e)), { status: 502 });
    }
  });

  // ───── 대표 보고 피드 (담당별 대표 전용 대화방) ─────
  app.get("/api/ai/feed", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ role: z.enum(["ops", "sales", "strategy"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    const params: unknown[] = [s.orgId, s.userId];
    let rf = "";
    if (qs.role) {
      params.push(qs.role);
      rf = `AND t.role_key=$3`;
    }
    params.push(qs.limit);
    return q(
      `SELECT m.id, m.thread_id, t.role_key, m.kind, m.content, m.actions, m.meta, m.created_at, m.read_at, e.kind AS event_kind, e.severity
       FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id LEFT JOIN events e ON e.id=m.event_id
       WHERE t.org_id=$1 AND t.owner_user_id=$2 AND t.kind='feed' ${rf} ORDER BY m.created_at DESC LIMIT $${params.length}`,
      params,
    );
  });
  app.post("/api/ai/feed/read", async (req) => {
    const s = scopeOf(req);
    await q(`UPDATE ai_messages m SET read_at=now() FROM ai_threads t WHERE t.id=m.thread_id AND t.owner_user_id=$1 AND t.kind='feed' AND m.read_at IS NULL`, [s.userId]);
    return { ok: true };
  });
  app.post("/api/ai/messages/:id/actions/:index", async (req) => {
    const s = scopeOf(req);
    const { id, index } = req.params as { id: string; index: string };
    return executeFeedAction(s, id, Number(index));
  });

  // ───── 활동 이력 ─────
  app.get("/api/activity", async (req) => {
    const s = scopeOf(req);
    requireOwner(s);
    const qs = z.object({ kind: z.string().optional(), test: z.coerce.boolean().optional() }).parse(req.query);
    return q(
      `SELECT id, kind, severity, role_key, title, link, is_test, reported, created_at FROM events WHERE org_id=$1 ${qs.kind ? "AND kind=$2" : ""} ORDER BY created_at DESC LIMIT 200`,
      qs.kind ? [s.orgId, qs.kind] : [s.orgId],
    );
  });

  void tx;
}
