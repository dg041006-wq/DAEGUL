import { Link } from "react-router-dom";
import { patch, useApi } from "../lib/api";
import { canDo, useSession } from "../lib/session";
import { fmtDateTime, fmtRelative, fmtWon } from "../lib/format";
import { StaffAvatar } from "../components/StaffAvatar";
import { DataBanner, Empty, ErrorBox, IntegrationBadge, Loading } from "../components/common";

const DECISION_LABEL: Record<string, string> = { stage_change: "단계 변경 제안", reply_draft: "답장 초안 검토", outbound: "고객 발송 승인/확인", ideas: "경영 제안 결정", sheet_review: "시트 가져오기 확인" };
const DECISION_LINK: Record<string, string> = { stage_change: "/pipeline", reply_draft: "/inbox", outbound: "/inbox?filter=all", ideas: "/ideas", sheet_review: "/settings?tab=sheet" };

export function Home() {
  const { me } = useSession();
  const home = useApi<any>("/api/home", { tables: ["conversations", "opportunities", "contracts"] });
  const today = useApi<any>("/api/today", { tables: ["tasks", "projects", "conversations", "messages", "approvals", "outbound_messages", "ideas", "reports", "payments"] });
  const roles = useApi<any>("/api/ai/roles", { tables: ["ai_messages", "reports"] });
  const feed = useApi<any[]>("/api/ai/feed?limit=8", { tables: ["ai_messages"] });
  if (home.loading || today.loading) return <Loading />;
  if (home.error) return <ErrorBox error={home.error} />;
  const d = home.data;
  const t = today.data;
  const owner = me?.role === "owner";
  const priorities: Array<{ label: string; sub?: string; link: string; tone: string }> = [
    ...(t.prepMissingTomorrow ?? []).map((p: any) => ({ label: `내일 작업 준비: ${p.display_name ?? p.title}`, sub: `${p.missing.join("·")} 미확인`, link: `/projects/${p.id}`, tone: "danger" })),
    ...(t.deliveryRisks ?? []).map((r: any) => ({ label: `납기 위험: ${r.title}`, sub: `납기 ${String(r.delivery_due).slice(0, 10)}`, link: `/projects/${r.id}`, tone: "danger" })),
    ...(t.awaiting ?? []).slice(0, 3).map((a: any) => ({ label: `답변 대기: ${a.display_name ?? "이름 미제공"}`, sub: `${fmtRelative(a.last_customer_message_at)}부터`, link: `/inbox/${a.id}`, tone: "warn" })),
    ...(t.tasks ?? []).filter((x: any) => x.due_at && new Date(x.due_at) < new Date()).slice(0, 4).map((x: any) => ({ label: x.title, sub: `마감 ${fmtDateTime(x.due_at)} 지남`, link: "/tasks", tone: "warn" })),
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>대표실</h1>
          <p className="muted small">
            {t.today} · {me?.user.name} {owner ? "대표님" : "님"}
          </p>
        </div>
        <div className="row small">
          {d.dataStatus.integrations
            .filter((i: any) => i.provider === "kakao_counsel" || i.status !== "not_connected")
            .map((i: any) => (
              <span key={i.provider} className="row" style={{ gap: 4 }}>
                <span className="muted">{i.provider === "kakao_counsel" ? "카카오 상담" : i.provider === "demo" ? "샘플" : i.provider}</span>
                <IntegrationBadge status={i.status} />
              </span>
            ))}
        </div>
      </div>
      <DataBanner ds={d.dataStatus} />
      {!d.ai.available && (
        <div className="banner info">
          <b className="nowrap">AI 규칙 모드</b>
          <span>{d.ai.message} 보고·알림·할 일 생성은 서버에서 계속 동작합니다.</span>
        </div>
      )}

      <section className="studio" aria-label="AI 직원">
        <div className="card-head">
          <h2>AI 직원</h2>
          <Link to="/staff/meeting" className="btn sm">
            세 담당 회의
          </Link>
        </div>
        <div className="staff-row">
          {(roles.data?.roles ?? []).map((r: any) => {
            const st = roles.data.status[r.role_key] ?? {};
            const last = (feed.data ?? []).find((m) => m.role_key === r.role_key);
            return (
              <Link key={r.role_key} to={`/staff/${r.role_key}`} className="staff-card">
                <StaffAvatar suit={r.suit_color} hair={r.appearance?.hair} accent={r.appearance?.accent} size={80} working={st.running} label={`${r.title} ${r.display_name}`} />
                <div className="who">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="name">{r.display_name}</span>
                    <span className="badge ai">AI</span>
                  </div>
                  <div className="title">{r.title}</div>
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {st.running && (
                      <span className="badge navy">
                        <span className="status-dot live" /> 요청 처리 중
                      </span>
                    )}
                    {st.newReports > 0 && <span className="badge brass">새 보고 {st.newReports}</span>}
                    {st.pendingReview > 0 && <span className="badge warn">검토 대기 {st.pendingReview}</span>}
                    {st.failedToday > 0 && <span className="badge danger">오늘 실패 {st.failedToday}</span>}
                    {st.dataGap && <span className="badge">{st.dataGap}</span>}
                  </div>
                  <div className="line muted">{last ? last.content.replace(/^\[테스트\] /, "").split("\n")[0] : "아직 보고가 없습니다."}</div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="card-head">
            <h2>오늘 우선순위</h2>
            <Link to="/tasks" className="small muted">
              할 일 전체
            </Link>
          </div>
          {priorities.length === 0 ? (
            <Empty>급한 일이 없습니다.</Empty>
          ) : (
            priorities.slice(0, 8).map((p, i) => (
              <Link key={i} to={p.link} className="list-item">
                <span className={`badge ${p.tone}`}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{p.label}</div>
                  {p.sub && <div className="tiny muted">{p.sub}</div>}
                </div>
              </Link>
            ))
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>결정이 필요한 일</h2>
          </div>
          {(t.decisions ?? []).length === 0 ? (
            <Empty>대표님 결정 대기 없음</Empty>
          ) : (
            t.decisions.map((x: any) => (
              <Link key={x.kind} to={DECISION_LINK[x.kind] ?? "/"} className="list-item">
                <span className="badge brass">{x.n}</span>
                <span>{DECISION_LABEL[x.kind] ?? x.kind}</span>
              </Link>
            ))
          )}
          <div className="grid grid-2" style={{ marginTop: 10 }}>
            <Link to="/inbox?filter=awaiting" className="kpi">
              <span className="l">답변 대기</span>
              <span className="v" style={{ color: t.awaiting.length ? "var(--danger)" : undefined }}>
                {t.awaiting.length}
              </span>
            </Link>
            <Link to="/pipeline?stage=quoted" className="kpi">
              <span className="l">견적 후 회신 대기</span>
              <span className="v">{t.quoteAwaiting}</span>
            </Link>
            {t.receivables && (
              <Link to="/settlement" className="kpi">
                <span className="l">미수금 확인</span>
                <span className="v">{t.receivables.count}</span>
                <span className="tiny muted">
                  {fmtWon(t.receivables.total)} · 금액 미확정 {t.receivables.unconfirmed}
                </span>
              </Link>
            )}
            <div className="kpi">
              <span className="l">오늘 신규 문의</span>
              <span className="v">{d.summary.newInquiries}</span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>마감 임박 · 오늘/내일 일정</h2>
            <Link to="/schedule" className="small muted">
              일정
            </Link>
          </div>
          {t.schedule.projects.length === 0 && t.tasks.length === 0 ? <Empty>오늘·내일 일정과 마감이 없습니다.</Empty> : null}
          {t.schedule.projects.map((p: any) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="list-item">
              <span className="badge navy">{String(p.scheduled_date).slice(5, 10)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  {p.start_time ?? p.time_raw ?? "시간 미정"} · {p.title}
                </div>
                <div className="tiny muted">
                  {p.work_type ?? "구분 미정"} {!p.address && <span className="badge danger">주소 미확인</span>}
                </div>
              </div>
            </Link>
          ))}
          {t.tasks.slice(0, 6).map((x: any) => (
            <div key={x.id} className="list-item">
              <input
                type="checkbox"
                aria-label={`${x.title} 완료`}
                style={{ width: 20, height: 20, marginTop: 2 }}
                onChange={async () => {
                  await patch(`/api/tasks/${x.id}`, { status: "done", version: x.version });
                  today.reload();
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{x.title}</div>
                <div className="tiny muted">
                  {x.assignee_name ?? "미배정"} · 마감 {fmtDateTime(x.due_at)}
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>최근 보고</h2>
            {canDo(me, "view_finance") && (
              <Link to="/reports" className="small muted">
                보고서
              </Link>
            )}
          </div>
          {t.reports.map((r: any) => (
            <Link key={r.id} to={`/reports/${r.id}`} className="list-item">
              {r.status === "new" && <span className="badge brass">새 보고</span>}
              {r.is_test && <span className="badge">테스트</span>}
              <div>
                <div>{r.title}</div>
                <div className="tiny muted">{fmtDateTime(r.created_at)}</div>
              </div>
            </Link>
          ))}
          {(feed.data ?? []).slice(0, 5).map((m) => (
            <Link key={m.id} to={`/staff/${m.role_key}`} className="list-item">
              <span className={`badge ${m.severity === "critical" ? "danger" : m.kind === "report" ? "brass" : "navy"}`}>{m.kind === "report" ? "보고" : m.kind === "action_result" ? "처리" : "알림"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.content.split("\n")[0]}</div>
                <div className="tiny muted">{fmtRelative(m.created_at)}</div>
              </div>
            </Link>
          ))}
          {!t.reports.length && !(feed.data ?? []).length && <Empty>아직 보고가 없습니다. 일일 보고는 매일 오후 7시, 주간 보고는 금요일 오후 7시 10분에 자동 생성됩니다.</Empty>}
        </section>
      </div>
    </>
  );
}
