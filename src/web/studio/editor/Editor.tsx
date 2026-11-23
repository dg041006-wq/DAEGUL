import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fileUrl, onSave, sget, spatch, spost, sput, supload } from "../api";
import { useMe } from "../main";
import { floorHit, placementWarnings, project, type Camera, type Placement } from "../../../shared/studio/geometry";
import { CALIB_STATUS_LABEL, DEFAULT_VIEW_ADJUST, type Lighting, type VariantState } from "../../../shared/studio/variant";
import type { SceneSpec } from "../render/scene";
import { Stage, type Tool, type ViewMode } from "./Stage";
import { renderThumb } from "./preview";
import { KIND_LABEL, assetThumb, verificationChip } from "../pages/Assets";
import { CalibPanel, LightingPanel, PlacementPanel, ViewAdjustPanel, MaskPanel } from "./panels";
import { CompareDialog, ConsultDialog, DownloadDialog, ShareDialog } from "./dialogs";

const STATUS_LABEL: Record<string, string> = { queued: "대기", running: "처리 중", done: "완료", failed: "실패", canceled: "취소" };
const calibChip = (s: string) => <span className={`chip ${s === "measured" ? "ok" : s === "estimated" ? "warn" : s === "failed" ? "bad" : ""}`}>{CALIB_STATUS_LABEL[s] ?? s}</span>;

export function Editor() {
  const { roomId } = useParams();
  const { me } = useMe();
  const [data, setData] = useState<any>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [variantId, setVariantId] = useState<string | null>(null);
  const [state, setState] = useState<VariantState | null>(null);
  const [head, setHead] = useState<any>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [viewMode, setViewMode] = useState<ViewMode>("layout");
  const [zoom, setZoom] = useState<"fit" | "100">("fit");
  const [split, setSplit] = useState<number | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [save, setSave] = useState<{ state: string; message?: string }>({ state: "idle" });
  const [activeRef, setActiveRef] = useState<string | null>(null);
  const [maskDraft, setMaskDraft] = useState<[number, number][]>([]);
  const [maskType, setMaskType] = useState<"occluders" | "protected">("occluders");
  const [dialog, setDialog] = useState<null | "share" | "download" | "compare" | "consult">(null);
  const [rightTab, setRightTab] = useState<"place" | "light" | "qa">("place");
  const saveTimer = useRef<any>(null);
  const editStart = useRef<number>(Date.now());

  const load = useCallback(async () => {
    const d = await sget(`/api/studio/rooms/${roomId}`);
    setData(d);
    return d;
  }, [roomId]);

  useEffect(() => {
    load()
      .then(async (d) => {
        if (!d.variants.length) {
          await spost(`/api/studio/rooms/${roomId}/variants`, { name: "A안" });
          d = await load();
        }
        const v = d.variants[0];
        if (v) {
          setVariantId(v.id);
          setState(v.head.state);
          setHead(v.head);
        }
        setPhotoId(d.photos[0]?.id ?? null);
        if (!d.photos.some((p: any) => p.calib_status === "estimated" || p.calib_status === "measured") && d.photos.length) setTool("calib");
      })
      .catch((e) => setErr(e.message));
    sget("/api/studio/assets").then(setAssets);
    const off = onSave((s) => setSave(s));
    return () => {
      off();
    };
  }, [load]);

  const loadJobs = useCallback(async () => {
    if (!roomId) return;
    setJobs(await sget(`/api/studio/renders?roomId=${roomId}`));
  }, [roomId]);
  useEffect(() => {
    loadJobs();
  }, [loadJobs]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === "queued" || j.status === "running")) return;
    const t = setInterval(loadJobs, 2000);
    return () => clearInterval(t);
  }, [jobs, loadJobs]);

  const photos: any[] = data?.photos ?? [];
  const photo = photos.find((p) => p.id === photoId) ?? null;
  const variants: any[] = data?.variants ?? [];
  const variant = variants.find((v) => v.id === variantId) ?? null;
  const room = data?.room;
  const cams = useMemo(() => photos.filter((p) => p.calibration?.result?.ok).map((p) => ({ photoId: p.id, label: p.label, cam: p.calibration.result.camera as Camera })), [photos]);
  const cam: Camera | null = photo?.calibration?.result?.ok ? photo.calibration.result.camera : null;
  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  // 장면 사양 (미리보기·썸네일)
  const verUrl = useCallback(
    (assetVersionId: string, assetId: string) => {
      const a = assetMap.get(assetId);
      const v = a?.current_version?.id === assetVersionId ? a.current_version : null;
      if (!a) return null;
      if (a.kind === "model3d") {
        const fid = v?.glb_file_id;
        return fid ? { kind: "model3d" as const, url: fileUrl(fid), frontAxis: v.meta?.frontAxis ?? "+Z" } : null;
      }
      const ref = v?.ref_photos?.[0];
      return ref ? { kind: "photo" as const, url: fileUrl(ref.cutoutFileId ?? ref.fileId), frontAxis: "+Z" } : null;
    },
    [assetMap],
  );
  const specFor = useCallback(
    (ph: any): SceneSpec | null => {
      if (!state || !ph?.calibration?.result?.ok) return null;
      const c = ph.calibration.result.camera;
      const placements = state.placements
        .map((p) => {
          const u = verUrl(p.assetVersionId, p.assetId);
          return u ? { id: p.id, kind: u.kind, url: u.url, dims: p.dims, position: p.position, rotationDeg: p.rotationDeg, frontAxis: u.frontAxis as any } : null;
        })
        .filter(Boolean) as SceneSpec["placements"];
      return { camera: c, placements, lighting: state.lighting, exposure: ph.view_adjust?.exposure ?? 0, envUrl: fileUrl(ph.preview_file_id) };
    },
    [state, verUrl],
  );
  const spec = useMemo(() => specFor(photo), [specFor, photo]);

  // 썸네일 갱신(디바운스)
  const thumbs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const thumbImgs = useRef<Record<string, HTMLImageElement>>({});
  useEffect(() => {
    const t = setTimeout(async () => {
      for (const ph of photos) {
        const c = thumbs.current[ph.id];
        if (!c) continue;
        let img = thumbImgs.current[ph.id];
        if (!img) {
          img = new Image();
          img.src = fileUrl(ph.preview_file_id);
          thumbImgs.current[ph.id] = img;
          await new Promise((r) => {
            img.onload = r;
            img.onerror = r;
          });
        }
        await renderThumb(c, img, specFor(ph), ph.calibration?.result?.ok ? ph.calibration.result.camera : null);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [photos, specFor]);

  // ───── 초안 저장: 한 번에 하나만 보내고, 그 사이 변경은 최신 상태 하나로 모아 이어서 보낸다 ─────
  const headRef = useRef<any>(null);
  headRef.current = head;
  const saving = useRef(false);
  const dirty = useRef<VariantState | null>(null);
  const variantRef = useRef<string | null>(null);
  variantRef.current = variantId;
  const flush = useCallback(async () => {
    if (saving.current || !dirty.current || !variantRef.current) return;
    saving.current = true;
    const st = dirty.current;
    dirty.current = null;
    const vid = variantRef.current;
    try {
      const h = headRef.current;
      const saved = await sput(`/api/studio/variants/${vid}/draft`, { state: st, rev: h.locked_at ? undefined : h.rev });
      if (variantRef.current === vid) {
        headRef.current = saved;
        setHead(saved);
        // 서버가 정규화한 값(비규격 표시 등)은 그 사이 새 편집이 없을 때만 반영
        if (!dirty.current) setState(saved.state);
      }
      setData((d: any) => (d ? { ...d, variants: d.variants.map((v: any) => (v.id === vid ? { ...v, head: saved } : v)) } : d));
    } catch (e: any) {
      if (e.status === 409) {
        dirty.current = null;
        const d = await load();
        const v = d.variants.find((x: any) => x.id === vid);
        if (v && variantRef.current === vid) {
          setState(v.head.state);
          setHead(v.head);
          headRef.current = v.head;
        }
      }
    } finally {
      saving.current = false;
      if (dirty.current) flush();
    }
  }, [load]);
  const persist = useCallback(
    (next: VariantState, immediate = false) => {
      dirty.current = next;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, immediate ? 0 : 400);
    },
    [flush],
  );
  const flushNow = async () => {
    clearTimeout(saveTimer.current);
    await flush();
    while (saving.current) await new Promise((r) => setTimeout(r, 50));
  };
  const update = (fn: (s: VariantState) => VariantState, commit = true) => {
    setState((cur) => {
      if (!cur) return cur;
      const next = fn(structuredClone(cur));
      if (commit) persist(next);
      return next;
    });
  };

  const switchVariant = async (id: string) => {
    await flushNow();
    const v = (data?.variants ?? []).find((x: any) => x.id === id);
    if (!v) return;
    setVariantId(id);
    setState(v.head.state);
    setHead(v.head);
    setSelected(null);
  };

  const addPlacement = (a: any) => {
    if (!state || !a.current_version_id) return;
    const c = cam ?? cams[0]?.cam;
    let pos = { x: 0, z: 0 };
    let rot = 0;
    if (c) {
      // 화면 아래쪽(카메라에 가까운 바닥)부터 찾는다. 방 경계가 있으면 그 안의 점만 쓴다.
      const bounds: [number, number][] | null = room?.floor_bounds ?? null;
      const inside = (x: number, z: number) => {
        if (!bounds) return true;
        let ins = false;
        for (let i = 0, j = bounds.length - 1; i < bounds.length; j = i++) {
          const [xi, zi] = bounds[i], [xj, zj] = bounds[j];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
        }
        return ins;
      };
      for (const fv of [0.88, 0.82, 0.94, 0.76, 0.7]) {
        const hit = floorHit(c, c.width / 2, c.height * fv);
        if (hit && inside(hit[0], hit[2])) {
          pos = { x: +hit[0].toFixed(3), z: +hit[2].toFixed(3) };
          break;
        }
      }
      rot = Math.round((Math.atan2(c.C[0] - pos.x, c.C[2] - pos.z) * 180) / Math.PI);
    }
    const o = a.size_options[0];
    const pl: Placement = { id: `pl-${Math.random().toString(36).slice(2, 9)}`, assetId: a.id, assetVersionId: a.current_version_id, sizeOptionIndex: 0, dims: { w: o.w, d: o.d, h: o.h }, nonStandard: false, position: pos, rotationDeg: rot };
    update((s) => ({ ...s, placements: [...s.placements, pl] }));
    setSelected(pl.id);
    setTool("move");
    setViewMode("layout");
  };

  // 키보드 미세 이동 (카메라 기준 앞뒤·좌우)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (tool === "mask") {
        if (e.key === "Enter" && maskDraft.length >= 3) closeMask();
        if (e.key === "Escape") setMaskDraft([]);
        return;
      }
      if (!selected || !state || (e.target as HTMLElement)?.tagName?.match(/INPUT|SELECT|TEXTAREA/)) return;
      const step = e.shiftKey ? 0.1 : 0.01;
      const c = cam;
      let fwd: [number, number] = [0, -1];
      if (c) {
        const f = [-c.R[2], -c.R[8]];
        const n = Math.hypot(f[0], f[1]) || 1;
        fwd = [f[0] / n, f[1] / n];
      }
      const right: [number, number] = [-fwd[1], fwd[0]];
      let d: [number, number] | null = null;
      if (e.key === "ArrowUp") d = [fwd[0] * step, fwd[1] * step];
      if (e.key === "ArrowDown") d = [-fwd[0] * step, -fwd[1] * step];
      if (e.key === "ArrowLeft") d = [-right[0] * step, -right[1] * step];
      if (e.key === "ArrowRight") d = [right[0] * step, right[1] * step];
      if (d) {
        e.preventDefault();
        update((s) => ({ ...s, placements: s.placements.map((p) => (p.id === selected ? { ...p, position: { x: +(p.position.x + d![0]).toFixed(4), z: +(p.position.z + d![1]).toFixed(4) } } : p)) }));
      }
      if (e.key === "q" || e.key === "e" || e.key === "Q" || e.key === "E") {
        const r = (e.key.toLowerCase() === "q" ? -1 : 1) * (e.shiftKey ? 15 : 1);
        update((s) => ({ ...s, placements: s.placements.map((p) => (p.id === selected ? { ...p, rotationDeg: p.rotationDeg + r } : p)) }));
      }
      if (e.key === "Delete" || e.key === "Backspace") update((s) => ({ ...s, placements: s.placements.filter((p) => p.id !== selected) }));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // ───── 사진 보정·마스크 저장 ─────
  const patchPhoto = async (id: string, body: any) => {
    const r = await spatch(`/api/studio/photos/${id}`, body);
    setData((d: any) => ({ ...d, photos: d.photos.map((p: any) => (p.id === id ? { ...p, ...r } : p)) }));
    return r;
  };
  const calibTimer = useRef<any>(null);
  const setCalibPoint = (refId: string, u: number, v: number) => {
    if (!photo) return;
    const pts = photo.calibration.points.filter((p: any) => p.refId !== refId);
    const old = photo.calibration.points.find((p: any) => p.refId === refId);
    pts.push({ refId, u: Math.round(u * 2) / 2, v: Math.round(v * 2) / 2, check: old?.check });
    const cal = { ...photo.calibration, points: pts };
    setData((d: any) => ({ ...d, photos: d.photos.map((p: any) => (p.id === photo.id ? { ...p, calibration: cal } : p)) }));
    clearTimeout(calibTimer.current);
    calibTimer.current = setTimeout(() => patchPhoto(photo.id, { calibration: { points: pts, focalMode: cal.focalMode, focal35: cal.focal35 ?? null } }), 350);
  };
  const closeMask = () => {
    if (!photo || maskDraft.length < 3) return;
    const masks = structuredClone(photo.masks);
    masks[maskType].push({ id: `m-${Date.now().toString(36)}`, points: maskDraft });
    setMaskDraft([]);
    patchPhoto(photo.id, { masks });
  };

  // ───── 렌더 ─────
  const headJobs = useMemo(() => {
    if (!head) return new Map<string, any>();
    const m = new Map<string, any>();
    for (const j of jobs) if (j.variantVersionId === head.id && !m.has(j.photoId)) m.set(j.photoId, j);
    return m;
  }, [jobs, head]);
  const requestRender = async (photoIds: string[]) => {
    if (!head) return;
    await flushNow();
    try {
      const r = await spost("/api/studio/renders", { variantVersionId: headRef.current.id, photoIds });
      const skipped = r.filter((x: any) => x.skipped);
      if (skipped.length) setErr(skipped.map((s: any) => s.reason).join(" / "));
      await loadJobs();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const currentJob = photo ? headJobs.get(photo.id) : null;
  const compositeUrl = currentJob?.status === "done" ? fileUrl(currentJob.outputs.deliveryFileId) : null;

  const warnings = useMemo(() => (state ? placementWarnings(state.placements, room?.floor_bounds ?? null, cams) : []), [state, room, cams]);
  const sel = state?.placements.find((p) => p.id === selected) ?? null;

  if (err && !data) return <div className="page notice bad">{err}</div>;
  if (!data || !state && variants.length) return <div className="page muted">불러오는 중…</div>;

  const lockedText = head?.locked_reason === "approved" ? "승인됨 · 고정" : head?.locked_reason === "shared" ? "공유됨 · 고정" : head?.locked_reason === "saved" ? "저장됨 · 고정" : "초안";

  return (
    <div className="editor">
      <div className="bar">
        <div className="crumb">
          <Link to="/studio" className="btn ghost sm">
            ←
          </Link>
          <b title={data.project.name}>{data.project.name}</b>
          <span className="muted">›</span>
          <span>{room.name}</span>
        </div>
        <div className="tabs" style={{ marginLeft: 8 }}>
          {variants.map((v) => (
            <button key={v.id} className={`tab ${v.id === variantId ? "on" : ""}`} onClick={() => switchVariant(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
        <button
          className="btn sm"
          title="현재 안을 복제해 새 안 만들기"
          onClick={async () => {
            const name = prompt("새 안 이름", `${String.fromCharCode(65 + variants.length)}안`);
            if (!name) return;
            await flushNow();
            const r = await spost(`/api/studio/rooms/${roomId}/variants`, { name, copyFromVariantId: variantId ?? undefined });
            const d = await load();
            setVariantId(r.variant.id);
            const v = d.variants.find((x: any) => x.id === r.variant.id);
            setState(v.head.state);
            setHead(v.head);
          }}
        >
          + 복제해 새 안
        </button>
        {head && (
          <span className={`chip ${head.locked_at ? "ok" : ""}`} title={(head.summary ?? []).map((s: any) => s.text).join("\n")}>
            v{head.version} · {lockedText}
          </span>
        )}
        {head && !head.locked_at && (
          <button
            className="btn sm"
            onClick={async () => {
              await flushNow();
              const h = await spost(`/api/studio/variants/${variantId}/lock`, {});
              setHead(h);
              await load();
            }}
          >
            버전 저장
          </button>
        )}
        <span className={`save ${save.state === "error" ? "error" : ""}`}>{save.state === "saving" ? "저장 중…" : save.state === "saved" ? "저장됨" : save.state === "error" ? save.message : ""}</span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => setDialog("compare")} disabled={variants.length < 2}>
          A/B 비교
        </button>
        <button className={`btn sm ${rightTab === "qa" ? "on" : ""}`} onClick={() => setRightTab("qa")}>
          검수
        </button>
        <button className="btn sm" onClick={() => setDialog("download")}>
          다운로드
        </button>
        <button className="btn sm" onClick={() => setDialog("consult")}>
          스테이신 상담
        </button>
        <button className="btn sm guide" onClick={() => setDialog("share")}>
          공유
        </button>
      </div>
      <div className="body3">
        {/* 왼쪽: 시점·가구 */}
        <div className="side">
          <div className="col">
            <div className="row">
              <h3 className="grow">시점</h3>
              <label className="btn sm">
                + 사진
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      const ph = await supload(`/api/studio/rooms/${roomId}/photos`, f);
                      await load();
                      setPhotoId(ph.id);
                      setTool("calib");
                    } catch (er: any) {
                      setErr(er.message);
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="views">
              {photos.map((ph) => {
                const j = head ? headJobs.get(ph.id) : null;
                return (
                  <div key={ph.id} className={`view ${ph.id === photoId ? "on" : ""}`} onClick={() => setPhotoId(ph.id)}>
                    <canvas ref={(el) => (thumbs.current[ph.id] = el)} width={300} height={Math.round((300 * ph.height) / ph.width)} />
                    <div className="lbl">
                      <span className="chip">{ph.label}</span>
                      {calibChip(ph.calib_status)}
                      {j && <span className={`chip ${j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}`}>{STATUS_LABEL[j.status]}</span>}
                    </div>
                  </div>
                );
              })}
              {!photos.length && <p className="tiny muted">같은 방 사진을 1~3장 올리세요. 한 장으로도 시작할 수 있습니다.</p>}
            </div>
          </div>
          <div className="col">
            <div className="row">
              <h3 className="grow">가구</h3>
              <Link className="btn sm" to="/studio/assets">
                제품 등록
              </Link>
            </div>
            {assets
              .filter((a) => a.current_version_id)
              .map((a) => (
                <div key={a.id} className="prod" onClick={() => addPlacement(a)} title="클릭하면 현재 시점 바닥에 놓습니다">
                  <div className="th">{assetThumb(a)}</div>
                  <div className="col grow" style={{ gap: 2 }}>
                    <b style={{ fontSize: 12 }}>{a.name}</b>
                    <div className="row wrap" style={{ gap: 4 }}>
                      <span className="chip">{KIND_LABEL[a.kind]}</span>
                      {verificationChip(a)}
                    </div>
                    <span className="tiny muted">
                      {a.size_options[0].w}×{a.size_options[0].d}×{a.size_options[0].h}cm
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* 가운데: 캔버스 */}
        <div className="stage-wrap">
          <div className="stage-tools">
            <div className="tabs">
              <button className={`tab ${tool === "move" ? "on" : ""}`} onClick={() => setTool("move")}>
                배치
              </button>
              <button className={`tab ${tool === "calib" ? "on" : ""}`} onClick={() => setTool("calib")}>
                기준점 보정
              </button>
              <button className={`tab ${tool === "mask" ? "on" : ""}`} onClick={() => setTool("mask")}>
                가림·보호 영역
              </button>
            </div>
            <span className="muted">|</span>
            <div className="tabs">
              {(["original", "layout", "composite"] as ViewMode[]).map((m) => (
                <button key={m} className={`tab ${viewMode === m ? "on" : ""}`} onClick={() => setViewMode(m)}>
                  {{ original: "원본", layout: "배치", composite: "합성" }[m]}
                </button>
              ))}
            </div>
            {viewMode === "composite" && compositeUrl && (
              <label className="row tiny">
                원본 대비
                <input type="range" min={0} max={100} value={split === null ? 0 : split * 100} onChange={(e) => setSplit(Number(e.target.value) === 0 ? null : Number(e.target.value) / 100)} />
              </label>
            )}
            {viewMode === "composite" && !compositeUrl && <span className="tiny muted">렌더 전 — 미리보기 표시 중</span>}
            <div className="spacer" />
            <div className="tabs">
              <button className={`tab ${zoom === "fit" ? "on" : ""}`} onClick={() => setZoom("fit")}>
                전체
              </button>
              <button className={`tab ${zoom === "100" ? "on" : ""}`} onClick={() => setZoom("100")}>
                100%
              </button>
            </div>
          </div>
          {photo ? (
            <Stage
              photo={photo}
              imgUrl={fileUrl(photo.preview_file_id)}
              masterUrl={fileUrl(photo.master_file_id)}
              cam={cam}
              spec={spec}
              placements={state?.placements ?? []}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                if (id) setRightTab("place");
              }}
              onMove={(id, pos, rot, commit) => update((s) => ({ ...s, placements: s.placements.map((p) => (p.id === id ? { ...p, position: pos, rotationDeg: rot ?? p.rotationDeg } : p)) }), !!commit)}
              tool={tool}
              viewMode={viewMode}
              zoom={zoom}
              compositeUrl={compositeUrl}
              split={split}
              refPoints={room.ref_points}
              calibPoints={photo.calibration.points}
              activeRef={activeRef}
              onCalibPoint={setCalibPoint}
              floorBounds={room.floor_bounds}
              masks={photo.masks}
              maskDraft={maskDraft}
              maskType={maskType}
              onMaskPoint={(p) => setMaskDraft((d) => [...d, p])}
              onMaskClose={closeMask}
            />
          ) : (
            <div className="stage-scroll">
              <div className="card" style={{ margin: "auto", maxWidth: 420 }}>
                <h2>방 사진을 올리세요</h2>
                <p className="muted">비어 있거나 바닥이 잘 보이는 사진이 좋습니다. 원본은 변경 없이 비공개로 보관됩니다.</p>
              </div>
            </div>
          )}
          <div className="stage-foot">
            {photo && (
              <>
                <span>
                  {photo.label} · {photo.width}×{photo.height}px
                </span>
                {calibChip(photo.calib_status)}
                {photo.calibration.result?.ok && (
                  <span>
                    재투영 {photo.calibration.result.rmsNormPx?.toFixed(1)}px · 화각 {photo.calibration.result.hfovDeg?.toFixed(0)}° · 카메라 높이 {(photo.calibration.result.cameraHeightM * 100).toFixed(0)}cm
                  </span>
                )}
                {tool === "move" && <span>드래그: 이동 · Shift+드래그: 회전 · 방향키 1cm(Shift 10cm) · Q/E 1°(Shift 15°)</span>}
                {tool === "calib" && <span>오른쪽에서 기준점을 고르고 사진에서 그 위치를 클릭하세요. 빨간 ×는 계산된 위치, 파란 격자는 바닥 50cm 간격입니다.</span>}
                {tool === "mask" && <span>클릭으로 꼭짓점 추가 · 더블클릭/Enter로 닫기 · Esc 취소</span>}
              </>
            )}
          </div>
        </div>

        {/* 오른쪽: 설정 */}
        <div className="side right">
          {err && (
            <div className="notice bad" onClick={() => setErr("")}>
              {err}
            </div>
          )}
          {tool === "calib" && photo && (
            <CalibPanel
              room={room}
              photo={photo}
              activeRef={activeRef}
              setActiveRef={setActiveRef}
              onPhotoPatch={(body) => patchPhoto(photo.id, body)}
              onRoomPatch={async (body) => {
                try {
                  await spatch(`/api/studio/rooms/${roomId}`, { rev: room.rev, ...body });
                } catch (e: any) {
                  setErr(e.message);
                }
                await load();
              }}
            />
          )}
          {tool === "mask" && photo && <MaskPanel photo={photo} maskType={maskType} setMaskType={setMaskType} draft={maskDraft} onClose={closeMask} onCancel={() => setMaskDraft([])} onPatch={(m) => patchPhoto(photo.id, { masks: m })} />}
          {tool === "move" && (
            <>
              <div className="tabs" style={{ alignSelf: "stretch" }}>
                {(["place", "light", "qa"] as const).map((t) => (
                  <button key={t} className={`tab ${rightTab === t ? "on" : ""}`} style={{ flex: 1 }} onClick={() => setRightTab(t)}>
                    {{ place: "배치", light: "조명·시점", qa: "검수·렌더" }[t]}
                  </button>
                ))}
              </div>
              {rightTab === "place" && (
                <>
                  {sel ? (
                    <PlacementPanel
                      placement={sel}
                      asset={assetMap.get(sel.assetId)}
                      onChange={(p) => update((s) => ({ ...s, placements: s.placements.map((x) => (x.id === p.id ? p : x)) }))}
                      onDelete={() => {
                        update((s) => ({ ...s, placements: s.placements.filter((x) => x.id !== sel.id) }));
                        setSelected(null);
                      }}
                    />
                  ) : (
                    <p className="muted tiny">사진에서 가구를 클릭해 선택하거나, 왼쪽 목록에서 가구를 추가하세요.</p>
                  )}
                  <div className="sec">
                    <h3>이 안의 가구</h3>
                    {state?.placements.map((p) => (
                      <div key={p.id} className={`refpt ${p.id === selected ? "on" : ""}`} style={{ gridTemplateColumns: "1fr auto" }} onClick={() => setSelected(p.id)}>
                        <span>{assetMap.get(p.assetId)?.name ?? "가구"}</span>
                        <span className="tiny muted">
                          {p.dims.w}×{p.dims.d}
                          {p.nonStandard ? " · 비규격" : ""}
                        </span>
                      </div>
                    ))}
                    {head?.summary?.length > 0 && (
                      <>
                        <h3>변경 요약 (v{head.version})</h3>
                        <ul className="tiny" style={{ margin: 0, paddingLeft: 16 }}>
                          {head.summary.map((s: any, i: number) => (
                            <li key={i}>{s.text}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                  {warnings.length > 0 && (
                    <div className="sec">
                      <h3>검수 경고</h3>
                      <div className="issues">
                        {warnings.map((w, i) => (
                          <div key={i} className={`issue ${w.code === "collision" || w.code === "outside_room" ? "warning" : ""}`}>
                            {w.message}
                          </div>
                        ))}
                      </div>
                      <p className="tiny muted">사진에서 가려진 선이나 실측되지 않은 공간의 간섭은 직접 확인하세요.</p>
                    </div>
                  )}
                </>
              )}
              {rightTab === "light" && state && (
                <>
                  <LightingPanel lighting={state.lighting} onChange={(l: Lighting) => update((s) => ({ ...s, lighting: l }))} />
                  {photo && <ViewAdjustPanel adjust={{ ...DEFAULT_VIEW_ADJUST, ...photo.view_adjust }} onChange={(va) => patchPhoto(photo.id, { viewAdjust: va })} label={photo.label} />}
                </>
              )}
              {rightTab === "qa" && (
                <div className="col">
                  <div className="sec">
                    <h3>시점별 합성 (현재 안 v{head?.version})</h3>
                    {!me?.capabilities.renderer && <div className="notice">이 서버에 렌더 워커가 없습니다. 요청은 대기열에 남습니다.</div>}
                    <div className="jobs">
                      {photos.map((ph) => {
                        const j = headJobs.get(ph.id);
                        return (
                          <div key={ph.id} className="job">
                            {j?.status === "done" ? <img src={fileUrl(j.outputs.previewFileId)} onClick={() => { setPhotoId(ph.id); setViewMode("composite"); }} /> : <img src={fileUrl(ph.preview_file_id)} style={{ opacity: 0.5 }} />}
                            <div className="col" style={{ gap: 2 }}>
                              <div className="row" style={{ gap: 4 }}>
                                <b>{ph.label}</b>
                                {j ? <span className={`chip ${j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}`}>{STATUS_LABEL[j.status]}</span> : <span className="chip">요청 전</span>}
                                {!ph.calibration?.result?.ok && calibChip(ph.calib_status)}
                              </div>
                              {j?.status === "done" && (
                                <span className="tiny muted">
                                  {j.evidenceLabel} · {j.releaseLabel} · 원본 밖 변경 {j.outputs.qa.changedOutsideAllowed}px {j.outputs.qa.preservation?.ok ? "✓" : "✕"}
                                </span>
                              )}
                              {j?.status === "done" && (
                                <span className="row tiny" style={{ gap: 4 }}>
                                  {j.outputs.aiEdit ? (
                                    <>
                                      <span className="chip warn">AI 경계 보정본 있음</span>
                                      <a href={`/api/studio/renders/${j.id}/download?type=delivery&variant=ai`}>보정본 받기</a>
                                    </>
                                  ) : (
                                    <button
                                      className="btn sm"
                                      disabled={!me?.capabilities.aiEdit}
                                      title={me?.capabilities.aiEdit ? "" : "이미지 편집 API 키가 설정되지 않음"}
                                      onClick={async () => {
                                        if (!confirm(`외부 이미지 편집 API(OpenAI)로 다음 자료를 보냅니다:\n- ${ph.label}의 합성 결과(축소본)\n- 경계·그림자 영역 마스크\n원본 사진 파일과 고객 정보는 보내지 않습니다. 결과는 경계 띠만 받아들이고 가구 내부와 나머지 사진은 그대로 둡니다. 진행할까요?`)) return;
                                        try {
                                          await spost(`/api/studio/renders/${j.id}/ai-edit`, { confirmSend: true });
                                          loadJobs();
                                        } catch (e: any) {
                                          setErr(e.message);
                                        }
                                      }}
                                    >
                                      AI 경계 보정{me?.capabilities.aiEdit ? "" : " (미설정)"}
                                    </button>
                                  )}
                                </span>
                              )}
                              {j?.status === "failed" && (
                                <span className="tiny" style={{ color: "var(--bad)" }}>
                                  {j.errorCode}: {j.errorDetail}
                                </span>
                              )}
                              {(j?.placementEvidence ?? []).filter((e: any) => e.need).map((e: any, i: number) => (
                                <span key={i} className="tiny" style={{ color: "var(--warn)" }}>
                                  {e.need}
                                </span>
                              ))}
                              <div className="row" style={{ gap: 4 }}>
                                {(!j || j.status === "done") && ph.calibration?.result?.ok && (
                                  <button className="btn sm" onClick={() => requestRender([ph.id])}>
                                    {j ? "다시 확인" : "렌더"}
                                  </button>
                                )}
                                {j && (j.status === "failed" || j.status === "canceled") && (
                                  <button className="btn sm" onClick={async () => { await spost(`/api/studio/renders/${j.id}/retry`); loadJobs(); }}>
                                    실패 시점 재시도
                                  </button>
                                )}
                                {j && (j.status === "queued" || j.status === "running") && (
                                  <button className="btn sm" onClick={async () => { await spost(`/api/studio/renders/${j.id}/cancel`); loadJobs(); }}>
                                    취소
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <button className="btn guide" onClick={() => requestRender(photos.filter((p) => p.calibration?.result?.ok).map((p) => p.id))} disabled={!photos.some((p) => p.calibration?.result?.ok)}>
                      보정된 모든 시점 렌더
                    </button>
                    <p className="tiny muted">같은 설정의 중복 요청은 진행 중이거나 완료된 작업을 그대로 보여줍니다. 성공한 시점은 보존되고 실패한 시점만 다시 요청할 수 있습니다.</p>
                  </div>
                  <div className="sec">
                    <h3>100% 확대 검수 순서</h3>
                    <ol className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
                      <li>광원 방향·그림자 방향이 사진과 맞는가</li>
                      <li>다리·바닥 접점이 떠 보이지 않는가</li>
                      <li>전경 가림(문틀·기둥)이 가구 앞에 있는가</li>
                      <li>누끼 테두리·이중 경계·재질의 과도한 매끈함</li>
                      <li>노이즈·초점·압축감이 사진과 같은가</li>
                    </ol>
                    <button
                      className="btn"
                      onClick={async () => {
                        await spost("/api/studio/events", { name: "review_done", projectId: data.project.id, props: { versionId: head?.id ?? "", minutes: Math.round((Date.now() - editStart.current) / 6000) / 10 } });
                        await spost("/api/studio/events", { name: "edit_time", projectId: data.project.id, props: { minutes: Math.round((Date.now() - editStart.current) / 6000) / 10 } });
                        editStart.current = Date.now();
                        alert("검수 완료로 기록했습니다.");
                      }}
                    >
                      검수 완료 기록
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {dialog === "share" && <ShareDialog roomId={roomId!} projectId={data.project.id} variants={variants} jobs={jobs} photos={photos} onClose={() => { setDialog(null); load(); }} />}
      {dialog === "download" && head && <DownloadDialog head={head} variantName={variant?.name} jobs={[...headJobs.values()]} photos={photos} onClose={() => setDialog(null)} />}
      {dialog === "compare" && <CompareDialog variants={variants} jobs={jobs} photos={photos} photoId={photoId} onClose={() => setDialog(null)} />}
      {dialog === "consult" && <ConsultDialog projectId={data.project.id} variants={variants} jobs={jobs} photos={photos} onClose={() => setDialog(null)} />}
    </div>
  );
}

export { project };
