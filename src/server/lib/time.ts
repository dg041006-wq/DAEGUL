// 시간 유틸: 저장은 UTC, 계산·표시 기준은 조직 시간대(기본 Asia/Seoul, UTC+9 고정·서머타임 없음)
import type { OrgSettings } from "../../shared/domain.js";

const KST_OFFSET_MIN = 9 * 60;

/** KST 기준 날짜(YYYY-MM-DD)의 00:00을 UTC Date로 */
export function kstStartOfDay(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - KST_OFFSET_MIN * 60_000);
}

export function toKstParts(d: Date) {
  const k = new Date(d.getTime() + KST_OFFSET_MIN * 60_000);
  return {
    y: k.getUTCFullYear(),
    m: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
    dow: k.getUTCDay(),
    minutes: k.getUTCHours() * 60 + k.getUTCMinutes(),
  };
}

export function kstDateString(d: Date): string {
  const p = toKstParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function addDays(dateStr: string, n: number): string {
  const t = kstStartOfDay(dateStr).getTime() + n * 86_400_000;
  return kstDateString(new Date(t));
}

/** 기간 파라미터 해석: from/to(YYYY-MM-DD, KST, to 포함) → [start, end) UTC */
export function resolvePeriod(from?: string, to?: string, defaultDays = 7) {
  const today = kstDateString(new Date());
  const toStr = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today;
  const fromStr = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : addDays(toStr, -(defaultDays - 1));
  return { from: fromStr, to: toStr, start: kstStartOfDay(fromStr), end: kstStartOfDay(addDays(toStr, 1)) };
}

function hm(s: string) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** 두 시각 사이의 '영업시간' 분 수 (조직 영업시간 설정 기준) */
export function businessMinutesBetween(a: Date, b: Date, bh: OrgSettings["businessHours"]): number {
  if (b <= a) return 0;
  const start = hm(bh.start);
  const end = hm(bh.end);
  let total = 0;
  let dayStr = kstDateString(a);
  const lastDay = kstDateString(b);
  // 안전 상한: 400일
  for (let i = 0; i < 400; i++) {
    const dayStart = kstStartOfDay(dayStr).getTime();
    const dow = toKstParts(new Date(dayStart)).dow;
    if (bh.days.includes(dow)) {
      const winStart = dayStart + start * 60_000;
      const winEnd = dayStart + end * 60_000;
      const s = Math.max(winStart, a.getTime());
      const e = Math.min(winEnd, b.getTime());
      if (e > s) total += (e - s) / 60_000;
    }
    if (dayStr === lastDay) break;
    dayStr = addDays(dayStr, 1);
  }
  return Math.round(total);
}

/** 기준 시각에서 N영업일 이후 (해당 일의 영업 종료 시각) */
export function addBusinessDays(from: Date, n: number, bh: OrgSettings["businessHours"]): Date {
  let dayStr = kstDateString(from);
  let count = 0;
  for (let i = 0; i < 60 && count < n; i++) {
    dayStr = addDays(dayStr, 1);
    const dow = toKstParts(kstStartOfDay(dayStr)).dow;
    if (bh.days.includes(dow)) count++;
  }
  return new Date(kstStartOfDay(dayStr).getTime() + hm(bh.end) * 60_000);
}
