#!/usr/bin/env node
// F7a — Test de loopback: una partida completa donde las decisiones del
// jugador 1 viajan por un "socket" en memoria que fuerza JSON.stringify/parse
// en ambos sentidos. Si algo dependiera de referencias de objetos o de tipos
// no serializables, este test lo destapa.
// Uso: node scripts/net-loopback.mjs [nPartidas]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';
import { RemoteController } from '../js/net/remote.js';
import { makeSeat } from '../js/net/seat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const deckOf = (slug) => JSON.parse(readFileSync(join(DIR, `${slug}.json`), 'utf8'));

const nGames = parseInt(process.argv[2] ?? '10', 10);

// Canal en memoria con serialización JSON REAL en ambos sentidos.
function jsonChannel(onMessage) {
  let stats = { msgs: 0, bytes: 0 };
  const send = (obj) => {
    const wire = JSON.stringify(obj);           // → red
    stats.msgs++; stats.bytes += wire.length;
    queueMicrotask(() => onMessage(JSON.parse(wire)));  // ← red
  };
  return { send, stats };
}

let fails = 0;
let totalMsgs = 0;
for (let g = 0; g < nGames; g++) {
  const a = index[g % index.length].slug;
  const b = index[(g + 3) % index.length].slug;

  // El "cliente": un bot que responde a las preguntas COMO LO HARÍA la UI,
  // usando solo los datos del payload (ids) — sin acceso al motor.
  const clientBot = new BotController('remoto');
  let seatHandler = null;
  let remote = null;

  // servidor → cliente
  const toClient = jsonChannel((msg) => {
    if (msg.t === 'ask') seatHandler(msg);
  });
  // cliente → servidor
  const toServer = jsonChannel((msg) => {
    if (msg.t === 'answer') remote.answer(msg.reqId, msg.value);
  });

  remote = new RemoteController(toClient.send);

  const game = new Game([
    { name: 'Remoto', deck: deckOf(a), controller: remote, isBot: false },
    { name: 'Local', deck: deckOf(b), controller: new BotController('local'), isBot: true },
  ], { seed: 1000 + g, maxTurns: 40 });

  // El bot cliente necesita un "game" para sus heurísticas: en este test le
  // damos el motor real SOLO COMO ORÁCULO de lectura (byId). La partida
  // real de F8 usará ClientGame; aquí lo que se valida es el protocolo.
  clientBot.player = game.players[0];
  seatHandler = makeSeat(clientBot, toServer.send, game);

  try {
    const winner = await game.run();
    if (!winner) throw new Error('sin ganador');
    totalMsgs += toClient.stats.msgs + toServer.stats.msgs;
  } catch (err) {
    fails++;
    console.error(`✗ partida ${g} (${a} vs ${b}): ${err.message}`);
  }
}

console.log(`Loopback: ${nGames} partidas por canal JSON, ${fails} fallos, ${totalMsgs} mensajes serializados.`);
if (fails) process.exit(1);
console.log('✅ Todas las decisiones viajan como JSON puro (sin referencias).');
