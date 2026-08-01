#!/usr/bin/env node
// Arena: HardBot (competitivo) contra BotController (normal) con los mismos
// mazos, en ambos asientos, sobre todos los starters. Mide si el cerebro
// nuevo es de verdad superior. Uso: node scripts/arena.mjs [partidas]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';
import { HardBot } from '../js/ai/hardbot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');
const nGames = parseInt(process.argv[2] ?? '60', 10);

const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const decks = Object.fromEntries(index.map((d) => [d.slug, JSON.parse(readFileSync(join(DIR, `${d.slug}.json`), 'utf8'))]));
const slugs = index.map((d) => d.slug);

let hardWins = 0, played = 0, crashes = 0, turns = 0;
for (let g = 0; g < nGames; g++) {
  // Espejo de mazos (mismo mazo para ambos: mide SOLO el cerebro) alternando
  // asiento inicial, sobre todos los starters.
  const slug = slugs[g % slugs.length];
  const hardFirst = g % 2 === 0;
  const hard = { name: 'HARD', deck: decks[slug], controller: new HardBot('H'), isBot: true };
  const norm = { name: 'NORM', deck: decks[slug], controller: new BotController('N'), isBot: true };
  const game = new Game(hardFirst ? [hard, norm] : [norm, hard], { seed: 9100 + g * 37 });
  try {
    const winner = await game.run();
    played++;
    turns += game.turn;
    if (winner.name === 'HARD') hardWins++;
  } catch (err) {
    crashes++;
    console.error(`Partida ${g + 1} (${slug}): CRASH:`, err.stack?.split('\n').slice(0, 3).join(' | '));
  }
}

const pct = Math.round((hardWins / Math.max(1, played)) * 100);
console.log(`\nArena espejo: HardBot gana ${hardWins}/${played} (${pct}%), ${crashes} crashes, media ${Math.round(turns / Math.max(1, played))} turnos.`);
if (crashes) process.exit(1);
if (pct < 60) { console.error('✗ El bot competitivo no supera el 60% contra el normal.'); process.exit(1); }
console.log('✅ Bot competitivo claramente superior al normal.');
