#!/usr/bin/env node
// Simulación headless bot-vs-bot para validar el motor y el nivel de los bots.
// Uso: node scripts/simulate.mjs [nPartidas] [--verbose]

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'precons');

const nGames = parseInt(process.argv[2] ?? '5', 10);
const verbose = process.argv.includes('--verbose');

const slugs = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8')).map((d) => d.slug);
const decks = Object.fromEntries(slugs.map((s) => [s, JSON.parse(readFileSync(join(DIR, `${s}.json`), 'utf8'))]));

const wins = {};
let crashes = 0;
let totalTurns = 0;

for (let g = 0; g < nGames; g++) {
  const pick = slugs.slice();
  // rotación de mazos por partida
  const chosen = [0, 1, 2, 3].map((i) => pick[(g + i * 2) % pick.length]);
  const configs = chosen.map((slug, i) => ({
    name: `Bot${i + 1}(${decks[slug].name})`,
    deck: decks[slug],
    controller: new BotController(`Bot${i + 1}`),
    isBot: true,
  }));
  const game = new Game(configs, {
    seed: 1000 + g * 17,
    onLog: verbose ? (m) => console.log(`  ${m}`) : null,
    maxTurns: 100,
  });
  try {
    const winner = await game.run();
    totalTurns += game.turn;
    const name = winner?.deck.name ?? '(nadie)';
    wins[name] = (wins[name] ?? 0) + 1;
    console.log(`Partida ${g + 1}: gana ${winner?.name ?? 'nadie'} en ${game.turn} turnos. Vidas finales: ${game.players.map((p) => `${p.deck.name}=${p.lost ? '☠' : p.life}`).join(', ')}`);
  } catch (err) {
    crashes++;
    console.error(`Partida ${g + 1}: CRASH en turno ${game.turn}:`, err.stack?.split('\n').slice(0, 4).join('\n'));
  }
}

console.log(`\nResumen: ${nGames} partidas, ${crashes} crashes, media ${Math.round(totalTurns / Math.max(1, nGames - crashes))} turnos.`);
console.log('Victorias por mazo:', wins);
