#!/usr/bin/env node
// F8 — Servidor autoritativo de salas para el multijugador online.
//
// El motor completo (js/engine/) corre AQUÍ; cada navegador solo recibe su
// vista filtrada y responde preguntas. Salas por código de 4 letras,
// reconexión por token (recargar la página no pierde la partida).
//
// Uso:  cd server && npm install && npm start     (PORT=8765 por defecto)

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Game } from '../js/engine/game.js';
import { RemoteController } from '../js/net/remote.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const DECKS = {};
for (const d of index) DECKS[d.slug] = JSON.parse(readFileSync(join(DIR, `${d.slug}.json`), 'utf8'));

const PORT = parseInt(process.env.PORT ?? '8765', 10);

// ---- servidor HTTP: sirve el juego estático (mismo origen que el WebSocket,
// para que el online funcione sin configurar nada) ------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
// Solo estas carpetas/archivos del repo se sirven (nunca server/ ni .git).
const SERVE_OK = /^(index\.html|js\/|css\/|data\/|assets\/|favicon)/;

const httpServer = createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  if (rel === '' || rel === '/') rel = 'index.html';
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!SERVE_OK.test(safe)) { res.writeHead(404); return res.end('Not found'); }
  const file = join(ROOT, safe);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': safe === 'index.html' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(readFileSync(file));
});
const rooms = new Map();          // code → room
const byToken = new Map();        // token → {room, seatIdx}
const ROOM_TTL_MS = 45 * 60 * 1000;

const newCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // sin I/O (se confunden con 1/0)
  let c;
  do { c = [...randomBytes(4)].map((b) => A[b % A.length]).join(''); } while (rooms.has(c));
  return c;
};
const newToken = () => randomBytes(12).toString('hex');

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function pushView(room, idx) {
  const seat = room.seats[idx];
  if (!seat || !room.game || !seat.rc?.player) return;
  send(seat.ws, { t: 'view', view: room.game.viewFor(seat.rc.player) });
}

function broadcast(room, obj) {
  for (const s of room.seats) if (s) send(s.ws, obj);
}

// Coalescencia: muchas líneas de log seguidas → una sola vista fresca.
function scheduleViews(room) {
  if (room._viewTimer) return;
  room._viewTimer = setTimeout(() => {
    room._viewTimer = null;
    pushView(room, 0);
    pushView(room, 1);
  }, 25);
}

async function startGame(room) {
  room.started = true;
  const mk = (idx) => {
    const rc = new RemoteController((msg) => send(room.seats[idx].ws, msg));
    rc.beforeAsk = () => pushView(room, idx);
    room.seats[idx].rc = rc;
    return rc;
  };
  const configs = room.seats.map((seat, idx) => ({
    name: seat.name || `Jugador ${idx + 1}`,
    deck: DECKS[seat.deckSlug] ?? DECKS[index[0].slug],
    controller: mk(idx),
    isBot: false,
  }));
  // Quién empieza, al azar (la semilla también decide barajados).
  if (Math.random() < 0.5) configs.reverse();

  const game = new Game(configs, {
    seed: (Math.random() * 2 ** 31) | 0,
    onLog: (line) => {
      room.log.push(line);
      broadcast(room, { t: 'log', line });
      scheduleViews(room);   // agrupa ráfagas de cambios en un solo envío de vista
    },
    // ev.actorIdx es índice del MOTOR; el cliente compara con view.youIdx
    // (también índice del motor), así que viaja tal cual.
    onNarrate: (ev) => broadcast(room, { t: 'narrate', ev }),
    onAnimate: (ev) => { broadcast(room, { t: 'animate', ev }); return Promise.resolve(); },
  });
  room.game = game;
  // Enlaza cada RemoteController con su Player (configs pudo invertirse).
  for (const seat of room.seats) {
    seat.rc.player = game.players.find((p) => p.controller === seat.rc);
  }

  broadcast(room, { t: 'status', msg: '¡Rival encontrado! Comienza la partida.' });
  pushView(room, 0); pushView(room, 1);
  try {
    const winner = await game.run();
    const winSeat = room.seats.findIndex((s) => s.rc?.player === winner);
    broadcast(room, { t: 'end', winnerSeat: winSeat, reason: game.players.find((p) => p !== winner)?.lossReason ?? '' });
  } catch (err) {
    console.error(`sala ${room.code}:`, err);
    broadcast(room, { t: 'error', msg: `Error del motor: ${err.message}` });
  }
  setTimeout(() => closeRoom(room), 60 * 1000);
}

function closeRoom(room) {
  for (const s of room.seats) if (s) byToken.delete(s.token);
  rooms.delete(room.code);
}

// El WebSocket comparte el mismo servidor/puerto que el estático: así la
// página y el juego online salen del MISMO origen (wss:// automático).
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => {
  console.log(`⚓ Servidor OPTCG escuchando en http://0.0.0.0:${PORT} (juego + salas, ${index.length} mazos)`);
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { handle(ws, msg); } catch (err) {
      console.error('handle:', err);
      send(ws, { t: 'error', msg: err.message });
    }
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      const code = newCode();
      const token = newToken();
      const room = { code, seats: [null, null], game: null, started: false, log: [], createdAt: Date.now() };
      room.seats[0] = { ws, token, name: String(msg.name ?? '').slice(0, 24), deckSlug: msg.deckSlug, rc: null };
      rooms.set(code, room);
      byToken.set(token, { room, seatIdx: 0 });
      send(ws, { t: 'hello', seat: 0, code, token });
      send(ws, { t: 'status', msg: `Sala ${code} creada. Comparte el código con tu rival.` });
      break;
    }
    case 'join': {
      const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!room) return send(ws, { t: 'error', msg: 'No existe ninguna sala con ese código.' });
      if (room.seats[1]) return send(ws, { t: 'error', msg: 'La sala ya está completa.' });
      const token = newToken();
      room.seats[1] = { ws, token, name: String(msg.name ?? '').slice(0, 24), deckSlug: msg.deckSlug, rc: null };
      byToken.set(token, { room, seatIdx: 1 });
      send(ws, { t: 'hello', seat: 1, code: room.code, token });
      startGame(room);
      break;
    }
    case 'rejoin': {
      const entry = byToken.get(msg.token);
      if (!entry) return send(ws, { t: 'error', msg: 'La sala ya no existe.' });
      const { room, seatIdx } = entry;
      room.seats[seatIdx].ws = ws;
      send(ws, { t: 'hello', seat: seatIdx, code: room.code, token: msg.token });
      for (const line of room.log.slice(-40)) send(ws, { t: 'log', line });
      pushView(room, seatIdx);
      // attach reenvía la pregunta pendiente si el motor espera respuesta.
      room.seats[seatIdx].rc?.attach((m) => send(room.seats[seatIdx].ws, m));
      break;
    }
    case 'answer': {
      // Localiza el asiento por el propio ws.
      for (const room of rooms.values()) {
        for (const seat of room.seats) {
          if (seat?.ws === ws && seat.rc) seat.rc.answer(msg.reqId, msg.value);
        }
      }
      break;
    }
    default: break;
  }
}

// Limpieza de salas muertas.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > ROOM_TTL_MS && !room.started) closeRoom(room);
  }
}, 60 * 1000);
