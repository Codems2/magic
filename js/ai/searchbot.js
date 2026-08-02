// Bot Maestro: búsqueda por simulación sobre el motor real.
//
// En cada decisión de fase principal:
//   1. Enumera las acciones candidatas legales (bajadas, eventos, DON!!,
//      habilidades, cada ataque posible y pasar).
//   2. Para cada candidata, D veces: fotografía el estado (snapshotState),
//      DETERMINIZA lo que no ha visto (baraja la mano+mazo del rival con su
//      propio mazo de posibilidades y su propio mazo — así se adapta al robo
//      SIN hacer trampas), aplica la acción y deja que una política rápida
//      (HardBot) termine el turno; puntúa el estado final y restaura.
//   3. Juega la candidata con mejor media.
//
// La evaluación pondera las vidas de forma marginal (perder la última vale
// mucho más que la quinta), el tablero con habilidades, la mano como recurso
// y el tempo de DON!!. Es un PIMC de 1 turno: no ve el futuro del rival, pero
// sí TODAS las consecuencias reales de sus propias líneas de juego este turno.

import { HardBot } from './hardbot.js';
import { vetoedPlay } from './bot.js';
import { opsValue, abilitiesOf } from '../engine/effects.js';

export class SearchBot extends HardBot {
  constructor(name, { determinizations = 3, maxActions = 10, maxCandidates = 14 } = {}) {
    super(name);
    this.D = determinizations;
    this.maxActions = maxActions;
    this.maxCandidates = maxCandidates;
    this._searchBroken = false;   // ante cualquier fallo, degrada a HardBot
  }

  async mainAction(game) {
    if (this._searchBroken || !game.snapshotState) return super.mainAction(game);
    try {
      return await this.search(game);
    } catch (err) {
      this._searchBroken = true;
      if (typeof console !== 'undefined') console.warn('SearchBot degrada a HardBot:', err);
      return super.mainAction(game);
    }
  }

  // ---- candidatas ---------------------------------------------------------

  candidates(game) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const out = [];
    const seen = new Set();
    const add = (a) => {
      const key = JSON.stringify(a);
      if (!seen.has(key)) { seen.add(key); out.push(a); }
    };

    add({ type: 'pass' });
    // Bajadas.
    const weakest = p.characters.slice().sort((a, b) => (a.data.power ?? 0) - (b.data.power ?? 0))[0];
    for (const c of p.hand.filter((c) => c.isCharacter && c.cost <= p.donActive && !vetoedPlay(game, p, c))) {
      const a = { type: 'playCharacter', cardId: c.id };
      if (p.characters.length >= 5) a.trashId = weakest?.id;
      add(a);
    }
    const stage = p.hand.find((c) => c.isStage && c.cost <= p.donActive);
    if (stage && !p.stage) add({ type: 'playStage', cardId: stage.id });
    // Eventos [Main] pagables.
    for (const ev of p.hand.filter((c) => c.isEvent && c.cost <= p.donActive)) {
      const main = abilitiesOf(ev, 'main')[0];
      if (main && game.canPayAbilityCost(p, ev, main.cost)) add({ type: 'playEvent', cardId: ev.id });
    }
    // Habilidades activables.
    for (const c of [p.leader, ...p.characters, p.stage].filter(Boolean)) {
      const ab = abilitiesOf(c, 'activateMain')[0];
      if (!ab) continue;
      if (ab.once && c._activatedTurn === game.turn) continue;
      if (ab.donX && c.givenDon < ab.donX) continue;
      if (!game.canPayAbilityCost(p, c, ab.cost)) continue;
      add({ type: 'activate', cardId: c.id });
    }
    // DON!! y ataques.
    const attackers = [...p.characters, p.leader].filter((c) => c && c.canAttack(game));
    for (const atk of attackers) {
      if (p.donActive >= 1) add({ type: 'giveDon', cardId: atk.id, n: 1 });
      if (p.donActive >= 2) add({ type: 'giveDon', cardId: atk.id, n: 2 });
      // Un ataque cuyo poder no llega al del objetivo no entra: solo merece
      // simularse si el [When Attacking] del atacante lo hace conectar
      // (auto-buff suficiente) o da valor aunque el golpe falle (robar, KO...).
      const wa = abilitiesOf(atk, 'whenAttacking').filter((ab) => (ab.donX ?? 0) <= atk.givenDon);
      const pumpPower = wa.reduce((n, ab) => n + ab.ops.reduce((m, o) =>
        m + (o.op === 'selfGrant' ? (o.changes ?? []).filter((ch) => ch.stat === 'power').reduce((k, ch) => k + ch.delta, 0) : 0), 0), 0);
      const sideValue = wa.some((ab) => ab.ops.some((o) => o.op !== 'selfGrant'));
      const worthIt = (tPower) => atk.power(game) + Math.max(0, pumpPower) >= tPower || sideValue;
      if (worthIt(opp.leader.power(game))) add({ type: 'attack', attackerId: atk.id, targetId: 'leader' });
      const canHitActive = atk.script?.abilities?.some((ab) => ab.ops.some((o) => o.op === 'canAttackActive'));
      for (const t of opp.characters.filter((c) => c.rested || canHitActive)) {
        if (worthIt(t.power(game))) add({ type: 'attack', attackerId: atk.id, targetId: t.id });
      }
    }
    return out.slice(0, this.maxCandidates + 8);
  }

  // ---- búsqueda -----------------------------------------------------------

  async search(game) {
    const p = this.player;
    // La jugada de la heurística siempre compite (y es el fallback).
    const base = await super.mainAction(game);
    let cands = this.candidates(game);
    const baseKey = JSON.stringify(base);
    if (!cands.some((a) => JSON.stringify(a) === baseKey)) cands.unshift(base);
    if (cands.length === 1) return cands[0];
    if (cands.length > this.maxCandidates) {
      // Recorta: conserva pass + base y las primeras por orden natural.
      cands = cands.filter((a, i) => i < this.maxCandidates ||
        a.type === 'pass' || JSON.stringify(a) === baseKey);
    }

    // Números aleatorios COMUNES: la determinización d es idéntica para
    // todas las candidatas (mismo robo imaginado), así la comparación mide
    // la acción y no la suerte de cada simulación.
    const seeds = Array.from({ length: this.D }, (_, d) => (game.rngState ^ ((d + 1) * 0x9e3779b9)) >>> 0);

    let best = base;
    let bestScore = -Infinity;
    for (const a of cands) {
      let total = 0;
      let ok = 0;
      for (let d = 0; d < this.D; d++) {
        const snap = game.snapshotState();
        game._mute = true;
        const saved = game.players.map((pl) => pl.controller);
        try {
          game.rngState = seeds[d];
          this.determinize(game);
          total += await this.rollout(game, a);
          ok++;
        } catch {
          total += -1e5;   // acción que rompe en simulación: castigo
          ok++;
        } finally {
          game.players.forEach((pl, i) => { pl.controller = saved[i]; });
          game._mute = false;
          game.restoreState(snap);
        }
      }
      const score = ok ? total / ok : -Infinity;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  // Baraja lo que este jugador NO ha visto: la mano+mazo del rival entre sí
  // y el orden de su propio mazo. Las zonas públicas no se tocan.
  determinize(game) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const pool = [...opp.hand, ...opp.library];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (game.rng() * (i + 1)) | 0;
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const h = opp.hand.length;
    opp.hand = pool.slice(0, h);
    for (const c of opp.hand) c.zone = 'hand';
    opp.library = pool.slice(h);
    for (const c of opp.library) c.zone = 'deck';
    game.shuffle(p.library);
  }

  // Aplica la candidata, deja que una política rápida termine el turno,
  // cierra el turno DE VERDAD (habilidades [End of Your Turn] incluidas) y
  // simula el turno completo de respuesta del rival: así "ve" el castigo
  // que le espera antes de comprometerse.
  async rollout(game, action) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const polMe = new HardBot('sim'); polMe.player = p; p.controller = polMe;
    const polOpp = new HardBot('simOpp'); polOpp.player = opp; opp.controller = polOpp;
    await game.performAction(p, action);
    let steps = 0;
    while (!game.over && steps++ < this.maxActions) {
      const a = await polMe.mainAction(game);
      if (!a || a.type === 'pass') break;
      await game.performAction(p, a);
    }
    // Evalúa en dos puntos y mezcla: el estado al cerrar tu turno (señal
    // limpia de tu línea) y el estado tras el turno del rival (el castigo
    // que te espera). La mezcla amortigua la varianza del robo simulado.
    if (game.over) return this.evalState(game, p);
    await game.endPhase(p);
    const mid = this.evalState(game, p);
    if (!game.over) await game.playTurn();     // turno del rival (política)
    const end = this.evalState(game, p);
    return mid * 0.5 + end * 0.5;
  }

  // ---- evaluación ---------------------------------------------------------

  evalState(game, me) {
    const opp = game.opponentOf(me);
    if (game.over) return game.winner === me ? 1e6 : -1e6;
    // Vidas marginales: la última vale mucho más que la quinta.
    const lifeScore = (n) => {
      const w = [0, 5, 9, 12, 14.5, 16.5, 18, 19.2, 20.2];
      return n < w.length ? w[n] : w[w.length - 1] + (n - w.length + 1);
    };
    const abil = (c) => (c.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);
    const board = (q) => q.characters.reduce((n, c) =>
      n + c.power(game) / 1000 + abil(c) * 0.5 + (c.hasBlocker ? 1 : 0), 0);
    let s = 0;
    s += (lifeScore(me.life.length) - lifeScore(opp.life.length)) * 1.6;
    s += (board(me) - board(opp)) * 1.0;
    s += (me.hand.length - opp.hand.length) * 1.1;
    // Tempo: DON!! sin usar al acabar es pérdida, salvo la banca para counters.
    s -= Math.max(0, me.donActive - this.donReserve(game)) * 0.3;
    // Defensa lista y objetivos girados del rival para el próximo turno.
    s += me.characters.filter((c) => !c.rested && c.hasBlocker).length * 0.4;
    s += opp.characters.filter((c) => c.rested).length * 0.2;
    // Girar un personaje propio sin sacar nada es regalar un objetivo.
    s -= me.characters.filter((c) => c.rested).length * 0.15;
    return s;
  }
}
