// 데모 공급사: 로컬 샘플 데이터 전용. 카카오와 연결되어 있지 않다.
// 이벤트 형식은 이 앱이 정의한 테스트용 형식이며, 어떤 실제 공급사의 형식도 흉내내지 않는다.
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import type { NormalizedEvent, ProviderAdapter, VerifyInput } from "./types.js";

const DemoEvent = z.object({
  event_id: z.string().min(1),
  type: z.enum(["message", "conversation_status"]),
  occurred_at: z.string(),
  user: z.object({ id: z.string().min(1), name: z.string().nullish() }),
  conversation: z.object({ id: z.string().min(1), status: z.enum(["open", "closed"]).optional(), channel: z.string().nullish() }),
  message: z
    .object({
      id: z.string().min(1),
      sender: z.enum(["customer", "staff", "bot", "system"]),
      sender_id: z.string().nullish(),
      sender_name: z.string().nullish(),
      text: z.string().nullable(),
      attachments: z.array(z.object({ name: z.string().optional(), mime: z.string().optional(), ref: z.string().optional() })).optional(),
    })
    .optional(),
});
export type DemoEventPayload = z.infer<typeof DemoEvent>;

export function signDemo(rawBody: string, secret = config.demoWebhookSecret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function header(h: VerifyInput["headers"], name: string) {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

export function makeHmacAdapter(key: string, secret: () => string, headerName: string): ProviderAdapter {
  return {
    ...demoAdapter,
    key,
    verify({ rawBody, headers }) {
      const sec = secret();
      if (!sec) return false;
      const sig = header(headers, headerName);
      if (!sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
      const expected = crypto.createHmac("sha256", sec).update(rawBody).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    },
  };
}

export const demoAdapter: ProviderAdapter = {
  key: "demo",
  implemented: true,
  verify({ rawBody, headers }) {
    if (!config.demoWebhookSecret) return false;
    const sig = header(headers, "x-demo-signature");
    if (!sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
    const expected = signDemo(rawBody);
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  },
  eventId(payload) {
    return DemoEvent.parse(payload).event_id;
  },
  normalize(payload): NormalizedEvent[] {
    const e = DemoEvent.parse(payload);
    const contact = { externalUserId: e.user.id, displayName: e.user.name ?? null };
    if (e.type === "conversation_status") {
      return [
        {
          kind: "conversation_status",
          externalEventId: e.event_id,
          contact,
          conversation: { externalConversationId: e.conversation.id, status: e.conversation.status ?? "open", at: e.occurred_at, channel: e.conversation.channel },
        },
      ];
    }
    if (!e.message) return [];
    return [
      {
        kind: "message",
        externalEventId: e.event_id,
        contact,
        conversation: { externalConversationId: e.conversation.id, channel: e.conversation.channel ?? null, status: e.conversation.status },
        message: {
          externalMessageId: e.message.id,
          senderType: e.message.sender,
          senderExternalId: e.message.sender_id ?? null,
          senderName: e.message.sender_name ?? null,
          body: e.message.text,
          attachments: (e.message.attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, providerRef: a.ref })),
          sentAt: e.occurred_at,
        },
      },
    ];
  },
};
