// app-sample/traffic.js
// Génère du trafic continu sur ShopFlow app-sample
// Simule un mix réaliste de navigation e-commerce

const http = require('http');

const TARGET = process.env.TARGET_URL || 'http://localhost:8080';
const parsed = new URL(TARGET);
const HOST = parsed.hostname;
const PORT = parseInt(parsed.port) || 80;

// Répartition du trafic par route (poids relatifs)
const ROUTES = [
  { path: '/api/products', method: 'GET',  weight: 40 },
  { path: '/api/checkout', method: 'POST', weight: 25 },
  { path: '/api/users',    method: 'GET',  weight: 20 },
  { path: '/health',       method: 'GET',  weight: 15 },
];

// Construire la table de sélection pondérée
const table = [];
ROUTES.forEach(r => {
  for (let i = 0; i < r.weight; i++) table.push(r);
});

function pick() {
  return table[Math.floor(Math.random() * table.length)];
}

function request(route) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: HOST, port: PORT, path: route.path, method: route.method },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve); // ignorer les erreurs réseau transitoires
    req.end();
  });
}

async function loop() {
  // Attendre que app-sample soit prêt
  await new Promise(r => setTimeout(r, 3000));
  console.log(`[traffic-generator] Démarrage — cible : ${TARGET}`);

  while (true) {
    const route = pick();
    request(route).catch(() => {});
    // Intervalle entre requêtes : 200–600ms → ~2–5 req/s
    await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
  }
}

loop();
