// 구글시트 읽기 전용 연동 (준비 단계).
// 필요 설정: GOOGLE_SERVICE_ACCOUNT_JSON (서비스 계정 키 JSON, 서버 환경변수) + 시트를 그 서비스 계정 이메일에 '뷰어'로 공유 + 설정 화면의 스프레드시트 ID.
// 권한 범위는 spreadsheets.readonly 만 사용하며 원본 시트에 쓰지 않는다.
// 연결 테스트가 성공하기 전에는 상태를 'verified'로 표시하지 않는다.
import crypto from "node:crypto";
import type { Cell, Grid } from "./sheetImport.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

function serviceAccount(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j.client_email && j.private_key ? j : null;
  } catch {
    return null;
  }
}

export function sheetsConfigured() {
  const sa = serviceAccount();
  return { configured: !!sa, serviceAccountEmail: sa?.client_email ?? null };
}

async function accessToken(): Promise<string> {
  const sa = serviceAccount();
  if (!sa) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 미설정");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`구글 인증 실패 (${res.status})`);
  return ((await res.json()) as any).access_token;
}

/** 시트 값을 가져와 xlsx와 같은 Grid 형식으로 변환 (날짜는 직렬 숫자 → 날짜, 1 미만 소수는 시간) */
export async function fetchSheetGrid(spreadsheetId: string, sheetName?: string | null): Promise<Grid[]> {
  const token = await accessToken();
  const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!meta.ok) throw new Error(`시트 메타데이터 조회 실패 (${meta.status}) — 서비스 계정에 뷰어 공유가 되어 있는지 확인`);
  const titles: string[] = ((await meta.json()) as any).sheets.map((s: any) => s.properties.title).filter((t: string) => !sheetName || t === sheetName);
  const grids: Grid[] = [];
  for (const t of titles) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(t)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`시트 값 조회 실패 (${r.status})`);
    const values: any[][] = ((await r.json()) as any).values ?? [];
    grids.push({
      name: t,
      rows: values.map((row) =>
        row.map((v, ci): Cell => {
          if (v === "" || v == null) return null;
          if (typeof v === "number" && ci === 0 && v > 20000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
          if (typeof v === "number" && v > 0 && v < 1 && !Number.isInteger(v)) {
            const mins = Math.round(v * 1440);
            return { time: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}` };
          }
          return v;
        }),
      ),
    });
  }
  return grids;
}
