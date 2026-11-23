import { useEffect, useState } from "react";
import { fileUrl, sget, spost, supload } from "../api";
import { TopNav } from "./Home";

export const KIND_LABEL: Record<string, string> = { model3d: "3D 모델", photo: "상품 사진", concept: "콘셉트" };
export function verificationChip(a: any) {
  const v = a.current_version;
  if (!v) return <span className="chip warn">파일 없음</span>;
  if (a.kind === "model3d") return v.verification === "verified" ? <span className="chip ok">정확한 모델 · 치수 확인</span> : <span className="chip warn">3D · 치수/재질 미확인</span>;
  if (a.kind === "photo") return <span className="chip warn">외관 참조 · 보이는 면만</span>;
  return <span className="chip">콘셉트 · 제품 미확정</span>;
}

export function assetThumb(a: any) {
  const v = a.current_version;
  const ref = v?.ref_photos?.[0];
  if (ref) return <img src={fileUrl(ref.cutoutFileId ?? ref.fileId)} alt="" />;
  return <span>{a.kind === "model3d" ? "3D" : "—"}</span>;
}

export function Assets() {
  const [assets, setAssets] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ name: "", brand: "", modelCode: "", category: "sofa", color: "", material: "", sourceUrl: "", kind: "model3d", w: "", d: "", h: "", label: "기본", notes: "" });
  const load = () => sget("/api/studio/assets").then(setAssets);
  useEffect(() => {
    load();
  }, []);
  const openAsset = async (id: string) => setSel(await sget(`/api/studio/assets/${id}`));
  return (
    <>
      <TopNav />
      <div className="page col" style={{ gap: 18 }}>
        <h1>가구 제품</h1>
        <p className="muted">
          정확한 3D 모델이 있는 제품은 어느 시점에서도 같은 형상·재질로 렌더됩니다. 상품 사진만 있는 제품은 보이는 면만 근거가 있으며, 다른 각도는 '외관 추정' 또는 '추가 참조 필요'로 표시됩니다. 출처 링크는 기록용이며 자동 수집하지 않습니다.
        </p>
        {err && <div className="notice bad">{err}</div>}
        {msg && <div className="notice ok">{msg}</div>}
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <div className="col grow" style={{ gap: 8 }}>
            {assets.map((a) => (
              <div key={a.id} className="prod" onClick={() => openAsset(a.id)}>
                <div className="th">{assetThumb(a)}</div>
                <div className="col grow" style={{ gap: 2 }}>
                  <div className="row">
                    <b>{a.name}</b>
                    {a.is_catalog && <span className="chip">기본 카탈로그</span>}
                  </div>
                  <div className="row wrap">
                    <span className="chip">{KIND_LABEL[a.kind]}</span>
                    {verificationChip(a)}
                    <span className="tiny muted">{a.size_options.map((o: any) => `${o.label} ${o.w}×${o.d}×${o.h}`).join(" · ")}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <form
            className="card col"
            style={{ width: 340, flexShrink: 0 }}
            onSubmit={async (e) => {
              e.preventDefault();
              setErr("");
              try {
                const a = await spost("/api/studio/assets", {
                  name: f.name,
                  brand: f.brand || undefined,
                  modelCode: f.modelCode || undefined,
                  category: f.category,
                  color: f.color || undefined,
                  material: f.material || undefined,
                  sourceUrl: f.sourceUrl || undefined,
                  kind: f.kind,
                  notes: f.notes || undefined,
                  sizeOptions: [{ label: f.label || "기본", w: Number(f.w), d: Number(f.d), h: Number(f.h) }],
                });
                setMsg(`'${a.name}' 등록됨 — 오른쪽 상세에서 ${f.kind === "model3d" ? "GLB 파일" : "상품 사진"}을 올리세요.`);
                await load();
                openAsset(a.id);
              } catch (e: any) {
                setErr(e.message);
              }
            }}
          >
            <h2>고객이 고른 제품 등록</h2>
            <label className="f">
              자료 종류
              <select className="in" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                <option value="model3d">3D 모델(GLB) 보유</option>
                <option value="photo">상품 사진만 보유</option>
                <option value="concept">콘셉트(제품 미확정)</option>
              </select>
            </label>
            <label className="f">
              제품명
              <input className="in" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <div className="num" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <label className="f">
                브랜드
                <input className="in" value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} />
              </label>
              <label className="f">
                모델
                <input className="in" value={f.modelCode} onChange={(e) => setF({ ...f, modelCode: e.target.value })} />
              </label>
              <label className="f">
                색상
                <input className="in" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
              </label>
              <label className="f">
                소재
                <input className="in" value={f.material} onChange={(e) => setF({ ...f, material: e.target.value })} />
              </label>
            </div>
            <label className="f">
              분류
              <select className="in" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {["sofa:소파", "chair:의자", "table:테이블", "bed:침대", "storage:수납", "lighting:조명", "other:기타"].map((x) => (
                  <option key={x} value={x.split(":")[0]}>
                    {x.split(":")[1]}
                  </option>
                ))}
              </select>
            </label>
            <div className="num" style={{ gridTemplateColumns: "1.2fr 1fr 1fr 1fr" }}>
              <label className="f">
                옵션명
                <input className="in" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
              </label>
              <label className="f">
                폭 cm
                <input className="in" required type="number" value={f.w} onChange={(e) => setF({ ...f, w: e.target.value })} />
              </label>
              <label className="f">
                깊이
                <input className="in" required type="number" value={f.d} onChange={(e) => setF({ ...f, d: e.target.value })} />
              </label>
              <label className="f">
                높이
                <input className="in" required type="number" value={f.h} onChange={(e) => setF({ ...f, h: e.target.value })} />
              </label>
            </div>
            <label className="f">
              출처 링크(기록용)
              <input className="in" value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} placeholder="https://" />
            </label>
            <button className="btn primary">등록</button>
          </form>
        </div>
        {sel && <AssetDetail asset={sel} onChange={() => { load(); openAsset(sel.id); }} onError={setErr} onMsg={setMsg} />}
      </div>
    </>
  );
}

function AssetDetail({ asset, onChange, onError, onMsg }: { asset: any; onChange: () => void; onError: (s: string) => void; onMsg: (s: string) => void }) {
  const [front, setFront] = useState("+Z");
  const [confirmed, setConfirmed] = useState(false);
  const [license, setLicense] = useState("");
  const [az, setAz] = useState("0");
  const [el, setEl] = useState("10");
  const [label, setLabel] = useState("정면");
  return (
    <div className="card col">
      <div className="row">
        <h2 className="grow">{asset.name}</h2>
        <span className="chip">{KIND_LABEL[asset.kind]}</span>
      </div>
      {asset.notes && <p className="tiny muted">{asset.notes}</p>}
      <table className="t">
        <thead>
          <tr>
            <th>버전</th>
            <th>상태</th>
            <th>모델 치수(측정)</th>
            <th>참조 사진</th>
            <th>출처·라이선스</th>
            <th>등록</th>
          </tr>
        </thead>
        <tbody>
          {asset.versions.map((v: any) => (
            <tr key={v.id}>
              <td>v{v.version}</td>
              <td>{v.verification === "verified" ? "확인됨" : v.verification === "appearance" ? "외관 참조" : "미확인"}</td>
              <td>
                {v.meta?.measuredBBoxCm ? `${v.meta.measuredBBoxCm.w}×${v.meta.measuredBBoxCm.d}×${v.meta.measuredBBoxCm.h}cm · 앞면 ${v.meta.frontAxis}` : "—"}
                {v.meta?.dimensionMismatch?.length > 0 && <div className="tiny" style={{ color: "var(--bad)" }}>{v.meta.dimensionMismatch.join(", ")}</div>}
              </td>
              <td>
                <div className="row wrap">
                  {(v.ref_photos ?? []).map((r: any, i: number) => (
                    <span key={i} className="chip" title={r.note}>
                      {r.label} {r.azimuthDeg}°{r.cutout === "failed" ? " · 배경제거 실패" : ""}
                    </span>
                  ))}
                </div>
              </td>
              <td className="tiny">
                {v.meta?.provenance ?? ""} {v.meta?.license ? `· ${v.meta.license}` : ""}
              </td>
              <td className="tiny">{new Date(v.created_at).toLocaleDateString("ko-KR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {asset.is_catalog ? (
        <p className="tiny muted">기본 카탈로그 제품입니다. 버전은 스테이신이 관리합니다.</p>
      ) : asset.kind === "model3d" ? (
        <div className="row wrap" style={{ alignItems: "flex-end" }}>
          <label className="f">
            모델 앞면 방향
            <select className="in" value={front} onChange={(e) => setFront(e.target.value)}>
              <option value="+Z">+Z (glTF 기본)</option>
              <option value="-Z">-Z</option>
              <option value="+X">+X</option>
              <option value="-X">-X</option>
            </select>
          </label>
          <label className="f">
            라이선스/사용 권한
            <input className="in" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="예: 제조사 제공" />
          </label>
          <label className="row tiny" style={{ height: 30 }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> 실물·제조사 자료와 치수·방향·재질을 대조했음
          </label>
          <label className="btn">
            GLB 올리기 (새 버전)
            <input
              type="file"
              accept=".glb,model/gltf-binary"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const v = await supload(`/api/studio/assets/${asset.id}/versions/glb?frontAxis=${encodeURIComponent(front)}&confirmed=${confirmed}&license=${encodeURIComponent(license)}`, file, "model/gltf-binary");
                  onMsg(`v${v.version} 등록: ${v.verification === "verified" ? "치수 일치·확인됨" : "미확인 — " + (v.meta.dimensionMismatch.join(", ") || "대조 확인 체크 필요")}`);
                  onChange();
                } catch (er: any) {
                  onError(er.message);
                }
              }}
            />
          </label>
        </div>
      ) : (
        <div className="row wrap" style={{ alignItems: "flex-end" }}>
          <label className="f" style={{ width: 120 }}>
            촬영 방위(°)
            <input className="in" type="number" value={az} onChange={(e) => setAz(e.target.value)} title="0=정면, 90=오른쪽 측면, 180=뒷면, 270=왼쪽 측면" />
          </label>
          <label className="f" style={{ width: 100 }}>
            고도(°)
            <input className="in" type="number" value={el} onChange={(e) => setEl(e.target.value)} />
          </label>
          <label className="f" style={{ width: 120 }}>
            이름
            <input className="in" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="btn">
            상품 사진 올리기 (새 버전)
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const r = await supload(`/api/studio/assets/${asset.id}/versions/photo?azimuth=${az}&elevation=${el}&label=${encodeURIComponent(label)}`, file);
                  onMsg(`v${r.version.version} 등록 — ${r.cutout.note}`);
                  onChange();
                } catch (er: any) {
                  onError(er.message);
                }
              }}
            />
          </label>
          <span className="tiny muted">0° 정면 · 90° 오른쪽 측면 · 180° 뒷면 · 270° 왼쪽 측면</span>
        </div>
      )}
    </div>
  );
}
