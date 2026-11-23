// 편집기 미리보기 렌더러 — 워커와 같은 scene.ts. 드래그 중에는 장면을 다시 만들지 않고 변환만 갱신한다.
import * as THREE from "three";
import { applyCamera, buildScene, makeRenderer, orientBillboards, setPass, type BuiltScene, type RenderCamera, type SceneSpec } from "../render/scene";

function structureKey(spec: SceneSpec) {
  return JSON.stringify({ p: spec.placements.map((p) => [p.id, p.url, p.kind, p.dims, p.frontAxis]), l: spec.lighting, e: spec.envUrl });
}

export class PreviewRenderer {
  renderer: THREE.WebGLRenderer;
  built: BuiltScene | null = null;
  key = "";
  building: Promise<void> | null = null;
  pendingSpec: SceneSpec | null = null;
  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = makeRenderer(canvas);
    this.renderer.shadowMap.autoUpdate = true;
  }

  async sync(spec: SceneSpec) {
    const key = structureKey(spec);
    if (key !== this.key || !this.built) {
      this.pendingSpec = spec;
      if (this.building) return this.building;
      this.building = (async () => {
        try {
          while (this.pendingSpec) {
            const s = this.pendingSpec;
            this.pendingSpec = null;
            const b = await buildScene({ ...s, quality: "preview" });
            this.built?.dispose();
            this.built = b;
            this.key = structureKey(s);
            this.updateTransforms(s);
          }
          (window as any).__studioPreviewReady = true; // E2E 대기용
        } catch (e) {
          console.error("미리보기 장면 생성 실패", e);
          this.key = "";
        } finally {
          this.building = null;
        }
      })();
      return this.building;
    }
    this.updateTransforms(spec);
  }

  updateTransforms(spec: SceneSpec) {
    const b = this.built;
    if (!b) return;
    spec.placements.forEach((p, i) => {
      const o = b.objects.get(p.id);
      if (!o) return;
      o.position.set(p.position.x, 0, p.position.z);
      o.rotation.y = (p.rotationDeg * Math.PI) / 180;
      const c = b.contactGroup.children[i];
      if (c) {
        c.position.set(p.position.x, 0.002, p.position.z);
        c.rotation.z = o.rotation.y;
      }
    });
    b.furnitureRoot.updateMatrixWorld(true);
    // 그림자 카메라를 가구 쪽으로 다시 맞춤
    const bounds = new THREE.Box3().setFromObject(b.furnitureRoot);
    if (!bounds.isEmpty()) {
      const c = bounds.getCenter(new THREE.Vector3());
      c.y = 0;
      const dir = b.sun.position.clone().sub(b.sun.target.position).normalize();
      b.sun.target.position.copy(c);
      b.sun.position.copy(c).addScaledVector(dir, 12);
      b.sun.target.updateMatrixWorld();
    }
  }

  render(cam: RenderCamera, width: number, height: number, exposure = 0) {
    const b = this.built;
    if (!b) return;
    this.renderer.setSize(width, height, false);
    this.renderer.toneMappingExposure = Math.pow(2, exposure);
    applyCamera(b.camera, cam);
    orientBillboards(b.furnitureRoot, b.camera);
    setPass(b, "combined");
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(b.scene, b.camera);
  }

  dispose() {
    this.built?.dispose();
    this.renderer.dispose();
  }
}

/** 썸네일: 하나의 렌더러로 여러 시점을 그린 뒤 2D 캔버스로 복사 */
let thumbR: PreviewRenderer | null = null;
export async function renderThumb(target: HTMLCanvasElement, photo: HTMLImageElement | null, spec: SceneSpec | null, cam: RenderCamera | null) {
  const w = target.width, h = target.height;
  const g = target.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  if (photo?.complete && photo.naturalWidth) g.drawImage(photo, 0, 0, w, h);
  if (!spec || !cam || !spec.placements.length) return;
  if (!thumbR) thumbR = new PreviewRenderer(document.createElement("canvas"));
  await thumbR.sync({ ...spec, envUrl: null });
  thumbR.render(cam, w, h, spec.exposure);
  g.drawImage(thumbR.canvas, 0, 0, w, h);
}
