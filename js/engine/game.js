// Motor de partida de Commander multijugador.

import { CardInstance, makeToken, resetIds } from './cards.js';
import { buildScript, opsValue } from './effects.js';
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

    // Enderezar (los contadores de aturdir lo impiden y se consumen).
    this.phase = 'untap';
    for (const c of p.battlefield) {
      c.summoningSick = false;
      if (c.tapped && c.stunCounters > 0) {
        c.stunCounters--;
        this.log(`${c.name} sigue girada (aturdir, quedan ${c.stunCounters}).`);
        continue;
      }
      c.tapped = false;
    }

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
    // Vanishing: quita un contador de tiempo; a cero, se sacrifica.
    for (const c of [...p.battlefield]) {
      if (c._timeCounters > 0) {
        c._timeCounters--;
        this.log(`${c.name} pierde un contador de tiempo (${c._timeCounters}).`);
        if (c._timeCounters === 0) this.removeFromBattlefield(c, 'sacrificado');
      }
    }
    for (const c of [...p.battlefield]) {
      if (c.script.upkeep.length) await this.resolveTriggered(c, c.script.upkeep, 'mantenimiento');
    }
    // Sagas: siguiente capítulo; tras el último, se sacrifica.
    for (const c of [...p.battlefield]) {
      if (!c.script?.sagaMax || c._lore == null) continue;
      c._lore++;
      const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
      if (c.script.saga[c._lore]) {
        await this.resolveTriggered(c, c.script.saga[c._lore], `capítulo ${ROMAN[c._lore] ?? c._lore}`);
      }
      if (c._lore >= c.script.sagaMax && c.zone === 'battlefield') {
        this.removeFromBattlefield(c, 'se sacrifica (saga completa)');
      }
      if (this.over) return;
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

    // Robar (más "cada jugador roba una carta adicional", tipo Howling Mine).
    this.phase = 'draw';
    let extraDraws = 0;
    for (const q of this.alivePlayers()) {
      extraDraws += q.battlefield.filter((c) => c.script?.eachDrawExtra).length;
    }
    this.drawCards(p, 1 + extraDraws);
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
    // Fichas marcadas "sacrifícala/exíliala al comienzo del próximo paso final".
    for (const q of this.alivePlayers()) {
      for (const c of [...q.battlefield]) {
        if (c._sacAtEnd) this.removeFromBattlefield(c, 'sacrificado');
        else if (c._exileAtEnd) this.exileCard(c);
      }
    }
    // Cartas parpadeadas: vuelven al campo de batalla.
    for (const c of this._returnAtEnd ?? []) {
      if (c.zone !== 'exile') continue;
      const ex = c.owner.exile;
      ex.splice(ex.indexOf(c), 1);
      this.putOnBattlefield(c, c.owner);
      this.log(`${c.name} vuelve al campo de batalla.`);
    }
    this._returnAtEnd = [];
    for (const q of this.players) {
      q._countersPutThisTurn = false;
      for (const c of q.battlefield) { c.cleanupEndOfTurn(); c._counterGotThisTurn = false; }
    }
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
    const fromGY = card.zone === 'graveyard' && p.battlefield.some((c) => c.script?.landsFromGY);
    if (!card.isLand || (card.zone !== 'hand' && !fromGY)) throw new Error('no es una tierra jugable');
    if (fromGY) p.graveyard.splice(p.graveyard.indexOf(card), 1);
    else p.hand.splice(p.hand.indexOf(card), 1);
    this.putOnBattlefield(card, p);
    p.landsPlayedThisTurn++;
    this.log(`${p.name} juega ${card.name}.`);
    // Tierras que entran giradas (incondicionales o con condición evaluada).
    const tu = card.script?.tapUnless;
    if (tu) {
      let ok = false;
      if (tu.basics) ok = p.lands().filter((l) => l.hasType('Basic')).length >= tu.basics;
      else if (tu.subtypes) ok = p.lands().some((l) => tu.subtypes.some((s) => l.hasSubtype(s)));
      else if (tu.handTypes) ok = p.hand.some((c) => tu.handTypes.some((s) => c.hasSubtype(s) || c.hasType(s)));
      if (!ok) card.tapped = true;
    } else if (/enters?( the battlefield)? tapped/.test(card.oracleText.toLowerCase()) &&
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

    // "Siempre que (tú|un oponente|un jugador) lance(s) un hechizo...".
    this._castDepth = (this._castDepth || 0) + 1;
    if (this._castDepth <= 3) {
      for (const q of this.alivePlayers()) {
        for (const perm of [...q.battlefield]) {
          for (const tr of perm.script?.onCast ?? []) {
            if (tr.who === 'you' && q !== p) continue;
            if (tr.who === 'opponent' && q === p) continue;
            if (tr.filter === 'creature' && !card.isCreature) continue;
            if (tr.filter === 'noncreature' && card.isCreature) continue;
            if (tr.filter === 'instant or sorcery' && !card.isInstant && !card.isSorcery) continue;
            this.resolveOpsSync(tr.ops, { source: perm, controller: q, targets: [], xValue: 0, eventPlayer: p });
          }
        }
      }
    }
    this._castDepth--;

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
        this.gainLife(p, opps.length, true);
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
      // Auras: se anexan a su objetivo (las de control apuntan al rival).
      if (card.isAura) {
        let host = targets?.[0];
        if (!host || !(host instanceof CardInstance)) {
          const debuff = (card.script.attachPT && card.script.attachPT[0] + card.script.attachPT[1] < 0) ||
            card.script.grantsKeywords.some((k) => k.startsWith('cant'));
          const candidates = this.legalTargets({ kind: 'creature' }, p);
          if (candidates.length) {
            host = await p.controller.chooseTarget(this, card, { op: debuff ? 'destroy' : 'pump' }, candidates);
          }
        }
        if (!host || !(host instanceof CardInstance)) { this.moveToGraveyard(card, 'sin objetivo'); return; }
        this.putOnBattlefield(card, p);
        card.attachedTo = host;
        host.attachments.push(card);
        this.log(`${card.name} encanta a ${host.name}.`);
      } else {
        this.putOnBattlefield(card, p);
        if (card.script.entersTapped) card.tapped = true;
        // Arma viviente / ¡Por Mirrodin!: el equipo entra con su portador.
        const kws = card.data.keywords || [];
        if (card.isEquipment && (kws.includes('Living weapon') || kws.includes('For Mirrodin!'))) {
          const germ = kws.includes('Living weapon')
            ? makeToken({ name: 'Phyrexian Germ', pt: [0, 0], colors: ['B'] }, p, this.turn)
            : makeToken({ name: 'Rebel', pt: [2, 2], colors: ['R'] }, p, this.turn);
          germ.script = buildScript(germ.data);
          this.putOnBattlefield(germ, p);
          card.attachedTo = germ;
          germ.attachments.push(card);
          this.log(`${card.name} entra anexada a una ficha de ${germ.name}.`);
        }
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
      // Sin: absorbe los contadores de tus permanentes y entra con el doble.
      if (card.script.sinEnter) {
        let total = 0;
        for (const c of p.battlefield) {
          if (c !== card && c.counters > 0 && (c.isCreature || c.isArtifact || c.isEnchantment)) {
            total += c.counters;
            c.counters = 0;
          }
        }
        if (total) this.addCounters(card, total * 2, p);
      }
      // Clon: entra como copia de la mejor criatura en el campo.
      if (card.script.cloneEnter) {
        const all = this.alivePlayers().flatMap((q) => q.creatures()).filter((c) => c !== card);
        const best = all.sort((a, b) => b.power(this) - a.power(this))[0];
        if (best) {
          card.data = { ...best.data, nameEs: card.data.nameEs ?? best.data.nameEs, image: card.data.image, imageSmall: card.data.imageSmall };
          this.log(`${card.name} entra como copia de ${best.name}.`);
          if (card.script.cloneEnter.xCounters && xValue) this.addCounters(card, xValue, p);
        }
      }
      if (card.script.entersCounters) {
        const n = card.script.entersCounters === 'x' ? xValue : card.script.entersCounters;
        if (n) this.addCounters(card, n, p);
      }
      if (card.script.entersCountersPer) {
        const n = this.countFor(p, card.script.entersCountersPer);
        if (n) this.addCounters(card, n, p);
      }
      // Sagas: capítulo I al entrar.
      if (card.script.sagaMax) {
        card._lore = 1;
        if (card.script.saga[1]) await this.resolveTriggered(card, card.script.saga[1], 'capítulo I');
      }
      if (card.script.etb.length) await this.resolveTriggered(card, card.script.etb, 'entra al campo', xValue);
      if (card.script.unknown.length && !card.isLand) {
        this.log(`(${card.name}: parte de su texto no está simulado)`);
      }
    } else {
      await this.resolveOps(card.script.castOps, { source: card, controller: p, targets: targets.slice(), xValue });
      // "Cópialo por cada vez que hayas lanzado a tu comandante".
      if (card.script.copyPerCmdCast) {
        const copies = Math.min(5, p.command.concat(p.battlefield.filter((c) => c.isCommander))
          .reduce((n, c) => n + c.commanderCasts, 0));
        for (let i = 0; i < copies; i++) {
          this.log(`Copia ${i + 1} de ${card.name}.`);
          await this.resolveOps(card.script.castOps, { source: card, controller: p, targets: [], xValue });
        }
      }
      // Registro para efectos de copia tipo Fork (aproximados sin pila).
      this._lastSpell ??= new Map();
      this._lastSpell.set(p, card);
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
      } else if (src.perm.name === 'Treasure' || src.perm.data._sacMana) {
        this.removeFromBattlefield(src.perm, 'sacrificado');
      } else src.perm.tapped = true;
    }
  }

  async activateAbility(p, perm, ability, { targets = null } = {}) {
    if (ability.fromGraveyard) {
      if (perm.zone !== 'graveyard') throw new Error('la carta no está en el cementerio');
    } else if (perm.zone !== 'battlefield') throw new Error('permanente fuera del campo');
    if (ability.tap && (perm.tapped || (perm.isCreature && perm.summoningSick && !perm.hasKeyword('haste', this)))) {
      throw new Error('no puede girarse');
    }
    if (ability.removeCounters && perm.counters < ability.removeCounters) {
      throw new Error('sin contadores suficientes');
    }
    let anyCounterSource = null;
    if (ability.removeAnyCounter) {
      anyCounterSource = p.battlefield
        .filter((c) => !c.isLand && c.counters > 0)
        .sort((a, b) => a.counters - b.counters)[0];
      if (!anyCounterSource) throw new Error('sin contadores que quitar');
    }
    const payment = solvePayment(ability.mana, manaSources(p, this), 0);
    if (!payment) throw new Error('sin maná para la habilidad');

    const targetedOps = ability.ops.filter((op) => op.targeted || op.target?.targeted);
    if (!targets && targetedOps.length) {
      targets = await this.pickTargetsFor(p, perm, targetedOps);
      if (targets === null) throw new Error('sin objetivos legales');
    }
    // Coste adicional: sacrificar otros permanentes.
    let extraVictims = [];
    if (ability.sacExtra) {
      const match = (c) =>
        (ability.sacExtra.what.includes('creature') && c.isCreature) ||
        (ability.sacExtra.what.includes('artifact') && c.isArtifact) ||
        (ability.sacExtra.what.includes('land') && c.isLand) ||
        (ability.sacExtra.what.includes('permanent'));
      extraVictims = p.battlefield.filter((c) => c !== perm && match(c))
        .sort((a, b) => a.cmc - b.cmc)
        .slice(0, ability.sacExtra.n);
      if (extraVictims.length < ability.sacExtra.n) throw new Error('sin permanentes que sacrificar');
    }
    this.paySources(payment);
    if (ability.tap) perm.tapped = true;
    if (ability.removeCounters) perm.counters -= ability.removeCounters;
    if (anyCounterSource) {
      anyCounterSource.counters -= 1;
      this.log(`${p.name} quita un contador de ${anyCounterSource.name}.`);
    }
    this.log(`${p.name} activa ${perm.name}.`);
    for (const v of extraVictims) this.removeFromBattlefield(v, 'sacrificado');
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

  legalTargets(spec, forPlayer, source = null) {
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
        if (spec.withCounters && c.counters <= 0) continue;
        if (spec.powerLess && source && c.power(this) >= source.power(this)) continue;
        out.push(c);
      }
    }
    return out;
  }

  async pickTargetsFor(p, source, targetedOps) {
    const chosen = [];
    for (const op of targetedOps) {
      const spec = op.target ?? { kind: op.scope === 'target' ? 'creature' : 'any' };
      const candidates = this.legalTargets(spec, p, source);
      if (!candidates.length) {
        if (op.optional) { chosen.push(null); continue; }
        return null;
      }
      const pick = await p.controller.chooseTarget(this, source, op, candidates);
      if (!pick) {
        if (op.optional) { chosen.push(null); continue; }
        return null;
      }
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

  // Punto único para poner contadores +1/+1: aplica duplicadores
  // (Hardened Scales, Branching Evolution) y dispara "siempre que pongas
  // contadores sobre una criatura...".
  addCounters(card, n, putter) {
    if (n === 0 || card.zone !== 'battlefield') return;
    if (n > 0 && putter) {
      for (const perm of putter.battlefield) {
        if (perm.script?.counterMod === 'plus1') n += 1;
        else if (perm.script?.counterMod === 'double') n *= 2;
      }
    }
    card.counters += n;
    if (n > 0) this.log(`${card.name} recibe ${n} contador(es) +1/+1.`);
    else this.log(`${card.name} recibe ${-n} contador(es) -1/-1.`);
    if (n > 0) {
      if (putter) putter._countersPutThisTurn = true;
      card._counterGotThisTurn = true;
    }
    if (n > 0 && putter) {
      for (const perm of [...putter.battlefield]) {
        for (const tr of perm.script?.onCounters ?? []) {
          if (tr.scope === 'self' && perm !== card) continue;
          if (tr.scope === 'yours' && card.controller !== putter) continue;
          if (tr.scope === 'notYours' && card.controller === putter) continue;
          this.resolveOpsSync(tr.ops, { source: perm, controller: putter, targets: [], xValue: 0 });
        }
      }
    }
    this.checkState();
  }

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
        case 'wheel': {
          for (const q of this.alivePlayers()) {
            const had = q.hand.length;
            for (const c of [...q.hand]) this.moveToGraveyard(c, null);
            this.drawCards(q, op.n);
            this.log(`${q.name} descarta ${had} y roba ${op.n}.`);
            if (this.over) break;
          }
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
          if (kind === 'ctxPlayer') { if (ctx.eventPlayer) this.damagePlayer(ctx.eventPlayer, n, ctx.source); }
          else if (kind === 'eachOpponent') for (const q of this.opponentsOf(p)) this.damagePlayer(q, n, ctx.source);
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
          let n = this.num(op, ctx);
          // Duplicadores de fichas (Doubling Season, Primal Vigor...).
          if (p.battlefield.some((c) => c.script?.tokenMod === 'double')) n *= 2;
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
        case 'optSac': {
          const match = (c) =>
            (op.what.includes('creature') && c.isCreature) ||
            (op.what.includes('artifact') && c.isArtifact) ||
            (op.what.includes('land') && c.isLand) ||
            (op.what.includes('permanent'));
          const candidates = p.battlefield.filter((c) => c !== ctx.source && match(c));
          if (!candidates.length) break;
          let pick = null;
          if (p.isBot) {
            const sorted = candidates.slice().sort((a, b) => a.cmc - b.cmc);
            pick = sorted[0];
            if (pick.isCreature && pick.power(this) >= 3) pick = null; // no sacrificar cuerpos buenos
          } else {
            const chosen = await p.controller.chooseCards(this, candidates, 1,
              `¿Sacrificas un(a) ${op.what} para ${ctx.source.name}? (puedes confirmar sin elegir)`);
            pick = chosen[0] ?? null;
          }
          if (pick) {
            this.removeFromBattlefield(pick, 'sacrificado');
            await this.resolveOps(op.ops, ctx);
          }
          break;
        }
        case 'exileTop': {
          const cards = p.library.splice(0, Math.min(op.n, p.library.length));
          for (const c of cards) { c.zone = 'exile'; c.owner.exile.push(c); }
          if (cards.length) this.log(`${p.name} exilia ${cards.length} carta(s) de su biblioteca.`);
          break;
        }
        case 'sacAtEnd': {
          for (const c of ctx._lastCreated ?? []) c._sacAtEnd = true;
          break;
        }
        case 'tokensSacMana': {
          // Engendros/vástagos Eldrazi: "sacrifica ~: agrega {C}".
          for (const c of ctx._lastCreated ?? []) {
            c.data.producedMana = ['C'];
            c.data._sacMana = true;
          }
          break;
        }
        case 'damagePerEach': {
          const n = this.countFor(p, op.what);
          if (n > 0) for (const q of this.opponentsOf(p)) this.damagePlayer(q, n, ctx.source);
          break;
        }
        case 'exileAtEnd': {
          const marks = ctx._lastCreated ?? (ctx._lastTarget ? [ctx._lastTarget] : []);
          for (const c of marks) c._exileAtEnd = true;
          break;
        }
        case 'blinkReturn': {
          const t = ctx._lastTarget;
          if (t instanceof CardInstance && t.zone === 'exile') {
            (this._returnAtEnd ??= []).push(t);
            this.log(`${t.name} volverá al campo de batalla al final del turno.`);
          }
          break;
        }
        case 'eachSac': {
          const victims = op.who === 'opponent' ? this.opponentsOf(p) : this.alivePlayers();
          for (const q of victims) {
            const creatures = q.creatures();
            if (!creatures.length) continue;
            let pick = null;
            if (!q.isBot) {
              const chosen = await q.controller.chooseCards(this, creatures, 1, 'Sacrifica una criatura');
              pick = chosen[0] ?? null;
            }
            if (!pick) pick = creatures.slice().sort((a, b) => a.cmc - b.cmc)[0];
            this.removeFromBattlefield(pick, 'sacrificado');
          }
          break;
        }
        case 'gainLifeLast': {
          const t = ctx._lastTarget;
          if (t instanceof CardInstance) {
            const n = op.stat === 'toughness' ? Math.max(0, t.toughness(this)) : t.power(this);
            if (n) this.gainLife(p, n);
          }
          break;
        }
        case 'gainLifeLostWay': {
          const n = ctx._lifeLost ?? 0;
          if (n) this.gainLife(p, n);
          break;
        }
        case 'sacSelfThen': {
          if (ctx.source.zone === 'battlefield' &&
              opsValue(op.ops) >= 2 && ctx.source.power(this) < 2) {
            this.removeFromBattlefield(ctx.source, 'sacrificado');
            await this.resolveOps(op.ops, ctx);
          }
          break;
        }
        case 'tapSelfThen': {
          const s2 = ctx.source;
          if (s2.zone === 'battlefield' && !s2.tapped &&
              !(s2.isCreature && s2.summoningSick && !s2.hasKeyword('haste', this))) {
            s2.tapped = true;
            await this.resolveOps(op.ops, ctx);
          }
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
          else if (op.scope === 'last') { if (ctx._lastTarget instanceof CardInstance) apply(ctx._lastTarget); }
          else if (op.scope === 'self' && ctx.source.zone === 'battlefield') apply(ctx.source);
          else if (op.scope === 'yours') for (const c of p.creatures()) apply(c);
          break;
        }
        case 'gainLife': {
          const n = this.num(op, ctx);
          this.gainLife(p, n);
          break;
        }
        case 'gainLifePerOpp': {
          const n = op.n * this.opponentsOf(p).length;
          this.gainLife(p, n);
          break;
        }
        case 'loseLife': {
          if (op.who === 'you') {
            p.life -= op.n;
            this.log(`${p.name} pierde ${op.n} vidas (${p.life}).`);
          } else if (op.who === 'eachOpponent') {
            const opps = this.opponentsOf(p);
            ctx._lifeLost = op.n * opps.length;
            for (const q of opps) { q.life -= op.n; this.log(`${q.name} pierde ${op.n} vidas (${q.life}).`); }
          } else {
            const t = takeTarget();
            if (t instanceof Player) { t.life -= op.n; this.log(`${t.name} pierde ${op.n} vidas (${t.life}).`); }
          }
          break;
        }
        case 'counters': {
          const n = this.num(op, ctx);
          if (op.scope === 'target') { const t = takeTarget(); if (t instanceof CardInstance) this.addCounters(t, n, p); }
          else if (op.scope === 'yours') for (const c of [...p.creatures()]) this.addCounters(c, n, p);
          else if (op.scope === 'eachAll') {
            for (const q of this.alivePlayers()) for (const c of [...q.creatures()]) this.addCounters(c, n, p);
          } else if (ctx.source.zone === 'battlefield') this.addCounters(ctx.source, n, p);
          break;
        }
        case 'stun': {
          let t = op.scope === 'last' ? ctx._lastTarget : takeTarget();
          if (!(t instanceof CardInstance)) {
            const enemies = this.legalTargets({ kind: 'creature', controller: 'opponent' }, p);
            t = enemies.sort((a, b) => b.power(this) - a.power(this))[0];
          }
          if (t instanceof CardInstance) {
            t.tapped = true;
            t.stunCounters += 1;
            this.log(`${t.name} queda girada con un contador de aturdir.`);
          }
          break;
        }
        case 'shield': {
          const chosen = new Set();
          for (let i = 0; i < op.n; i++) {
            const candidates = this.legalTargets({ kind: 'creature', controller: 'you' }, p)
              .filter((c) => !chosen.has(c));
            if (!candidates.length) break;
            const pick = await p.controller.chooseTarget(this, ctx.source, { op: 'shield' }, candidates);
            if (!pick || pick instanceof Player) break;
            chosen.add(pick);
            pick.shieldCounters += 1;
            this.log(`${pick.name} recibe un contador de escudo.`);
          }
          break;
        }
        case 'moveFrom': {
          const t = takeTarget();
          if (t instanceof CardInstance && t.counters > 0) ctx._moveSrc = t;
          break;
        }
        case 'moveTo': {
          const t = takeTarget();
          const src = ctx._moveSrc;
          if (t instanceof CardInstance && src && src !== t && src.counters > 0) {
            src.counters -= 1;
            this.addCounters(t, 1, p);
            this.log(`${p.name} mueve un contador de ${src.name} a ${t.name}.`);
          }
          break;
        }
        case 'countersToBestFromSelf': {
          const n = ctx.source._lastCounters ?? 0;
          const dest = p.creatures().sort((a, b) => b.power(this) - a.power(this))[0];
          if (n > 0 && dest) this.addCounters(dest, n, p);
          break;
        }
        case 'selfToLibrary': {
          const c = ctx.source;
          if (c.zone === 'graveyard') {
            const g = c.owner.graveyard;
            g.splice(g.indexOf(c), 1);
            c.zone = 'library';
            c.owner.library.push(c);
            this.shuffle(c.owner.library);
            this.log(`${c.name} se baraja en la biblioteca de ${c.owner.name}.`);
          }
          break;
        }
        case 'reviveEventFlying': {
          const ev = ctx.eventCard;
          if (ev && ev.zone === 'graveyard') {
            const g = ev.owner.graveyard;
            g.splice(g.indexOf(ev), 1);
            this.putOnBattlefield(ev, p);
            ev.script.selfKeywords.push('flying');
            this.log(`${ev.name} regresa al campo de batalla con un contador de volar.`);
          }
          break;
        }
        case 'counterCompare': {
          const ev = ctx.eventCard;
          if (ev && ev.zone === 'battlefield' && ctx.source.zone === 'battlefield') {
            const dest = ev.power(this) < ctx.source.power(this) ? ev : ctx.source;
            this.addCounters(dest, 1, p);
          }
          break;
        }
        case 'countersEqualPower': {
          if (ctx.source.zone !== 'battlefield') break;
          const others = p.creatures().filter((c) => c !== ctx.source);
          if (!others.length) break;
          const dest = p.isBot
            ? others.sort((a, b) => b.power(this) - a.power(this))[0]
            : await p.controller.chooseTarget(this, ctx.source, { op: 'counters', n: 1 }, others);
          if (dest instanceof CardInstance) this.addCounters(dest, ctx.source.power(this), p);
          break;
        }
        case 'exileUntilLeave': {
          const t = takeTarget();
          if (t instanceof CardInstance && ctx.source.zone === 'battlefield') {
            this.exileCard(t);
            if (t.zone === 'exile') (ctx.source._exiledUntilLeave ??= []).push(t);
            this.log(`${t.name} queda exiliado mientras ${ctx.source.name} esté en el campo.`);
          }
          break;
        }
        case 'eachOppBounceBiggest': {
          for (const q of this.opponentsOf(p)) {
            const biggest = q.creatures().sort((a, b) => b.cmc - a.cmc)[0];
            if (biggest) this.bounce(biggest);
          }
          break;
        }
        case 'treasurePerOppBig': {
          const n = this.opponentsOf(p).filter((q) => q.creatures().some((c) => c.power(this) >= op.p)).length;
          for (let i = 0; i < n; i++) {
            const tok = makeToken({ name: 'Treasure', pt: [0, 0], types: 'Artifact', producedMana: ['W', 'U', 'B', 'R', 'G'] }, p, this.turn);
            tok.script = buildScript(tok.data);
            this.putOnBattlefield(tok, p);
          }
          if (n) this.log(`${p.name} crea ${n} Tesoro(s).`);
          break;
        }
        case 'plainsSearch': {
          const idx = p.library.findIndex((c) => c.isLand && c.hasSubtype('Plains'));
          if (idx === -1) break;
          const land = p.library.splice(idx, 1)[0];
          this.shuffle(p.library);
          const oppMoreLands = this.opponentsOf(p).some((q) => q.lands().length > p.lands().length);
          if (oppMoreLands) {
            this.putOnBattlefield(land, p);
            land.tapped = true;
            this.log(`${p.name} busca ${land.name} y la pone en juego girada.`);
          } else {
            land.zone = 'hand';
            p.hand.push(land);
            this.log(`${p.name} busca ${land.name} a su mano.`);
          }
          break;
        }
        case 'tuck': {
          const t = takeTarget();
          if (t instanceof CardInstance && t.zone === 'battlefield') {
            this.detachAll(t);
            const q = t.controller;
            q.battlefield.splice(q.battlefield.indexOf(t), 1);
            if (t.isCommander) { t.zone = 'command'; t.owner.command.push(t); this.log(`${t.name} vuelve a la zona de mando.`); }
            else if (t.isToken) this.log(`La ficha ${t.name} desaparece.`);
            else {
              t.zone = 'library'; t.counters = 0; t.damage = 0;
              t.owner.library.push(t);
              this.log(`${t.name} va al fondo de la biblioteca de ${t.owner.name}.`);
            }
          }
          break;
        }
        case 'damageToCounters': {
          const t = takeTarget();
          if (t instanceof CardInstance) {
            t._damageToCounters = true;
            this.log(`${t.name}: el daño de este turno se convierte en contadores +1/+1.`);
          }
          break;
        }
        case 'sacAllButOne': {
          for (const q of this.alivePlayers()) {
            const creatures = q.creatures();
            if (creatures.length <= 1) continue;
            let keep = null;
            if (!q.isBot) {
              const chosen = await q.controller.chooseCards(this, creatures, 1, 'Elige la criatura que conservas');
              keep = chosen[0] ?? null;
            }
            if (!keep) keep = creatures.slice().sort((a, b) => b.cmc - a.cmc)[0];
            for (const c of [...creatures]) {
              if (c !== keep) this.removeFromBattlefield(c, 'sacrificado');
            }
          }
          break;
        }
        case 'revealUntilCreature': {
          const revealed = [];
          let found = null;
          while (p.library.length) {
            const c = p.library.shift();
            if (c.isCreature) { found = c; break; }
            revealed.push(c);
          }
          this.shuffle(revealed);
          p.library.push(...revealed);
          if (found) {
            found.zone = 'hand';
            p.hand.push(found);
            this.log(`${p.name} revela hasta ${found.name} y la pone en su mano.`);
            if (op.counters) {
              const dest = p.creatures().sort((a, b) => b.power(this) - a.power(this))[0];
              if (dest) this.addCounters(dest, found.cmc, p);
            }
          }
          break;
        }
        case 'rampTyped': {
          const idx = p.library.findIndex((c) => c.isLand && op.subtypes.some((s) => c.hasSubtype(s)));
          if (idx !== -1) {
            const land = p.library.splice(idx, 1)[0];
            this.shuffle(p.library);
            this.putOnBattlefield(land, p);
            if (op.tapped) land.tapped = true;
            this.log(`${p.name} busca ${land.name} y la pone en juego${op.tapped ? ' girada' : ''}.`);
          }
          break;
        }
        case 'drawPerCounters': {
          const n = p.creatures().filter((c) => c.counters > 0).length;
          if (n > 0) this.drawCards(p, n);
          break;
        }
        case 'moveSelfCountersOut': {
          const src = ctx.source;
          if (src.zone !== 'battlefield' || src.counters <= 0) break;
          const dest = p.creatures().filter((c) => c !== src)
            .sort((a, b) => this.botValueOf?.(b) - this.botValueOf?.(a) || b.power(this) - a.power(this))[0];
          if (dest) {
            const n = src.counters;
            src.counters = 0;
            this.addCounters(dest, n, p);
            this.log(`${p.name} mueve ${n} contador(es) de ${src.name} a ${dest.name}.`);
          }
          break;
        }
        case 'basicForLastController': {
          const t = ctx._lastTarget;
          const q = t instanceof CardInstance ? t.owner : t instanceof Player ? t : null;
          if (q?.alive) {
            const idx = q.library.findIndex((c) => c.hasType('Basic') && c.isLand);
            if (idx !== -1) {
              const land = q.library.splice(idx, 1)[0];
              this.shuffle(q.library);
              this.putOnBattlefield(land, q);
              land.tapped = true;
              this.log(`${q.name} busca una básica girada.`);
            }
          }
          break;
        }
        case 'pumpFiltered': {
          for (const c of p.creatures()) {
            if (op.filter === 'counters' && c.counters <= 0) continue;
            for (const k of op.keywords) c.tempKeywords.add(k);
          }
          this.log(`Las criaturas con contadores de ${p.name} ganan ${op.keywords.join(', ')}.`);
          break;
        }
        case 'ifCountersPutThisTurn': {
          if (p._countersPutThisTurn) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'ifSelfCounterThisTurn': {
          if (ctx.source._counterGotThisTurn) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'bolster': {
          const weakest = p.creatures().sort((a, b) => a.toughness(this) - b.toughness(this))[0];
          if (weakest) this.addCounters(weakest, op.n, p);
          break;
        }
        case 'doubleCounters': {
          const best = p.creatures().filter((c) => c.counters > 0)
            .sort((a, b) => b.counters - a.counters)[0];
          if (best) this.addCounters(best, best.counters, p);
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
            if (op.dest === 'battlefield' && top.isPermanentType) {
              this.log(`${p.name} revela ${top.name} y la pone en el campo de batalla.`);
              this.putOnBattlefield(top, p);
            } else {
              top.zone = 'hand';
              p.hand.push(top);
              this.log(`${p.name} revela ${top.name} y la pone en su mano.`);
            }
          } else if (op.elseHand) {
            p.library.shift();
            top.zone = 'hand';
            p.hand.push(top);
            this.log(`${p.name} revela ${top.name}: a su mano.`);
          } else {
            this.log(`${p.name} revela ${top.name}: se queda arriba.`);
          }
          break;
        }
        case 'untapYours': {
          for (const c of p.creatures()) c.tapped = false;
          this.log(`${p.name} endereza sus criaturas.`);
          break;
        }
        case 'copySelfPerCmd': {
          if (ctx._noCopy) break;
          const copies = Math.min(5, p.command.concat(p.battlefield.filter((c) => c.isCommander))
            .reduce((n, c) => n + c.commanderCasts, 0));
          const opsNoCopy = ctx.source.script.castOps.filter((o) => o.op !== 'copySelfPerCmd');
          for (let i = 0; i < copies; i++) {
            this.log(`Copia ${i + 1} de ${ctx.source.name}.`);
            await this.resolveOps(opsNoCopy, { ...ctx, targets: [], _noCopy: true });
          }
          break;
        }
        case 'copyLastSpell': {
          const last = this._lastSpell?.get(p);
          if (last && last !== ctx.source && last.script.castOps.length) {
            this.log(`${p.name} copia ${last.name}.`);
            const targetedOps = last.script.castOps.filter((o) => o.targeted || o.target?.targeted);
            let tgs = [];
            if (targetedOps.length) tgs = (await this.pickTargetsFor(p, last, targetedOps)) ?? [];
            await this.resolveOps(last.script.castOps, { source: last, controller: p, targets: tgs, xValue: 0 });
          }
          break;
        }
        case 'discover': {
          const exiled = [];
          let hit = null;
          while (p.library.length) {
            const c = p.library.shift();
            if (!c.isLand && c.cmc <= op.n) { hit = c; break; }
            exiled.push(c);
          }
          this.shuffle(exiled);
          p.library.push(...exiled);
          if (hit) {
            this.log(`Descubrir: ${p.name} lanza ${hit.name} gratis.`);
            hit.zone = 'stack';
            let dTargets = [];
            if (hit.script.targets.length) {
              dTargets = await this.pickTargetsFor(p, hit, hit.script.targets);
              if (dTargets === null) { this.moveToGraveyard(hit, null); break; }
            }
            await this.resolveSpell(p, hit, dTargets, 0);
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
              .filter((c) => (op.allowSelf || c !== ctx.source) && !chosen.has(c));
            if (!candidates.length) break;
            const pick = await p.controller.chooseTarget(this, ctx.source, op, candidates);
            if (!pick || pick instanceof Player) break;
            chosen.add(pick);
            this.addCounters(pick, 1, p);
          }
          break;
        }
        case 'distribute': {
          for (let i = 0; i < op.n; i++) {
            const candidates = this.legalTargets({ kind: 'creature', controller: 'you' }, p);
            if (!candidates.length) break;
            const pick = await p.controller.chooseTarget(this, ctx.source, op, candidates);
            if (!pick || pick instanceof Player) break;
            this.addCounters(pick, 1, p);
          }
          break;
        }
        case 'proliferate': {
          let hits = 0;
          for (const c of p.battlefield) {
            if (c.counters > 0) { this.addCounters(c, 1, p); hits++; }
          }
          this.log(`${p.name} prolifera (${hits} permanente(s)).`);
          break;
        }
        case 'tokenSpecial': {
          let n = this.num(op, ctx);
          if (p.battlefield.some((c) => c.script?.tokenMod === 'double')) n *= 2;
          const SPECS = {
            Treasure: { text: '', producedMana: ['W', 'U', 'B', 'R', 'G'] },
            Clue: { text: '{2}, sacrifice ~: draw a card.' },
            Food: { text: '{2}, {t}, sacrifice ~: you gain 3 life.' },
            Blood: { text: '{1}, {t}, sacrifice ~: draw a card.' },
            Powerstone: { text: '', producedMana: ['C'] },
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
            this.addCounters(ctx.source, 1, p);
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
          this.addCounters(army, op.n, p);
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
          if (n > 0) this.gainLife(p, n);
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
      this.gainLife(source.controller, n, true);
    }
    this.checkState();
  }

  damageCreature(c, n, source) {
    if (n <= 0 || c.zone !== 'battlefield') return;
    // "Si se le fuera a hacer daño, en vez de eso ponle contadores".
    if (c._damageToCounters) {
      this.addCounters(c, n, c.controller);
      return;
    }
    if (c.shieldCounters > 0) {
      c.shieldCounters--;
      this.log(`${c.name} gasta un contador de escudo.`);
      return;
    }
    if (c.hasKeyword('indestructible', this)) {
      if (source && source.isCreature === false) return;
    }
    // Infectar: el daño a criaturas son contadores -1/-1.
    if (source && (source.data?.keywords || []).includes('Infect')) {
      c.counters -= n;
      if (source.isCreature && source.hasKeyword('lifelink', this)) this.gainLife(source.controller, n, true);
      this.checkState();
      return;
    }
    c.damage += n;
    if (source && source.isCreature && source.hasKeyword('lifelink', this)) this.gainLife(source.controller, n, true);
    const lethal = source && (source.hasKeyword?.('deathtouch', this));
    if (c.damage >= c.toughness(this) || (lethal && n > 0)) {
      if (!c.hasKeyword('indestructible', this)) this.destroy(c, source, true);
    }
  }

  destroy(c, source, fromDamage = false) {
    if (c.zone !== 'battlefield') return;
    if (c.shieldCounters > 0) {
      c.shieldCounters--;
      this.log(`${c.name} gasta un contador de escudo.`);
      return;
    }
    if (c.hasKeyword('indestructible', this) ) return;
    this.removeFromBattlefield(c, 'muere');
  }

  exileCard(c) {
    this.detachAll(c);
    this.releaseExiled(c);
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
    this.releaseExiled(c);
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
          this.resolveOpsSync(tr.ops, { source: perm, controller: q, targets: [], xValue: 0, eventCard: dead });
        }
      }
    }
  }

  // Libera cartas exiliadas "hasta que ~ deje el campo de batalla".
  releaseExiled(c) {
    for (const ex of c._exiledUntilLeave ?? []) {
      if (ex.zone !== 'exile') continue;
      const zone = ex.owner.exile;
      zone.splice(zone.indexOf(ex), 1);
      this.putOnBattlefield(ex, ex.owner);
      this.log(`${ex.name} regresa al campo de batalla.`);
    }
    c._exiledUntilLeave = [];
  }

  removeFromBattlefield(c, verb) {
    if (c.zone !== 'battlefield') return;
    this.detachAll(c);
    this.releaseExiled(c);
    const p = c.controller;
    const hadCounters = c.counters;
    c._lastCounters = hadCounters;
    p.battlefield.splice(p.battlefield.indexOf(c), 1);
    // Yuna: "si tenía contadores, ponlos en otra criatura".
    if (hadCounters > 0) {
      for (const perm of p.battlefield) {
        if (perm.script?.allyDiesCounters && perm !== c) {
          const dest = p.creatures().sort((a, b) => b.power(this) - a.power(this))[0];
          if (dest) {
            this.log(`Se dispara ${perm.name}: los contadores de ${c.name} pasan a ${dest.name}.`);
            this.addCounters(dest, hadCounters, p);
          }
          break;
        }
      }
    }
    // "Siempre que sacrifiques una criatura/artefacto/permanente...".
    if (verb === 'sacrificado') {
      this._sacDepth = (this._sacDepth || 0) + 1;
      if (this._sacDepth <= 3) {
        for (const perm of [...p.battlefield]) {
          for (const tr of perm.script?.onSac ?? []) {
            const match = tr.what === 'permanent' ||
              (tr.what === 'creature' && c.isCreature) ||
              (tr.what === 'artifact' && c.isArtifact) ||
              c.hasSubtype(tr.what) || c.name.toLowerCase() === tr.what;
            if (match) this.resolveOpsSync(tr.ops, { source: perm, controller: p, targets: [], xValue: 0, eventCard: c });
          }
        }
      }
      this._sacDepth--;
    }
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

  // Disparos por entradas: landfall, "otra criatura/tribu tuya entra" y evolucionar.
  fireEnterTriggers(card, p) {
    if (card.script?.vanishing) card._timeCounters = card.script.vanishing;
    if (card.isLand) {
      this._etbDepth = (this._etbDepth || 0) + 1;
      if (this._etbDepth <= 5) {
        for (const perm of [...p.battlefield]) {
          if (perm.script?.landfall?.length) {
            this.log(`Se dispara ${perm.name} (landfall).`);
            this.resolveOpsSync(perm.script.landfall, { source: perm, controller: p, targets: [], xValue: 0 });
          }
        }
      }
      this._etbDepth--;
      return;
    }
    if (!card.isCreature) return;
    this._etbDepth = (this._etbDepth || 0) + 1;
    if (this._etbDepth > 5) { this._etbDepth--; return; } // corta bucles de fichas
    // Tromell: otras criaturas no ficha entran con un contador adicional.
    if (!card.isToken) {
      for (const perm of p.battlefield) {
        if (perm !== card && perm.script?.allyEnterCounter) {
          this.addCounters(card, perm.script.allyEnterCounter, p);
        }
      }
    }
    for (const perm of [...p.battlefield]) {
      for (const tr of perm.script?.allyEtb || []) {
        if (card === perm && !tr.includeSelf) continue;
        if (tr.subtype && !card.hasSubtype(tr.subtype)) continue;
        this.log(`Se dispara ${perm.name} (entra ${card.name}).`);
        this.resolveOpsSync(tr.ops, { source: perm, controller: p, targets: [], xValue: 0, eventCard: card });
      }
      if (perm !== card && perm.isCreature && (perm.data.keywords || []).includes('Evolve') &&
          (card.power(this) > perm.power(this) || card.toughness(this) > perm.toughness(this))) {
        this.log(`${perm.name} evoluciona.`);
        this.addCounters(perm, 1, p);
      }
    }
    this._etbDepth--;
  }

  // Punto único de ganancia de vida: dispara "siempre que ganes vida".
  gainLife(q, n, silent = false) {
    if (n <= 0 || !q.alive) return;
    q.life += n;
    if (!silent) this.log(`${q.name} gana ${n} vidas (${q.life}).`);
    this._lifeDepth = (this._lifeDepth || 0) + 1;
    if (this._lifeDepth <= 3) {
      for (const perm of [...q.battlefield]) {
        if (perm.script?.onGainLife?.length) {
          this.resolveOpsSync(perm.script.onGainLife, { source: perm, controller: q, targets: [], xValue: 0 });
        }
      }
    }
    this._lifeDepth--;
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
      this.fireDrawTriggers(p);
    }
    if (n > 0) this.log(`${p.name} roba ${n} carta(s).`);
  }

  // "Siempre que robes / un oponente robe una carta".
  fireDrawTriggers(drawer) {
    this._drawDepth = (this._drawDepth || 0) + 1;
    if (this._drawDepth <= 3) {
      for (const q of this.alivePlayers()) {
        for (const perm of [...q.battlefield]) {
          if (q === drawer && perm.script?.onDraw?.length) {
            this.resolveOpsSync(perm.script.onDraw, { source: perm, controller: q, targets: [], xValue: 0, eventPlayer: drawer });
          }
          if (q !== drawer && perm.script?.onOppDraw?.length) {
            this.resolveOpsSync(perm.script.onOppDraw, { source: perm, controller: q, targets: [], xValue: 0, eventPlayer: drawer });
          }
        }
      }
    }
    this._drawDepth--;
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
        if (st.needsCounters && card.counters <= 0) continue;
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
        await this.resolveTriggered(c, tr.ops, 'inicio de combate');
        if (this.over) return;
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

    // "Siempre que ataques" (Chocobo Knights y similares).
    for (const c of [...attackerP.battlefield]) {
      if (c.script?.onYouAttack?.length) {
        this.resolveOpsSync(c.script.onYouAttack, { source: c, controller: attackerP, targets: [], xValue: 0 });
      }
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

    // "Siempre que un oponente te ataque" (Lulu: aturdir al mayor atacante).
    for (const [def, atks] of byDefender) {
      if (!def.alive) continue;
      for (const perm of [...def.battlefield]) {
        for (const tr of perm.script?.onAttacked ?? []) {
          if (tr.op === 'stunAttacker') {
            const biggest = atks.filter((a) => a.zone === 'battlefield')
              .sort((a, b) => b.power(this) - a.power(this))[0];
            if (biggest) {
              biggest.stunCounters += 1;
              this.log(`${perm.name}: ${biggest.name} recibe un contador de aturdir.`);
            }
          }
        }
      }
    }

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
      if (atk.hasKeyword('lifelink', this)) this.gainLife(atk.controller, power, true);
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
      if (atk.hasKeyword('lifelink', this)) this.gainLife(atk.controller, power, true);
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
        if (tr.needsCounters && atk.counters <= 0) continue;
        if (tr.once) {
          if (perm._onceUsedTurn === this.turn) continue;
          perm._onceUsedTurn = this.turn;
        }
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
