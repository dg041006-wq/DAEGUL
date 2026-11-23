import { useEffect, useState } from "react";
import type { Placement } from "../../../shared/studio/geometry";
import type { Lighting, ViewAdjust } from "../../../shared/studio/variant";
import { CALIB_STATUS_LABEL } from "../../../shared/studio/variant";

function Rng({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="rng">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="tiny" style={{ textAlign: "right" }}>
        {Number.isInteger(step) ? value : value.toFixed(2)}
        {unit}
      </span>
    </div>
  );
}

function NumIn({ label, value, onCommit, step = 1 }: { label: string; value: number; onCommit: (v: number) => void; step?: number }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="f">
      {label}
      <input
        className="in"
        type="number"
        step={step}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n !== value) onCommit(n);
          else setV(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function PlacementPanel({ placement: p, asset, onChange, onDelete }: { placement: Placement; asset: any; onChange: (p: Placement) => void; onDelete: () => void }) {
  const opts: any[] = asset?.size_options ?? [];
  const setDims = (dims: Placement["dims"]) => {
    const idx = opts.findIndex((o) => o.w === dims.w && o.d === dims.d && o.h === dims.h);
    onChange({ ...p, dims, sizeOptionIndex: idx >= 0 ? idx : null, nonStandard: idx < 0 });
  };
  return (
    <div className="sec">
      <div className="row">
        <b className="grow">{asset?.name ?? "가구"}</b>
        <button className="btn sm danger" onClick={onDelete}>
          삭제
        </button>
      </div>
      <div className="row wrap" style={{ gap: 4 }}>
        {asset?.kind === "model3d" ? (
          asset.current_version?.verification === "verified" ? <span className="chip ok">정확한 모델</span> : <span className="chip warn">3D · 미확인</span>
        ) : (
          <span className="chip warn">외관 참조(사진)</span>
        )}
        {p.nonStandard && <span className="chip bad">비규격 크기</span>}
        {asset?.current_version_id !== p.assetVersionId && <span className="chip">이전 에셋 버전 사용 중</span>}
      </div>
      {opts.length > 0 && (
        <label className="f">
          제품 옵션
          <select className="in" value={p.sizeOptionIndex ?? -1} onChange={(e) => { const o = opts[Number(e.target.value)]; if (o) setDims({ w: o.w, d: o.d, h: o.h }); }}>
            {p.sizeOptionIndex === null && <option value={-1}>비규격 크기</option>}
            {opts.map((o, i) => (
              <option key={i} value={i}>
                {o.label} {o.w}×{o.d}×{o.h}cm
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="num">
        <NumIn label="폭 cm" value={p.dims.w} onCommit={(w) => setDims({ ...p.dims, w })} />
        <NumIn label="깊이 cm" value={p.dims.d} onCommit={(d) => setDims({ ...p.dims, d })} />
        <NumIn label="높이 cm" value={p.dims.h} onCommit={(h) => setDims({ ...p.dims, h })} />
      </div>
      {p.nonStandard && <p className="tiny" style={{ color: "var(--bad)" }}>등록 옵션과 다른 크기입니다. 이 안에만 '비규격 크기'로 표시되며 제품 정보는 바뀌지 않습니다.</p>}
      <div className="num">
        <NumIn label="X cm" value={Math.round(p.position.x * 1000) / 10} step={0.5} onCommit={(x) => onChange({ ...p, position: { ...p.position, x: x / 100 } })} />
        <NumIn label="Z cm" value={Math.round(p.position.z * 1000) / 10} step={0.5} onCommit={(z) => onChange({ ...p, position: { ...p.position, z: z / 100 } })} />
        <NumIn label="회전 °" value={Math.round(p.rotationDeg * 10) / 10} step={0.5} onCommit={(r) => onChange({ ...p, rotationDeg: r })} />
      </div>
    </div>
  );
}

export function LightingPanel({ lighting: l, onChange }: { lighting: Lighting; onChange: (l: Lighting) => void }) {
  const s = (k: keyof Lighting) => (v: number) => onChange({ ...l, [k]: v });
  return (
    <div className="sec">
      <h3>방 조명 (모든 시점 공유)</h3>
      <Rng label="주광 방위" value={l.sunAzimuthDeg} min={0} max={360} step={1} unit="°" onChange={s("sunAzimuthDeg")} />
      <Rng label="주광 고도" value={l.sunElevationDeg} min={5} max={85} step={1} unit="°" onChange={s("sunElevationDeg")} />
      <Rng label="세기" value={l.sunIntensity} min={0} max={5} step={0.05} onChange={s("sunIntensity")} />
      <Rng label="색온도" value={l.colorTempK} min={2700} max={7500} step={50} unit="K" onChange={s("colorTempK")} />
      <Rng label="그림자 부드러움" value={l.softness} min={0} max={1} step={0.01} onChange={s("softness")} />
      <Rng label="환경광" value={l.ambient} min={0} max={3} step={0.05} onChange={s("ambient")} />
      <Rng label="그림자 강도" value={l.shadowStrength} min={0} max={1} step={0.01} onChange={s("shadowStrength")} />
      <Rng label="접지 그림자" value={l.contactShadow} min={0} max={1} step={0.01} onChange={s("contactShadow")} />
      <p className="tiny muted">방위 0° = +Z 쪽에서, 90° = +X 쪽에서 비춤. 창 방향에 맞추고 그림자 방향을 사진 속 실제 그림자와 비교하세요.</p>
    </div>
  );
}

export function ViewAdjustPanel({ adjust, onChange, label }: { adjust: ViewAdjust; onChange: (a: ViewAdjust) => void; label: string }) {
  const [a, setA] = useState(adjust);
  useEffect(() => setA(adjust), [JSON.stringify(adjust)]);
  const commit = (n: ViewAdjust) => {
    setA(n);
    onChange(n);
  };
  const warm = Math.round((a.wb[0] - a.wb[2]) * 100);
  return (
    <div className="sec">
      <h3>{label} 카메라 보정 (이 시점만)</h3>
      <Rng label="노출" value={a.exposure} min={-2} max={2} step={0.05} unit="EV" onChange={(v) => commit({ ...a, exposure: v })} />
      <Rng label="색 따뜻함" value={warm} min={-20} max={20} step={1} onChange={(v) => commit({ ...a, wb: [1 + v / 200, 1, 1 - v / 200] })} />
      <Rng label="초점 흐림" value={a.blurPx} min={0} max={4} step={0.1} unit="px" onChange={(v) => commit({ ...a, blurPx: v })} />
      <label className="row tiny">
        <input type="checkbox" checked={a.grain === null} onChange={(e) => commit({ ...a, grain: e.target.checked ? null : 1 })} /> 노이즈를 원본에서 자동 추정
      </label>
      {a.grain !== null && <Rng label="노이즈 σ" value={a.grain} min={0} max={6} step={0.1} onChange={(v) => commit({ ...a, grain: v })} />}
      <p className="tiny muted">노출·색·흐림·노이즈는 최종 렌더에만 반영되며 원본 픽셀은 바꾸지 않습니다.</p>
    </div>
  );
}

export function CalibPanel({ room, photo, activeRef, setActiveRef, onPhotoPatch, onRoomPatch }: { room: any; photo: any; activeRef: string | null; setActiveRef: (id: string | null) => void; onPhotoPatch: (b: any) => Promise<any>; onRoomPatch: (b: any) => Promise<void> }) {
  const cal = photo.calibration;
  const res = cal.result;
  const [editRefs, setEditRefs] = useState(false);
  const [refs, setRefs] = useState<any[]>(room.ref_points);
  const [rect, setRect] = useState({ w: "", d: "" });
  useEffect(() => setRefs(room.ref_points), [room.ref_points]);
  const pts: any[] = cal.points;
  const patchCal = (c: any) => onPhotoPatch({ calibration: { points: c.points ?? pts, focalMode: c.focalMode ?? cal.focalMode, focal35: c.focal35 !== undefined ? c.focal35 : cal.focal35 ?? null } });
  return (
    <>
      <div className="sec">
        <div className="row">
          <h3 className="grow">카메라 보정 · {photo.label}</h3>
          <span className={`chip ${photo.calib_status === "measured" ? "ok" : photo.calib_status === "estimated" ? "warn" : photo.calib_status === "failed" ? "bad" : ""}`}>{CALIB_STATUS_LABEL[photo.calib_status]}</span>
        </div>
        {res?.ok && (
          <dl className="kv">
            <dt>재투영 오차</dt>
            <dd>{res.rmsNormPx?.toFixed(1)}px (긴 변 2000px 기준)</dd>
            <dt>검증점 오차</dt>
            <dd>{res.checkMedianNormPx != null ? `중앙값 ${res.checkMedianNormPx.toFixed(1)}px / 최대 ${res.checkMaxNormPx.toFixed(1)}px` : "검증점 없음"}</dd>
            <dt>화각 · 초점</dt>
            <dd>
              {res.hfovDeg?.toFixed(1)}° · {res.focalSource === "exif" ? "EXIF" : res.focalSource === "manual" ? "직접 입력" : res.focalSource === "default" ? "기본값" : "추정"}
              {res.sigmaFocalPct != null && res.focalSource === "estimated" ? ` (±${res.sigmaFocalPct.toFixed(1)}%)` : ""}
            </dd>
            <dt>카메라 높이</dt>
            <dd>
              {(res.cameraHeightM * 100).toFixed(0)}cm{res.sigmaCenterM != null ? ` (위치 ±${(res.sigmaCenterM * 100).toFixed(0)}cm)` : ""}
            </dd>
          </dl>
        )}
        <div className="issues">
          {(res?.issues ?? []).map((i: any, k: number) => (
            <div key={k} className={`issue ${i.severity}`}>
              {i.message}
              {i.need && <span className="need">→ {i.need}</span>}
            </div>
          ))}
          {!res && <div className="issue">아직 기준점이 없습니다. 아래 목록에서 점을 고르고 사진에서 클릭하세요(최소 4개, 초점거리를 알면 3개).</div>}
        </div>
        {cal.suggestedPoints?.length > 0 && !pts.length && (
          <button className="btn sm" onClick={() => patchCal({ points: cal.suggestedPoints })}>
            이전 기준점 불러오기 (새 사진에서 위치 확인 필요)
          </button>
        )}
        <div className="row">
          <label className="f grow">
            초점거리
            <select className="in" value={cal.focalMode} onChange={(e) => patchCal({ focalMode: e.target.value })}>
              <option value="auto">기준점으로 추정</option>
              <option value="exif" disabled={!photo.exif?.focal35mm}>
                EXIF 사용 {photo.exif?.focal35mm ? `(${photo.exif.focal35mm}mm 환산)` : "(없음)"}
              </option>
              <option value="manual">직접 입력(35mm 환산)</option>
            </select>
          </label>
          {cal.focalMode === "manual" && (
            <label className="f" style={{ width: 80 }}>
              mm
              <input className="in" type="number" defaultValue={cal.focal35 ?? ""} onBlur={(e) => patchCal({ focal35: Number(e.target.value) || null })} />
            </label>
          )}
        </div>
      </div>
      <div className="sec">
        <div className="row">
          <h3 className="grow">기준점 (방 공통)</h3>
          <button className="btn sm" onClick={() => setEditRefs(!editRefs)}>
            {editRefs ? "닫기" : "좌표 편집"}
          </button>
        </div>
        <p className="tiny muted">{room.scale_note ?? (room.scale_measured ? "실측 좌표" : "실측 전 — 추정 스케일")}</p>
        {!editRefs &&
          room.ref_points.map((r: any) => {
            const p = pts.find((x) => x.refId === r.id);
            const err = res?.perPoint?.find((x: any) => x.id === r.id);
            return (
              <div key={r.id} className={`refpt ${activeRef === r.id ? "on" : ""}`} onClick={() => setActiveRef(activeRef === r.id ? null : r.id)}>
                <b>{r.id}</b>
                <span>
                  {r.label}
                  <span className="tiny muted" style={{ display: "block" }}>
                    ({(r.world[0] * 100).toFixed(0)}, {(r.world[1] * 100).toFixed(0)}, {(r.world[2] * 100).toFixed(0)})cm{p ? ` · ${err ? err.errPx.toFixed(1) + "px" : "지정됨"}` : " · 미지정"}
                  </span>
                </span>
                <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                  {p && (
                    <>
                      <button className={`btn sm ${p.check ? "on" : ""}`} title="검증점: 적합에 쓰지 않고 독립 오차만 계산" onClick={() => patchCal({ points: pts.map((x) => (x.refId === r.id ? { ...x, check: !x.check } : x)) })}>
                        검증
                      </button>
                      <button className="btn sm" title="이 사진에서 지우기" onClick={() => patchCal({ points: pts.filter((x) => x.refId !== r.id) })}>
                        ✕
                      </button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        {editRefs && (
          <div className="col">
            {refs.map((r, i) => (
              <div key={i} className="col" style={{ gap: 4, padding: 6, background: "var(--panel-2)", borderRadius: 6 }}>
                <div className="row">
                  <input className="in" style={{ width: 56 }} value={r.id} onChange={(e) => setRefs(refs.map((x, k) => (k === i ? { ...x, id: e.target.value } : x)))} />
                  <input className="in" value={r.label} onChange={(e) => setRefs(refs.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
                  <button className="btn sm" onClick={() => setRefs(refs.filter((_, k) => k !== i))}>
                    ✕
                  </button>
                </div>
                <div className="num">
                  {["X", "높이", "Z"].map((ax, k) => (
                    <label key={ax} className="f">
                      {ax} cm
                      <input className="in" type="number" value={Math.round(r.world[k] * 1000) / 10} onChange={(e) => setRefs(refs.map((x, j) => (j === i ? { ...x, world: x.world.map((w: number, m: number) => (m === k ? Number(e.target.value) / 100 : w)) } : x)))} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="row">
              <button className="btn sm" onClick={() => setRefs([...refs, { id: `Q${refs.length + 1}`, label: "", world: [0, 0, 0], measured: room.scale_measured }])}>
                + 점
              </button>
              <span className="tiny muted">바닥 사각형</span>
              <input className="in" style={{ width: 60 }} placeholder="폭cm" value={rect.w} onChange={(e) => setRect({ ...rect, w: e.target.value })} />
              <input className="in" style={{ width: 60 }} placeholder="깊이cm" value={rect.d} onChange={(e) => setRect({ ...rect, d: e.target.value })} />
              <button
                className="btn sm"
                disabled={!Number(rect.w) || !Number(rect.d)}
                onClick={() => {
                  const w = Number(rect.w) / 100, d = Number(rect.d) / 100;
                  const base = refs.length;
                  setRefs([...refs, ...[[0, 0], [w, 0], [w, d], [0, d]].map(([x, z], k) => ({ id: `R${base + k + 1}`, label: `바닥 사각형 ${k + 1}`, world: [x, 0, z], measured: true }))]);
                }}
              >
                추가
              </button>
            </div>
            <label className="row tiny">
              <input type="checkbox" checked={room.scale_measured} onChange={(e) => onRoomPatch({ scaleMeasured: e.target.checked })} /> 이 좌표는 줄자로 잰 실측값입니다
            </label>
            <button className="btn primary" onClick={() => onRoomPatch({ refPoints: refs }).then(() => setEditRefs(false))}>
              기준점 저장 (모든 시점 재계산)
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function MaskPanel({ photo, maskType, setMaskType, draft, onClose, onCancel, onPatch }: { photo: any; maskType: "occluders" | "protected"; setMaskType: (t: "occluders" | "protected") => void; draft: [number, number][]; onClose: () => void; onCancel: () => void; onPatch: (m: any) => void }) {
  const m = photo.masks;
  return (
    <div className="sec">
      <h3>가림·보호 영역 · {photo.label}</h3>
      <div className="tabs">
        <button className={`tab ${maskType === "occluders" ? "on" : ""}`} onClick={() => setMaskType("occluders")}>
          전경 가림
        </button>
        <button className={`tab ${maskType === "protected" ? "on" : ""}`} onClick={() => setMaskType("protected")}>
          보호 영역
        </button>
      </div>
      <p className="tiny muted">
        {maskType === "occluders" ? "가구보다 앞에 있는 물체(문틀·기둥·전경 집기)를 그리면 가구가 그 뒤로 숨습니다." : "몰딩·콘센트·로고·창밖 풍경처럼 절대 바뀌면 안 되는 영역입니다. 최종 합성에서 원본 픽셀로 복원됩니다."}
      </p>
      <div className="row">
        <button className="btn sm" disabled={draft.length < 3} onClick={onClose}>
          영역 닫기({draft.length}점)
        </button>
        <button className="btn sm" disabled={!draft.length} onClick={onCancel}>
          취소
        </button>
      </div>
      {(["occluders", "protected"] as const).map((t) =>
        m[t].map((x: any, i: number) => (
          <div key={x.id} className="row tiny">
            <span className={`chip ${t === "occluders" ? "warn" : "ok"}`}>{t === "occluders" ? "가림" : "보호"}</span>
            <span className="grow">
              영역 {i + 1} · 꼭짓점 {x.points.length}
            </span>
            <button className="btn sm" onClick={() => onPatch({ ...m, [t]: m[t].filter((y: any) => y.id !== x.id) })}>
              삭제
            </button>
          </div>
        )),
      )}
      <p className="tiny muted">마스크 버전 {photo.masks_rev} — 렌더 기록에 함께 남습니다.</p>
    </div>
  );
}
