// 고객용 공유 화면 (로그인 없음, 모바일 우선): 선택한 버전만 보기 · 안 선택 · 의견 · 승인
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { sget, spost } from "../api";

export function SharePage() {
  const { token } = useParams();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [view, setView] = useState(0);
  const [mode, setMode] = useState<"side" | "toggle">(window.innerWidth < 700 ? "toggle" : "side");
  const [active, setActive] = useState(0);
  const [name, setName] = useState(() => localStorage.getItem("share-name") ?? "");
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState("");
  const load = () =>
    sget(`/api/studio/public/share/${token}`)
      .then(setD)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, [token]);
  if (err) return <div className="share"><div className="notice bad">{err}</div></div>;
  if (!d) return <div className="share muted">불러오는 중…</div>;
  const views: string[] = [...new Set<string>(d.items.flatMap((it: any) => it.images.map((i: any) => i.view)))];
  const send = async (kind: "comment" | "select" | "approve", vvId: string) => {
    if (!name.trim()) {
      setMsg("이름을 먼저 입력해 주세요.");
      return;
    }
    localStorage.setItem("share-name", name);
    try {
      await spost(`/api/studio/public/share/${token}/feedback`, { variantVersionId: vvId, kind, authorName: name, body: kind === "comment" ? comment : undefined });
      setComment("");
      setMsg(kind === "approve" ? "승인이 전달되었습니다. 이 버전은 고정되어 이후 수정은 새 버전으로 만들어집니다." : kind === "select" ? "선택이 전달되었습니다." : "의견이 전달되었습니다.");
      load();
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  const imgFor = (it: any) => it.images.find((i: any) => i.view === views[view]) ?? it.images[0];
  return (
    <div className="share">
      <div className="col" style={{ gap: 4 }}>
        <span className="tiny muted">{d.vendor ? `${d.vendor} 제안` : "가구 배치 제안"}</span>
        <h1>{d.title}</h1>
        {d.clientName && <span className="muted">{d.clientName} 님</span>}
      </div>
      <div className="notice">{d.notice}</div>
      <div className="row wrap">
        {views.length > 1 && (
          <div className="tabs">
            {views.map((v, i) => (
              <button key={v} className={`tab ${i === view ? "on" : ""}`} onClick={() => setView(i)}>
                {v}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {d.items.length > 1 && (
          <div className="tabs">
            <button className={`tab ${mode === "side" ? "on" : ""}`} onClick={() => setMode("side")}>
              나란히
            </button>
            <button className={`tab ${mode === "toggle" ? "on" : ""}`} onClick={() => setMode("toggle")}>
              전환
            </button>
          </div>
        )}
      </div>
      {mode === "toggle" && d.items.length > 1 && (
        <div className="tabs" style={{ alignSelf: "flex-start" }}>
          {d.items.map((it: any, i: number) => (
            <button key={it.variantVersionId} className={`tab ${i === active ? "on" : ""}`} onClick={() => setActive(i)}>
              {it.label}
            </button>
          ))}
        </div>
      )}
      <div className="plans">
        {d.items.map((it: any, i: number) => {
          if (mode === "toggle" && i !== active) return null;
          const img = imgFor(it);
          const fb = d.feedback.filter((f: any) => f.variant_version_id === it.variantVersionId);
          return (
            <div key={it.variantVersionId} className="card col">
              <div className="row">
                <h2 className="grow">
                  {it.label} <span className="tiny muted">v{it.version}</span>
                </h2>
                {it.approved && <span className="chip ok">승인됨</span>}
              </div>
              {img && <img src={img.url} alt={`${it.label} ${img.view}`} />}
              {img && (
                <span className="tiny muted">
                  {img.view} · {img.evidence}
                </span>
              )}
              <table className="t">
                <tbody>
                  {it.products.map((p: any, k: number) => (
                    <tr key={k}>
                      <td>
                        <b>{p.name}</b>
                        <div className="tiny muted">{[p.brand, p.model, p.color, p.material].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="nowrap">
                        {p.dims}
                        {p.sizeLabel === "비규격 크기" && <div className="tiny" style={{ color: "var(--warn)" }}>비규격 크기</div>}
                      </td>
                      <td className="tiny">{p.verification}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row wrap">
                <button className="btn" onClick={() => send("select", it.variantVersionId)}>
                  이 안으로 선택
                </button>
                {!it.approved && (
                  <button className="btn primary" onClick={() => send("approve", it.variantVersionId)}>
                    이 버전 승인
                  </button>
                )}
              </div>
              {fb.length > 0 && (
                <div className="col" style={{ gap: 4 }}>
                  {fb.map((f: any, k: number) => (
                    <div key={k} className="tiny">
                      <b>{f.author_name}</b> {f.kind === "approve" ? "승인" : f.kind === "select" ? "선택" : ""} {f.body} <span className="muted">{new Date(f.created_at).toLocaleString("ko-KR")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="card col">
        <h2>수정 의견</h2>
        <input className="in" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className="in" rows={3} placeholder="예: 소파를 창 쪽으로 30cm 옮겨 주세요" value={comment} onChange={(e) => setComment(e.target.value)} />
        <div className="row wrap">
          {d.items.map((it: any) => (
            <button key={it.variantVersionId} className="btn" disabled={!comment.trim()} onClick={() => send("comment", it.variantVersionId)}>
              {it.label}에 의견 남기기
            </button>
          ))}
        </div>
        {msg && <div className="notice info">{msg}</div>}
      </div>
      <p className="tiny muted">링크 만료: {new Date(d.expiresAt).toLocaleDateString("ko-KR")}</p>
    </div>
  );
}
