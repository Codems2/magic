// IA heurística para los bots: curva de maná, evaluación de amenazas,
// combate calculado, removal oportuno y política multijugador (atacar al líder).

import { opsValue } from '../engine/effects.js';
import { manaSources, solvePayment, canPay, maxAffordableX, sourcesFor } from '../engine/mana.js';
import { Player } from '../engine/game.js';

export class BotController {
  constructor(name) {
    this.name = name;
    this.player = null;
    this._activatedThisTurn = new Set();
    this._turnSeen = 0;
  }

  // ---- valoración --------------------------------------------------------

  cardValue(card, game) {
    const s = card.script;
    let v = 0;
    if (card.isCreature) {
      v += card.power(game) * 0.7 + card.toughness(game) * 0.4;
      const kws = card.keywords();
      for (const k of ['flying', 'trample', 'menace', 'deathtouch', 'lifelink', 'first strike', 'vigilance']) {
        if (kws.has(k)) v += 0.7;
      }
      if (kws.has('double strike')) v += card.power(game) * 0.7;
    }
    if (s) {
      v += opsValue(s.castOps) + opsValue(s.etb) + opsValue(s.attack) * 1.5 +
           opsValue(s.upkeep) * 2 + opsValue(s.dies) * 0.5 + opsValue(s.eachUpkeep || []) * 2;
      for (const tr of s.combatHit || []) v += opsValue(tr.ops) * 1.2;
      for (const tr of s.allyEtb || []) v += opsValue(tr.ops) * 1.5;
      for (const tr of s.allyDies || []) v += opsValue(tr.ops);
      if (s.entersCounters) v += s.entersCounters === 'x' ? 2 : s.entersCounters;
      for (const st of s.statics) v += (st.pt[0] + st.pt[1]) * 1.5 + st.keywords.length;
      for (const ab of s.activated) v += opsValue(ab.ops) * 0.7;
      if (s.attachPT) v += (s.attachPT[0] + s.attachPT[1]) * 0.5;
    }
    if (card.isCommander) v += 3;
    return v;
  }

  // Amenaza que representa un oponente (para elegir a quién atacar/quitar).
  threatOf(q, game) {
    let t = 0;
    for (const c of q.creatures()) t += c.power(game) * 1.1 + this.cardValue(c, game) * 0.3;
    t += q.battlefield.filter((c) => !c.isLand && !c.isCreature).length * 1.2;
    t += q.hand.length * 0.4;
    t += (q.life - 20) * 0.15;
    if (q.creatures().some((c) => c.isCommander)) t += 4;
    return t;
  }

  biggestThreat(game) {
    const opps = game.opponentsOf(this.player);
    return opps.sort((a, b) => this.threatOf(b, game) - this.threatOf(a, game))[0] ?? null;
  }

  // ---- mulligan y mano ---------------------------------------------------

  async mulligan(game, hand, mulls) {
    if (mulls >= 2) return false;
    const lands = hand.filter((c) => c.isLand).length;
    return lands < 2 || lands > 5;
  }

  async chooseBottom(game, n) {
    const hand = this.player.hand.slice();
    const lands = hand.filter((c) => c.isLand);
    const spells = hand.filter((c) => !c.isLand).sort((a, b) => this.cardValue(a, game) - this.cardValue(b, game));
    const out = [];
    while (out.length < n && lands.length > 3) out.push(lands.pop());
    while (out.length < n && spells.length) out.push(spells.shift());
    while (out.length < n && lands.length) out.push(lands.pop());
    return out.slice(0, n);
  }

  async discardTo(game, n) {
    const sorted = this.player.hand.slice().sort((a, b) => this.cardValue(a, game) - this.cardValue(b, game));
    // Con muchas tierras, descarta tierras primero.
    const lands = this.player.hand.filter((c) => c.isLand);
    const out = [];
    if (this.player.lands().length + lands.length > 8) out.push(...lands.slice(0, n));
    for (const c of sorted) {
      if (out.length >= n) break;
      if (!out.includes(c)) out.push(c);
    }
    return out.slice(0, n);
  }

  async scryDecision(game, cards) {
    const needLand = this.player.lands().length < 4 && !this.player.hand.some((c) => c.isLand);
    const flooded = this.player.lands().length >= 6;
    const top = []; const bottom = [];
    for (const c of cards) {
      if (c.isLand) (needLand ? top : flooded ? bottom : top).push(c);
      else (this.cardValue(c, game) >= 2 ? top : bottom).push(c);
    }
    return { top, bottom };
  }

  // ---- fase principal ----------------------------------------------------

  resetTurnMemory(game) {
    if (this._turnSeen !== game.turn) {
      this._turnSeen = game.turn;
      this._activatedThisTurn.clear();
    }
  }

  async mainAction(game) {
    const p = this.player;
    this.resetTurnMemory(game);

    // 1. Jugar tierra.
    if (p.landsPlayedThisTurn < 1) {
      const land = this.pickLand(game);
      if (land) return { type: 'playLand', card: land };
    }

    // 2. Mejor hechizo lanzable.
    const cast = this.bestCast(game);
    if (cast) return cast;

    // 3. Equipar en main2 (o si no hay nada mejor).
    const eq = this.bestEquip(game);
    if (eq) return eq;

    // 3b. Tripular vehículos que compensen antes de combate.
    if (game.phase === 'main1') {
      const crew = this.bestCrew(game);
      if (crew) return crew;
    }

    // 4. Habilidades activadas útiles.
    const act = this.bestActivation(game);
    if (act) return act;

    return { type: 'pass' };
  }

  pickLand(game) {
    const p = this.player;
    const lands = p.hand.filter((c) => c.isLand);
    if (!lands.length) return null;
    // Preferir tierras que entran sin girar y aportan colores que faltan.
    const have = new Set();
    for (const l of p.lands()) for (const c of l.data.producedMana || []) have.add(c);
    const need = new Set(p.deck.commanders.flatMap((c) => c.colorIdentity || []));
    const score = (l) => {
      let s = 0;
      const prod = l.data.producedMana || [];
      if (!/enters?( the battlefield)? tapped/.test(l.oracleText.toLowerCase())) s += 1.5;
      for (const c of prod) { if (need.has(c) && !have.has(c)) s += 2; }
      s += Math.min(prod.length, 3) * 0.2;
      return s;
    };
    return lands.sort((a, b) => score(b) - score(a))[0];
  }

  castables(game, { instantOnly = false } = {}) {
    const p = this.player;
    const pool = [...p.hand, ...p.command];
    const out = [];
    for (const card of pool) {
      if (card.isLand) continue;
      if (instantOnly && !(card.isInstant || card.hasKeyword('flash', game))) continue;
      const cost = card.zone === 'command' ? game.commanderCost(card) : card.parsedCost;
      const srcs = sourcesFor(p, game, card);
      if (!solvePayment(cost, srcs, cost.x ? 1 : 0) && !(cost.x && solvePayment(cost, srcs, 0))) continue;
      // Conjuros sin efecto simulado: no malgastar.
      if ((card.isInstant || card.isSorcery) && !card.script.castOps.length) continue;
      // Objetivos requeridos disponibles.
      if (card.script.targets.length) {
        const ok = card.script.targets.every((op) => {
          const spec = op.target ?? { kind: 'creature' };
          return game.legalTargets(spec, p).length > 0;
        });
        if (!ok) continue;
      }
      // Auras solo con criatura propia que mejorar.
      if (card.isAura && !p.creatures().length) continue;
      out.push(card);
    }
    return out;
  }

  bestCast(game) {
    const p = this.player;
    const options = this.castables(game);
    let best = null; let bestScore = 0.5;
    for (const card of options) {
      const score = this.castScore(card, game);
      if (score > bestScore) { best = card; bestScore = score; }
    }
    if (!best) return null;
    const action = { type: 'cast', card: best };
    const cost = best.zone === 'command' ? game.commanderCost(best) : best.parsedCost;
    if (cost.x) action.xValue = Math.min(maxAffordableX(cost, p, game), 10);
    return action;
  }

  castScore(card, game) {
    const p = this.player;
    const s = card.script;
    let score = this.cardValue(card, game);

    // Contrahechizos se guardan para responder.
    if (s.castOps.some((op) => op.op === 'counterSpell')) return 0;

    // Instantáneos de truco de combate se guardan.
    if (card.isInstant && s.castOps.every((op) => op.op === 'pump')) return 0;

    // Rampa: prioridad en los primeros turnos.
    if (s.castOps.some((op) => op.op === 'ramp' || op.op === 'treasure') || (card.data.producedMana && !card.isLand)) {
      score += game.turn <= 5 ? 4 : -1;
    }

    // Comandante: núcleo del mazo.
    if (card.isCommander) score += 4 - card.commanderCasts * 1.5;

    // Removal dirigido: solo si hay un objetivo que lo merezca.
    const removal = s.castOps.filter((op) => ['destroy', 'exile', 'bounce'].includes(op.op) || (op.op === 'damage' && op.target?.targeted));
    if (removal.length) {
      const target = this.bestEnemyTarget(game, removal[0]);
      if (!target) return 0;
      const tv = target instanceof Player ? 2 : this.cardValue(target, game);
      if (tv < 3.5) return 0;
      score = tv + 2;
    }

    // Barreduras: solo si vamos por detrás en mesa.
    if (s.castOps.some((op) => op.op === 'wipe')) {
      const myBoard = p.creatures().reduce((n, c) => n + this.cardValue(c, game), 0);
      const oppBoard = Math.max(...game.opponentsOf(p).map((q) => q.creatures().reduce((n, c) => n + this.cardValue(c, game), 0)), 0);
      if (oppBoard < myBoard + 6) return 0;
      score = 10;
    }

    // No gastar la mano entera sin necesidad: leve penalización al final.
    if (game.phase === 'main2') score += 0.3; // mejor después de combate para trucos ya pasados
    return score;
  }

  bestEnemyTarget(game, op) {
    const p = this.player;
    const spec = op.target ?? { kind: 'creature' };
    const candidates = game.legalTargets(spec, p).filter((t) => {
      if (t instanceof Player) return t !== p;
      return t.controller !== p;
    });
    if (!candidates.length) return null;
    // Si es daño, solo objetivos que mueran (o la cara del líder).
    if (op.op === 'damage' && op.n !== 'x') {
      const killable = candidates.filter((t) => !(t instanceof Player) && t.toughness(game) <= op.n && !t.hasKeyword('indestructible', game));
      if (killable.length) return killable.sort((a, b) => this.cardValue(b, game) - this.cardValue(a, game))[0];
      const players = candidates.filter((t) => t instanceof Player);
      if (players.length) return this.biggestThreat(game);
      return null;
    }
    const perms = candidates.filter((t) => !(t instanceof Player) && !t.hasKeyword('indestructible', game));
    if (perms.length) return perms.sort((a, b) => this.cardValue(b, game) - this.cardValue(a, game))[0];
    return candidates[0];
  }

  bestEquip(game) {
    const p = this.player;
    const equips = p.battlefield.filter((c) => c.isEquipment && c.script.equipCost && !c.attachedTo);
    if (!equips.length) return null;
    const target = p.creatures().sort((a, b) => this.cardValue(b, game) - this.cardValue(a, game))[0];
    if (!target) return null;
    for (const eq of equips) {
      if (this._activatedThisTurn.has(eq.id)) continue;
      if (solvePayment(eq.script.equipCost, manaSources(p, game))) {
        this._activatedThisTurn.add(eq.id);
        return { type: 'equip', equipment: eq, creature: target };
      }
    }
    return null;
  }

  bestCrew(game) {
    const p = this.player;
    for (const v of p.battlefield) {
      if (!v.script?.crew || v.crewed || v.summoningSick) continue;
      if (this._activatedThisTurn.has(v.id)) continue;
      const pool = p.creatures().filter((c) => !c.tapped && c !== v)
        .sort((a, b) => a.power(game) - b.power(game));
      let sum = 0; const crew = [];
      const single = pool.find((c) => c.power(game) >= v.script.crew);
      if (single) { crew.push(single); sum = single.power(game); }
      else for (const c of pool) { crew.push(c); sum += c.power(game); if (sum >= v.script.crew) break; }
      if (sum < v.script.crew) continue;
      // Solo si el vehículo pega más que lo que giramos para tripularlo.
      const crewPower = crew.reduce((n, c) => n + c.power(game), 0);
      const vp = parseInt(v.data.power, 10) || 0;
      if (vp <= crewPower) continue;
      this._activatedThisTurn.add(v.id);
      return { type: 'crew', vehicle: v };
    }
    return null;
  }

  bestActivation(game) {
    const p = this.player;
    // Recursión desde el cementerio.
    for (const card of p.graveyard) {
      for (const ab of card.script?.activated || []) {
        if (!ab.fromGraveyard || this._activatedThisTurn.has(card.id)) continue;
        if (this.cardValue(card, game) < 2.5) continue;
        if (!solvePayment(ab.mana, manaSources(p, game))) continue;
        this._activatedThisTurn.add(card.id);
        return { type: 'activate', permanent: card, ability: ab };
      }
    }
    for (const perm of p.battlefield) {
      if (this._activatedThisTurn.has(perm.id)) continue;
      for (const ab of perm.script?.activated || []) {
        // Solo sacrifica fichas utilitarias (Pista, Comida, Sangre...).
        if (ab.sac && !(perm.isToken && !perm.isCreature)) continue;
        if (opsValue(ab.ops) < (ab.sac ? 1 : 1.5)) continue;
        if (ab.tap && (perm.tapped || (perm.isCreature && perm.summoningSick))) continue;
        // No girar criaturas buenas antes de combate.
        if (ab.tap && perm.isCreature && this.cardValue(perm, game) > 3 && game.phase === 'main1') continue;
        if (!solvePayment(ab.mana, manaSources(p, game))) continue;
        const targeted = ab.ops.filter((op) => op.targeted || op.target?.targeted);
        if (targeted.length && !targeted.every((op) => game.legalTargets(op.target ?? { kind: 'creature' }, p).length)) continue;
        this._activatedThisTurn.add(perm.id);
        return { type: 'activate', permanent: perm, ability: ab };
      }
    }
    return null;
  }

  // ---- objetivos ---------------------------------------------------------

  async chooseTarget(game, source, op, candidates) {
    const p = this.player;
    const beneficial = ['pump', 'counters', 'support', 'distribute', 'fightSel'].includes(op.op);
    if (beneficial) {
      const own = candidates.filter((t) => !(t instanceof Player) && t.controller === p);
      if (own.length) return own.sort((a, b) => this.cardValue(b, game) - this.cardValue(a, game))[0];
      return candidates[0];
    }
    const enemyPerms = candidates.filter((t) => !(t instanceof Player) && t.controller !== p);
    if (enemyPerms.length) {
      if (op.op === 'damage' && typeof op.n === 'number') {
        const killable = enemyPerms.filter((t) => t.toughness(game) <= op.n);
        if (killable.length) return killable.sort((a, b) => this.cardValue(b, game) - this.cardValue(a, game))[0];
      } else {
        return enemyPerms.sort((a, b) => this.cardValue(b, game) - this.cardValue(a, game))[0];
      }
    }
    const enemyPlayers = candidates.filter((t) => t instanceof Player && t !== p);
    if (enemyPlayers.length) {
      const threat = this.biggestThreat(game);
      return enemyPlayers.includes(threat) ? threat : enemyPlayers[0];
    }
    return candidates[0];
  }

  async chooseX(game, card, maxX) { return Math.min(maxX, 10); }

  async choosePayTimes(game, card, maxTimes) { return maxTimes; }

  async chooseCards(game, cards, n) {
    const needLand = this.player.lands().length < 4;
    return cards.slice().sort((a, b) => {
      const av = this.cardValue(a, game) + (needLand && a.isLand ? 3 : 0);
      const bv = this.cardValue(b, game) + (needLand && b.isLand ? 3 : 0);
      return bv - av;
    }).slice(0, n);
  }

  // ---- respuestas --------------------------------------------------------

  async respond(game, spell) {
    const p = this.player;
    const counters = p.hand.filter((c) =>
      c.isInstant && c.script.castOps.some((op) => op.op === 'counterSpell') &&
      canPay(c.parsedCost, p, game));
    if (!counters.length) return null;
    const threat = opsValue(spell.script.castOps) + spell.cmc + (spell.isCommander ? 3 : 0);
    const isWipe = spell.script.castOps.some((op) => op.op === 'wipe');
    if (threat >= 6 || isWipe || (spell.cmc >= 5 && spell.isCreature)) {
      return { card: counters.sort((a, b) => a.cmc - b.cmc)[0] };
    }
    return null;
  }

  async combatInstant(game) {
    const p = this.player;
    // Removal instantáneo sobre el mayor atacante si compensa.
    const attackers = [];
    for (const q of game.players) for (const c of q.battlefield) {
      if (c.attacking === p) attackers.push(c);
    }
    if (!attackers.length) return null;
    const biggest = attackers.sort((a, b) => b.power(game) - a.power(game))[0];
    if (biggest.power(game) < 4 && !biggest.isCommander) return null;
    for (const c of p.hand) {
      if (!c.isInstant || !canPay(c.parsedCost, p, game)) continue;
      const rem = c.script.castOps.find((op) => ['destroy', 'exile'].includes(op.op) ||
        (op.op === 'damage' && op.target?.targeted && typeof op.n === 'number' && op.n >= biggest.toughness(game)));
      if (rem) return { card: c, targets: [biggest] };
    }
    return null;
  }

  // ---- combate -----------------------------------------------------------

  async declareAttackers(game) {
    const p = this.player;
    const ready = p.creatures().filter((c) => c.canAttack(game) && c.power(game) > 0);
    if (!ready.length) return [];

    const opps = game.opponentsOf(p);
    if (!opps.length) return [];

    // ¿Alguien está a tiro de muerte?
    const potential = ready.reduce((n, c) => n + c.power(game), 0);
    let primary = opps.find((q) => q.life <= potential * 0.8 && this.defenseOf(q, game) < ready.length);
    if (!primary) primary = this.biggestThreat(game);

    const decls = [];
    const dangerAtHome = Math.max(...opps.map((q) => q.creatures().filter((c) => !c.tapped).length), 0);
    const myLife = p.life;
    // Reserva defensiva si estamos bajos de vida.
    let keepBack = myLife < 15 && dangerAtHome > 1 ? 1 : 0;

    const sorted = ready.slice().sort((a, b) => b.power(game) - a.power(game));
    for (const atk of sorted) {
      const defender = this.pickDefender(atk, primary, opps, game);
      if (!defender) continue;
      if (keepBack > 0 && !this.safeAttack(atk, defender, game) && atk.toughness(game) >= 3) {
        keepBack--;
        continue;
      }
      if (this.shouldAttack(atk, defender, game)) decls.push({ attacker: atk, defender });
    }
    return decls;
  }

  defenseOf(q, game) {
    return q.creatures().filter((c) => !c.tapped).length;
  }

  pickDefender(atk, primary, opps, game) {
    // Ataca al líder salvo que otro esté casi muerto y sin defensas.
    const easy = opps.find((q) => q.life <= atk.power(game) && this.defenseOf(q, game) === 0);
    return easy ?? primary;
  }

  safeAttack(atk, defender, game) {
    const blockers = defender.creatures().filter((b) => b.canBlock(atk, game));
    if (!blockers.length) return true;
    const p = atk.power(game); const t = atk.toughness(game);
    return !blockers.some((b) => b.power(game) >= t && b.toughness(game) > p);
  }

  shouldAttack(atk, defender, game) {
    const blockers = defender.creatures().filter((b) => b.canBlock(atk, game));
    if (!blockers.length) return true;
    const p = atk.power(game); const t = atk.toughness(game);
    const value = this.cardValue(atk, game);
    // ¿Puede el defensor hacer un bloqueo claramente favorable?
    const badBlock = blockers.some((b) =>
      b.power(game) >= t && b.toughness(game) > p && this.cardValue(b, game) < value);
    if (badBlock && value > 2.5) return false;
    // Con evasión o trades neutros, adelante.
    return true;
  }

  async declareBlockers(game, attackers) {
    const p = this.player;
    const available = p.creatures().filter((c) => !c.tapped && !c.attacking);
    if (!available.length) return [];

    const incoming = attackers.reduce((n, a) => n + a.power(game), 0);
    const lethal = incoming >= p.life;
    const used = new Set();
    const blocks = [];

    const sorted = attackers.slice().sort((a, b) => b.power(game) - a.power(game));
    for (const atk of sorted) {
      const canBlockers = available.filter((b) => !used.has(b.id) && b.canBlock(atk, game));
      if (!canBlockers.length) continue;
      const needTwo = atk.hasKeyword('menace', game);
      const atkP = atk.power(game); const atkT = atk.toughness(game);
      const atkVal = this.cardValue(atk, game);

      // Mejor trade: mata al atacante y sobrevive.
      const winning = canBlockers.filter((b) =>
        b.power(game) >= atkT && (b.toughness(game) > atkP || b.hasKeyword('indestructible', game) || (b.hasKeyword('first strike', game) && b.power(game) >= atkT)));
      // Trade parejo: ambos mueren pero salimos ganando en valor.
      const trading = canBlockers.filter((b) => b.power(game) >= atkT && this.cardValue(b, game) <= atkVal + 1);

      let choice = null;
      if (winning.length) choice = winning.sort((a, b) => this.cardValue(a, game) - this.cardValue(b, game))[0];
      else if (trading.length && !atk.hasKeyword('deathtouch', game)) choice = trading.sort((a, b) => this.cardValue(a, game) - this.cardValue(b, game))[0];
      else if (lethal || (atk.isCommander && (p.commanderDamage.get(atk.id) || 0) + atkP >= 15)) {
        // Chump para sobrevivir.
        choice = canBlockers.sort((a, b) => this.cardValue(a, game) - this.cardValue(b, game))[0];
      }
      if (!choice) continue;

      if (needTwo) {
        const second = canBlockers.filter((b) => b !== choice)
          .sort((a, b) => this.cardValue(a, game) - this.cardValue(b, game))[0];
        if (!second) continue;
        used.add(second.id);
        blocks.push({ blocker: second, attacker: atk });
      }
      used.add(choice.id);
      blocks.push({ blocker: choice, attacker: atk });
    }
    return blocks;
  }
}
