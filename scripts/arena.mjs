#!/usr/bin/env node
// Arena espejo: dos cerebros con el MISMO mazo, alternando asiento, sobre
// todos los starters — mide solo la calidad del cerebro.
// Uso: node scripts/arena.mjs [partidas] [hard-normal|search-hard]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';
import { HardBot } from '../js/ai/hardbot.js';
import { SearchBot } from '../js/ai/searchbot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');
const nGames = parseInt(process.argv[2] ?? '60', 10);
const mode = process.argv[3] ?? 'hard-normal';
const [mkA, mkB, labelA, labelB, threshold] = mode === 'search-hard'
  ? [() => new SearchBot('S'), () => new HardBot('H'), 'SearchBot(Maestro)', 'HardBot(Competitivo)', 55]
  : [() => new HardBot('H'), () => new BotController('N'), 'HardBot(Competitivo)', 'BotController(Normal)', 60];

const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const decks = Object.fromEntries(index.map((d) => [d.slug, JSON.parse(readFileSync(join(DIR, `${d.slug}.json`), 'utf8'))]));
const slugs = index.map((d) => d.slug);

let aWins = 0, played = 0, crashes = 0, turns = 0;
const t0 = Date.now();
for (let g = 0; g < nGames; g++) {
  const slug = slugs[g % slugs.length];
  const aFirst = g % 2 === 0;
  const A = { name: 'A', deck: decks[slug], controller: mkA(), isBot: true };
  const B = { name: 'B', deck: decks[slug], controller: mkB(), isBot: true };
  const game = new Game(aFirst ? [A, B] : [B, A], { seed: 9100 + g * 37 });
  try {
    const winner = await game.run();
    played++;
    turns += game.turn;
    if (winner.name === 'A') aWins++;
  } catch (err) {
    crashes++;
    console.error(`Partida ${g + 1} (${slug}): CRASH:`, err.stack?.split('\n').slice(0, 3).join(' | '));
  }
}

const pct = Math.round((aWins / Math.max(1, played)) * 100);
console.log(`\nArena espejo (${labelA} vs ${labelB}): gana ${aWins}/${played} (${pct}%), ${crashes} crashes, media ${Math.round(turns / Math.max(1, played))} turnos, ${Math.round((Date.now() - t0) / 1000)}s.`);
if (crashes) process.exit(1);
if (pct < threshold) { console.error(`✗ ${labelA} no supera el ${threshold}% contra ${labelB}.`); process.exit(1); }
console.log(`✅ ${labelA} claramente superior.`);
