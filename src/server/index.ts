import { buildApp } from "./app.js";
import { assertServerConfig, config } from "./config.js";
import { migrate } from "./db/migrate.js";

assertServerConfig();
await migrate(false);
const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });

// 단일 서비스 배포: 같은 프로세스에서 워커(작업 큐·정기 보고·알림)도 실행
if (process.env.RUN_WORKER_IN_PROCESS === "true") {
  const { startWorkerLoop, stopWorker } = await import("./worker.js");
  process.on("SIGTERM", () => {
    stopWorker();
    app.close().finally(() => process.exit(0));
  });
  startWorkerLoop();
}

// 스타일링 스튜디오 렌더 워커(헤드리스 Chromium). STUDIO_RENDER_IN_PROCESS=false면 별도 워커 프로세스에서 실행
if (process.env.STUDIO_RENDER_IN_PROCESS !== "false" && config.env !== "test") {
  const { startStudioRenderLoop } = await import("./studio/renderJobs.js");
  startStudioRenderLoop();
}
