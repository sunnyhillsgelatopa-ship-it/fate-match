self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: '💕 缘分速配', body: '有新消息' };
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon.png', badge: '/icon.png', data: data }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(cs => { if (cs.length > 0) cs[0].focus(); else clients.openWindow('/'); }));
});
