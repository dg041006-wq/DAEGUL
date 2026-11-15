import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fileToBase64, post, useApi } from "../lib/api";
import { useSession } from "../lib/session";
import { fmtDate, fmtDateTime, fmtWon } from "../lib/format";
import { BackLink, Empty, ErrorBox, Loading, Modal, useToast } from "../components/common";
import { PROJECT_STATUS_LABELS } from "../../shared/domain";
import { currentSubscription, enablePush, isIOS, isStandalone, pushSupported } from "../lib/pwa";

// ───── 고객 ─────
export function Contacts() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const list = useApi<any[]>(`/api/contacts${term ? `?q=${encodeURIComponent(term)}` : ""}`, { tables: ["contacts", "projects"] });
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>고객</h1>
          <p className="muted small">고객별 문의·견적·계약·작업·납품·정산 이력을 한 화면에서 봅니다.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          + 고객 등록
        </button>
      </div>
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q);
        }}
      >
        <input placeholder="이름·연락처로 찾기" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, width: "auto" }} />
        <button className="btn">검색</button>
      </form>
      <div className="card">
        {list.loading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : !list.data!.length ? (
          <Empty>고객이 없습니다.</Empty>
        ) : (
          list.data!.map((c) => (
            <Link key={c.id} to={`/contacts/${c.id}`} className="list-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{c.display_name ?? "이름 미제공"}</b>
                <div className="tiny muted">
                  작업 {c.projects} · 상담 {c.conversations}
                  {c.last_project_date && ` · 최근 작업 ${String(c.last_project_date).slice(0, 10)}`}
                  {Number(c.projects) >= 2 && <span className="badge brass" style={{ marginLeft: 4 }}>재의뢰</span>}
                </div>
              </div>
              <span className="badge">{{ sheet: "시트", manual: "수동", test: "테스트", sample: "샘플", live: "연동", import: "가져오기" }[c.data_origin as string] ?? c.data_origin}</span>
            </Link>
          ))
        )}
      </div>
      {adding && (
        <Modal title="고객 등록" onClose={() => setAdding(false)}>
          <ContactForm
            onSave={async (b) => {
              const r = await post("/api/contacts", b);
              nav(`/contacts/${r.id}`);
            }}
          />
        </Modal>
      )}
    </>
  );
}

function ContactForm({ onSave }: { onSave: (b: any) => void }) {
  const [v, setV] = useState({ display_name: "", phone: "", email: "", memo: "" });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ display_name: v.display_name, phone: v.phone || undefined, email: v.email || undefined, memo: v.memo || undefined });
      }}
    >
      <input placeholder="이름/상호" value={v.display_name} onChange={(e) => setV({ ...v, display_name: e.target.value })} required />
      <input placeholder="연락처" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
      <input placeholder="이메일" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
      <textarea placeholder="메모" value={v.memo} onChange={(e) => setV({ ...v, memo: e.target.value })} />
      <button className="btn primary">저장</button>
    </form>
  );
}

export function ContactDetail() {
  const { id } = useParams();
  const { me } = useSession();
  const nav = useNavigate();
  const d = useApi<any>(`/api/contacts/${id}`, { tables: ["contacts", "projects", "conversations", "payments", "attachments", "tasks"] });
  const toast = useToast();
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const c = d.data.contact;
  return (
    <>
      <BackLink to="/contacts" label="고객" />
      <div className="page-head">
        <div>
          <h1>{c.display_name ?? "이름 미제공"}</h1>
          <p className="muted small">
            {c.phone ?? "연락처 미확인"} {c.email && `· ${c.email}`}
          </p>
        </div>
        <div className="row">
          <Link className="btn primary" to={`/projects/new?contact=${c.id}`}>
            + 작업 등록
          </Link>
          {me?.role === "owner" && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!confirm("이 고객의 상담 원문·AI 요약·첨부·관련 할 일을 삭제하고, 작업·입금 기록은 금액만 남기고 비식별화합니다. 되돌릴 수 없습니다. 진행할까요?")) return;
                await post(`/api/contacts/${c.id}/erase`);
                toast.show("삭제했습니다.");
                nav("/contacts");
              }}
            >
              고객 정보 삭제
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-2">
        <section className="card">
          <h2>이력 (최신순)</h2>
          {d.data.timeline.length === 0 ? (
            <Empty>이력 없음</Empty>
          ) : (
            d.data.timeline.map((t: any, i: number) => (
              <Link key={i} to={t.link} className="list-item small">
                <span className="nowrap muted">{String(t.at).slice(0, 10)}</span>
                <span className="badge navy">{t.kind}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{t.label}</span>
              </Link>
            ))
          )}
        </section>
        <section className="card">
          <h2>작업 · 정산</h2>
          {d.data.projects.map((p: any) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item small">
              <span className="nowrap">{p.scheduled_date ? String(p.scheduled_date).slice(0, 10) : "날짜 미정"}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{p.title}</span>
              <span className="badge">{PROJECT_STATUS_LABELS[p.status]}</span>
              {d.data.financeVisible && <span className="nowrap">{p.agreed_amount != null ? `${fmtWon(p.agreed_amount)} / 입금 ${fmtWon(p.paid)}` : `단가 ${fmtWon(p.listed_price)}`}</span>}
            </Link>
          ))}
          <h3 style={{ marginTop: 12 }}>첨부</h3>
          {d.data.attachments.map((a: any) => (
            <div key={a.id} className="list-item small">
              <a href={`/api/attachments/${a.id}`}>{a.filename}</a>
            </div>
          ))}
          <label className="btn sm" style={{ marginTop: 6 }}>
            파일 올리기
            <input
              type="file"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) return toast.show("10MB 이하만 가능합니다.");
                await post("/api/attachments", { contact_id: c.id, filename: f.name, mime: f.type || "application/octet-stream", data_base64: await fileToBase64(f) });
                d.reload();
              }}
            />
          </label>
          <h3 style={{ marginTop: 12 }}>할 일</h3>
          {d.data.tasks.map((t: any) => (
            <div key={t.id} className="list-item small">
              <span className={`badge ${t.status === "done" ? "ok" : ""}`}>{t.status === "done" ? "완료" : "진행"}</span> {t.title} <span className="muted">{fmtDateTime(t.due_at)}</span>
            </div>
          ))}
          {c.memo && (
            <>
              <h3 style={{ marginTop: 12 }}>메모</h3>
              <p className="small pre">{c.memo}</p>
            </>
          )}
        </section>
      </div>
      {toast.node}
    </>
  );
}

// ───── 정산 ─────
export function Settlement() {
  const d = useApi<any>("/api/settlement", { tables: ["payments", "projects", "costs"] });
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const r = d.data.receivables;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>정산</h1>
          <p className="muted small">확인 입금과 확인 필요 입금, 시트 단가와 확정 금액을 섞지 않습니다.</p>
        </div>
      </div>
      <div className="grid grid-2">
        <section className="card">
          <h2>미수금 확인 대상 ({r.due.length})</h2>
          {r.due.length === 0 ? (
            <Empty>확정 금액 기준 미수금 없음</Empty>
          ) : (
            r.due.map((x: any) => (
              <Link key={x.id} to={`/projects/${x.id}`} className="list-item small">
                <span className="nowrap muted">{x.scheduled_date ? String(x.scheduled_date).slice(0, 10) : "-"}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{x.display_name ?? x.title}</span>
                <span className="nowrap">미수 {fmtWon(x.outstanding)}</span>
                {Number(x.claimed) > 0 && <span className="badge warn">입금 주장</span>}
              </Link>
            ))
          )}
        </section>
        <section className="card">
          <h2>확인 필요 입금 ({d.data.claims.length})</h2>
          <p className="tiny muted">고객이 입금했다고 알렸거나 시트에 '입금완료'로만 적힌 건입니다. 통장 확인 후 작업 화면에서 '입금 확인'을 누르세요.</p>
          {d.data.claims.slice(0, 40).map((x: any) => (
            <Link key={x.id} to={`/projects/${x.project_id}`} className="list-item small">
              <span className="nowrap muted">{fmtDate(x.paid_at)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{x.title}</span>
              <span>{x.amount != null ? fmtWon(x.amount) : "금액 미기재"}</span>
            </Link>
          ))}
        </section>
        <section className="card">
          <h2>월별 확인 입금</h2>
          <table className="t">
            <thead>
              <tr>
                <th>월</th>
                <th>확인 입금</th>
                <th>확인 필요</th>
              </tr>
            </thead>
            <tbody>
              {d.data.monthly.map((m: any) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td>{fmtWon(m.confirmed)}</td>
                  <td>{m.claimed}건</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>월별 작업 금액</h2>
          <table className="t">
            <thead>
              <tr>
                <th>월</th>
                <th>작업</th>
                <th>시트/견적 단가 합</th>
                <th>확정 금액 합</th>
              </tr>
            </thead>
            <tbody>
              {d.data.listedByMonth.map((m: any) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td>{m.jobs}</td>
                  <td>{fmtWon(m.listed)}</td>
                  <td>
                    {fmtWon(m.agreed)} {Number(m.unconfirmed) > 0 && <span className="tiny muted">(미확정 {m.unconfirmed})</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny muted" style={{ marginTop: 6 }}>금액 미확정 작업 {r.unconfirmedAmount.length}건 — 작업 화면에서 확정 금액을 입력하면 미수금·매출에 반영됩니다.</p>
        </section>
      </div>
      <ul className="tiny muted" style={{ paddingLeft: 18, marginTop: 10 }}>
        {d.data.notes.map((n: string) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  );
}

// ───── 경영 제안 ─────
export function Ideas() {
  const { me } = useSession();
  const d = useApi<any[]>("/api/ideas", { tables: ["ideas", "tasks"] });
  const members = useApi<any[]>("/api/members/brief", { poll: 0 });
  const [deciding, setDeciding] = useState<any>(null);
  const toast = useToast();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>경영 제안</h1>
          <p className="muted small">경영·전략 담당이 데이터에서 찾은 개선 기회입니다. 같은 제안은 반복하지 않으며 결정 이유를 기록합니다.</p>
        </div>
        {me?.role === "owner" && (
          <button className="btn" onClick={async () => toast.show(`새 제안 ${(await post("/api/ideas/run")).created.length}건`)}>
            지금 분석
          </button>
        )}
      </div>
      {d.loading ? (
        <Loading />
      ) : d.error ? (
        <ErrorBox error={d.error} />
      ) : !d.data!.length ? (
        <Empty>아직 제안이 없습니다. 근거 데이터가 쌓이면 일일 분석 때 제안합니다.</Empty>
      ) : (
        d.data!.map((i) => (
          <div key={i.id} className="card">
            <div className="row">
              <span className={`badge ${i.status === "adopted" ? "ok" : i.status === "rejected" ? "" : i.status === "held" ? "warn" : "brass"}`}>{{ proposed: "검토 대기", adopted: "채택", held: "보류", rejected: "기각" }[i.status as string]}</span>
              {i.is_hypothesis && <span className="badge">가설</span>}
              {i.importance === "high" && <span className="badge danger">중요</span>}
              <span className="badge navy">{i.category}</span>
              <span className="tiny muted">{fmtDateTime(i.created_at)}</span>
            </div>
            <h2 style={{ marginTop: 6 }}>{i.title}</h2>
            <table className="t" style={{ marginTop: 6 }}>
              <tbody>
                <tr>
                  <td className="muted nowrap">근거</td>
                  <td>{i.evidence}</td>
                </tr>
                <tr>
                  <td className="muted nowrap">기대 효과(예상)</td>
                  <td>{i.expected_effect}</td>
                </tr>
                <tr>
                  <td className="muted nowrap">필요 시간·비용</td>
                  <td>{i.effort}</td>
                </tr>
                <tr>
                  <td className="muted nowrap">첫 행동</td>
                  <td>{i.first_action}</td>
                </tr>
                {i.decision_reason && (
                  <tr>
                    <td className="muted nowrap">결정 이유</td>
                    <td>
                      {i.decision_reason} ({i.decided_by_name})
                    </td>
                  </tr>
                )}
                {i.success_metric && (
                  <tr>
                    <td className="muted nowrap">성과 기준</td>
                    <td>
                      {i.success_metric} {i.task_id && <Link to="/tasks">· 실행 할 일 {i.task_status === "done" ? "(완료)" : "(진행)"}</Link>}
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="muted nowrap">실제 성과</td>
                  <td>{i.actual_result ?? <span className="muted">아직 측정 전 (예상 효과와 구분)</span>}</td>
                </tr>
              </tbody>
            </table>
            {me?.role === "owner" && (
              <div className="row" style={{ marginTop: 8 }}>
                {i.status === "proposed" || i.status === "held" ? (
                  <>
                    <button className="btn sm primary" onClick={() => setDeciding({ idea: i, decision: "adopted" })}>
                      채택 → 할 일
                    </button>
                    <button className="btn sm" onClick={() => setDeciding({ idea: i, decision: "held" })}>
                      보류
                    </button>
                    <button className="btn sm ghost" onClick={() => setDeciding({ idea: i, decision: "rejected" })}>
                      기각
                    </button>
                  </>
                ) : i.status === "adopted" ? (
                  <button className="btn sm" onClick={() => setDeciding({ idea: i, decision: "adopted", resultOnly: true })}>
                    실제 성과 기록
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ))
      )}
      {deciding && (
        <Modal title={{ adopted: deciding.resultOnly ? "실제 성과 기록" : "채택 — 실행 할 일 만들기", held: "보류", rejected: "기각" }[deciding.decision as string] ?? ""} onClose={() => setDeciding(null)}>
          <DecideForm
            decision={deciding.decision}
            resultOnly={deciding.resultOnly}
            members={members.data ?? []}
            onSave={async (b) => {
              try {
                await post(`/api/ideas/${deciding.idea.id}/decision`, { decision: deciding.decision, ...b });
                setDeciding(null);
                d.reload();
              } catch (e: any) {
                toast.show(e.message);
              }
            }}
          />
        </Modal>
      )}
      {toast.node}
    </>
  );
}

function DecideForm({ decision, resultOnly, members, onSave }: { decision: string; resultOnly?: boolean; members: any[]; onSave: (b: any) => void }) {
  const [v, setV] = useState({ reason: resultOnly ? "성과 기록" : "", assignee: "", due: "", metric: "", result: "" });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          reason: v.reason,
          ...(decision === "adopted" && !resultOnly ? { assignee_user_id: v.assignee || undefined, due_at: v.due ? new Date(`${v.due}T18:00:00+09:00`).toISOString() : undefined, success_metric: v.metric } : {}),
          ...(resultOnly ? { actual_result: v.result } : {}),
        });
      }}
    >
      {!resultOnly && <input placeholder="결정 이유 (필수)" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} required />}
      {decision === "adopted" && !resultOnly && (
        <>
          <select value={v.assignee} onChange={(e) => setV({ ...v, assignee: e.target.value })} aria-label="담당자">
            <option value="">담당: 나</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input type="date" value={v.due} onChange={(e) => setV({ ...v, due: e.target.value })} required aria-label="기한" />
          <input placeholder="성과 기준 (예: 4주간 견적 후 회신율 확인)" value={v.metric} onChange={(e) => setV({ ...v, metric: e.target.value })} required />
        </>
      )}
      {resultOnly && <textarea placeholder="실제로 확인된 성과 (측정 기간·수치)" value={v.result} onChange={(e) => setV({ ...v, result: e.target.value })} required />}
      <button className="btn primary">저장</button>
    </form>
  );
}

// ───── 통합 검색 ─────
export function Search() {
  const [sp, setSp] = useSearchParams();
  const term = sp.get("q") ?? "";
  const [q, setQ] = useState(term);
  const d = useApi<any>(term ? `/api/search?q=${encodeURIComponent(term)}` : null, { poll: 0 });
  return (
    <>
      <div className="page-head">
        <h1>검색</h1>
      </div>
      <form
        className="row"
        style={{ marginBottom: 12, flexWrap: "nowrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          setSp({ q });
        }}
      >
        <input autoFocus placeholder="고객명·프로젝트·대화·보고서" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary">검색</button>
      </form>
      {term && d.loading && <Loading />}
      {d.data && (
        <div className="grid grid-2">
          <Section title="고객" items={d.data.contacts} render={(c: any) => <Link to={`/contacts/${c.id}`}>{c.display_name}</Link>} />
          <Section title="작업" items={d.data.projects} render={(p: any) => <Link to={`/projects/${p.id}`}>{p.scheduled_date ? String(p.scheduled_date).slice(0, 10) : ""} {p.title}</Link>} />
          <Section
            title="대화"
            items={d.data.messages}
            render={(m: any) => (
              <Link to={`/inbox/${m.conversation_id}?m=${m.id}`}>
                <b>{m.display_name ?? "고객"}</b> {m.snippet}
              </Link>
            )}
          />
          <Section title="보고서" items={d.data.reports} render={(r: any) => <Link to={`/reports/${r.id}`}>{r.title}</Link>} />
          <Section title="할 일" items={d.data.tasks} render={(t: any) => <Link to="/tasks">{t.title}</Link>} />
        </div>
      )}
    </>
  );
}
function Section({ title, items, render }: { title: string; items: any[]; render: (x: any) => any }) {
  return (
    <section className="card">
      <h2>
        {title} ({items.length})
      </h2>
      {items.length === 0 ? (
        <p className="small muted">결과 없음</p>
      ) : (
        items.map((x, i) => (
          <div key={i} className="list-item small">
            {render(x)}
          </div>
        ))
      )}
    </section>
  );
}

// ───── 앱 설치 · 알림 ─────
export function Install() {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [perm, setPerm] = useState<string>("Notification" in window ? Notification.permission : "unsupported");
  const vapid = useApi<any>("/api/push/vapid", { poll: 0 });
  useEffect(() => {
    currentSubscription().then((s) => setSubscribed(!!s));
  }, []);
  const standalone = isStandalone();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>앱 설치 · 알림</h1>
          <p className="muted small">앱스토어 없이 이 주소를 홈 화면/작업 표시줄에 설치해 앱처럼 사용합니다.</p>
        </div>
      </div>
      <div className="grid grid-2">
        <section className="card stack">
          <h2>현재 기기 상태</h2>
          <table className="t">
            <tbody>
              <tr>
                <td className="muted">앱으로 설치되어 실행 중</td>
                <td>{standalone ? <span className="badge ok">예</span> : <span className="badge warn">아니오 (브라우저에서 열림)</span>}</td>
              </tr>
              <tr>
                <td className="muted">웹 푸시 지원</td>
                <td>{pushSupported() ? <span className="badge ok">지원</span> : <span className="badge danger">미지원{isIOS() && !standalone ? " — 홈 화면 추가 후 가능" : ""}</span>}</td>
              </tr>
              <tr>
                <td className="muted">알림 권한</td>
                <td>{{ granted: <span className="badge ok">허용</span>, denied: <span className="badge danger">차단됨</span>, default: <span className="badge warn">아직 묻지 않음</span>, unsupported: <span className="badge">해당 없음</span> }[perm]}</td>
              </tr>
              <tr>
                <td className="muted">이 기기 푸시 구독</td>
                <td>{subscribed == null ? "확인 중" : subscribed ? <span className="badge ok">구독됨</span> : <span className="badge warn">미구독</span>}</td>
              </tr>
            </tbody>
          </table>
          <div className="row">
            <button
              className="btn primary"
              onClick={async () => {
                const r = await enablePush();
                setMsg(r.message);
                setPerm("Notification" in window ? Notification.permission : "unsupported");
                setSubscribed(!!(await currentSubscription()));
                vapid.reload();
              }}
            >
              이 기기에서 알림 켜기
            </button>
            <button
              className="btn"
              onClick={async () => {
                const r = await post("/api/push/test");
                setMsg({ sent: "테스트 푸시를 보냈습니다. 기기 알림을 확인하세요.", failed: `발송 실패: ${r.error ?? ""}`, no_subscription: "푸시를 구독한 기기가 없습니다. 먼저 알림을 켜세요." }[r.status as string] ?? r.status);
              }}
            >
              테스트 푸시 보내기
            </button>
          </div>
          {msg && <div className="banner info small">{msg}</div>}
          <p className="tiny muted">푸시가 안 되는 환경에서도 모든 보고와 알림 원문은 알림함과 AI 직원 보고방에 남습니다.</p>
          {vapid.data?.subscriptions?.length > 0 && (
            <>
              <h3>내 알림 기기</h3>
              {vapid.data.subscriptions.map((s: any) => (
                <div key={s.id} className="small list-item">
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.user_agent}</span>
                  <span className="muted">{s.last_success_at ? `최근 성공 ${fmtDateTime(s.last_success_at)}` : s.last_error ? `오류: ${s.last_error}` : "발송 기록 없음"}</span>
                  {s.disabled_at && <span className="badge">만료</span>}
                </div>
              ))}
            </>
          )}
        </section>
        <section className="card stack">
          <h2>설치 방법</h2>
          <h3>아이폰 (Safari, iOS 16.4 이상)</h3>
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Safari로 이 주소를 엽니다.</li>
            <li>아래 공유 버튼 → '홈 화면에 추가'.</li>
            <li>홈 화면의 STAYSCENE 아이콘으로 실행 → 로그인 → 이 화면에서 '알림 켜기' → 허용.</li>
          </ol>
          <h3>안드로이드 (Chrome)</h3>
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Chrome으로 이 주소를 엽니다.</li>
            <li>메뉴(⋮) → '앱 설치' 또는 '홈 화면에 추가'.</li>
            <li>앱 실행 → 로그인 → '알림 켜기' → 허용.</li>
          </ol>
          <h3>PC (Chrome / Edge)</h3>
          <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
            <li>주소창 오른쪽 설치 아이콘(⊕) 또는 메뉴 → '앱 설치'.</li>
            <li>실행 후 '알림 켜기'. 공용 PC에서는 사용 후 반드시 로그아웃하세요(이 기기 알림 구독과 캐시가 삭제됩니다).</li>
          </ol>
        </section>
      </div>
    </>
  );
}
