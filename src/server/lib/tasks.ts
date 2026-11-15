// 할 일 생성/수정 — 화면 API, AI 도구, 보고 버튼이 모두 같은 함수와 권한 검사를 사용한다.
import { q, q1 } from "../db/pool.js";
import { can, conversationAccessSql, ForbiddenError, NotFoundError, opportunityAccessSql, projectAccessSql, contactAccessSql, type Scope } from "../auth/scope.js";
import { audit } from "./audit.js";
import { addDays, kstDateString, kstStartOfDay } from "./time.js";

async function assertAccess(s: Scope, table: "conversations" | "opportunities" | "projects" | "contacts", id: string) {
  const params: unknown[] = [];
  const acc =
    table === "conversations" ? conversationAccessSql(s, "x", params) : table === "opportunities" ? opportunityAccessSql(s, "x", params) : table === "projects" ? projectAccessSql(s, "x", params) : contactAccessSql(s, "x", params);
  params.push(id);
  const r = await q1(`SELECT 1 FROM ${table} x WHERE ${acc} AND x.id::text = $${params.length}`, params);
  if (!r) throw new NotFoundError("대상을 찾을 수 없거나 권한이 없습니다.");
}

export interface TaskInput {
  title: string;
  description?: string | null;
  assignee_user_id?: string | null;
  due_at?: string | null;
  remind_at?: string | null;
  conversation_id?: string | null;
  opportunity_id?: string | null;
  project_id?: string | null;
  contact_id?: string | null;
  source?: "manual" | "ai" | "system";
  source_reason?: string | null;
}

export async function createTask(s: Scope, t: TaskInput, via: "user" | "ai" = "user") {
  if (t.conversation_id) await assertAccess(s, "conversations", t.conversation_id);
  if (t.opportunity_id) await assertAccess(s, "opportunities", t.opportunity_id);
  if (t.project_id) await assertAccess(s, "projects", t.project_id);
  if (t.contact_id) await assertAccess(s, "contacts", t.contact_id);
  const assignee = t.assignee_user_id ?? s.userId;
  if (assignee !== s.userId) {
    if (!can(s, "view_all_conversations")) throw new ForbiddenError("다른 직원에게 할 일을 배정할 권한이 없습니다.");
    const m = await q1(`SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2 AND status='active'`, [s.orgId, assignee]);
    if (!m) throw new NotFoundError("담당자를 찾을 수 없습니다.");
  }
  const row = await q1<any>(
    `INSERT INTO tasks(org_id, title, description, assignee_user_id, due_at, remind_at, conversation_id, opportunity_id, project_id, contact_id, source, source_reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [s.orgId, t.title.slice(0, 200), t.description ?? null, assignee, t.due_at ?? null, t.remind_at ?? null, t.conversation_id ?? null, t.opportunity_id ?? null, t.project_id ?? null, t.contact_id ?? null, t.source ?? (via === "ai" ? "ai" : "manual"), t.source_reason ?? null, s.userId],
  );
  await audit({ orgId: s.orgId, actorUserId: s.userId, actorType: via === "ai" ? "ai" : "user", action: "task.create", targetType: "task", targetId: row.id });
  return row;
}

export async function updateTask(
  s: Scope,
  id: string,
  b: { status?: "open" | "done" | "cancelled"; title?: string; due_at?: string | null; assignee_user_id?: string | null; remind_at?: string | null; version?: number },
  via: "user" | "ai" = "user",
) {
  const t = await q1<any>(`SELECT * FROM tasks WHERE id::text=$1 AND org_id=$2`, [id, s.orgId]);
  if (!t) throw new NotFoundError("할 일을 찾을 수 없습니다.");
  if (t.assignee_user_id !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError();
  if (b.assignee_user_id !== undefined && b.assignee_user_id !== s.userId && !can(s, "view_all_conversations")) throw new ForbiddenError();
  if (b.version !== undefined && b.version !== t.version) throw Object.assign(new Error("다른 기기에서 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 시도하세요."), { status: 409, current: t });
  const r = await q1<any>(
    `UPDATE tasks SET status=COALESCE($2,status), title=COALESCE($3,title),
       due_at=CASE WHEN $4::boolean THEN $5::timestamptz ELSE due_at END,
       assignee_user_id=CASE WHEN $6::boolean THEN $7::uuid ELSE assignee_user_id END,
       remind_at=CASE WHEN $8::boolean THEN $9::timestamptz ELSE remind_at END,
       completed_at=CASE WHEN $2='done' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE completed_at END,
       version=version+1, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [t.id, b.status ?? null, b.title ?? null, b.due_at !== undefined, b.due_at ?? null, b.assignee_user_id !== undefined, b.assignee_user_id ?? null, b.remind_at !== undefined, b.remind_at ?? null],
  );
  await audit({ orgId: s.orgId, actorUserId: s.userId, actorType: via === "ai" ? "ai" : "user", action: "task.update", targetType: "task", targetId: t.id, detail: b });
  return r;
}

/** 자연어 시점 → KST 시각. 확정 가능한 표현만 해석하고 아니면 null */
export function parseWhen(text: string, now = new Date()): string | null {
  const today = kstDateString(now);
  let day: string | null = null;
  if (/모레/.test(text)) day = addDays(today, 2);
  else if (/내일/.test(text)) day = addDays(today, 1);
  else if (/오늘/.test(text)) day = today;
  if (!day) return null;
  let h = /오전/.test(text) ? 10 : /오후/.test(text) ? 15 : /저녁/.test(text) ? 18 : 10;
  const m = text.match(/(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*반)?/);
  if (m) {
    h = Number(m[1]);
    if (/오후|저녁/.test(text) && h < 12) h += 12;
  }
  const min = m?.[2] ? Number(m[2]) : /시\s*반/.test(text) ? 30 : 0;
  return new Date(kstStartOfDay(day).getTime() + (h * 60 + min) * 60000).toISOString();
}
