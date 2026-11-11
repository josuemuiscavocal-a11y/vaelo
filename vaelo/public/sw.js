// Permite instalar Vaelo como app en el celular. Guarda solo archivos de diseño; los datos siempre se piden en vivo.
const CACHE = 'vaelo-v12';
const ARCHIVOS = ['/css/styles.css', '/css/suave.css', '/js/comun.js', '/js/suave.js', '/img/logo-blanco.png', '/img/logo-negro.png', '/img/icono-192.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Primero la red (para tener siempre lo último); si no hay internet, lo guardado
  ev.respondWith(
    fetch(ev.request).then((r) => {
      if (r.ok && ARCHIVOS.includes(url.pathname)) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(ev.request, copia)); }
      return r;
    }).catch(() => caches.match(ev.request).then((r) => r || new Response('Sin conexión. Revisa tu internet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});

// Al tocar la notificación de un pedido nuevo, abre (o trae al frente) el panel
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const destino = (ev.notification.data && ev.notification.data.url) || '/familiatecun';
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    const url = new URL(destino, self.location.origin);
    const abierta = ventanas.find((v) => new URL(v.url).pathname === url.pathname);
    if (abierta) return (url.search && abierta.navigate ? abierta.navigate(url.href) : Promise.resolve(abierta)).then((v) => (v || abierta).focus());
    return self.clients.openWindow(url.href);
  }));
});

// Avisos que manda el servidor aunque Vaelo esté cerrado
self.addEventListener('push', (ev) => {
  let d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch { d = { titulo: 'Vaelo', cuerpo: ev.data ? ev.data.text() : '' }; }
  ev.waitUntil(self.registration.showNotification(d.titulo || 'Vaelo', {
    body: d.cuerpo || '', icon: '/img/icono-192.png', badge: '/img/icono-192.png', tag: d.etiqueta || 'vaelo', renotify: true,
    vibrate: d.urgente ? [300, 100, 300, 100, 300] : [200, 100, 200], requireInteraction: !!d.urgente, data: { url: d.url || '/' },
  }));
});
