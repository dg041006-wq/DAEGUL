// 서버 환경 설정. 비밀값은 여기서만 읽고 클라이언트·로그로 내보내지 않는다.

function num(v: string | undefined, d: number) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : d;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stayscene",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:5173",
  ai: {
    // 키 값 자체는 ai/client.ts에서만 SDK가 환경변수로 읽는다.
    get enabled() {
      return Boolean(process.env.ANTHROPIC_API_KEY);
    },
    get model() {
      return process.env.AI_MODEL || "claude-opus-5-5";
    },
    priceInputPerMTok: num(process.env.AI_PRICE_INPUT_PER_MTOK, 4),
    priceOutputPerMTok: num(process.env.AI_PRICE_OUTPUT_PER_MTOK, 20),
  },
  demoWebhookSecret: process.env.DEMO_WEBHOOK_SECRET ?? "",
  get isProd() {
    return this.env === "production";
  },
};

export function assertServerConfig() {
  if (config.isProd && config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET(32자 이상)이 필요합니다.");
  }
}
