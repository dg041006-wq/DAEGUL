import { useState } from "react";
import { useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { daysAgoKst, fmtDate, fmtMinutes, fmtWon, pct, todayKst } from "../lib/format";
import { DataBanner, Empty, ErrorBox, Loading } from "../components/common";
import { CERTAINTY_LABELS, LOSS_REASON_LABELS, MAIN_FUNNEL, STAGE_LABELS } from "../../shared/domain";

export function Analytics() {
  const { me } = useSession();
  const [from, setFrom] = useState(daysAgoKst(29));
  const [to, setTo] = useState(todayKst());
  const a = useApi<any>(`/api/analytics?from=${from}&to=${to}`, { poll: 60000 });
  const fin = useApi<any>(canDo(me, "view_finance") ? `/api/finance?from=${from}&to=${to}` : null, { poll: 60000 });
  const home = useApi<any>("/api/home", { poll: 0 });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>분석실</h1>
          <p className="muted small">집계는 DB 쿼리로 계산한 값입니다. 문의 건수 = 메시지 수가 아닌 '문의 기회' 수.</p>
        </div>
        <div className="row">
          <input type="date" aria-label="시작일" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} />
          <span className="muted">~</span>
          <input type="date" aria-label="종료일" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "auto" }} />
        </div>
      </div>
      <DataBanner ds={home.data?.dataStatus} />
      {a.loading ? <Loading /> : a.error ? <ErrorBox error={a.error} /> : <Body a={a.data} fin={fin.data} />}
    </>
  );
}

function Share({ n, d, label }: { n: number; d: number; label: string }) {
  return (
    <div className="card kpi">
      <span className="l">{label}</span>
      <span className="v">{d ? pct(n / d) : "-"}</span>
      <span className="tiny muted">
        {n} / {d}건
      </span>
    </div>
  );
}

function Body({ a, fin }: { a: any; fin: any }) {
  const c = a.counts;
  const funnel = Object.fromEntries(a.funnel.map((r: any) => [r.stage, Number(r.n)]));
  const maxF = Math.max(1, ...MAIN_FUNNEL.map((s) => funnel[s] ?? 0));
  const confirmed = a.loss.rows.filter((r: any) => r.certainty === "confirmed");
  const estimated = a.loss.rows.filter((r: any) => r.certainty === "estimated");
  const unknown = a.loss.rows.filter((r: any) => r.certainty === "unknown").reduce((s: number, r: any) => s + Number(r.n), 0) + a.loss.lostWithoutAssessment;
  return (
    <>
      <div className="grid grid-4">
        <div className="card kpi">
          <span className="l">유효 문의</span>
          <span className="v">{c.valid}</span>
          <span className="tiny muted">중복 제외 고객 {c.unique_contacts}명</span>
        </div>
        <div className="card kpi">
          <span className="l">별도 집계</span>
          <span className="v">{c.test + c.spam + c.existing_cs}</span>
          <span className="tiny muted">
            테스트 {c.test} · 스팸 {c.spam} · 기존 CS {c.existing_cs}
          </span>
        </div>
        <div className="card kpi">
          <span className="l">사람 첫 응답 (중앙값)</span>
          <span className="v">{fmtMinutes(a.firstResponse.medianBusinessMinutes)}</span>
          <span className="tiny muted">
            영업시간 기준 · 전체 경과 {fmtMinutes(a.firstResponse.medianTotalMinutes)} · 미응답 {a.firstResponse.noResponseCount}
          </span>
        </div>
        <div className="card kpi">
          <span className="l">후속 연락 누락</span>
          <span className="v">{a.overdueFollowups}</span>
          <span className="tiny muted">마감 지난 미완료 할 일</span>
        </div>
      </div>

      <h2 style={{ margin: "18px 0 8px" }}>확인 불가 비중 (항상 표시)</h2>
      <div className="grid grid-3">
        <Share label="서비스 미분류" n={a.unknownShares.unclassified} d={a.unknownShares.denominator} />
        <Share label="유입경로 미확인" n={a.unknownShares.sourceUnknown} d={a.unknownShares.denominator} />
        <Share label="이탈 사유 불명" n={a.unknownShares.lossReasonUnknown} d={a.unknownShares.denominator} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>서비스별 문의 / 전환</h2>
          {a.conversionByService.length === 0 ? (
            <Empty>기간 내 유효 문의가 없습니다.</Empty>
          ) : (
            <table className="t" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>서비스 (복수 선택 포함)</th>
                  <th>문의</th>
                  <th>계약</th>
                  <th>전환율</th>
                </tr>
              </thead>
              <tbody>
                {a.conversionByService.map((r: any) => (
                  <tr key={r.service}>
                    <td>{r.service}</td>
                    <td>{r.cohort}</td>
                    <td>{r.won}</td>
                    <td>{r.cohort ? pct(r.won / r.cohort) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="tiny muted" style={{ marginTop: 6 }}>한 문의가 여러 서비스를 포함하면 각 서비스에 모두 집계됩니다.</p>
        </section>

        <section className="card">
          <h2>단계별 전환 (기간 내 유입 집단)</h2>
          {MAIN_FUNNEL.map((s) => (
            <div key={s} className="funnel-row">
              <span>{STAGE_LABELS[s]}</span>
              <div className="bar">
                <span style={{ width: `${((funnel[s] ?? 0) / maxF) * 100}%` }} />
              </div>
              <span className="small" style={{ textAlign: "right" }}>
                {funnel[s] ?? 0}
              </span>
            </div>
          ))}
          <p className="small" style={{ marginTop: 8 }}>
            계약 전환율 <b>{pct(a.conversion.rate)}</b> ({a.conversion.won}/{a.conversion.cohort})
          </p>
          {a.conversion.note && <p className="tiny muted">{a.conversion.note}</p>}
        </section>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2>이탈 사유 — 확인 / 추정 / 사유 불명 분리</h2>
        <div className="grid grid-3" style={{ marginTop: 8 }}>
          {[
            ["confirmed", confirmed],
            ["estimated", estimated],
          ].map(([k, rows]: any) => (
            <div key={k}>
              <h3>{CERTAINTY_LABELS[k as "confirmed"]}</h3>
              {rows.length === 0 ? (
                <p className="small muted">없음</p>
              ) : (
                <table className="t">
                  <tbody>
                    {rows.map((r: any) => (
                      <tr key={r.reason_code}>
                        <td>{LOSS_REASON_LABELS[r.reason_code as keyof typeof LOSS_REASON_LABELS]}</td>
                        <td>{r.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
          <div>
            <h3>사유 불명</h3>
            <p className="small">
              {unknown}건 <span className="muted">(평가 없음 {a.loss.lostWithoutAssessment} 포함)</span>
            </p>
          </div>
        </div>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          견적 후 회신이 없는 건은 '견적 후 회신 대기'로 남으며 이 표에 포함되지 않습니다. 응대 지연과 이탈이 함께 있어도 원인으로 단정하지 않습니다.
        </p>
      </section>

      {fin && (
        <section className="card" style={{ marginTop: 14 }}>
          <h2>매출 · 손익 (입력된 자료 범위)</h2>
          <div className="grid grid-3" style={{ marginTop: 8 }}>
            <div className="kpi">
              <span className="l">계약 금액 (계약일 기준)</span>
              <span className="v" style={{ fontSize: "1.3rem" }}>{fmtWon(fin.contractAmountInPeriod)}</span>
            </div>
            <div className="kpi">
              <span className="l">실제 입금액 (입금일 기준)</span>
              <span className="v" style={{ fontSize: "1.3rem" }}>{fmtWon(fin.paymentsReceivedInPeriod)}</span>
            </div>
            <div className="kpi">
              <span className="l">견적 발송 (발송일 기준)</span>
              <span className="v" style={{ fontSize: "1.3rem" }}>{fmtWon(fin.quotesSentInPeriod.total)}</span>
              <span className="tiny muted">{fin.quotesSentInPeriod.count}건</span>
            </div>
          </div>
          {fin.contracts.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>계약일</th>
                    <th>서비스</th>
                    <th>계약 금액</th>
                    <th>입금</th>
                    <th>직접비</th>
                    <th>공헌이익(직접비 기준)</th>
                  </tr>
                </thead>
                <tbody>
                  {fin.contracts.map((k: any) => (
                    <tr key={k.id}>
                      <td className="nowrap">{fmtDate(k.signed_at)}</td>
                      <td className="small">{k.services?.join(", ") || "미분류"}</td>
                      <td>{fmtWon(k.amount)}</td>
                      <td>{fmtWon(k.paid)}</td>
                      <td>{k.cost_data_complete ? fmtWon(k.direct_cost) : <span className="badge warn">자료 불완전</span>}</td>
                      <td>{k.cost_data_complete ? `${fmtWon(k.contribution_after_direct)} (${pct(k.contribution_margin)})` : "계산 안 함"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ul className="tiny muted" style={{ paddingLeft: 18, marginTop: 8 }}>
            {fin.notes.map((n: string) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="tiny muted" style={{ marginTop: 12 }}>
        기간 {a.period.from} ~ {a.period.to} · 계산 시각 {new Date(a.computedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} · 광고비·노출·클릭 자료가 연결되지 않아 광고 수익률/획득 비용은 산출하지 않습니다.
      </p>
    </>
  );
}
