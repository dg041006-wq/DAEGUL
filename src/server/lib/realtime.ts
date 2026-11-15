// PostgreSQL LISTEN/NOTIFY → SSE. API 서버와 워커가 만든 변경이 모두 화면으로 전달된다.
// 전달 내용은 '어떤 테이블의 어떤 id가 바뀌었다'뿐이며 원문은 포함하지 않는다.
import pg from "pg";
import { config } from "../config.js";

type Listener = (msg: { t: string; id: string; op: string }) => void;
const listeners = new Map<string, Set<Listener>>(); // orgId → listeners
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;

async function ensureClient() {
  if (client) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on("notification", (n) => {
      try {
        const m = JSON.parse(n.payload ?? "{}");
        const set = listeners.get(m.org);
        if (set) for (const l of set) l({ t: m.t, id: m.id, op: m.op });
      } catch {
        /* ignore */
      }
    });
    c.on("error", () => {
      client = null;
      setTimeout(() => ensureClient().catch(() => {}), 2000);
    });
    await c.connect();
    await c.query("LISTEN ss_changes");
    client = c;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

export async function subscribe(orgId: string, l: Listener) {
  await ensureClient();
  if (!listeners.has(orgId)) listeners.set(orgId, new Set());
  listeners.get(orgId)!.add(l);
  return () => listeners.get(orgId)?.delete(l);
}

export async function closeRealtime() {
  await client?.end().catch(() => {});
  client = null;
}
