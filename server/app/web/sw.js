// NuniFlix service worker: only shows push notifications (no offline caching).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  const d = e.data ? e.data.json() : {title: "NuniFlix", body: ""};
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "/icon-180.png", badge: "/icon-180.png", data: {url: d.url || "/"},
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type: "window", includeUncontrolled: true}).then(wins => {
    const url = e.notification.data.url, w = wins.find(x => "focus" in x);
    if (!w) return clients.openWindow(url);
    return (w.navigate ? w.navigate(url).catch(() => w) : Promise.resolve(w)).then(x => (x || w).focus());
  }));
});
