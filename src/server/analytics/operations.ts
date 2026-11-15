// 운영 관점 집계: 일정, 납기, 촬영 준비, 미수금, 오늘 보드. 모두 DB 쿼리.
import { q } from "../db/pool.js";
import { can, projectAccessSql, type Scope } from "../auth/scope.js";
import { addDays, kstDateString } from "../lib/time.js";

/** 작업의 확정 금액: 작업에 직접 확정한 금액 → 없으면 연결된 계약 금액. 시트 단가(listed_price)는 확정 금액이 아니다. */
const AMOUNT_SQL = `COALESCE(p.agreed_amount, (SELECT k.amount FROM contracts k WHERE k.opportunity_id = p.opportunity_id AND p.opportunity_id IS NOT NULL ORDER BY k.signed_at DESC LIMIT 1))`;
const PAID_SQL = `(SELECT COALESCE(sum(pm.amount),0) FROM payments pm WHERE pm.project_id = p.id AND pm.status='confirmed')`;
const CLAIMED_SQL = `(SELECT count(*) FROM payments pm WHERE pm.project_id = p.id AND pm.status='claimed')`;

export async function schedule(s: Scope, from: string, to: string) {
  const params: unknown[] = [];
  const acc = projectAccessSql(s, "p", params);
  params.push(from, to);
  const fin = can(s, "view_finance");
  const projects = await q(
    `SELECT p.id, p.title, p.work_type, p.package, p.scheduled_date, p.start_time, p.time_raw, p.address, p.status, p.flags, p.data_origin,
            p.delivery_due, p.contact_id, ct.display_name, ct.phone IS NOT NULL AS has_phone, u.name AS assignee_name,
            ${fin ? "p.listed_price, " + AMOUNT_SQL + " AS amount" : "NULL::numeric AS listed_price, NULL::numeric AS amount"}
     FROM projects p LEFT JOIN contacts ct ON ct.id=p.contact_id LEFT JOIN users u ON u.id=p.assignee_user_id
     WHERE ${acc} AND p.scheduled_date BETWEEN $${params.length - 1}::date AND $${params.length}::date
     ORDER BY p.scheduled_date, p.start_time NULLS LAST`,
    params,
  );
  const blocks = await q(
    `SELECT id, date, person_label, label, kind, data_origin FROM schedule_blocks WHERE org_id=$1 AND date BETWEEN $2::date AND $3::date ${s.role === "owner" ? "" : "AND kind='business'"} ORDER BY date`,
    [s.orgId, from, to],
  );
  return { projects, blocks };
}

/** 미수금 확인 대상: 확정 금액 대비 확인된 입금이 부족한 작업 + 금액 미확정(시트 단가만 있음) 작업 */
export async function receivables(s: Scope) {
  if (!can(s, "view_finance")) return { due: [], unconfirmedAmount: [], restricted: true };
  const params: unknown[] = [];
  const acc = projectAccessSql(s, "p", params);
  const rows = await q<any>(
    `SELECT p.id, p.title, p.scheduled_date, p.status, p.listed_price, ${AMOUNT_SQL} AS amount, ${PAID_SQL} AS paid, ${CLAIMED_SQL} AS claimed,
            ct.display_name, p.data_origin
     FROM projects p LEFT JOIN contacts ct ON ct.id=p.contact_id
     WHERE ${acc} AND p.status NOT IN ('cancelled') AND (p.scheduled_date IS NULL OR p.scheduled_date <= (now() AT TIME ZONE 'Asia/Seoul')::date)
     ORDER BY p.scheduled_date NULLS LAST`,
    params,
  );
  const due = rows.filter((r) => r.amount != null && Number(r.amount) > 0 && Number(r.paid) < Number(r.amount)).map((r) => ({ ...r, outstanding: Number(r.amount) - Number(r.paid) }));
  const unconfirmedAmount = rows.filter((r) => r.amount == null && r.listed_price != null && Number(r.listed_price) > 0 && Number(r.paid) === 0);
  return { due, unconfirmedAmount, restricted: false };
}

export async function deliveryRisks(s: Scope, todayStr = kstDateString(new Date())) {
  const params: unknown[] = [];
  const acc = projectAccessSql(s, "p", params);
  params.push(addDays(todayStr, 1));
  return q(
    `SELECT p.id, p.title, p.delivery_due, p.status, ct.display_name FROM projects p LEFT JOIN contacts ct ON ct.id=p.contact_id
     WHERE ${acc} AND p.delivery_due IS NOT NULL AND p.delivery_due <= $${params.length}::date AND p.status NOT IN ('delivered','done','cancelled')
     ORDER BY p.delivery_due`,
    params,
  );
}

/** 내일(또는 지정일) 작업 중 주소·시간·연락처가 비어 있거나 사전 체크리스트 미완료 */
export async function prepMissing(s: Scope, dateStr: string) {
  const params: unknown[] = [];
  const acc = projectAccessSql(s, "p", params);
  params.push(dateStr);
  const rows = await q<any>(
    `SELECT p.id, p.title, p.address, p.start_time, p.time_raw, p.checklist, ct.display_name, ct.phone, ct.email
     FROM projects p LEFT JOIN contacts ct ON ct.id=p.contact_id
     WHERE ${acc} AND p.scheduled_date = $${params.length}::date AND p.status IN ('scheduled','in_progress')`,
    params,
  );
  return rows
    .map((r) => {
      const missing: string[] = [];
      if (!r.address || !String(r.address).trim()) missing.push("주소");
      if (!r.start_time) missing.push("시간");
      if (!r.phone && !r.email) missing.push("연락처");
      const pre = (r.checklist ?? []).filter((c: any) => c.phase === "pre" && !c.done).map((c: any) => c.label);
      return { id: r.id, title: r.title, display_name: r.display_name, missing, pendingChecklist: pre };
    })
    .filter((r) => r.missing.length > 0);
}
