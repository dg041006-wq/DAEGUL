import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { BackLink, Empty, ErrorBox, Loading, useToast } from "../components/common";

export function Reports() {
  const list = useApi<any[]>("/api/reports", { poll: 30000 });
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>보고서</h1>
          <p className="muted small">일일 보고 매일 오후 7:00, 주간 보고 금요일 오후 7:10 (한국 시간) 서버에서 자동 생성. 테스트 실행 보고는 [테스트]로 분리됩니다.</p>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post("/api/reports/test-run", { kind: "daily" });
                nav(`/reports/${r.id}`);
              } catch (err: any) {
                toast.show(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            일일 보고 테스트 실행
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post("/api/reports/test-run", { kind: "weekly" });
                nav(`/reports/${r.id}`);
              } catch (err: any) {
                toast.show(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            주간 보고 테스트 실행
          </button>
        </div>
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
              {r.is_test && <span className="badge">테스트</span>}
              <span className="badge navy">{{ daily: "일일", weekly: "주간", adhoc: "수시" }[r.kind as string]}</span>
              <div style={{ flex: 1 }}>
                <b>{r.title}</b>
                <div className="tiny muted">
                  기준 시각 {fmtDateTime(r.cutoff_at ?? r.period_end)} · 대상 {r.target_count}건 · 작성 {fmtDateTime(r.created_at)}
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
            집계 구간 {fmtDateTime(d.period_start)} ~ {fmtDateTime(d.period_end)} · 데이터 기준 시각 {fmtDateTime(d.cutoff_at ?? d.period_end)} · 대상 {d.target_count}건 · 최신 수신 {fmtDateTime(d.data_synced_at)}
          </p>
        </div>
        {d.status === "new" && (
          <button className="btn" onClick={async () => (await post(`/api/reports/${id}/reviewed`), r.reload())}>
            검토 완료
          </button>
        )}
      </div>
      {d.is_test && <div className="banner info">테스트 실행 보고입니다. 운영 보고와 별도로 저장되며 일정 보고 중복 판단에 영향을 주지 않습니다.</div>}
      <div className="card">
        <div className="pre">{d.body}</div>
      </div>
      {d.next_actions?.length > 0 && (
        <div className="card">
          <h2>다음 행동</h2>
          <ul>
            {d.next_actions.map((a: any, i: number) => (
              <li key={i}>{a.link ? <Link to={a.link}>{a.title}</Link> : a.title}</li>
            ))}
          </ul>

        </div>
      )}
      <p className="tiny muted" style={{ marginTop: 10 }}>
        {d.run ? `해석 엔진: ${d.run.engine === "model" ? `모델 ${d.run.model} · ${d.run.prompt_version}` : "규칙"}` : "AI 해석 없음 (집계값만)"}
      </p>
    </>
  );
}
