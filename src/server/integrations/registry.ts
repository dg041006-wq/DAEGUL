import { demoAdapter, makeHmacAdapter } from "./demo.js";
import { channelTalkAdapter } from "./channeltalk.js";
import type { ProviderAdapter } from "./types.js";

// test: 실제 고객 데이터와 분리된 '테스트 수신' 경로 (TEST_WEBHOOK_SECRET 서명). 화면·집계에서 테스트로 구분된다.
// 테스트 발송: 외부로 아무것도 보내지 않고 '테스트 발송함'에만 기록 (테스트 상담에만 허용)
const testOutbox = new Map<string, string>();
const testAdapter: ProviderAdapter = {
  ...makeHmacAdapter("test", () => process.env.TEST_WEBHOOK_SECRET ?? "", "x-test-signature"),
  async send(m) {
    if (!m.isTest) return { status: "failed", error: "테스트 공급사는 테스트 상담에만 발송할 수 있습니다." };
    if (process.env.TEST_SEND_MODE === "fail") return { status: "failed", error: "테스트: 공급사 거부" };
    if (process.env.TEST_SEND_MODE === "timeout") throw new Error("테스트: 응답 시간 초과");
    const id = testOutbox.get(m.idempotencyKey) ?? `test-${m.idempotencyKey}`;
    testOutbox.set(m.idempotencyKey, id); // 같은 키 재요청은 같은 메시지로 간주(중복 발송 없음)
    return { status: "sent", providerMessageId: id };
  },
  async getSendStatus(m) {
    const id = testOutbox.get(m.idempotencyKey);
    return id ? { status: "sent", providerMessageId: id } : { status: "failed" };
  },
};
export const __testOutbox = testOutbox;

const adapters: Record<string, ProviderAdapter> = {
  demo: demoAdapter,
  test: testAdapter,
  channeltalk: channelTalkAdapter,
};

export function getAdapter(key: string): ProviderAdapter | null {
  return adapters[key] ?? null;
}

/** 샘플 데이터를 만드는 공급사 — 화면에 '샘플 데이터 / 카카오 미연동'으로 표시 */
export const SAMPLE_PROVIDERS = new Set(["demo"]);

/** 공급사 → 데이터 출처 */
export function originOf(provider: string): "sample" | "test" | "manual" | "import" | "live" {
  if (provider === "demo") return "sample";
  if (provider === "test") return "test";
  if (provider === "manual") return "manual";
  if (provider === "import" || provider === "sheet") return "import";
  return "live";
}
