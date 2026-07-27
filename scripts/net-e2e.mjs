#!/usr/bin/env node
// F8 — E2E de red: arranca el servidor de salas real y conecta DOS clientes
// por WebSocket auténtico. Cada cliente usa el espejo ClientGame (la misma
// tubería que el navegador) y un bot como "humano". La partida debe llegar
// al final con mensajes 'end' en ambos asientos.
// Uso: node scripts/net-e2e.mjs

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotController } from '../js/ai/bot.js';
import { ClientGame } from '../js/net/clientGame.js';
import { makeSeat } from '../js/net/seat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8760 + Math.floor(Math.random() * 200);

// 1. Servidor real como proceso hijo.
const srv = spawn('node', [join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('el servidor no arrancó')), 8000);
  srv.stdout.on('data', (d) => { if (String(d).includes('escuchando')) { clearTimeout(to); res(); } });
});

// 2. Cliente genérico (la tubería del navegador, sin DOM).
function makeClient(name, deckSlug, onReady) {
  const cg = new ClientGame();
  const bot = new BotController(name);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const seat = makeSeat(bot, send, cg);
  const state = { code: null, ended: null, views: 0, asks: 0 };
  ws.onmessage = async (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text());
    switch (m.t) {
      case 'hello': state.code = m.code; onReady?.(m); break;
      case 'view': cg.update(m.view); bot.player = cg.players[m.view.youIdx]; state.views++; break;
      case 'ask': cg.absorbAskCards(m.payload?.cards); state.asks++; await seat(m); break;
      case 'end': state.ended = m; break;
      case 'error': console.error(`${name} error:`, m.msg); break;
      default: break;
    }
  };
  return { ws, send, state };
}

const timeout = setTimeout(() => { console.error('✗ TIMEOUT: la partida no terminó'); srv.kill(); process.exit(1); }, 90_000);

// 3. Crear sala y unirse.
const c1 = makeClient('Ana', 'st-01', (hello) => {
  // Cuando A tiene código, B se une.
  const int = setInterval(() => {
    if (c2.ws.readyState === 1) {
      clearInterval(int);
      c2.send({ t: 'join', code: hello.code, name: 'Berto', deckSlug: 'st-13' });
    }
  }, 50);
});
const c2 = makeClient('Berto', 'st-13', null);
c1.ws.onopen = () => c1.send({ t: 'create', name: 'Ana', deckSlug: 'st-01' });

// 4. Espera al final en ambos asientos.
while (!(c1.state.ended && c2.state.ended)) {
  await new Promise((r) => setTimeout(r, 200));
}
clearTimeout(timeout);

const w1 = c1.state.ended.winnerSeat;
console.log(`Partida online completa. Ganó el asiento ${w1} (${w1 === 0 ? 'Ana' : 'Berto'}).`);
console.log(`Ana: ${c1.state.views} vistas, ${c1.state.asks} preguntas · Berto: ${c2.state.views} vistas, ${c2.state.asks} preguntas.`);
if (c1.state.ended.winnerSeat !== c2.state.ended.winnerSeat) {
  console.error('✗ Los dos asientos discrepan del ganador');
  process.exit(1);
}
console.log('✅ Servidor autoritativo + dos clientes ClientGame: OK');
srv.kill();
process.exit(0);
