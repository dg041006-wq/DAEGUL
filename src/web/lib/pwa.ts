// PWA: 서비스 워커 등록, 푸시 구독, 로그아웃 시 캐시·구독 정리, 설치 상태 확인
import { get, post } from "./api";

export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

function b64ToBytes(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** 알림 권한 요청 → 구독 → 서버 저장. 결과 상태를 그대로 반환(가짜 성공 없음) */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (!pushSupported()) return { ok: false, message: isIOS() && !isStandalone() ? "아이폰은 먼저 '홈 화면에 추가'로 설치한 앱에서 알림을 켤 수 있습니다." : "이 브라우저는 웹 푸시를 지원하지 않습니다. 알림함에서 확인하세요." };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, message: perm === "denied" ? "알림이 차단되어 있습니다. 브라우저/기기 설정에서 이 사이트 알림을 허용하세요." : "알림 권한 요청이 닫혔습니다." };
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSW());
  if (!reg) return { ok: false, message: "서비스 워커를 등록하지 못했습니다." };
  await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>("/api/push/vapid");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
  const j = sub.toJSON() as any;
  await post("/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys });
  return { ok: true, message: "이 기기에서 푸시 알림을 받습니다." };
}

/** 공용 PC 대비: 로그아웃 시 이 기기의 푸시 구독 해지 + 캐시 삭제 */
export async function cleanupOnLogout() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    /* ignore */
  }
  try {
    if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.clear();
    localStorage.removeItem("ss:lastSeen");
  } catch {
    /* ignore */
  }
}
