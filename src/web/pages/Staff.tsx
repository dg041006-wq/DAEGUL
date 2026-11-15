import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, post, useApi } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { StaffAvatar } from "../components/StaffAvatar";
import { BackLink, Empty, ErrorBox, Loading, useToast } from "../components/common";

const EXAMPLES: Record<string, string[]> = {
  cs: ["오늘 답장 안 한 문의부터 보여줘", "필수 정보가 빠진 상담 정리해줘"],
  marketing: ["최근 상담에서 고객이 가장 많이 묻는 걸로 게시물 주제 뽑아줘", "서비스별 문의 추세 알려줘"],
  strategy: ["견적을 보냈는데 계약이 안 된 건을 근거랑 같이 정리해줘", "이번 달 전환이 막히는 단계는?"],
  meeting: ["세 팀장 의견 모아서 이번 주 내가 먼저 할 일 세 가지 알려줘"],
};

export function StaffRoom() {
  const roles = useApi<any>("/api/ai/roles", { poll: 15000 });
  if (roles.loading) return <Loading />;
  if (roles.error) return <ErrorBox error={roles.error} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI 직원</h1>
          <p className="muted small">필요한 역할만 호출합니다. 합동 검토는 '전체 회의'에서 공유된 근거 묶음으로 1회 처리합니다.</p>
        </div>
      </div>
      {!roles.data.ai.available && <div className="banner info">{roles.data.ai.message} — 현재는 DB 집계 기반 규칙 응답만 제공합니다.</div>}
      <div className="grid grid-3">
        {roles.data.roles.map((r: any) => (
          <Link key={r.role_key} to={`/staff/${r.role_key}`} className="card" style={{ textDecoration: "none", textAlign: "center" }}>
            <div style={{ display: "grid", placeItems: "center" }}>
              <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} size={130} working={roles.data.status[r.role_key]?.running} label={`${r.title} ${r.display_name}`} />
            </div>
            <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
              <h2>{r.display_name}</h2>
              <span className="badge ai">AI</span>
            </div>
            <p className="muted small">{r.title}</p>
            <p className="small" style={{ marginTop: 8, textAlign: "left" }}>
              {r.instructions}
            </p>
          </Link>
        ))}
      </div>
      <Link to="/staff/meeting" className="card row" style={{ marginTop: 14, textDecoration: "none" }}>
        <div className="row" style={{ gap: 0 }}>
          {roles.data.roles.map((r: any, i: number) => (
            <div key={r.role_key} style={{ marginLeft: i ? -14 : 0 }}>
              <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} size={48} />
            </div>
          ))}
        </div>
        <div>
          <h2>전체 회의</h2>
          <p className="small muted">세 팀장의 관점을 한 번에 모아 대표가 먼저 할 일을 정리합니다.</p>
        </div>
      </Link>
    </>
  );
}

export function StaffChat() {
  const { role = "cs", threadId } = useParams();
  const nav = useNavigate();
  const roles = useApi<any>("/api/ai/roles", { poll: 0 });
  const threads = useApi<any[]>(`/api/ai/threads?role=${role}`, { poll: 0 });
  const thread = useApi<any>(threadId ? `/api/ai/threads/${threadId}` : null, { poll: 0 });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const pending = thread.data?.messages?.some((m: any) => m.status === "pending" || m.status === "running");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(thread.reload, 2000);
    return () => clearInterval(t);
  }, [pending, thread.reload]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.data?.messages?.length, pending]);

  const r = role === "meeting" ? { display_name: "전체 회의", title: "세 팀장 합동 검토", suit_color: "#1f2f4f" } : roles.data?.roles.find((x: any) => x.role_key === role);
  const send = async (msg: string) => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      if (threadId) {
        await post(`/api/ai/threads/${threadId}/messages`, { message: msg });
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
          {r && role !== "meeting" && <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} size={52} />}
          <div>
            <div className="row" style={{ gap: 6 }}>
              <h1>{r?.display_name ?? ""}</h1>
              <span className="badge ai">AI</span>
            </div>
            <p className="muted small">{r?.title}</p>
          </div>
        </div>
        <div className="row">
          <select aria-label="이전 대화" value={threadId ?? ""} onChange={(e) => nav(e.target.value ? `/staff/${role}/${e.target.value}` : `/staff/${role}`)} style={{ width: "auto", maxWidth: 260 }}>
            <option value="">+ 새 대화</option>
            {(threads.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chat">
        {!threadId && (
          <div className="card">
            <p className="small muted">예시 요청</p>
            <div className="row" style={{ marginTop: 6 }}>
              {(EXAMPLES[role] ?? []).map((e) => (
                <button key={e} className="chip" onClick={() => send(e)} disabled={sending}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {thread.loading && threadId ? <Loading /> : null}
        {thread.data?.messages.map((m: any) => (m.author === "user" ? <div key={m.id} className="bubble user pre">{m.content}</div> : <AssistantBubble key={m.id} m={m} />))}
        <div ref={endRef} />
      </div>

      <form
        className="card row"
        style={{ position: "sticky", bottom: 72, marginTop: 14, flexWrap: "nowrap", alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea aria-label="요청 입력" placeholder="업무를 요청하세요" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 48 }} />
        <button className="btn primary" disabled={sending || !text.trim() || pending}>
          요청
        </button>
      </form>
      {toast.node}
    </>
  );
}

function AssistantBubble({ m }: { m: any }) {
  const toast = useToast();
  if (m.status === "pending" || m.status === "running")
    return (
      <div className="bubble assistant">
        <span className="badge navy">
          <span className="status-dot live" /> 분석 중
        </span>
        <span className="small muted"> 권한 범위 안의 자료를 조회하고 있습니다…</span>
      </div>
    );
  const meta = m.meta ?? {};
  return (
    <div className="bubble assistant">
      {meta.engine === "rules" && <span className="badge warn" style={{ marginBottom: 6 }}>규칙 기반 집계 (모델 미사용)</span>}
      {meta.sample_data && <span className="badge warn" style={{ marginLeft: 4 }}>샘플 데이터 기반</span>}
      <div className="pre" style={{ marginTop: 4 }}>{m.content}</div>
      {m.customer_draft && (
        <div className="draft-box">
          <div className="label">고객 발송용 초안 — 내부 보고와 별도 · 담당자 확인 후 공급사 화면에서 발송</div>
          <div className="pre small">{m.customer_draft}</div>
          <button
            className="btn sm"
            style={{ marginTop: 6 }}
            onClick={async () => {
              await navigator.clipboard?.writeText(m.customer_draft).catch(() => {});
              toast.show("복사했습니다.");
            }}
          >
            복사
          </button>
        </div>
      )}
      {m.next_actions?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b className="small">다음 행동</b>
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
      <div className="meta-line">
        {meta.periods?.length > 0 && <span>분석 기간 {meta.periods.map((p: any) => `${p.from}~${p.to}`).join(", ")}</span>}
        {meta.target_counts && (
          <span>
            대상 상담 {meta.target_counts.conversations} · 문의 {meta.target_counts.opportunities}
          </span>
        )}
        {meta.target_count != null && <span>대상 {meta.target_count}건</span>}
        <span>최신 동기화 {fmtDateTime(meta.data_synced_at)}</span>
        <span>{meta.kakao_verified ? "카카오 연동 검증됨" : "카카오 미연동"}</span>
        {m.model && <span>모델 {m.model}</span>}
        {m.prompt_version && <span>지침 {m.prompt_version}</span>}
        <span>{fmtDateTime(m.created_at)}</span>
      </div>
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
  return <Empty>-</Empty>;
}
