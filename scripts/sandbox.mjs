#!/usr/bin/env node
// Sandbox de pruebas: juega TODAS las cartas una a una y dispara cada uno de
// sus timings mediante EVENTOS REALES de partida (ataques, bloqueos, KOs...).
// Clasifica cada escenario:
//   ERR  — el efecto lanza una excepción.
//   MISS — la habilidad NO llegó a ejecutarse (bug de despacho del motor).
//   NOOP — se ejecutó pero sin actividad visible (condición no satisfecha o bug).
//   SKIP — el sandbox no pudo montar el escenario (p. ej. sin blocker rival).
//   OK   — la habilidad se despachó y produjo actividad.
// Uso: node scripts/sandbox.mjs [--full] [ID...]   (--full lista NOOP/SKIP)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../js/engine/game.js';
import { abilitiesOf } from '../js/engine/effects.js';
import { snap, checkOp, WRAPPERS } from './opcheck.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');

const full = process.argv.includes('--full');
const onlyIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// ---- catálogo -------------------------------------------------------------
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const decks = {};
for (const d of index) decks[d.slug] = JSON.parse(readFileSync(join(DIR, `${d.slug}.json`), 'utf8'));

const catalog = new Map(); // id → {card, slug} (mazo de origen: líder correcto)
for (const d of index) {
  const deck = decks[d.slug];
  for (const c of [deck.leader, ...(deck.altLeaders ?? []), ...deck.cards]) {
    if (c && !catalog.has(c.id)) catalog.set(c.id, { card: c, slug: d.slug });
  }
}

// ---- controlador automático ----------------------------------------------
function autoCtrl(overrides = {}) {
  return {
    player: null,
    async mulligan() { return false; },
    async mainAction() { return { type: 'pass' }; },
    async chooseTarget(g, { candidateIds }) { return candidateIds[0] ?? null; },
    async chooseBlocker() { return null; },
    async counterStep() { return { discardIds: [], eventIds: [] }; },
    async discardFromHand(g, n, opts = {}) {
      const pool = opts.fromIds ?? (this.player?.hand ?? []).map((c) => c.id);
      return pool.slice(0, Math.max(opts.min ?? n, Math.min(n, 2)));
    },
    async triggerDecision() { return true; },
    async payOptionalCost() { return true; },
    async chooseOption() { return 0; },
    async chooseRevealed(g, { pickableIds, max = 1 }) { return pickableIds.slice(0, max); },
    ...overrides,
  };
}

// ---- montaje --------------------------------------------------------------
async function newGame(deck, oppDeck, p1Overrides = {}, p2Overrides = {}) {
  const g = new Game([
    { name: 'P1', deck, controller: autoCtrl(p1Overrides), isBot: false },
    { name: 'P2', deck: oppDeck, controller: autoCtrl(p2Overrides), isBot: true },
  ], { seed: 11, maxTurns: 99 });
  await g.start();
  const [p1, p2] = g.players;
  g.turn = 5; g.activeIdx = 0; g.phase = 'main';
  p1.donActive = 10; p2.donActive = 10;
  p1.donRested = 2; p2.donRested = 2;

  const seedBoard = (p, nRested) => {
    let moved = 0;
    for (let i = p.library.length - 1; i >= 0 && moved < 3; i--) {
      const c = p.library[i];
      if (!c.isCharacter) continue;
      p.library.splice(i, 1);
      c.zone = 'characters'; c.enteredTurn = 1; c.summonedThisTurn = false;
      c.rested = moved < nRested;
      p.characters.push(c);
      moved++;
    }
  };
  seedBoard(p1, 1);   // uno girado propio (objetivo de "endereza tus...")
  seedBoard(p2, 2);   // dos girados rivales (objetivos de KO/ataque)

  for (const p of [p1, p2]) {
    for (let i = 0; i < 6 && p.library.length > 10; i++) {
      const c = p.library.pop();
      c.zone = 'trash'; p.trash.push(c);
    }
    while (p.life.length > 2) { const c = p.life.pop(); c.zone = 'deck'; p.library.push(c); }
  }
  return g;
}

function getInstance(g, cardId) {
  const p1 = g.players[0];
  if (p1.leader.data.id === cardId) return p1.leader;
  const inst = [...p1.hand, ...p1.library, ...p1.trash, ...p1.characters, ...p1.life]
    .find((c) => c.data.id === cardId);
  if (!inst) return null;
  for (const zone of [p1.hand, p1.library, p1.trash, p1.characters, p1.life]) {
    const i = zone.indexOf(inst);
    if (i !== -1) zone.splice(i, 1);
  }
  inst.zone = 'hand'; inst.rested = false; inst.givenDon = 0;
  p1.hand.push(inst);
  return inst;
}

function putOnBoard(g, inst, { rested = false } = {}) {
  const p1 = g.players[0];
  if (inst.isLeader) return;
  for (const z of [p1.hand, p1.library, p1.trash]) {
    const i = z.indexOf(inst); if (i !== -1) z.splice(i, 1);
  }
  if (inst.isStage) { p1.stage = inst; inst.zone = 'stage'; return; }
  inst.zone = 'characters'; inst.rested = rested; inst.enteredTurn = 1; inst.summonedThisTurn = false;
  if (p1.characters.length >= 5) { const v = p1.characters.shift(); v.zone = 'trash'; p1.trash.push(v); }
  p1.characters.push(inst);
}

// Prepara el estado para que el coste interno de una habilidad sea pagable.
function satisfyCost(g, p, ab) {
  const cost = ab?.cost;
  if (!cost) return;
  if (cost.returnGivenDon) p.leader.givenDon = Math.max(p.leader.givenDon, cost.returnGivenDon);
  const fromLibrary = (pred, place) => {
    const i = p.library.findIndex(pred);
    if (i === -1) return false;
    place(p.library.splice(i, 1)[0]);
    return true;
  };
  const needChar = (filter, n) => {
    while (p.characters.filter((c) => !c.rested && g.matchesFilter(c, filter)).length < n) {
      const ok = fromLibrary((c) => c.isCharacter && g.matchesFilter(c, filter), (c) => {
        c.zone = 'characters'; c.rested = false; c.enteredTurn = 1; c.summonedThisTurn = false;
        if (p.characters.length >= 5) { const v = p.characters.shift(); v.zone = 'trash'; p.trash.push(v); }
        p.characters.push(c);
      });
      if (!ok) break;
    }
  };
  if (cost.restOwn) {
    needChar(cost.restOwn.filter, cost.restOwn.n);
    // El coste puede referirse a un ESCENARIO (p. ej. "rest your [Fullalead]").
    if (![...p.characters, p.stage, p.leader].filter(Boolean)
      .some((c) => !c.rested && g.matchesFilter(c, cost.restOwn.filter))) {
      fromLibrary((c) => c.isStage && g.matchesFilter(c, cost.restOwn.filter), (c) => {
        c.zone = 'stage'; c.rested = false; p.stage = c;
      });
    }
  }
  if (cost.bounceOwn) needChar(cost.bounceOwn.filter, cost.bounceOwn.n);
  if (cost.charToLife) needChar(cost.charToLife.filter, cost.charToLife.n);
  const needHand = (filter, n) => {
    while (p.hand.filter((c) => g.matchesFilter(c, filter)).length < n) {
      if (!fromLibrary((c) => g.matchesFilter(c, filter), (c) => { c.zone = 'hand'; p.hand.push(c); })) break;
    }
  };
  if (cost.trashHandFilter) needHand(cost.trashHandFilter, cost.trashHand);
  if (cost.revealHand) needHand(cost.revealHand.filter, cost.revealHand.n);
  // Voltear Vida boca abajo exige cartas boca arriba en la posición permitida.
  if (cost.turnLifeDown && p.life.length) {
    const idxs = cost.turnLifeEnds === 'top' ? [0]
      : cost.turnLifeEnds === 'both' ? [...new Set([0, p.life.length - 1])]
      : p.life.map((_, i) => i);
    for (const i of idxs.slice(0, cost.turnLifeDown)) p.life[i].faceUp = true;
  }
}

// Ejecuta un escenario comprobando (1) que la habilidad se despacha y
// (2) que CADA op produce el cambio de estado que promete (opcheck.mjs).
async function runScenario(name, g, expectedOps, fn) {
  const before = g.logLines.length;
  g.opTrace = [];
  const badOps = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const msg = checkOp(pending.op, pending.before, snap(g), g, pending.i, pending.srcId);
    if (msg) badOps.push(msg);
    pending = null;
  };
  g.opProbe = (op, ctx) => {
    flush();
    if (!op || WRAPPERS.has(op.op)) return;   // null = cierre de resolveOps
    pending = { op, before: snap(g), i: g.players.indexOf(ctx.p), srcId: ctx.source?.id ?? null };
  };
  try {
    await fn();
    flush();
    const activity = g.logLines.length - before;
    if (expectedOps?.length && !expectedOps.some((o) => g.opTrace.includes(o))) {
      return { name, status: 'MISS', activity, lines: g.logLines.slice(before) };
    }
    if (badOps.length) return { name, status: 'BADOP', error: badOps.join(' || ') };
    return { name, status: activity > 0 ? 'OK' : 'NOOP', activity };
  } catch (err) {
    return { name, status: 'ERR', error: err.message };
  } finally {
    g.opTrace = null;
    g.opProbe = null;
  }
}

const opsOf = (inst, when) => abilitiesOf(inst, when)[0]?.ops.map((o) => o.op);

// ---- escenarios por carta -------------------------------------------------
async function testCard(entry) {
  const { card, slug } = entry;
  const deck = decks[slug];
  const oppDeck = decks[slug === 'st-01' ? 'st-02' : 'st-01'];
  const results = [];
  const probe = new Game([
    { name: 'X', deck, controller: autoCtrl(), isBot: true },
    { name: 'Y', deck: oppDeck, controller: autoCtrl(), isBot: true },
  ], { seed: 1 });
  const sample = [...probe.cardsById.values()].find((c) => c.data.id === card.id);
  const whens = new Set((sample?.script?.abilities ?? []).map((a) => a.when));

  // 1. Jugarla.
  if (card.type === 'Character' || card.type === 'Stage') {
    const g = await newGame(deck, oppDeck);
    const inst = getInstance(g, card.id);
    if (inst) {
      const ab = abilitiesOf(inst, 'onPlay')[0];
      satisfyCost(g, g.players[0], ab);
      const type = card.type === 'Character' ? 'playCharacter' : 'playStage';
      results.push(await runScenario('play', g, whens.has('onPlay') ? opsOf(inst, 'onPlay') : null, async () => {
        await g.performAction(g.players[0], { type, cardId: inst.id });
      }));
    }
  } else if (card.type === 'Event' && whens.has('main')) {
    const g = await newGame(deck, oppDeck);
    const inst = getInstance(g, card.id);
    if (inst) {
      satisfyCost(g, g.players[0], abilitiesOf(inst, 'main')[0]);
      results.push(await runScenario('event-main', g, opsOf(inst, 'main'), async () => {
        await g.performAction(g.players[0], { type: 'playEvent', cardId: inst.id });
      }));
    }
  }

  // 2. [Activate: Main].
  if (whens.has('activateMain')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'activateMain')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      satisfyCost(g, g.players[0], ab);
      results.push(await runScenario('activate', g, opsOf(inst, 'activateMain'), async () => {
        await g.performAction(g.players[0], { type: 'activate', cardId: inst.id });
      }));
    }
  }

  // 3. [When Attacking].
  if (whens.has('whenAttacking') && (card.type === 'Character' || card.type === 'Leader')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'whenAttacking')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      satisfyCost(g, g.players[0], ab);
      results.push(await runScenario('attack', g, opsOf(inst, 'whenAttacking'), async () => {
        await g.performAction(g.players[0], { type: 'attack', attackerId: inst.id, targetId: 'leader' });
      }));
    }
  }

  // 4. [On Block] — el rival ataca y bloqueamos con la carta.
  if (whens.has('onBlock') && card.type === 'Character') {
    const g = await newGame(deck, oppDeck, {
      chooseBlocker: async (gg, { blockerIds }) =>
        blockerIds.find((id) => gg.byId(id).data.id === card.id) ?? null,
    });
    const inst = getInstance(g, card.id);
    if (inst) {
      putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'onBlock')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      satisfyCost(g, g.players[0], ab);
      g.activeIdx = 1;
      const p2 = g.players[1];
      results.push(await runScenario('block', g, opsOf(inst, 'onBlock'), async () => {
        await g.performAction(p2, { type: 'attack', attackerId: p2.leader.id, targetId: 'leader' });
      }));
    }
  }

  // 5. [Counter] de evento.
  if (whens.has('counter') && card.type === 'Event') {
    const g = await newGame(deck, oppDeck, {
      counterStep: async () => {
        const p1 = g.players[0];
        const c = p1.hand.find((x) => x.data.id === card.id);
        return { discardIds: [], eventIds: c ? [c.id] : [] };
      },
    });
    const inst = getInstance(g, card.id);
    if (inst) {
      satisfyCost(g, g.players[0], abilitiesOf(inst, 'counter')[0]);
      g.activeIdx = 1;
      const p2 = g.players[1];
      results.push(await runScenario('counter', g, opsOf(inst, 'counter'), async () => {
        await g.performAction(p2, { type: 'attack', attackerId: p2.leader.id, targetId: 'leader' });
      }));
    }
  }

  // 6. [Trigger] — pierde esa vida por daño real.
  if (whens.has('trigger')) {
    const g = await newGame(deck, oppDeck);
    const inst = getInstance(g, card.id);
    if (inst) {
      const p1 = g.players[0];
      p1.hand.splice(p1.hand.indexOf(inst), 1);
      inst.zone = 'life'; p1.life.unshift(inst);
      satisfyCost(g, p1, abilitiesOf(inst, 'trigger')[0]);
      g.activeIdx = 1;
      const p2 = g.players[1];
      p2.leader.tempPower += 20000;
      results.push(await runScenario('trigger', g, opsOf(inst, 'trigger'), async () => {
        await g.performAction(p2, { type: 'attack', attackerId: p2.leader.id, targetId: 'leader' });
      }));
    }
  }

  // 7. [On K.O.] — muere por efecto del rival.
  if (whens.has('onKO') && card.type === 'Character') {
    const g = await newGame(deck, oppDeck);
    const inst = getInstance(g, card.id);
    if (inst) {
      putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'onKO')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      // "[Opponent's Turn] [On K.O.]": el KO por efecto rival ocurre en el
      // turno del rival — el escenario debe reflejarlo.
      if (ab?.oppTurn) g.activeIdx = 1;
      satisfyCost(g, g.players[0], ab);
      const p2 = g.players[1];
      results.push(await runScenario('onKO', g, opsOf(inst, 'onKO'), async () => {
        await g.resolveOps(
          [{ op: 'ko', scope: 'opp', targets: 1, filter: { names: [inst.name] } }],
          { source: p2.leader, p: p2 },
        );
      }));
    }
  }

  // 8. [End of Your Turn].
  if (whens.has('endOfTurn')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'endOfTurn')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      satisfyCost(g, g.players[0], ab);
      results.push(await runScenario('endOfTurn', g, opsOf(inst, 'endOfTurn'), async () => {
        await g.runTaggedAbilities(inst, 'endOfTurn');
      }));
    }
  }

  // 9. [On Your Opponent's Attack] — el rival declara un ataque real.
  if (whens.has('onOppAttack')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'onOppAttack')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      satisfyCost(g, g.players[0], ab);
      g.activeIdx = 1;
      const p2 = g.players[1];
      results.push(await runScenario('onOppAttack', g, opsOf(inst, 'onOppAttack'), async () => {
        await g.performAction(p2, { type: 'attack', attackerId: p2.leader.id, targetId: 'leader' });
      }));
    }
  }

  // 10. "Cuando un DON!! vuelve al mazo" — despacho real del motor.
  if (whens.has('onDonReturn')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'onDonReturn')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      satisfyCost(g, g.players[0], ab);
      results.push(await runScenario('onDonReturn', g, opsOf(inst, 'onDonReturn'), async () => {
        await g.fireOnBoard(g.players[0], 'onDonReturn');
      }));
    }
  }

  // 11. "Cuando un personaje es KO" — KO real de otro personaje propio.
  if (whens.has('onCharKO')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'onCharKO')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      const p1 = g.players[0];
      const victim = p1.characters.find((c) => c !== inst);
      const p2 = g.players[1];
      if (victim) {
        results.push(await runScenario('onCharKO', g, opsOf(inst, 'onCharKO'), async () => {
          await g.resolveOps(
            [{ op: 'ko', scope: 'opp', targets: 1, filter: { names: [victim.name] } }],
            { source: p2.leader, p: p2 },
          );
        }));
      } else {
        results.push({ name: 'onCharKO', status: 'SKIP' });
      }
    }
  }

  // 12. "Cuando el rival activa un [Blocker]" — bloqueo real del rival.
  if (whens.has('onOppBlocker')) {
    const g = await newGame(deck, oppDeck, {}, {
      chooseBlocker: async (gg, { blockerIds }) => blockerIds[0] ?? null,
    });
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      const ab = abilitiesOf(inst, 'onOppBlocker')[0];
      if (ab?.donX) inst.givenDon = ab.donX;
      // El rival necesita un blocker enderezado.
      const p2 = g.players[1];
      let blocker = p2.characters.find((c) => c.hasBlocker);
      if (!blocker) {
        const i = p2.library.findIndex((c) => c.isCharacter && c.hasBlocker);
        if (i !== -1) {
          blocker = p2.library.splice(i, 1)[0];
          blocker.zone = 'characters'; blocker.enteredTurn = 1; blocker.summonedThisTurn = false;
          p2.characters.push(blocker);
        }
      }
      if (blocker) {
        blocker.rested = false;
        const attacker = inst.isLeader || !inst.canAttack(g) ? g.players[0].leader : inst;
        results.push(await runScenario('onOppBlocker', g, opsOf(inst, 'onOppBlocker'), async () => {
          await g.performAction(g.players[0], { type: 'attack', attackerId: attacker.id, targetId: 'leader' });
        }));
      } else {
        results.push({ name: 'onOppBlocker', status: 'SKIP' });
      }
    }
  }

  // 13. Estáticas: el cálculo de poder de todo el tablero no revienta.
  if (whens.has('static')) {
    const g = await newGame(deck, oppDeck);
    const inst = card.type === 'Leader' ? g.players[0].leader : getInstance(g, card.id);
    if (inst) {
      if (!inst.isLeader) putOnBoard(g, inst);
      results.push(await runScenario('static', g, null, async () => {
        for (const c of [...g.players[0].board(), ...g.players[1].board()]) c.power(g);
        g.log('(static evaluada)');
      }));
    }
  }

  return results;
}

// ---- bucle principal ------------------------------------------------------
const ids = onlyIds.length ? onlyIds : [...catalog.keys()];
const tally = { OK: 0, NOOP: 0, ERR: 0, MISS: 0, SKIP: 0, BADOP: 0 };
const problems = [];
const minors = [];
for (const id of ids) {
  const entry = catalog.get(id);
  if (!entry) { console.log(`?? ${id} no está en el catálogo`); continue; }
  let results;
  try {
    results = await testCard(entry);
  } catch (err) {
    tally.ERR++;
    problems.push(`[${id}] ${entry.card.name} :: montaje: ${err.message}`);
    continue;
  }
  for (const r of results) {
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    const line = `[${id}] ${entry.card.name} :: ${r.name}: ${r.status}${r.error ? ` (${r.error})` : ''}`;
    if (r.status === 'ERR' || r.status === 'MISS' || r.status === 'BADOP') problems.push(line);
    else if (r.status === 'NOOP' || r.status === 'SKIP') minors.push(line);
  }
}

console.log(`\nEscenarios → OK ${tally.OK} · BADOP ${tally.BADOP} · MISS ${tally.MISS} · ERR ${tally.ERR} · NOOP ${tally.NOOP} · SKIP ${tally.SKIP}\n`);
if (problems.length) {
  console.log('=== PROBLEMAS (ERR/MISS) ===');
  for (const p of problems) console.log(p);
}
if (full && minors.length) {
  console.log('\n=== NOOP/SKIP (revisar) ===');
  for (const m of minors) console.log(m);
}
