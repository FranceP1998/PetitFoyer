// Service worker minimo: tiene in cache i file dell'app per aprirla più in fretta
// e per mostrarla anche con rete debole. I dati (Supabase) non vengono mai messi in cache.
const CACHE = 'turni-v33';
const FILE = ['./', 'index.html', 'css/app.css', 'css/print.css', 'js/app.js', 'js/grid.js', 'js/data.js', 'js/pdf.js', 'js/pdf-metrics.js', 'js/cella.js', 'js/mutua.js', 'js/richieste.js', 'js/generatore.js',
  'js/config.js', 'js/demo-data.js', 'manifest.webmanifest', 'assets/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;       // dati e CDN: mai in cache
  // prima la rete (così gli aggiornamenti arrivano subito), la cache solo se manca la rete
  e.respondWith(fetch(e.request).then((r) => {
    const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r;
  }).catch(() => caches.match(e.request)));
});
