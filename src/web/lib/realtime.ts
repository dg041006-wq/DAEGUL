// 서버 변경 알림(SSE) 연결 관리. 연결 상태를 화면에 보여주고, 끊겼다 다시 연결되면 전체 재동기화한다.
import { useEffect, useState } from "react";

export type ConnState = "connecting" | "live" | "offline";
let es: EventSource | null = null;
let state: ConnState = "connecting";
let serverBuild: string | null = null;
let wasDown = false;
let retry: any = null;
const subs = new Set<() => void>();
const setState = (s: ConnState) => {
  state = s;
  subs.forEach((f) => f());
};

export function startRealtime() {
  if (es) return;
  const open = () => {
    es = new EventSource("/api/stream", { withCredentials: true });
    es.addEventListener("hello", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        if (serverBuild && d.build !== serverBuild) window.dispatchEvent(new CustomEvent("ss:newversion", { detail: d.build }));
        serverBuild = d.build;
      } catch {
        /* ignore */
      }
      setState("live");
      if (wasDown) window.dispatchEvent(new Event("ss:resync")); // 끊긴 동안의 변경 가져오기
      wasDown = false;
    });
    es.onmessage = (e) => {
      try {
        window.dispatchEvent(new CustomEvent("ss:change", { detail: JSON.parse(e.data) }));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      wasDown = true;
      setState("offline");
      es?.close();
      es = null;
      clearTimeout(retry);
      retry = setTimeout(open, navigator.onLine ? 3000 : 8000);
    };
  };
  open();
  window.addEventListener("online", () => {
    if (!es) {
      clearTimeout(retry);
      open();
    }
  });
  window.addEventListener("offline", () => setState("offline"));
}

export function stopRealtime() {
  es?.close();
  es = null;
  clearTimeout(retry);
}

export function useConnState() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  return state;
}
