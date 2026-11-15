import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fileToBase64, patch, post, useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { fmtDate, fmtDateTime, fmtWon, kstLocalToIso, todayKst } from "../lib/format";
import { BackLink, Empty, ErrorBox, Loading, Modal, useToast } from "../components/common";
import { PACKAGES, PROJECT_STATUSES, PROJECT_STATUS_LABELS, WORK_TYPES } from "../../shared/domain";

const ORIGIN: Record<string, string> = { sheet: "시트", manual: "수동", test: "테스트", sample: "샘플", live: "연동" };
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00+09:00`).getTime() + n * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
const WD = ["일", "월", "화", "수", "목", "금", "토"];

export function Schedule() {
  const [sp, setSp] = useSearchParams();
  const from = sp.get("from") ?? todayKst();
  const span = Number(sp.get("span") ?? 14);
  const to = addDays(from, span - 1);
  const d = useApi<any>(`/api/schedule?from=${from}&to=${to}`, { tables: ["projects", "schedule_blocks"] });
  const unscheduled = useApi<any[]>(`/api/projects?status=unscheduled`, { tables: ["projects"] });
  const flagged = useApi<any[]>(`/api/projects?flagged=true`, { tables: ["projects"] });
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(from, i)), [from, span]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>일정 · 작업</h1>
          <p className="muted small">촬영·스타일링·시공·브랜딩 일정과 팀 일정을 한 곳에서. 시트에서 가져온 확인 필요 항목은 표시됩니다.</p>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => setSp({ from: addDays(from, -7), span: String(span) })}>
            ← 이전
          </button>
          <button className="btn sm" onClick={() => setSp({})}>
            오늘
          </button>
          <button className="btn sm" onClick={() => setSp({ from: addDays(from, 7), span: String(span) })}>
            다음 →
          </button>
          <Link to="/projects/new" className="btn primary sm">
            + 작업 등록
          </Link>
        </div>
      </div>
      {d.loading ? (
        <Loading />
      ) : d.error ? (
        <ErrorBox error={d.error} />
      ) : (
        <div className="card">
          {days.map((day) => {
            const ps = d.data.projects.filter((p: any) => String(p.scheduled_date).slice(0, 10) === day);
            const bs = d.data.blocks.filter((b: any) => String(b.date).slice(0, 10) === day);
            const dow = new Date(`${day}T00:00:00+09:00`).getUTCDay();
            const dowKst = new Date(new Date(`${day}T00:00:00+09:00`).getTime() + 9 * 3600000).getUTCDay();
            void dow;
            return (
              <div key={day} className={`day-row ${day === todayKst() ? "today" : ""}`}>
                <div className="day-label">
                  <b>{day.slice(5).replace("-", ".")}</b> <span className={dowKst === 0 ? "danger-text" : dowKst === 6 ? "navy-text" : "muted"}>{WD[dowKst]}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {ps.length === 0 && bs.length === 0 && <span className="tiny muted">-</span>}
                  {ps.map((p: any) => (
                    <Link key={p.id} to={`/projects/${p.id}`} className="sched-item">
                      <span className="nowrap">{p.start_time ?? p.time_raw ?? "시간 미정"}</span>
                      <span className="badge navy">{p.work_type ?? "구분 미정"}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                      {!p.address && <span className="badge danger">주소 미확인</span>}
                      {p.flags?.length > 0 && <span className="badge warn">확인 {p.flags.length}</span>}
                      <span className="badge">{PROJECT_STATUS_LABELS[p.status]}</span>
                    </Link>
                  ))}
                  {bs.map((b: any) => (
                    <div key={b.id} className="sched-item block">
                      <span className="badge">{b.kind === "personal" ? "개인" : "사업"}</span>
                      <span>
                        {b.person_label ? `${b.person_label}: ` : ""}
                        {b.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>날짜 미정 작업 ({unscheduled.data?.length ?? 0})</h2>
          {(unscheduled.data ?? []).map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item small">
              {p.title} <span className="badge">{ORIGIN[p.data_origin] ?? p.data_origin}</span>
            </Link>
          ))}
        </section>
        <section className="card">
          <h2>확인 필요 작업 ({flagged.data?.length ?? 0})</h2>
          <p className="tiny muted">시트에서 날짜·연락처·상태 해석이 불확실했던 작업입니다. 열어서 확인 후 수정하면 표시가 줄어듭니다.</p>
          {(flagged.data ?? []).slice(0, 30).map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item small">
              <span className="nowrap">{p.scheduled_date ? String(p.scheduled_date).slice(0, 10) : "날짜 없음"}</span> {p.title} <span className="badge warn">{p.flags.length}</span>
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}

export function ProjectNew() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { me } = useSession();
  const contacts = useApi<any[]>("/api/contacts", { poll: 0 });
  const [v, setV] = useState<any>({ title: "", contact_id: sp.get("contact") ?? "", work_type: "촬영", package: "", scheduled_date: "", start_time: "", address: "", agreed_amount: "", delivery_due: "", notes: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <BackLink to="/schedule" label="일정" />
      <h1 style={{ marginBottom: 12 }}>작업 등록</h1>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const body: any = {
              title: v.title,
              contact_id: v.contact_id || null,
              opportunity_id: sp.get("opportunity") || null,
              work_type: v.work_type || null,
              package: v.package || null,
              scheduled_date: v.scheduled_date || null,
              start_time: v.start_time || null,
              address: v.address || null,
              delivery_due: v.delivery_due || null,
              notes: v.notes || null,
            };
            if (v.agreed_amount !== "" && canDo(me, "view_finance")) body.agreed_amount = Number(v.agreed_amount);
            const p = await post("/api/projects", body);
            nav(`/projects/${p.id}`);
          } catch (e: any) {
            setErr(e.message);
          }
        }}
      >
        <label className="field">
          <span>작업명</span>
          <input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} required placeholder="예: 연남동 6룸 숙소 촬영" />
        </label>
        <label className="field">
          <span>고객</span>
          <select value={v.contact_id} onChange={(e) => setV({ ...v, contact_id: e.target.value })}>
            <option value="">선택 안 함</option>
            {(contacts.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            <span>구분</span>
            <select value={v.work_type} onChange={(e) => setV({ ...v, work_type: e.target.value })}>
              {WORK_TYPES.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>패키지</span>
            <select value={v.package} onChange={(e) => setV({ ...v, package: e.target.value })}>
              <option value="">미정</option>
              {PACKAGES.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>날짜</span>
            <input type="date" value={v.scheduled_date} onChange={(e) => setV({ ...v, scheduled_date: e.target.value })} />
          </label>
          <label className="field">
            <span>시작 시간</span>
            <input type="time" value={v.start_time} onChange={(e) => setV({ ...v, start_time: e.target.value })} />
          </label>
          <label className="field">
            <span>납품 기한</span>
            <input type="date" value={v.delivery_due} onChange={(e) => setV({ ...v, delivery_due: e.target.value })} />
          </label>
          {canDo(me, "view_finance") && (
            <label className="field">
              <span>확정 금액 (원)</span>
              <input type="number" min={0} value={v.agreed_amount} onChange={(e) => setV({ ...v, agreed_amount: e.target.value })} />
            </label>
          )}
        </div>
        <label className="field">
          <span>주소</span>
          <input value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
        </label>
        <label className="field">
          <span>특이사항</span>
          <textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </label>
        {err && <div className="banner danger">{err}</div>}
        <button className="btn primary">등록</button>
      </form>
    </>
  );
}

export function ProjectDetail() {
  const { id } = useParams();
  const { me } = useSession();
  const d = useApi<any>(`/api/projects/${id}`, { tables: ["projects", "payments", "costs", "attachments", "tasks"] });
  const [edit, setEdit] = useState<any>(null);
  const [modal, setModal] = useState<null | "payment" | "cost">(null);
  const toast = useToast();
  useEffect(() => {
    if (d.data && !edit) setEdit(null);
  }, [d.data]);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const p = d.data.project;
  const fin = d.data.financeVisible;
  const confirmedPaid = d.data.payments.filter((x: any) => x.status === "confirmed").reduce((a: number, x: any) => a + Number(x.amount ?? 0), 0);
  const save = async (body: any) => {
    try {
      await patch(`/api/projects/${p.id}`, { ...body, version: p.version });
      toast.show("저장했습니다.");
      setEdit(null);
      d.reload();
    } catch (e: any) {
      toast.show(e.message);
      d.reload();
    }
  };
  const checklist = (p.checklist ?? []) as any[];
  return (
    <>
      <BackLink to="/schedule" label="일정" />
      <div className="page-head">
        <div>
          <h1>{p.title}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="badge navy">{p.work_type ?? "구분 미정"}</span>
            {p.package && <span className="badge">{p.package}</span>}
            <span className="badge brass">{PROJECT_STATUS_LABELS[p.status]}</span>
            <span className="badge">{ORIGIN[p.data_origin] ?? p.data_origin}</span>
            {p.source_ref && <span className="tiny muted">원본 {p.source_ref}</span>}
          </div>
        </div>
        <div className="row">
          <select aria-label="상태 변경" value={p.status} onChange={(e) => save({ status: e.target.value })} style={{ width: "auto" }}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PROJECT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setEdit({ title: p.title, scheduled_date: p.scheduled_date ? String(p.scheduled_date).slice(0, 10) : "", start_time: p.start_time ?? "", address: p.address ?? "", delivery_due: p.delivery_due ? String(p.delivery_due).slice(0, 10) : "", agreed_amount: p.agreed_amount ?? "", notes: p.notes ?? "", work_type: p.work_type ?? "", package: p.package ?? "" })}>
            수정
          </button>
        </div>
      </div>
      {p.flags?.length > 0 && (
        <div className="banner warn">
          <div className="stack" style={{ gap: 2 }}>
            <b>확인 필요 ({p.flags.length})</b>
            {p.flags.map((f: string) => (
              <span key={f} className="small">
                · {d.data.flagLabels[f] ?? f}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-2">
        <section className="card">
          <h2>기본 정보</h2>
          <table className="t" style={{ marginTop: 8 }}>
            <tbody>
              <tr>
                <td className="muted">고객</td>
                <td>{d.data.contact ? <Link to={`/contacts/${d.data.contact.id}`}>{d.data.contact.display_name}</Link> : <span className="muted">미연결</span>}</td>
              </tr>
              <tr>
                <td className="muted">연락처</td>
                <td>{d.data.contact?.phone ?? d.data.contact?.email ?? <span className="muted">미확인</span>}</td>
              </tr>
              <tr>
                <td className="muted">날짜·시간</td>
                <td>
                  {p.scheduled_date ? fmtDate(p.scheduled_date) : "날짜 미정"} {p.start_time ?? (p.time_raw ? <span className="muted">(원문: {p.time_raw})</span> : "시간 미정")}
                </td>
              </tr>
              <tr>
                <td className="muted">주소</td>
                <td>{p.address ?? <span className="badge danger">미확인</span>}</td>
              </tr>
              <tr>
                <td className="muted">납품 기한</td>
                <td>
                  {p.delivery_due ? fmtDate(p.delivery_due) : "미정"} {p.delivered_at && `· 납품 ${fmtDateTime(p.delivered_at)}`} · 수정 {p.revision_count}회
                </td>
              </tr>
              <tr>
                <td className="muted">특이사항</td>
                <td className="pre small">{p.notes ?? "-"}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>정산</h2>
            {fin && (
              <div className="row">
                <button className="btn sm" onClick={() => setModal("payment")}>
                  입금 기록
                </button>
                <button className="btn sm" onClick={() => setModal("cost")}>
                  비용 기록
                </button>
              </div>
            )}
          </div>
          {!fin ? (
            <p className="small muted">금액 조회 권한이 없습니다.</p>
          ) : (
            <>
              <table className="t">
                <tbody>
                  <tr>
                    <td className="muted">시트/견적 단가</td>
                    <td>
                      {fmtWon(p.listed_price)} <span className="tiny muted">(확정 금액 아님)</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">확정 금액</td>
                    <td>{p.agreed_amount != null ? fmtWon(p.agreed_amount) : <span className="badge warn">미확정</span>}</td>
                  </tr>
                  <tr>
                    <td className="muted">확인된 입금</td>
                    <td>{fmtWon(confirmedPaid)}</td>
                  </tr>
                  <tr>
                    <td className="muted">미수금</td>
                    <td>{p.agreed_amount != null ? fmtWon(Number(p.agreed_amount) - confirmedPaid) : "확정 금액 입력 후 계산"}</td>
                  </tr>
                  <tr>
                    <td className="muted">증빙</td>
                    <td>{p.cash_receipt ?? "-"}</td>
                  </tr>
                </tbody>
              </table>
              {d.data.payments.map((x: any) => (
                <div key={x.id} className="list-item small">
                  <span className={`badge ${x.status === "confirmed" ? "ok" : "warn"}`}>{x.status === "confirmed" ? "확인 입금" : "확인 필요"}</span>
                  <span>{x.amount != null ? fmtWon(x.amount) : "금액 미기재"}</span>
                  <span className="muted">
                    {fmtDate(x.paid_at)} · {x.evidence}
                  </span>
                  {x.status === "claimed" && <ConfirmPayment payment={x} onDone={d.reload} />}
                </div>
              ))}
              {d.data.costs.map((c: any) => (
                <div key={c.id} className="list-item small">
                  <span className="badge">{c.category.startsWith("direct_") ? "직접비" : "간접비"}</span>
                  <span>{fmtWon(c.amount)}</span>
                  <span className="muted">
                    {c.payee ?? ""} {c.note ?? ""}
                  </span>
                </div>
              ))}
            </>
          )}
        </section>

        <section className="card">
          <h2>체크리스트</h2>
          {["pre", "post"].map((phase) => (
            <div key={phase} style={{ marginTop: 8 }}>
              <h3>{phase === "pre" ? "작업 전 준비" : "작업 후 납품·수정"}</h3>
              {checklist
                .filter((c) => c.phase === phase)
                .map((c) => (
                  <label key={c.id} className="check" style={{ padding: "4px 0" }}>
                    <input
                      type="checkbox"
                      checked={!!c.done}
                      style={{ width: 20, height: 20 }}
                      onChange={async (e) => {
                        await post(`/api/projects/${p.id}/checklist`, { item_id: c.id, done: e.target.checked });
                        d.reload();
                      }}
                    />
                    <span style={{ textDecoration: c.done ? "line-through" : undefined }}>{c.label}</span>
                    {c.done_at && <span className="tiny muted">{fmtDateTime(c.done_at)}</span>}
                  </label>
                ))}
            </div>
          ))}
          {checklist.length === 0 && (
            <button className="btn sm" onClick={async () => (await post(`/api/projects/${p.id}/checklist`, {}), d.reload())}>
              기본 체크리스트 만들기
            </button>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>자료 첨부</h2>
            <label className="btn sm">
              파일 올리기
              <input
                type="file"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 10 * 1024 * 1024) return toast.show("10MB 이하만 가능합니다.");
                  await post("/api/attachments", { project_id: p.id, filename: f.name, mime: f.type || "application/octet-stream", data_base64: await fileToBase64(f) });
                  d.reload();
                }}
              />
            </label>
          </div>
          {d.data.attachments.length === 0 ? (
            <Empty>첨부 없음 (계약서·견적서·현장 사진 등)</Empty>
          ) : (
            d.data.attachments.map((a: any) => (
              <div key={a.id} className="list-item small">
                <a href={`/api/attachments/${a.id}`}>{a.filename}</a>
                <span className="muted">{Math.round(a.size_bytes / 1024)}KB</span>
              </div>
            ))
          )}
          <h3 style={{ marginTop: 12 }}>관련 할 일</h3>
          {d.data.tasks.map((t: any) => (
            <div key={t.id} className="list-item small">
              <span className={`badge ${t.status === "done" ? "ok" : ""}`}>{t.status === "done" ? "완료" : "진행"}</span> {t.title}
            </div>
          ))}
          <QuickTask projectId={p.id} onDone={d.reload} />
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>변경 이력</h2>
        {d.data.activity.map((a: any, i: number) => (
          <div key={i} className="list-item small">
            <span className="nowrap muted">{fmtDateTime(a.created_at)}</span>
            <span>{a.actor_name ?? a.actor_type}</span>
            <span>{a.action}</span>
          </div>
        ))}
      </section>

      {edit && (
        <Modal title="작업 수정" onClose={() => setEdit(null)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const body: any = {
                title: edit.title,
                scheduled_date: edit.scheduled_date || null,
                start_time: edit.start_time || null,
                address: edit.address || null,
                delivery_due: edit.delivery_due || null,
                notes: edit.notes || null,
                work_type: edit.work_type || null,
                package: edit.package || null,
              };
              if (fin) body.agreed_amount = edit.agreed_amount === "" ? null : Number(edit.agreed_amount);
              save(body);
            }}
          >
            <label className="field">
              <span>작업명</span>
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>날짜</span>
                <input type="date" value={edit.scheduled_date} onChange={(e) => setEdit({ ...edit, scheduled_date: e.target.value })} />
              </label>
              <label className="field">
                <span>시간</span>
                <input type="time" value={edit.start_time} onChange={(e) => setEdit({ ...edit, start_time: e.target.value })} />
              </label>
              <label className="field">
                <span>구분</span>
                <select value={edit.work_type} onChange={(e) => setEdit({ ...edit, work_type: e.target.value })}>
                  <option value="">미정</option>
                  {WORK_TYPES.map((w) => (
                    <option key={w}>{w}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>패키지</span>
                <select value={edit.package} onChange={(e) => setEdit({ ...edit, package: e.target.value })}>
                  <option value="">미정</option>
                  {PACKAGES.map((w) => (
                    <option key={w}>{w}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>납품 기한</span>
                <input type="date" value={edit.delivery_due} onChange={(e) => setEdit({ ...edit, delivery_due: e.target.value })} />
              </label>
              {fin && (
                <label className="field">
                  <span>확정 금액 (원)</span>
                  <input type="number" min={0} value={edit.agreed_amount} onChange={(e) => setEdit({ ...edit, agreed_amount: e.target.value })} />
                </label>
              )}
            </div>
            <label className="field">
              <span>주소</span>
              <input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} />
            </label>
            <label className="field">
              <span>특이사항</span>
              <textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            </label>
            <button className="btn primary">저장</button>
          </form>
        </Modal>
      )}
      {modal && (
        <MoneyForm
          kind={modal}
          onClose={() => setModal(null)}
          onSave={async (b) => {
            try {
              await post(`/api/projects/${p.id}/${modal === "payment" ? "payments" : "costs"}`, b);
              setModal(null);
              d.reload();
            } catch (e: any) {
              toast.show(e.message);
            }
          }}
        />
      )}
      {toast.node}
    </>
  );
}

function ConfirmPayment({ payment, onDone }: { payment: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(payment.amount ?? "");
  const [date, setDate] = useState(new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16));
  const [ev, setEv] = useState("통장 입금 내역 확인");
  if (!open)
    return (
      <button className="btn sm" onClick={() => setOpen(true)}>
        입금 확인
      </button>
    );
  return (
    <Modal title="입금 확인 (금액·일자·근거)" onClose={() => setOpen(false)}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(`/api/payments/${payment.id}/confirm`, { amount: Number(amount), paid_at: kstLocalToIso(date), evidence: ev });
          setOpen(false);
          onDone();
        }}
      >
        <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} required aria-label="금액" />
        <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} required aria-label="입금 일시" />
        <input value={ev} onChange={(e) => setEv(e.target.value)} required aria-label="확인 근거" />
        <button className="btn primary">확인 입금으로 기록</button>
      </form>
    </Modal>
  );
}

function MoneyForm({ kind, onClose, onSave }: { kind: "payment" | "cost"; onClose: () => void; onSave: (b: any) => void }) {
  const [v, setV] = useState<any>({ amount: "", date: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16), status: "confirmed", kind: "deposit", evidence: "통장 입금 내역 확인", category: "direct_outsourcing", payee: "", note: "" });
  return (
    <Modal title={kind === "payment" ? "입금 기록" : "비용 기록"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (kind === "payment") onSave({ amount: v.amount === "" ? null : Number(v.amount), paid_at: kstLocalToIso(v.date), kind: v.kind, status: v.status, evidence: v.evidence });
          else onSave({ category: v.category, amount: Number(v.amount), incurred_at: kstLocalToIso(v.date), payee: v.payee || undefined, note: v.note || undefined });
        }}
      >
        {kind === "payment" ? (
          <>
            <select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} aria-label="입금 확인 여부">
              <option value="confirmed">확인된 입금 (통장 등으로 확인)</option>
              <option value="claimed">고객이 입금했다고 함 (미확인)</option>
            </select>
            <select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} aria-label="구분">
              <option value="deposit">계약금</option>
              <option value="balance">잔금</option>
              <option value="full">전액</option>
              <option value="refund">환불</option>
              <option value="other">기타</option>
            </select>
          </>
        ) : (
          <>
            <select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} aria-label="비용 구분">
              <option value="direct_outsourcing">직접비 - 외주(예: 협력 촬영·인력)</option>
              <option value="direct_material">직접비 - 재료/소품/자재</option>
              <option value="direct_other">직접비 - 기타(교통·주차 등)</option>
              <option value="internal_labor">내부 인건비 배분</option>
              <option value="fixed">고정비 배분</option>
            </select>
            <input placeholder="지급처 (예: 현욱)" value={v.payee} onChange={(e) => setV({ ...v, payee: e.target.value })} />
          </>
        )}
        <input type="number" placeholder="금액 (원)" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} required={kind === "cost" || v.status === "confirmed"} aria-label="금액" />
        <input type="datetime-local" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} required aria-label="일시" />
        {kind === "payment" ? <input placeholder="확인 근거" value={v.evidence} onChange={(e) => setV({ ...v, evidence: e.target.value })} /> : <input placeholder="메모" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />}
        <button className="btn primary">저장</button>
      </form>
    </Modal>
  );
}

function QuickTask({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [t, setT] = useState("");
  return (
    <form
      className="row"
      style={{ marginTop: 6, flexWrap: "nowrap" }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!t.trim()) return;
        await post("/api/tasks", { title: t, project_id: projectId });
        setT("");
        onDone();
      }}
    >
      <input placeholder="이 작업의 할 일 추가" value={t} onChange={(e) => setT(e.target.value)} aria-label="할 일" />
      <button className="btn">추가</button>
    </form>
  );
}
