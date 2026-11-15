// 자동 실행 범위: 응답 지연/후속 연락 대상 표시와 내부 할 일 생성, 정기 보고서, 보관 기간 정리.
// 외부(고객) 발송은 자동화하지 않는다.
import { q, q1 } from "../db/pool.js";
import { getOrgSettings } from "../lib/org.js";
import { addBusinessDays, businessMinutesBetween, kstDateString, resolvePeriod, toKstParts, addDays } from "../lib/time.js";
import { analyticsOverview, awaitingHuman, financeOverview, quoteAwaitingReply, dataStatus } from "../analytics/metrics.js";
import type { Scope } from "../auth/scope.js";
import { checkAvailability, createMessage, finishRun, startRun, SYSTEM_DATA_RULE, textOf } from "../ai/client.js";
import { audit } from "../lib/audit.js";

async function ownerIds(orgId: string) {
  return (await q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE org_id=$1 AND role='owner' AND status='active'`, [orgId])).map((r) => r.user_id);
}

export async function notify(orgId: string, userId: string, kind: string, title: string, link: string | null, dedupeKey?: string) {
  // title에는 상담 원문을 넣지 않는다
  await q(
    `INSERT INTO notifications(org_id, user_id, kind, title, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [orgId, userId, kind, title, link, dedupeKey ?? null],
  );
}

export async function sweepOrg(orgId: string, now = new Date()) {
  const settings = await getOrgSettings(orgId);
  const owners = await ownerIds(orgId);
  const ownerScope: Scope = { orgId, userId: owners[0] ?? "00000000-0000-0000-0000-000000000000", role: "owner", perms: {} };

  // 1) 사람 답변 대기 — 영업시간 기준 경과가 기준 초과 시 할 일 + 알림
  const awaiting = await awaitingHuman(ownerScope, 500);
  for (const a of awaiting) {
    const biz = businessMinutesBetween(new Date(a.last_customer_message_at), now, settings.businessHours);
    if (biz < settings.replyAlertMinutes) continue;
    const key = `reply:${a.id}:${new Date(a.last_customer_message_at).toISOString()}`;
    const t = await q1<{ id: string }>(
      `INSERT INTO tasks(org_id, title, assignee_user_id, due_at, source, source_reason, conversation_id, opportunity_id, dedupe_key)
       VALUES ($1,$2,$3,now(),'system',$4,$5,$6,$7) ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [orgId, `답변 필요: ${a.display_name ?? "고객"} 상담`, a.assignee_user_id ?? owners[0] ?? null, `영업시간 기준 ${biz}분 동안 직원 답변 없음 (기준 ${settings.replyAlertMinutes}분)`, a.id, a.opportunity_id ?? null, key],
    );
    if (t) {
      const targets = a.assignee_user_id ? [a.assignee_user_id] : owners;
      for (const u of targets) await notify(orgId, u, "reply_delay", "답변 대기 상담이 있습니다", `/inbox/${a.id}`, key);
    }
  }

  // 2) 견적 후 회신 대기 — 설정 영업일 경과 시 '후속 연락 확인' 할 일 (이탈 확정 아님)
  const quoteWait = await quoteAwaitingReply(ownerScope);
  for (const w of quoteWait as any[]) {
    const dueAt = addBusinessDays(new Date(w.quote_sent_at), settings.quoteFollowupBusinessDays, settings.businessHours);
    if (dueAt > now) continue;
    const key = `quote-followup:${w.id}:${new Date(w.quote_sent_at).toISOString()}`;
    const owner = await q1<{ owner_user_id: string | null }>(`SELECT owner_user_id FROM opportunities WHERE id=$1`, [w.id]);
    const t = await q1<{ id: string }>(
      `INSERT INTO tasks(org_id, title, assignee_user_id, due_at, source, source_reason, opportunity_id, dedupe_key)
       VALUES ($1,$2,$3,now(),'system',$4,$5,$6) ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [orgId, `견적 후 회신 확인: ${w.display_name ?? "고객"}`, owner?.owner_user_id ?? owners[0] ?? null, `견적 발송 후 ${settings.quoteFollowupBusinessDays}영업일 동안 고객 회신 없음 — '견적 후 회신 대기' 상태이며 이탈로 확정하지 않음`, w.id, key],
    );
    if (t) for (const u of owner?.owner_user_id ? [owner.owner_user_id] : owners) await notify(orgId, u, "quote_followup", "견적 후 회신 대기 건 후속 확인", `/pipeline/${w.id}`, key);
  }

  // 3) 연동 장애 알림
  const failed = await q1<{ n: number }>(`SELECT count(*) AS n FROM webhook_events WHERE org_id=$1 AND status='failed'`, [orgId]);
  if ((failed?.n ?? 0) > 0) {
    for (const u of owners) await notify(orgId, u, "integration_error", `처리 실패한 수신 이벤트 ${failed!.n}건`, "/settings", `wh-failed:${kstDateString(now)}:${failed!.n}`);
  }

  // 4) AI 한도 알림 (80%, 100%)
  const used = await q1<{ cost: number }>(
    `SELECT COALESCE(sum(cost_usd),0) AS cost FROM analysis_runs WHERE org_id=$1 AND engine='model' AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
    [orgId],
  );
  const ratio = settings.aiMonthlyBudgetUsd > 0 ? Number(used?.cost ?? 0) / settings.aiMonthlyBudgetUsd : 0;
  const month = kstDateString(now).slice(0, 7);
  if (ratio >= 0.8) for (const u of owners) await notify(orgId, u, "ai_budget", ratio >= 1 ? "AI 월 한도 도달 — 분석 대기 상태" : "AI 월 한도 80% 사용", "/settings", `ai-budget:${month}:${ratio >= 1 ? 100 : 80}`);

  // 5) 정기 보고서
  const kp = toKstParts(now);
  const hhmm = (s: string) => s.split(":").map(Number).reduce((h, m) => h * 60 + m);
  const today = kstDateString(now);
  if (settings.reports.dailyEnabled && kp.minutes >= hhmm(settings.reports.dailyTime)) {
    await generateScheduledReport(orgId, "daily", today);
  }
  if (settings.reports.weeklyEnabled && kp.dow === settings.reports.weeklyDay && kp.minutes >= hhmm(settings.reports.weeklyTime)) {
    await generateScheduledReport(orgId, "weekly", today);
  }

  // 6) 작성 잠금 정리
  await q(`DELETE FROM compose_locks WHERE expires_at < now()`);
}

/** 정기 보고서 — 같은 날 중복 생성 방지. 집계는 DB, 해석은 AI(가능할 때만). */
export async function generateScheduledReport(orgId: string, kind: "daily" | "weekly", todayKst: string) {
  const exists = await q1(`SELECT 1 FROM reports WHERE org_id=$1 AND kind=$2 AND created_at >= $3`, [orgId, kind, resolvePeriod(todayKst, todayKst).start]);
  if (exists) return null;
  const to = addDays(todayKst, -1);
  const from = kind === "daily" ? to : addDays(to, -6);
  return generateReport(orgId, kind, from, to, null);
}

export async function generateReport(orgId: string, kind: "daily" | "weekly" | "adhoc", from: string, to: string, createdBy: string | null) {
  const owners = await ownerIds(orgId);
  const scope: Scope = { orgId, userId: createdBy ?? owners[0], role: "owner", perms: {} };
  const period = resolvePeriod(from, to);
  const ana = await analyticsOverview(scope, period);
  const fin = await financeOverview(scope, period);
  const ds = await dataStatus(scope);
  const awaiting = await awaitingHuman(scope, 100);
  const quoteWait = await quoteAwaitingReply(scope);
  const metrics = {
    counts: ana.counts,
    byService: ana.byService,
    conversion: ana.conversion,
    firstResponse: ana.firstResponse,
    loss: ana.loss,
    unknownShares: ana.unknownShares,
    awaitingHuman: awaiting.length,
    quoteAwaitingReply: quoteWait.length,
    finance: { contractAmount: fin.contractAmountInPeriod, payments: fin.paymentsReceivedInPeriod, quotes: fin.quotesSentInPeriod },
    sampleData: ds.usingSampleData,
    kakaoVerified: ds.kakaoVerified,
  };
  const label = kind === "daily" ? "일간" : kind === "weekly" ? "주간" : "수시";
  const lines = [
    `${label} 보고 (${from} ~ ${to})`,
    ds.usingSampleData ? "※ 샘플 데이터 / 카카오 미연동 — 실제 문의 분석 결과가 아닙니다." : "",
    `유효 문의 ${ana.counts.valid}건 (고객 ${ana.counts.unique_contacts}명) · 별도 집계: 테스트 ${ana.counts.test} / 스팸 ${ana.counts.spam} / 기존 CS ${ana.counts.existing_cs}`,
    `첫 응답 중앙값: 전체 ${ana.firstResponse.medianTotalMinutes ?? "-"}분 / 영업시간 ${ana.firstResponse.medianBusinessMinutes ?? "-"}분 (응답 ${ana.firstResponse.respondedCount}건, 미응답 ${ana.firstResponse.noResponseCount}건)`,
    `현재 사람 답변 대기 ${awaiting.length}건 · 견적 후 회신 대기 ${quoteWait.length}건`,
    ana.conversion.note ?? "",
    `미분류 ${ana.unknownShares.unclassified} · 유입경로 미확인 ${ana.unknownShares.sourceUnknown} · 이탈 사유 불명 ${ana.unknownShares.lossReasonUnknown} (분모 ${ana.unknownShares.denominator})`,
  ].filter(Boolean);

  let body = lines.join("\n");
  let runId: string | null = null;
  const avail = await checkAvailability(orgId);
  if (avail.ok) {
    runId = await startRun({ orgId, kind: "report", roleKey: "strategy", engine: "model", promptVersion: "report-v1", scope: { from, to, valid: ana.counts.valid } });
    try {
      const res = await createMessage({
        system: `스테이신 내부 보고서의 해석 문단을 작성합니다. 주어진 DB 집계값만 사용하고 새 수치를 만들지 않습니다. 확인되지 않은 원인을 단정하지 않습니다. 5문장 이내 한국어.\n${SYSTEM_DATA_RULE}`,
        messages: [{ role: "user", content: `집계값(JSON): ${JSON.stringify(metrics)}` }],
        effort: "low",
        maxTokens: 2000,
      });
      if (res.stop_reason !== "refusal") body += `\n\nAI 해석:\n${textOf(res)}`;
      await finishRun(runId, { status: "done", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens });
    } catch (e: any) {
      await finishRun(runId, { status: "failed", error: String(e?.message ?? e).slice(0, 200) });
      body += "\n\nAI 해석: 생성 실패 — 집계값만 표시합니다.";
    }
  } else {
    body += `\n\nAI 해석: 대기 (${avail.message})`;
  }
  const nextActions = [
    ...(awaiting.length ? [{ title: `답변 대기 상담 ${awaiting.length}건 처리` }] : []),
    ...(quoteWait.length ? [{ title: `견적 후 회신 대기 ${quoteWait.length}건 후속 여부 결정` }] : []),
    ...(ana.unknownShares.unclassified ? [{ title: `미분류 문의 ${ana.unknownShares.unclassified}건 분류` }] : []),
  ];
  const r = await q1<{ id: string }>(
    `INSERT INTO reports(org_id, role_key, kind, title, period_start, period_end, target_count, data_synced_at, body, metrics, next_actions, required_perms, analysis_run_id, created_by)
     VALUES ($1,'strategy',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [orgId, kind, `${label} 보고 ${from}${from !== to ? ` ~ ${to}` : ""}`, period.start, period.end, ana.counts.valid, ds.lastSyncAt, body, metrics, JSON.stringify(nextActions), ["view_analytics", "view_finance"], runId, createdBy],
  );
  for (const u of owners) await notify(orgId, u, "report", `${label} 보고가 도착했습니다`, `/reports/${r!.id}`, `report:${r!.id}`);
  await audit({ orgId, actorType: createdBy ? "user" : "system", actorUserId: createdBy, action: "report.create", targetType: "report", targetId: r!.id });
  return r!.id;
}

/** 보관 기간 정책: 원문·요약·근거·첨부 메타데이터를 함께 삭제 */
export async function purgeExpired(orgId: string) {
  const s = await getOrgSettings(orgId);
  if (!s.retentionDays) return 0;
  const cutoff = new Date(Date.now() - s.retentionDays * 86400000);
  // 마지막 활동이 보관 기간을 넘긴 상담 단위로 삭제 (messages, notes, evidence, locks는 CASCADE)
  const rows = await q<{ id: string }>(`DELETE FROM conversations WHERE org_id=$1 AND COALESCE(last_message_at, opened_at) < $2 RETURNING id`, [orgId, cutoff]);
  await q(`DELETE FROM webhook_events WHERE org_id=$1 AND received_at < $2`, [orgId, cutoff]);
  if (rows.length) await audit({ orgId, actorType: "system", action: "retention.purge", detail: { conversations: rows.length, cutoff } });
  return rows.length;
}
