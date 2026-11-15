// Web Push (VAPID). 앱을 닫아도 OS 알림으로 받는다. 페이로드에는 상담 원문을 넣지 않는다.
import webpush from "web-push";
import { q, q1 } from "../db/pool.js";
import { config } from "../config.js";

let vapid: { publicKey: string; privateKey: string } | null = null;

/** 환경변수 VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY가 없으면 최초 1회 생성해 DB(app_secrets)에 보관 */
export async function getVapid() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const row = await q1<{ value: string }>(`SELECT value FROM app_secrets WHERE key='vapid'`);
    if (row) vapid = JSON.parse(row.value);
    else {
      const k = webpush.generateVAPIDKeys();
      await q(`INSERT INTO app_secrets(key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(k)]);
      const again = await q1<{ value: string }>(`SELECT value FROM app_secrets WHERE key='vapid'`);
      vapid = JSON.parse(again!.value);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:admin@${new URL(config.appBaseUrl).hostname || "localhost"}`, vapid!.publicKey, vapid!.privateKey);
  return vapid!;
}

export interface PushPayload {
  title: string;
  body?: string;
  link?: string | null;
  tag?: string;
}

/** 사용자 기기 전체로 발송. 반환: 'sent' | 'failed' | 'no_subscription' */
export async function sendPushToUser(userId: string, payload: PushPayload, opts: { agent?: any } = {}): Promise<{ status: "sent" | "failed" | "no_subscription"; error?: string }> {
  const subs = await q<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1 AND disabled_at IS NULL`,
    [userId],
  );
  if (!subs.length) return { status: "no_subscription" };
  await getVapid();
  let ok = 0;
  let lastErr = "";
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: "high", ...(opts.agent ? { agent: opts.agent } : {}) });
      ok++;
      await q(`UPDATE push_subscriptions SET last_success_at=now(), last_error=NULL WHERE id=$1`, [s.id]);
    } catch (e: any) {
      lastErr = `${e?.statusCode ?? ""} ${String(e?.body ?? e?.message ?? e).slice(0, 200)}`.trim();
      // 404/410: 구독 만료 → 비활성화
      const gone = e?.statusCode === 404 || e?.statusCode === 410;
      await q(`UPDATE push_subscriptions SET last_error=$2, disabled_at=CASE WHEN $3 THEN now() ELSE disabled_at END WHERE id=$1`, [s.id, lastErr, gone]);
    }
  }
  return ok > 0 ? { status: "sent" } : { status: "failed", error: lastErr };
}
