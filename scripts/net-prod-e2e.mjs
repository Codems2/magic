#!/usr/bin/env node
// E2E de PRODUCCIÓN (sin navegador): arranca el servidor UNIFICADO tal cual
// corre en Render (juego estático + salas WebSocket en un ÚNICO puerto) y
// comprueba las dos mitades sobre el MISMO origen:
//   1. HTTP: sirve index.html y los módulos/datos del juego.
//   2. WS  : dos clientes ClientGame crean/entran a una sala por ese mismo
//            puerto y juegan una partida completa hasta el final.
// Uso: node scripts/net-prod-e2e.mjs

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotController } from '../js/ai/bot.js';
import { ClientGame } from '../js/net/clientGame.js';
import { makeSeat } from '../js/net/seat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn('node', [join(ROOT, 'server', 'index.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error('el servidor no arrancó')), 8000);
  srv.stdout.on('data', (d) => { if (String(d).includes('escuchando')) { clearTimeout(to); res(); } });
});

let ok = true;
const fail = (m) => { console.error('✗', m); ok = false; };

// --- 1. HTTP estático desde el mismo servidor ---
async function check(path, mustInclude) {
  const r = await fetch(BASE + path);
  if (!r.ok) return fail(`${path} → HTTP ${r.status}`);
  const body = await r.text();
  if (mustInclude && !body.includes(mustInclude)) return fail(`${path} no contiene "${mustInclude}"`);
  console.log(`  HTTP ${path} → ${r.status} (${(r.headers.get('content-type') || '').split(';')[0]})`);
}
await check('/index.html', 'Simulador');
await check('/js/main.js', 'startOnline');
await check('/js/net/client.js', 'connectOnline');
await check('/data/decks/index.json', 'st-01');
// Seguridad: el código del servidor NO debe servirse.
{
  const r = await fetch(BASE + '/server/index.mjs');
  if (r.ok) fail('¡el servidor sirve su propio código! (debería ser 404)');
  else console.log(`  HTTP /server/index.mjs → ${r.status} (bloqueado, correcto)`);
}

// --- 2. WebSocket en el MISMO puerto: partida completa entre dos clientes ---
function makeClient(name, deckSlug) {
  const cg = new ClientGame();
  const bot = new BotController(name);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);   // mismo puerto que el HTTP
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const seat = makeSeat(bot, send, cg);
  const st = { code: null, ended: null };
  ws.onmessage = async (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text());
    if (m.t === 'hello') st.code = m.code;
    else if (m.t === 'view') { cg.update(m.view); bot.player = cg.players[m.view.youIdx]; }
    else if (m.t === 'ask') { cg.absorbAskCards(m.payload?.cards); await seat(m); }
    else if (m.t === 'end') st.ended = m;
  };
  return { ws, send, st };
}

const to = setTimeout(() => { fail('TIMEOUT: la partida online no terminó'); finish(); }, 90_000);
const c1 = makeClient('Ana', 'st-01');
c1.ws.onopen = () => c1.send({ t: 'create', name: 'Ana', deckSlug: 'st-01' });
const c2 = makeClient('Berto', 'st-13');
const joinInt = setInterval(() => {
  if (c1.st.code && c2.ws.readyState === 1) {
    clearInterval(joinInt);
    c2.send({ t: 'join', code: c1.st.code, name: 'Berto', deckSlug: 'st-13' });
  }
}, 40);

while (ok && !(c1.st.ended && c2.st.ended)) await new Promise((r) => setTimeout(r, 150));
clearTimeout(to);

if (c1.st.ended && c2.st.ended) {
  if (c1.st.ended.winnerSeat !== c2.st.ended.winnerSeat) fail('los asientos discrepan del ganador');
  else console.log(`  WS: partida completa por el mismo puerto; ganó el asiento ${c1.st.ended.winnerSeat}.`);
}
finish();

function finish() {
  srv.kill();
  if (ok) console.log('✅ E2E de producción OK: un solo servidor sirve el juego y las salas online por el mismo origen (como en Render).');
  process.exit(ok ? 0 : 1);
}
