import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "x-requested-with": "stayscene", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth")) window.dispatchEvent(new Event("ss:unauthorized"));
    throw new ApiError(res.status, data?.error ?? `요청 실패 (${res.status})`);
  }
  return data as T;
}

export const get = <T = any>(url: string) => api<T>("GET", url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>("POST", url, body);
export const patch = <T = any>(url: string, body: unknown) => api<T>("PATCH", url, body);
export const del = <T = any>(url: string) => api<T>("DELETE", url);

/** GET + 주기적 재조회(기본 20초) — PC/모바일이 같은 서버 상태를 보도록 */
export function useApi<T = any>(url: string | null, opts: { poll?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;
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
    const poll = opts.poll ?? 20000;
    if (!poll) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, poll);
    return () => clearInterval(t);
  }, [url, load, opts.poll]);
  return { data, error, loading, reload: load, setData };
}
