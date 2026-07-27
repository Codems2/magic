// Bot heurístico para One Piece TCG (versión F3; se refina en F4).
// Todas las decisiones devuelven JSON plano con ids de carta.

import { abilitiesOf, opsValue } from '../engine/effects.js';

export class BotController {
  constructor(name) {
    this.name = name;
    this.player = null;
  }

  // Valor aproximado de una carta en mano (para descartes).
  handValue(c) {
    let v = (c.data.power ?? 0) / 2000 + (c.cost ?? 0) * 0.3;
    for (const ab of c.script?.abilities ?? []) v += opsValue(ab.ops) * 0.5;
    return v;
  }

  async chooseTarget(game, { purpose, candidateIds, optional, battle = null }) {
    const p = this.player;
    const cands = candidateIds.map((id) => game.byId(id)).filter(Boolean);
    if (!cands.length) return null;
    const own = cands.filter((c) => c.owner === p);
    const enemy = cands.filter((c) => c.owner !== p);
    switch (purpose) {
      case 'ko': case 'bounce': case 'tuckBottom': case 'rest':
      case 'powerDown': case 'costDown':
        // Al enemigo más peligroso (mayor poder + habilidades).
        return enemy.sort((a, b) => (b.power(game) ?? 0) - (a.power(game) ?? 0))[0]?.id ?? enemy[0]?.id ?? null;
      case 'playFree':
        // Pon en juego el personaje más fuerte disponible.
        return cands.sort((a, b) => (b.data.power ?? 0) - (a.data.power ?? 0))[0]?.id ?? null;
      case 'toLife':
        // A la Vida: la carta menos útil de la mano.
        return own.sort((a, b) => this.handValue(a) - this.handValue(b))[0]?.id ?? null;
      case 'giveDon': case 'grantNoBlocker':
        // Al líder por defecto (flexible para atacar o defender).
        return (own.find((c) => c.isLeader) ?? own[0])?.id ?? null;
      case 'powerUp': {
        // En batalla: al defensor; si no, al líder.
        if (battle?.defenderId) {
          const def = cands.find((c) => c.id === battle.defenderId);
          if (def) return def.id;
          const leader = own.find((c) => c.isLeader);
          if (leader) return leader.id;
        }
        return (own.find((c) => c.isLeader) ?? own.sort((a, b) => (b.data.power ?? 0) - (a.data.power ?? 0))[0])?.id ?? null;
      }
      case 'unrest': case 'recover':
        return own.sort((a, b) => (b.data.power ?? 0) - (a.data.power ?? 0))[0]?.id ?? null;
      default:
        return (own[0] ?? cands[0])?.id ?? null;
    }
  }

  async discardFromHand(game, n) {
    return this.player.hand.slice()
      .sort((a, b) => this.handValue(a) - this.handValue(b))
      .slice(0, n)
      .map((c) => c.id);
  }

  async triggerDecision(game, { cardId }) {
    // Los triggers de los starter decks son siempre beneficiosos.
    return true;
  }

  async chooseRevealed(game, { pickableIds, min = 0, max = 1 }) {
    // Coge las mejores cartas elegibles (por valor de mano).
    const cards = pickableIds.map((id) => game.byId(id)).filter(Boolean)
      .sort((a, b) => this.handValue(b) - this.handValue(a));
    return cards.slice(0, Math.max(min, Math.min(max, cards.length))).map((c) => c.id);
  }

  async chooseOption(game, { options }) {
    // El rival elige el mal menor: la opción de menor valor para el que la lanza.
    // Aproximación: preferir "añadir a tu Vida" (menos malo) sobre "descartar Vida".
    const bad = options.findIndex((o) => /Descartar 1 carta de tu Vida/i.test(o));
    const soft = options.findIndex((o) => /Añadir 1 carta a tu Vida/i.test(o));
    if (soft !== -1) return soft;
    if (bad !== -1 && game.opponentOf(this.player).life.length > 2) return bad;
    return 0;
  }

  async payOptionalCost(game, { cardId, when }) {
    const card = game.byId(cardId);
    const ab = abilitiesOf(card, when)[0];
    if (!ab) return false;
    // Paga si el efecto vale más que el coste aproximado (la Vida pesa mucho).
    const c = ab.cost ?? {};
    const costWeight = (c.donReturn ?? 0) * 0.8 + (c.donReturnVar ? 0.8 : 0) + (c.trashHand ?? 0) * 0.7 +
      (c.donRest ?? 0) * 0.4 + (c.trashLife ?? 0) * 2.5 + (c.lifeToHand ?? 0) * 0.6 +
      (c.trashSelf ? 1.5 : 0) + (c.bounceOwn ? 1 : 0) + (c.charToLife ? 2 : 0) + (c.returnGivenDon ?? 0) * 0.6;
    return opsValue(ab.ops) > costWeight;
  }

  async mulligan(game, handIds) {
    // Mano jugable: al menos 2 cartas de coste <= 3.
    const cheap = this.player.hand.filter((c) => c.isCharacter && c.cost <= 3).length;
    return cheap < 2;
  }

  async mainAction(game) {
    const p = this.player;
    const opp = game.opponentOf(p);

    // 1. Jugar el personaje más caro pagable (curva).
    const playable = p.hand
      .filter((c) => c.isCharacter && c.cost <= p.donActive)
      .sort((a, b) => b.cost - a.cost || (b.data.power ?? 0) - (a.data.power ?? 0));
    if (playable.length) {
      const card = playable[0];
      const action = { type: 'playCharacter', cardId: card.id };
      if (p.characters.length >= 5) {
        const weakest = p.characters.slice().sort((a, b) => (a.data.power ?? 0) - (b.data.power ?? 0))[0];
        // Solo reemplaza si mejora claramente.
        if ((card.data.power ?? 0) <= (weakest.data.power ?? 0)) return this.combatOrPass(game);
        action.trashId = weakest.id;
      }
      return action;
    }

    // 2. Eventos [Main] útiles (removal, robo, rampa de DON).
    for (const ev of p.hand.filter((c) => c.isEvent && c.cost <= p.donActive)) {
      const main = abilitiesOf(ev, 'main')[0];
      if (!main || !game.canPayAbilityCost(p, ev, main.cost)) continue;
      const hasKo = main.ops.some((o) => o.op === 'ko' || o.op === 'bounce');
      const oppHasTargets = game.opponentOf(p).characters.length > 0;
      if (hasKo && !oppHasTargets) continue;
      if (opsValue(main.ops) >= 1.5) return { type: 'playEvent', cardId: ev.id };
    }

    // 3. Habilidades [Activate: Main] (líder, personajes, escenario).
    for (const c of [p.leader, ...p.characters, p.stage].filter(Boolean)) {
      const ab = abilitiesOf(c, 'activateMain')[0];
      if (!ab) continue;
      if (ab.once && c._activatedTurn === game.turn) continue;
      if (ab.donX && c.givenDon < ab.donX) continue;
      if (!game.canPayAbilityCost(p, c, ab.cost)) continue;
      // Da DON girados solo si los hay; endereza líder solo con ataque hecho.
      if (ab.ops.some((o) => o.op === 'giveRestedDon') && p.donRested === 0) continue;
      if (ab.ops.some((o) => o.op === 'unrestSelf') && !c.rested) continue;
      const costWeight = (ab.cost?.donRest ?? 0) * 0.5 + (ab.cost?.donReturn ?? 0) * 0.9 + (ab.cost?.trashHand ?? 0) * 0.8;
      if (opsValue(ab.ops) > costWeight) return { type: 'activate', cardId: c.id };
    }

    // 4. Escenario si hay hueco de DON.
    const stage = p.hand.find((c) => c.isStage && c.cost <= p.donActive);
    if (stage && !p.stage) return { type: 'playStage', cardId: stage.id };

    return this.combatOrPass(game);
  }

  // Estima cuánto counter puede oponer el rival a un golpe (sin mirar su mano).
  counterEstimate(game, hittingLeader) {
    const opp = game.opponentOf(this.player);
    // Defiende más cuanto menos vida le queda y más mano tiene.
    const urgency = hittingLeader ? Math.max(0, 4 - opp.life.length) : 1;
    const capacity = Math.min(opp.hand.length, 2 + Math.floor(urgency / 2)) * 1200;
    return Math.min(capacity, urgency * 1500);
  }

  // ¿Vamos ganando la carrera? Ajusta agresividad.
  raceScore(game) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const board = (q) => q.characters.reduce((n, c) => n + (c.data.power ?? 0), 0);
    return (p.life.length - opp.life.length) * 2000 + (board(p) - board(opp)) / 2;
  }

  combatOrPass(game) {
    const p = this.player;
    const opp = game.opponentOf(p);

    const attackers = [...p.characters, p.leader].filter((c) => c && c.canAttack(game));
    for (const atk of attackers) {
      const plan = this.planAttack(game, atk);
      if (!plan) continue;
      // Asigna DON antes de pegar si el golpe se queda corto pero es alcanzable.
      if (plan.donNeeded > 0 && p.donActive >= plan.donNeeded) {
        return { type: 'giveDon', cardId: atk.id, n: plan.donNeeded };
      }
      if (plan.donNeeded === 0) {
        return { type: 'attack', attackerId: atk.id, targetId: plan.targetId };
      }
    }
    return { type: 'pass' };
  }

  // Devuelve {targetId, donNeeded} o null si no hay ataque rentable.
  planAttack(game, atk) {
    const p = this.player;
    const opp = game.opponentOf(p);
    const power = atk.power(game);
    const spareDon = p.donActive;
    const abilityBonus = (c) => (c.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);

    // Opción A: KO a un personaje girado (valor = poder + habilidades).
    const restedTargets = opp.characters.filter((c) => c.rested)
      .map((c) => ({
        card: c,
        value: (c.data.power ?? 0) / 1000 + abilityBonus(c),
        need: c.power(game) + this.counterEstimate(game, false),
      }))
      .filter((t) => t.value >= 3.5)
      .sort((a, b) => b.value - a.value);
    for (const t of restedTargets) {
      const deficit = Math.max(0, t.need - power);
      const don = Math.ceil(deficit / 1000);
      if (don <= spareDon && don <= 2) return { targetId: t.card.id, donNeeded: don };
    }

    // Opción B: golpe al líder. Atacar drena counters del rival: casi siempre
    // es correcto si igualas su poder base; el DON extra solo busca superar
    // el margen de counter esperado cuando sale barato.
    const leaderBase = opp.leader.power(game);
    if (power >= leaderBase) {
      const margin = this.counterEstimate(game, true);
      const extra = Math.min(
        Math.ceil(margin / 1000),
        opp.life.length <= 1 ? spareDon : Math.min(spareDon, 2),
      );
      return { targetId: 'leader', donNeeded: Math.max(0, extra) };
    }
    // Se queda corto: súbelo con DON si es barato (1-2).
    const deficit = leaderBase - power;
    const don = Math.ceil(deficit / 1000);
    if (don <= Math.min(spareDon, 2)) return { targetId: 'leader', donNeeded: don };

    // Opción C: KO fácil aunque valga poco (mejor que no atacar).
    const easy = opp.characters.filter((c) => c.rested && power >= c.power(game))
      .sort((a, b) => (b.data.power ?? 0) - (a.data.power ?? 0))[0];
    if (easy) return { targetId: easy.id, donNeeded: 0 };

    return null;
  }

  async chooseBlocker(game, { attackerId, targetId, blockerIds }) {
    const p = this.player;
    const attacker = game.byId(attackerId);
    const atkPower = attacker.power(game);
    const candidates = blockerIds.map((id) => game.byId(id));
    const survivor = candidates.filter((b) => b.power(game) > atkPower)
      .sort((a, b) => a.cost - b.cost)[0];
    const cheapest = candidates.slice().sort((a, b) => a.cost - b.cost)[0];
    const counterPotential = p.hand.reduce((n, c) => n + (c.counterValue ?? 0), 0);

    if (targetId === 'leader') {
      // Golpe potencialmente letal: bloquea siempre.
      const lethal = p.life.length === 0 || (attacker.hasDoubleAttack && p.life.length <= 1);
      if (lethal) return (survivor ?? cheapest).id;
      // Vidas bajas: bloquea salvo que el counter salga barato.
      if (p.life.length <= 2) {
        const deficit = atkPower - p.leader.power(game);
        if (deficit > 2000 || counterPotential < deficit + 1000) return (survivor ?? cheapest).id;
        return null;
      }
      // Con vida de sobra solo bloquea gratis (el bloqueador sobrevive).
      if (survivor) return survivor.id;
      if (attacker.hasDoubleAttack && p.life.length <= 3) return cheapest.id;
      return null;
    }
    const target = game.byId(targetId);
    const targetValue = (target?.data.power ?? 0) / 1000 +
      (target?.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);
    if (targetValue >= 5 && survivor) return survivor.id;
    if (targetValue >= 7 && cheapest && cheapest.cost <= 2) return cheapest.id;
    return null;
  }

  async counterStep(game, { attackerId, targetId, attackPower, targetPower }) {
    const p = this.player;
    const deficit = attackPower - targetPower;
    if (deficit < 0) return { discardIds: [], eventIds: [] };
    const isLeader = targetId === 'leader';
    const attacker = game.byId(attackerId);
    const lethal = isLeader && (p.life.length === 0 || (attacker?.hasDoubleAttack && p.life.length <= 1));

    // ¿Merece defender? Solo intercambios eficientes: la mano es tempo.
    // Letal: siempre. Vidas 1-2: si sale barato. Personajes: solo joyas baratas de salvar.
    let worth;
    if (lethal) worth = true;
    else if (isLeader) {
      worth = (p.life.length <= 1) ||
        (p.life.length === 2 && deficit <= 1000) ||
        (attacker?.hasDoubleAttack && p.life.length <= 3 && deficit <= 2000);
    } else {
      const t = game.byId(targetId);
      const tv = (t?.data.power ?? 0) / 1000 +
        (t?.script?.abilities ?? []).reduce((n, a) => n + opsValue(a.ops), 0);
      worth = tv >= 5 && deficit <= 1000;
    }
    if (!worth) return { discardIds: [], eventIds: [] };

    // No pagues defensas imposibles o carísimas (salvo letal).
    const maxSpend = lethal ? 99 : deficit <= 1000 ? 2 : p.life.length <= 1 ? 3 : 2;

    // 1. Eventos [Counter] primero: suelen dar +2000/+4000 por una sola carta.
    const eventIds = [];
    let bonus = 0;
    for (const ev of p.hand.filter((c) => c.isEvent)) {
      const ab = abilitiesOf(ev, 'counter')[0];
      if (!ab) continue;
      if (ev.cost > p.donActive || !game.canPayAbilityCost(p, ev, ab.cost)) continue;
      const evBonus = ab.ops.filter((o) => o.op === 'powerUp').reduce((n, o) => n + o.n, 0);
      if (bonus > deficit) break;
      if (evBonus > 0 || opsValue(ab.ops) >= 1.5) {
        eventIds.push(ev.id);
        bonus += evBonus;
      }
      if (eventIds.length >= 1) break; // uno por batalla es casi siempre lo correcto
    }

    // 2. Descartes con counter, de menor a mayor valor de carta, hasta superar.
    const counters = p.hand.filter((c) => c.counterValue > 0 && !eventIds.includes(c.id))
      .sort((a, b) => this.handValue(a) - this.handValue(b));
    const discardIds = [];
    for (const c of counters) {
      if (bonus > deficit) break;
      if (discardIds.length + eventIds.length >= maxSpend) break;
      discardIds.push(c.id);
      bonus += c.counterValue;
    }
    if (bonus <= deficit) {
      // No alcanza: solo tira la mano si era letal (para forzar el último punto).
      return lethal ? { discardIds, eventIds } : { discardIds: [], eventIds: [] };
    }
    return { discardIds, eventIds };
  }
}
