// 서버 주기 점검(워커, 1분 간격): 즉시 보고 사건 탐지, 내부 할 일 생성, 다시 알림, 정기 보고, 보관 정리.
// 외부(고객) 발송은 여기서 하지 않는다.
import crypto from "node:crypto";
import { q, q1, tx } from "../db/pool.js";
import { getOrgSettings } from "../lib/org.js";
import { addBusinessDays, addDays, businessMinutesBetween, kstDateString } from "../lib/time.js";
import { awaitingHuman, quoteAwaitingReply } from "../analytics/metrics.js";
import { deliveryRisks, prepMissing } from "../analytics/operations.js";
import type { Scope } from "../auth/scope.js";
import { audit } from "../lib/audit.js";
import { notify, ownerIds, postFeed, recordEvent } from "../lib/events.js";
import { runDueReports } from "./reports.js";

export { notify };

async function ownerScope(orgId: string): Promise<Scope> {
  const owners = await ownerIds(orgId);
  return { orgId, userId: owners[0] ?? "00000000-0000-0000-0000-000000000000", role: "owner", perms: {} };
}

export async function sweepOrg(orgId: string, now = new Date()) {
  const settings = await getOrgSettings(orgId);
  const owners = await ownerIds(orgId);
  const scope = await ownerScope(orgId);
  const today = kstDateString(now);

  // 1) 사람 답변 대기: 상담별 할 일 + 묶음 보고(같은 대상 묶음은 설정 간격 내 1회)
  const awaiting = await awaitingHuman(scope, 500);
  const overdueAwaiting = awaiting.filter((a: any) => a.data_origin !== "test").filter((a) => businessMinutesBetween(new Date(a.last_customer_message_at), now, settings.businessHours) >= settings.replyAlertMinutes);
  for (const a of overdueAwaiting) {
    const key = `reply:${a.id}:${new Date(a.last_customer_message_at).toISOString()}`;
    await q(
      `INSERT INTO tasks(org_id, title, assignee_user_id, due_at, source, source_reason, conversation_id, opportunity_id, dedupe_key)
       VALUES ($1,$2,$3,now(),'system',$4,$5,$6,$7) ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [orgId, `답변 필요: ${a.display_name ?? "고객"} 상담`, a.assignee_user_id ?? owners[0] ?? null, `영업시간 기준 ${settings.replyAlertMinutes}분 이상 직원 답변 없음`, a.id, a.opportunity_id ?? null, key],
    );
  }
  if (overdueAwaiting.length) {
    const bucket = Math.floor(now.getTime() / (Math.max(1, settings.awaitingAlertRepeatHours) * 3600_000));
    const sig = crypto.createHash("sha1").update(overdueAwaiting.map((a) => a.id).sort().join(",")).digest("hex").slice(0, 12);
    const first = overdueAwaiting[0];
    await recordEvent(orgId, {
      kind: "awaiting_reply",
      title: `답변을 기다리는 문의 ${overdueAwaiting.length}건`,
      dedupeKey: `awaiting:${bucket}:${sig}`,
      link: "/inbox?filter=awaiting",
      feedText: `대표님, 답변을 기다리는 문의가 ${overdueAwaiting.length}건 있습니다. 가장 오래된 건은 ${first.display_name ?? "이름 미제공 고객"}님입니다.`,
      actions: [
        { label: "답변 대기 목록", type: "open", link: "/inbox?filter=awaiting" },
        { label: "가장 오래된 상담", type: "open", link: `/inbox/${first.id}` },
        { label: "답장 초안 보기", type: "draft_reply", conversation_id: first.id },
        { label: "내가 담당", type: "assign_self", conversation_id: first.id },
        { label: "내일 다시 알림", type: "snooze", days: 1 },
      ],
    });
  }

  // 2) 견적 후 회신 대기 → 후속 확인 할 일 (이탈 확정 아님)
  for (const w of (await quoteAwaitingReply(scope)) as any[]) {
    const dueAt = addBusinessDays(new Date(w.quote_sent_at), settings.quoteFollowupBusinessDays, settings.businessHours);
    if (dueAt > now) continue;
    const key = `quote-followup:${w.id}:${new Date(w.quote_sent_at).toISOString()}`;
    const owner = await q1<{ owner_user_id: string | null }>(`SELECT owner_user_id FROM opportunities WHERE id=$1`, [w.id]);
    await q(
      `INSERT INTO tasks(org_id, title, assignee_user_id, due_at, source, source_reason, opportunity_id, dedupe_key)
       VALUES ($1,$2,$3,now(),'system',$4,$5,$6) ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [orgId, `견적 후 회신 확인: ${w.display_name ?? "고객"}`, owner?.owner_user_id ?? owners[0] ?? null, `견적 발송 후 ${settings.quoteFollowupBusinessDays}영업일 동안 고객 회신 없음 — '견적 후 회신 대기' 상태이며 이탈로 확정하지 않음`, w.id, key],
    );
  }

  // 3) 납기 위험
  for (const r of (await deliveryRisks(scope, today)) as any[]) {
    await recordEvent(orgId, {
      kind: "delivery_risk",
      title: `납기 위험: ${r.title} (납기 ${String(r.delivery_due).slice(0, 10)})`,
      dedupeKey: `delivery:${r.id}:${String(r.delivery_due).slice(0, 10)}`,
      entityType: "project",
      entityId: r.id,
      link: `/projects/${r.id}`,
      feedText: `대표님, 납기가 임박했거나 지난 작업이 있습니다: ${r.title}`,
      actions: [
        { label: "작업 열기", type: "open", link: `/projects/${r.id}` },
        { label: "할 일로 등록", type: "create_task", title: `납품 확인: ${r.title}`, project_id: r.id, due: "today" },
      ],
    });
  }

  // 4) 내일 작업 준비 누락 (주소·시간·연락처)
  const tomorrow = addDays(today, 1);
  for (const p of await prepMissing(scope, tomorrow)) {
    await recordEvent(orgId, {
      kind: "prep_missing",
      title: `내일 작업 준비 누락: ${p.title} (${p.missing.join("·")} 미확인)`,
      dedupeKey: `prep:${tomorrow}:${p.id}:${p.missing.join(",")}`,
      entityType: "project",
      entityId: p.id,
      link: `/projects/${p.id}`,
      feedText: `대표님, 내일 작업 중 ${p.missing.join("·")} 확인이 안 된 건이 있습니다: ${p.display_name ?? p.title}`,
      actions: [
        { label: "작업 열기", type: "open", link: `/projects/${p.id}` },
        { label: "확인 할 일 등록", type: "create_task", title: `${p.missing.join("·")} 확인: ${p.title}`, project_id: p.id, due: "today" },
      ],
    });
  }

  // 5) '다시 알림' 도래 할 일
  const reminders = await q<any>(`SELECT id, title, assignee_user_id, remind_at FROM tasks WHERE org_id=$1 AND status='open' AND remind_at IS NOT NULL AND remind_at <= $2`, [orgId, now]);
  for (const t of reminders) {
    await postFeed(orgId, "ops", {
      content: `대표님, 다시 알려드립니다: ${t.title}`,
      kind: "alert",
      actions: [
        { label: "할 일 보기", type: "open", link: "/tasks" },
        { label: "처리 완료", type: "resolve" },
        { label: "내일 다시 알림", type: "snooze", days: 1 },
      ],
      meta: { task_id: t.id },
    });
    await q(`UPDATE tasks SET remind_at=NULL, version=version+1, updated_at=now() WHERE id=$1`, [t.id]);
  }

  // 6) 중요 작업 실패: 처리 실패한 수신 이벤트, 재시도 한도 초과 작업
  const failed = await q1<{ n: number }>(`SELECT count(*) AS n FROM webhook_events WHERE org_id=$1 AND status='failed'`, [orgId]);
  if ((failed?.n ?? 0) > 0)
    await recordEvent(orgId, {
      kind: "job_failure",
      title: `처리 실패한 수신 이벤트 ${failed!.n}건`,
      dedupeKey: `wh-failed:${today}:${failed!.n}`,
      link: "/settings?tab=integrations",
      feedText: `대표님, 상담 수신 처리 중 실패한 이벤트가 ${failed!.n}건 있습니다. 원본은 보관되어 있어 재처리할 수 있습니다.`,
    });
  const dead = await q<{ id: number; kind: string }>(`SELECT id, kind FROM jobs WHERE status='dead' AND payload->>'orgId' = $1 AND finished_at > now() - interval '1 day'`, [orgId]);
  for (const d of dead)
    await recordEvent(orgId, { kind: "job_failure", title: `백그라운드 작업 실패: ${d.kind}`, dedupeKey: `job:${d.id}`, link: "/settings?tab=integrations" });

  // 7) AI 한도 알림
  const used = await q1<{ cost: number }>(
    `SELECT COALESCE(sum(cost_usd),0) AS cost FROM analysis_runs WHERE org_id=$1 AND engine='model' AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
    [orgId],
  );
  const ratio = settings.aiMonthlyBudgetUsd > 0 ? Number(used?.cost ?? 0) / settings.aiMonthlyBudgetUsd : 0;
  if (ratio >= 0.8) for (const u of owners) await notify(orgId, u, { kind: "ai_budget", title: ratio >= 1 ? "AI 월 한도 도달 — 분석 대기 상태" : "AI 월 한도 80% 사용", link: "/settings?tab=ai", severity: "important", dedupeKey: `ai-budget:${today.slice(0, 7)}:${ratio >= 1 ? 100 : 80}` });

  // 8) 정기 보고 (놓친 회차 보충 포함, 중복 방지)
  await runDueReports(orgId, now);

  // 9) 작성 잠금 정리
  await q(`DELETE FROM compose_locks WHERE expires_at < now()`);
}

/**
 * 보관 기간 정책. 원문과 파생 데이터(요약·AI 대화·보고서·사건·알림·발송 기록·첨부·가져오기 원문)를 함께 정리한다.
 * 작업·계약·입금·원가 등 회계 기록은 금액·날짜를 남기되 고객 식별 정보는 삭제 대상 고객일 때만 비식별화한다.
 */
export async function purgeExpired(orgId: string) {
  const s = await getOrgSettings(orgId);
  if (!s.retentionDays) return 0;
  const cutoff = new Date(Date.now() - s.retentionDays * 86400000);
  const n = await tx(async (c) => {
    const rows = await q<{ id: string }>(`DELETE FROM conversations WHERE org_id=$1 AND COALESCE(last_message_at, opened_at) < $2 RETURNING id`, [orgId, cutoff], c);
    await q(`DELETE FROM webhook_events WHERE org_id=$1 AND received_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM ai_messages WHERE created_at < $2 AND thread_id IN (SELECT id FROM ai_threads WHERE org_id=$1)`, [orgId, cutoff], c);
    await q(`DELETE FROM ai_threads WHERE org_id=$1 AND kind='chat' AND updated_at < $2 AND NOT EXISTS (SELECT 1 FROM ai_messages m WHERE m.thread_id=ai_threads.id)`, [orgId, cutoff], c);
    await q(`DELETE FROM reports WHERE org_id=$1 AND created_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM notifications WHERE org_id=$1 AND created_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM events WHERE org_id=$1 AND created_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM outbound_messages WHERE org_id=$1 AND created_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM sheet_imports WHERE org_id=$1 AND created_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM data_imports WHERE org_id=$1 AND created_at < $2`, [orgId, cutoff], c);
    await q(`DELETE FROM analysis_evidence WHERE analysis_run_id IN (SELECT id FROM analysis_runs WHERE org_id=$1 AND created_at < $2)`, [orgId, cutoff], c);
    return rows.length;
  });
  await audit({ orgId, actorType: "system", action: "retention.purge", detail: { conversations: n, cutoff } });
  return n;
}

/** 고객 1명 삭제 요청: 원문·파생 데이터 삭제, 회계 기록은 금액만 남기고 비식별화 */
export async function eraseContact(orgId: string, contactId: string, actorUserId: string) {
  const ct = await q1<{ display_name: string | null; phone: string | null; email: string | null }>(`SELECT display_name, phone, email FROM contacts WHERE id=$1 AND org_id=$2`, [contactId, orgId]);
  if (!ct) throw Object.assign(new Error("고객을 찾을 수 없습니다."), { status: 404 });
  const names = [ct.display_name, ct.phone, ct.email].filter((x): x is string => !!x && x.length >= 2);
  const result = await tx(async (c) => {
    const convs = await q<{ id: string }>(`SELECT id FROM conversations WHERE contact_id=$1`, [contactId], c);
    const convIds = convs.map((x) => x.id);
    const opps = await q<{ id: string }>(`SELECT id FROM opportunities WHERE contact_id=$1`, [contactId], c);
    const oppIds = opps.map((x) => x.id);
    // 이 고객을 근거로 한 AI 답변 삭제
    await q(
      `DELETE FROM ai_messages m USING analysis_evidence e WHERE m.analysis_run_id = e.analysis_run_id AND (e.conversation_id = ANY($1::uuid[]) OR e.opportunity_id = ANY($2::uuid[]))`,
      [convIds, oppIds],
      c,
    );
    await q(`DELETE FROM attachments WHERE contact_id=$1 OR project_id IN (SELECT id FROM projects WHERE contact_id=$1)`, [contactId], c);
    await q(`DELETE FROM tasks WHERE contact_id=$1 OR conversation_id = ANY($2::uuid[]) OR opportunity_id = ANY($3::uuid[])`, [contactId, convIds, oppIds], c);
    // 회계 기록 비식별화 (금액·날짜 유지)
    await q(`UPDATE projects SET title='[삭제된 고객] 작업', address=NULL, notes=NULL, time_raw=NULL, contact_id=NULL WHERE contact_id=$1`, [contactId], c);
    await q(`DELETE FROM conversations WHERE contact_id=$1`, [contactId], c);
    await q(`DELETE FROM opportunities WHERE contact_id=$1`, [contactId], c);
    await q(`DELETE FROM contacts WHERE id=$1`, [contactId], c);
    // 보고서·대화·사건·알림 본문의 이름/연락처 치환
    for (const nm of names) {
      await q(`UPDATE reports SET body=replace(body,$2,'[삭제된 고객]') WHERE org_id=$1 AND body LIKE '%' || $2 || '%'`, [orgId, nm], c);
      await q(`UPDATE ai_messages SET content=replace(content,$2,'[삭제된 고객]'), customer_draft=replace(customer_draft,$2,'[삭제된 고객]') WHERE thread_id IN (SELECT id FROM ai_threads WHERE org_id=$1) AND (content LIKE '%' || $2 || '%' OR customer_draft LIKE '%' || $2 || '%')`, [orgId, nm], c);
      await q(`UPDATE events SET title=replace(title,$2,'[삭제된 고객]') WHERE org_id=$1`, [orgId, nm], c);
      await q(`UPDATE notifications SET title=replace(title,$2,'[삭제된 고객]') WHERE org_id=$1`, [orgId, nm], c);
      await q(`UPDATE sheet_import_rows SET raw='{}'::jsonb, parsed='{}'::jsonb WHERE import_id IN (SELECT id FROM sheet_imports WHERE org_id=$1) AND (raw::text LIKE '%' || $2 || '%')`, [orgId, nm], c);
    }
    return { conversations: convIds.length, opportunities: oppIds.length };
  });
  await audit({ orgId, actorUserId, action: "contact.erase", targetType: "contact", targetId: contactId, detail: result });
  return result;
}
