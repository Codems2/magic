// Bot competitivo: hereda las heurísticas base de BotController y reescribe
// lo que separa a un rival flojo de uno que castiga:
//   1. Cálculo de LETAL: detecta cuándo puede rematar este turno y va all-in
//      con el reparto de DON!! y el orden de ataques correcto.
//   2. Disciplina defensiva: counters según el calendario de vidas (nunca
//      regala cartas en golpes irrelevantes, nunca deja pasar el letal).
//   3. Banca de DON!!: reserva lo necesario para sus eventos [Counter] antes
//      de gastarlo en bombas.
//   4. Secuencia de ataques: primero los KO rentables, luego caza bloqueadores,
//      después presión al líder de mayor a menor golpe.
// Sigue siendo un heurístico (no hay búsqueda de árbol), pero juega "a no
// perder": las líneas que un jugador competitivo no perdona.

import { BotController } from './bot.js';
import { abilitiesOf, opsValue } from '../engine/effects.js';

const SEARCHER_RX = /look at \d+ cards? from the top of your deck/i;

export class HardBot extends BotController {
  // ---- valoración ---------------------------------------------------------

  // Valor de mano más fino: los buscadores y motores valen más de lo que
  // aparentan; el counter impreso añade valor defensivo.
  handValue(c) {
    let v = super.handValue(c);
    if (SEARCHER_RX.test(c.text)) v += 1.2;
    if ((c.counterValue ?? 0) >= 2000) v += 0.4;
    for (const ab of c.script?.abilities ?? []) {
      if (ab.when === 'trigger' && ab.ops.length) v += 0.3;
      if (ab.when === 'counter') v += 0.8;   // evento [Counter]: oro defensivo
    }
    return v;
  }

  // DON!! que NO debe gastarse en ataques: el coste del mejor evento
  // [Counter] en mano (se paga en el turno del rival con DON activos).
  donReserve(game) {
    const evs = this.player.hand.filter((c) => c.isEvent && abilitiesOf(c, 'counter')[0]);
    if (!evs.length) return 0;
    return Math.min(...evs.map((c) => c.cost ?? 0));
  }

  // Estimación de counters del rival más realista: depende de su mano y de
  // cuánto le duela el golpe (vida baja = defenderá más).
  counterEstimate(game, hittingLeader) {
    const opp = game.opponentOf(this.player);
    const hand = opp.hand.length ?? 0;
    if (!hittingLeader) return Math.min(hand, 2) * 1000;
    const urgency = opp.life.length <= 1 ? 3 : opp.life.length <= 2 ? 2 : 1;
    return Math.min(hand * 1500, urgency * 2000);
  }

  // ---- mulligan -----------------------------------------------------------

  async mulligan(game, handIds) {
    const hand = this.player.hand;
    const early = hand.filter((c) => c.isCharacter && c.cost <= 4);
    const cheap = hand.filter((c) => c.isCharacter && c.cost <= 3);
    const searchers = hand.filter((c) => SEARCHER_RX.test(c.text) && (c.cost ?? 0) <= 2);
    return !((early.length >= 2 && cheap.length >= 1) || (searchers.length >= 1 && early.length >= 1));
  }

  // ---- combate ------------------------------------------------------------

  combatOrPass(game) {
    const p = this.player;
    // 1. ¿Hay letal (o casi)? All-in con el orden y el DON correctos.
    const lethal = this.lethalPush(game);
    if (lethal) return lethal;
    // 2. Si no, ataques por valor con el DON no reservado.
    const spendable = Math.max(0, p.donActive - this.donReserve(game));
    const seq = this.attackSequence(game, spendable);
    if (seq) return seq;
    return { type: 'pass' };
  }

  readyAttackers(game) {
    const p = this.player;
    return [...p.characters, p.leader].filter((c) => c && c.canAttack(game));
  }

  // Detecta si los ataques disponibles pueden quitar las vidas restantes y
  // rematar, asumiendo que cada bloqueador enderezado come un golpe y que
  // los últimos golpes deben superar el margen de counter estimado.
  lethalPush(game) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const attackers = this.readyAttackers(game)
      .slice().sort((a, b) => b.power(game) - a.power(game));
    if (!attackers.length) return null;

    const lb = opp.leader.power(game);
    const blockers = opp.characters.filter((c) => !c.rested && c.hasBlocker).length;
    // Golpes que deben CONECTAR con el líder: vidas + 1 (el golpe final).
    // [Double Attack] conecta doble.
    let needed = opp.life.length + 1 + blockers;
    const margin = Math.min(2000, (opp.hand.length ?? 0) * 1000); // colchón anti-counter
    let don = p.donActive;
    let deficit = 0;
    let hits = 0;
    const usable = [];
    for (const a of attackers) {
      if (hits >= needed) break;
      const pw = a.power(game);
      const target = lb + (hits < blockers ? 0 : margin); // los primeros se comen bloqueos
      const need = Math.max(0, target - pw);
      deficit += need;
      usable.push(a);
      hits += a.hasDoubleAttack && hits >= blockers ? 2 : 1;
    }
    if (hits < needed || Math.ceil(deficit / 1000) > don) return null;

    // Ejecutable: reparte DON al primero que lo necesite y ataca de mayor a menor.
    for (const a of usable) {
      const idx = usable.indexOf(a);
      const target = lb + (idx < blockers ? 0 : margin);
      const need = Math.max(0, Math.ceil((target - a.power(game)) / 1000));
      if (need > 0 && p.donActive >= need) return { type: 'giveDon', cardId: a.id, n: need };
      if (a.power(game) >= lb) {
        return { type: 'attack', attackerId: a.id, targetId: 'leader' };
      }
    }
    return null;
  }

  // Orden de ataques por valor: KO rentable > cazar bloqueadores > líder.
  attackSequence(game, spendable) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const abilityBonus = (c) => (c.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);

    const plans = [];
    for (const atk of this.readyAttackers(game)) {
      const power = atk.power(game);
      // a) KO a personajes girados valiosos (sin pagar counters de líder).
      for (const t of opp.characters.filter((c) => c.rested)) {
        const value = (t.data.power ?? 0) / 1000 + abilityBonus(t);
        const need = Math.max(0, Math.ceil((t.power(game) + this.counterEstimate(game, false) - power) / 1000));
        if (need <= Math.min(spendable, 2) && value >= 3) {
          plans.push({ atk, targetId: t.id, don: need, value: value + 1 - need * 0.4 });
        }
      }
      // b) Cazar bloqueadores enderezados si el golpe los mata igualmente
      //    (attack() permite atacar solo a girados salvo canAttackActive; así
      //    que el "caceo" real es atacar al líder y que el bloqueador muera
      //    al bloquear: lo favorecemos subiendo el valor del golpe al líder
      //    cuando nuestro poder mata a su mejor bloqueador).
      const bestBlocker = opp.characters.filter((c) => !c.rested && c.hasBlocker)
        .sort((a, b) => b.power(game) - a.power(game))[0];
      const lb = opp.leader.power(game);
      if (power >= lb) {
        const extra = Math.min(Math.ceil(this.counterEstimate(game, true) / 1000), Math.min(spendable, 2));
        let value = 1.8 - extra * 0.3;
        if (bestBlocker && power > bestBlocker.power(game)) value += 0.8; // si bloquea, pierde el muro
        if (opp.life.length <= 2) value += 0.8;                          // presión de cierre
        plans.push({ atk, targetId: 'leader', don: opp.life.length <= 1 ? Math.min(spendable, extra + 1) : extra, value });
      } else {
        const need = Math.ceil((lb - power) / 1000);
        if (need <= Math.min(spendable, 2)) plans.push({ atk, targetId: 'leader', don: need, value: 1.4 - need * 0.35 });
      }
    }
    if (!plans.length) return null;
    plans.sort((a, b) => b.value - a.value);
    const best = plans[0];
    if (best.value < 0.6) return null;
    if (best.don > 0) return { type: 'giveDon', cardId: best.atk.id, n: best.don };
    return { type: 'attack', attackerId: best.atk.id, targetId: best.targetId };
  }

  // ---- defensa ------------------------------------------------------------

  async chooseBlocker(game, { attackerId, targetId, blockerIds }) {
    const p = this.player;
    const attacker = game.byId(attackerId);
    const atkPower = attacker.power(game);
    const candidates = blockerIds.map((id) => game.byId(id));
    const survivor = candidates.filter((b) => b.power(game) > atkPower).sort((a, b) => a.cost - b.cost)[0];
    const cheapest = candidates.slice().sort((a, b) => a.cost - b.cost)[0];
    const counterTotal = p.hand.reduce((n, c) => n + (c.counterValue ?? 0), 0);

    if (targetId === 'leader') {
      const lethalHit = p.life.length === 0 || (attacker.hasDoubleAttack && p.life.length <= 1);
      if (lethalHit) return (survivor ?? cheapest).id;
      // Bloqueo gratis siempre (el bloqueador sobrevive y encima frena daño).
      if (survivor) return survivor.id;
      const deficit = atkPower - p.leader.power(game);
      // Con vida baja, mejor perder un muro barato que la vida + counters.
      if (p.life.length <= 2 && (deficit > 2000 || counterTotal < deficit + 1000)) return cheapest.id;
      if (attacker.hasDoubleAttack && p.life.length <= 3) return cheapest.id;
      return null;
    }
    const target = game.byId(targetId);
    const tv = (target?.data.power ?? 0) / 1000 +
      (target?.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);
    if (survivor && tv >= 4) return survivor.id;
    if (tv >= 7 && cheapest && cheapest.cost <= 2) return cheapest.id;
    return null;
  }

  async counterStep(game, { attackerId, targetId, attackPower, targetPower }) {
    const p = this.player;
    const deficit = attackPower - targetPower;
    if (deficit < 0) return { discardIds: [], eventIds: [] };
    const isLeader = targetId === 'leader';
    const attacker = game.byId(attackerId);
    const lethal = isLeader && (p.life.length === 0 || (attacker?.hasDoubleAttack && p.life.length <= 1));
    const need = deficit + 1000;    // hay que SUPERAR el poder del atacante

    // ¿Defender? Calendario de vidas: 0-1 siempre; 2 si ≤2 cartas; 3 si ≤1
    // carta o [Double Attack]; ≥4 solo tanquear (la vida es una carta).
    const cheapEnough = (cards) => {
      if (lethal) return true;
      if (!isLeader) {
        const t = game.byId(targetId);
        const tv = (t?.data.power ?? 0) / 1000 + (t?.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);
        return tv >= 5 && cards <= 1;
      }
      if (p.life.length <= 1) return cards <= 4;
      if (p.life.length === 2) return cards <= 2;
      if (p.life.length === 3) return cards <= 1 || (attacker?.hasDoubleAttack && cards <= 2);
      return attacker?.hasDoubleAttack && cards <= 1;
    };

    // Arma la defensa más barata en CARTAS: eventos [Counter] primero (una
    // carta que suele valer +3000/+4000), luego counters de menor valor.
    const eventIds = [];
    let bonus = 0;
    for (const ev of p.hand.filter((c) => c.isEvent)) {
      const ab = abilitiesOf(ev, 'counter')[0];
      if (!ab || ev.cost > p.donActive || !game.canPayAbilityCost(p, ev, ab.cost)) continue;
      const evBonus = ab.ops.filter((o) => o.op === 'powerUp').reduce((n, o) => n + o.n, 0);
      if (evBonus <= 0 && opsValue(ab.ops) < 1.5) continue;
      if (bonus >= need) break;
      eventIds.push(ev.id);
      bonus += evBonus;
      if (eventIds.length >= 1) break;
    }
    const discardIds = [];
    const counters = p.hand.filter((c) => c.counterValue > 0 && !eventIds.includes(c.id))
      .sort((a, b) => (a.counterValue - b.counterValue) || (this.handValue(a) - this.handValue(b)));
    // Greedy afinado: primero intenta cubrir con las piezas de MÁS counter y
    // menos valor (menos cartas), no con morralla de 1000 en cadena.
    const byEfficiency = counters.slice().sort((a, b) => (b.counterValue - a.counterValue) || (this.handValue(a) - this.handValue(b)));
    for (const c of byEfficiency) {
      if (bonus >= need) break;
      discardIds.push(c.id);
      bonus += c.counterValue;
    }
    const cardsSpent = discardIds.length + eventIds.length;
    if (bonus < need || !cheapEnough(cardsSpent)) {
      // O no llega o sale caro: en letal tira lo que haya, si no, no regales.
      return lethal ? { discardIds, eventIds } : { discardIds: [], eventIds: [] };
    }
    return { discardIds, eventIds };
  }

  // ---- fase principal -----------------------------------------------------

  async mainAction(game) {
    const p = this.player;
    const opp = game.opponentOf(p);

    // Letal disponible: no pierdas el turno desarrollando, remata.
    if (this.lethalPush(game)) return this.combatOrPass(game);

    // 1. Bajadas por valor (curva + roles), respetando la banca de DON.
    const reserve = this.donReserve(game);
    const budget = Math.max(0, p.donActive - (opp.life.length <= 2 ? 0 : Math.min(reserve, 2)));
    const playable = p.hand
      .filter((c) => c.isCharacter && c.cost <= budget)
      .map((c) => {
        let v = c.cost * 1.0 + (c.data.power ?? 0) / 4000;
        for (const ab of c.script?.abilities ?? []) if (ab.when === 'onPlay' || ab.when === 'static') v += opsValue(ab.ops) * 0.4;
        if (SEARCHER_RX.test(c.text) && game.turn <= 4) v += 1.2;
        if (c.hasBlocker) v += 0.6;
        return { c, v };
      })
      .sort((a, b) => b.v - a.v);
    if (playable.length) {
      const card = playable[0].c;
      const action = { type: 'playCharacter', cardId: card.id };
      if (p.characters.length >= 5) {
        const weakest = p.characters.slice().sort((a, b) => (a.data.power ?? 0) - (b.data.power ?? 0))[0];
        if ((card.data.power ?? 0) <= (weakest.data.power ?? 0) + 1000) return this.combatOrPass(game);
        action.trashId = weakest.id;
      }
      return action;
    }

    // 2. Eventos [Main] con objetivo real.
    for (const ev of p.hand.filter((c) => c.isEvent && c.cost <= budget)) {
      const main = abilitiesOf(ev, 'main')[0];
      if (!main || !game.canPayAbilityCost(p, ev, main.cost)) continue;
      const hasRemoval = main.ops.some((o) => ['ko', 'bounce', 'tuckBottom', 'setBasePowerOpp'].includes(o.op));
      if (hasRemoval && !opp.characters.length) continue;
      if (opsValue(main.ops) >= 1.2) return { type: 'playEvent', cardId: ev.id };
    }

    // 3. Habilidades activables (umbral más agresivo que el bot base).
    for (const c of [p.leader, ...p.characters, p.stage].filter(Boolean)) {
      const ab = abilitiesOf(c, 'activateMain')[0];
      if (!ab) continue;
      if (ab.once && c._activatedTurn === game.turn) continue;
      if (ab.donX && c.givenDon < ab.donX) continue;
      if (!game.canPayAbilityCost(p, c, ab.cost)) continue;
      if (ab.ops.some((o) => o.op === 'giveRestedDon') && p.donRested === 0) continue;
      if (ab.ops.some((o) => o.op === 'unrestSelf') && !c.rested) continue;
      const costWeight = (ab.cost?.donRest ?? 0) * 0.45 + (ab.cost?.donReturn ?? 0) * 0.85 + (ab.cost?.trashHand ?? 0) * 0.7;
      if (opsValue(ab.ops) > costWeight * 0.9) return { type: 'activate', cardId: c.id };
    }

    // 4. Escenario si sobra.
    const stage = p.hand.find((c) => c.isStage && c.cost <= budget);
    if (stage && !p.stage) return { type: 'playStage', cardId: stage.id };

    return this.combatOrPass(game);
  }
}
