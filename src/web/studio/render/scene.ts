// 공용 three.js 장면 — 편집기 미리보기와 서버 렌더 워커(헤드리스 Chromium)가 같은 코드를 쓴다.
// 레이어: (1) 가구 RGBA(프리멀티플라이드) (2) 그림자 알파(섀도 캐처 = ShadowMaterial + 접지 그림자)
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface RenderCamera {
  width: number;
  height: number;
  f: number;
  cx: number;
  cy: number;
  R: number[]; // world_from_cam row-major 3x3
  C: number[];
}

export interface RenderPlacement {
  id: string;
  kind: "model3d" | "photo";
  url: string; // GLB 또는 컷아웃 PNG
  dims: { w: number; d: number; h: number }; // cm
  position: { x: number; z: number };
  rotationDeg: number;
  frontAxis?: "+Z" | "-Z" | "+X" | "-X";
  photoFacingDeg?: number; // 사진 기반: 참조 사진이 찍힌 방위(가구 기준)
}

export interface RenderLighting {
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunIntensity: number;
  colorTempK: number;
  softness: number;
  ambient: number;
  shadowStrength: number;
  contactShadow: number;
}

export interface SceneSpec {
  camera: RenderCamera;
  placements: RenderPlacement[];
  lighting: RenderLighting;
  exposure: number; // EV
  envUrl?: string | null; // 환경광용 사진(미리보기 해상도)
}

export function kelvinToRGB(k: number): THREE.Color {
  // Tanner Helland 근사
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (x: number) => Math.min(255, Math.max(0, x)) / 255;
  // 6500K 기준 정규화(중립)
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

const gltfCache = new Map<string, Promise<THREE.Group>>();
const texCache = new Map<string, Promise<THREE.Texture>>();

export function loadGlb(url: string): Promise<THREE.Group> {
  if (!gltfCache.has(url)) {
    gltfCache.set(
      url,
      new Promise((resolve, reject) => {
        new GLTFLoader().load(url, (g) => resolve(g.scene), undefined, (e) => reject(e));
      }),
    );
  }
  return gltfCache.get(url)!.then((g) => g.clone(true));
}

export function loadTexture(url: string): Promise<THREE.Texture> {
  if (!texCache.has(url)) {
    texCache.set(
      url,
      new Promise((resolve, reject) => {
        new THREE.TextureLoader().load(
          url,
          (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            resolve(t);
          },
          undefined,
          (e) => reject(e),
        );
      }),
    );
  }
  return texCache.get(url)!;
}

export function applyCamera(cam: THREE.PerspectiveCamera, c: RenderCamera) {
  cam.fov = (2 * Math.atan(c.height / 2 / c.f) * 180) / Math.PI;
  cam.aspect = c.width / c.height;
  cam.near = 0.05;
  cam.far = 200;
  const R = c.R;
  const m = new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
  cam.quaternion.setFromRotationMatrix(m);
  cam.position.set(c.C[0], c.C[1], c.C[2]);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
}

function frontRotation(axis: RenderPlacement["frontAxis"]) {
  switch (axis) {
    case "-Z":
      return Math.PI;
    case "+X":
      return -Math.PI / 2;
    case "-X":
      return Math.PI / 2;
    default:
      return 0;
  }
}

function contactShadowTexture() {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      // 둥근 사각형 거리장: 가장자리 0.18 밖으로 부드럽게 감쇠
      const u = Math.abs((x + 0.5) / s - 0.5) * 2, v = Math.abs((y + 0.5) / s - 0.5) * 2;
      const inner = 0.72;
      const dx = Math.max(0, u - inner) / (1 - inner), dy = Math.max(0, v - inner) / (1 - inner);
      const d = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - d, 2.2);
      img.data[(y * s + x) * 4 + 3] = Math.round(a * 255);
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  return t;
}

export interface BuiltScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  furnitureRoot: THREE.Group;
  shadowFloor: THREE.Mesh;
  contactGroup: THREE.Group;
  sun: THREE.DirectionalLight;
  dispose: () => void;
  objects: Map<string, THREE.Object3D>;
}

async function buildPlacement(p: RenderPlacement): Promise<THREE.Object3D> {
  const holder = new THREE.Group();
  holder.name = p.id;
  if (p.kind === "model3d") {
    const model = await loadGlb(p.url);
    model.rotation.y = frontRotation(p.frontAxis);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const inner = new THREE.Group();
    model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    inner.add(model);
    // 비규격 크기면 축별 스케일, 규격이면 측정값=선언값이라 1에 가까움
    inner.scale.set(p.dims.w / 100 / size.x, p.dims.h / 100 / size.y, p.dims.d / 100 / size.z);
    model.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    holder.add(inner);
  } else {
    const tex = await loadTexture(p.url);
    const img: any = tex.image;
    const aspect = img.width / img.height;
    // 참조 사진의 실루엣 높이 = 가구 높이로 맞추고 폭은 사진 비율을 따른다
    const h = p.dims.h / 100;
    const w = h * aspect;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h / 2, 0);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, alphaTest: 0.02, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(geo, mat);
    plane.userData.billboard = true;
    holder.add(plane);
    // 그림자용 보이지 않는 상자
    const box = new THREE.Mesh(new THREE.BoxGeometry(p.dims.w / 100, h, p.dims.d / 100), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    box.position.y = h / 2;
    box.castShadow = true;
    box.userData.shadowProxy = true;
    holder.add(box);
  }
  holder.position.set(p.position.x, 0, p.position.z);
  holder.rotation.y = (p.rotationDeg * Math.PI) / 180;
  return holder;
}

/** 사진 기반 가구: 평면을 카메라 쪽으로 돌린다(수평 빌보드) */
export function orientBillboards(root: THREE.Object3D, cam: THREE.Camera) {
  root.traverse((o: any) => {
    if (!o.userData?.billboard) return;
    const holder = o.parent as THREE.Object3D;
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const hp = new THREE.Vector3().setFromMatrixPosition(holder.matrixWorld);
    const ang = Math.atan2(camPos.x - hp.x, camPos.z - hp.z);
    o.rotation.y = ang - holder.rotation.y;
  });
}

export async function buildScene(spec: SceneSpec): Promise<BuiltScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  applyCamera(camera, spec.camera);

  const furnitureRoot = new THREE.Group();
  scene.add(furnitureRoot);
  const objects = new Map<string, THREE.Object3D>();
  for (const p of spec.placements) {
    const o = await buildPlacement(p);
    objects.set(p.id, o);
    furnitureRoot.add(o);
  }
  furnitureRoot.updateMatrixWorld(true);
  orientBillboards(furnitureRoot, camera);

  // 조명: 월드 공간 공유
  const L = spec.lighting;
  const sun = new THREE.DirectionalLight(kelvinToRGB(L.colorTempK), L.sunIntensity * 1.8);
  const az = (L.sunAzimuthDeg * Math.PI) / 180, el = (L.sunElevationDeg * Math.PI) / 180;
  const bounds = new THREE.Box3().setFromObject(furnitureRoot);
  const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  center.y = 0;
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  sun.position.copy(center).addScaledVector(dir, 12);
  sun.target.position.copy(center);
  sun.castShadow = true;
  const ext = bounds.isEmpty() ? 4 : Math.max(2, bounds.getSize(new THREE.Vector3()).length() + 1.5);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -ext;
  sc.right = ext;
  sc.top = ext;
  sc.bottom = -ext;
  sc.near = 0.5;
  sc.far = 30;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.01;
  sun.shadow.radius = 1 + L.softness * 18;
  sun.shadow.blurSamples = 24;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xf4f1ec, 0x6b5a4c, L.ambient * 1.6);
  scene.add(hemi);

  // 섀도 캐처
  const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: L.shadowStrength, color: 0x000000 }));
  shadowFloor.rotation.x = -Math.PI / 2;
  shadowFloor.receiveShadow = true;
  scene.add(shadowFloor);

  // 접지 그림자(가구 바닥면 아래 부드러운 어둠)
  const contactGroup = new THREE.Group();
  const ctex = contactShadowTexture();
  for (const p of spec.placements) {
    const o = objects.get(p.id)!;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry((p.dims.w / 100) * 1.12, (p.dims.d / 100) * 1.15),
      new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: ctex, transparent: true, opacity: L.contactShadow * 0.55, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(o.position.x, 0.002, o.position.z);
    m.rotation.z = o.rotation.y;
    contactGroup.add(m);
  }
  scene.add(contactGroup);

  let envTex: THREE.Texture | null = null;
  if (spec.envUrl) {
    try {
      envTex = (await loadTexture(spec.envUrl)).clone();
      envTex.mapping = THREE.EquirectangularReflectionMapping;
      envTex.needsUpdate = true;
    } catch {
      envTex = null;
    }
  }
  if (envTex) {
    scene.environment = envTex;
    (scene as any).environmentIntensity = 0.5 * L.ambient;
  }

  return {
    scene,
    camera,
    furnitureRoot,
    shadowFloor,
    contactGroup,
    sun,
    objects,
    dispose: () => {
      scene.traverse((o: any) => {
        if (o.geometry) o.geometry.dispose?.();
      });
    },
  };
}

export function makeRenderer(canvas?: HTMLCanvasElement | OffscreenCanvas) {
  const r = new THREE.WebGLRenderer({ canvas: canvas as any, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.VSMShadowMap;
  r.setClearColor(0x000000, 0);
  return r;
}

type Pass = "furniture" | "shadow" | "combined";

/** 패스별 표시 설정 */
export function setPass(b: BuiltScene, pass: Pass) {
  b.shadowFloor.visible = pass !== "furniture";
  b.contactGroup.visible = pass !== "furniture";
  b.furnitureRoot.traverse((o: any) => {
    if (!o.isMesh) return;
    if (o.userData.shadowProxy) return; // 항상 색 없음
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      m.colorWrite = pass !== "shadow";
      m.needsUpdate = true;
    }
  });
}

/** 타일 렌더 → RGBA 바이트(상하 정렬: 위→아래) */
export function renderTile(r: THREE.WebGLRenderer, b: BuiltScene, full: { width: number; height: number }, x: number, y: number, w: number, h: number, exposure: number): Uint8Array {
  r.setSize(w, h, false);
  r.toneMappingExposure = Math.pow(2, exposure);
  b.camera.setViewOffset(full.width, full.height, x, y, w, h);
  b.camera.updateProjectionMatrix();
  r.setClearColor(0x000000, 0);
  r.clear();
  r.render(b.scene, b.camera);
  const gl = r.getContext();
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) out.set(buf.subarray((h - 1 - row) * w * 4, (h - row) * w * 4), row * w * 4);
  b.camera.clearViewOffset();
  return out;
}
