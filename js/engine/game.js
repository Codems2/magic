// Motor de partida de Commander multijugador.

import { CardInstance, makeToken, resetIds } from './cards.js';
import { buildScript } from './effects.js';
import { manaSources, solvePayment, maxAffordableX, sourcesFor } from './mana.js';

// RNG con semilla para partidas reproducibles.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Player {
  constructor(name, deck, controller, isBot) {
    this.name = name;
    this.deck = deck;
    this.controller = controller;
    this.isBot = isBot;
    this.life = 40;
    this.energy = 0;
    this.poison = 0;
    this.castNoncreatureThisTurn = false;
    this.library = [];
    this.hand = [];
    this.battlefield = [];
    this.graveyard = [];
    this.exile = [];
    this.command = [];
    this.commanderDamage = new Map(); // commanderId -> daño
    this.landsPlayedThisTurn = 0;
    this.lost = false;
    this.lossReason = null;
  }
  get alive() { return !this.lost; }
  creatures() { return this.battlefield.filter((c) => c.isCreature); }
  lands() { return this.battlefield.filter((c) => c.isLand); }
}

export class Game {
  constructor(configs, { seed = 42, onLog = null, maxTurns = 80 } = {}) {
    resetIds();
    this.rng = mulberry32(seed);
    this.onLog = onLog;
    this.maxTurns = maxTurns;
    this.turn = 0;
    this.phase = 'setup';
    this.activeIdx = 0;
    this.winner = null;
    this.over = false;
    this.monarch = null;
    this.logLines = [];

    this.players = configs.map((cfg) => {
      const p = new Player(cfg.name, cfg.deck, cfg.controller, cfg.isBot);
      cfg.controller.player = p;
      return p;
    });

    for (const p of this.players) {
      for (const entry of p.deck.cards) {
        for (let i = 0; i < entry.count; i++) {
          const card = new CardInstance(entry, p);
          card.script = buildScript(entry);
          p.library.push(card);
        }
      }
      for (const entry of p.deck.commanders) {
        const card = new CardInstance(entry, p);
        card.script = buildScript(entry);
        card.isCommander = true;
        card.zone = 'command';
        p.command.push(card);
      }
      this.shuffle(p.library);
    }
  }

  log(msg) {
    this.logLines.push(msg);
    if (this.onLog) this.onLog(msg);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  get activePlayer() { return this.players[this.activeIdx]; }
  alivePlayers() { return this.players.filter((p) => p.alive); }
  opponentsOf(p) { return this.players.filter((q) => q !== p && q.alive); }

  // ---- preparación -------------------------------------------------------

  async start() {
    for (const p of this.players) {
      p.hand = p.library.splice(0, 7);
      p.hand.forEach((c) => (c.zone = 'hand'));
    }
    // Mulligan de Londres.
    for (const p of this.players) {
      let mulls = 0;
      while (mulls < 3) {
        const wants = await p.controller.mulligan(this, p.hand, mulls);
        if (!wants) break;
        mulls++;
        p.library.push(...p.hand.splice(0));
        this.shuffle(p.library);
        p.hand = p.library.splice(0, 7);
        p.hand.forEach((c) => (c.zone = 'hand'));
        this.log(`${p.name} hace mulligan (${mulls}).`);
      }
      if (mulls > 0) {
        const bottom = await p.controller.chooseBottom(this, mulls);
        for (const c of bottom) {
          p.hand.splice(p.hand.indexOf(c), 1);
          c.zone = 'library';
          p.library.push(c);
        }
      }
    }
    this.log(`Comienza la partida. Orden: ${this.players.map((p) => p.name).join(' → ')}.`);
  }

  async run() {
    await this.start();
    while (!this.over) await this.playTurn();
    return this.winner;
  }

  // ---- turno -------------------------------------------------------------

  async playTurn() {
    if (this.over) return;
    const p = this.activePlayer;
    if (!p.alive) { this.nextPlayer(); return; }
    this.turn++;
    if (this.turn > this.maxTurns) return this.endByTimeout();

    this.log(`— Turno ${this.turn}: ${p.name} (${p.life} vidas) —`);
    p.landsPlayedThisTurn = 0;
    p.castNoncreatureThisTurn = false;

    // Enderezar.
    this.phase = 'untap';
    for (const c of p.battlefield) { c.tapped = false; c.summoningSick = false; }

    // Mantenimiento.
    this.phase = 'upkeep';
    // Rebotes pendientes de este jugador.
    for (const item of [...(this.reboundQueue ?? [])]) {
      if (item.player !== p) continue;
      this.reboundQueue.splice(this.reboundQueue.indexOf(item), 1);
      const c = item.card;
      const ex = c.owner.exile;
      if (ex.includes(c)) ex.splice(ex.indexOf(c), 1);
      this.log(`Rebote: ${p.name} lanza ${c.name} gratis.`);
      c.zone = 'stack';
      let targets = [];
      if (c.script.targets.length) {
        targets = await this.pickTargetsFor(p, c, c.script.targets);
        if (targets === null) { this.moveToGraveyard(c, null); continue; }
      }
      await this.resolveSpell(p, c, targets, 0);
      if (this.over) return;
    }
    for (const c of [...p.battlefield]) {
      if (c.script.upkeep.length) await this.resolveTriggered(c, c.script.upkeep, 'mantenimiento');
    }
    // "Al comienzo de cada mantenimiento" (permanentes de cualquier jugador).
    for (const q of this.alivePlayers()) {
      for (const c of [...q.battlefield]) {
        if (c.script.eachUpkeep?.length) {
          this.resolveOpsSync(c.script.eachUpkeep, { source: c, controller: q, targets: [], xValue: 0 });
        }
      }
    }
    if (this.over) return;

    // Robar.
    this.phase = 'draw';
    this.drawCards(p, 1);
    if (this.over) return;

    // Primera fase principal.
    this.phase = 'main1';
    await this.mainPhase(p);
    if (this.over) return;

    // Combate.
    this.phase = 'combat';
    await this.combatPhase(p);
    if (this.over) return;

    // Segunda fase principal.
    this.phase = 'main2';
    await this.mainPhase(p);
    if (this.over) return;

    // Paso final.
    this.phase = 'end';
    for (const c of [...p.battlefield]) {
      if (c.script.endStep.length) await this.resolveTriggered(c, c.script.endStep, 'paso final');
    }
    for (const q of this.alivePlayers()) {
      for (const c of [...q.battlefield]) {
        if (c.script.eachEnd?.length) {
          this.resolveOpsSync(c.script.eachEnd, { source: c, controller: q, targets: [], xValue: 0 });
        }
      }
    }
    if (this.monarch === p && p.alive) {
      this.log(`👑 ${p.name} roba por ser el monarca.`);
      this.drawCards(p, 1);
      if (this.over) return;
    }
    const noMax = p.battlefield.some((c) => c.script?.noMaxHand);
    if (p.hand.length > 7 && !noMax) {
      const toDiscard = await p.controller.discardTo(this, p.hand.length - 7);
      for (const c of toDiscard) this.moveToGraveyard(c, 'descarta');
    }
    // Fichas marcadas "sacrifícala al comienzo del próximo paso final".
    for (const q of this.alivePlayers()) {
      for (const c of [...q.battlefield]) {
        if (c._sacAtEnd) this.removeFromBattlefield(c, 'sacrificado');
      }
    }
    for (const q of this.players) for (const c of q.battlefield) c.cleanupEndOfTurn();
    this.checkState();
    this.nextPlayer();
  }

  nextPlayer() {
    for (let i = 1; i <= this.players.length; i++) {
      const idx = (this.activeIdx + i) % this.players.length;
      if (this.players[idx].alive) { this.activeIdx = idx; return; }
    }
  }

  endByTimeout() {
    const ranked = this.alivePlayers().sort((a, b) => b.life - a.life);
    this.winner = ranked[0] ?? null;
    this.over = true;
    this.log(`Límite de turnos alcanzado. Gana ${this.winner?.name ?? 'nadie'} por vidas.`);
  }

  // ---- fase principal ----------------------------------------------------

  async mainPhase(p) {
    let guard = 0;
    while (!this.over && guard++ < 200) {
      const action = await p.controller.mainAction(this);
      if (!action || action.type === 'pass') return;
      try {
        await this.performAction(p, action);
      } catch (err) {
        this.log(`(!) Acción inválida de ${p.name}: ${err.message}`);
        return;
      }
      this.checkState();
      if (!p.alive) return;
    }
  }

  async performAction(p, action) {
    switch (action.type) {
      case 'playLand': return this.playLand(p, action.card);
      case 'cast': return this.castSpell(p, action.card, action);
      case 'activate': return this.activateAbility(p, action.permanent, action.ability, action);
      case 'equip': return this.equip(p, action.equipment, action.creature);
      case 'crew': return this.crewVehicle(p, action.vehicle);
      default: throw new Error(`acción desconocida ${action.type}`);
    }
  }

  crewVehicle(p, vehicle) {
    const need = vehicle.script?.crew;
    if (!need || vehicle.crewed || vehicle.zone !== 'battlefield') throw new Error('no se puede tripular');
    // Gira criaturas propias (las de menos fuerza primero) hasta sumar la tripulación.
    const crew = [];
    let sum = 0;
    const pool = p.creatures().filter((c) => !c.tapped && c !== vehicle && !c.crewed)
      .sort((a, b) => a.power(this) - b.power(this));
    // Primero intenta con una sola criatura justa, si no, acumula desde abajo.
    const single = pool.find((c) => c.power(this) >= need);
    if (single) { crew.push(single); sum = single.power(this); }
    else {
      for (const c of pool) { crew.push(c); sum += c.power(this); if (sum >= need) break; }
    }
    if (sum < need) throw new Error('sin tripulación suficiente');
    for (const c of crew) c.tapped = true;
    vehicle.crewed = true;
    this.log(`${p.name} tripula ${vehicle.name} con ${crew.map((c) => c.name).join(', ')}.`);
  }

  maxLands(p) {
    return 1 + p.battlefield.filter((c) => c.script?.extraLand).length;
  }

  playLand(p, card) {
    if (p.landsPlayedThisTurn >= this.maxLands(p)) throw new Error('ya jugó tierra');
    if (!card.isLand || card.zone !== 'hand') throw new Error('no es una tierra en mano');
    p.hand.splice(p.hand.indexOf(card), 1);
    this.putOnBattlefield(card, p);
    p.landsPlayedThisTurn++;
    this.log(`${p.name} juega ${card.name}.`);
    // Tierras que entran giradas.
    if (/enters?( the battlefield)? tapped/.test(card.oracleText.toLowerCase()) &&
        !/unless|if you control/.test(card.oracleText.toLowerCase())) {
      card.tapped = true;
    }
  }

  commanderCost(card) {
    const base = card.parsedCost;
    return { generic: base.generic + 2 * card.commanderCasts, pips: base.pips, x: base.x };
  }

  async castSpell(p, card, { targets = null, xValue = 0 } = {}) {
    const fromCommand = card.zone === 'command';
    if (card.zone !== 'hand' && !fromCommand) throw new Error('carta fuera de mano');
    const cost = fromCommand ? this.commanderCost(card) : card.parsedCost;
    if (cost.x && !xValue) xValue = await p.controller.chooseX(this, card, maxAffordableX(cost, p, this));

    const payment = solvePayment(cost, sourcesFor(p, this, card), xValue);
    if (!payment) throw new Error(`no puede pagar ${card.name}`);

    // Elegir objetivos del hechizo.
    if (!targets && card.script.targets.length) {
      targets = await this.pickTargetsFor(p, card, card.script.targets);
      if (targets === null) throw new Error(`sin objetivos legales para ${card.name}`);
    }

    this.paySources(payment);
    if (fromCommand) {
      p.command.splice(p.command.indexOf(card), 1);
      card.commanderCasts++;
    } else {
      p.hand.splice(p.hand.indexOf(card), 1);
    }
    card.zone = 'stack';
    const tax = fromCommand && card.commanderCasts > 1 ? ` (impuesto ${(card.commanderCasts - 1) * 2})` : '';
    this.log(`${p.name} lanza ${card.name}${tax}${xValue ? ` con X=${xValue}` : ''}.`);

    // Prowess: hechizos que no son de criatura animan a tus criaturas.
    if (!card.isCreature) {
      p.castNoncreatureThisTurn = true;
      for (const c of p.creatures()) {
        if ((c.data.keywords || []).includes('Prowess')) {
          c.tempPT = [c.tempPT[0] + 1, c.tempPT[1] + 1];
        }
      }
    }
    // Extorsionar (solo bots: pago automático con maná sobrante).
    if (p.isBot) {
      for (const c of p.battlefield) {
        if (!(c.data.keywords || []).includes('Extort')) continue;
        const pay = solvePayment({ generic: 0, pips: [['W', 'B']], x: 0 }, manaSources(p, this));
        if (!pay) break;
        this.paySources(pay);
        const opps = this.opponentsOf(p);
        for (const q of opps) q.life -= 1;
        p.life += opps.length;
        this.log(`${p.name} extorsiona: cada oponente pierde 1 vida (+${opps.length} para ${p.name}).`);
        this.checkState();
        break;
      }
    }

    // Ventana de respuesta: contrahechizos de los demás.
    const countered = await this.responseWindow(p, card);
    if (countered) {
      this.log(`${card.name} es contrarrestado.`);
      this.moveToGraveyard(card, null);
      return;
    }
    if (card.script.cascade) await this.doCascade(p, card);
    await this.resolveSpell(p, card, targets ?? [], xValue);
  }

  // Cascada: exilia hasta hallar un hechizo más barato y lánzalo gratis.
  async doCascade(p, spell) {
    const exiled = [];
    let hit = null;
    while (p.library.length) {
      const c = p.library.shift();
      if (!c.isLand && c.cmc < spell.cmc) { hit = c; break; }
      exiled.push(c);
    }
    this.shuffle(exiled);
    p.library.push(...exiled);
    if (!hit) return;
    this.log(`Cascada: ${p.name} lanza ${hit.name} gratis.`);
    hit.zone = 'stack';
    let targets = [];
    if (hit.script.targets.length) {
      targets = await this.pickTargetsFor(p, hit, hit.script.targets);
      if (targets === null) { this.moveToGraveyard(hit, null); return; }
    }
    await this.resolveSpell(p, hit, targets, 0);
  }

  async responseWindow(caster, spell) {
    for (const q of this.opponentsOf(caster)) {
      const resp = await q.controller.respond(this, spell);
      if (resp && resp.card) {
        const c = resp.card;
        const payment = solvePayment(c.parsedCost, manaSources(q, this), 0);
        if (!payment) continue;
        this.paySources(payment);
        q.hand.splice(q.hand.indexOf(c), 1);
        this.log(`${q.name} responde con ${c.name}.`);
        this.moveToGraveyard(c, null);
        if (c.script.castOps.some((op) => op.op === 'counterSpell')) return true;
      }
    }
    return false;
  }

  async resolveSpell(p, card, targets, xValue) {
    if (card.isPermanentType) {
      // Auras: se anexan a su objetivo.
      if (card.isAura) {
        let host = targets?.[0];
        if (!host || !(host instanceof CardInstance)) {
          const own = p.creatures();
          host = own.sort((a, b) => b.power(this) - a.power(this))[0];
        }
        if (!host) { this.moveToGraveyard(card, 'sin objetivo'); return; }
        this.putOnBattlefield(card, p);
        card.attachedTo = host;
        host.attachments.push(card);
        this.log(`${card.name} encanta a ${host.name}.`);
      } else {
        this.putOnBattlefield(card, p);
        if (card.script.entersTapped) card.tapped = true;
      }
      // Escuadrón: paga el coste extra N veces para crear N copias.
      if (card.script.squad && card.isCreature) {
        let max = 0;
        while (max < 3 && solvePayment(
          { generic: card.script.squad.generic * (max + 1), pips: Array(max + 1).fill(card.script.squad.pips).flat(), x: 0 },
          manaSources(p, this))) max++;
        const times = max > 0 ? await p.controller.choosePayTimes(this, card, max, 'Escuadrón: ¿cuántas copias pagas?') : 0;
        for (let i = 0; i < times; i++) {
          const payment = solvePayment(card.script.squad, manaSources(p, this));
          if (!payment) break;
          this.paySources(payment);
          const tok = makeToken({
            name: card.data.name, pt: card.basePT(),
            colors: card.data.colors, keywords: card.data.keywords,
          }, p, this.turn);
          tok.data.typeLine = card.data.typeLine;
          tok.script = buildScript(tok.data);
          this.putOnBattlefield(tok, p);
          this.log(`Escuadrón: copia de ${card.name}.`);
        }
      }
      if (card.script.entersCounters) {
        const n = card.script.entersCounters === 'x' ? xValue : card.script.entersCounters;
        card.counters += n;
        if (n) this.log(`${card.name} entra con ${n} contador(es) +1/+1.`);
      }
      if (card.script.etb.length) await this.resolveTriggered(card, card.script.etb, 'entra al campo', xValue);
      if (card.script.unknown.length && !card.isLand) {
        this.log(`(${card.name}: parte de su texto no está simulado)`);
      }
    } else {
      await this.resolveOps(card.script.castOps, { source: card, controller: p, targets: targets.slice(), xValue });
      // Rebound: se exilia y se vuelve a lanzar gratis en tu próximo mantenimiento.
      if (card.script.rebound && !card._rebounded) {
        card._rebounded = true;
        card.zone = 'exile';
        card.owner.exile.push(card);
        (this.reboundQueue ??= []).push({ card, player: p });
        this.log(`${card.name} queda exiliado (rebote): se lanzará de nuevo gratis.`);
      } else {
        this.moveToGraveyard(card, null);
      }
    }
    this.checkState();
  }

  paySources(payment) {
    for (const src of payment) {
      if (src.delve) {
        // Delve: la carta del cementerio se exilia para pagar.
        const g = src.card.owner.graveyard;
        const i = g.indexOf(src.card);
        if (i !== -1) { g.splice(i, 1); src.card.zone = 'exile'; src.card.owner.exile.push(src.card); }
      } else if (src.perm.name === 'Treasure') this.removeFromBattlefield(src.perm, 'sacrificado');
      else src.perm.tapped = true;
    }
  }

  async activateAbility(p, perm, ability, { targets = null } = {}) {
    if (ability.fromGraveyard) {
      if (perm.zone !== 'graveyard') throw new Error('la carta no está en el cementerio');
    } else if (perm.zone !== 'battlefield') throw new Error('permanente fuera del campo');
    if (ability.tap && (perm.tapped || (perm.isCreature && perm.summoningSick && !perm.hasKeyword('haste', this)))) {
      throw new Error('no puede girarse');
    }
    const payment = solvePayment(ability.mana, manaSources(p, this), 0);
    if (!payment) throw new Error('sin maná para la habilidad');

    const targetedOps = ability.ops.filter((op) => op.targeted || op.target?.targeted);
    if (!targets && targetedOps.length) {
      targets = await this.pickTargetsFor(p, perm, targetedOps);
      if (targets === null) throw new Error('sin objetivos legales');
    }
    this.paySources(payment);
    if (ability.tap) perm.tapped = true;
    this.log(`${p.name} activa ${perm.name}.`);
    if (ability.sac) this.removeFromBattlefield(perm, 'sacrificado');
    await this.resolveOps(ability.ops, { source: perm, controller: p, targets: targets ?? [], xValue: 0 });
    this.checkState();
  }

  equip(p, equipment, creature) {
    if (!equipment.script.equipCost) throw new Error('no es equipo');
    const payment = solvePayment(equipment.script.equipCost, manaSources(p, this), 0);
    if (!payment) throw new Error('sin maná para equipar');
    this.paySources(payment);
    if (equipment.attachedTo) {
      const prev = equipment.attachedTo;
      prev.attachments.splice(prev.attachments.indexOf(equipment), 1);
    }
    equipment.attachedTo = creature;
    creature.attachments.push(equipment);
    this.log(`${p.name} equipa ${equipment.name} a ${creature.name}.`);
  }

  // ---- objetivos ---------------------------------------------------------

  legalTargets(spec, forPlayer) {
    const out = [];
    const kind = spec.kind ?? spec.target?.kind ?? 'creature';
    const controller = spec.controller ?? spec.target?.controller ?? 'any';
    const wantsPlayers = ['any', 'player', 'opponentPlayer', 'eachOpponent'].includes(kind);
    if (wantsPlayers) {
      for (const q of this.alivePlayers()) {
        if (kind === 'opponentPlayer' && q === forPlayer) continue;
        out.push(q);
      }
      if (kind !== 'any') return out;
    }
    for (const q of this.alivePlayers()) {
      if (controller === 'opponent' && q === forPlayer) continue;
      if (controller === 'you' && q !== forPlayer) continue;
      for (const c of q.battlefield) {
        if (q !== forPlayer && c.hasKeyword('hexproof', this)) continue;
        if (c.hasKeyword('shroud', this)) continue;
        if (kind === 'any' || kind === 'creature') { if (!c.isCreature) continue; }
        else if (kind === 'artifact') { if (!c.isArtifact) continue; }
        else if (kind === 'enchantment') { if (!c.isEnchantment) continue; }
        else if (kind === 'artifact-or-enchantment') { if (!c.isArtifact && !c.isEnchantment) continue; }
        else if (kind === 'planeswalker') { if (!c.isPlaneswalker) continue; }
        else if (kind === 'land') { if (!c.isLand) continue; }
        else if (kind === 'nonland-permanent') { if (c.isLand) continue; }
        else if (kind === 'permanent') { /* cualquiera */ }
        else if (kind === 'attacking-or-blocking') { if (!c.attacking && !c.blocking) continue; }
        else continue;
        if (spec.attacking && !c.attacking) continue;
        if (spec.withFlying && !c.hasKeyword('flying', this)) continue;
        if (spec.withoutFlying && c.hasKeyword('flying', this)) continue;
        if (spec.tapped && !c.tapped) continue;
        out.push(c);
      }
    }
    return out;
  }

  async pickTargetsFor(p, source, targetedOps) {
    const chosen = [];
    for (const op of targetedOps) {
      const spec = op.target ?? { kind: op.scope === 'target' ? 'creature' : 'any' };
      const candidates = this.legalTargets(spec, p);
      if (!candidates.length) return null;
      const pick = await p.controller.chooseTarget(this, source, op, candidates);
      if (!pick) return null;
      chosen.push(pick);
    }
    return chosen;
  }

  // ---- resolución de efectos --------------------------------------------

  async resolveTriggered(source, ops, label, xValue = 0) {
    const p = source.controller;
    const targetedOps = ops.filter((op) => op.targeted || op.target?.targeted);
    let targets = [];
    if (targetedOps.length) {
      targets = await this.pickTargetsFor(p, source, targetedOps);
      if (targets === null) return; // sin objetivos: no pasa nada
    }
    this.log(`Se dispara ${source.name} (${label}).`);
    await this.resolveOps(ops, { source, controller: p, targets, xValue });
    this.checkState();
  }

  num(op, ctx) { return op.n === 'x' ? ctx.xValue : op.n; }

  // Cuenta "por cada X que controlas" (o cada oponente).
  countFor(p, what) {
    if (what === 'opponent') return this.opponentsOf(p).length;
    if (what === 'creature') return p.creatures().length;
    if (what === 'land') return p.lands().length;
    if (what === 'artifact') return p.battlefield.filter((c) => c.isArtifact).length;
    if (what === 'enchantment') return p.battlefield.filter((c) => c.isEnchantment).length;
    return p.creatures().filter((c) => c.hasSubtype(what)).length;
  }

  async resolveOps(ops, ctx) {
    for (const op of ops) {
      if (this.over) return;
      const p = ctx.controller;
      const takeTarget = () => {
        const t = (op.targeted || op.target?.targeted) ? ctx.targets.shift() : null;
        if (t) ctx._lastTarget = t;
        return t;
      };
      switch (op.op) {
        case 'draw': {
          const n = this.num(op, ctx);
          if (op.who === 'each') for (const q of this.alivePlayers()) this.drawCards(q, 1);
          else if (op.who === 'target') { const t = takeTarget(); if (t instanceof Player) this.drawCards(t, n); }
          else this.drawCards(p, n);
          break;
        }
        case 'dig': {
          const cards = p.library.splice(0, Math.min(op.look, p.library.length));
          if (!cards.length) break;
          const chosen = await p.controller.chooseCards(this, cards, Math.min(op.take, cards.length),
            `Elige ${op.take} carta(s) para tu mano`);
          for (const c of chosen) { c.zone = 'hand'; p.hand.push(c); }
          const rest = cards.filter((c) => !chosen.includes(c));
          this.shuffle(rest);
          p.library.push(...rest);
          this.log(`${p.name} mira ${cards.length} carta(s) y se queda ${chosen.length}.`);
          break;
        }
        case 'digPlay': {
          const cards = p.library.splice(0, Math.min(op.look, p.library.length));
          if (!cards.length) break;
          const perms = cards.filter((c) => c.isPermanentType && !c.isLand);
          const chosen = perms.length
            ? await p.controller.chooseCards(this, perms, 1, 'Elige una carta para poner en el campo de batalla')
            : [];
          if (chosen.length) {
            this.log(`${p.name} pone ${chosen[0].name} en el campo de batalla.`);
            this.putOnBattlefield(chosen[0], p);
          }
          const rest = cards.filter((c) => c !== chosen[0]);
          this.shuffle(rest);
          p.library.push(...rest);
          break;
        }
        case 'impulse': {
          // Exilio "puedes jugarla": simplificado como robo.
          this.drawCards(p, this.num(op, ctx));
          break;
        }
        case 'monarch': {
          this.monarch = p;
          this.log(`👑 ${p.name} se convierte en el monarca.`);
          break;
        }
        case 'discardHandEach': {
          for (const q of this.alivePlayers()) {
            const n = q.hand.length;
            for (const c of [...q.hand]) this.moveToGraveyard(c, null);
            if (n) this.log(`${q.name} descarta su mano (${n}).`);
          }
          break;
        }
        case 'damage': {
          const n = this.num(op, ctx);
          const kind = op.target?.kind;
          if (kind === 'eachOpponent') for (const q of this.opponentsOf(p)) this.damagePlayer(q, n, ctx.source);
          else if (kind === 'eachPlayer') for (const q of this.alivePlayers()) this.damagePlayer(q, n, ctx.source);
          else if (kind === 'eachCreature') {
            for (const q of this.alivePlayers()) for (const c of [...q.battlefield]) {
              if (c.isCreature) this.damageCreature(c, n, ctx.source);
            }
          } else {
            const t = takeTarget();
            if (t instanceof Player) this.damagePlayer(t, n, ctx.source);
            else if (t) this.damageCreature(t, n, ctx.source);
          }
          break;
        }
        case 'destroy': {
          const t = takeTarget();
          if (t instanceof CardInstance) this.destroy(t, ctx.source);
          break;
        }
        case 'exile': {
          const t = takeTarget();
          if (t instanceof CardInstance) this.exileCard(t);
          break;
        }
        case 'wipe': {
          this.log('¡El campo de batalla queda arrasado!');
          for (const q of this.alivePlayers()) {
            for (const c of [...q.battlefield]) {
              const match =
                (op.what.includes('creature') && c.isCreature) ||
                (op.what.includes('artifact') && c.isArtifact) ||
                (op.what.includes('enchantment') && c.isEnchantment) ||
                (op.what.includes('nonland') && !c.isLand);
              if (match) op.exile ? this.exileCard(c) : this.destroy(c, ctx.source, true);
            }
          }
          break;
        }
        case 'bounce': {
          const t = takeTarget();
          if (t instanceof CardInstance) this.bounce(t);
          break;
        }
        case 'token': {
          const n = this.num(op, ctx);
          this.log(`${p.name} crea ${n} ficha(s) de ${op.name} ${op.pt[0]}/${op.pt[1]}.`);
          ctx._lastCreated = [];
          for (let i = 0; i < n; i++) {
            const tok = makeToken(op, p, this.turn);
            tok.script = buildScript(tok.data);
            this.putOnBattlefield(tok, p);
            ctx._lastCreated.push(tok);
          }
          break;
        }
        case 'sacAtEnd': {
          for (const c of ctx._lastCreated ?? []) c._sacAtEnd = true;
          break;
        }
        case 'goad': {
          const t = takeTarget();
          if (t instanceof CardInstance) {
            t._goadedBy = p;
            t._goadedUntil = this.turn + this.alivePlayers().length;
            this.log(`${t.name} queda incitada: debe atacar a otro jugador.`);
          }
          break;
        }
        case 'treasure': {
          const n = this.num(op, ctx);
          for (let i = 0; i < n; i++) {
            const tok = makeToken({ name: 'Treasure', pt: [0, 0], types: 'Artifact', producedMana: ['W', 'U', 'B', 'R', 'G'] }, p, this.turn);
            tok.script = buildScript(tok.data);
            p.battlefield.push(tok);
          }
          this.log(`${p.name} crea ${n} Tesoro(s).`);
          break;
        }
        case 'ramp': {
          let found = 0;
          for (let i = 0; i < op.n; i++) {
            const idx = p.library.findIndex((c) => c.hasType('Basic') && c.isLand);
            if (idx === -1) break;
            const land = p.library.splice(idx, 1)[0];
            this.putOnBattlefield(land, p);
            land.tapped = op.tapped !== false;
            found++;
          }
          if (found) { this.shuffle(p.library); this.log(`${p.name} pone ${found} tierra(s) básica(s) en juego.`); }
          break;
        }
        case 'landToHand': {
          const idx = p.library.findIndex((c) => c.hasType('Basic') && c.isLand);
          if (idx !== -1) {
            const land = p.library.splice(idx, 1)[0];
            land.zone = 'hand';
            p.hand.push(land);
            this.shuffle(p.library);
            this.log(`${p.name} busca una tierra básica a su mano.`);
          }
          break;
        }
        case 'pump': {
          const pt = op.pt; const kws = op.keywords || [];
          const apply = (c) => {
            c.tempPT = [c.tempPT[0] + pt[0], c.tempPT[1] + pt[1]];
            for (const k of kws) c.tempKeywords.add(k);
          };
          if (op.scope === 'target') { const t = takeTarget(); if (t instanceof CardInstance) apply(t); }
          else if (op.scope === 'self' && ctx.source.zone === 'battlefield') apply(ctx.source);
          else if (op.scope === 'yours') for (const c of p.creatures()) apply(c);
          break;
        }
        case 'gainLife': {
          const n = this.num(op, ctx);
          p.life += n;
          this.log(`${p.name} gana ${n} vidas (${p.life}).`);
          break;
        }
        case 'gainLifePerOpp': {
          const n = op.n * this.opponentsOf(p).length;
          p.life += n;
          this.log(`${p.name} gana ${n} vidas (${p.life}).`);
          break;
        }
        case 'loseLife': {
          if (op.who === 'you') {
            p.life -= op.n;
            this.log(`${p.name} pierde ${op.n} vidas (${p.life}).`);
          } else if (op.who === 'eachOpponent') {
            for (const q of this.opponentsOf(p)) { q.life -= op.n; this.log(`${q.name} pierde ${op.n} vidas (${q.life}).`); }
          } else {
            const t = takeTarget();
            if (t instanceof Player) { t.life -= op.n; this.log(`${t.name} pierde ${op.n} vidas (${t.life}).`); }
          }
          break;
        }
        case 'counters': {
          const n = this.num(op, ctx);
          if (op.scope === 'target') { const t = takeTarget(); if (t instanceof CardInstance) t.counters += n; }
          else if (op.scope === 'yours') for (const c of p.creatures()) c.counters += n;
          else if (ctx.source.zone === 'battlefield') ctx.source.counters += n;
          break;
        }
        case 'scry': {
          const n = Math.min(op.n, p.library.length);
          if (!n) break;
          const cards = p.library.splice(0, n);
          const { top, bottom } = await p.controller.scryDecision(this, cards);
          p.library.unshift(...top);
          p.library.push(...bottom);
          this.log(`${p.name} adivina ${n}.`);
          break;
        }
        case 'mill': {
          const doMill = (q) => {
            const cards = q.library.splice(0, op.n);
            for (const c of cards) { c.zone = 'graveyard'; q.graveyard.push(c); }
            this.log(`${q.name} muele ${cards.length} carta(s).`);
          };
          if (op.who === 'eachOpponent') for (const q of this.opponentsOf(p)) doMill(q);
          else { const t = takeTarget(); if (t instanceof Player) doMill(t); }
          break;
        }
        case 'discard': {
          const doDiscard = async (q) => {
            const picked = await q.controller.discardTo(this, Math.min(op.n, q.hand.length));
            for (const c of picked) this.moveToGraveyard(c, 'descarta');
          };
          if (op.who === 'you') await doDiscard(p);
          else if (op.who === 'eachOpponent') for (const q of this.opponentsOf(p)) await doDiscard(q);
          else { const t = takeTarget(); if (t instanceof Player) await doDiscard(t); }
          break;
        }
        case 'tap': {
          const t = takeTarget();
          if (t instanceof CardInstance) { t.tapped = true; this.log(`${t.name} se gira.`); }
          break;
        }
        case 'untapSelf': ctx.source.tapped = false; break;
        case 'untapLast': {
          const t = ctx._lastTarget;
          if (t instanceof CardInstance && t.zone === 'battlefield') { t.tapped = false; this.log(`${t.name} se endereza.`); }
          break;
        }
        case 'landFromHand': {
          const land = p.hand.filter((c) => c.isLand)
            .sort((a, b) => (b.data.producedMana?.length ?? 0) - (a.data.producedMana?.length ?? 0))[0];
          if (land) {
            p.hand.splice(p.hand.indexOf(land), 1);
            this.putOnBattlefield(land, p);
            if (op.tapped) land.tapped = true;
            this.log(`${p.name} pone ${land.name} en juego desde su mano.`);
          }
          break;
        }
        case 'extraLandTurn': {
          p.landsPlayedThisTurn = Math.max(0, p.landsPlayedThisTurn - 1);
          this.log(`${p.name} puede jugar una tierra adicional este turno.`);
          break;
        }
        case 'topFilter': {
          const top = p.library[0];
          if (!top) break;
          if (top.hasType(op.type) || top.hasSubtype(op.type)) {
            p.library.shift();
            top.zone = 'hand';
            p.hand.push(top);
            this.log(`${p.name} revela ${top.name} y la pone en su mano.`);
          } else {
            this.log(`${p.name} revela ${top.name}: se queda arriba.`);
          }
          break;
        }
        case 'regrow': {
          const matches = p.graveyard.filter((c) => c.isCreature).slice(-op.n);
          for (const c of matches) {
            p.graveyard.splice(p.graveyard.indexOf(c), 1);
            c.zone = 'hand'; p.hand.push(c);
            this.log(`${p.name} devuelve ${c.name} a su mano.`);
          }
          break;
        }
        case 'reanimateAny': {
          let best = null;
          for (const q of this.alivePlayers()) {
            for (const c of q.graveyard) {
              if (c.isCreature && (!best || c.cmc > best.cmc)) best = c;
            }
          }
          if (best) {
            best.owner.graveyard.splice(best.owner.graveyard.indexOf(best), 1);
            this.putOnBattlefield(best, p);
            this.log(`${p.name} pone ${best.name} en el campo de batalla desde un cementerio.`);
          }
          break;
        }
        case 'reanimate': {
          const best = p.graveyard.filter((c) => c.isCreature).sort((a, b) => b.cmc - a.cmc)[0];
          if (best) {
            p.graveyard.splice(p.graveyard.indexOf(best), 1);
            this.putOnBattlefield(best, p);
            this.log(`${p.name} regresa ${best.name} al campo de batalla.`);
          }
          break;
        }
        case 'support': {
          // Reparte contadores +1/+1 entre hasta N criaturas objetivo distintas.
          const chosen = new Set();
          for (let i = 0; i < op.n; i++) {
            const candidates = this.legalTargets({ kind: 'creature' }, p)
              .filter((c) => c !== ctx.source && !chosen.has(c));
            if (!candidates.length) break;
            const pick = await p.controller.chooseTarget(this, ctx.source, op, candidates);
            if (!pick || pick instanceof Player) break;
            chosen.add(pick);
            pick.counters += 1;
            this.log(`${pick.name} recibe un contador +1/+1.`);
          }
          break;
        }
        case 'distribute': {
          for (let i = 0; i < op.n; i++) {
            const candidates = this.legalTargets({ kind: 'creature', controller: 'you' }, p);
            if (!candidates.length) break;
            const pick = await p.controller.chooseTarget(this, ctx.source, op, candidates);
            if (!pick || pick instanceof Player) break;
            pick.counters += 1;
            this.log(`${pick.name} recibe un contador +1/+1.`);
          }
          break;
        }
        case 'proliferate': {
          let hits = 0;
          for (const c of p.battlefield) {
            if (c.counters > 0) { c.counters += 1; hits++; }
          }
          this.log(`${p.name} prolifera (${hits} permanente(s)).`);
          break;
        }
        case 'tokenSpecial': {
          const n = this.num(op, ctx);
          const SPECS = {
            Treasure: { text: '', producedMana: ['W', 'U', 'B', 'R', 'G'] },
            Clue: { text: '{2}, sacrifice ~: draw a card.' },
            Food: { text: '{2}, {t}, sacrifice ~: you gain 3 life.' },
            Blood: { text: '{1}, {t}, sacrifice ~: draw a card.' },
          };
          const spec = SPECS[op.kind] ?? { text: '' };
          for (let i = 0; i < n; i++) {
            const tok = makeToken({ name: op.kind, pt: [0, 0], types: 'Artifact', producedMana: spec.producedMana ?? null }, p, this.turn);
            tok.data.oracleText = spec.text;
            tok.script = buildScript(tok.data);
            this.putOnBattlefield(tok, p);
          }
          this.log(`${p.name} crea ${n} ficha(s) de ${op.kind}.`);
          break;
        }
        case 'explore': {
          if (!p.library.length) break;
          const top = p.library[0];
          if (top.isLand) {
            p.library.shift();
            top.zone = 'hand';
            p.hand.push(top);
            this.log(`${ctx.source.name} explora: ${top.name} va a la mano.`);
          } else if (ctx.source.zone === 'battlefield') {
            ctx.source.counters += 1;
            this.log(`${ctx.source.name} explora: recibe un contador +1/+1.`);
          }
          break;
        }
        case 'amass': {
          let army = p.creatures().find((c) => c.hasSubtype('Army'));
          if (!army) {
            army = makeToken({ name: 'Zombie Army', pt: [0, 0], colors: ['B'] }, p, this.turn);
            army.data.typeLine = 'Token Creature — Zombie Army';
            army.script = buildScript(army.data);
            this.putOnBattlefield(army, p);
            this.log(`${p.name} crea una ficha de Ejército zombie.`);
          }
          army.counters += op.n;
          this.log(`Ejército: +${op.n} contadores (${army.power(this)}/${army.toughness(this)}).`);
          break;
        }
        case 'populate': {
          const tokens = p.creatures().filter((c) => c.isToken);
          if (!tokens.length) break;
          const best = tokens.sort((a, b) => b.power(this) - a.power(this))[0];
          const copy = makeToken({
            name: best.data.name, pt: best.basePT(),
            colors: best.data.colors, keywords: best.data.keywords,
          }, p, this.turn);
          copy.data.typeLine = best.data.typeLine;
          copy.script = buildScript(copy.data);
          this.putOnBattlefield(copy, p);
          this.log(`${p.name} puebla: copia de ${best.name}.`);
          break;
        }
        case 'fight': {
          const t = takeTarget();
          if (t instanceof CardInstance && ctx.source.zone === 'battlefield') {
            this.log(`${ctx.source.name} lucha contra ${t.name}.`);
            const sp = ctx.source.power(this);
            this.damageCreature(t, sp, ctx.source);
            this.damageCreature(ctx.source, t.power(this), t);
          }
          break;
        }
        case 'fightSel': {
          const t = takeTarget();
          if (t instanceof CardInstance) ctx._fighter = t;
          break;
        }
        case 'fightVs': {
          const t = takeTarget();
          const f = ctx._fighter;
          if (t instanceof CardInstance && f && f.zone === 'battlefield') {
            this.log(`${f.name} lucha contra ${t.name}.`);
            const fp = f.power(this);
            this.damageCreature(t, fp, f);
            this.damageCreature(f, t.power(this), t);
          }
          break;
        }
        case 'pounce': {
          const t = takeTarget();
          if (t instanceof CardInstance && ctx.source.zone === 'battlefield') {
            this.damageCreature(t, ctx.source.power(this), ctx.source);
          }
          break;
        }
        case 'drawPer': {
          const n = this.countFor(p, op.what);
          if (n > 0) this.drawCards(p, n);
          break;
        }
        case 'gainLifePer': {
          const n = op.n * this.countFor(p, op.what);
          if (n > 0) { p.life += n; this.log(`${p.name} gana ${n} vidas (${p.life}).`); }
          break;
        }
        case 'selfToHand': {
          const c = ctx.source;
          if (c.zone === 'battlefield') this.bounce(c);
          else if (c.zone === 'graveyard') {
            const g = c.owner.graveyard;
            g.splice(g.indexOf(c), 1);
            c.zone = 'hand'; c.owner.hand.push(c);
            this.log(`${c.name} vuelve a la mano de ${c.owner.name}.`);
          }
          break;
        }
        case 'gyToHand': {
          const c = ctx.source;
          const g = c.owner.graveyard;
          if (g.includes(c)) {
            g.splice(g.indexOf(c), 1);
            c.zone = 'hand'; c.owner.hand.push(c);
            this.log(`${c.owner.name} devuelve ${c.name} del cementerio a su mano.`);
          }
          break;
        }
        case 'gyToBattlefield': {
          const c = ctx.source;
          const g = c.owner.graveyard;
          if (g.includes(c)) {
            g.splice(g.indexOf(c), 1);
            this.putOnBattlefield(c, p);
            if (op.tapped) c.tapped = true;
            this.log(`${c.name} vuelve del cementerio al campo de batalla.`);
          }
          break;
        }
        case 'energy': {
          p.energy += op.n;
          this.log(`${p.name} obtiene ${op.n} de energía (⚡${p.energy}).`);
          break;
        }
        case 'energyPay': {
          if (p.energy >= op.n) {
            p.energy -= op.n;
            this.log(`${p.name} paga ${op.n} de energía (⚡${p.energy}).`);
            await this.resolveOps(op.ops, ctx);
          }
          break;
        }
        case 'manaPay': {
          const cost = { generic: op.n, pips: [], x: 0 };
          const payment = solvePayment(cost, manaSources(p, this));
          if (payment) {
            this.paySources(payment);
            this.log(`${p.name} paga {${op.n}}.`);
            await this.resolveOps(op.ops, ctx);
          }
          break;
        }
        case 'lootDiscard': {
          if (!p.hand.length) break;
          const picked = await p.controller.discardTo(this, 1);
          for (const c of picked) this.moveToGraveyard(c, 'descarta');
          if (picked.length) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'coin': {
          const win = this.rng() < 0.5;
          this.log(`${p.name} lanza una moneda: ${win ? 'gana' : 'pierde'}.`);
          await this.resolveOps(win ? op.win : op.lose, ctx);
          break;
        }
        case 'counterSpell': break; // se maneja en responseWindow
        default: break;
      }
    }
  }

  // ---- daño, muertes y zonas ---------------------------------------------

  damagePlayer(q, n, source) {
    if (!q.alive || n <= 0) return;
    q.life -= n;
    this.log(`${source?.name ?? 'Efecto'} hace ${n} de daño a ${q.name} (${q.life}).`);
    if (source?.isCommander) {
      // solo daño de combate cuenta; se controla en combate
    }
    if (source && source.isCreature && source.hasKeyword('lifelink', this)) {
      source.controller.life += n;
    }
    this.checkState();
  }

  damageCreature(c, n, source) {
    if (n <= 0 || c.zone !== 'battlefield') return;
    if (c.hasKeyword('indestructible', this)) {
      if (source && source.isCreature === false) return;
    }
    // Infectar: el daño a criaturas son contadores -1/-1.
    if (source && (source.data?.keywords || []).includes('Infect')) {
      c.counters -= n;
      if (source.isCreature && source.hasKeyword('lifelink', this)) source.controller.life += n;
      this.checkState();
      return;
    }
    c.damage += n;
    if (source && source.isCreature && source.hasKeyword('lifelink', this)) source.controller.life += n;
    const lethal = source && (source.hasKeyword?.('deathtouch', this));
    if (c.damage >= c.toughness(this) || (lethal && n > 0)) {
      if (!c.hasKeyword('indestructible', this)) this.destroy(c, source, true);
    }
  }

  destroy(c, source, fromDamage = false) {
    if (c.zone !== 'battlefield') return;
    if (c.hasKeyword('indestructible', this) ) return;
    this.removeFromBattlefield(c, 'muere');
  }

  exileCard(c) {
    this.detachAll(c);
    const p = c.controller;
    p.battlefield.splice(p.battlefield.indexOf(c), 1);
    if (c.isCommander) {
      c.zone = 'command'; c.owner.command.push(c);
      this.log(`${c.name} vuelve a la zona de mando.`);
    } else if (!c.isToken) {
      c.zone = 'exile'; c.owner.exile.push(c);
      this.log(`${c.name} es exiliado.`);
    }
  }

  bounce(c) {
    if (c.zone !== 'battlefield') return;
    this.detachAll(c);
    const p = c.controller;
    p.battlefield.splice(p.battlefield.indexOf(c), 1);
    if (c.isToken) { this.log(`La ficha ${c.name} desaparece.`); return; }
    if (c.isCommander) { c.zone = 'command'; c.owner.command.push(c); this.log(`${c.name} vuelve a la zona de mando.`); return; }
    c.zone = 'hand'; c.owner.hand.push(c);
    this.log(`${c.name} vuelve a la mano de ${c.owner.name}.`);
  }

  detachAll(c) {
    for (const att of [...c.attachments]) {
      att.attachedTo = null;
      c.attachments.splice(c.attachments.indexOf(att), 1);
    }
    if (c.attachedTo) {
      c.attachedTo.attachments.splice(c.attachedTo.attachments.indexOf(c), 1);
      c.attachedTo = null;
    }
  }

  // Disparos "otra criatura (tuya) muere".
  fireAllyDies(dead, controller) {
    for (const q of this.alivePlayers()) {
      for (const perm of [...q.battlefield]) {
        for (const tr of perm.script?.allyDies || []) {
          if (perm === dead && !tr.includeSelf) continue;
          if (tr.yoursOnly && controller !== q) continue;
          if (tr.subtype && !dead.hasSubtype(tr.subtype)) continue;
          this.log(`Se dispara ${perm.name} (muere ${dead.name}).`);
          this.resolveOpsSync(tr.ops, { source: perm, controller: q, targets: [], xValue: 0 });
        }
      }
    }
  }

  removeFromBattlefield(c, verb) {
    if (c.zone !== 'battlefield') return;
    this.detachAll(c);
    const p = c.controller;
    p.battlefield.splice(p.battlefield.indexOf(c), 1);
    if (c.isCreature && (verb === 'muere' || verb === 'sacrificado')) this.fireAllyDies(c, p);
    if (c.isCommander) {
      c.zone = 'command'; c.damage = 0; c.owner.command.push(c);
      this.log(`${c.name} ${verb}: vuelve a la zona de mando.`);
      return;
    }
    // Undying / Persist: vuelven al campo con un contador si no tenían.
    if (verb === 'muere' && c.isCreature && c.counters === 0 && !c.isToken) {
      const kws = c.data.keywords || [];
      if (kws.includes('Undying') || kws.includes('Persist')) {
        const undying = kws.includes('Undying');
        c.damage = 0;
        c.cleanupEndOfTurn();
        this.putOnBattlefield(c, c.owner);
        c.counters = undying ? 1 : -1;
        this.log(`${c.name} regresa con un contador ${undying ? '+1/+1' : '-1/-1'}.`);
        return;
      }
    }
    if (c.isToken) { this.log(`La ficha ${c.name} ${verb}.`); return; }
    c.zone = 'graveyard';
    c.damage = 0; c.counters = 0; c.cleanupEndOfTurn?.();
    c.owner.graveyard.push(c);
    this.log(`${c.name} ${verb}.`);
    if (c.script.dies.length && c.isCreature) {
      this._pendingDies = this._pendingDies || [];
      this._pendingDies.push(c);
    }
  }

  moveToGraveyard(c, verb) {
    if (c.zone === 'battlefield') return this.removeFromBattlefield(c, verb ?? 'muere');
    const holder = c.zone === 'hand' ? c.owner.hand : null;
    if (holder) holder.splice(holder.indexOf(c), 1);
    if (c.isCommander) { c.zone = 'command'; c.owner.command.push(c); return; }
    c.zone = 'graveyard';
    c.owner.graveyard.push(c);
    if (verb) this.log(`${c.owner.name} ${verb} ${c.name}.`);
  }

  putOnBattlefield(card, p) {
    card.zone = 'battlefield';
    card.controller = p;
    card.tapped = false;
    card.damage = 0;
    card.summoningSick = card.isCreature || card.isVehicle;
    card.enteredTurn = this.turn;
    p.battlefield.push(card);
    this.fireEnterTriggers(card, p);
  }

  // Disparos por la entrada de una criatura: "otra criatura/tribu tuya entra" y evolucionar.
  fireEnterTriggers(card, p) {
    if (!card.isCreature) return;
    this._etbDepth = (this._etbDepth || 0) + 1;
    if (this._etbDepth > 5) { this._etbDepth--; return; } // corta bucles de fichas
    for (const perm of [...p.battlefield]) {
      for (const tr of perm.script?.allyEtb || []) {
        if (card === perm && !tr.includeSelf) continue;
        if (tr.subtype && !card.hasSubtype(tr.subtype)) continue;
        this.log(`Se dispara ${perm.name} (entra ${card.name}).`);
        this.resolveOpsSync(tr.ops, { source: perm, controller: p, targets: [], xValue: 0 });
      }
      if (perm !== card && perm.isCreature && (perm.data.keywords || []).includes('Evolve') &&
          (card.power(this) > perm.power(this) || card.toughness(this) > perm.toughness(this))) {
        perm.counters += 1;
        this.log(`${perm.name} evoluciona (+1/+1).`);
      }
    }
    this._etbDepth--;
  }

  drawCards(p, n) {
    for (let i = 0; i < n; i++) {
      if (!p.library.length) {
        this.eliminate(p, 'se queda sin cartas para robar');
        return;
      }
      const c = p.library.shift();
      c.zone = 'hand';
      p.hand.push(c);
    }
    if (n > 0) this.log(`${p.name} roba ${n} carta(s).`);
  }

  // ---- bonos estáticos (anthems) ----------------------------------------

  staticBonusesFor(card) {
    if (card.zone !== 'battlefield' || !card.isCreature) return [];
    const out = [];
    const p = card.controller;
    for (const perm of p.battlefield) {
      for (const st of perm.script?.statics || []) {
        if (st.other && perm === card) continue;
        if (st.subtype && !card.hasSubtype(st.subtype) && !(st.subtype === 'token' && card.isToken)) continue;
        out.push({ pt: st.pt, keywords: st.keywords });
      }
    }
    return out;
  }

  // ---- combate -----------------------------------------------------------

  async combatPhase(attackerP) {
    // "Al comienzo del combate en tu turno" (con condiciones comunes).
    for (const c of [...attackerP.battlefield]) {
      for (const tr of c.script?.beginCombat || []) {
        if (tr.cond === 'noncreature' && !attackerP.castNoncreatureThisTurn) continue;
        if (tr.cond === 'commander' && !attackerP.battlefield.some((x) => x.isCommander)) continue;
        this.log(`Se dispara ${c.name} (inicio de combate).`);
        this.resolveOpsSync(tr.ops, { source: c, controller: attackerP, targets: [], xValue: 0 });
      }
    }
    if (this.over) return;

    const decls = await attackerP.controller.declareAttackers(this);
    if (!decls || !decls.length) return;

    const valid = decls.filter((d) => d.attacker.canAttack(this) && d.defender.alive && d.defender !== attackerP);
    if (!valid.length) return;
    for (const { attacker, defender } of valid) {
      attacker.attacking = defender;
      if (!attacker.hasKeyword('vigilance', this)) attacker.tapped = true;
    }
    // Miríada: copias atacando a cada otro oponente.
    for (const d of [...valid]) {
      if (!(d.attacker.data.keywords || []).includes('Myriad')) continue;
      for (const q of this.opponentsOf(attackerP)) {
        if (q === d.defender) continue;
        const tok = makeToken({
          name: d.attacker.data.name, pt: d.attacker.basePT(),
          colors: d.attacker.data.colors, keywords: d.attacker.data.keywords,
        }, attackerP, this.turn);
        tok.data.typeLine = d.attacker.data.typeLine;
        tok.script = buildScript(tok.data);
        this.putOnBattlefield(tok, attackerP);
        tok.summoningSick = false;
        tok.tapped = true;
        tok.attacking = q;
        tok._myriad = true;
        valid.push({ attacker: tok, defender: q });
        this.log(`Miríada: copia de ${d.attacker.name} ataca a ${q.name}.`);
      }
    }
    const byDefender = new Map();
    for (const d of valid) {
      if (!byDefender.has(d.defender)) byDefender.set(d.defender, []);
      byDefender.get(d.defender).push(d.attacker);
    }
    for (const [def, atks] of byDefender) {
      this.log(`${attackerP.name} ataca a ${def.name} con ${atks.map((a) => `${a.name} (${a.power(this)}/${a.toughness(this)})`).join(', ')}.`);
    }

    // Melee: +1/+1 por cada oponente distinto atacado.
    const distinctDefenders = new Set(valid.map((d) => d.defender)).size;
    for (const { attacker } of valid) {
      if ((attacker.data.keywords || []).includes('Melee')) {
        attacker.tempPT = [attacker.tempPT[0] + distinctDefenders, attacker.tempPT[1] + distinctDefenders];
        this.log(`${attacker.name} recibe +${distinctDefenders}/+${distinctDefenders} (cuerpo a cuerpo).`);
      }
    }

    // Disparos de ataque.
    for (const { attacker } of valid) {
      if (attacker.script.attack.length && attacker.zone === 'battlefield') {
        await this.resolveTriggered(attacker, attacker.script.attack, 'ataca');
      }
    }
    if (this.over) return;

    // Ventana de instantáneos para cada defensor.
    for (const def of byDefender.keys()) {
      if (!def.alive) continue;
      await this.instantWindow(def);
      if (this.over) return;
    }

    // Bloqueos.
    const blocks = new Map(); // attacker -> [blockers]
    for (const [def, atks] of byDefender) {
      if (!def.alive) continue;
      const alive = atks.filter((a) => a.zone === 'battlefield' && a.attacking === def);
      if (!alive.length) continue;
      const decl = (await def.controller.declareBlockers(this, alive)) || [];
      for (const { blocker, attacker } of decl) {
        if (!blocker.canBlock(attacker, this) || blocker.controller !== def) continue;
        blocker.blocking = attacker;
        if (!blocks.has(attacker)) blocks.set(attacker, []);
        blocks.get(attacker).push(blocker);
      }
    }
    // Menace: necesita 2+ bloqueadores.
    for (const [atk, blkrs] of [...blocks]) {
      if (atk.hasKeyword('menace', this) && blkrs.length < 2) {
        for (const b of blkrs) b.blocking = null;
        blocks.delete(atk);
      }
    }
    for (const [atk, blkrs] of blocks) {
      this.log(`${blkrs.map((b) => `${b.name} (${b.power(this)}/${b.toughness(this)})`).join(' y ')} bloquea(n) a ${atk.name}.`);
    }

    // Daño (con primer golpe).
    const strikers = (phase) => valid
      .map((d) => d.attacker)
      .filter((a) => a.zone === 'battlefield' && a.attacking)
      .filter((a) => {
        const fs = a.hasKeyword('first strike', this); const ds = a.hasKeyword('double strike', this);
        return phase === 'first' ? (fs || ds) : (!fs || ds);
      });

    const dealCombat = (phase) => {
      for (const atk of strikers(phase)) {
        const blkrs = (blocks.get(atk) || []).filter((b) => b.zone === 'battlefield');
        this.combatDamageFromAttacker(atk, blkrs);
      }
      // Bloqueadores devuelven daño.
      for (const [atk, blkrs] of blocks) {
        for (const b of blkrs.filter((x) => x.zone === 'battlefield')) {
          const fs = b.hasKeyword('first strike', this); const ds = b.hasKeyword('double strike', this);
          const inPhase = phase === 'first' ? (fs || ds) : (!fs || ds);
          if (!inPhase || atk.zone !== 'battlefield') continue;
          this.damageCreature(atk, b.power(this), b);
        }
      }
      this.processDies();
    };

    dealCombat('first');
    if (!this.over) dealCombat('normal');
    this.checkState();
    for (const q of this.players) {
      for (const c of [...q.battlefield]) {
        c.attacking = null; c.blocking = null;
        if (c._myriad) this.removeFromBattlefield(c, 'se exilia (miríada)');
      }
    }
  }

  combatDamageFromAttacker(atk, blkrs) {
    const def = atk.attacking;
    if (!def || !def.alive) return;
    let power = atk.power(this);
    const infect = (atk.data.keywords || []).includes('Infect');
    if (!blkrs.length) {
      if (infect) {
        def.poison += power;
        this.log(`${atk.name} infecta a ${def.name} (☠${def.poison}/10).`);
      } else {
        def.life -= power;
        this.log(`${atk.name} golpea a ${def.name} por ${power} (${def.life}).`);
        if (atk.script?.toxic) {
          def.poison += atk.script.toxic;
          this.log(`${def.name} recibe ${atk.script.toxic} contador(es) de veneno (☠${def.poison}/10).`);
        }
      }
      if (atk.hasKeyword('lifelink', this)) atk.controller.life += power;
      if (atk.isCommander) {
        const dmg = (def.commanderDamage.get(atk.id) || 0) + power;
        def.commanderDamage.set(atk.id, dmg);
        if (dmg >= 21) this.eliminate(def, `recibe 21+ de daño de comandante de ${atk.name}`);
      }
      if (power > 0) this.fireCombatHit(atk);
      this.checkState();
      return;
    }
    const deathtouch = atk.hasKeyword('deathtouch', this);
    const trample = atk.hasKeyword('trample', this);
    for (const b of blkrs) {
      if (power <= 0) break;
      const need = deathtouch ? 1 : Math.max(1, b.toughness(this) - b.damage);
      const assign = Math.min(power, need);
      power -= assign;
      this.damageCreature(b, assign, atk);
    }
    if (trample && power > 0) {
      if (infect) {
        def.poison += power;
        this.log(`${atk.name} infecta a ${def.name} (☠${def.poison}/10).`);
      } else {
        def.life -= power;
        this.log(`${atk.name} arrolla a ${def.name} por ${power} (${def.life}).`);
      }
      if (atk.hasKeyword('lifelink', this)) atk.controller.life += power;
      if (atk.isCommander) {
        const dmg = (def.commanderDamage.get(atk.id) || 0) + power;
        def.commanderDamage.set(atk.id, dmg);
        if (dmg >= 21) this.eliminate(def, `recibe 21+ de daño de comandante de ${atk.name}`);
      }
      this.fireCombatHit(atk);
    }
    this.checkState();
  }

  // Disparos "hace daño de combate a un jugador".
  fireCombatHit(atk) {
    const def = atk.attacking;
    if (def && this.monarch === def) {
      this.monarch = atk.controller;
      this.log(`👑 ${atk.controller.name} le roba la corona a ${def.name}.`);
    }
    const p = atk.controller;
    for (const perm of [...p.battlefield]) {
      for (const tr of perm.script?.combatHit || []) {
        if (tr.scope === 'self' && perm !== atk) continue;
        if (tr.subtype && !atk.hasSubtype(tr.subtype)) continue;
        const source = tr.scope === 'self' ? perm : atk;
        this.resolveOpsSync(tr.ops, { source, controller: p, targets: [], xValue: 0 });
      }
    }
  }

  async instantWindow(p) {
    let guard = 0;
    while (guard++ < 10) {
      const action = await p.controller.combatInstant(this);
      if (!action) return;
      try {
        await this.castSpell(p, action.card, action);
      } catch (err) {
        this.log(`(!) ${p.name}: ${err.message}`);
        return;
      }
      if (this.over) return;
    }
  }

  processDies() {
    const pending = this._pendingDies || [];
    this._pendingDies = [];
    for (const c of pending) {
      // Disparo de muerte (sin objetivos: solo efectos automáticos).
      this.resolveOpsSync(c.script.dies, { source: c, controller: c.controller, targets: [], xValue: 0 });
    }
  }

  // Versión síncrona para disparos de muerte simples (sin decisiones interactivas).
  resolveOpsSync(ops, ctx) {
    const interactive = new Set(['scry', 'discard', 'support', 'distribute', 'dig', 'digPlay', 'lootDiscard']);
    const safe = ops.filter((op) => !op.targeted && !op.target?.targeted && !interactive.has(op.op));
    if (safe.length) this.resolveOps(safe, ctx);
  }

  // ---- estado ------------------------------------------------------------

  checkState() {
    if (this.over) return;
    // Criaturas con resistencia <= 0.
    for (const q of this.players) {
      for (const c of [...q.battlefield]) {
        if (c.isCreature && c.toughness(this) <= 0) this.removeFromBattlefield(c, 'muere');
        else if (c.isCreature && c.damage >= c.toughness(this) && c.damage > 0 && !c.hasKeyword('indestructible', this)) {
          this.removeFromBattlefield(c, 'muere');
        }
        // Auras/equipos huérfanos.
        if ((c.isAura || c.isEquipment) && c.attachedTo && c.attachedTo.zone !== 'battlefield') {
          this.detachAll(c);
          if (c.isAura) this.removeFromBattlefield(c, 'va al cementerio');
        }
      }
    }
    this.processDies();
    // Jugadores muertos.
    for (const q of this.players) {
      if (q.alive && q.life <= 0) this.eliminate(q, 'se queda sin vidas');
      else if (q.alive && q.poison >= 10) this.eliminate(q, 'sucumbe al veneno');
    }
  }

  eliminate(q, reason) {
    if (!q.alive || this.over) return;
    q.lost = true;
    q.lossReason = reason;
    if (this.monarch === q) this.monarch = null;
    this.log(`☠ ${q.name} ${reason}. ¡Eliminado!`);
    for (const c of [...q.battlefield]) {
      this.detachAll(c);
      q.battlefield.splice(q.battlefield.indexOf(c), 1);
    }
    const alive = this.alivePlayers();
    if (alive.length === 1) {
      this.winner = alive[0];
      this.over = true;
      this.log(`🏆 ¡${this.winner.name} gana la partida!`);
    } else if (alive.length === 0) {
      this.over = true;
      this.log('La partida termina sin ganador.');
    }
  }
}
