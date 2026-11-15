// 권한 범위(Scope): 모든 읽기/쓰기와 AI 도구 호출은 이 객체로 서버에서 필터링한다.
import type { StaffPerm } from "../../shared/domain.js";

export interface Scope {
  orgId: string;
  userId: string;
  role: "owner" | "staff";
  perms: Partial<Record<StaffPerm, boolean>>;
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = "권한이 없습니다.") {
    super(msg);
  }
}
export class NotFoundError extends Error {
  status = 404;
  constructor(msg = "찾을 수 없습니다.") {
    super(msg);
  }
}

export const isOwner = (s: Scope) => s.role === "owner";
export const can = (s: Scope, p: StaffPerm) => s.role === "owner" || s.perms[p] === true;

export function requireOwner(s: Scope) {
  if (!isOwner(s)) throw new ForbiddenError("대표만 사용할 수 있는 기능입니다.");
}
export function requirePerm(s: Scope, p: StaffPerm) {
  if (!can(s, p)) throw new ForbiddenError();
}

/**
 * 상담 접근 조건 SQL. alias = conversations 테이블 별칭.
 * 반환된 SQL 조각은 params 배열에 값을 push하며 placeholder 번호를 만든다.
 */
export function conversationAccessSql(s: Scope, alias: string, params: unknown[]): string {
  params.push(s.orgId);
  const org = `${alias}.org_id = $${params.length}`;
  if (can(s, "view_all_conversations")) return org;
  params.push(s.userId);
  return `${org} AND ${alias}.assignee_user_id = $${params.length}`;
}

/** 영업 기회 접근 조건: 담당자 본인이거나, 본인 배정 상담이 연결된 기회 */
export function opportunityAccessSql(s: Scope, alias: string, params: unknown[]): string {
  params.push(s.orgId);
  const org = `${alias}.org_id = $${params.length}`;
  if (can(s, "view_all_conversations")) return org;
  params.push(s.userId);
  const u = `$${params.length}`;
  return `${org} AND (${alias}.owner_user_id = ${u} OR EXISTS (
    SELECT 1 FROM opportunity_conversations oc JOIN conversations cc ON cc.id = oc.conversation_id
    WHERE oc.opportunity_id = ${alias}.id AND cc.assignee_user_id = ${u}))`;
}

/** 작업(프로젝트) 접근: 전체 조회 권한, 담당자 본인, 또는 본인 배정 상담과 연결된 고객의 작업 */
export function projectAccessSql(s: Scope, alias: string, params: unknown[]): string {
  params.push(s.orgId);
  const org = `${alias}.org_id = $${params.length}`;
  if (can(s, "view_all_conversations")) return org;
  params.push(s.userId);
  const u = `$${params.length}`;
  return `${org} AND (${alias}.assignee_user_id = ${u} OR EXISTS (
    SELECT 1 FROM conversations cc WHERE cc.contact_id = ${alias}.contact_id AND cc.assignee_user_id = ${u}))`;
}

/** 고객 접근: 전체 조회 권한 또는 본인 배정 상담/작업이 있는 고객 */
export function contactAccessSql(s: Scope, alias: string, params: unknown[]): string {
  params.push(s.orgId);
  const org = `${alias}.org_id = $${params.length}`;
  if (can(s, "view_all_conversations")) return org;
  params.push(s.userId);
  const u = `$${params.length}`;
  return `${org} AND (EXISTS (SELECT 1 FROM conversations cc WHERE cc.contact_id=${alias}.id AND cc.assignee_user_id=${u})
    OR EXISTS (SELECT 1 FROM projects pp WHERE pp.contact_id=${alias}.id AND pp.assignee_user_id=${u}))`;
}
