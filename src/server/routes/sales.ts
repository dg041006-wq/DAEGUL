// 고객/영업 현황, 견적·계약, 이탈 근거, 합치기/분리, 분석실, 보고서
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, q1, tx } from "../db/pool.js";
import { scopeOf } from "../auth/request.js";
import { can, ForbiddenError, NotFoundError, opportunityAccessSql, requirePerm, type Scope } from "../auth/scope.js";
import { analyticsOverview, financeOverview } from "../analytics/metrics.js";
import { resolvePeriod } from "../lib/time.js";
import { audit } from "../lib/audit.js";
import { getAccessibleConversation, getAccessibleOpportunity } from "./core.js";
import { runTestReport } from "../jobs/reports.js";
import { recordEvent } from "../lib/events.js";
import { CATEGORIES, LOSS_REASONS, SERVICE_TYPES, STAGES } from "../../shared/domain.js";

export async function applyStageChange(s: Scope, oppId: string, to: string, reason: string, evidenceMessageIds: string[], actorType: "user" | "ai" = "user") {
  const o = await getAccessibleOpportunity(s, oppId);
  if (!(STAGES as readonly string[]).includes(to)) throw Object.assign(new Error("잘못된 단계"), { status: 400 });
  if (to === "won") {
    const k = await q1(`SELECT 1 FROM contracts WHERE opportunity_id=$1`, [o.id]);
    if (!k) throw Object.assign(new Error("계약 확정은 계약 기록(근거·날짜)을 먼저 등록해야 합니다."), { status: 400 });
  }
  await tx(async (c) => {
    await q(`UPDATE opportunities SET stage=$2, updated_at=now() WHERE id=$1`, [o.id, to], c);
    await q(
      `INSERT INTO stage_events(org_id, opportunity_id, from_stage, to_stage, actor_type, actor_user_id, reason, evidence_message_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.orgId, o.id, o.stage, to, actorType, s.userId, reason, evidenceMessageIds],
      c,
    );
  });
  await audit({ orgId: s.orgId, actorUserId: s.userId, action: "opportunity.stage", targetType: "opportunity", targetId: o.id, detail: { from: o.stage, to, reason, via: actorType } });
  if (to === "lost" && o.data_origin !== "sample")
    await recordEvent(s.orgId, { kind: "cancelled", title: `문의 종료/이탈 처리: ${o.title ?? "문의 건"}`, dedupeKey: `lost:${o.id}:${Date.now()}`, entityType: "opportunity", entityId: o.id, link: `/pipeline/${o.id}`, isTest: o.data_origin === "test" });
  else if (o.data_origin !== "sample")
    await recordEvent(s.orgId, { kind: "status_change", title: `단계 변경: ${o.title ?? "문의 건"} → ${to}`, dedupeKey: `stage:${o.id}:${to}:${Date.now()}`, entityType: "opportunity", entityId: o.id, link: `/pipeline/${o.id}`, isTest: o.data_origin === "test" });
}

export async function salesRoutes(app: FastifyInstance) {
  app.get("/api/opportunities", async (req) => {
    const s = scopeOf(req);
    const qs = z.object({ stage: z.string().optional(), category: z.string().optional(), service: z.string().optional() }).parse(req.query);
    const params: unknown[] = [];
    const acc = opportunityAccessSql(s, "o", params);
    const where = [acc, "o.merged_into_id IS NULL"];
    if (qs.stage) {
      params.push(qs.stage);
      where.push(`o.stage=$${params.length}`);
    }
    if (qs.category) {
      params.push(qs.category);
      where.push(`o.category=$${params.length}`);
    }
    if (qs.service) {
      params.push(qs.service);
      where.push(`$${params.length} = ANY(o.services)`);
    }
    const fin = can(s, "view_finance");
    return q(
      `SELECT o.id, o.title, o.services, o.category, o.stage, o.region, o.space_type, o.opened_at, o.last_contact_at, o.next_action, o.next_action_due,
              o.is_sample, o.duplicate_of_candidate, o.owner_user_id, u.name AS owner_name, ct.display_name,
              ${fin ? "(SELECT amount FROM quotes WHERE opportunity_id=o.id ORDER BY sent_at DESC LIMIT 1)" : "NULL"} AS last_quote_amount,
              (SELECT max(sent_at) FROM quotes WHERE opportunity_id=o.id) AS last_quote_at,
              (SELECT count(*) FROM opportunity_conversations oc WHERE oc.opportunity_id=o.id) AS conversation_count
       FROM opportunities o JOIN contacts ct ON ct.id=o.contact_id LEFT JOIN users u ON u.id=o.owner_user_id
       WHERE ${where.join(" AND ")} ORDER BY COALESCE(o.last_contact_at, o.opened_at) DESC LIMIT 300`,
      params,
    );
  });

  app.get("/api/opportunities/:id", async (req) => {
    const s = scopeOf(req);
    const o = await getAccessibleOpportunity(s, (req.params as any).id);
    const fin = can(s, "view_finance");
    const [contact, convs, events, losses, quotes, contracts, suggestions, merges, others] = await Promise.all([
      q1(`SELECT id, display_name, provider, is_sample FROM contacts WHERE id=$1`, [o.contact_id]),
      q(
        `SELECT c.id, c.status, c.opened_at, c.last_message_at, c.ai_summary, oc.link_reason FROM opportunity_conversations oc JOIN conversations c ON c.id=oc.conversation_id
         WHERE oc.opportunity_id=$1 ORDER BY c.opened_at`,
        [o.id],
      ),
      q(`SELECT se.*, u.name AS actor_name FROM stage_events se LEFT JOIN users u ON u.id=se.actor_user_id WHERE opportunity_id=$1 ORDER BY occurred_at`, [o.id]),
      q(`SELECT la.*, u.name AS confirmed_by_name FROM loss_assessments la LEFT JOIN users u ON u.id=la.confirmed_by_user_id WHERE opportunity_id=$1 ORDER BY analyzed_at DESC`, [o.id]),
      q(`SELECT id, ${fin ? "amount" : "NULL::numeric AS amount"}, currency, sent_at, note FROM quotes WHERE opportunity_id=$1 ORDER BY sent_at`, [o.id]),
      fin
        ? q(
            `SELECT k.*, (SELECT COALESCE(json_agg(p ORDER BY p.paid_at), '[]') FROM payments p WHERE p.contract_id=k.id) AS payments,
                    (SELECT COALESCE(json_agg(c ORDER BY c.incurred_at), '[]') FROM costs c WHERE c.contract_id=k.id) AS costs
             FROM contracts k WHERE opportunity_id=$1 ORDER BY signed_at`,
            [o.id],
          )
        : q(`SELECT id, signed_at, channel, evidence FROM contracts WHERE opportunity_id=$1`, [o.id]),
      q(`SELECT id, payload, created_at FROM approvals WHERE opportunity_id=$1 AND kind='stage_change' AND status='draft' ORDER BY created_at DESC`, [o.id]),
      q(`SELECT * FROM opportunity_merges WHERE $1 = ANY(source_ids) OR target_id=$1 ORDER BY created_at DESC`, [o.id]),
      q(`SELECT id, stage, services, opened_at FROM opportunities WHERE contact_id=$1 AND id<>$2 AND merged_into_id IS NULL ORDER BY opened_at DESC`, [o.contact_id, o.id]),
    ]);
    return { opportunity: o, contact, conversations: convs, stageEvents: events, lossAssessments: losses, quotes, contracts, stageSuggestions: suggestions, mergeHistory: merges, otherOpportunitiesOfContact: others, financeVisible: fin };
  });

  app.patch("/api/opportunities/:id", async (req) => {
    const s = scopeOf(req);
    const o = await getAccessibleOpportunity(s, (req.params as any).id);
    const body = z
      .object({
        title: z.string().max(200).nullable().optional(),
        services: z.array(z.enum(SERVICE_TYPES)).optional(),
        category: z.enum(CATEGORIES).optional(),
        space_type: z.string().max(100).nullable().optional(),
        region: z.string().max(100).nullable().optional(),
        size_text: z.string().max(100).nullable().optional(),
        room_count: z.number().int().min(0).max(10000).nullable().optional(),
        desired_work: z.string().max(500).nullable().optional(),
        desired_schedule: z.string().max(200).nullable().optional(),
        stated_budget: z.string().max(200).nullable().optional(),
        quote_requested: z.boolean().nullable().optional(),
        source_channel: z.string().max(100).nullable().optional(),
        source_evidence: z.string().max(500).nullable().optional(),
        next_action: z.string().max(300).nullable().optional(),
        next_action_due: z.string().datetime({ offset: true }).nullable().optional(),
        owner_user_id: z.string().uuid().nullable().optional(),
        version: z.number().int().optional(),
      })
      .parse(req.body);
    if (body.version !== undefined && body.version !== o.version) throw Object.assign(new Error("다른 기기에서 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 시도하세요."), { status: 409 });
    delete (body as any).version;
    if (body.source_channel && !body.source_evidence && !o.source_evidence) throw Object.assign(new Error("유입경로는 근거(고객 답변·캠페인 식별정보)와 함께 입력해야 합니다."), { status: 400 });
    if (body.owner_user_id !== undefined && body.owner_user_id !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError();
    const keys = Object.keys(body) as Array<keyof typeof body>;
    if (!keys.length) return { ok: true };
    const fe = { ...(o.field_evidence ?? {}) };
    const sets: string[] = [];
    const vals: unknown[] = [o.id];
    for (const k of keys) {
      vals.push(body[k] as unknown);
      sets.push(`${k}=$${vals.length}`);
      fe[k] = { by: "user", user_id: s.userId, at: new Date().toISOString() };
    }
    vals.push(JSON.stringify(fe));
    sets.push(`field_evidence=$${vals.length}`);
    await q(`UPDATE opportunities SET ${sets.join(", ")}, version=version+1, updated_at=now() WHERE id=$1`, vals);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "opportunity.update", targetType: "opportunity", targetId: o.id, detail: { fields: keys } });
    return { ok: true };
  });

  app.post("/api/opportunities/:id/stage", async (req) => {
    const s = scopeOf(req);
    const body = z.object({ to: z.enum(STAGES), reason: z.string().max(500).default(""), evidence_message_ids: z.array(z.string().uuid()).default([]) }).parse(req.body);
    await applyStageChange(s, (req.params as any).id, body.to, body.reason, body.evidence_message_ids);
    return { ok: true };
  });

  // 단계 변경 되돌리기 (변경 이력 보존)
  app.post("/api/stage-events/:id/revert", async (req) => {
    const s = scopeOf(req);
    const ev = await q1<any>(`SELECT * FROM stage_events WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!ev || !ev.from_stage) throw new NotFoundError("되돌릴 수 있는 변경이 아닙니다.");
    const o = await getAccessibleOpportunity(s, ev.opportunity_id);
    await tx(async (c) => {
      await q(`UPDATE opportunities SET stage=$2, updated_at=now() WHERE id=$1`, [o.id, ev.from_stage], c);
      await q(
        `INSERT INTO stage_events(org_id, opportunity_id, from_stage, to_stage, actor_type, actor_user_id, reason, reverts_event_id) VALUES ($1,$2,$3,$4,'user',$5,'되돌리기',$6)`,
        [s.orgId, o.id, o.stage, ev.from_stage, s.userId, ev.id],
        c,
      );
    });
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "opportunity.stage_revert", targetType: "opportunity", targetId: o.id, detail: { event: ev.id } });
    return { ok: true };
  });

  // ───── 견적 / 계약 / 입금 / 원가 (금액은 view_finance 필요) ─────
  app.post("/api/opportunities/:id/quotes", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const o = await getAccessibleOpportunity(s, (req.params as any).id);
    const body = z.object({ amount: z.number().int().nonnegative().nullable(), sent_at: z.string().datetime({ offset: true }), note: z.string().max(500).optional() }).parse(req.body);
    const r = await q1(`INSERT INTO quotes(org_id, opportunity_id, amount, sent_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [s.orgId, o.id, body.amount, body.sent_at, body.note ?? null, s.userId]);
    if (["new", "requirements"].includes(o.stage)) await applyStageChange(s, o.id, "quoted", "견적 등록", []);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "quote.create", targetType: "opportunity", targetId: o.id });
    return r;
  });

  app.post("/api/opportunities/:id/contracts", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const o = await getAccessibleOpportunity(s, (req.params as any).id);
    const body = z
      .object({
        amount: z.number().int().nonnegative().nullable(),
        signed_at: z.string().datetime({ offset: true }),
        channel: z.enum(["kakao", "phone", "email", "in_person", "other"]),
        evidence: z.string().min(2).max(1000),
      })
      .parse(req.body);
    const r = await q1(`INSERT INTO contracts(org_id, opportunity_id, amount, signed_at, channel, evidence, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
      s.orgId,
      o.id,
      body.amount,
      body.signed_at,
      body.channel,
      body.evidence,
      s.userId,
    ]);
    await applyStageChange(s, o.id, "won", `계약 기록 등록 (${body.channel})`, []);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "contract.create", targetType: "opportunity", targetId: o.id });
    await recordEvent(s.orgId, {
      kind: "contract_confirmed",
      title: `계약 확정: ${o.title ?? "문의 건"}${body.amount != null ? ` · ${body.amount.toLocaleString("ko-KR")}원` : ""} (담당자 등록 계약 기록)`,
      dedupeKey: `contract:${r.id}`,
      entityType: "opportunity",
      entityId: o.id,
      link: `/pipeline/${o.id}`,
      isTest: o.data_origin === "test",
      feedText: `대표님, 계약이 확정됐습니다. ${o.title ?? "문의 건"}${body.amount != null ? ` · ${body.amount.toLocaleString("ko-KR")}원` : ""} (근거: ${body.evidence.slice(0, 60)})`,
      actions: [{ label: "문의 건 열기", type: "open", link: `/pipeline/${o.id}` }, { label: "작업 일정 만들기", type: "open", link: `/projects/new?opportunity=${o.id}` }],
    });
    return r;
  });

  async function accessibleContract(s: Scope, id: string) {
    const k = await q1<any>(`SELECT * FROM contracts WHERE id=$1 AND org_id=$2`, [id, s.orgId]);
    if (!k) throw new NotFoundError();
    await getAccessibleOpportunity(s, k.opportunity_id);
    return k;
  }

  app.post("/api/contracts/:id/payments", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const k = await accessibleContract(s, (req.params as any).id);
    const body = z.object({ amount: z.number().int().positive(), paid_at: z.string().datetime({ offset: true }), note: z.string().max(300).optional() }).parse(req.body);
    const r = await q1(`INSERT INTO payments(org_id, contract_id, amount, paid_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [s.orgId, k.id, body.amount, body.paid_at, body.note ?? null, s.userId]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "payment.create", targetType: "contract", targetId: k.id });
    await recordEvent(s.orgId, { kind: "payment_confirmed", title: `입금 확인: ${body.amount.toLocaleString("ko-KR")}원 (담당자 확인 기록)`, dedupeKey: `payment:${r.id}`, entityType: "opportunity", entityId: k.opportunity_id, link: `/pipeline/${k.opportunity_id}` });
    return r;
  });

  app.post("/api/contracts/:id/costs", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const k = await accessibleContract(s, (req.params as any).id);
    const body = z
      .object({
        category: z.enum(["direct_material", "direct_outsourcing", "direct_other", "internal_labor", "fixed"]),
        amount: z.number().int().nonnegative(),
        incurred_at: z.string().datetime({ offset: true }),
        note: z.string().max(300).optional(),
      })
      .parse(req.body);
    const r = await q1(`INSERT INTO costs(org_id, contract_id, category, amount, incurred_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
      s.orgId,
      k.id,
      body.category,
      body.amount,
      body.incurred_at,
      body.note ?? null,
      s.userId,
    ]);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "cost.create", targetType: "contract", targetId: k.id });
    return r;
  });

  // ───── 이탈 사유: 근거·확인 주체·분석 시점·대안 해석 필수 ─────
  app.post("/api/opportunities/:id/loss", async (req) => {
    const s = scopeOf(req);
    const o = await getAccessibleOpportunity(s, (req.params as any).id);
    const body = z
      .object({
        reason_code: z.enum(LOSS_REASONS),
        certainty: z.enum(["confirmed", "estimated", "unknown"]),
        confirmed_by_type: z.enum(["customer", "user"]),
        evidence: z.string().max(1000).default(""),
        evidence_message_ids: z.array(z.string().uuid()).default([]),
        alternative_explanations: z.string().max(1000).default(""),
        mark_lost: z.boolean().default(false),
      })
      .parse(req.body);
    if (body.certainty === "confirmed" && !body.evidence.trim() && !body.evidence_message_ids.length)
      throw Object.assign(new Error("'확인' 사유는 고객 발화 또는 담당자 근거가 필요합니다."), { status: 400 });
    if (body.certainty === "confirmed" && body.confirmed_by_type === "customer" && !body.evidence_message_ids.length)
      throw Object.assign(new Error("고객이 밝힌 사유는 근거 메시지를 연결해야 합니다."), { status: 400 });
    if (body.certainty === "unknown" && body.reason_code !== "unknown") throw Object.assign(new Error("'사유 불명'은 사유 코드도 '사유 불명'이어야 합니다."), { status: 400 });
    // 근거 메시지는 이 기회의 상담에 속해야 함
    if (body.evidence_message_ids.length) {
      const ok = await q1<{ n: number }>(
        `SELECT count(*) AS n FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id WHERE oc.opportunity_id=$1 AND m.id = ANY($2::uuid[])`,
        [o.id, body.evidence_message_ids],
      );
      if ((ok?.n ?? 0) !== body.evidence_message_ids.length) throw Object.assign(new Error("근거 메시지가 이 문의 건의 상담에 속하지 않습니다."), { status: 400 });
    }
    await tx(async (c) => {
      await q(`UPDATE loss_assessments SET superseded_at=now() WHERE opportunity_id=$1 AND superseded_at IS NULL`, [o.id], c);
      await q(
        `INSERT INTO loss_assessments(org_id, opportunity_id, reason_code, certainty, evidence, evidence_message_ids, confirmed_by_type, confirmed_by_user_id, alternative_explanations)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.orgId, o.id, body.reason_code, body.certainty, body.evidence, body.evidence_message_ids, body.confirmed_by_type, s.userId, body.alternative_explanations],
        c,
      );
    });
    if (body.mark_lost && o.stage !== "lost") await applyStageChange(s, o.id, "lost", `이탈 기록: ${body.reason_code} (${body.certainty})`, body.evidence_message_ids);
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "loss.assess", targetType: "opportunity", targetId: o.id, detail: { reason: body.reason_code, certainty: body.certainty } });
    return { ok: true };
  });

  // ───── 합치기 / 분리 (이력 보관) ─────
  app.post("/api/opportunities/:id/merge", async (req) => {
    const s = scopeOf(req);
    const src = await getAccessibleOpportunity(s, (req.params as any).id);
    const body = z.object({ target_id: z.string().uuid(), reason: z.string().max(500).default("") }).parse(req.body);
    const target = await getAccessibleOpportunity(s, body.target_id);
    if (src.id === target.id) throw Object.assign(new Error("같은 건입니다."), { status: 400 });
    if (src.merged_into_id || target.merged_into_id) throw Object.assign(new Error("이미 합쳐진 건입니다."), { status: 400 });
    const convIds = await tx(async (c) => {
      const rows = await q<{ conversation_id: string }>(
        `UPDATE opportunity_conversations SET opportunity_id=$2, link_reason='merge', linked_by=$3, linked_at=now() WHERE opportunity_id=$1 RETURNING conversation_id`,
        [src.id, target.id, s.userId],
        c,
      );
      await q(`UPDATE opportunities SET merged_into_id=$2, updated_at=now() WHERE id=$1`, [src.id, target.id], c);
      await q(`UPDATE opportunities SET opened_at=LEAST(opened_at,$2), last_contact_at=GREATEST(last_contact_at,$3), updated_at=now() WHERE id=$1`, [target.id, src.opened_at, src.last_contact_at ?? src.opened_at], c);
      await q(`INSERT INTO opportunity_merges(org_id, action, source_ids, target_id, conversation_ids, reason, actor_user_id) VALUES ($1,'merge',$2,$3,$4,$5,$6)`, [
        s.orgId,
        [src.id],
        target.id,
        rows.map((r) => r.conversation_id),
        body.reason,
        s.userId,
      ], c);
      return rows.map((r) => r.conversation_id);
    });
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "opportunity.merge", targetType: "opportunity", targetId: target.id, detail: { source: src.id } });
    return { ok: true, movedConversations: convIds };
  });

  app.post("/api/opportunities/:id/split", async (req) => {
    const s = scopeOf(req);
    const src = await getAccessibleOpportunity(s, (req.params as any).id);
    const body = z.object({ conversation_ids: z.array(z.string().uuid()).min(1), reason: z.string().max(500).default("") }).parse(req.body);
    for (const cid of body.conversation_ids) await getAccessibleConversation(s, cid);
    const linked = await q<{ conversation_id: string }>(`SELECT conversation_id FROM opportunity_conversations WHERE opportunity_id=$1`, [src.id]);
    const linkedSet = new Set(linked.map((l) => l.conversation_id));
    if (!body.conversation_ids.every((c) => linkedSet.has(c))) throw Object.assign(new Error("이 건에 연결된 상담만 분리할 수 있습니다."), { status: 400 });
    if (body.conversation_ids.length >= linked.length) throw Object.assign(new Error("모든 상담을 분리할 수는 없습니다. 최소 1개는 남겨야 합니다."), { status: 400 });
    const newId = await tx(async (c) => {
      const first = await q1<{ min: string }>(`SELECT min(sent_at) AS min FROM messages WHERE conversation_id = ANY($1::uuid[])`, [body.conversation_ids], c);
      const last = await q1<{ max: string }>(`SELECT max(sent_at) AS max FROM messages WHERE conversation_id = ANY($1::uuid[])`, [body.conversation_ids], c);
      const n = await q1<{ id: string }>(
        `INSERT INTO opportunities(org_id, contact_id, opened_at, last_contact_at, is_sample, category) VALUES ($1,$2,$3,$4,$5,'valid') RETURNING id`,
        [s.orgId, src.contact_id, first?.min ?? new Date(), last?.max ?? new Date(), src.is_sample],
        c,
      );
      await q(`UPDATE opportunity_conversations SET opportunity_id=$1, link_reason='manual', linked_by=$2, linked_at=now() WHERE conversation_id = ANY($3::uuid[])`, [n!.id, s.userId, body.conversation_ids], c);
      await q(`INSERT INTO stage_events(org_id, opportunity_id, to_stage, actor_type, actor_user_id, reason) VALUES ($1,$2,'new','user',$3,'분리로 생성')`, [s.orgId, n!.id, s.userId], c);
      // 원래 건의 시작 시각 재계산
      await q(
        `UPDATE opportunities o SET opened_at = COALESCE((SELECT min(m.sent_at) FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id WHERE oc.opportunity_id=o.id AND m.sender_type='customer'), o.opened_at) WHERE o.id=$1`,
        [src.id],
        c,
      );
      await q(`INSERT INTO opportunity_merges(org_id, action, source_ids, target_id, conversation_ids, reason, actor_user_id) VALUES ($1,'split',$2,$3,$4,$5,$6)`, [
        s.orgId,
        [src.id],
        n!.id,
        body.conversation_ids,
        body.reason,
        s.userId,
      ], c);
      return n!.id;
    });
    await audit({ orgId: s.orgId, actorUserId: s.userId, action: "opportunity.split", targetType: "opportunity", targetId: src.id, detail: { newId } });
    return { ok: true, newOpportunityId: newId };
  });

  // ───── 분석실 ─────
  app.get("/api/analytics", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_analytics");
    const qs = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    return analyticsOverview(s, resolvePeriod(qs.from, qs.to, 30));
  });

  app.get("/api/finance", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_finance");
    const qs = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    return financeOverview(s, resolvePeriod(qs.from, qs.to, 30));
  });

  // ───── 보고서 ─────
  function reportVisible(s: Scope, required: string[]) {
    return required.every((p) => can(s, p as any));
  }
  app.get("/api/reports", async (req) => {
    const s = scopeOf(req);
    const rows = await q<any>(`SELECT id, role_key, kind, title, period_start, period_end, target_count, data_synced_at, status, required_perms, created_at, is_test, cutoff_at, period_key FROM reports WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`, [s.orgId]);
    return rows.filter((r) => reportVisible(s, r.required_perms));
  });
  app.get("/api/reports/:id", async (req) => {
    const s = scopeOf(req);
    const r = await q1<any>(`SELECT * FROM reports WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!r || !reportVisible(s, r.required_perms)) throw new NotFoundError();
    const run = r.analysis_run_id ? await q1(`SELECT model, prompt_version, engine, created_at, knowledge_version_ids FROM analysis_runs WHERE id=$1`, [r.analysis_run_id]) : null;
    return { ...r, run };
  });
  // 테스트 실행: 실제 예약 시각을 기다리지 않고 같은 생성 경로로 만들되 운영 보고와 분리(is_test)
  app.post("/api/reports/test-run", async (req) => {
    const s = scopeOf(req);
    requirePerm(s, "view_analytics");
    requirePerm(s, "view_finance");
    const body = z.object({ kind: z.enum(["daily", "weekly"]) }).parse(req.body);
    const id = await runTestReport(s.orgId, body.kind, s.userId);
    return { id };
  });
  app.post("/api/reports/:id/reviewed", async (req) => {
    const s = scopeOf(req);
    const r = await q1<any>(`SELECT id, required_perms FROM reports WHERE id=$1 AND org_id=$2`, [(req.params as any).id, s.orgId]);
    if (!r || !reportVisible(s, r.required_perms)) throw new NotFoundError();
    await q(`UPDATE reports SET status='reviewed' WHERE id=$1`, [r.id]);
    return { ok: true };
  });
}
