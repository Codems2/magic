#!/usr/bin/env node
// Validación headless del Coach ST-36: partidas completas con el coach
// enganchado a TODOS los puntos de decisión del jugador (como hace la UI).
// Comprueba que cada consejo se genera sin errores y no viene vacío.
// Uso: node scripts/coach-check.mjs [--verbose]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';
import { Coach } from '../js/ui/coach.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');
const verbose = process.argv.includes('--verbose');

const deck = (slug) => JSON.parse(readFileSync(join(DIR, `${slug}.json`), 'utf8'));
const strip = (s) => String(s).replace(/<[^>]+>/g, '');

const counts = {};   // consejos generados por gancho
const samples = {};  // un ejemplo de texto por gancho
let errors = 0;

// Jugador "humano" simulado: decide como el bot, pero antes pide consejo al
// coach en cada gancho, exactamente igual que HumanController.
function coachedController() {
  const ctl = new BotController('Tú');
  const coach = new Coach(ctl);
  const note = (hook, text) => {
    if (text === '' && (hook === 'payCost')) return; // payCost puede callar (carta sin consejo)
    if (typeof text !== 'string' || !text.trim()) throw new Error(`consejo vacío en ${hook}`);
    counts[hook] = (counts[hook] ?? 0) + 1;
    samples[hook] ??= strip(text).slice(0, 150);
    if (verbose) console.log(`  [${hook}] ${strip(text)}`);
  };
  const guard = (hook, fn) => async (...args) => {
    try { note(hook, await fn(...args)); }
    catch (err) { errors++; console.error(`  ✗ ${hook}: ${err.message}`); }
  };
  const wrap = (method, hook, advise) => {
    const orig = ctl[method].bind(ctl);
    const adv = guard(hook, advise);
    ctl[method] = async (...args) => { await adv(...args); return orig(...args); };
  };
  wrap('mulligan', 'mulligan', (game) => coach.adviseMulligan(game));
  wrap('mainAction', 'panel', (game) => {
    coach.updatePanel(game);
    if (!coach.lastPlan.length || coach.lastPlan.some((s) => !s.lines.length)) {
      throw new Error('panel sin secciones o con secciones vacías');
    }
    return coach.lastPlan.map((s) => `${s.title}: ${s.lines.join(' | ')}`).join(' || ');
  });
  wrap('chooseBlocker', 'blocker', (game, ask) => coach.adviseBlocker(game, ask));
  wrap('counterStep', 'counter', (game, ask) => coach.adviseCounter(game, ask));
  wrap('triggerDecision', 'trigger', (game, ask) => coach.adviseTrigger(game, ask.cardId));
  wrap('payOptionalCost', 'payCost', (game, ask) => coach.advisePayCost(game, ask));
  wrap('chooseTarget', 'target', (game, ask) => coach.adviseTarget(game, ask));
  wrap('discardFromHand', 'discard', (game, n, opts) => coach.adviseDiscard(game, n, opts ?? {}));
  wrap('chooseRevealed', 'revealed', (game, ask) => coach.adviseRevealed(game, ask));
  return ctl;
}

const rivals = ['st-31', 'st-32', 'st-33', 'st-34', 'st-35', 'st-36'];
let crashes = 0;
for (let g = 0; g < rivals.length; g++) {
  const me = coachedController();
  const game = new Game([
    { name: 'Tú (ST-36 + coach)', deck: deck('st-36'), controller: me, isBot: true },
    { name: `Rival (${rivals[g]})`, deck: deck(rivals[g]), controller: new BotController('Rival'), isBot: true },
  ], { seed: 7100 + g * 17 });
  try {
    const winner = await game.run();
    console.log(`Partida ${g + 1} vs ${rivals[g].toUpperCase()}: gana ${winner.deck.id} en ${game.turn} turnos.`);
  } catch (err) {
    crashes++;
    console.error(`Partida ${g + 1}: CRASH:`, err.stack?.split('\n').slice(0, 3).join(' | '));
  }
}

console.log('\nConsejos generados por gancho:');
for (const [hook, n] of Object.entries(counts).sort()) {
  console.log(`  ${hook.padEnd(9)} ${String(n).padStart(4)} · ej.: ${samples[hook]}`);
}
const required = ['mulligan', 'panel', 'counter', 'trigger', 'payCost', 'blocker'];
const missing = required.filter((h) => !counts[h]);
if (missing.length) console.error(`\n✗ Ganchos sin ejercitar: ${missing.join(', ')}`);
if (errors || crashes || missing.length) {
  console.error(`\n✗ FALLO — errores de consejo: ${errors}, crashes: ${crashes}`);
  process.exit(1);
}
console.log('\n✅ Coach OK: consejos en todos los ganchos, sin errores ni crashes.');
