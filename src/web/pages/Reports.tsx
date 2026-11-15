import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { daysAgoKst, fmtDate, fmtDateTime, todayKst } from "../lib/format";
import { BackLink, Empty, ErrorBox, Loading, useToast } from "../components/common";

export function Reports() {
  const list = useApi<any[]>("/api/reports", { poll: 30000 });
  const nav = useNavigate();
  const [from, setFrom] = useState(daysAgoKst(7));
  const [to, setTo] = useState(daysAgoKst(1));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>보고서</h1>
          <p className="muted small">정기 보고 일정은 설정 → 알림·보고에서 켭니다. 집계는 DB, 해석은 AI(연동 시).</p>
        </div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await post("/api/reports", { from, to });
              nav(`/reports/${r.id}`);
            } catch (err: any) {
              toast.show(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="date" aria-label="시작일" value={from} max={todayKst()} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} />
          <input type="date" aria-label="종료일" value={to} max={todayKst()} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} />
          <button className="btn primary" disabled={busy}>
            {busy ? "작성 중…" : "수시 보고 만들기"}
          </button>
        </form>
      </div>
      <div className="card">
        {list.loading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : list.data!.length === 0 ? (
          <Empty>저장된 보고서가 없습니다.</Empty>
        ) : (
          list.data!.map((r) => (
            <Link key={r.id} to={`/reports/${r.id}`} className="list-item">
              {r.status === "new" && <span className="badge brass">새 보고</span>}
              <div style={{ flex: 1 }}>
                <b>{r.title}</b>
                <div className="tiny muted">
                  대상 {r.target_count}건 · 동기화 {fmtDateTime(r.data_synced_at)} · 작성 {fmtDateTime(r.created_at)}
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
      {toast.node}
    </>
  );
}

export function ReportDetail() {
  const { id } = useParams();
  const r = useApi<any>(`/api/reports/${id}`, { poll: 0 });
  if (r.loading) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} />;
  const d = r.data;
  return (
    <>
      <BackLink to="/reports" label="보고서" />
      <div className="page-head">
        <div>
          <h1>{d.title}</h1>
          <p className="muted small">
            분석 기간 {fmtDate(d.period_start)} ~ {fmtDate(new Date(new Date(d.period_end).getTime() - 1).toISOString())} · 대상 {d.target_count}건 · 최신 동기화 {fmtDateTime(d.data_synced_at)}
          </p>
        </div>
        {d.status === "new" && (
          <button className="btn" onClick={async () => (await post(`/api/reports/${id}/reviewed`), r.reload())}>
            검토 완료
          </button>
        )}
      </div>
      {d.metrics?.sampleData && <div className="banner warn">샘플 데이터 / 카카오 미연동 — 실제 문의 분석 결과가 아닙니다.</div>}
      <div className="card">
        <div className="pre">{d.body}</div>
      </div>
      {d.next_actions?.length > 0 && (
        <div className="card">
          <h2>다음 행동</h2>
          <ul>
            {d.next_actions.map((a: any, i: number) => (
              <li key={i}>{a.title}</li>
            ))}
          </ul>
          <div className="row">
            <Link className="btn sm" to="/inbox?filter=awaiting">
              답변 대기 상담
            </Link>
            <Link className="btn sm" to="/pipeline?stage=quoted">
              견적 후 회신 대기
            </Link>
          </div>
        </div>
      )}
      <p className="tiny muted" style={{ marginTop: 10 }}>
        {d.run ? `해석 엔진: ${d.run.engine === "model" ? `모델 ${d.run.model} · ${d.run.prompt_version}` : "규칙"}` : "AI 해석 없음 (집계값만)"}
      </p>
    </>
  );
}
