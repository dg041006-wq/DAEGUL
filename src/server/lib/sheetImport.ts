// 스테이신 업무 시트(달력형 예약표) 가져오기.
// 원칙: 날짜·금액·계약/입금 상태를 추정하지 않는다. 해석이 불확실한 값은 원문 보존 + 플래그로 표시하고,
// 대표가 미리보기에서 확인한 뒤 확정한다. 원본 파일은 수정하지 않는다(읽기 전용 파싱).
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { q, q1, tx } from "../db/pool.js";
import { addDays, kstDateString, kstStartOfDay } from "./time.js";
import { DEFAULT_CHECKLIST } from "../../shared/domain.js";

const defaultChecklist = () => JSON.stringify([
  ...DEFAULT_CHECKLIST.pre.map((label, i) => ({ id: `pre${i}`, phase: "pre", label, done: false, done_at: null })),
  ...DEFAULT_CHECKLIST.post.map((label, i) => ({ id: `post${i}`, phase: "post", label, done: false, done_at: null })),
]);

export type Cell = string | number | Date | { time: string } | null;
export interface Grid {
  name: string;
  rows: Cell[][]; // 0-based, rows[0] = 1행
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export const FLAG_LABELS: Record<string, string> = {
  date_inherited: "날짜 칸이 비어 있어 바로 위 날짜 행에 이어진 것으로 보았습니다 (확인 필요)",
  weekday_mismatch: "시트의 요일이 실제 날짜의 요일과 다릅니다",
  no_date_unscheduled: "'미지정 예약' 구역 — 날짜 없음",
  contact_column_used_as_time: "연락처 칸에 시간이 적혀 있어 시간으로 옮겼습니다",
  ambiguous_value_in_contact: "연락처 칸 값의 의미가 불분명합니다 (원문 보존)",
  invalid_phone: "연락처가 불완전한 전화번호입니다",
  time_unparsed: "시간 표기를 확정할 수 없어 원문만 보존했습니다",
  zero_price: "단가가 0원입니다 (무상/미정 여부 확인)",
  negative_amount: "단가가 음수입니다 (환불·AS 등 확인 필요) — 금액으로 반영하지 않음",
  price_missing: "단가가 없습니다",
  customer_missing: "예약자명이 없습니다",
  status_missing: "진행 상태가 비어 있습니다",
  status_paid_claim: "진행 상태 '입금완료' — 입금 금액·일자가 없어 '확인 필요 입금'으로만 기록",
  status_done_payment_unknown: "진행 상태 '완료' — 입금 여부는 알 수 없음",
  status_unknown: "진행 상태 값을 알 수 없습니다",
  extra_columns: "제목 없는 열(M~O)에 값이 있어 메모로 보존했습니다",
  possible_payment_in_notes: "메모에 입금/선금으로 보이는 내용이 있습니다 (입금 기록은 만들지 않음)",
  possible_cost_in_notes: "메모에 외주비/비용으로 보이는 내용이 있습니다 (비용 기록은 만들지 않음)",
  cash_receipt_mentioned: "현금영수증 언급",
  duplicate_in_file: "같은 날짜·장소·고객·단가 행이 파일 안에 중복됩니다",
  possible_repeat_visit: "같은 고객·장소의 다른 날짜 행이 있습니다 (재방문/연속 작업/중복 확인)",
  work_type_missing: "구분(촬영/브랜딩/기타)이 비어 있습니다",
  classification_uncertain: "고객 작업인지 개인/사업 일정인지 불분명합니다",
};

const s = (v: Cell): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return v.time;
  return String(v).trim();
};
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** exceljs로 읽기 (수식이 있으면 계산 결과 값을 사용) */
export async function readXlsx(buf: Buffer): Promise<Grid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const grids: Grid[] = [];
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    const maxCol = Math.min(ws.columnCount, 40);
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= maxCol; c++) {
        let v: any = row.getCell(c).value;
        if (v && typeof v === "object" && !(v instanceof Date)) {
          if ("result" in v) v = v.result; // 수식 결과
          else if ("richText" in v) v = v.richText.map((t: any) => t.text).join("");
          else if ("text" in v) v = v.text;
          else if ("hyperlink" in v) v = v.hyperlink;
        }
        if (v instanceof Date && v.getUTCFullYear() < 1901) {
          // 시간만 입력된 셀 (1899-12-30 기준)
          v = { time: `${String(v.getUTCHours()).padStart(2, "0")}:${String(v.getUTCMinutes()).padStart(2, "0")}` };
        }
        if (typeof v === "string" && !v.trim()) v = null;
        cells.push(v ?? null);
      }
      rows.push(cells);
    }
    grids.push({ name: ws.name, rows });
  });
  return grids;
}

interface Columns {
  date: number;
  weekday: number;
  persons: Array<{ col: number; name: string }>;
  kind: number;
  address: number;
  customer: number;
  contact: number;
  pkg: number;
  price: number;
  notes: number;
  status: number;
  extras: number[];
  headerRow: number;
}

function detectColumns(g: Grid): Columns | null {
  for (let r = 0; r < Math.min(g.rows.length, 15); r++) {
    const row = g.rows[r].map(s);
    const idx = (name: string) => row.findIndex((v) => v.replace(/\s/g, "") === name.replace(/\s/g, ""));
    const address = idx("주소");
    const customer = idx("예약자명");
    const price = idx("단가");
    if (address < 0 || customer < 0 || price < 0) continue;
    const status = idx("진행 상태");
    const persons: Array<{ col: number; name: string }> = [];
    // 날짜·요일 다음, 구분 앞의 이름 칸 (예: 한대규, 박상준) = 개인 일정 칸
    for (let c = 2; c < address - 1; c++) if (row[c]) persons.push({ col: c, name: row[c] });
    const last = Math.max(status, idx("특이사항"), price);
    const extras: number[] = [];
    for (let c = last + 1; c < Math.min(row.length + 6, 20); c++) extras.push(c);
    return {
      date: 0,
      weekday: 1,
      persons,
      kind: address - 1,
      address,
      customer,
      contact: idx("연락처"),
      pkg: idx("패키지"),
      price,
      notes: idx("특이사항"),
      status,
      extras,
      headerRow: r,
    };
  }
  return null;
}

const PHONE = /^0\d{1,2}-?\d{3,4}-?\d{4}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseTime(raw: string): string | null {
  // 확정 가능한 표기만: 'HH:MM', '오후 15:30', '13:30'
  const m = raw.match(/(?:^|\s|오전|오후)\s*([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  if (!m) return null;
  let h = Number(m[1]);
  if (/오후/.test(raw) && h < 12) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export interface ParsedRow {
  sheet: string;
  row: number; // 시트 행 번호(1부터)
  classification: "booking" | "personal" | "business" | "note" | "empty_day" | "header";
  raw: Record<string, string>;
  parsed: {
    date: string | null;
    section: string | null;
    workType: string | null;
    title: string | null;
    address: string | null;
    customerName: string | null;
    phone: string | null;
    email: string | null;
    startTime: string | null;
    timeRaw: string | null;
    package: string | null;
    listedPrice: number | null;
    statusRaw: string | null;
    projectStatus: string;
    paidClaim: boolean;
    notes: string | null;
    cashReceipt: string | null;
    personBlocks: Array<{ person: string; label: string }>;
    blockLabel: string | null;
  };
  flags: string[];
  decision: "import" | "skip" | "review";
  dedupeKey: string | null;
}

export function analyzeGrid(g: Grid, todayStr = kstDateString(new Date())): { columns: Columns | null; rows: ParsedRow[] } {
  const cols = detectColumns(g);
  if (!cols) return { columns: null, rows: [] };
  const out: ParsedRow[] = [];
  let section: string | null = null;
  let lastDate: string | null = null;
  for (let r = cols.headerRow + 1; r < g.rows.length; r++) {
    const row = g.rows[r];
    const val = (c: number) => (c >= 0 && c < row.length ? row[c] : null);
    const raw: Record<string, string> = {};
    row.forEach((v, i) => {
      if (v != null && s(v) !== "") raw[String.fromCharCode(65 + i)] = s(v);
    });
    if (!Object.keys(raw).length) continue;
    const a = val(cols.date);
    // 구역 제목 (예: '미지정 예약', '예약')
    if (typeof a === "string" && Object.keys(raw).length === 1) {
      section = a.includes("미지정") ? "unscheduled" : "calendar";
      out.push(mk(g.name, r + 1, "header", raw, { section }, [], "skip", null));
      continue;
    }
    const flags: string[] = [];
    let date: string | null = null;
    if (a instanceof Date) {
      date = ymd(a);
      lastDate = date;
      const wd = s(val(cols.weekday));
      if (wd && WEEKDAYS.includes(wd) && WEEKDAYS[a.getUTCDay()] !== wd) flags.push("weekday_mismatch");
    } else if (section === "unscheduled") {
      flags.push("no_date_unscheduled");
    } else if (lastDate) {
      date = lastDate;
      flags.push("date_inherited");
    }

    const personBlocks = cols.persons.map((p) => ({ person: p.name, label: s(val(p.col)) })).filter((b) => b.label);
    const kind = s(val(cols.kind)) || null;
    const address = s(val(cols.address)) || null;
    const customer = s(val(cols.customer)) || null;
    const contactCell = val(cols.contact);
    const pkg = s(val(cols.pkg)) || null;
    const priceCell = val(cols.price);
    const notes = s(val(cols.notes)) || null;
    const notesCell = val(cols.notes);
    const statusRaw = s(val(cols.status)) || null;
    const extras = cols.extras.map((c) => ({ col: String.fromCharCode(65 + c), v: val(c) })).filter((x) => x.v != null && s(x.v) !== "");

    // 연락처 칸 해석
    let phone: string | null = null;
    let email: string | null = null;
    let startTime: string | null = null;
    let timeRaw: string | null = null;
    if (contactCell != null) {
      const cs = s(contactCell);
      if (typeof contactCell === "object" && !(contactCell instanceof Date)) {
        startTime = contactCell.time;
        timeRaw = contactCell.time;
        flags.push("contact_column_used_as_time");
      } else if (typeof contactCell === "string" && PHONE.test(cs.replace(/\s/g, ""))) phone = cs.replace(/\s/g, "");
      else if (typeof contactCell === "string" && EMAIL.test(cs)) email = cs;
      else if (typeof contactCell === "string" && /^0\d{0,2}-?\d{0,4}$/.test(cs)) flags.push("invalid_phone");
      else if (typeof contactCell === "string" && (parseTime(cs) || /시|출|기입예정|\d{1,2}-\d{1,2}$/.test(cs))) {
        timeRaw = cs;
        startTime = parseTime(cs);
        flags.push("contact_column_used_as_time");
        if (!startTime) flags.push("time_unparsed");
      } else {
        // 숫자·날짜 등 의미 불명 (예: 9.2, 10, 날짜로 변환된 값)
        timeRaw = contactCell instanceof Date ? `날짜값 ${ymd(contactCell)}` : cs;
        flags.push("ambiguous_value_in_contact");
      }
    }
    if (notesCell && typeof notesCell === "object" && !(notesCell instanceof Date) && !startTime) {
      startTime = notesCell.time;
      timeRaw = notesCell.time;
    }

    let listedPrice: number | null = null;
    if (typeof priceCell === "number") {
      if (priceCell < 0) flags.push("negative_amount");
      else {
        listedPrice = Math.round(priceCell);
        if (priceCell === 0) flags.push("zero_price");
      }
    }

    const hasJob = Boolean(customer || phone || email || pkg || statusRaw || typeof priceCell === "number" || kind === "촬영" || kind === "브랜딩");
    let classification: ParsedRow["classification"];
    if (hasJob) classification = "booking";
    else if (address || kind === "기타" || extras.length || notes) classification = kind === "기타" ? "business" : "note";
    else if (personBlocks.length) classification = "personal";
    else classification = "empty_day";

    const allNotes = [notes, ...extras.map((x) => `[${x.col}열] ${s(x.v)}`)].filter(Boolean).join(" / ") || null;
    let cashReceipt: string | null = null;
    let projectStatus = date ? "scheduled" : "unscheduled";
    let paidClaim = false;
    if (classification === "booking") {
      if (extras.length) flags.push("extra_columns");
      if (!customer) flags.push("customer_missing");
      if (typeof priceCell !== "number") flags.push("price_missing");
      if (!kind) flags.push("work_type_missing");
      if (allNotes && /(먼저 받|선금|계약금|입금)/.test(allNotes)) flags.push("possible_payment_in_notes");
      if (allNotes && (/형\s*\d|>\s*\S+형|>현욱|현욱|외주|소싱비/.test(allNotes))) flags.push("possible_cost_in_notes");
      if (allNotes && /현금영수증/.test(allNotes)) {
        cashReceipt = "시트 메모에 현금영수증 언급";
        flags.push("cash_receipt_mentioned");
      }
      switch (statusRaw) {
        case "완료":
          projectStatus = "done";
          flags.push("status_done_payment_unknown");
          break;
        case "진행중":
          projectStatus = "in_progress";
          break;
        case "입금완료":
          paidClaim = true;
          flags.push("status_paid_claim");
          break;
        case "미진행":
          projectStatus = "on_hold";
          break;
        case null:
          if (date && date < todayStr) flags.push("status_missing");
          break;
        default:
          flags.push("status_unknown");
      }
    } else if (classification === "note") {
      flags.push("classification_uncertain");
    }

    const title = classification === "booking" ? [customer, address].filter(Boolean).join(" · ") || kind || "제목 없음" : null;
    const blockLabel = classification === "note" || classification === "business" ? [kind && kind !== "기타" ? kind : null, address, notes, ...extras.map((x) => s(x.v))].filter(Boolean).join(" / ") || kind : null;
    const dedupeKey =
      classification === "booking"
        ? "sheet:" + crypto.createHash("sha1").update([g.name, date ?? "nodate", address ?? "", customer ?? "", String(priceCell ?? "")].join("|")).digest("hex").slice(0, 24)
        : classification === "note" || classification === "business"
          ? "sheetnote:" + crypto.createHash("sha1").update([g.name, date ?? "nodate", blockLabel ?? ""].join("|")).digest("hex").slice(0, 24)
          : null;

    out.push(
      mk(g.name, r + 1, classification, raw, {
        date,
        section,
        workType: kind,
        title,
        address,
        customerName: customer,
        phone,
        email,
        startTime,
        timeRaw,
        package: pkg,
        listedPrice,
        statusRaw,
        projectStatus,
        paidClaim,
        notes: allNotes,
        cashReceipt,
        personBlocks,
        blockLabel,
      }, flags, classification === "empty_day" ? "skip" : "import", dedupeKey),
    );
  }

  // 파일 내 중복 / 재방문 후보
  const seen = new Map<string, ParsedRow>();
  const byCustomerPlace = new Map<string, ParsedRow[]>();
  for (const r of out) {
    if (r.classification !== "booking" || !r.dedupeKey) continue;
    if (seen.has(r.dedupeKey)) {
      r.flags.push("duplicate_in_file");
      r.decision = "review";
    } else seen.set(r.dedupeKey, r);
    const cp = `${r.parsed.customerName ?? ""}|${(r.parsed.address ?? "").replace(/\s/g, "")}`;
    if (r.parsed.customerName && r.parsed.address) byCustomerPlace.set(cp, [...(byCustomerPlace.get(cp) ?? []), r]);
  }
  for (const list of byCustomerPlace.values()) if (list.length > 1) list.forEach((r) => r.flags.push("possible_repeat_visit"));
  return { columns: cols, rows: out };
}

function mk(sheet: string, row: number, classification: ParsedRow["classification"], raw: Record<string, string>, parsed: any, flags: string[], decision: ParsedRow["decision"], dedupeKey: string | null): ParsedRow {
  const base = {
    date: null, section: null, workType: null, title: null, address: null, customerName: null, phone: null, email: null, startTime: null, timeRaw: null,
    package: null, listedPrice: null, statusRaw: null, projectStatus: "unscheduled", paidClaim: false, notes: null, cashReceipt: null, personBlocks: [], blockLabel: null,
  };
  return { sheet, row, classification, raw, parsed: { ...base, ...parsed }, flags, decision, dedupeKey };
}

export function summarize(rows: ParsedRow[]) {
  const by = (k: string) => rows.filter((r) => r.classification === k).length;
  const flagCounts: Record<string, number> = {};
  for (const r of rows) for (const f of r.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const bookings = rows.filter((r) => r.classification === "booking");
  const dates = bookings.map((r) => r.parsed.date).filter(Boolean).sort() as string[];
  return {
    bookings: bookings.length,
    personalBlocks: rows.reduce((a, r) => a + r.parsed.personBlocks.length, 0),
    notes: by("note") + by("business"),
    emptyDays: by("empty_day"),
    review: rows.filter((r) => r.decision === "review").length,
    flagged: rows.filter((r) => r.flags.length).length,
    flagCounts,
    listedPriceTotal: bookings.reduce((a, r) => a + (r.parsed.listedPrice ?? 0), 0),
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    customers: new Set(bookings.map((r) => r.parsed.phone ?? r.parsed.customerName).filter(Boolean)).size,
  };
}

/** 미리보기 저장 (DB에는 원문·해석·플래그만, 아직 업무 데이터 생성 안 함) */
export async function createPreview(orgId: string, userId: string, grids: Grid[], sourceKind: "xlsx_upload" | "google_sheets", label: string, sha: string | null) {
  const all: ParsedRow[] = [];
  const sheets: Array<{ name: string; detected: boolean }> = [];
  for (const g of grids) {
    const r = analyzeGrid(g);
    sheets.push({ name: g.name, detected: !!r.columns });
    all.push(...r.rows);
  }
  // 이미 가져온 행 표시
  const keys = all.map((r) => r.dedupeKey).filter(Boolean) as string[];
  const existing = new Set(
    keys.length ? (await q<{ dedupe_key: string }>(`SELECT dedupe_key FROM sheet_row_links WHERE org_id=$1 AND dedupe_key = ANY($2::text[])`, [orgId, keys])).map((x) => x.dedupe_key) : [],
  );
  const summary = { ...summarize(all), sheets, alreadyImported: all.filter((r) => r.dedupeKey && existing.has(r.dedupeKey)).length };
  const imp = await q1<{ id: string }>(
    `INSERT INTO sheet_imports(org_id, source_kind, source_label, file_sha256, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, sourceKind, label, sha, summary, userId],
  );
  for (const r of all) {
    await q(
      `INSERT INTO sheet_import_rows(import_id, sheet_name, row_number, classification, raw, parsed, flags, decision, dedupe_key, duplicate_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [imp!.id, r.sheet, r.row, r.classification, r.raw, r.parsed, r.flags, r.decision, r.dedupeKey, r.dedupeKey && existing.has(r.dedupeKey) ? "already_imported" : null],
    );
  }
  return { id: imp!.id, summary };
}

/** 확정: decision='import' 행만 업무 데이터로 생성. 같은 원본 행(dedupe_key)은 다시 만들지 않는다. */
export async function commitImport(orgId: string, userId: string, importId: string) {
  const imp = await q1<any>(`SELECT * FROM sheet_imports WHERE id=$1 AND org_id=$2`, [importId, orgId]);
  if (!imp) throw Object.assign(new Error("가져오기를 찾을 수 없습니다."), { status: 404 });
  if (imp.status !== "previewed") throw Object.assign(new Error("이미 확정되었거나 취소된 가져오기입니다."), { status: 400 });
  const rows = await q<any>(`SELECT * FROM sheet_import_rows WHERE import_id=$1 AND decision='import' ORDER BY row_number`, [importId]);
  const result = { projects: 0, contacts: 0, blocks: 0, claims: 0, skippedExisting: 0 };
  await tx(async (c) => {
    for (const r of rows) {
      const p = r.parsed;
      // 개인 일정 칸 (사람별)
      for (const b of p.personBlocks ?? []) {
        if (!p.date) continue;
        const key = "sheetperson:" + crypto.createHash("sha1").update([r.sheet_name, p.date, b.person, b.label].join("|")).digest("hex").slice(0, 24);
        const ex = await q1(`SELECT 1 FROM sheet_row_links WHERE org_id=$1 AND dedupe_key=$2`, [orgId, key], c);
        if (ex) continue;
        const bl = await q1<{ id: string }>(
          `INSERT INTO schedule_blocks(org_id, date, person_label, label, kind, data_origin, source_ref, created_by) VALUES ($1,$2,$3,$4,'personal','sheet',$5,$6) RETURNING id`,
          [orgId, p.date, b.person, b.label, `${r.sheet_name}!${r.row_number}`, userId],
          c,
        );
        await q(`INSERT INTO sheet_row_links(org_id, dedupe_key, block_id, import_id) VALUES ($1,$2,$3,$4)`, [orgId, key, bl!.id, importId], c);
        result.blocks++;
      }
      if (!r.dedupe_key) continue;
      const ex = await q1(`SELECT 1 FROM sheet_row_links WHERE org_id=$1 AND dedupe_key=$2`, [orgId, r.dedupe_key], c);
      if (ex) {
        result.skippedExisting++;
        continue;
      }
      if (r.classification === "note" || r.classification === "business") {
        if (!p.date || !p.blockLabel) continue;
        const bl = await q1<{ id: string }>(
          `INSERT INTO schedule_blocks(org_id, date, label, kind, data_origin, source_ref, created_by) VALUES ($1,$2,$3,$4,'sheet',$5,$6) RETURNING id`,
          [orgId, p.date, p.blockLabel, r.classification === "business" ? "business" : "personal", `${r.sheet_name}!${r.row_number}`, userId],
          c,
        );
        await q(`INSERT INTO sheet_row_links(org_id, dedupe_key, block_id, import_id) VALUES ($1,$2,$3,$4)`, [orgId, r.dedupe_key, bl!.id, importId], c);
        result.blocks++;
        continue;
      }
      if (r.classification !== "booking") continue;
      // 고객: 전화번호가 있으면 전화번호로, 없으면 이름으로 동일 고객 판단
      let contactId: string | null = null;
      if (p.customerName || p.phone || p.email) {
        const ext = p.phone ? `phone:${p.phone.replace(/-/g, "")}` : p.email ? `email:${p.email.toLowerCase()}` : `name:${p.customerName}`;
        const ct = await q1<{ id: string; created: boolean }>(
          `INSERT INTO contacts(org_id, provider, external_user_id, display_name, phone, email, data_origin) VALUES ($1,'sheet',$2,$3,$4,$5,'sheet')
           ON CONFLICT (org_id, provider, external_user_id) DO UPDATE SET display_name=COALESCE(contacts.display_name, EXCLUDED.display_name),
             phone=COALESCE(contacts.phone, EXCLUDED.phone), email=COALESCE(contacts.email, EXCLUDED.email)
           RETURNING id, (xmax = 0) AS created`,
          [orgId, ext, p.customerName ?? p.phone ?? p.email, p.phone, p.email],
          c,
        );
        contactId = ct!.id;
        if (ct!.created) result.contacts++;
      }
      const pj = await q1<{ id: string }>(
        `INSERT INTO projects(org_id, contact_id, title, work_type, package, scheduled_date, start_time, time_raw, address, status, listed_price, notes, cash_receipt, data_origin, source_ref, flags, created_by, checklist)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'sheet',$14,$15,$16,$17) RETURNING id`,
        [orgId, contactId, p.title ?? "제목 없음", p.workType, p.package, p.date, p.startTime, p.timeRaw, p.address, p.projectStatus, p.listedPrice, p.notes, p.cashReceipt, `${r.sheet_name}!${r.row_number}`, r.flags, userId, ["scheduled", "unscheduled", "in_progress"].includes(p.projectStatus) ? defaultChecklist() : "[]"],
        c,
      );
      if (p.paidClaim) {
        await q(
          `INSERT INTO payments(org_id, project_id, amount, paid_at, status, kind, evidence, created_by) VALUES ($1,$2,NULL,$3,'claimed','other',$4,$5)`,
          [orgId, pj!.id, p.date ? kstStartOfDay(p.date) : new Date(), "시트 진행 상태 '입금완료' (금액·입금일 미기재 — 확인 필요)", userId],
          c,
        );
        result.claims++;
      }
      await q(`INSERT INTO sheet_row_links(org_id, dedupe_key, project_id, import_id) VALUES ($1,$2,$3,$4)`, [orgId, r.dedupe_key, pj!.id, importId], c);
      await q(`UPDATE sheet_import_rows SET created_refs=$2 WHERE id=$1`, [r.id, { project_id: pj!.id, contact_id: contactId }], c);
      result.projects++;
    }
    await q(`UPDATE sheet_imports SET status='committed', committed_at=now(), summary = summary || $2::jsonb WHERE id=$1`, [importId, JSON.stringify({ result })], c);
  });
  return result;
}

export { addDays };
