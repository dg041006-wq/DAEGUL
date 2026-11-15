// 집계는 검증 가능한 DB 쿼리로만 계산한다. AI는 분류/요약/해석만 담당한다.
// 정의 (요구사항 6절):
//  - 문의 건수 = 유효(valid) 영업 기회 수. 메시지 수가 아니다. 합쳐진(merged) 기회는 제외.
//  - 첫 응답 시간 = 기회의 첫 고객 메시지 → 그 이후 첫 '실제 직원(staff)' 메시지. bot/AI 초안 제외.
//  - 계약 전환율 = 기간 내 유입된 유효 문의 집단 중 집계 시점까지 계약 확정(won) 수 / 집단 크기.
import { q, q1 } from "../db/pool.js";
import { can, conversationAccessSql, opportunityAccessSql, type Scope } from "../auth/scope.js";
import { businessMinutesBetween, resolvePeriod } from "../lib/time.js";
import { getOrgSettings } from "../lib/org.js";

export type Period = ReturnType<typeof resolvePeriod>;

export async function dataStatus(scope: Scope) {
  const integrations = await q(
    `SELECT provider, status, coverage_start, last_event_at, last_sync_at, last_error, last_error_at FROM integrations WHERE org_id=$1 ORDER BY provider`,
    [scope.orgId],
  );
  const counts = await q1<{ sample: number; real: number; imported: number; first_at: string | null }>(
    `SELECT count(*) FILTER (WHERE m.is_sample) AS sample,
            count(*) FILTER (WHERE NOT m.is_sample AND c.import_id IS NULL) AS real,
            count(*) FILTER (WHERE c.import_id IS NOT NULL) AS imported,
            min(m.sent_at) AS first_at
     FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.org_id=$1`,
    [scope.orgId],
  );
  const failed = await q1<{ n: number }>(`SELECT count(*) AS n FROM webhook_events WHERE org_id=$1 AND status='failed'`, [scope.orgId]);
  const imports = await q(`SELECT source_label, period_start, period_end, message_count, created_at FROM data_imports WHERE org_id=$1 ORDER BY created_at DESC`, [scope.orgId]);
  const verified = integrations.some((i: any) => i.status === "verified");
  return {
    integrations,
    messageCounts: counts,
    failedEvents: failed?.n ?? 0,
    imports,
    kakaoVerified: verified,
    usingSampleData: (counts?.sample ?? 0) > 0,
    lastSyncAt: integrations.reduce<string | null>((acc, i: any) => (i.last_sync_at && (!acc || i.last_sync_at > acc) ? i.last_sync_at : acc), null),
  };
}

/** 사람 답변 대기: 마지막 고객 메시지 이후 실제 직원 답변이 없는 열린 상담 */
export async function awaitingHuman(scope: Scope, limit = 50) {
  const params: unknown[] = [];
  const acc = conversationAccessSql(scope, "c", params);
  params.push(limit);
  const rows = await q(
    `SELECT c.id, c.last_customer_message_at, c.last_staff_message_at, c.assignee_user_id, c.is_sample, c.ai_summary,
            ct.display_name, u.name AS assignee_name, oc.opportunity_id,
            (SELECT body FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='customer' ORDER BY sent_at DESC LIMIT 1) AS last_customer_body
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     LEFT JOIN users u ON u.id = c.assignee_user_id
     LEFT JOIN opportunity_conversations oc ON oc.conversation_id = c.id
     LEFT JOIN opportunities o ON o.id = oc.opportunity_id
     WHERE ${acc} AND c.status='open' AND c.last_customer_message_at IS NOT NULL
       AND (c.last_staff_message_at IS NULL OR c.last_staff_message_at < c.last_customer_message_at)
       AND COALESCE(o.category,'valid') NOT IN ('spam','test')
     ORDER BY c.last_customer_message_at ASC LIMIT $${params.length}`,
    params,
  );
  const settings = await getOrgSettings(scope.orgId);
  const now = new Date();
  return rows.map((r: any) => ({
    ...r,
    waiting_total_minutes: Math.round((now.getTime() - new Date(r.last_customer_message_at).getTime()) / 60000),
    waiting_business_minutes: businessMinutesBetween(new Date(r.last_customer_message_at), now, settings.businessHours),
  }));
}

/** 견적 후 회신 대기: 최근 견적 이후 고객 메시지가 없는 견적 단계 기회 (이탈로 확정하지 않음) */
export async function quoteAwaitingReply(scope: Scope) {
  const params: unknown[] = [];
  const acc = opportunityAccessSql(scope, "o", params);
  const showAmount = can(scope, "view_finance");
  return q(
    `SELECT o.id, o.title, o.services, ct.display_name, lq.sent_at AS quote_sent_at, ${showAmount ? "lq.amount" : "NULL::numeric AS amount"},
            (SELECT max(m.sent_at) FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id
              WHERE oc.opportunity_id=o.id AND m.sender_type='customer') AS last_customer_at
     FROM opportunities o
     JOIN contacts ct ON ct.id=o.contact_id
     JOIN LATERAL (SELECT sent_at, amount FROM quotes WHERE opportunity_id=o.id ORDER BY sent_at DESC LIMIT 1) lq ON true
     WHERE ${acc} AND o.merged_into_id IS NULL AND o.stage IN ('quoted','negotiating')
       AND NOT EXISTS (SELECT 1 FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id
                       WHERE oc.opportunity_id=o.id AND m.sender_type='customer' AND m.sent_at > lq.sent_at)
     ORDER BY lq.sent_at ASC`,
    params,
  );
}

export async function homeSummary(scope: Scope, period: Period) {
  const params: unknown[] = [];
  const acc = opportunityAccessSql(scope, "o", params);
  params.push(period.start, period.end);
  const p = params.length;
  const today = await q1<{ new_valid: number; other: number }>(
    `SELECT count(*) FILTER (WHERE category='valid') AS new_valid, count(*) FILTER (WHERE category<>'valid') AS other
     FROM opportunities o WHERE ${acc} AND o.merged_into_id IS NULL AND o.opened_at >= $${p - 1} AND o.opened_at < $${p}`,
    params,
  );
  const params2: unknown[] = [];
  const acc2 = opportunityAccessSql(scope, "o", params2);
  params2.push(period.start, period.end);
  const won = await q1<{ n: number }>(
    `SELECT count(DISTINCT o.id) AS n FROM opportunities o JOIN contracts k ON k.opportunity_id=o.id
     WHERE ${acc2} AND k.signed_at >= $${params2.length - 1} AND k.signed_at < $${params2.length}`,
    params2,
  );
  const awaiting = await awaitingHuman(scope, 500);
  const quoteWait = await quoteAwaitingReply(scope);
  return {
    newInquiries: today?.new_valid ?? 0,
    excludedInquiries: today?.other ?? 0,
    awaitingHuman: awaiting.length,
    quoteAwaitingReply: quoteWait.length,
    confirmedContracts: won?.n ?? 0,
  };
}

/** 분석실 지표 — view_analytics 권한 필요 (호출자에서 검사) */
export async function analyticsOverview(scope: Scope, period: Period) {
  const settings = await getOrgSettings(scope.orgId);
  const params: unknown[] = [];
  const acc = opportunityAccessSql(scope, "o", params);
  params.push(period.start, period.end);
  const ps = `$${params.length - 1}`;
  const pe = `$${params.length}`;
  const base = `FROM opportunities o WHERE ${acc} AND o.merged_into_id IS NULL AND o.opened_at >= ${ps} AND o.opened_at < ${pe}`;

  const counts = await q1<any>(
    `SELECT count(*) FILTER (WHERE category='valid') AS valid,
            count(*) FILTER (WHERE category='test') AS test,
            count(*) FILTER (WHERE category='spam') AS spam,
            count(*) FILTER (WHERE category='existing_cs') AS existing_cs,
            count(DISTINCT contact_id) FILTER (WHERE category='valid') AS unique_contacts,
            count(*) FILTER (WHERE category='valid' AND (cardinality(services)=0 OR '기타/확인 필요' = ANY(services))) AS unclassified,
            count(*) FILTER (WHERE category='valid' AND source_channel IS NULL) AS source_unknown,
            count(*) FILTER (WHERE category='valid' AND stage='won') AS won,
            count(*) FILTER (WHERE category='valid' AND stage='lost') AS lost,
            count(*) FILTER (WHERE category='valid' AND stage NOT IN ('won','lost')) AS open,
            count(*) FILTER (WHERE is_sample) AS sample
     ${base}`,
    params,
  );

  const byService = await q(
    `SELECT s AS service, count(*) AS n FROM (SELECT unnest(CASE WHEN cardinality(services)=0 THEN ARRAY['미분류'] ELSE services END) AS s ${base} AND category='valid') x
     GROUP BY s ORDER BY n DESC`,
    params,
  );

  // 단계별 도달 (stage_events 기준 — 현재 단계만이 아니라 한 번이라도 도달한 단계)
  const funnel = await q(
    `SELECT st AS stage, count(DISTINCT o.id) AS n
     FROM opportunities o
     JOIN LATERAL (SELECT DISTINCT to_stage AS st FROM stage_events se WHERE se.opportunity_id=o.id AND se.reverts_event_id IS NULL
                   UNION SELECT o.stage) s ON true
     WHERE ${acc} AND o.merged_into_id IS NULL AND o.opened_at >= ${ps} AND o.opened_at < ${pe} AND o.category='valid'
     GROUP BY st`,
    params,
  );

  // 서비스 유형별 전환
  const conversionByService = await q(
    `SELECT s AS service, count(*) AS cohort, count(*) FILTER (WHERE stage='won') AS won
     FROM (SELECT unnest(CASE WHEN cardinality(services)=0 THEN ARRAY['미분류'] ELSE services END) AS s, stage ${base} AND category='valid') x
     GROUP BY s ORDER BY cohort DESC`,
    params,
  );

  // 첫 응답 시간
  const frt = await q<any>(
    `SELECT o.id,
       (SELECT min(m.sent_at) FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id
         WHERE oc.opportunity_id=o.id AND m.sender_type='customer') AS first_customer,
       (SELECT min(m2.sent_at) FROM messages m2 JOIN opportunity_conversations oc2 ON oc2.conversation_id=m2.conversation_id
         WHERE oc2.opportunity_id=o.id AND m2.sender_type='staff'
           AND m2.sent_at >= (SELECT min(m.sent_at) FROM messages m JOIN opportunity_conversations oc ON oc.conversation_id=m.conversation_id
                              WHERE oc.opportunity_id=o.id AND m.sender_type='customer')) AS first_staff
     ${base} AND category='valid'`,
    params,
  );
  const responded = frt.filter((r) => r.first_customer && r.first_staff);
  const totalMins = responded.map((r) => (new Date(r.first_staff).getTime() - new Date(r.first_customer).getTime()) / 60000);
  const bizMins = responded.map((r) => businessMinutesBetween(new Date(r.first_customer), new Date(r.first_staff), settings.businessHours));
  const median = (a: number[]) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const mid = Math.floor(s.length / 2);
    return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
  };

  // 이탈 사유: 최신(대체되지 않은) 평가만
  const loss = await q(
    `SELECT la.certainty, la.reason_code, count(*) AS n
     FROM loss_assessments la JOIN opportunities o ON o.id=la.opportunity_id
     WHERE ${acc} AND la.superseded_at IS NULL AND o.merged_into_id IS NULL AND o.opened_at >= ${ps} AND o.opened_at < ${pe}
     GROUP BY la.certainty, la.reason_code ORDER BY la.certainty, n DESC`,
    params,
  );
  const lostWithoutAssessment = await q1<{ n: number }>(
    `SELECT count(*) AS n ${base} AND category='valid' AND stage='lost'
       AND NOT EXISTS (SELECT 1 FROM loss_assessments la WHERE la.opportunity_id=o.id AND la.superseded_at IS NULL)`,
    params,
  );

  // 후속 연락 누락: 마감 지난 미완료 할 일
  const overdue = await q1<{ n: number }>(
    `SELECT count(*) AS n FROM tasks t WHERE t.org_id=$1 AND t.status='open' AND t.due_at < now()
     ${can(scope, "view_all_conversations") ? "" : "AND t.assignee_user_id=$2"}`,
    can(scope, "view_all_conversations") ? [scope.orgId] : [scope.orgId, scope.userId],
  );

  const now = new Date();
  const observationDays = Math.floor((now.getTime() - period.end.getTime()) / 86400000);
  const valid = counts?.valid ?? 0;

  return {
    period: { from: period.from, to: period.to },
    computedAt: now.toISOString(),
    counts,
    byService,
    funnel,
    conversion: {
      cohort: valid,
      won: counts?.won ?? 0,
      rate: valid ? (counts.won as number) / valid : null,
      stillOpen: counts?.open ?? 0,
      observationDaysAfterPeriod: Math.max(0, observationDays),
      note:
        (counts?.open ?? 0) > 0
          ? `집단 ${valid}건 중 ${counts.open}건이 아직 진행 중입니다. 기간 종료 후 관찰 ${Math.max(0, observationDays)}일 — 전환율은 확정치가 아닙니다.`
          : null,
    },
    conversionByService,
    firstResponse: {
      respondedCount: responded.length,
      noResponseCount: frt.filter((r) => r.first_customer && !r.first_staff).length,
      medianTotalMinutes: median(totalMins),
      medianBusinessMinutes: median(bizMins),
    },
    loss: { rows: loss, lostWithoutAssessment: lostWithoutAssessment?.n ?? 0 },
    overdueFollowups: overdue?.n ?? 0,
    unknownShares: {
      unclassified: counts?.unclassified ?? 0,
      sourceUnknown: counts?.source_unknown ?? 0,
      lossReasonUnknown:
        (lostWithoutAssessment?.n ?? 0) +
        loss.filter((r: any) => r.certainty === "unknown").reduce((a: number, r: any) => a + Number(r.n), 0),
      denominator: valid,
    },
  };
}

/** 재무 — view_finance 필요. 계약금액 / 실제 입금 / 견적 금액을 섞지 않는다. */
export async function financeOverview(scope: Scope, period: Period) {
  const params: unknown[] = [];
  const acc = opportunityAccessSql(scope, "o", params);
  params.push(period.start, period.end);
  const ps = `$${params.length - 1}`;
  const pe = `$${params.length}`;
  const contracts = await q<any>(
    `SELECT k.id, k.amount, k.signed_at, k.channel, o.id AS opportunity_id, o.title, o.services,
       (SELECT COALESCE(sum(amount),0) FROM payments p WHERE p.contract_id=k.id) AS paid,
       (SELECT COALESCE(sum(amount),0) FROM costs c WHERE c.contract_id=k.id AND c.category LIKE 'direct_%') AS direct_cost,
       (SELECT count(*) FROM costs c WHERE c.contract_id=k.id AND c.category LIKE 'direct_%') AS direct_cost_rows,
       (SELECT COALESCE(sum(amount),0) FROM costs c WHERE c.contract_id=k.id AND c.category IN ('internal_labor','fixed')) AS overhead_cost
     FROM contracts k JOIN opportunities o ON o.id=k.opportunity_id
     WHERE ${acc} AND k.signed_at >= ${ps} AND k.signed_at < ${pe} ORDER BY k.signed_at`,
    params,
  );
  const quotes = await q1<any>(
    `SELECT count(*) AS n, COALESCE(sum(qq.amount),0) AS total FROM quotes qq JOIN opportunities o ON o.id=qq.opportunity_id
     WHERE ${acc} AND qq.sent_at >= ${ps} AND qq.sent_at < ${pe}`,
    params,
  );
  const payments = await q1<any>(
    `SELECT COALESCE(sum(p.amount),0) AS total FROM payments p JOIN contracts k ON k.id=p.contract_id JOIN opportunities o ON o.id=k.opportunity_id
     WHERE ${acc} AND p.paid_at >= ${ps} AND p.paid_at < ${pe}`,
    params,
  );
  const rows = contracts.map((k) => {
    const complete = k.amount != null && Number(k.direct_cost_rows) > 0;
    return {
      ...k,
      cost_data_complete: complete,
      // 직접비만 뺀 값 = '공헌이익(직접비 기준)'. 순이익이 아님.
      contribution_after_direct: complete ? k.amount - k.direct_cost : null,
      contribution_margin: complete && k.amount ? (k.amount - k.direct_cost) / k.amount : null,
    };
  });
  const byService: Record<string, { contracts: number; amount: number; contribution: number; incomplete: number }> = {};
  for (const r of rows) {
    const svcs: string[] = r.services?.length ? r.services : ["미분류"];
    for (const s of svcs) {
      byService[s] ??= { contracts: 0, amount: 0, contribution: 0, incomplete: 0 };
      byService[s].contracts++;
      byService[s].amount += r.amount ?? 0;
      if (r.cost_data_complete) byService[s].contribution += r.contribution_after_direct;
      else byService[s].incomplete++;
    }
  }
  return {
    period: { from: period.from, to: period.to },
    contractAmountInPeriod: rows.reduce((a, r) => a + (r.amount ?? 0), 0),
    paymentsReceivedInPeriod: payments?.total ?? 0,
    quotesSentInPeriod: { count: quotes?.n ?? 0, total: quotes?.total ?? 0 },
    contracts: rows,
    byService,
    notes: [
      "계약 금액(계약일 기준), 실제 입금액(입금일 기준), 견적 금액(발송일 기준)은 서로 다른 값이며 합산하지 않습니다.",
      "공헌이익은 계약 금액에서 직접비만 뺀 값입니다. 인건비·고정비가 포함되지 않았으므로 순이익이 아닙니다.",
      "직접비가 입력되지 않은 계약은 이익률을 계산하지 않고 '자료 불완전'으로 표시합니다.",
    ],
  };
}
