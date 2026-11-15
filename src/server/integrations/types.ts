// 상담 공급사 어댑터 인터페이스.
// 실제 공급사(채널톡 등 상담톡 경로 A, 딜러사 API 경로 B)는 계약과 현재 공식 문서를 확인한 뒤에만 구현한다.

export type SenderType = "customer" | "staff" | "bot" | "system";

export interface NormalizedMessageEvent {
  kind: "message";
  externalEventId: string;
  contact: { externalUserId: string; displayName?: string | null };
  conversation: {
    externalConversationId: string;
    channel?: string | null; // 예: "kakao"
    status?: "open" | "closed";
    openedAt?: string | null;
  };
  message: {
    externalMessageId: string;
    senderType: SenderType;
    senderExternalId?: string | null;
    senderName?: string | null;
    body: string | null;
    attachments?: Array<{ name?: string; mime?: string; providerRef?: string }>;
    sentAt: string; // ISO 8601
  };
}

export interface NormalizedConversationStatusEvent {
  kind: "conversation_status";
  externalEventId: string;
  contact: { externalUserId: string; displayName?: string | null };
  conversation: { externalConversationId: string; status: "open" | "closed"; at: string; channel?: string | null };
}

export type NormalizedEvent = NormalizedMessageEvent | NormalizedConversationStatusEvent;

export interface VerifyInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ProviderAdapter {
  key: string;
  /** 공식 문서 기준 검증·구현 여부 */
  implemented: boolean;
  /** 웹훅 서명/토큰 검증. 실패 시 false — 검증되지 않은 웹훅은 저장하지 않는다. */
  verify(input: VerifyInput): boolean;
  /** 원본 이벤트 → 이벤트 ID(중복 방지 키) */
  eventId(payload: unknown): string;
  /** 원본 이벤트 → 정규화 이벤트 목록 (무시할 이벤트면 빈 배열) */
  normalize(payload: unknown): NormalizedEvent[];
  /** 내역 보충(백필) — 공급사가 지원할 때만 */
  backfill?: (args: { since: Date }) => Promise<NormalizedEvent[]>;
  /** 고객 발송 — 공급사 지원 + 실제 발송 검증 후에만 활성화 */
  send?: undefined;
}
