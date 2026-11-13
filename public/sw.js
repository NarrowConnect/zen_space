/* ZenSpace service worker: funciona offline e abre instantaneamente.
   - Página (HTML): rede primeiro, cache como reserva (sempre pega a versão nova quando há internet).
   - Ícones/fontes/estáticos: cache primeiro, atualizando em segundo plano.
   - /api/* e APIs externas (Spotify, LRCLib): nunca são cacheados aqui. */
const VERSION = 'zenspace-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const CACHEABLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(VERSION)
            .then(cache => cache.addAll(SHELL))
            .catch(() => {}) // não impede a instalação se algo falhar
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

function putInCache(request, response) {
    if (response && (response.ok || response.type === 'opaque')) {
        const copy = response.clone();
        caches.open(VERSION).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;

    if (sameOrigin && url.pathname.startsWith('/api/')) return;
    if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => putInCache('/', response))
                .catch(() => caches.match('/').then(cached => cached || Response.error()))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then(cached => {
            const network = fetch(request).then(response => putInCache(request, response)).catch(() => cached);
            return cached || network;
        })
    );
});
