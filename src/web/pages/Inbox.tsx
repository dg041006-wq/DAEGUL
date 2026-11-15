import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { del, patch, post, useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { fmtDateTime, fmtRelative, fmtTime } from "../lib/format";
import { CategoryBadge, DataBanner, Empty, ErrorBox, Loading, Modal, SampleTag, StageBadge, useToast } from "../components/common";
import { SERVICE_TYPES, STAGES, STAGE_LABELS } from "../../shared/domain";
import { Icon } from "../components/Icon";

const FILTERS = [
  ["all", "전체"],
  ["awaiting", "답변 대기"],
  ["mine", "내 담당"],
  ["unassigned", "미배정"],
  ["closed", "종료"],
] as const;

const SENDER_LABEL: Record<string, string> = { customer: "고객", staff: "직원", bot: "자동 안내", system: "시스템" };

export function Inbox() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const filter = sp.get("filter") ?? "all";
  const service = sp.get("service") ?? "";
  const stage = sp.get("stage") ?? "";
  const qs = new URLSearchParams({ filter, ...(service ? { service } : {}), ...(stage ? { stage } : {}) }).toString();
  const list = useApi<any[]>(`/api/conversations?${qs}`, { poll: 15000 });
  const home = useApi<any>("/api/home", { poll: 60000 });
  const [showInfo, setShowInfo] = useState(false);
  const [registering, setRegistering] = useState(false);
  const navTo = useNavigate();
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>상담함</h1>
          <p className="muted small">카카오 공급사 미연동: 상담은 수동 등록·가져오기·테스트 수신으로 관리하고, 고객 답장은 공급사 화면에서 보낸 뒤 '직접 발송함'으로 기록합니다.</p>
        </div>
        <button className="btn primary" onClick={() => setRegistering(true)}>
          + 상담 등록
        </button>
      </div>
      {registering && (
        <Modal title="상담 등록" onClose={() => setRegistering(false)}>
          <ManualConversation
            onDone={(id) => {
              setRegistering(false);
              list.reload();
              navTo(`/inbox/${id}`);
            }}
          />
        </Modal>
      )}
      <DataBanner ds={home.data?.dataStatus} />
      <div className={`inbox ${id ? "has-conv" : ""} ${showInfo ? "show-info" : ""}`}>
        <section className="list" aria-label="상담 목록">
          <div className="filters">
            <div className="chips" role="tablist">
              {FILTERS.map(([k, l]) => (
                <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setParam("filter", k === "all" ? "" : k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select aria-label="서비스 필터" value={service} onChange={(e) => setParam("service", e.target.value)}>
                <option value="">모든 서비스</option>
                {SERVICE_TYPES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <select aria-label="진행 상태 필터" value={stage} onChange={(e) => setParam("stage", e.target.value)}>
                <option value="">모든 단계</option>
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {list.loading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} />
          ) : list.data!.length === 0 ? (
            <Empty>표시할 상담이 없습니다.</Empty>
          ) : (
            list.data!.map((c) => (
              <Link key={c.id} to={`/inbox/${c.id}?${sp.toString()}`} className={`conv-item ${c.id === id ? "on" : ""}`}>
                <div className="top">
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.display_name ?? "이름 미제공 고객"}</b>
                  <span className="spacer" />
                  <span className="tiny muted nowrap">{fmtRelative(c.last_message_at)}</span>
                </div>
                <div className="preview">{c.last_body ?? "(첨부/빈 메시지)"}</div>
                <div className="row" style={{ gap: 4, marginTop: 4 }}>
                  {c.awaiting && <span className="badge danger">답변 대기</span>}
                  {c.stage && <StageBadge stage={c.stage} />}
                  <CategoryBadge category={c.category} />
                  {c.locked_by && <span className="badge warn">작성 중</span>}
                  {c.data_origin === "test" && <span className="badge">테스트</span>}
                  {c.data_origin === "manual" && <span className="badge">수동</span>}
                  <SampleTag show={c.is_sample} />
                  <span className="tiny muted">{c.assignee_name ?? "미배정"}</span>
                </div>
              </Link>
            ))
          )}
        </section>
        <section className="thread-col">{id ? <Conversation id={id} onInfo={() => setShowInfo(true)} onChanged={list.reload} /> : <Empty>왼쪽에서 상담을 선택하세요.</Empty>}</section>
        {id && (
          <section className="info" aria-label="고객 및 문의 정보">
            <InfoPanel id={id} onClose={() => setShowInfo(false)} />
          </section>
        )}
        {showInfo && <div className="drawer-backdrop mobile-only" onClick={() => setShowInfo(false)} />}
      </div>
    </>
  );
}

function Conversation({ id, onInfo, onChanged }: { id: string; onInfo: () => void; onChanged: () => void }) {
  const { me } = useSession();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const highlight = sp.get("m");
  const d = useApi<any>(`/api/conversations/${id}`, { poll: 10000 });
  const members = useApi<any[]>("/api/members/brief", { poll: 0 });
  const [text, setText] = useState("");
  const [lockErr, setLockErr] = useState<string | null>(null);
  const toast = useToast();
  const endRef = useRef<HTMLDivElement>(null);

  const timeline = useMemo(() => {
    if (!d.data) return [];
    const items = [
      ...d.data.messages.map((m: any) => ({ kind: "msg", at: m.sent_at, m })),
      ...d.data.notes.map((n: any) => ({ kind: "note", at: n.created_at, n })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [d.data]);

  useEffect(() => {
    if (highlight) document.getElementById(`m-${highlight}`)?.scrollIntoView({ block: "center" });
    else endRef.current?.scrollIntoView({ block: "end" });
  }, [timeline.length, highlight]);

  // 작성 잠금: 메모 작성 시작 시 획득, 30초마다 갱신
  useEffect(() => {
    if (!text) return;
    let alive = true;
    const acquire = () =>
      post(`/api/conversations/${id}/lock`)
        .then(() => alive && setLockErr(null))
        .catch((e) => alive && setLockErr(e.message));
    acquire();
    const t = setInterval(acquire, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, !!text]);
  useEffect(() => () => void del(`/api/conversations/${id}/lock`).catch(() => {}), [id]);

  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const c = d.data.conversation;
  const lockOther = d.data.lock && d.data.lock.user_id !== me?.user.id ? d.data.lock : null;

  return (
    <div className="thread">
      <div className="thread-head">
        <button className="btn ghost sm mobile-only" onClick={() => nav(`/inbox?${sp.toString()}`)} aria-label="목록으로">
          <Icon name="back" />
        </button>
        <b>{d.data.contact?.display_name ?? "이름 미제공 고객"}</b>
        <span className={`badge ${c.status === "open" ? "ok" : ""}`}>{c.status === "open" ? "진행" : "종료"}</span>
        <SampleTag show={c.is_sample} />
        <span className="spacer" />
        <select
          aria-label="담당자"
          style={{ width: "auto", minHeight: 34 }}
          value={c.assignee_user_id ?? ""}
          onChange={async (e) => {
            try {
              await patch(`/api/conversations/${id}`, { assignee_user_id: e.target.value || null });
              d.reload();
              onChanged();
            } catch (err: any) {
              toast.show(err.message);
            }
          }}
          disabled={!canDo(me, "view_all_conversations")}
        >
          <option value="">미배정</option>
          {(members.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={onInfo} aria-label="고객 정보">
          <Icon name="info" size={18} />
          <span className="mobile-only">정보</span>
        </button>
      </div>
      <div className="messages" aria-live="polite">
        <div className="msg system">
          공급사: {c.provider === "demo" ? "샘플(데모)" : c.provider} · 상담 시작 {fmtDateTime(c.opened_at)}
        </div>
        {timeline.map((it: any) =>
          it.kind === "msg" ? (
            <div key={it.m.id} id={`m-${it.m.id}`} className={`msg ${it.m.sender_type} ${highlight === it.m.id ? "highlight" : ""}`}>
              {it.m.body ?? "(본문 없음)"}
              {it.m.attachments?.length ? <div className="tiny muted">첨부 {it.m.attachments.length}개 (공급사 화면에서 확인)</div> : null}
              <div className="meta">
                {SENDER_LABEL[it.m.sender_type]}
                {it.m.sender_name ? ` · ${it.m.sender_name}` : ""} · {fmtDateTime(it.m.sent_at)}
              </div>
            </div>
          ) : (
            <div key={it.n.id} className="note">
              <b>내부 메모 · 고객에게 보이지 않음</b> — {it.n.author_name} · {fmtTime(it.n.created_at)}
              <div className="pre">{it.n.body}</div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      <div className="composer note-mode">
        {lockOther && <div className="banner warn small" style={{ marginBottom: 6 }}>{lockOther.name}님이 이 상담에서 작성 중입니다. 중복 작성에 주의하세요.</div>}
        {lockErr && <div className="banner warn small" style={{ marginBottom: 6 }}>{lockErr}</div>}
        <div className="mode small">
          <span className="badge warn">내부 메모</span>
          <span className="muted tiny">앱에서 고객 발송은 공급사 검증 전까지 비활성화되어 있습니다.</span>
        </div>
        <form
          className="row"
          style={{ flexWrap: "nowrap", alignItems: "flex-end" }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            await post(`/api/conversations/${id}/notes`, { body: text });
            setText("");
            await del(`/api/conversations/${id}/lock`).catch(() => {});
            d.reload();
          }}
        >
          <textarea aria-label="내부 메모" placeholder="팀 내부 메모 (고객에게 보이지 않음)" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 44 }} />
          <button className="btn primary" disabled={!text.trim()}>
            저장
          </button>
        </form>
      </div>
      {toast.node}
    </div>
  );
}

function InfoPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useSession();
  const d = useApi<any>(`/api/conversations/${id}`, { poll: 15000 });
  const [busy, setBusy] = useState(false);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const toast = useToast();
  if (!d.data) return <Loading />;
  const c = d.data.conversation;
  const o = d.data.opportunity;
  const aiLabel: Record<string, string> = {
    none: "분석 전",
    queued: "분석 대기열",
    running: "분석 중",
    done: "분석 완료",
    waiting_no_api: "분석 대기 (모델 API 미연동)",
    waiting_budget: "분석 대기 (월 한도 도달)",
    failed: "분석 실패",
  };
  return (
    <div className="stack">
      <div className="row">
        <h2>고객 / 문의 정보</h2>
        <span className="spacer" />
        <button className="btn ghost sm info-close" onClick={onClose} aria-label="정보 닫기">
          ✕
        </button>
      </div>
      {o ? (
        <div className="card" style={{ padding: 12 }}>
          <div className="row">
            <StageBadge stage={o.stage} />
            <CategoryBadge category={o.category} />
            <span className="spacer" />
            <Link to={`/pipeline/${o.id}`} className="small">
              문의 건 열기 →
            </Link>
          </div>
          <table className="t" style={{ marginTop: 6 }}>
            <tbody>
              <Field k="서비스" v={o.services?.length ? o.services.join(", ") : null} ev={o.field_evidence?.services} />
              <Field k="공간 유형" v={o.space_type} ev={o.field_evidence?.space_type} />
              <Field k="지역" v={o.region} ev={o.field_evidence?.region} />
              <Field k="규모" v={o.size_text ?? (o.room_count != null ? `객실 ${o.room_count}개` : null)} ev={o.field_evidence?.size_text ?? o.field_evidence?.room_count} />
              <Field k="희망 일정" v={o.desired_schedule} ev={o.field_evidence?.desired_schedule} />
              <Field k="고객이 밝힌 예산" v={o.stated_budget} ev={o.field_evidence?.stated_budget} />
              <Field k="유입경로" v={o.source_channel} ev={o.field_evidence?.source_channel} />
            </tbody>
          </table>
          {d.data.linkReason === "auto_same_contact_active" && <p className="tiny muted">같은 고객의 진행 중인 건에 자동 연결된 상담입니다. 다른 프로젝트면 문의 건 화면에서 분리하세요.</p>}
        </div>
      ) : (
        <Empty>연결된 문의 건 없음</Empty>
      )}

      <div className="card" style={{ padding: 12 }}>
        <div className="card-head">
          <h3>
            AI 요약 <span className="badge ai">AI</span>
          </h3>
          <span className="tiny muted">{aiLabel[c.ai_status] ?? c.ai_status}</span>
        </div>
        <p className="small pre">{c.ai_summary ?? "아직 요약이 없습니다."}</p>
        {c.ai_missing_questions?.length > 0 && (
          <>
            <h3 style={{ marginTop: 10 }}>확인할 질문 후보</h3>
            <ul className="small" style={{ paddingLeft: 18, margin: "4px 0" }}>
              {c.ai_missing_questions.map((q: string, i: number) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="btn sm"
            onClick={async () => {
              await post(`/api/conversations/${id}/analyze`);
              d.reload();
            }}
          >
            다시 분석
          </button>
          {c.ai_analyzed_at && <span className="tiny muted">분석 {fmtDateTime(c.ai_analyzed_at)}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div className="card-head">
          <h3>답변 초안</h3>
          <button
            className="btn sm primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setDraftErr(null);
              try {
                await post(`/api/conversations/${id}/draft`);
                d.reload();
              } catch (e: any) {
                setDraftErr(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "작성 중…" : "AI 초안 만들기"}
          </button>
        </div>
        {draftErr && <div className="banner info small">{draftErr}</div>}
        {d.data.drafts.filter((a: any) => a.kind === "reply_draft").length === 0 && !draftErr && <p className="tiny muted">승인된 정책 문서만 근거로 초안을 만듭니다. 발송은 공급사 화면에서 직접 하세요.</p>}
        {d.data.drafts
          .filter((a: any) => a.kind === "reply_draft")
          .map((a: any) => (
            <div key={a.id} className="draft-box">
              <div className="label">고객 발송용 초안 · {a.status === "approved" ? "검토 완료" : "검토 전"}</div>
              <div className="small pre">{a.payload.body}</div>
              <div className="tiny muted" style={{ marginTop: 4 }}>
                근거 문서: {a.payload.knowledge_versions?.length ? a.payload.knowledge_versions.map((k: any) => `${k.kind} v${k.version}`).join(", ") : "승인 문서 없음"}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button
                  className="btn sm"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(a.payload.body).catch(() => {});
                    toast.show("복사했습니다. 공급사 상담 화면에 붙여넣어 발송하세요.");
                  }}
                >
                  복사
                </button>
                <button
                  className="btn sm primary"
                  onClick={async () => {
                    try {
                      await post(`/api/conversations/${id}/outbound`, { body: a.payload.body, approval_id: a.id });
                      await post(`/api/approvals/${a.id}/decision`, { decision: "approve" });
                      toast.show("고객 발송 목록에 올렸습니다(승인 대기).");
                      d.reload();
                    } catch (e: any) {
                      toast.show(e.message);
                    }
                  }}
                >
                  발송 목록에 올리기
                </button>
                <button className="btn sm ghost danger" onClick={async () => (await post(`/api/approvals/${a.id}/decision`, { decision: "discard" }), d.reload())}>
                  폐기
                </button>
              </div>
            </div>
          ))}
      </div>

      <OutboundPanel id={id} items={d.data.outbound ?? []} onChange={d.reload} />
      <TaskQuick conversationId={id} opportunityId={o?.id} me={me} />
      {toast.node}
    </div>
  );
}

function Field({ k, v, ev }: { k: string; v: any; ev?: any }) {
  return (
    <tr>
      <td className="muted nowrap">{k}</td>
      <td>
        {v ?? <span className="muted">미확인</span>}
        {ev && (
          <span className="tiny muted">
            {" "}
            · {ev.by === "user" ? "담당자 입력" : "AI 추출"}
            {ev.message_id && (
              <>
                {" "}
                <a href={`?m=${ev.message_id}`}>근거</a>
              </>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

function TaskQuick({ conversationId, opportunityId }: { conversationId: string; opportunityId?: string; me: any }) {
  const [title, setTitle] = useState("");
  const toast = useToast();
  return (
    <form
      className="card stack"
      style={{ padding: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await post("/api/tasks", { title, conversation_id: conversationId, opportunity_id: opportunityId ?? null });
        setTitle("");
        toast.show("할 일을 추가했습니다.");
      }}
    >
      <h3>다음 할 일</h3>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input placeholder="예: 내일 오전 견적 범위 재안내" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="할 일 제목" />
        <button className="btn">추가</button>
      </div>
      {toast.node}
    </form>
  );
}

const OUT_LABEL: Record<string, string> = {
  pending_approval: "승인 대기",
  queued: "발송 대기",
  sending: "전송 중",
  sent: "전송됨(공급사 확인)",
  failed: "실패",
  unknown: "확인 불가 — 재발송 전 상태 확인",
  sent_manually: "직접 발송함(기록)",
  cancelled: "취소",
  blocked_no_provider: "공급사 발송 미연동 — 직접 발송 필요",
};

function OutboundPanel({ id, items, onChange }: { id: string; items: any[]; onChange: () => void }) {
  const [body, setBody] = useState("");
  const toast = useToast();
  const act = async (oid: string, decision: string) => {
    try {
      await post(`/api/outbound/${oid}/decision`, { decision });
      onChange();
    } catch (e: any) {
      toast.show(e.message);
    }
  };
  return (
    <div className="card stack" style={{ padding: 12 }}>
      <h3>고객 발송</h3>
      <p className="tiny muted">대표 보고와 별개입니다. 수신자·본문·상태가 기록되며, 결과를 모르는 메시지는 자동으로 다시 보내지 않습니다.</p>
      {items.map((m) => (
        <div key={m.id} className="draft-box">
          <div className="label">
            {OUT_LABEL[m.status] ?? m.status} · {m.channel === "provider" ? "공급사" : "수동"} {m.sent_at && `· ${fmtDateTime(m.sent_at)}`}
          </div>
          <div className="small pre">{m.body}</div>
          {m.last_error && <div className="tiny muted">{m.last_error}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            {m.status === "pending_approval" && (
              <button className="btn sm primary" onClick={() => act(m.id, "approve")}>
                승인
              </button>
            )}
            {["pending_approval", "blocked_no_provider", "failed", "unknown"].includes(m.status) && (
              <button className="btn sm" onClick={async () => (await navigator.clipboard?.writeText(m.body).catch(() => {}), act(m.id, "sent_manually"))}>
                복사 후 직접 발송함
              </button>
            )}
            {m.status === "unknown" && (
              <button className="btn sm" onClick={() => act(m.id, "check_status")}>
                상태 확인
              </button>
            )}
            {m.status === "failed" && (
              <button className="btn sm" onClick={() => act(m.id, "retry")}>
                다시 보내기
              </button>
            )}
            {["pending_approval", "queued", "blocked_no_provider", "failed"].includes(m.status) && (
              <button className="btn sm ghost danger" onClick={() => act(m.id, "cancel")}>
                취소
              </button>
            )}
          </div>
        </div>
      ))}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          try {
            await post(`/api/conversations/${id}/outbound`, { body, client_key: `${Date.now()}` });
            setBody("");
            onChange();
          } catch (err: any) {
            toast.show(err.message);
          }
        }}
      >
        <textarea placeholder="고객에게 보낼 메시지 (승인 후 발송)" value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 60 }} aria-label="고객 발송 메시지" />
        <button className="btn sm" style={{ alignSelf: "flex-start" }}>
          발송 목록에 추가
        </button>
      </form>
      {toast.node}
    </div>
  );
}

function ManualConversation({ onDone }: { onDone: (id: string) => void }) {
  const [v, setV] = useState({ customer_name: "", phone: "", channel_label: "전화", text: "", test: false });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await post("/api/conversations/manual", { customer_name: v.customer_name, phone: v.phone || undefined, channel_label: v.channel_label, test: v.test, messages: [{ sender: "customer", text: v.text }] });
          onDone(r.conversationId);
        } catch (e: any) {
          setErr(e.message);
        }
      }}
    >
      <input placeholder="고객 이름/상호" value={v.customer_name} onChange={(e) => setV({ ...v, customer_name: e.target.value })} required />
      <input placeholder="연락처 (선택)" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
      <select value={v.channel_label} onChange={(e) => setV({ ...v, channel_label: e.target.value })} aria-label="유입 채널">
        <option>전화</option>
        <option>카카오(수동 입력)</option>
        <option>인스타그램 DM</option>
        <option>네이버</option>
        <option>소개</option>
        <option>기타</option>
      </select>
      <textarea placeholder="고객 문의 내용" value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} required />
      <label className="check">
        <input type="checkbox" checked={v.test} onChange={(e) => setV({ ...v, test: e.target.checked })} /> 테스트 수신 (실제 고객 데이터와 분리, 집계 제외)
      </label>
      {err && <div className="banner danger">{err}</div>}
      <button className="btn primary">등록</button>
    </form>
  );
}
