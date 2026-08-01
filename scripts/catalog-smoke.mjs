#!/usr/bin/env node
// Smoke-test del catálogo COMPLETO: cada carta se añade a la mano en una
// partida sandbox y se juega/activa, cazando crashes de ops en runtime.
// (La verificación semántica profunda sigue siendo scripts/sandbox.mjs sobre
// los starters; esto garantiza que NINGUNA carta del pool revienta el motor.)
// Uso: node scripts/catalog-smoke.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { BotController } from '../js/ai/bot.js';
import { abilitiesOf } from '../js/engine/effects.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'cards', 'catalog.json'), 'utf8'));
const st01 = JSON.parse(readFileSync(join(ROOT, 'data', 'decks', 'st-01.json'), 'utf8'));
const st02 = JSON.parse(readFileSync(join(ROOT, 'data', 'decks', 'st-02.json'), 'utf8'));

let played = 0, activated = 0, errors = 0;
const failed = [];

// Una partida sandbox reutilizable por lotes (reiniciada cada 60 cartas para
// que las zonas no se desborden).
let game = null, me = null;
async function freshGame(seed) {
  game = new Game([
    { name: 'A', deck: st01, controller: new BotController('A'), isBot: true },
    { name: 'B', deck: st02, controller: new BotController('B'), isBot: true },
  ], { seed, sandbox: true });
  await game.start();
  me = game.players[0];
  game.turn = 3; game.activeIdx = 0; game.phase = 'main';
  me.donActive = 10;
  // Rival con tablero para que los efectos tengan objetivos.
  const rival = game.players[1];
  for (let i = rival.library.length - 1; i >= 0 && rival.characters.length < 3; i--) {
    const c = rival.library[i];
    if (!c.isCharacter) continue;
    rival.library.splice(i, 1);
    c.zone = 'characters'; c.rested = rival.characters.length < 2;
    rival.characters.push(c);
  }
  rival.donActive = 5;
  game._mute = true;
}

let batch = 0;
for (const data of catalog) {
  if (batch % 60 === 0) await freshGame(4000 + batch);
  batch++;
  try {
    if (data.type === 'Leader') continue;   // los líderes no se "juegan"
    const c = game.addCardToHand(me, data);
    me.donActive = Math.max(me.donActive, (c.cost ?? 0) + 2);
    if (c.isCharacter) {
      if (me.characters.length >= 5) {
        const v = me.characters.shift(); v.zone = 'trash'; me.trash.push(v);
      }
      await game.performAction(me, { type: 'playCharacter', cardId: c.id });
      played++;
      const ab = abilitiesOf(c, 'activateMain')[0];
      if (ab && !ab.donX && game.canPayAbilityCost(me, c, ab.cost)) {
        await game.performAction(me, { type: 'activate', cardId: c.id });
        activated++;
      }
    } else if (c.isEvent) {
      if (abilitiesOf(c, 'main')[0] && game.canPayAbilityCost(me, c, abilitiesOf(c, 'main')[0].cost)) {
        await game.performAction(me, { type: 'playEvent', cardId: c.id });
        played++;
      }
    } else if (c.isStage) {
      if (me.stage) { const st = me.stage; me.stage = null; st.zone = 'trash'; me.trash.push(st); }
      await game.performAction(me, { type: 'playStage', cardId: c.id });
      played++;
    }
  } catch (err) {
    // Un rechazo de VALIDACIÓN del motor (acción ilegal en el estado del
    // lote) no es un crash: solo cuentan los errores reales de ejecución.
    if (!/inválida|inválido|no puede/i.test(err.message)) {
      errors++;
      failed.push([data.id, err.message]);
    }
    await freshGame(9000 + batch);   // partida limpia tras un fallo
  }
}

console.log(`Jugadas: ${played} · activadas: ${activated} · errores: ${errors}`);
for (const [id, msg] of failed.slice(0, 20)) console.log(`  ✗ ${id}: ${msg}`);
if (failed.length > 20) console.log(`  … y ${failed.length - 20} más`);
process.exit(errors ? 1 : 0);
