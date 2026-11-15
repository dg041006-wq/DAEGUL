import { useState } from "react";
import { Link } from "react-router-dom";
import { patch, post, useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { fmtDateTime, kstLocalToIso } from "../lib/format";
import { Empty, ErrorBox, Loading } from "../components/common";

export function Tasks() {
  const { me } = useSession();
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const tasks = useApi<any[]>(`/api/tasks?status=${status}`, { poll: 20000 });
  const members = useApi<any[]>("/api/members/brief", { poll: 0 });
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>할 일</h1>
          <p className="muted small">답변 지연·견적 후속 확인은 설정 기준에 따라 자동 생성됩니다(외부 발송 없음).</p>
        </div>
      </div>
      <form
        className="card row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          await post("/api/tasks", { title, due_at: due ? kstLocalToIso(due) : null, assignee_user_id: assignee || null });
          setTitle("");
          setDue("");
          tasks.reload();
        }}
      >
        <input placeholder="새 할 일" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: "2 1 220px", width: "auto" }} aria-label="할 일 제목" />
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} style={{ flex: "1 1 180px", width: "auto" }} aria-label="마감" />
        {canDo(me, "view_all_conversations") && (
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ flex: "1 1 120px", width: "auto" }} aria-label="담당자">
            <option value="">나</option>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn primary">추가</button>
      </form>
      <div className="tabs" style={{ marginTop: 14 }}>
        {(["open", "done", "all"] as const).map((s) => (
          <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
            {{ open: "진행 중", done: "완료", all: "전체" }[s]}
          </button>
        ))}
      </div>
      <div className="card">
        {tasks.loading ? (
          <Loading />
        ) : tasks.error ? (
          <ErrorBox error={tasks.error} />
        ) : tasks.data!.length === 0 ? (
          <Empty>할 일이 없습니다.</Empty>
        ) : (
          tasks.data!.map((t) => {
            const overdue = t.status === "open" && t.due_at && new Date(t.due_at) < new Date();
            return (
              <div key={t.id} className="list-item">
                <input
                  type="checkbox"
                  style={{ width: 22, height: 22, marginTop: 2 }}
                  checked={t.status === "done"}
                  aria-label={`${t.title} 완료`}
                  onChange={async (e) => {
                    await patch(`/api/tasks/${t.id}`, { status: e.target.checked ? "done" : "open" });
                    tasks.reload();
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ textDecoration: t.status === "done" ? "line-through" : undefined }}>
                    {t.conversation_id ? <Link to={`/inbox/${t.conversation_id}`}>{t.title}</Link> : t.opportunity_id ? <Link to={`/pipeline/${t.opportunity_id}`}>{t.title}</Link> : t.title}
                  </div>
                  <div className="tiny muted row" style={{ gap: 6 }}>
                    <span>{t.assignee_name ?? "미배정"}</span>
                    <span style={{ color: overdue ? "var(--danger)" : undefined }}>마감 {fmtDateTime(t.due_at)}</span>
                    {t.source === "system" && <span className="badge">자동 생성</span>}
                    {t.source === "ai" && <span className="badge ai">AI 제안</span>}
                    {t.source_reason && <span>{t.source_reason}</span>}
                  </div>
                </div>
                {t.status === "open" && (
                  <button
                    className="btn sm ghost"
                    onClick={async () => {
                      await patch(`/api/tasks/${t.id}`, { status: "cancelled" });
                      tasks.reload();
                    }}
                  >
                    취소
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
