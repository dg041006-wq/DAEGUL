import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: any) {
    super(message);
  }
}

/** 저장 상태 전역 표시 (저장 중 / 저장됨 / 실패) */
export type SaveState = { state: "idle" | "saving" | "saved" | "error"; message?: string };
let pending = 0;
function emitSave(s: SaveState) {
  window.dispatchEvent(new CustomEvent("ss:save", { detail: s }));
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const mutating = method !== "GET";
  if (mutating) {
    pending++;
    emitSave({ state: "saving" });
  }
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-requested-with": "stayscene", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 && !url.startsWith("/api/auth")) window.dispatchEvent(new Event("ss:unauthorized"));
      throw new ApiError(res.status, data?.error ?? `요청 실패 (${res.status})`, data);
    }
    if (mutating) emitSave({ state: --pending > 0 ? "saving" : "saved" });
    return data as T;
  } catch (e: any) {
    if (mutating) {
      pending = Math.max(0, pending - 1);
      const offline = !navigator.onLine || e instanceof TypeError;
      emitSave({ state: "error", message: offline ? "네트워크 끊김 — 저장되지 않았습니다" : e.status === 409 ? "다른 기기에서 먼저 수정됨 — 새로 불러왔습니다" : e.message });
      if (e.status === 409) window.dispatchEvent(new Event("ss:resync"));
    }
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "네트워크에 연결할 수 없습니다.");
  }
}

export const get = <T = any>(url: string) => api<T>("GET", url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>("POST", url, body);
export const patch = <T = any>(url: string, body: unknown) => api<T>("PATCH", url, body);
export const put = <T = any>(url: string, body: unknown) => api<T>("PUT", url, body);
export const del = <T = any>(url: string) => api<T>("DELETE", url);

/**
 * GET + 실시간 변경 반영. 서버 변경 알림(SSE)이 오면 다시 불러오고,
 * 재연결 시 전체 재동기화. SSE가 막힌 환경을 위해 느린 주기 재조회도 유지.
 */
export function useApi<T = any>(url: string | null, opts: { poll?: number; tables?: string[] } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;
  const tablesRef = useRef(opts.tables);
  tablesRef.current = opts.tables;
  const load = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      const d = await get<T>(urlRef.current);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    setData(null);
    load();
    if (!url) return;
    let timer: any = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(() => document.visibilityState === "visible" && load(), 350);
    };
    const onChange = (e: Event) => {
      const t = (e as CustomEvent).detail?.t as string | undefined;
      if (!tablesRef.current || !t || tablesRef.current.includes(t)) debounced();
    };
    const onResync = () => load();
    const onVisible = () => document.visibilityState === "visible" && load();
    window.addEventListener("ss:change", onChange);
    window.addEventListener("ss:resync", onResync);
    document.addEventListener("visibilitychange", onVisible);
    const poll = opts.poll ?? 60000;
    const iv = poll ? setInterval(() => document.visibilityState === "visible" && load(), poll) : null;
    return () => {
      clearTimeout(timer);
      if (iv) clearInterval(iv);
      window.removeEventListener("ss:change", onChange);
      window.removeEventListener("ss:resync", onResync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, load, opts.poll]);
  return { data, error, loading, reload: load, setData };
}

export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
