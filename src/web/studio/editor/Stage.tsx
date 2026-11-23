// 큰 사진 캔버스: 원본/배치/합성 보기, 드래그 배치, 기준점 지정, 마스크 그리기, 원본 대비 슬라이더
import { useEffect, useMemo, useRef, useState } from "react";
import { boxCorners, floorHit, footprint, project, type Camera, type Placement } from "../../../shared/studio/geometry";
import type { SceneSpec } from "../render/scene";
import { PreviewRenderer } from "./preview";

export type Tool = "move" | "calib" | "mask";
export type ViewMode = "original" | "layout" | "composite";

interface Props {
  photo: any;
  imgUrl: string;
  masterUrl: string;
  cam: Camera | null;
  spec: SceneSpec | null;
  placements: Placement[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, pos: { x: number; z: number }, rotationDeg?: number, commit?: boolean) => void;
  tool: Tool;
  viewMode: ViewMode;
  zoom: "fit" | "100";
  compositeUrl: string | null;
  split: number | null; // 0..1 원본 대비 슬라이더 위치
  // 보정
  refPoints: { id: string; label: string; world: [number, number, number] }[];
  calibPoints: { refId: string; u: number; v: number; check?: boolean }[];
  activeRef: string | null;
  onCalibPoint: (refId: string, u: number, v: number) => void;
  floorBounds: [number, number][] | null;
  // 마스크
  masks: { occluders: { id: string; points: [number, number][] }[]; protected: { id: string; points: [number, number][] }[] };
  maskDraft: [number, number][];
  maskType: "occluders" | "protected";
  onMaskPoint: (p: [number, number]) => void;
  onMaskClose: () => void;
}

const GUIDE = "#2f6bff";

function hull(pts: [number, number][]) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function inPoly(pt: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function Stage(p: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const prevR = useRef<PreviewRenderer | null>(null);
  const [box, setBox] = useState({ w: 800, h: 533 });
  const drag = useRef<null | { id: string; start: [number, number, number]; init: { x: number; z: number }; rot: number; mode: "move" | "rotate"; sx: number; dragRef?: string }>(null);
  const W = p.photo.width, H = p.photo.height;

  // 크기 맞춤
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = p.zoom === "100" ? 1 : Math.min((r.width - 24) / W, (r.height - 24) / H);
      setBox({ w: Math.max(50, Math.round(W * s)), h: Math.max(50, Math.round(H * s)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H, p.zoom]);

  const glSize = useMemo(() => {
    const s = Math.min(1, 4096 / Math.max(box.w, box.h)) * Math.min(2, window.devicePixelRatio || 1);
    return { w: Math.round(box.w * s), h: Math.round(box.h * s) };
  }, [box]);

  // 3D 미리보기
  useEffect(() => {
    if (!glRef.current) return;
    if (!prevR.current) prevR.current = new PreviewRenderer(glRef.current);
    return () => {
      prevR.current?.dispose();
      prevR.current = null;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const r = prevR.current;
    if (!r || !p.cam || !p.spec) {
      const g = glRef.current?.getContext("webgl2");
      g?.clearColor(0, 0, 0, 0);
      g?.clear(g.COLOR_BUFFER_BIT);
      return;
    }
    r.sync(p.spec).then(() => {
      if (alive && p.cam && p.spec) r.render(p.cam, glSize.w, glSize.h, p.spec.exposure);
    });
    return () => {
      alive = false;
    };
  }, [p.spec, p.cam, glSize]);

  // 가림 마스크를 미리보기에 반영 (가구 캔버스를 가림 다각형 모양으로 지움)
  const maskCss = useMemo(() => {
    const polys = p.masks.occluders.concat(p.masks.protected);
    if (!polys.length) return undefined;
    const c = document.createElement("canvas");
    const s = Math.min(1, 1024 / Math.max(W, H));
    c.width = Math.round(W * s);
    c.height = Math.round(H * s);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-out";
    for (const m of polys) {
      g.beginPath();
      m.points.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
      g.closePath();
      g.fill();
    }
    return `url(${c.toDataURL()})`;
  }, [p.masks, W, H]);

  // 오버레이(가이드)
  useEffect(() => {
    const c = ovRef.current;
    if (!c) return;
    c.width = box.w;
    c.height = box.h;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, box.w, box.h);
    const s = box.w / W;
    const P = (u: number, v: number) => [u * s, v * s] as const;
    const cam = p.cam;
    if (p.viewMode === "layout" && cam) {
      for (const pl of p.placements) {
        const sel = pl.id === p.selected;
        const corners = boxCorners(pl).map((c) => project(cam, c));
        if (corners.some((q) => q.depth <= 0)) continue;
        g.strokeStyle = GUIDE;
        g.lineWidth = sel ? 2 : 1;
        g.globalAlpha = sel ? 1 : 0.6;
        const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        g.beginPath();
        for (const [a, b] of edges) {
          g.moveTo(...P(corners[a].u, corners[a].v));
          g.lineTo(...P(corners[b].u, corners[b].v));
        }
        g.stroke();
        // 바닥 면 채움 + 정면 표시
        g.fillStyle = sel ? "rgba(47,107,255,0.18)" : "rgba(47,107,255,0.08)";
        g.beginPath();
        corners.slice(0, 4).forEach((q, i) => (i ? g.lineTo(...P(q.u, q.v)) : g.moveTo(...P(q.u, q.v))));
        g.closePath();
        g.fill();
        const f = [corners[2], corners[3]];
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(...P(f[0].u, f[0].v));
        g.lineTo(...P(f[1].u, f[1].v));
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    if (p.tool === "calib") {
      // 바닥 50cm 격자 + 방 경계(보정 결과 육안 확인용)
      if (cam) {
        g.strokeStyle = "rgba(47,107,255,0.55)";
        g.lineWidth = 1;
        const xs = p.refPoints.map((r) => r.world[0]), zs = p.refPoints.map((r) => r.world[2]);
        const b = p.floorBounds ?? [[Math.min(...xs, 0) - 1, Math.min(...zs, 0) - 1], [Math.max(...xs, 0) + 1, Math.max(...zs, 0) + 1]];
        const bx = b.map((q) => q[0]), bz = b.map((q) => q[1]);
        const x0 = Math.floor(Math.min(...bx) * 2) / 2, x1 = Math.ceil(Math.max(...bx) * 2) / 2, z0 = Math.floor(Math.min(...bz) * 2) / 2, z1 = Math.ceil(Math.max(...bz) * 2) / 2;
        const line = (a: [number, number, number], bb: [number, number, number]) => {
          const steps = 20;
          g.beginPath();
          let pen = false;
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const q = project(cam, [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t]);
            if (q.depth <= 0.05) {
              pen = false;
              continue;
            }
            if (pen) g.lineTo(...P(q.u, q.v));
            else g.moveTo(...P(q.u, q.v));
            pen = true;
          }
          g.stroke();
        };
        for (let x = x0; x <= x1 + 1e-6; x += 0.5) line([x, 0, z0], [x, 0, z1]);
        for (let z = z0; z <= z1 + 1e-6; z += 0.5) line([x0, 0, z], [x1, 0, z]);
        if (p.floorBounds) {
          g.strokeStyle = "rgba(255,170,40,0.9)";
          g.lineWidth = 2;
          for (let i = 0; i < p.floorBounds.length; i++) {
            const a = p.floorBounds[i], bb = p.floorBounds[(i + 1) % p.floorBounds.length];
            line([a[0], 0, a[1]], [bb[0], 0, bb[1]]);
          }
        }
      }
      for (const cp of p.calibPoints) {
        const [x, y] = P(cp.u, cp.v);
        const active = cp.refId === p.activeRef;
        g.strokeStyle = cp.check ? "#ffb020" : GUIDE;
        g.fillStyle = "rgba(255,255,255,0.85)";
        g.lineWidth = active ? 3 : 2;
        g.beginPath();
        g.arc(x, y, active ? 9 : 7, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.beginPath();
        g.moveTo(x - 3, y);
        g.lineTo(x + 3, y);
        g.moveTo(x, y - 3);
        g.lineTo(x, y + 3);
        g.stroke();
        g.font = "600 12px system-ui";
        g.fillStyle = "#fff";
        g.strokeStyle = "rgba(0,0,0,0.7)";
        g.lineWidth = 3;
        g.strokeText(cp.refId + (cp.check ? " (검증)" : ""), x + 11, y - 9);
        g.fillText(cp.refId + (cp.check ? " (검증)" : ""), x + 11, y - 9);
        // 재투영 위치
        if (cam) {
          const r = p.refPoints.find((q) => q.id === cp.refId);
          if (r) {
            const q = project(cam, r.world);
            if (q.depth > 0) {
              const [qx, qy] = P(q.u, q.v);
              g.strokeStyle = "#ff3b30";
              g.lineWidth = 1.5;
              g.beginPath();
              g.moveTo(qx - 5, qy - 5);
              g.lineTo(qx + 5, qy + 5);
              g.moveTo(qx + 5, qy - 5);
              g.lineTo(qx - 5, qy + 5);
              g.stroke();
            }
          }
        }
      }
    }
    if (p.tool === "mask" || p.viewMode === "layout") {
      const drawPoly = (pts: [number, number][], color: string, closed: boolean) => {
        if (!pts.length) return;
        g.strokeStyle = color;
        g.fillStyle = color.replace("1)", "0.18)");
        g.lineWidth = 2;
        g.setLineDash(closed ? [] : [6, 4]);
        g.beginPath();
        pts.forEach(([u, v], i) => (i ? g.lineTo(...P(u, v)) : g.moveTo(...P(u, v))));
        if (closed) g.closePath();
        g.stroke();
        if (closed) g.fill();
        g.setLineDash([]);
        for (const [u, v] of pts) {
          g.beginPath();
          g.arc(...P(u, v), 3, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
        }
      };
      if (p.tool === "mask") {
        p.masks.occluders.forEach((m) => drawPoly(m.points, "rgba(255,149,0,1)", true));
        p.masks.protected.forEach((m) => drawPoly(m.points, "rgba(52,199,89,1)", true));
        drawPoly(p.maskDraft, p.maskType === "occluders" ? "rgba(255,149,0,1)" : "rgba(52,199,89,1)", false);
      }
    }
  }, [box, p.cam, p.placements, p.selected, p.tool, p.viewMode, p.calibPoints, p.activeRef, p.refPoints, p.masks, p.maskDraft, p.maskType, p.floorBounds, W]);

  const toImg = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const pick = (u: number, v: number): string | null => {
    if (!p.cam) return null;
    let best: { id: string; d: number } | null = null;
    for (const pl of p.placements) {
      const pr = boxCorners(pl).map((c) => project(p.cam!, c));
      if (pr.some((q) => q.depth <= 0)) continue;
      if (inPoly([u, v], hull(pr.map((q) => [q.u, q.v])))) {
        const d = Math.min(...pr.map((q) => q.depth));
        if (!best || d < best.d) best = { id: pl.id, d };
      }
    }
    return best?.id ?? null;
  };

  const onDown = (e: React.PointerEvent) => {
    const [u, v] = toImg(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (p.tool === "calib") {
      // 가까운 기존 점 드래그 또는 활성 기준점 지정
      const near = p.calibPoints.find((c) => Math.hypot(c.u - u, c.v - v) < 14 * (W / box.w));
      if (near) {
        drag.current = { id: "", start: [0, 0, 0], init: { x: 0, z: 0 }, rot: 0, mode: "move", sx: 0, dragRef: near.refId };
        return;
      }
      if (p.activeRef) p.onCalibPoint(p.activeRef, u, v);
      return;
    }
    if (p.tool === "mask") {
      if (e.detail >= 2 && p.maskDraft.length >= 3) p.onMaskClose();
      else p.onMaskPoint([Math.round(u), Math.round(v)]);
      return;
    }
    const id = pick(u, v);
    p.onSelect(id);
    if (!id || !p.cam) return;
    const hit = floorHit(p.cam, u, v);
    const pl = p.placements.find((x) => x.id === id)!;
    drag.current = { id, start: hit ?? [pl.position.x, 0, pl.position.z], init: { ...pl.position }, rot: pl.rotationDeg, mode: e.shiftKey || e.button === 2 ? "rotate" : "move", sx: e.clientX };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [u, v] = toImg(e);
    if (d.dragRef) {
      p.onCalibPoint(d.dragRef, Math.max(0, Math.min(W, u)), Math.max(0, Math.min(H, v)));
      return;
    }
    if (!p.cam) return;
    if (d.mode === "rotate") {
      p.onMove(d.id, d.init, Math.round(d.rot + (e.clientX - d.sx) * 0.5), false);
      return;
    }
    const hit = floorHit(p.cam, u, v);
    if (!hit) return;
    p.onMove(d.id, { x: +(d.init.x + hit[0] - d.start[0]).toFixed(4), z: +(d.init.z + hit[2] - d.start[2]).toFixed(4) }, undefined, false);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.dragRef) {
      const pl = p.placements.find((x) => x.id === d.id);
      if (pl) p.onMove(d.id, pl.position, pl.rotationDeg, true);
    }
  };

  const showComposite = p.viewMode === "composite" && p.compositeUrl;
  return (
    <div className="stage-scroll" ref={scrollRef}>
      <div className={`stage ${p.tool === "move" ? "move" : ""}`} style={{ width: box.w, height: box.h }} onContextMenu={(e) => e.preventDefault()}>
        <img src={p.zoom === "100" ? p.masterUrl : p.imgUrl} alt="" draggable={false} />
        <canvas
          ref={glRef}
          width={glSize.w}
          height={glSize.h}
          style={{ visibility: p.viewMode === "original" || showComposite ? "hidden" : "visible", WebkitMaskImage: maskCss, maskImage: maskCss, WebkitMaskSize: "100% 100%", maskSize: "100% 100%" } as any}
        />
        {showComposite && <img src={p.compositeUrl!} alt="합성 결과" draggable={false} style={p.split !== null ? { clipPath: `inset(0 0 0 ${p.split * 100}%)` } : undefined} />}
        {showComposite && p.split !== null && <div className="split" style={{ left: `${p.split * 100}%` }} />}
        <canvas ref={ovRef} className="overlay" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
    </div>
  );
}

export { footprint };
