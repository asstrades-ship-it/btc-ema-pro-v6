
self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      body: event.data ? event.data.text() : ""
    };
  }

  event.waitUntil(
    self.registration.showNotification(
      data.title || "BTC EMA PRO",
      {
        body: data.body || "New BTC Alert",
        vibrate: [200, 100, 200],
        data: {
          url: self.registration.scope
        }
      }
    )
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  event.waitUntil(
    self.clients.openWindow(
      self.registration.scope
    )
  );
});
