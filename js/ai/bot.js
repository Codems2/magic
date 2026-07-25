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

  async chooseTarget(game, { purpose, candidateIds, optional }) {
    const p = this.player;
    const cands = candidateIds.map((id) => game.byId(id)).filter(Boolean);
    if (!cands.length) return null;
    const own = cands.filter((c) => c.owner === p);
    const enemy = cands.filter((c) => c.owner !== p);
    switch (purpose) {
      case 'ko': case 'bounce': case 'tuckBottom': case 'rest':
        return enemy.sort((a, b) => (b.data.power ?? 0) - (a.data.power ?? 0))[0]?.id ?? null;
      case 'giveDon': case 'grantNoBlocker':
        // Al líder por defecto (flexible para atacar o defender).
        return (own.find((c) => c.isLeader) ?? own[0])?.id ?? null;
      case 'powerUp': {
        // En batalla: al defensor; si no, al líder.
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

  async payOptionalCost(game, { cardId, when }) {
    const card = game.byId(cardId);
    const ab = abilitiesOf(card, when)[0];
    if (!ab) return false;
    // Paga si el efecto vale más que el coste aproximado.
    const costWeight = (ab.cost?.donReturn ?? 0) * 0.8 + (ab.cost?.trashHand ?? 0) * 0.7 + (ab.cost?.donRest ?? 0) * 0.4;
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

  combatOrPass(game) {
    const p = this.player;
    const opp = game.opponentOf(p);

    // 3. Atacar con lo rentable (estimando el counter del rival por su mano).
    const attackers = [p.leader, ...p.characters].filter((c) => c && c.canAttack(game));
    const counterRisk = Math.min(opp.hand.length, 2) * 1000; // estimación, no mira la mano
    for (const atk of attackers) {
      // Dar DON sobrante al atacante antes de pegar.
      const target = this.pickTarget(game, atk, counterRisk);
      if (!target) continue;
      const need = (target.card ? target.card.power(game) : opp.leader.power(game)) + counterRisk;
      let power = atk.power(game);
      if (power < need && p.donActive > 0) {
        const give = Math.min(p.donActive, Math.ceil((need - power) / 1000));
        if (give > 0 && power + give * 1000 >= need) {
          return { type: 'giveDon', cardId: atk.id, n: give };
        }
      }
      return { type: 'attack', attackerId: atk.id, targetId: target.id };
    }
    return { type: 'pass' };
  }

  pickTarget(game, atk, counterRisk) {
    const opp = game.opponentOf(this.player);
    const power = atk.power(game);
    // KO gratis a personajes girados valiosos.
    const rested = opp.characters.filter((c) => c.rested && power >= c.power(game));
    const good = rested.sort((a, b) => (b.data.power ?? 0) - (a.data.power ?? 0))[0];
    if (good && (good.data.power ?? 0) >= 4000) return { id: good.id, card: good };
    // Si no, presiona al líder cuando el golpe puede entrar.
    if (power >= opp.leader.power(game)) return { id: 'leader', card: null };
    if (good) return { id: good.id, card: good };
    return null;
  }

  async chooseBlocker(game, { attackerId, targetId, blockerIds }) {
    const p = this.player;
    const attacker = game.byId(attackerId);
    // Bloquea si el ataque va al líder con pocas vidas, o salva a un personaje valioso.
    const atkPower = attacker.power(game);
    const candidates = blockerIds.map((id) => game.byId(id));
    // Prefiere un bloqueador que sobreviva; si no, el más barato.
    const survivor = candidates.filter((b) => b.power(game) > atkPower)
      .sort((a, b) => a.cost - b.cost)[0];
    const cheapest = candidates.slice().sort((a, b) => a.cost - b.cost)[0];
    if (targetId === 'leader') {
      if (p.life.length <= 2) return (survivor ?? cheapest).id;
      if (survivor) return survivor.id;
      if (p.life.length <= 3 && attacker.hasDoubleAttack) return cheapest.id;
      return null;
    }
    const target = game.byId(targetId);
    if (target && (target.data.power ?? 0) >= 5000 && survivor) return survivor.id;
    return null;
  }

  async counterStep(game, { attackerId, targetId, attackPower, targetPower }) {
    const p = this.player;
    const deficit = attackPower - targetPower;
    if (deficit < 0) return []; // ya no entra
    const isLeader = targetId === 'leader';
    // ¿Merece la pena counterear? Líder con vidas bajas o personaje valioso.
    const worth = isLeader
      ? (p.life.length <= 3 || game.byId(attackerId)?.hasDoubleAttack)
      : (game.byId(targetId)?.data.power ?? 0) >= 5000;
    if (!worth) return [];
    // Selecciona counters de mano justos para superar el déficit.
    const counters = p.hand.filter((c) => c.counterValue > 0)
      .sort((a, b) => a.counterValue - b.counterValue || a.cost - b.cost);
    const chosen = [];
    let sum = 0;
    for (const c of counters) {
      if (sum > deficit) break;
      chosen.push(c.id);
      sum += c.counterValue;
    }
    // Si ni con todo alcanza, no desperdicies mano.
    return sum > deficit ? chosen : [];
  }
}
