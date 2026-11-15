const TZ = "Asia/Seoul";

export function fmtDateTime(v: string | null | undefined) {
  if (!v) return "-";
  return new Date(v).toLocaleString("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
export function fmtDate(v: string | null | undefined) {
  if (!v) return "-";
  return new Date(v).toLocaleDateString("ko-KR", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" });
}
export function fmtTime(v: string | null | undefined) {
  if (!v) return "";
  return new Date(v).toLocaleTimeString("ko-KR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}
export function fmtRelative(v: string | null | undefined) {
  if (!v) return "-";
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}
export function fmtMinutes(m: number | null | undefined) {
  if (m == null) return "-";
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}
export function fmtWon(v: number | null | undefined) {
  if (v == null) return "-";
  return `${v.toLocaleString("ko-KR")}원`;
}
export function pct(n: number | null | undefined) {
  if (n == null) return "-";
  return `${Math.round(n * 1000) / 10}%`;
}
/** 브라우저 로컬 입력(datetime-local) → KST 기준 ISO */
export function kstLocalToIso(local: string) {
  return new Date(`${local}:00+09:00`).toISOString();
}
export function todayKst() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function daysAgoKst(n: number) {
  return new Date(Date.now() + 9 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);
}
