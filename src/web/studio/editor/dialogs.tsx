import { useEffect, useState } from "react";
import { fileUrl, sget, spost } from "../api";

function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">{title}</h2>
          <button className="btn sm ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const doneFor = (jobs: any[], vvId: string) => {
  const m = new Map<string, any>();
  for (const j of jobs) if (j.variantVersionId === vvId && j.status === "done" && !m.has(j.photoId)) m.set(j.photoId, j);
  return m;
};

export function ShareDialog({ roomId, projectId, variants, jobs, photos, onClose }: { roomId: string; projectId: string; variants: any[]; jobs: any[]; photos: any[]; onClose: () => void }) {
  const [title, setTitle] = useState("가구 배치 제안");
  const [client, setClient] = useState("");
  const [days, setDays] = useState(14);
  const [branding, setBranding] = useState(true);
  const [pick, setPick] = useState<Record<string, string[]>>(() => Object.fromEntries(variants.map((v) => [v.id, [...doneFor(jobs, v.head.id).values()].map((j) => j.id)])));
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const [shares, setShares] = useState<any[]>([]);
  const loadShares = () => sget(`/api/studio/projects/${projectId}/shares`).then(setShares);
  useEffect(() => {
    loadShares();
  }, []);
  return (
    <Modal title="고객에게 공유" wide onClose={onClose}>
      <p className="tiny muted">선택한 안의 현재 버전과 결과 이미지만 공개됩니다. 공유하면 해당 버전은 고정되고, 이후 수정은 새 버전으로 저장되어 링크 내용은 바뀌지 않습니다. 고객 화면에는 '배치 시뮬레이션' 안내가 표시됩니다.</p>
      <div className="row wrap">
        <label className="f grow">
          제목
          <input className="in" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="f">
          고객명
          <input className="in" value={client} onChange={(e) => setClient(e.target.value)} />
        </label>
        <label className="f" style={{ width: 90 }}>
          만료(일)
          <input className="in" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <label className="row tiny" style={{ alignSelf: "flex-end", height: 30 }}>
          <input type="checkbox" checked={branding} onChange={(e) => setBranding(e.target.checked)} /> 업체명 표시
        </label>
      </div>
      {variants.map((v) => {
        const done = doneFor(jobs, v.head.id);
        return (
          <div key={v.id} className="card col" style={{ padding: 10 }}>
            <div className="row">
              <b className="grow">
                {v.name} v{v.head.version}
              </b>
              <span className="tiny muted">{done.size ? `완료된 시점 ${done.size}개` : "완료된 렌더 없음 — 공유 불가"}</span>
            </div>
            <div className="row wrap">
              {photos.map((p) => {
                const j = done.get(p.id);
                if (!j) return null;
                const on = pick[v.id]?.includes(j.id);
                return (
                  <label key={p.id} className="col" style={{ width: 150, opacity: on ? 1 : 0.5, cursor: "pointer" }}>
                    <img src={fileUrl(j.outputs.previewFileId)} style={{ width: "100%", borderRadius: 4 }} />
                    <span className="row tiny">
                      <input type="checkbox" checked={!!on} onChange={(e) => setPick({ ...pick, [v.id]: e.target.checked ? [...(pick[v.id] ?? []), j.id] : (pick[v.id] ?? []).filter((x) => x !== j.id) })} />
                      {p.label} · {j.releaseLabel}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      {err && <div className="notice bad">{err}</div>}
      <div className="row">
        <button
          className="btn guide"
          onClick={async () => {
            setErr("");
            const items = variants.filter((v) => pick[v.id]?.length).map((v) => ({ variantVersionId: v.head.id, label: v.name, renderJobIds: pick[v.id] }));
            if (!items.length) return setErr("공유할 결과를 선택하세요.");
            try {
              const r = await spost("/api/studio/shares", { roomId, title, clientName: client || undefined, expiresDays: days, showBranding: branding, items });
              setLink(location.origin + r.path);
              loadShares();
            } catch (e: any) {
              setErr(e.message);
            }
          }}
        >
          공유 링크 만들기
        </button>
        {link && <input className="in grow" readOnly value={link} onFocus={(e) => e.target.select()} />}
        {link && (
          <a className="btn" href={link} target="_blank">
            열기
          </a>
        )}
      </div>
      <h3>이 프로젝트의 공유</h3>
      <table className="t">
        <tbody>
          {shares.map((s) => (
            <tr key={s.id}>
              <td>
                <b>{s.title}</b>
                <div className="tiny muted">
                  {s.items.map((i: any) => i.label).join(", ")} · {new Date(s.created_at).toLocaleString("ko-KR")}
                </div>
              </td>
              <td className="tiny">
                {(s.feedback ?? []).map((f: any, k: number) => (
                  <div key={k}>
                    {f.author_name}: {f.kind === "approve" ? "✔ 승인" : f.kind === "select" ? "선택" : f.body}
                  </div>
                ))}
              </td>
              <td className="tiny">{s.revoked_at ? "중지됨" : new Date(s.expires_at) < new Date() ? "만료" : `~${new Date(s.expires_at).toLocaleDateString("ko-KR")}`}</td>
              <td>
                {!s.revoked_at && (
                  <button className="btn sm danger" onClick={async () => { await spost(`/api/studio/shares/${s.id}/revoke`); loadShares(); }}>
                    공유 중지
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function DownloadDialog({ head, variantName, jobs, photos, onClose }: { head: any; variantName?: string; jobs: any[]; photos: any[]; onClose: () => void }) {
  const done = jobs.filter((j) => j.status === "done");
  return (
    <Modal title={`다운로드 · ${variantName ?? ""} v${head.version}`} onClose={onClose}>
      <p className="tiny muted">마스터 PNG는 원본과 같은 픽셀 크기의 무손실 파일입니다(마스크 밖 픽셀 동일성 검증 완료). 전달용 JPEG는 재압축되며 위치 정보 등 메타데이터가 없습니다.</p>
      <table className="t">
        <tbody>
          {photos.map((p) => {
            const j = done.find((x) => x.photoId === p.id);
            return (
              <tr key={p.id}>
                <td>{p.label}</td>
                <td className="tiny">{j ? `${j.evidenceLabel} · ${j.releaseLabel}` : "완료된 렌더 없음"}</td>
                <td>
                  {j && (
                    <div className="row">
                      <a className="btn sm" href={`/api/studio/renders/${j.id}/download?type=master`}>
                        마스터 PNG
                      </a>
                      <a className="btn sm" href={`/api/studio/renders/${j.id}/download?type=delivery`}>
                        전달용 JPG
                      </a>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row wrap">
        <a className={`btn ${done.length ? "" : "disabled"}`} href={`/api/studio/variant-versions/${head.id}/bundle.zip`}>
          전 시점 묶음(JPG) + 제품 목록
        </a>
        <a className="btn" href={`/api/studio/variant-versions/${head.id}/bundle.zip?type=master`}>
          전 시점 묶음(마스터 PNG)
        </a>
        <a className="btn" href={`/api/studio/variant-versions/${head.id}/products.csv`}>
          제품 목록 CSV
        </a>
      </div>
    </Modal>
  );
}

export function CompareDialog({ variants, jobs, photos, photoId, onClose }: { variants: any[]; jobs: any[]; photos: any[]; photoId: string | null; onClose: () => void }) {
  const [a, setA] = useState(variants[0]?.id);
  const [b, setB] = useState(variants[1]?.id);
  const [pid, setPid] = useState(photoId ?? photos[0]?.id);
  const [mode, setMode] = useState<"side" | "toggle">("side");
  const [showB, setShowB] = useState(false);
  const va = variants.find((v) => v.id === a), vb = variants.find((v) => v.id === b);
  const ja = va ? doneFor(jobs, va.head.id).get(pid) : null;
  const jb = vb ? doneFor(jobs, vb.head.id).get(pid) : null;
  const [summary, setSummary] = useState<string[]>([]);
  useEffect(() => {
    if (!va || !vb) return;
    // 두 안의 실제 차이(제품·위치·회전·치수)
    import("../../../shared/studio/variant").then(({ diffStates }) => {
      const names: Record<string, string> = {};
      setSummary(diffStates(va.head.state, vb.head.state, names).map((s) => s.text));
    });
    spost("/api/studio/events", { name: "compare_viewed" }).catch(() => {});
  }, [a, b]);
  return (
    <Modal title="A/B 비교 (같은 시점)" wide onClose={onClose}>
      <div className="row wrap">
        <select className="in" style={{ width: 140 }} value={a} onChange={(e) => setA(e.target.value)}>
          {variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} v{v.head.version}
            </option>
          ))}
        </select>
        <span>vs</span>
        <select className="in" style={{ width: 140 }} value={b} onChange={(e) => setB(e.target.value)}>
          {variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} v{v.head.version}
            </option>
          ))}
        </select>
        <select className="in" style={{ width: 120 }} value={pid} onChange={(e) => setPid(e.target.value)}>
          {photos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="tabs">
          <button className={`tab ${mode === "side" ? "on" : ""}`} onClick={() => setMode("side")}>
            나란히
          </button>
          <button className={`tab ${mode === "toggle" ? "on" : ""}`} onClick={() => setMode("toggle")}>
            전환
          </button>
        </div>
        {ja && jb && (
          <a className="btn sm" href={`/api/studio/compare.jpg?a=${ja.id}&b=${jb.id}`}>
            비교 이미지 저장
          </a>
        )}
      </div>
      <div className="tiny">
        <b>B안이 A안과 다른 점:</b> {summary.length ? summary.join(" · ") : "차이 없음"}
      </div>
      {(!ja || !jb) && <div className="notice">두 안 모두 이 시점의 렌더가 완료되어야 비교 이미지를 볼 수 있습니다. (편집기의 '검수·렌더'에서 요청)</div>}
      {mode === "side" ? (
        <div className="cmp">
          <div>{ja ? <img src={fileUrl(ja.outputs.deliveryFileId)} /> : <div className="muted">A 결과 없음</div>}</div>
          <div>{jb ? <img src={fileUrl(jb.outputs.deliveryFileId)} /> : <div className="muted">B 결과 없음</div>}</div>
        </div>
      ) : (
        <div className="col">
          <button className="btn" onClick={() => setShowB(!showB)}>
            {showB ? "B 보는 중 — A로 전환" : "A 보는 중 — B로 전환"}
          </button>
          {(showB ? jb : ja) && <img src={fileUrl((showB ? jb : ja).outputs.deliveryFileId)} style={{ width: "100%" }} />}
        </div>
      )}
    </Modal>
  );
}

export function ConsultDialog({ projectId, variants, jobs, photos, onClose }: { projectId: string; variants: any[]; jobs: any[]; photos: any[]; onClose: () => void }) {
  const [purpose, setPurpose] = useState("precision_composite");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [photoIds, setPhotoIds] = useState<string[]>(photos.map((p) => p.id));
  const [vvIds, setVvIds] = useState<string[]>(variants.map((v) => v.head.id));
  const done = jobs.filter((j) => j.status === "done" && vvIds.includes(j.variantVersionId));
  const [jobIds, setJobIds] = useState<string[]>(done.map((j) => j.id));
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const toggle = (arr: string[], set: (a: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  return (
    <Modal title="스테이신 정밀 합성 · 촬영 · 스타일링 상담" onClose={onClose}>
      {ok ? (
        <div className="notice ok">요청이 접수되었습니다. 선택한 자료만 스테이신 운영자가 열람할 수 있습니다.</div>
      ) : (
        <>
          <p className="tiny muted">맞춤 제품이나 까다로운 공간처럼 직접 처리하기 어려운 작업을 스테이신에 맡길 수 있습니다. 함께 보낼 자료를 고르세요 — 선택하지 않은 자료는 공개되지 않습니다.</p>
          <label className="f">
            목적
            <select className="in" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="precision_composite">정밀 합성 요청</option>
              <option value="shooting">준공·공간 촬영 상담</option>
              <option value="styling">숙소·공간 스타일링 상담</option>
              <option value="other">기타</option>
            </select>
          </label>
          <label className="f">
            요청 내용
            <textarea className="in" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <label className="f">
            문제 발생 시점(선택)
            <input className="in" value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="예: B안 시점 2 렌더에서 소파가 떠 보임" />
          </label>
          <h3>보낼 사진</h3>
          <div className="row wrap">
            {photos.map((p) => (
              <label key={p.id} className="row tiny">
                <input type="checkbox" checked={photoIds.includes(p.id)} onChange={() => toggle(photoIds, setPhotoIds, p.id)} /> {p.label}
              </label>
            ))}
          </div>
          <h3>보낼 안</h3>
          <div className="row wrap">
            {variants.map((v) => (
              <label key={v.id} className="row tiny">
                <input type="checkbox" checked={vvIds.includes(v.head.id)} onChange={() => toggle(vvIds, setVvIds, v.head.id)} /> {v.name} v{v.head.version}
              </label>
            ))}
          </div>
          <h3>보낼 결과</h3>
          <div className="row wrap">
            {done.map((j) => (
              <label key={j.id} className="row tiny">
                <input type="checkbox" checked={jobIds.includes(j.id)} onChange={() => toggle(jobIds, setJobIds, j.id)} /> {variants.find((v) => v.head.id === j.variantVersionId)?.name} · {photos.find((p) => p.id === j.photoId)?.label}
              </label>
            ))}
            {!done.length && <span className="tiny muted">완료된 결과 없음</span>}
          </div>
          {err && <div className="notice bad">{err}</div>}
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await spost("/api/studio/consult", { projectId, purpose, message: message || undefined, problemNote: problem || undefined, included: { photoIds, variantVersionIds: vvIds, renderJobIds: jobIds.filter((id) => done.some((j) => j.id === id)) } });
                setOk(true);
              } catch (e: any) {
                setErr(e.message);
              }
            }}
          >
            요청 보내기
          </button>
        </>
      )}
    </Modal>
  );
}
