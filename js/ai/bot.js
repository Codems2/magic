// Bot heurístico para One Piece TCG (versión F2; se refina en F4).
// Todas las decisiones devuelven JSON plano con ids de carta.

export class BotController {
  constructor(name) {
    this.name = name;
    this.player = null;
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

    // 2. Escenario si hay hueco de DON.
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
