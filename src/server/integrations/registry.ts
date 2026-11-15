import { demoAdapter } from "./demo.js";
import { channelTalkAdapter } from "./channeltalk.js";
import type { ProviderAdapter } from "./types.js";

const adapters: Record<string, ProviderAdapter> = {
  demo: demoAdapter,
  channeltalk: channelTalkAdapter,
};

export function getAdapter(key: string): ProviderAdapter | null {
  return adapters[key] ?? null;
}

/** 샘플 데이터를 만드는 공급사 — 화면에 '샘플 데이터 / 카카오 미연동'으로 표시 */
export const SAMPLE_PROVIDERS = new Set(["demo"]);
