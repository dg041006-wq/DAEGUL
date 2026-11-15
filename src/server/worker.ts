// 백그라운드 워커: 작업 큐 처리 + 1분 주기 점검(즉시 보고·정기 보고·할 일·알림) + 일 1회 보관 정리.
// 별도 프로세스(npm run start:worker) 또는 API 프로세스 안(RUN_WORKER_IN_PROCESS=true)에서 실행.
// 예약 상태는 DB에 있으므로 재시작·재배포 후에도 유지되고, 놓친 정기 보고는 다음 점검 때 1회 보충된다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, q } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { handlers } from "./jobs/handlers.js";
import { enqueue, recoverStuckJobs, runOnce } from "./jobs/queue.js";

let stopping = false;
export const workerState = { startedAt: null as Date | null, lastLoopAt: null as Date | null, lastError: null as string | null };

async function scheduleOrgJobs(kind: "sweep_org" | "purge_org") {
  const orgs = await q<{ id: string }>(`SELECT id FROM organizations`);
  for (const o of orgs) await enqueue(kind, { orgId: o.id }, { dedupeKey: `${kind === "sweep_org" ? "sweep" : "purge"}:${o.id}`, maxAttempts: 1 });
}

export async function startWorkerLoop() {
  workerState.startedAt = new Date();
  let lastSweep = 0;
  let lastPurge = 0;
  console.log("worker started");
  while (!stopping) {
    try {
      if (Date.now() - lastSweep > 60_000) {
        await recoverStuckJobs();
        await scheduleOrgJobs("sweep_org");
        lastSweep = Date.now();
      }
      if (Date.now() - lastPurge > 24 * 3600_000) {
        await scheduleOrgJobs("purge_org");
        lastPurge = Date.now();
      }
      const n = await runOnce(handlers, 20);
      workerState.lastLoopAt = new Date();
      if (n === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (e: any) {
      workerState.lastError = String(e?.message ?? e).slice(0, 200);
      console.error("worker loop error", workerState.lastError);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export function stopWorker() {
  stopping = true;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  process.on("SIGTERM", stopWorker);
  process.on("SIGINT", stopWorker);
  migrate(false)
    .then(startWorkerLoop)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
