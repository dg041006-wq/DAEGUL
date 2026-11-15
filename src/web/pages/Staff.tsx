import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, post, useApi } from "../lib/api";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { StaffAvatar } from "../components/StaffAvatar";
import { BackLink, Empty, ErrorBox, Loading, useToast } from "../components/common";

const EXAMPLES: Record<string, string[]> = {
  ops: ["내일 일정 알려줘", "이번 주 미수금 확인해줘", "내일 오전에 거래처 연락할 일 넣어줘"],
  sales: ["오늘 답장 안 한 문의부터 보여줘", "견적 답장 초안 만들어줘", "견적 보내고 회신 없는 고객 정리해줘"],
  strategy: ["이번 달 전환이 막히는 단계는?", "재의뢰 고객이 몇 명이야?", "수익성 낮은 작업 유형을 근거와 함께 알려줘"],
  meeting: ["세 담당 의견 모아서 이번 주 내가 먼저 할 일 세 가지 알려줘"],
};

export function StaffRoom() {
  const roles = useApi<any>("/api/ai/roles", { tables: ["ai_messages"] });
  if (roles.loading) return <Loading />;
  if (roles.error) return <ErrorBox error={roles.error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI 직원</h1>
          <p className="muted small">각 담당이 필요한 상황에 대표님께 먼저 보고합니다. 담당을 눌러 보고를 확인하고 업무를 맡기세요.</p>
        </div>
      </div>
      {!roles.data.ai.available && <div className="banner info">{roles.data.ai.message} — 지금은 규칙 기반으로 처리합니다(할 일 등록·미수금·일정 조회는 실제 실행).</div>}
      <div className="grid grid-3">
        {roles.data.roles.map((r: any) => {
          const st = roles.data.status[r.role_key] ?? {};
          return (
            <Link key={r.role_key} to={`/staff/${r.role_key}`} className="card" style={{ textDecoration: "none", textAlign: "center" }}>
              <div style={{ display: "grid", placeItems: "center" }}>
                <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} accent={r.appearance?.accent} size={140} working={st.running} label={`${r.title} ${r.display_name}`} />
              </div>
              <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
                <h2>{r.display_name}</h2>
                <span className="badge ai">AI</span>
                {st.newReports > 0 && <span className="badge brass">새 보고 {st.newReports}</span>}
              </div>
              <p className="muted small">{r.title}</p>
              <p className="small" style={{ marginTop: 8, textAlign: "left" }}>
                {r.instructions}
              </p>
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function StaffChat() {
  const { role = "sales", threadId } = useParams();
  const nav = useNavigate();
  const roles = useApi<any>("/api/ai/roles", { poll: 0 });
  const threads = useApi<any[]>(`/api/ai/threads?role=${role}`, { tables: ["ai_messages"] });
  const feedThread = (threads.data ?? []).find((t) => t.kind === "feed");
  const isNew = threadId === "new";
  const activeId = isNew ? null : threadId ?? feedThread?.id ?? null;
  const thread = useApi<any>(activeId ? `/api/ai/threads/${activeId}` : null, { tables: ["ai_messages"] });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const isFeed = thread.data?.thread?.kind === "feed";

  const pending = thread.data?.messages?.some((m: any) => m.status === "pending" || m.status === "running");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(thread.reload, 2000);
    return () => clearInterval(t);
  }, [pending, thread.reload]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.data?.messages?.length, pending]);
  useEffect(() => {
    post("/api/ai/feed/read").catch(() => {});
  }, [activeId]);

  const r = role === "meeting" ? { display_name: "전체 회의", title: "세 담당 합동 검토", suit_color: "#22304f" } : roles.data?.roles.find((x: any) => x.role_key === role);
  const send = async (msg: string) => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      if (activeId) {
        await post(`/api/ai/threads/${activeId}/messages`, { message: msg });
        thread.reload();
      } else {
        const t = await post("/api/ai/threads", { role_key: role, message: msg });
        threads.reload();
        nav(`/staff/${role}/${t.id}`);
      }
      setText("");
    } catch (e: any) {
      toast.show(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <BackLink to="/staff" label="AI 직원" />
      <div className="page-head">
        <div className="row">
          {r && role !== "meeting" && <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} accent={r.appearance?.accent} size={56} />}
          <div>
            <div className="row" style={{ gap: 6 }}>
              <h1>{r?.display_name ?? ""}</h1>
              <span className="badge ai">AI</span>
            </div>
            <p className="muted small">
              {r?.title} {isFeed && "· 대표님 전용 보고방"}
            </p>
          </div>
        </div>
        <div className="row">
          <select aria-label="대화 선택" value={activeId ?? ""} onChange={(e) => nav(e.target.value ? `/staff/${role}/${e.target.value}` : `/staff/${role}`)} style={{ width: "auto", maxWidth: 260 }}>
            {!feedThread && <option value="">+ 새 대화</option>}
            {(threads.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.kind === "feed" ? "📌 대표님 보고방" : t.title}
              </option>
            ))}
          </select>
          {activeId && (
            <button className="btn sm" onClick={() => nav(`/staff/${role}/new`)}>
              새 대화
            </button>
          )}
        </div>
      </div>

      <div className="chat">
        {!activeId && (
          <div className="card">
            <p className="small muted">이렇게 요청해 보세요</p>
            <div className="row" style={{ marginTop: 6 }}>
              {(EXAMPLES[role] ?? []).map((e) => (
                <button key={e} className="chip" onClick={() => send(e)} disabled={sending}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {thread.loading && activeId ? <Loading /> : null}
        {thread.data?.messages.length === 0 && isFeed && <Empty>아직 보고가 없습니다. 신규 문의·계약·입금·일정 변경·납기 위험 등이 생기면 먼저 보고합니다.</Empty>}
        {activeId &&
          thread.data?.messages.map((m: any) =>
            m.author === "user" ? (
              <div key={m.id} className="bubble user pre">
                {m.content}
              </div>
            ) : (
              <AssistantBubble key={m.id} m={m} onAction={thread.reload} />
            ),
          )}
        <div ref={endRef} />
      </div>

      <form
        className="card row composer-sticky"
        style={{ marginTop: 14, flexWrap: "nowrap", alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea aria-label="요청 입력" placeholder={isFeed ? "보고에 대해 지시하세요 (예: 이 고객 내일 오전에 연락할 일 넣어줘)" : "업무를 요청하세요"} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 48 }} />
        <button className="btn primary" disabled={sending || !text.trim() || pending}>
          요청
        </button>
      </form>
      {toast.node}
    </>
  );
}

function AssistantBubble({ m, onAction }: { m: any; onAction: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [busy, setBusy] = useState<number | null>(null);
  if (m.status === "pending" || m.status === "running")
    return (
      <div className="bubble assistant">
        <span className="badge navy">
          <span className="status-dot live" /> 처리 중
        </span>
        <span className="small muted"> 권한 범위 안의 자료를 조회하고 있습니다…</span>
      </div>
    );
  if (m.status === "failed")
    return (
      <div className="bubble assistant">
        <span className="badge danger">실패</span> <span className="small">{m.content}</span>
      </div>
    );
  const meta = m.meta ?? {};
  const kindBadge = m.kind === "alert" ? (meta.severity === "critical" ? <span className="badge danger">즉시 보고</span> : <span className="badge navy">보고</span>) : m.kind === "report" ? <span className="badge brass">정기 보고</span> : m.kind === "action_result" ? <span className="badge ok">처리 결과</span> : null;
  return (
    <div className={`bubble assistant ${meta.resolved ? "resolved" : ""}`}>
      <div className="row" style={{ gap: 4, marginBottom: 4 }}>
        {kindBadge}
        {meta.is_test && <span className="badge">테스트</span>}
        {meta.engine === "rules" && m.kind === "reply" && <span className="badge warn">규칙 기반 (모델 미사용)</span>}
        {meta.engine === "model" && <span className="badge ok">AI 모델</span>}
        {meta.sample_data && <span className="badge warn">샘플 데이터 기반</span>}
        {meta.resolved && <span className="badge ok">처리 완료</span>}
        <span className="tiny muted">{fmtRelative(m.created_at)}</span>
      </div>
      <div className="pre">{m.content}</div>
      {(m.actions ?? []).length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          {m.actions.map((a: any, i: number) => (
            <button
              key={i}
              className={`btn sm ${a.type === "open" ? "" : "primary"}`}
              disabled={busy !== null}
              onClick={async () => {
                if (a.type === "open") return nav(a.link);
                setBusy(i);
                try {
                  const r = await post(`/api/ai/messages/${m.id}/actions/${i}`);
                  toast.show(r.summary);
                  onAction();
                  if (r.link && (a.type === "draft_reply" || a.type === "assign_self")) nav(r.link);
                } catch (e: any) {
                  toast.show(e.message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === i ? "처리 중…" : a.label}
            </button>
          ))}
        </div>
      )}
      {m.customer_draft && (
        <div className="draft-box">
          <div className="label">고객 발송용 초안 — 내부 보고와 별도 · 승인 전 미발송</div>
          <div className="pre small">{m.customer_draft}</div>
        </div>
      )}
      {m.next_actions?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b className="small">다음 행동 제안</b>
          {m.next_actions.map((a: any, i: number) => (
            <div key={i} className="row small" style={{ marginTop: 4 }}>
              <span>• {a.title}</span>
              {a.due && <span className="muted">({a.due})</span>}
              <button
                className="btn sm ghost"
                onClick={async () => {
                  await post("/api/tasks", { title: a.title, source: "ai", source_reason: "AI 직원 제안", due_at: a.due ? new Date(`${a.due}T18:00:00+09:00`).toISOString() : null });
                  toast.show("할 일로 등록했습니다.");
                }}
              >
                할 일로 등록
              </button>
            </div>
          ))}
        </div>
      )}
      {meta.evidence?.length > 0 && (
        <div className="evidence" style={{ marginTop: 10 }}>
          <b className="small">근거</b>
          <ul className="small" style={{ paddingLeft: 18, margin: "4px 0" }}>
            {meta.evidence.map((e: any, i: number) => (
              <li key={i}>
                <EvidenceTarget e={e} /> {e.note}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(m.kind === "reply" || m.kind === "action_result") && meta.engine && (
        <div className="meta-line">
          {meta.periods?.length > 0 && <span>기간 {meta.periods.map((p: any) => `${p.from}~${p.to}`).join(", ")}</span>}
          {meta.target_counts && <span>대상 상담 {meta.target_counts.conversations} · 문의 {meta.target_counts.opportunities}</span>}
          {meta.data_synced_at && <span>최신 수신 {fmtDateTime(meta.data_synced_at)}</span>}
          {m.model && <span>모델 {m.model}</span>}
          {m.error_kind && <span>오류 {m.error_kind}</span>}
        </div>
      )}
      {toast.node}
    </div>
  );
}

function EvidenceTarget({ e }: { e: any }) {
  const nav = useNavigate();
  if (e.message_id)
    return (
      <a
        href="#"
        onClick={async (ev) => {
          ev.preventDefault();
          try {
            const r = await get(`/api/evidence/message/${e.message_id}`);
            nav(`/inbox/${r.conversationId}?m=${r.messageId}`);
          } catch {
            alert("권한 범위 밖이거나 삭제된 메시지입니다.");
          }
        }}
      >
        [메시지]
      </a>
    );
  if (e.conversation_id) return <Link to={`/inbox/${e.conversation_id}`}>[상담]</Link>;
  if (e.opportunity_id) return <Link to={`/pipeline/${e.opportunity_id}`}>[문의 건]</Link>;
  return null;
}
