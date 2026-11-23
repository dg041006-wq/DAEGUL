// 스튜디오 API 클라이언트
export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: any) {
    super(message);
  }
}

type SaveListener = (s: { state: "idle" | "saving" | "saved" | "error"; message?: string }) => void;
const listeners = new Set<SaveListener>();
export const onSave = (l: SaveListener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = (s: Parameters<SaveListener>[0]) => listeners.forEach((l) => l(s));
let pending = 0;

async function call<T>(method: string, url: string, body?: unknown, raw?: { data: Blob | ArrayBuffer; type: string }): Promise<T> {
  const mutating = method !== "GET";
  if (mutating) {
    pending++;
    emit({ state: "saving" });
  }
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "x-requested-with": "stayscene", ...(raw ? { "content-type": raw.type } : body !== undefined ? { "content-type": "application/json" } : {}) },
      body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401) window.dispatchEvent(new Event("studio:unauthorized"));
      throw new ApiError(res.status, data?.error ?? `요청 실패 (${res.status})`, data);
    }
    if (mutating) emit({ state: --pending > 0 ? "saving" : "saved" });
    return data as T;
  } catch (e: any) {
    if (mutating) {
      pending = Math.max(0, pending - 1);
      emit({ state: "error", message: e instanceof ApiError ? e.message : "네트워크 연결 실패 — 저장되지 않았습니다" });
    }
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "네트워크에 연결할 수 없습니다.");
  }
}

export const sget = <T = any>(u: string) => call<T>("GET", u);
export const spost = <T = any>(u: string, b: unknown = {}) => call<T>("POST", u, b);
export const sput = <T = any>(u: string, b: unknown) => call<T>("PUT", u, b);
export const spatch = <T = any>(u: string, b: unknown) => call<T>("PATCH", u, b);
export const sdel = <T = any>(u: string) => call<T>("DELETE", u);
export const supload = <T = any>(u: string, file: Blob, type?: string) => call<T>("POST", u, undefined, { data: file, type: type || file.type || "application/octet-stream" });
export const fileUrl = (id: string) => `/api/studio/files/${id}`;
