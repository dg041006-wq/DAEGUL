import { buildApp } from "./app.js";
import { assertServerConfig, config } from "./config.js";
import { migrate } from "./db/migrate.js";

assertServerConfig();
await migrate(false);
const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
