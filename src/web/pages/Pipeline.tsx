import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { patch, post, useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { fmtDate, fmtDateTime, fmtWon, kstLocalToIso } from "../lib/format";
import { BackLink, CategoryBadge, Empty, ErrorBox, Loading, Modal, SampleTag, StageBadge, useToast } from "../components/common";
import { CATEGORIES, CATEGORY_LABELS, CERTAINTY_LABELS, LOSS_REASONS, LOSS_REASON_LABELS, MAIN_FUNNEL, SERVICE_TYPES, STAGES, STAGE_LABELS, type Stage } from "../../shared/domain";

export function Pipeline() {
  const [sp, setSp] = useSearchParams();
  const stage = sp.get("stage") ?? "";
  const list = useApi<any[]>(`/api/opportunities${stage ? `?stage=${stage}` : ""}`, { poll: 20000 });
  const counts = useApi<any[]>(`/api/opportunities`, { poll: 30000 });
  const byStage = (s: string) => (counts.data ?? []).filter((o) => o.stage === s && o.category === "valid").length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>고객 / 영업 현황</h1>
          <p className="muted small">고객 한 명이 여러 공간·프로젝트를 문의할 수 있어 고객과 문의 건을 분리해 관리합니다.</p>
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={`chip ${!stage ? "on" : ""}`} onClick={() => setSp({})}>
          전체
        </button>
        {[...MAIN_FUNNEL, "on_hold", "waiting_contact", "lost"].map((s) => (
          <button key={s} className={`chip ${stage === s ? "on" : ""}`} onClick={() => setSp({ stage: s })}>
            {STAGE_LABELS[s as Stage]} {byStage(s)}
          </button>
        ))}
      </div>
      <div className="card">
        {list.loading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : list.data!.length === 0 ? (
          <Empty>해당 단계의 문의 건이 없습니다.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>고객 / 건</th>
                  <th>서비스</th>
                  <th>단계</th>
                  <th>마지막 연락</th>
                  <th>다음 행동</th>
                </tr>
              </thead>
              <tbody>
                {list.data!.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/pipeline/${o.id}`}>
                        <b>{o.display_name ?? "이름 미제공"}</b>
                      </Link>
                      <div className="tiny muted">
                        {o.title ?? "제목 없음"} · 상담 {o.conversation_count}개 <SampleTag show={o.is_sample} />
                        {o.duplicate_of_candidate && <span className="badge warn">이전 건 있음</span>}
                      </div>
                    </td>
                    <td className="small">{o.services?.length ? o.services.join(", ") : <span className="muted">미분류</span>}</td>
                    <td>
                      <StageBadge stage={o.stage} /> <CategoryBadge category={o.category} />
                      {o.last_quote_at && o.stage === "quoted" && <div className="tiny muted">견적 {fmtDate(o.last_quote_at)}{o.last_quote_amount != null ? ` · ${fmtWon(o.last_quote_amount)}` : ""}</div>}
                    </td>
                    <td className="small nowrap">{fmtDateTime(o.last_contact_at)}</td>
                    <td className="small">{o.next_action ?? <span className="muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function OpportunityDetail() {
  const { id } = useParams();
  const { me } = useSession();
  const d = useApi<any>(`/api/opportunities/${id}`, { poll: 20000 });
  const [modal, setModal] = useState<null | "quote" | "contract" | "loss" | "merge" | "split" | "edit">(null);
  const toast = useToast();
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  const o = d.data.opportunity;
  const fin = d.data.financeVisible;
  const run = async (fn: () => Promise<any>, ok: string) => {
    try {
      await fn();
      toast.show(ok);
      setModal(null);
      d.reload();
    } catch (e: any) {
      toast.show(e.message);
    }
  };
  return (
    <>
      <BackLink to="/pipeline" label="영업 현황" />
      <div className="page-head">
        <div>
          <h1>{d.data.contact?.display_name ?? "이름 미제공 고객"} · {o.title ?? "문의 건"}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <StageBadge stage={o.stage} />
            <CategoryBadge category={o.category} />
            <SampleTag show={o.is_sample} />
            <span className="small muted">최초 문의 {fmtDateTime(o.opened_at)}</span>
          </div>
        </div>
        <div className="row">
          <select
            aria-label="단계 변경"
            style={{ width: "auto" }}
            value=""
            onChange={(e) => {
              const to = e.target.value;
              if (!to) return;
              if (to === "won") return setModal("contract");
              if (to === "lost") return setModal("loss");
              const reason = prompt(`'${STAGE_LABELS[to as Stage]}'(으)로 변경하는 이유`) ?? "";
              run(() => post(`/api/opportunities/${o.id}/stage`, { to, reason }), "단계를 변경했습니다.");
            }}
          >
            <option value="">단계 변경…</option>
            {STAGES.filter((s) => s !== o.stage).map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setModal("edit")}>
            정보 수정
          </button>
        </div>
      </div>

      {d.data.stageSuggestions.map((s: any) => (
        <div key={s.id} className="banner info">
          <span className="badge ai">AI</span>
          <span style={{ flex: 1 }}>
            단계 변경 제안: {STAGE_LABELS[s.payload.from as Stage]} → <b>{STAGE_LABELS[s.payload.to as Stage]}</b> — {s.payload.reason}
            <span className="tiny muted"> (제안일 뿐이며 승인 전에는 반영되지 않습니다)</span>
          </span>
          <button className="btn sm" onClick={() => run(() => post(`/api/approvals/${s.id}/decision`, { decision: "approve" }), "제안을 반영했습니다.")}>
            반영
          </button>
          <button className="btn sm ghost" onClick={() => run(() => post(`/api/approvals/${s.id}/decision`, { decision: "reject" }), "제안을 거절했습니다.")}>
            거절
          </button>
        </div>
      ))}

      <div className="grid grid-2">
        <section className="card">
          <h2>문의 정보</h2>
          <table className="t" style={{ marginTop: 8 }}>
            <tbody>
              {[
                ["서비스", o.services?.join(", ")],
                ["공간 유형", o.space_type],
                ["지역", o.region],
                ["규모", o.size_text ?? (o.room_count != null ? `객실 ${o.room_count}개` : null)],
                ["원하는 작업", o.desired_work],
                ["희망 일정", o.desired_schedule],
                ["고객이 밝힌 예산", o.stated_budget],
                ["견적 요청", o.quote_requested == null ? null : o.quote_requested ? "예" : "아니오"],
                ["유입경로", o.source_channel ? `${o.source_channel} (${o.source_evidence ?? "근거 미기재"})` : null],
                ["다음 행동", o.next_action],
              ].map(([k, v]) => (
                <tr key={k as string}>
                  <td className="muted nowrap">{k}</td>
                  <td>{v || <span className="muted">미확인</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>견적 · 계약</h2>
            {fin && (
              <div className="row">
                <button className="btn sm" onClick={() => setModal("quote")}>
                  견적 등록
                </button>
                <button className="btn sm" onClick={() => setModal("contract")}>
                  계약 등록
                </button>
              </div>
            )}
          </div>
          {!fin && <p className="tiny muted">금액 조회 권한이 없어 금액은 표시되지 않습니다.</p>}
          {d.data.quotes.length === 0 && d.data.contracts.length === 0 && <Empty>견적·계약 기록 없음</Empty>}
          {d.data.quotes.map((q: any) => (
            <div key={q.id} className="list-item small">
              <span className="badge brass">견적</span>
              <span>{fmtDate(q.sent_at)}</span>
              <span>{fin ? fmtWon(q.amount) : "금액 비공개"}</span>
              <span className="muted">{q.note}</span>
            </div>
          ))}
          {d.data.contracts.map((k: any) => (
            <div key={k.id} className="list-item small" style={{ flexDirection: "column" }}>
              <div className="row">
                <span className="badge ok">계약</span>
                <span>{fmtDate(k.signed_at)}</span>
                {fin && <span>{fmtWon(k.amount)}</span>}
                <span className="muted">경로: {k.channel}</span>
              </div>
              <div className="muted">근거: {k.evidence}</div>
              {fin && (
                <ContractMoney k={k} onDone={d.reload} />
              )}
            </div>
          ))}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>이탈 사유</h2>
            <button className="btn sm" onClick={() => setModal("loss")}>
              사유 기록
            </button>
          </div>
          {d.data.lossAssessments.length === 0 ? (
            <Empty>{o.stage === "quoted" ? "견적 후 회신 대기 — 이탈로 확정하지 않습니다." : "기록 없음"}</Empty>
          ) : (
            d.data.lossAssessments.map((l: any) => (
              <div key={l.id} className="list-item small" style={{ flexDirection: "column", opacity: l.superseded_at ? 0.55 : 1 }}>
                <div className="row">
                  <span className={`badge ${l.certainty === "confirmed" ? "danger" : l.certainty === "estimated" ? "warn" : ""}`}>{CERTAINTY_LABELS[l.certainty as keyof typeof CERTAINTY_LABELS]}</span>
                  <b>{LOSS_REASON_LABELS[l.reason_code as keyof typeof LOSS_REASON_LABELS]}</b>
                  {l.superseded_at && <span className="tiny muted">(이전 평가)</span>}
                </div>
                <div>근거: {l.evidence || "-"}</div>
                {l.evidence_message_ids?.length > 0 && (
                  <div className="row">
                    {l.evidence_message_ids.map((m: string) => (
                      <EvidenceLink key={m} messageId={m} />
                    ))}
                  </div>
                )}
                <div className="muted">
                  확인 주체: {l.confirmed_by_type === "customer" ? "고객 발화" : l.confirmed_by_type === "user" ? `담당자(${l.confirmed_by_name ?? ""})` : "AI"} · 분석 {fmtDateTime(l.analyzed_at)}
                </div>
                {l.alternative_explanations && <div className="muted">대안 해석: {l.alternative_explanations}</div>}
              </div>
            ))
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>연결된 상담 ({d.data.conversations.length})</h2>
            <div className="row">
              <button className="btn sm" onClick={() => setModal("merge")} disabled={!d.data.otherOpportunitiesOfContact.length}>
                합치기
              </button>
              <button className="btn sm" onClick={() => setModal("split")} disabled={d.data.conversations.length < 2}>
                분리
              </button>
            </div>
          </div>
          {d.data.conversations.map((c: any) => (
            <Link key={c.id} to={`/inbox/${c.id}`} className="list-item small">
              <span className={`badge ${c.status === "open" ? "ok" : ""}`}>{c.status === "open" ? "진행" : "종료"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  {fmtDateTime(c.opened_at)} 시작 · {c.link_reason === "auto_same_contact_active" ? "자동 연결(같은 고객 진행 건)" : c.link_reason === "merge" ? "합치기" : c.link_reason === "manual" ? "수동 연결" : "최초 상담"}
                </div>
                <div className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.ai_summary ?? "요약 없음"}
                </div>
              </div>
            </Link>
          ))}
          {d.data.otherOpportunitiesOfContact.length > 0 && (
            <p className="tiny muted" style={{ marginTop: 8 }}>
              같은 고객의 다른 문의 건 {d.data.otherOpportunitiesOfContact.length}개:{" "}
              {d.data.otherOpportunitiesOfContact.map((x: any) => (
                <Link key={x.id} to={`/pipeline/${x.id}`} style={{ marginRight: 6 }}>
                  {STAGE_LABELS[x.stage as Stage]}({fmtDate(x.opened_at)})
                </Link>
              ))}
            </p>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>변경 이력</h2>
        <div className="table-wrap">
          <table className="t" style={{ marginTop: 8 }}>
            <tbody>
              {d.data.stageEvents.map((e: any) => (
                <tr key={e.id}>
                  <td className="nowrap small">{fmtDateTime(e.occurred_at)}</td>
                  <td className="small">
                    {e.from_stage ? `${STAGE_LABELS[e.from_stage as Stage]} → ` : ""}
                    <b>{STAGE_LABELS[e.to_stage as Stage]}</b>
                  </td>
                  <td className="small muted">
                    {e.actor_type === "system" ? "시스템" : e.actor_type === "ai" ? `AI 제안 승인(${e.actor_name ?? ""})` : e.actor_name} · {e.reason}
                  </td>
                  <td>
                    {e.from_stage && !e.reverts_event_id && (
                      <button className="btn sm ghost" onClick={() => run(() => post(`/api/stage-events/${e.id}/revert`), "되돌렸습니다.")}>
                        되돌리기
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {d.data.mergeHistory.map((m: any) => (
                <tr key={m.id}>
                  <td className="nowrap small">{fmtDateTime(m.created_at)}</td>
                  <td className="small">
                    <b>{m.action === "merge" ? "합치기" : "분리"}</b>
                  </td>
                  <td className="small muted" colSpan={2}>
                    상담 {m.conversation_ids.length}개 · {m.reason || "사유 없음"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {modal === "edit" && <EditModal o={o} onClose={() => setModal(null)} onSave={(body) => run(() => patch(`/api/opportunities/${o.id}`, body), "저장했습니다.")} />}
      {modal === "quote" && (
        <MoneyModal
          title="견적 등록"
          fields={["amount", "date", "note"]}
          onClose={() => setModal(null)}
          onSave={(v) => run(() => post(`/api/opportunities/${o.id}/quotes`, { amount: v.amount, sent_at: v.date, note: v.note }), "견적을 등록했습니다.")}
        />
      )}
      {modal === "contract" && (
        <MoneyModal
          title="계약 등록 (계약 확정)"
          fields={["amount", "date", "channel", "evidence"]}
          onClose={() => setModal(null)}
          onSave={(v) => run(() => post(`/api/opportunities/${o.id}/contracts`, { amount: v.amount, signed_at: v.date, channel: v.channel, evidence: v.evidence }), "계약을 등록했습니다.")}
        />
      )}
      {modal === "loss" && <LossModal oppId={o.id} conversations={d.data.conversations} onClose={() => setModal(null)} onSave={(body) => run(() => post(`/api/opportunities/${o.id}/loss`, body), "이탈 사유를 기록했습니다.")} />}
      {modal === "merge" && (
        <Modal title="다른 문의 건과 합치기" onClose={() => setModal(null)}>
          <p className="small muted">이 건의 상담을 선택한 건으로 옮기고, 이 건은 '합쳐짐'으로 표시됩니다. 이력이 남습니다.</p>
          <MergeForm others={d.data.otherOpportunitiesOfContact} onSave={(target, reason) => run(() => post(`/api/opportunities/${o.id}/merge`, { target_id: target, reason }), "합쳤습니다.")} />
        </Modal>
      )}
      {modal === "split" && (
        <Modal title="상담 분리 → 새 문의 건" onClose={() => setModal(null)}>
          <SplitForm conversations={d.data.conversations} onSave={(ids, reason) => run(() => post(`/api/opportunities/${o.id}/split`, { conversation_ids: ids, reason }), "새 문의 건으로 분리했습니다.")} />
        </Modal>
      )}
      {toast.node}
      {!canDo(me, "view_finance") && null}
    </>
  );
}

function EvidenceLink({ messageId }: { messageId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <a
      href="#"
      className="tiny"
      onClick={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          const r = await (await import("../lib/api")).get(`/api/evidence/message/${messageId}`);
          location.href = `/inbox/${r.conversationId}?m=${r.messageId}`;
        } catch {
          alert("권한 범위 밖이거나 삭제된 메시지입니다.");
        } finally {
          setBusy(false);
        }
      }}
    >
      근거 메시지 보기
    </a>
  );
}

function ContractMoney({ k, onDone }: { k: any; onDone: () => void }) {
  const [open, setOpen] = useState<null | "pay" | "cost">(null);
  const paid = (k.payments ?? []).reduce((a: number, p: any) => a + Number(p.amount), 0);
  const direct = (k.costs ?? []).filter((c: any) => c.category.startsWith("direct_")).reduce((a: number, c: any) => a + Number(c.amount), 0);
  const hasDirect = (k.costs ?? []).some((c: any) => c.category.startsWith("direct_"));
  return (
    <div className="stack" style={{ gap: 4, marginTop: 4 }}>
      <div className="row tiny">
        <span>입금 {fmtWon(paid)}</span>
        <span>직접비 {hasDirect ? fmtWon(direct) : <span className="badge warn">자료 불완전</span>}</span>
        {hasDirect && k.amount != null && <span>공헌이익(직접비 기준, 순이익 아님) {fmtWon(k.amount - direct)}</span>}
      </div>
      <div className="row">
        <button className="btn sm" onClick={() => setOpen("pay")}>
          입금 기록
        </button>
        <button className="btn sm" onClick={() => setOpen("cost")}>
          원가 기록
        </button>
      </div>
      {open && (
        <MoneyModal
          title={open === "pay" ? "입금 기록" : "원가 기록"}
          fields={open === "pay" ? ["amount", "date", "note"] : ["costCategory", "amount", "date", "note"]}
          onClose={() => setOpen(null)}
          onSave={async (v) => {
            try {
              if (open === "pay") await post(`/api/contracts/${k.id}/payments`, { amount: v.amount, paid_at: v.date, note: v.note });
              else await post(`/api/contracts/${k.id}/costs`, { category: v.costCategory, amount: v.amount, incurred_at: v.date, note: v.note });
              setOpen(null);
              onDone();
            } catch (e: any) {
              alert(e.message);
            }
          }}
        />
      )}
    </div>
  );
}

function MoneyModal({ title, fields, onClose, onSave }: { title: string; fields: string[]; onClose: () => void; onSave: (v: any) => void }) {
  const now = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16);
  const [v, setV] = useState<any>({ amount: "", date: now, note: "", channel: "kakao", evidence: "", costCategory: "direct_material" });
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...v, amount: v.amount === "" ? null : Number(v.amount), date: kstLocalToIso(v.date), note: v.note || undefined });
        }}
      >
        {fields.includes("costCategory") && (
          <label className="field">
            <span>원가 구분</span>
            <select value={v.costCategory} onChange={(e) => setV({ ...v, costCategory: e.target.value })}>
              <option value="direct_material">직접비 - 재료/소품</option>
              <option value="direct_outsourcing">직접비 - 외주</option>
              <option value="direct_other">직접비 - 기타</option>
              <option value="internal_labor">내부 인건비 배분</option>
              <option value="fixed">고정비 배분</option>
            </select>
          </label>
        )}
        {fields.includes("amount") && (
          <label className="field">
            <span>금액 (원)</span>
            <input type="number" min={0} inputMode="numeric" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} required={!title.includes("견적") && !title.includes("계약")} />
          </label>
        )}
        {fields.includes("date") && (
          <label className="field">
            <span>날짜/시각 (KST)</span>
            <input type="datetime-local" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} required />
          </label>
        )}
        {fields.includes("channel") && (
          <label className="field">
            <span>계약 경로</span>
            <select value={v.channel} onChange={(e) => setV({ ...v, channel: e.target.value })}>
              <option value="kakao">카카오 상담</option>
              <option value="phone">전화</option>
              <option value="email">이메일</option>
              <option value="in_person">대면</option>
              <option value="other">기타</option>
            </select>
          </label>
        )}
        {fields.includes("evidence") && (
          <label className="field">
            <span>계약 근거 (필수)</span>
            <textarea value={v.evidence} onChange={(e) => setV({ ...v, evidence: e.target.value })} required placeholder="예: 11/14 전화 통화로 진행 확정, 계약서 서명본 보관" />
          </label>
        )}
        {fields.includes("note") && (
          <label className="field">
            <span>메모</span>
            <input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
          </label>
        )}
        <button className="btn primary">저장</button>
      </form>
    </Modal>
  );
}

function EditModal({ o, onClose, onSave }: { o: any; onClose: () => void; onSave: (b: any) => void }) {
  const [v, setV] = useState<any>({
    title: o.title ?? "",
    services: o.services ?? [],
    category: o.category,
    space_type: o.space_type ?? "",
    region: o.region ?? "",
    size_text: o.size_text ?? "",
    desired_work: o.desired_work ?? "",
    desired_schedule: o.desired_schedule ?? "",
    stated_budget: o.stated_budget ?? "",
    source_channel: o.source_channel ?? "",
    source_evidence: o.source_evidence ?? "",
    next_action: o.next_action ?? "",
  });
  const text = (k: string, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  return (
    <Modal title="문의 정보 수정" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const body: any = {};
          for (const [k, val] of Object.entries(v)) {
            if (JSON.stringify(val) === JSON.stringify(o[k] ?? (Array.isArray(val) ? [] : ""))) continue;
            body[k] = val === "" ? null : val;
          }
          onSave(body);
        }}
      >
        {text("title", "건 제목")}
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 9 }}>
          <legend className="small muted">서비스 유형 (복수 선택)</legend>
          <div className="row">
            {SERVICE_TYPES.map((s) => (
              <label key={s} className="check">
                <input type="checkbox" checked={v.services.includes(s)} onChange={(e) => setV({ ...v, services: e.target.checked ? [...v.services, s] : v.services.filter((x: string) => x !== s) })} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>집계 구분</span>
          <select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          {text("space_type", "공간 유형")}
          {text("region", "지역")}
          {text("size_text", "규모")}
          {text("desired_schedule", "희망 일정")}
          {text("stated_budget", "고객이 밝힌 예산")}
          {text("desired_work", "원하는 작업")}
          {text("source_channel", "유입경로")}
          {text("source_evidence", "유입경로 근거 (필수)")}
        </div>
        {text("next_action", "다음 행동")}
        <button className="btn primary">저장</button>
      </form>
    </Modal>
  );
}

function LossModal({ conversations, onClose, onSave }: { oppId: string; conversations: any[]; onClose: () => void; onSave: (b: any) => void }) {
  const [v, setV] = useState<any>({ reason_code: "unknown", certainty: "unknown", confirmed_by_type: "user", evidence: "", alternative_explanations: "", mark_lost: true, evidence_message_ids: [] });
  const [msgs, setMsgs] = useState<any[] | null>(null);
  const loadMsgs = async () => {
    const { get } = await import("../lib/api");
    const all: any[] = [];
    for (const c of conversations) {
      const d = await get(`/api/conversations/${c.id}`);
      all.push(...d.messages.filter((m: any) => m.sender_type === "customer"));
    }
    setMsgs(all);
  };
  return (
    <Modal title="이탈 사유 기록" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <div className="banner info small">견적 후 침묵은 '견적 후 회신 대기'입니다. 고객이 이유를 밝혔거나 담당자가 근거를 가진 경우에만 '확인'으로 기록하세요.</div>
        <div className="form-grid">
          <label className="field">
            <span>확실성</span>
            <select value={v.certainty} onChange={(e) => setV({ ...v, certainty: e.target.value, reason_code: e.target.value === "unknown" ? "unknown" : v.reason_code === "unknown" ? "price" : v.reason_code })}>
              <option value="confirmed">확인 — 고객 명시 또는 담당자 근거</option>
              <option value="estimated">추정 — 정황상 가능성</option>
              <option value="unknown">사유 불명</option>
            </select>
          </label>
          <label className="field">
            <span>사유</span>
            <select value={v.reason_code} disabled={v.certainty === "unknown"} onChange={(e) => setV({ ...v, reason_code: e.target.value })}>
              {LOSS_REASONS.filter((r) => (v.certainty === "unknown" ? r === "unknown" : r !== "unknown")).map((r) => (
                <option key={r} value={r}>
                  {LOSS_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>확인 주체</span>
            <select value={v.confirmed_by_type} onChange={(e) => setV({ ...v, confirmed_by_type: e.target.value })}>
              <option value="customer">고객이 직접 밝힘</option>
              <option value="user">담당자 판단/근거</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>근거</span>
          <textarea value={v.evidence} onChange={(e) => setV({ ...v, evidence: e.target.value })} />
        </label>
        <div className="stack">
          <button type="button" className="btn sm" onClick={loadMsgs}>
            고객 메시지에서 근거 선택
          </button>
          {msgs?.map((m) => (
            <label key={m.id} className="check small">
              <input
                type="checkbox"
                checked={v.evidence_message_ids.includes(m.id)}
                onChange={(e) => setV({ ...v, evidence_message_ids: e.target.checked ? [...v.evidence_message_ids, m.id] : v.evidence_message_ids.filter((x: string) => x !== m.id) })}
              />
              <span>
                {fmtDateTime(m.sent_at)} — {m.body}
              </span>
            </label>
          ))}
        </div>
        <label className="field">
          <span>대안 해석 (다른 가능성)</span>
          <textarea value={v.alternative_explanations} onChange={(e) => setV({ ...v, alternative_explanations: e.target.value })} placeholder="예: 응대 지연이 있었지만 원인으로 단정할 근거 없음" />
        </label>
        <label className="check">
          <input type="checkbox" checked={v.mark_lost} onChange={(e) => setV({ ...v, mark_lost: e.target.checked })} /> 단계를 '종료/이탈'로 변경
        </label>
        <button className="btn primary">기록</button>
      </form>
    </Modal>
  );
}

function MergeForm({ others, onSave }: { others: any[]; onSave: (target: string, reason: string) => void }) {
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const [reason, setReason] = useState("");
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), onSave(target, reason))}>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {STAGE_LABELS[o.stage as Stage]} · {o.services?.join(", ") || "미분류"} · {fmtDate(o.opened_at)}
          </option>
        ))}
      </select>
      <input placeholder="사유" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn primary">합치기</button>
    </form>
  );
}

function SplitForm({ conversations, onSave }: { conversations: any[]; onSave: (ids: string[], reason: string) => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  return (
    <form className="stack" onSubmit={(e) => (e.preventDefault(), onSave(ids, reason))}>
      <p className="small muted">다른 프로젝트에 해당하는 상담을 선택하세요. 최소 1개는 이 건에 남아야 합니다.</p>
      {conversations.map((c) => (
        <label key={c.id} className="check small">
          <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
          {fmtDateTime(c.opened_at)} · {c.ai_summary ?? "요약 없음"}
        </label>
      ))}
      <input placeholder="사유 (예: 2호점은 별도 프로젝트)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn primary" disabled={!ids.length || ids.length >= conversations.length}>
        분리
      </button>
    </form>
  );
}
