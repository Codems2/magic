#!/usr/bin/env node
// F4 — Evaluación del bot: partidas contra un bot débil de referencia.
// El bot bueno debe ganar con claridad (>75%) para dar por buena la fase.
// Uso: node scripts/eval.mjs [nPartidas]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');

// Bot débil: juega por curva, pega siempre al líder, nunca defiende.
class WeakBot {
  constructor() { this.player = null; }
  async mulligan() { return false; }
  async mainAction(game) {
    const p = this.player;
    const playable = p.hand
      .filter((c) => c.isCharacter && c.cost <= p.donActive && p.characters.length < 5)
      .sort((a, b) => b.cost - a.cost)[0];
    if (playable) return { type: 'playCharacter', cardId: playable.id };
    const opp = game.opponentOf(p);
    const atk = [p.leader, ...p.characters].find((c) => c && c.canAttack(game) &&
      c.power(game) >= opp.leader.power(game));
    if (atk) return { type: 'attack', attackerId: atk.id, targetId: 'leader' };
    return { type: 'pass' };
  }
  async chooseBlocker() { return null; }
  async counterStep() { return []; }
  async chooseTarget(game, { candidateIds }) { return candidateIds[0] ?? null; }
  async discardFromHand(game, n) { return this.player.hand.slice(0, n).map((c) => c.id); }
  async triggerDecision() { return true; }
  async payOptionalCost() { return false; }
}

const nGames = parseInt(process.argv[2] ?? '40', 10);
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const decks = index.map((d) => JSON.parse(readFileSync(join(DIR, `${d.slug}.json`), 'utf8')));

let smartWins = 0;
let crashes = 0;
for (let g = 0; g < nGames; g++) {
  const deckA = decks[g % decks.length];
  const deckB = decks[(g + 1 + Math.floor(g / decks.length)) % decks.length];
  const smartFirst = g % 2 === 0; // alterna quién empieza
  const configs = smartFirst
    ? [
      { name: 'Smart', deck: deckA, controller: new BotController('S'), isBot: true },
      { name: 'Weak', deck: deckB, controller: new WeakBot(), isBot: true },
    ]
    : [
      { name: 'Weak', deck: deckB, controller: new WeakBot(), isBot: true },
      { name: 'Smart', deck: deckA, controller: new BotController('S'), isBot: true },
    ];
  const game = new Game(configs, { seed: 5000 + g * 17 });
  try {
    const winner = await game.run();
    if (winner.name === 'Smart') smartWins++;
  } catch (err) {
    crashes++;
    console.error(`CRASH partida ${g + 1}:`, err.stack?.split('\n').slice(0, 3).join(' | '));
  }
}

const pct = Math.round((smartWins / (nGames - crashes)) * 100);
console.log(`Bot bueno vs bot débil: ${smartWins}/${nGames - crashes} victorias (${pct}%), ${crashes} crashes.`);
console.log(pct >= 75 ? '✅ F4 supera el umbral (75%).' : '❌ Por debajo del umbral: revisar heurísticas.');
