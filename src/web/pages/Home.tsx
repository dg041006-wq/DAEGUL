import { Link } from "react-router-dom";
import { patch, useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { fmtDateTime, fmtDate } from "../lib/format";
import { StaffAvatar } from "../components/StaffAvatar";
import { DataBanner, Empty, ErrorBox, IntegrationBadge, Loading } from "../components/common";

export function Home() {
  const { me } = useSession();
  const home = useApi<any>("/api/home", { poll: 20000 });
  const roles = useApi<any>("/api/ai/roles", { poll: 15000 });
  if (home.loading) return <Loading />;
  if (home.error) return <ErrorBox error={home.error} />;
  const d = home.data;
  const s = d.summary;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>대표실</h1>
          <p className="muted small">
            {fmtDate(new Date().toISOString())} · 안녕하세요, {me?.user.name}님
          </p>
        </div>
        <div className="row small">
          {d.dataStatus.integrations.map((i: any) => (
            <span key={i.provider} className="row" style={{ gap: 4 }}>
              <span className="muted">{i.provider === "kakao_counsel" ? "카카오 상담" : i.provider === "demo" ? "샘플 공급사" : i.provider}</span>
              <IntegrationBadge status={i.status} />
            </span>
          ))}
          <span className="muted">마지막 수신 {fmtDateTime(d.dataStatus.lastSyncAt)}</span>
        </div>
      </div>

      <DataBanner ds={d.dataStatus} />
      {!d.ai.available && (
        <div className="banner info">
          <b className="nowrap">AI 분석 대기</b>
          <span>{d.ai.message} AI 직원은 DB 집계 기반의 규칙 응답만 제공합니다.</span>
        </div>
      )}

      <section className="studio" aria-label="AI 직원">
        <div className="card-head">
          <h2>AI 직원</h2>
          <Link to="/staff/meeting" className="btn sm">
            세 팀장 회의 열기
          </Link>
        </div>
        <div className="staff-row">
          {(roles.data?.roles ?? []).map((r: any) => {
            const st = roles.data.status[r.role_key];
            return (
              <Link key={r.role_key} to={`/staff/${r.role_key}`} className="staff-card">
                <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} size={76} working={st?.running} label={`${r.title} ${r.display_name}`} />
                <div className="who">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="name">{r.display_name}</span>
                    <span className="badge ai">AI</span>
                  </div>
                  <div className="title">{r.title}</div>
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {st?.running && (
                      <span className="badge navy">
                        <span className="status-dot live" /> 분석 중
                      </span>
                    )}
                    {st?.newReports > 0 && <span className="badge brass">새 보고 {st.newReports}건</span>}
                    {st?.pendingReview > 0 && <span className="badge warn">검토 대기 {st.pendingReview}</span>}
                    {st?.dataGap && <span className="badge">자료 부족: {st.dataGap}</span>}
                  </div>
                  <div className="line muted">{st?.lastMessage ?? "대화를 시작하면 근거와 함께 보고합니다."}</div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid grid-4" style={{ marginTop: 14 }}>
        <Link to="/pipeline?stage=new" className="card kpi">
          <span className="l">오늘 신규 문의</span>
          <span className="v">{s.newInquiries}</span>
          <span className="tiny muted">유효 문의 기회 기준 · 별도 집계 {s.excludedInquiries}</span>
        </Link>
        <Link to="/inbox?filter=awaiting" className="card kpi">
          <span className="l">사람 답변 대기</span>
          <span className="v" style={{ color: s.awaitingHuman ? "var(--danger)" : undefined }}>
            {s.awaitingHuman}
          </span>
          <span className="tiny muted">자동 안내 제외, 실제 직원 답변 기준</span>
        </Link>
        <Link to="/pipeline?stage=quoted" className="card kpi">
          <span className="l">견적 후 회신 대기</span>
          <span className="v">{s.quoteAwaitingReply}</span>
          <span className="tiny muted">이탈로 확정하지 않음</span>
        </Link>
        <Link to="/pipeline?stage=won" className="card kpi">
          <span className="l">오늘 확인된 계약</span>
          <span className="v">{s.confirmedContracts}</span>
          <span className="tiny muted">담당자 등록 계약 기록 기준</span>
        </Link>
      </div>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="card-head">
            <h2>오늘 할 일</h2>
            <Link to="/tasks" className="small muted">
              전체 보기
            </Link>
          </div>
          {d.tasks.length === 0 ? (
            <Empty>열린 할 일이 없습니다.</Empty>
          ) : (
            d.tasks.map((t: any) => (
              <div key={t.id} className="list-item">
                <input
                  type="checkbox"
                  aria-label={`${t.title} 완료`}
                  checked={t.status === "done"}
                  style={{ width: 20, height: 20, marginTop: 2 }}
                  onChange={async (e) => {
                    await patch(`/api/tasks/${t.id}`, { status: e.target.checked ? "done" : "open" });
                    home.reload();
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ textDecoration: t.status === "done" ? "line-through" : undefined }}>
                    {t.conversation_id ? <Link to={`/inbox/${t.conversation_id}`}>{t.title}</Link> : t.opportunity_id ? <Link to={`/pipeline/${t.opportunity_id}`}>{t.title}</Link> : t.title}
                  </div>
                  <div className="tiny muted">
                    {t.assignee_name ?? "미배정"} · 마감 {fmtDateTime(t.due_at)} {t.source !== "manual" && <span className="badge">{t.source === "system" ? "자동 생성" : "AI 제안"}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <h2>연동 및 데이터 범위</h2>
            {me?.role === "owner" && (
              <Link to="/settings?tab=integrations" className="small muted">
                연동 설정
              </Link>
            )}
          </div>
          <table className="t">
            <tbody>
              <tr>
                <td className="muted">카카오 상담 공식 연동</td>
                <td>{d.dataStatus.kakaoVerified ? <span className="badge ok">검증 완료</span> : <span className="badge danger">미연동 · 검증 전</span>}</td>
              </tr>
              <tr>
                <td className="muted">현재 데이터</td>
                <td>{d.dataStatus.usingSampleData ? "샘플 데이터 포함" : "수신/가져온 기록만"}</td>
              </tr>
              <tr>
                <td className="muted">분석 가능 시작 시점</td>
                <td>{fmtDateTime(d.dataStatus.firstMessageAt)} 이후 (이전 이력 없음)</td>
              </tr>
              <tr>
                <td className="muted">마지막 동기화</td>
                <td>{fmtDateTime(d.dataStatus.lastSyncAt)}</td>
              </tr>
              {d.dataStatus.failedEvents ? (
                <tr>
                  <td className="muted">처리 실패 이벤트</td>
                  <td>
                    <span className="badge danger">{d.dataStatus.failedEvents}건</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {!canDo(me, "view_analytics") && <p className="tiny muted" style={{ marginTop: 8 }}>본인 권한 범위의 지표만 표시됩니다.</p>}
        </section>
      </div>
    </>
  );
}
