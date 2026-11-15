import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { del, patch, post, useApi } from "../lib/api";
import { useSession } from "../lib/session";
import { fmtDateTime } from "../lib/format";
import { Empty, ErrorBox, IntegrationBadge, Loading, useToast } from "../components/common";
import { StaffAvatar } from "../components/StaffAvatar";
import { KNOWLEDGE_KINDS, STAFF_PERMS, STAFF_PERM_LABELS } from "../../shared/domain";
import { ActivityLog, AlertSettings, AutoReplies, SheetImport } from "./SettingsExtra";

const TABS = [
  ["members", "구성원·권한"],
  ["sheet", "시트 가져오기"],
  ["alerts", "보고·알림·푸시"],
  ["ops", "영업시간"],
  ["autoreply", "자동응답"],
  ["activity", "활동 이력"],
  ["knowledge", "승인 자료"],
  ["staff", "AI 직원"],
  ["integrations", "연동 상태"],
  ["ai", "AI 비용"],
  ["data", "데이터 보관"],
  ["audit", "감사 로그"],
] as const;

export function Settings() {
  const { me } = useSession();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "members";
  if (me?.role !== "owner")
    return (
      <>
        <div className="page-head">
          <h1>설정</h1>
        </div>
        <div className="card stack">
          <p className="small">설정 변경은 대표만 할 수 있습니다.</p>
          <p className="small muted">
            내 권한: {STAFF_PERMS.filter((p) => me?.perms?.[p]).map((p) => STAFF_PERM_LABELS[p]).join(", ") || "기본(배정 상담·할 일)"}
          </p>
          <button className="btn" onClick={() => post(`/api/members/${me?.user.id}/sessions/revoke`).then(() => location.reload())}>
            모든 기기에서 로그아웃
          </button>
        </div>
      </>
    );
  return (
    <>
      <div className="page-head">
        <h1>설정</h1>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setSp({ tab: k })} role="tab" aria-selected={tab === k}>
            {l}
          </button>
        ))}
      </div>
      {tab === "members" && <Members />}
      {tab === "ops" && <Ops />}
      {tab === "sheet" && <SheetImport />}
      {tab === "alerts" && <AlertSettings />}
      {tab === "autoreply" && <AutoReplies />}
      {tab === "activity" && <ActivityLog />}
      {tab === "knowledge" && <Knowledge />}
      {tab === "staff" && <StaffSettings />}
      {tab === "integrations" && <Integrations />}
      {tab === "ai" && <AiUsage />}
      {tab === "data" && <DataRetention />}
      {tab === "audit" && <Audit />}
    </>
  );
}

function Members() {
  const { me } = useSession();
  const d = useApi<any>("/api/members", { poll: 0 });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const [invite, setInvite] = useState<string | null>(null);
  const toast = useToast();
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post("/api/invitations", { email, role, perms });
            setInvite(r.inviteUrl);
            setEmail("");
            d.reload();
          } catch (err: any) {
            toast.show(err.message);
          }
        }}
      >
        <h2>구성원 초대</h2>
        <div className="form-grid">
          <label className="field">
            <span>이메일</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>역할</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="staff">직원</option>
              <option value="owner">대표(전체 권한)</option>
            </select>
          </label>
        </div>
        {role === "staff" && (
          <div className="row">
            {STAFF_PERMS.map((p) => (
              <label key={p} className="check">
                <input type="checkbox" checked={!!perms[p]} onChange={(e) => setPerms({ ...perms, [p]: e.target.checked })} />
                {STAFF_PERM_LABELS[p]}
              </label>
            ))}
          </div>
        )}
        <button className="btn primary" style={{ alignSelf: "flex-start" }}>
          초대 링크 만들기
        </button>
        {invite && (
          <div className="banner info">
            <div className="stack" style={{ width: "100%" }}>
              <span className="small">아래 링크를 직접 전달하세요. 이 화면을 벗어나면 다시 볼 수 없습니다(7일 유효).</span>
              <input readOnly value={invite} onFocus={(e) => e.target.select()} />
            </div>
          </div>
        )}
      </form>
      <div className="card">
        <h2>구성원</h2>
        <div className="table-wrap">
          <table className="t" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>이름</th>
                <th>역할</th>
                <th>추가 권한</th>
                <th>최근 접속</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {d.data.members.map((m: any) => (
                <tr key={m.id} style={{ opacity: m.status === "revoked" ? 0.5 : 1 }}>
                  <td>
                    {m.name}
                    <div className="tiny muted">{m.email}</div>
                  </td>
                  <td>{m.role === "owner" ? "대표" : "직원"}</td>
                  <td>
                    {m.role === "staff" && m.status === "active" ? (
                      <div className="stack" style={{ gap: 2 }}>
                        {STAFF_PERMS.map((p) => (
                          <label key={p} className="check small">
                            <input
                              type="checkbox"
                              checked={!!m.perms?.[p]}
                              onChange={async (e) => {
                                await patch(`/api/members/${m.id}`, { perms: { ...m.perms, [p]: e.target.checked } });
                                d.reload();
                              }}
                            />
                            {STAFF_PERM_LABELS[p]}
                          </label>
                        ))}
                      </div>
                    ) : m.role === "owner" ? (
                      <span className="small muted">전체</span>
                    ) : (
                      <span className="badge">회수됨</span>
                    )}
                  </td>
                  <td className="small nowrap">{fmtDateTime(m.last_seen_at)}</td>
                  <td>
                    {m.id !== me?.user.id && m.status === "active" && (
                      <div className="stack" style={{ gap: 4 }}>
                        <button className="btn sm" onClick={async () => (await post(`/api/members/${m.id}/sessions/revoke`), toast.show("세션을 종료했습니다."))}>
                          세션 종료
                        </button>
                        <button
                          className="btn sm danger"
                          onClick={async () => {
                            if (!confirm(`${m.name} 계정을 회수할까요? 즉시 로그아웃됩니다.`)) return;
                            await post(`/api/members/${m.id}/revoke`);
                            d.reload();
                          }}
                        >
                          계정 회수
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 style={{ marginTop: 14 }}>초대 내역</h3>
        {d.data.invitations.length === 0 ? (
          <Empty>초대 내역 없음</Empty>
        ) : (
          d.data.invitations.map((i: any) => (
            <div key={i.id} className="list-item small">
              <span>{i.email}</span>
              <span className="muted">{i.role === "owner" ? "대표" : "직원"}</span>
              <span className="spacer" />
              {i.accepted_at ? <span className="badge ok">수락</span> : i.revoked_at ? <span className="badge">취소</span> : new Date(i.expires_at) < new Date() ? <span className="badge">만료</span> : (
                <button className="btn sm ghost" onClick={async () => (await del(`/api/invitations/${i.id}`), d.reload())}>
                  취소
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {toast.node}
    </>
  );
}

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

function Ops() {
  const s = useApi<any>("/api/settings", { poll: 0 });
  const [v, setV] = useState<any>(null);
  const toast = useToast();
  useEffect(() => {
    if (s.data) setV(s.data);
  }, [s.data]);
  if (!v) return <Loading />;
  const save = async () => {
    try {
      const { businessHours, replyAlertMinutes, quoteFollowupBusinessDays } = v;
      await patch("/api/settings", { businessHours, replyAlertMinutes, quoteFollowupBusinessDays });
      toast.show("저장했습니다.");
    } catch (e: any) {
      toast.show(e.message);
    }
  };
  return (
    <div className="card stack">
      <h2>영업시간 (KST)</h2>
      <div className="row">
        {DAYS.map((d, i) => (
          <label key={i} className="check">
            <input
              type="checkbox"
              checked={v.businessHours.days.includes(i)}
              onChange={(e) => setV({ ...v, businessHours: { ...v.businessHours, days: e.target.checked ? [...v.businessHours.days, i].sort() : v.businessHours.days.filter((x: number) => x !== i) } })}
            />
            {d}
          </label>
        ))}
      </div>
      <div className="form-grid">
        <label className="field">
          <span>시작</span>
          <input type="time" value={v.businessHours.start} onChange={(e) => setV({ ...v, businessHours: { ...v.businessHours, start: e.target.value } })} />
        </label>
        <label className="field">
          <span>종료</span>
          <input type="time" value={v.businessHours.end} onChange={(e) => setV({ ...v, businessHours: { ...v.businessHours, end: e.target.value } })} />
        </label>
      </div>
      <h2 style={{ marginTop: 10 }}>알림 기준 (제안값 — 자유롭게 변경)</h2>
      <div className="form-grid">
        <label className="field">
          <span>답변 대기 알림 (영업시간 기준 분)</span>
          <input type="number" min={5} value={v.replyAlertMinutes} onChange={(e) => setV({ ...v, replyAlertMinutes: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>견적 후 후속 확인 (영업일)</span>
          <input type="number" min={1} value={v.quoteFollowupBusinessDays} onChange={(e) => setV({ ...v, quoteFollowupBusinessDays: Number(e.target.value) })} />
          <span className="tiny">기준 경과 시 '후속 확인' 할 일만 생성합니다. 이탈로 자동 확정하지 않습니다.</span>
        </label>
      </div>

      <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={save}>
        저장
      </button>
      {toast.node}
    </div>
  );
}

function Knowledge() {
  const list = useApi<any[]>("/api/knowledge", { poll: 0 });
  const [kind, setKind] = useState("price_list");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const toast = useToast();
  return (
    <>
      <div className="banner info small">답변 초안은 대표가 승인한 최신 버전만 근거로 사용합니다. 과거 대화의 가격·할인율은 현재 정책으로 쓰지 않습니다. 실제 가격·정책은 직접 입력하세요(임의로 채우지 않음).</div>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          await post("/api/knowledge", { kind, title, content });
          setTitle("");
          setContent("");
          list.reload();
          toast.show("새 버전을 초안으로 저장했습니다. 승인해야 사용됩니다.");
        }}
      >
        <h2>새 버전 작성</h2>
        <div className="form-grid">
          <label className="field">
            <span>종류</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KNOWLEDGE_KINDS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>제목</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span>내용</span>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} required style={{ minHeight: 140 }} />
        </label>
        <button className="btn primary" style={{ alignSelf: "flex-start" }}>
          초안 저장
        </button>
      </form>
      <div className="card">
        {!list.data?.length ? (
          <Empty>등록된 자료가 없습니다.</Empty>
        ) : (
          list.data.map((k) => (
            <details key={k.id} className="list-item" style={{ display: "block" }}>
              <summary className="row" style={{ cursor: "pointer" }}>
                <b>{KNOWLEDGE_KINDS[k.kind as keyof typeof KNOWLEDGE_KINDS]}</b> v{k.version} · {k.title}
                <span className={`badge ${k.status === "approved" ? "ok" : k.status === "draft" ? "warn" : ""}`}>{{ approved: "승인(사용 중)", draft: "초안", archived: "보관" }[k.status as string]}</span>
                {k.approved_at && <span className="tiny muted">승인 {fmtDateTime(k.approved_at)}</span>}
              </summary>
              <div className="pre small" style={{ marginTop: 6 }}>
                {k.content}
              </div>
              {k.status === "draft" && (
                <button className="btn sm primary" style={{ marginTop: 6 }} onClick={async () => (await post(`/api/knowledge/${k.id}/approve`), list.reload())}>
                  승인 (이전 승인본은 보관)
                </button>
              )}
            </details>
          ))
        )}
      </div>
      {toast.node}
    </>
  );
}

function StaffSettings() {
  const roles = useApi<any>("/api/ai/roles", { poll: 0 });
  const toast = useToast();
  if (!roles.data) return <Loading />;
  return (
    <div className="grid grid-3">
      {roles.data.roles.map((r: any) => (
        <RoleEditor
          key={r.role_key}
          r={r}
          onSave={async (b) => {
            try {
              await patch(`/api/ai/roles/${r.role_key}`, b);
              toast.show("저장했습니다.");
              roles.reload();
            } catch (e: any) {
              toast.show(e.message);
            }
          }}
        />
      ))}
      {toast.node}
    </div>
  );
}

function RoleEditor({ r, onSave }: { r: any; onSave: (b: any) => void }) {
  const [v, setV] = useState({ display_name: r.display_name, title: r.title, suit_color: r.suit_color, hair: r.appearance?.hair ?? "wave", instructions: r.instructions });
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ display_name: v.display_name, title: v.title, suit_color: v.suit_color, appearance: { ...r.appearance, hair: v.hair }, instructions: v.instructions });
      }}
    >
      <div style={{ display: "grid", placeItems: "center" }}>
        <StaffAvatar suit={v.suit_color} hair={v.hair} accent={r.appearance?.accent} size={96} />
      </div>
      <label className="field">
        <span>이름</span>
        <input value={v.display_name} onChange={(e) => setV({ ...v, display_name: e.target.value })} />
      </label>
      <label className="field">
        <span>직함</span>
        <input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>정장 색</span>
          <input type="color" value={v.suit_color} onChange={(e) => setV({ ...v, suit_color: e.target.value })} style={{ minHeight: 42, width: "100%" }} />
        </label>
        <label className="field">
          <span>헤어</span>
          <select value={v.hair} onChange={(e) => setV({ ...v, hair: e.target.value })}>
            <option value="wave">웨이브 롱</option>
            <option value="long">스트레이트 롱</option>
            <option value="bob">단발</option>
            <option value="updo">업스타일</option>
            <option value="ponytail">포니테일</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>역할 지침</span>
        <textarea value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} style={{ minHeight: 120 }} />
      </label>
      <button className="btn primary">저장</button>
    </form>
  );
}

function Integrations() {
  const d = useApi<any>("/api/integrations", { poll: 15000 });
  const toast = useToast();
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} />;
  return (
    <>
      <div className="banner warn">
        <div className="stack">
          <b>카카오 상담 공식 연동: 미완료</b>
          <span className="small">
            일반 카카오 채널 API는 1:1 대화 전체 조회 수단이 아닙니다. 상담톡 공식 경로(A: 채널톡 등 상담 솔루션 연동 / B: 상담톡 딜러사 API)를 계약·문서로 확인한 뒤 어댑터를 구현합니다. 상담톡 전환 시 기존 채널 관리자 채팅 메뉴가 중지되며 과거 대화가 자동 이전되지 않을 수 있으니 전환 계획을 먼저 확정하세요. 자세한 체크리스트는 docs/INTEGRATION.md.
          </span>
        </div>
      </div>
      <div className="card">
        <h2>공급사</h2>
        <table className="t" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>공급사</th>
              <th>상태</th>
              <th>수신 범위 시작</th>
              <th>마지막 이벤트</th>
              <th>최근 오류</th>
            </tr>
          </thead>
          <tbody>
            {d.data.integrations.map((i: any) => (
              <tr key={i.id}>
                <td>{i.provider === "kakao_counsel" ? "카카오 상담(공급사 미정)" : i.provider === "demo" ? "샘플 공급사(demo)" : i.provider}</td>
                <td>
                  <IntegrationBadge status={i.status} />
                </td>
                <td className="small">{fmtDateTime(i.coverage_start)}</td>
                <td className="small">{fmtDateTime(i.last_event_at)}</td>
                <td className="small">{i.last_error ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          웹훅 수신 주소 형식: <code>{d.data.webhookUrlPattern}</code> (공급사 공식 서명 검증을 통과한 요청만 저장)
        </p>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>원본 이벤트 수신함</h2>
          <button className="btn sm" onClick={async () => toast.show(`재처리 ${(await post("/api/integrations/requeue-failed")).requeued}건`)}>
            실패 이벤트 재처리
          </button>
        </div>
        <table className="t">
          <tbody>
            {d.data.events.map((e: any) => (
              <tr key={e.provider + e.status}>
                <td>{e.provider}</td>
                <td>{e.status}</td>
                <td>{e.n}건</td>
                <td className="small muted">{fmtDateTime(e.last_received)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.data.recentFailures.length > 0 && (
          <>
            <h3 style={{ marginTop: 10 }}>최근 실패</h3>
            {d.data.recentFailures.map((f: any) => (
              <div key={f.id} className="small list-item">
                {fmtDateTime(f.received_at)} · {f.external_event_id} · 시도 {f.attempts} · {f.error}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="card">
        <h2>모델 API</h2>
        <p className="small">
          {d.data.ai.configured ? <span className="badge ok">설정됨</span> : <span className="badge danger">미설정</span>} 모델 {d.data.ai.model}
        </p>
        <p className="tiny muted">API 키는 서버 환경변수 ANTHROPIC_API_KEY로만 설정합니다(배포 플랫폼의 비밀 설정). 채팅이나 화면에 키를 붙여넣지 마세요.</p>
      </div>
      {toast.node}
    </>
  );
}

function AiUsage() {
  const u = useApi<any>("/api/ai/usage", { poll: 0 });
  const s = useApi<any>("/api/settings", { poll: 0 });
  const [budget, setBudget] = useState<string>("");
  const toast = useToast();
  useEffect(() => {
    if (s.data) setBudget(String(s.data.aiMonthlyBudgetUsd));
  }, [s.data]);
  if (!u.data) return <Loading />;
  const d = u.data;
  return (
    <div className="card stack">
      <h2>이번 달 AI 사용량 (추정)</h2>
      <p className="small">
        ${d.usage.costUsd.toFixed(2)} / 한도 ${d.budgetUsd} · 호출 {d.usage.runs}회 · 입력 {d.usage.inputTokens.toLocaleString()} / 출력 {d.usage.outputTokens.toLocaleString()} 토큰
      </p>
      <div className="bar">
        <span style={{ width: `${Math.min(100, (d.usage.costUsd / Math.max(0.01, d.budgetUsd)) * 100)}%` }} />
      </div>
      <p className="tiny muted">
        {d.note} 단가 설정: 입력 ${d.priceInputPerMTok}/1M, 출력 ${d.priceOutputPerMTok}/1M ({d.model}). 한도 도달 시 AI 분석만 대기하며 상담 수신과 기본 업무는 계속됩니다.
      </p>
      <table className="t">
        <thead>
          <tr>
            <th>종류</th>
            <th>엔진</th>
            <th>호출</th>
            <th>추정 비용</th>
          </tr>
        </thead>
        <tbody>
          {d.byKind.map((r: any) => (
            <tr key={r.kind + r.engine}>
              <td>{r.kind}</td>
              <td>{r.engine === "model" ? "모델" : "규칙"}</td>
              <td>{r.runs}</td>
              <td>${Number(r.cost).toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        최근 성공 호출: {d.lastSuccess ? `${fmtDateTime(d.lastSuccess.finished_at)} (${d.lastSuccess.model})` : "없음"} · 호출 상한 시간당 {d.hourlyCallCap}회 / 하루 {d.dailyCallCap}회
      </p>
      {d.errors?.length > 0 && (
        <table className="t">
          <thead>
            <tr>
              <th>최근 30일 오류</th>
              <th>건수</th>
              <th>마지막</th>
            </tr>
          </thead>
          <tbody>
            {d.errors.map((e: any) => (
              <tr key={e.error_kind ?? "x"}>
                <td>{({ auth: "인증 실패(키 확인)", billing: "크레딧/결제", permission: "권한 없음", rate_limit: "요청 한도", overloaded: "서버 혼잡", network: "연결 실패", refusal: "정책상 거절", invalid: "잘못된 요청", server: "API 서버 오류", other: "기타" } as any)[e.error_kind] ?? e.error_kind ?? "미분류"}</td>
                <td>{e.n}</td>
                <td>{fmtDateTime(e.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="tiny muted">{d.billingNote}</p>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          await patch("/api/settings", { aiMonthlyBudgetUsd: Number(budget) });
          toast.show("한도를 저장했습니다.");
          u.reload();
        }}
      >
        <label className="field" style={{ width: 200 }}>
          <span>월 한도 (USD)</span>
          <input type="number" min={0} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </label>
        <button className="btn" style={{ alignSelf: "flex-end" }}>
          저장
        </button>
      </form>
      {toast.node}
    </div>
  );
}

function DataRetention() {
  const s = useApi<any>("/api/settings", { poll: 0 });
  const [days, setDays] = useState<string>("");
  const [importText, setImportText] = useState("");
  const [label, setLabel] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (s.data) setDays(s.data.retentionDays == null ? "" : String(s.data.retentionDays));
  }, [s.data]);
  return (
    <>
      <div className="card stack">
        <h2>보관 기간</h2>
        <p className="small muted">기간이 지난 상담은 원문·내부 메모·AI 요약·근거 연결·첨부 메타데이터를 함께 삭제합니다. 비워두면 무기한(정책 확정 전).</p>
        <div className="row">
          <input type="number" min={30} placeholder="예: 1095" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 160 }} aria-label="보관 일수" />
          <span>일</span>
          <button className="btn" onClick={async () => (await patch("/api/settings", { retentionDays: days ? Number(days) : null }), toast.show("저장했습니다."))}>
            저장
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm("보관 기간이 지난 상담을 지금 삭제할까요? 되돌릴 수 없습니다.")) return;
              const r = await post("/api/retention/run");
              toast.show(`삭제 ${r.deletedConversations}건`);
            }}
          >
            지금 정리 실행
          </button>
        </div>
      </div>
      <div className="card stack">
        <h2>샘플 데이터 삭제</h2>
        <p className="small muted">실연동 전환 전에 샘플(demo) 상담·문의·관련 할 일을 모두 삭제합니다.</p>
        <button
          className="btn danger"
          style={{ alignSelf: "flex-start" }}
          onClick={async () => {
            if (!confirm("샘플 데이터를 모두 삭제할까요?")) return;
            const r = await post("/api/sample-data/delete");
            toast.show(`상담 ${r.conversations}건, 문의 ${r.opportunities}건 삭제`);
          }}
        >
          샘플 데이터 삭제
        </button>
      </div>
      <div className="card stack">
        <h2>과거 기록 가져오기 (사용자 제공 자료)</h2>
        <p className="small muted">
          이 앱이 정의한 JSON 형식만 지원합니다. 출처와 기간이 기록·표시됩니다. 공급사의 일괄 내보내기 기능을 가정하지 않으며, 형식 예시는 docs/IMPORT_FORMAT.md를 참고하세요.
        </p>
        <input placeholder="출처 (예: 대표 보관 엑셀 정리본 2026-09~10)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <textarea placeholder='{"conversations":[...]}' value={importText} onChange={(e) => setImportText(e.target.value)} style={{ minHeight: 120, fontFamily: "monospace" }} />
        <button
          className="btn"
          style={{ alignSelf: "flex-start" }}
          onClick={async () => {
            try {
              const parsed = JSON.parse(importText);
              const r = await post("/api/imports", { source_label: label, ...parsed });
              toast.show(`가져오기 완료: 메시지 ${r.inserted}건`);
            } catch (e: any) {
              toast.show(e.message);
            }
          }}
        >
          가져오기
        </button>
      </div>
      {toast.node}
    </>
  );
}

function Audit() {
  const d = useApi<any[]>("/api/audit", { poll: 0 });
  if (!d.data) return <Loading />;
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>시각</th>
            <th>주체</th>
            <th>작업</th>
            <th>대상</th>
          </tr>
        </thead>
        <tbody>
          {d.data.map((a) => (
            <tr key={a.id}>
              <td className="small nowrap">{fmtDateTime(a.created_at)}</td>
              <td className="small">{a.actor_name ?? a.actor_type}</td>
              <td className="small">{a.action}</td>
              <td className="tiny muted">
                {a.target_type} {a.target_id?.slice(0, 8)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
