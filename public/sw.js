// STAYSCENE 서비스 워커
// - 앱 셸(아이콘·매니페스트)만 캐시. /api 응답·상담 원문은 절대 캐시하지 않는다.
// - 웹 푸시 수신 → OS 알림, 알림 클릭 → 해당 화면 열기.
const CACHE = "stayscene-shell-v2";
const SHELL = ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate") {
    // 네트워크 우선. 오프라인이면 간단한 안내 페이지 (데이터 없음)
    e.respondWith(
      fetch(e.request).catch(
        () =>
          new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STAYSCENE</title><body style="font-family:sans-serif;padding:24px;background:#f7f3ec;color:#2b2a28"><h2>오프라인입니다</h2><p>네트워크에 다시 연결되면 자동으로 최신 내용을 불러옵니다.</p><button onclick="location.reload()">다시 시도</button></body>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      ),
    );
    return;
  }
  if (SHELL.includes(url.pathname)) e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: e.data ? e.data.text() : "STAYSCENE" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "STAYSCENE 알림", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag,
      data: { link: d.link || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(link).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "clear-caches") e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
});
