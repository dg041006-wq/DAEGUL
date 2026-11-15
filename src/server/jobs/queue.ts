// PostgreSQL 기반 단순 작업 큐 (FOR UPDATE SKIP LOCKED). 실패 시 지수 백오프 재시도 → 한도 초과 시 dead.
import { pool, q, q1, type Db } from "../db/pool.js";

export type JobHandler = (payload: any) => Promise<void>;

export async function enqueue(
  kind: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number; db?: Db } = {},
) {
  await q(
    `INSERT INTO jobs(kind, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1,$2,COALESCE($3, now()),$4,$5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running') DO NOTHING`,
    [kind, payload, opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? 5],
    opts.db ?? pool,
  );
}

export async function runOnce(handlers: Record<string, JobHandler>, limit = 10): Promise<number> {
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const job = await q1<{ id: number; kind: string; payload: any; attempts: number; max_attempts: number }>(
      `UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1
       WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_at <= now()
                   ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
    );
    if (!job) break;
    processed++;
    const h = handlers[job.kind];
    try {
      if (!h) throw new Error(`unknown job kind ${job.kind}`);
      await h(job.payload);
      await q(`UPDATE jobs SET status='done', finished_at=now(), last_error=NULL WHERE id=$1`, [job.id]);
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 1000);
      if (job.attempts >= job.max_attempts) {
        await q(`UPDATE jobs SET status='dead', finished_at=now(), last_error=$2 WHERE id=$1`, [job.id, msg]);
      } else {
        const delaySec = Math.min(3600, 2 ** job.attempts * 15);
        await q(
          `UPDATE jobs SET status='queued', run_at=now() + ($2 || ' seconds')::interval, last_error=$3 WHERE id=$1`,
          [job.id, String(delaySec), msg],
        );
      }
    }
  }
  return processed;
}

/** 오래 running 상태로 남은 작업(워커 중단) 복구 */
export async function recoverStuckJobs() {
  await q(`UPDATE jobs SET status='queued', run_at=now() WHERE status='running' AND locked_at < now() - interval '10 minutes'`);
}
