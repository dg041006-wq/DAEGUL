// 백그라운드 워커: 작업 큐 처리 + 주기적 점검(sweep). API 서버와 별도 프로세스로 실행.
import { pool, q } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { handlers } from "./jobs/handlers.js";
import { enqueue, recoverStuckJobs, runOnce } from "./jobs/queue.js";

let stopping = false;

async function scheduleSweeps() {
  const orgs = await q<{ id: string }>(`SELECT id FROM organizations`);
  for (const o of orgs) {
    await enqueue("sweep_org", { orgId: o.id }, { dedupeKey: `sweep:${o.id}`, maxAttempts: 1 });
  }
}

async function scheduleDailyPurge() {
  const orgs = await q<{ id: string }>(`SELECT id FROM organizations`);
  for (const o of orgs) await enqueue("purge_org", { orgId: o.id }, { dedupeKey: `purge:${o.id}`, maxAttempts: 1 });
}

async function main() {
  await migrate(false);
  console.log("worker started");
  let lastSweep = 0;
  let lastPurge = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > 60_000) {
        await recoverStuckJobs();
        await scheduleSweeps();
        lastSweep = Date.now();
      }
      if (Date.now() - lastPurge > 24 * 3600_000) {
        await scheduleDailyPurge();
        lastPurge = Date.now();
      }
      const n = await runOnce(handlers, 20);
      if (n === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (e: any) {
      console.error("worker loop error", e?.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await pool.end();
}

process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
main();
