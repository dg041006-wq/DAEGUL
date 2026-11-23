import { useEffect, useState } from "react";
import { sget, spatch, spost } from "../api";
import { TopNav } from "./Home";

const PURPOSE: Record<string, string> = { precision_composite: "정밀 합성", shooting: "촬영", styling: "스타일링", other: "기타" };

export function Ops() {
  const [usage, setUsage] = useState<any>(null);
  const [consults, setConsults] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [invite, setInvite] = useState("");
  const [err, setErr] = useState("");
  const load = async () => {
    try {
      setUsage(await sget("/api/studio/ops/usage"));
      setConsults(await sget("/api/studio/ops/consults"));
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <TopNav />
      <div className="page col" style={{ gap: 18 }}>
        <h1>운영 (스테이신 내부)</h1>
        {err && <div className="notice bad">{err}</div>}
        <div className="card col">
          <h2>업체 초대</h2>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const r = await spost("/api/studio/ops/invites", { days: 14 });
                setInvite(location.origin + r.path);
              }}
            >
              초대 링크 만들기 (14일)
            </button>
            {invite && <input className="in grow" readOnly value={invite} onFocus={(e) => e.target.select()} />}
          </div>
        </div>
        <div className="card col">
          <h2>상담 요청</h2>
          <p className="tiny muted">업체가 공개 범위로 고른 사진·안·결과만 열람할 수 있습니다. 외부 메시지 발송은 별도 연결 설정에서 처리합니다(미연결).</p>
          <table className="t">
            <thead>
              <tr>
                <th>접수</th>
                <th>업체 · 프로젝트</th>
                <th>목적</th>
                <th>내용</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {consults.map((c) => (
                <tr key={c.id} onClick={async () => setSel(await sget(`/api/studio/ops/consults/${c.id}`))} style={{ cursor: "pointer" }}>
                  <td>{new Date(c.created_at).toLocaleString("ko-KR")}</td>
                  <td>
                    {c.workspace_name} · {c.project_name}
                  </td>
                  <td>{PURPOSE[c.purpose]}</td>
                  <td>{c.message}</td>
                  <td>{c.status}</td>
                </tr>
              ))}
              {!consults.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    접수된 요청이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sel && (
          <div className="card col">
            <div className="row">
              <h2 className="grow">
                {sel.workspace_name} · {sel.project_name} — {PURPOSE[sel.purpose]}
              </h2>
              <select className="in" style={{ width: 140 }} value={sel.status} onChange={async (e) => { await spatch(`/api/studio/ops/consults/${sel.id}`, { status: e.target.value }); setSel({ ...sel, status: e.target.value }); load(); }}>
                <option value="new">신규</option>
                <option value="in_review">검토 중</option>
                <option value="closed">종료</option>
              </select>
            </div>
            <p>{sel.message}</p>
            {sel.problem_note && <p className="tiny muted">문제 발생 시점: {sel.problem_note}</p>}
            <h3>포함된 사진</h3>
            <div className="grid-cards">
              {sel.photos.map((p: any) => (
                <div key={p.id} className="col">
                  <img src={`/api/studio/ops/consults/${sel.id}/file/${p.preview_file_id}`} style={{ width: "100%", borderRadius: 4 }} />
                  <span className="tiny">
                    {p.label} · 보정 {p.calib_status} {(p.issues ?? []).filter((i: any) => i.severity !== "info").map((i: any) => i.code).join(", ")}
                  </span>
                </div>
              ))}
            </div>
            <h3>포함된 결과 · 렌더 진단</h3>
            <div className="grid-cards">
              {sel.jobs.map((j: any) => (
                <div key={j.id} className="col">
                  {j.status === "done" && <img src={`/api/studio/ops/consults/${sel.id}/file/${j.outputs.previewFileId}`} style={{ width: "100%", borderRadius: 4 }} />}
                  <span className="tiny">
                    {j.status} · {j.evidence} · {j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : ""} {j.error_code ?? ""}
                  </span>
                  {j.status === "done" && (
                    <span className="tiny muted">
                      허용 밖 변경 {j.outputs.qa.changedOutsideAllowed} · 가려진 가구 {j.outputs.qa.occludedFurniturePixels}px · 노이즈 σ {j.outputs.qa.grainSigma}
                      {" · "}
                      <a href={`/api/studio/ops/consults/${sel.id}/file/${j.outputs.alphaFileId}`} target="_blank">
                        가구 레이어
                      </a>{" "}
                      <a href={`/api/studio/ops/consults/${sel.id}/file/${j.outputs.shadowFileId}`} target="_blank">
                        그림자 레이어
                      </a>{" "}
                      <a href={`/api/studio/ops/consults/${sel.id}/file/${j.outputs.allowedMaskFileId}`} target="_blank">
                        변경 허용 마스크
                      </a>
                    </span>
                  )}
                </div>
              ))}
            </div>
            <h3>가구 목록</h3>
            {sel.products.map((p: any) => (
              <ul key={p.versionId} className="tiny">
                {p.rows.map((r: any, i: number) => (
                  <li key={i}>
                    {r.name} · {r.dims} · {r.verification} {r.sourceUrl && `· ${r.sourceUrl}`}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}
        {usage && (
          <div className="card col">
            <h2>사용량 · 실패 원인</h2>
            <table className="t">
              <thead>
                <tr>
                  <th>작업공간</th>
                  <th>이번 달 렌더 / 한도</th>
                  <th>비용(USD)</th>
                  <th>평균 렌더 시간</th>
                  <th>실패</th>
                </tr>
              </thead>
              <tbody>
                {usage.byWorkspace.map((w: any) => (
                  <tr key={w.id}>
                    <td>
                      {w.name} {w.kind === "internal" && <span className="chip">내부</span>}
                    </td>
                    <td>
                      {w.renders_month} / {w.limits?.monthlyRenders}
                    </td>
                    <td>{Number(w.cost_month).toFixed(2)}</td>
                    <td>{(w.avg_render_ms / 1000).toFixed(1)}s</td>
                    <td>{w.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>실패 유형</h3>
            <ul className="tiny">
              {usage.failures.map((f: any) => (
                <li key={f.error_code}>
                  {f.error_code}: {f.n}건 — {f.sample}
                </li>
              ))}
              {!usage.failures.length && <li className="muted">없음</li>}
            </ul>
            <h3>운영 지표(업체 수 / 이벤트 수)</h3>
            <div className="row wrap">
              {usage.funnel.map((f: any) => (
                <span key={f.name} className="chip">
                  {f.name} {f.workspaces}/{f.events}
                </span>
              ))}
            </div>
            <h3>외부 공급자 전송 기록</h3>
            <p className="tiny muted">{usage.providers.length ? usage.providers.map((p: any) => `${p.provider} ${p.n}건`).join(", ") : "외부 이미지 API로 보낸 자료 없음 (API 키 미설정)"}</p>
          </div>
        )}
      </div>
    </>
  );
}
