#!/usr/bin/env node
// Validación headless: partidas bot vs bot con los starter decks.
// Uso: node scripts/simulate.mjs [nPartidas] [--verbose]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');

const nGames = parseInt(process.argv[2] ?? '8', 10);
const verbose = process.argv.includes('--verbose');

const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const decks = Object.fromEntries(index.map((d) => [d.slug, JSON.parse(readFileSync(join(DIR, `${d.slug}.json`), 'utf8'))]));
const slugs = index.map((d) => d.slug);

let crashes = 0;
let totalTurns = 0;
const wins = {};

for (let g = 0; g < nGames; g++) {
  const a = slugs[g % slugs.length];
  const b = slugs[(g + 1 + Math.floor(g / slugs.length)) % slugs.length];
  const game = new Game([
    { name: `Bot1(${decks[a].leader.name})`, deck: decks[a], controller: new BotController('B1'), isBot: true },
    { name: `Bot2(${decks[b].leader.name})`, deck: decks[b], controller: new BotController('B2'), isBot: true },
  ], { seed: 2000 + g * 31, onLog: verbose ? (m) => console.log('  ' + m) : null });
  try {
    const winner = await game.run();
    totalTurns += game.turn;
    wins[winner.deck.id] = (wins[winner.deck.id] ?? 0) + 1;
    const loser = game.opponentOf(winner);
    console.log(`Partida ${g + 1}: ${decks[a].id} vs ${decks[b].id} → gana ${winner.deck.id} en ${game.turn} turnos (vidas ${winner.life.length}-${loser.life.length}, ${loser.lossReason}).`);
  } catch (err) {
    crashes++;
    console.error(`Partida ${g + 1}: CRASH turno ${game.turn}:`, err.stack?.split('\n').slice(0, 3).join(' | '));
  }
}

console.log(`\nResumen: ${nGames} partidas, ${crashes} crashes, media ${Math.round(totalTurns / Math.max(1, nGames - crashes))} turnos.`);
console.log('Victorias:', wins);
