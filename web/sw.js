const CACHE = 'fastmp3-v2';
const PRECACHE = [
    '/mp3/',
    '/mp3/style.css',
    '/mp3/script.js',
    '/mp3/manifest.json',
    '/mp3/favicon-192.png',
    '/mp3/favicon-512.png',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Never intercept API calls, downloads, or cross-origin requests
    // Let them go straight to the network with zero SW overhead
    if (
        url.pathname.startsWith('/mp3/api/') ||
        url.pathname.startsWith('/mp3/downloads/') ||
        url.origin !== self.location.origin
    ) {
        return; // bypass — browser handles it natively
    }

    // Static assets — cache first, network fallback
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(response => {
                // Only cache successful same-origin static responses
                if (response.ok && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return response;
            });
        })
    );
});