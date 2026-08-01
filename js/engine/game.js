// Motor de partida 1v1 de One Piece Card Game.
//
// Decisiones de diseño (ver PLAN.md §4b):
//  - Sin DOM: corre igual en navegador, en Node (simulación) y en un futuro
//    servidor autoritativo.
//  - Toda decisión de jugador pasa por su `controller` (bot, humano o remoto).
//  - Las acciones son JSON plano que referencia cartas POR ID.
//  - Todo el azar sale de un RNG con semilla.

import { CardInstance, resetIds } from './cards.js';
import { buildScript, abilitiesOf } from './effects.js';

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
    this.leader = null;
    this.library = [];       // mazo boca abajo
    this.hand = [];
    this.characters = [];    // máx. 5
    this.stage = null;
    this.life = [];          // cartas de vida boca abajo (la [0] es la de arriba)
    this.trash = [];
    this.donDeck = 10;       // DON!! sin colocar
    this.donActive = 0;      // en el área de coste, enderezados
    this.donRested = 0;      // en el área de coste, girados
    this.lost = false;
    this.lossReason = null;
  }
  get alive() { return !this.lost; }
  get donGiven() {
    return (this.leader?.givenDon ?? 0) + this.characters.reduce((n, c) => n + c.givenDon, 0);
  }
  board() { return [this.leader, ...this.characters].filter(Boolean); }
}

export class Game {
  constructor(configs, { seed = 42, onLog = null, onAnimate = null, onNarrate = null, maxTurns = 60, sandbox = false } = {}) {
    resetIds();
    // RNG con estado visible: snapshot/restore (bot con búsqueda) lo necesita.
    this.rngState = seed >>> 0;
    this.rng = () => {
      const a = (this.rngState = (this.rngState + 0x6d2b79f5) | 0);
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.onLog = onLog;
    this.onAnimate = onAnimate;   // hook opcional para animaciones de la UI
    this.onNarrate = onNarrate;   // hook opcional: la UI narra las jugadas
    this.maxTurns = maxTurns;
    this.sandbox = sandbox;       // modo pruebas: DON!! garantizado y herramientas extra
    this.turn = 0;
    this.phase = 'setup';
    this.activeIdx = 0;
    this.winner = null;
    this.over = false;
    this.logLines = [];
    this.cardsById = new Map();

    this.players = configs.map((cfg) => {
      const p = new Player(cfg.name, cfg.deck, cfg.controller, cfg.isBot);
      cfg.controller.player = p;
      return p;
    });

    const scriptCache = new Map();
    const withScript = (c) => {
      if (!scriptCache.has(c.data.id)) scriptCache.set(c.data.id, buildScript(c.data));
      c.script = scriptCache.get(c.data.id);
      return c;
    };
    for (const p of this.players) {
      p.leader = withScript(this.register(new CardInstance(p.deck.leader, p)));
      p.leader.zone = 'leader';
      for (const entry of p.deck.cards) {
        for (let i = 0; i < entry.count; i++) {
          const c = withScript(this.register(new CardInstance(entry, p)));
          p.library.push(c);
        }
      }
      this.shuffle(p.library);
    }
  }

  // ---- estáticas ---------------------------------------------------------

  // Filtro sin poder dinámico (evita recursión con staticPowerFor).
  matchesFilterStatic(card, f) {
    if (!f) return true;
    const cmp = (val, spec) => spec.dir === 'less' ? val <= spec.v : spec.dir === 'more' ? val >= spec.v : val === spec.v;
    if (f.names && !f.names.some((nm) => card.name.toLowerCase().includes(nm.toLowerCase()) ||
      (card.script?.aliases ?? []).some((a) => a.toLowerCase().includes(nm.toLowerCase())))) return false;
    if (f.notName && card.name.toLowerCase().includes(f.notName.toLowerCase())) return false;
    if (f.types && !f.types.some((t) => (card.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase())))) return false;
    if (f.colors && !f.colors.some((c) => (card.color ?? '').toLowerCase().includes(c))) return false;
    if (f.basePower && !cmp(card.data.power ?? 0, f.basePower)) return false;
    if (f.power && !cmp(card.data.power ?? 0, f.power)) return false;
    if (f.baseCost && !cmp(card.data.cost ?? 0, f.baseCost)) return false;
    if (f.cost && !cmp(card.data.cost ?? 0, f.cost)) return false;
    if (f.costRange && ((card.data.cost ?? 0) < f.costRange.lo || (card.data.cost ?? 0) > f.costRange.hi)) return false;
    return true;
  }

  buffInScope(op, card) {
    const inScope = (op.scope === 'leader' && card.isLeader) ||
      (op.scope === 'char' && card.isCharacter) || op.scope === 'leaderChar';
    return inScope && this.matchesFilterStatic(card, op.filter);
  }

  // Multiplicador "for every N <cosa>" de un grant.
  perFactor(per, p, ctx = {}) {
    if (!per) return 1;
    switch (per.kind) {
      case 'trash': return Math.floor(p.trash.length / per.n);
      case 'returned': return Math.floor((ctx.returnedNow ?? 0) / per.n);
      case 'trashed': return Math.floor((ctx.trashedNow ?? 0) / per.n);
      case 'restedDon': return Math.floor(p.donRested / per.n);
      case 'fieldType': {
        const pool = [p.leader, ...p.characters, p.stage].filter(Boolean);
        return pool.filter((c) => (c.data.subTypes ?? []).some((s) => s.toLowerCase().includes(per.type.toLowerCase()))).length;
      }
      default: return 1;
    }
  }

  // Gira una carta disparando "cuando este personaje se gira" (Mihawk ST32-003).
  async restCard(c) {
    if (c.rested) return;
    c.rested = true;
    await this.runTaggedAbilities(c, 'onSelfRested');
  }

  // Recorre las habilidades estáticas de `holder` que aplican ahora mismo y
  // llama a visit(op, holder, isSelf) por cada op, entrando en condicionales.
  walkStatics(card, visit) {
    const p = card.owner;
    const runOps = (ops, holder, self) => {
      for (const op of ops) {
        if (op.op === 'ifCond') {
          // Guarda de reentrada: una condición que consulte poder/coste de
          // otras cartas no debe reevaluar estáticas en cadena sin fin.
          if (this._inStaticCond) continue;
          this._inStaticCond = true;
          let ok = false;
          try { ok = this.evalCond(op.cond, { p: holder.owner, source: holder }); }
          finally { this._inStaticCond = false; }
          if (ok) runOps(op.ops, holder, self);
          continue;
        }
        visit(op, holder, self);
      }
    };
    const walk = (holder, self) => {
      if (holder._negatedUntil === this.turn) return;
      for (const ab of holder.script?.abilities ?? []) {
        if (ab.when !== 'static') continue;
        if (ab.donX && holder.givenDon < ab.donX) continue;
        if (ab.yourTurn && this.activePlayer !== holder.owner) continue;
        if (ab.oppTurn && this.activePlayer === holder.owner) continue;
        runOps(ab.ops, holder, self);
      }
    };
    walk(card, true);
    for (const other of p.board()) if (other !== card) walk(other, false);
  }

  staticPowerFor(card) {
    let bonus = 0;
    const p = card.owner;
    // Estáticas no-[static] propias (ligadas a DON!! xN con otro timing raro).
    for (const ab of card.script?.abilities ?? []) {
      if (ab.when === 'static') continue;
      if (ab.donX && card.givenDon < ab.donX) continue;
      for (const op of ab.ops) {
        if (op.op === 'staticSelfPower' && p.characters.length >= (op.cond?.minChars ?? 0)) bonus += op.n;
      }
    }
    this.walkStatics(card, (op, holder, self) => {
      if (self && op.op === 'powerSelf') bonus += op.n;
      if (self && op.op === 'staticSelfPower' && p.characters.length >= (op.cond?.minChars ?? 0)) bonus += op.n;
      if (self && op.op === 'selfGrant' && op.static) {
        const f = this.perFactor(op.per, p);
        for (const ch of op.changes) if (ch.stat === 'power') bonus += ch.delta * f;
      }
      if (!self && op.op === 'auraWhileRested' && holder.rested) bonus += op.n;
      if (!self && op.op === 'buff' && op.side === 'own' && this.buffInScope(op, card)) {
        const f = this.perFactor(op.per, holder.owner);
        for (const ch of op.changes) if (ch.stat === 'power') bonus += ch.delta * f;
      }
    });
    return bonus;
  }

  // Delta de COSTE por estáticas ("gain +1 cost", propias o de grupo).
  staticCostFor(card) {
    // Descuentos "de mano" (Borsalino ST33-004): estáticas de la propia carta
    // que aplican mientras está en tu mano.
    if (card.zone === 'hand') {
      let d = 0;
      for (const ab of card.script?.abilities ?? []) {
        if (ab.when !== 'static') continue;
        for (const op of ab.ops) {
          if (op.op === 'handCostAfterTrash' && card.owner?._handTrashedTurn === this.turn) d += op.delta;
        }
      }
      return d;
    }
    if (!['characters', 'leader', 'stage'].includes(card.zone)) return 0;
    if (this._inStaticCost) return 0;   // corta ciclos coste→condición→coste
    this._inStaticCost = true;
    let delta = 0;
    try {
      this.walkStatics(card, (op, holder, self) => {
        if (self && op.op === 'selfGrant' && op.static) {
          const f = this.perFactor(op.per, holder.owner);
          for (const ch of op.changes) if (ch.stat === 'cost') delta += ch.delta * f;
        }
        if (!self && op.op === 'buff' && op.side === 'own' && this.buffInScope(op, card)) {
          const f = this.perFactor(op.per, holder.owner);
          for (const ch of op.changes) if (ch.stat === 'cost') delta += ch.delta * f;
        }
      });
    } finally {
      this._inStaticCost = false;
    }
    return delta;
  }

  // ¿La carta cumple un filtro de objetivo (color/subtipo/nombre/poder/coste)?
  matchesFilter(card, f) {
    if (!f) return true;
    const cmp = (val, spec) => spec.dir === 'less' ? val <= spec.v : spec.dir === 'more' ? val >= spec.v : val === spec.v;
    if (f.names && !f.names.some((nm) => card.name.toLowerCase().includes(nm.toLowerCase()) ||
      (card.script?.aliases ?? []).some((a) => a.toLowerCase().includes(nm.toLowerCase())))) return false;
    if (f.notName && card.name.toLowerCase().includes(f.notName.toLowerCase())) return false;
    if (f.types && !f.types.some((t) => (card.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase())))) return false;
    if (f.colors && !f.colors.some((c) => (card.color ?? '').toLowerCase().includes(c))) return false;
    if (f.basePower && !cmp(card.data.power ?? 0, f.basePower)) return false;
    if (f.power && !cmp(card.power(this), f.power)) return false;
    if (f.baseCost && !cmp(card.data.cost ?? 0, f.baseCost)) return false;
    if (f.cost && !cmp(card.cost, f.cost)) return false;
    if (f.costRange && (card.cost < f.costRange.lo || card.cost > f.costRange.hi)) return false;
    if (f.hasTrigger && !card.hasTrigger) return false;
    if (f.noTrigger && card.hasTrigger) return false;
    if (f.noEffect && !(card.text === 'NULL' || !card.text.trim())) return false;
    if (f.activeOnly && card.rested) return false;
    if (f.restedOnly && !card.rested) return false;
    return true;
  }

  // Evalúa un descriptor de condición "if ..." (ver parseCondition).
  evalCond(cond, ctx) {
    const p = ctx.p; const opp = this.opponentOf(p); const src = ctx.source;
    const cmp = (val, spec) => spec.dir === 'less' ? val <= spec.v : spec.dir === 'more' ? val >= spec.v : val === spec.v;
    const donField = p.donActive + p.donRested;
    switch (cond.t) {
      case 'and': return this.evalCond(cond.a, ctx) && this.evalCond(cond.b, ctx);
      case 'youLife': return cmp(p.life.length, cond);
      case 'oppLife': return cmp(opp.life.length, cond);
      case 'lifeLEOpp': return p.life.length <= opp.life.length;
      case 'lifeLTOpp': return p.life.length < opp.life.length;
      case 'youHand': return cmp(p.hand.length, cond);
      case 'oppHand': return cmp(opp.hand.length, cond);
      case 'leaderName': return p.leader.name.toLowerCase().includes(cond.name.toLowerCase());
      case 'leaderType': return (p.leader.data.subTypes ?? []).some((s) => s.toLowerCase().includes(cond.type.toLowerCase()));
      case 'leaderMulticolor': return (p.leader.color ?? '').includes('/');
      case 'boardCost': return [...p.characters, ...opp.characters].some((c) => c.cost === cond.v);
      case 'oppHasChar': return opp.characters.some((c) => this.matchesFilter(c, cond.filter));
      case 'oppRested': {
        let val = opp.characters.filter((c) => c.rested).length;
        if (cond.anyCard) val += (opp.leader?.rested ? 1 : 0) + (opp.stage?.rested ? 1 : 0) + opp.donRested;
        return val >= cond.v;
      }
      case 'youHaveMatch': {
        const pool = cond.anyZone ? [...p.characters, p.leader, p.stage].filter(Boolean) : p.characters;
        const list = pool.filter((c) => this.matchesFilter(c, cond.filter) && (!cond.filter.rested || c.rested) && (!cond.excludeSelf || c !== ctx.source));
        return cond.dir === 'less' ? list.length <= (cond.count ?? 1) : list.length >= (cond.count ?? 1);
      }
      case 'don': return cond.any.some((spec) => cmp(donField, spec));
      case 'rested': {
        const val = cond.kind === 'don' ? p.donRested
          : cond.kind === 'char' ? p.characters.filter((c) => c.rested).length
            : p.donRested + p.characters.filter((c) => c.rested).length + (p.leader.rested ? 1 : 0) + (p.stage?.rested ? 1 : 0);
        return val >= cond.v;
      }
      case 'playedThisTurn': return src?.enteredTurn === this.turn;
      case 'didPlay': return !!ctx.didPlay;
      case 'not': return !this.evalCond(cond.a, ctx);
      case 'totalLife': return p.life.length + opp.life.length <= cond.v;
      case 'givenDon': return p.donGiven >= cond.v;
      case 'donLEOpp': return (p.donActive + p.donRested + p.donGiven) <= (opp.donActive + opp.donRested + opp.donGiven);
      case 'leaderAttrSelf': return !!src?.data?.attribute && p.leader.data.attribute === src.data.attribute;
      case 'handTrashedThisTurn': return p._handTrashedTurn === this.turn;
      case 'oppMoreDon': return (opp.donActive + opp.donRested) > (p.donActive + p.donRested);
      case 'restedByEffect': return !!p._restedByEffectTurn && p._restedByEffectTurn === this.turn;
      case 'or': return this.evalCond(cond.a, ctx) || this.evalCond(cond.b, ctx);
      case 'oppCharCount': return opp.characters.length >= cond.v;
      case 'revealedIs': return !!ctx.lastRevealed && this.matchesFilter(ctx.lastRevealed, cond.filter);
      case 'onlyType': return p.characters.length > 0 && p.characters.every((c) => this.matchesFilter(c, cond.filter));
      case 'boardCostCount': return [...p.characters, ...opp.characters].filter((c) => c.cost >= cond.v).length >= cond.count;
      case 'selfPower': return (src?.power?.(this) ?? 0) >= cond.v;
      case 'selfRested': return !!src?.rested;
      case 'deckLE': return p.library.length <= cond.v;
      case 'trashMatch': return p.trash.filter((c) => this.matchesFilter(c, cond.filter)).length >= cond.count;
      case 'trashCount': return p.trash.length >= cond.v;
      case 'oppDon': return (opp.donActive + opp.donRested + opp.donGiven) >= cond.v;
      default: return false;
    }
  }

  staticKeyword(card, kw) {
    let found = false;
    const want = kw.toLowerCase();
    this.walkStatics(card, (op, holder, self) => {
      if (found) return;
      if (self && op.op === 'gainKeyword' && op.kw.toLowerCase() === want) found = true;
      if (self && op.op === 'selfGrant' && op.static && (op.kws ?? []).some((k) => k.toLowerCase() === want)) found = true;
      if (!self && op.op === 'buff' && op.side === 'own' &&
        (op.kws ?? []).some((k) => k.toLowerCase() === want) && this.buffInScope(op, card)) found = true;
    });
    return found;
  }

  // ¿Puede esta carta ser KO en este contexto? Consulta protecciones estáticas
  // ("cannot be KO'd in battle / by effects / by leaders").
  canBeKOd(card, { byEffect = false, byLeaderBattle = false } = {}) {
    // "None of your Characters can be KO'd during this turn" (efecto global).
    if (card.owner._noKOTurn === this.turn) return false;
    if (byEffect && this.isProtectedFromRemoval(card)) return false;
    if (byEffect && card._noKOEffectUntil >= this.turn) return false;
    for (const ab of card.script?.abilities ?? []) {
      if (ab.when !== 'static' && ab.when !== 'onPlay') continue;
      if (ab.donX && card.givenDon < ab.donX) continue;
      for (const op of ab.ops) {
        if (op.op === 'ifCond') {
          if (!this.evalCond(op.cond, { p: card.owner, source: card })) continue;
          if (op.ops.some((o) => o.op === 'cannotKO' && this.koModeBlocks(o, byEffect, byLeaderBattle))) return false;
        }
        if (op.op === 'cannotKO' && this.koModeBlocks(op, byEffect, byLeaderBattle)) return false;
      }
    }
    return true;
  }

  // Efectos de reemplazo ante KO/retirada ("...you may ... instead").
  // Devuelve true si se evitó el KO (la carta permanece en el tablero).
  async tryPreventKO(card, { byEffect }) {
    for (const ab of card.script?.abilities ?? []) {
      if (ab.donX && card.givenDon < ab.donX) continue;
      for (const op of ab.ops) {
        if (op.op !== 'koReplace') continue;
        if (op.trigger === 'remove' && !byEffect) continue;
        const owner = card.owner;
        const cost = { trashHand: op.trashHand ?? 0, trashLife: op.trashLife ?? 0, trashLifePick: !!op.trashLifePick };
        if (op.action === 'pay' && !this.canPayAbilityCost(owner, card, cost)) continue;
        const wants = owner.isBot
          ? (op.action === 'rest' || (owner.hand.length > (op.trashHand ?? 0) + 1))
          : await owner.controller.chooseOption(this, {
            prompt: `${card.name} sería eliminado. ¿Evitarlo (${op.action === 'rest' ? 'girándolo' : 'pagando un coste'})?`,
            options: ['Sí', 'No'],
          }) === 0;
        if (!wants) continue;
        if (op.action === 'pay') { await this.payAbilityCost(owner, card, cost); this.log(`🛡 ${card.name} evita ser eliminado pagando un coste.`); return true; }
        if (op.action === 'rest') { card.rested = true; this.log(`🛡 ${card.name} se gira en vez de ser eliminado.`); return true; }
        if (op.action === 'trashDraw') { this.draw(owner, op.draw ?? 1); this.log(`${owner.name} roba al retirarse ${card.name}.`); return false; }
        if (op.action === 'tuckOwn') {
          const cands = owner.characters.filter((c) => c !== card && (!op.notName || !c.name.toLowerCase().includes(op.notName.toLowerCase())));
          if (cands.length < (op.n ?? 1)) continue;
          for (let k = 0; k < (op.n ?? 1); k++) {
            const id = await owner.controller.chooseTarget(this, { purpose: 'tuckBottom', candidateIds: cands.map((c) => c.id), optional: false });
            const t = this.byId(id) ?? cands[0];
            cands.splice(cands.indexOf(t), 1);
            owner.donActive += t.givenDon; t.givenDon = 0;
            owner.characters.splice(owner.characters.indexOf(t), 1);
            t.zone = 'deck'; t.rested = false; owner.library.push(t);
            this.log(`⤵ ${t.name} va al fondo del mazo para salvar a ${card.name}.`);
          }
          return true;
        }
      }
    }
    return false;
  }

  // ¿Tiene la carta una estática simple (op sin condición) activa en juego?
  cardHasStatic(card, opName) {
    if (!['characters', 'leader', 'stage'].includes(card.zone)) return false;
    let found = false;
    this.walkStatics(card, (op, holder, self) => {
      if (found) return;
      if (self && op.op === opName) found = true;
      if (!self && op.op === `${opName}Group` && this.matchesFilterStatic(card, op.filter)) found = true;
    });
    return found;
  }

  // "cannot be removed from the field by your opponent's effects".
  isProtectedFromRemoval(card) {
    return this.cardHasStatic(card, 'cannotRemove');
  }

  koModeBlocks(op, byEffect, byLeaderBattle) {
    if (op.mode === 'any') return true;
    if (op.mode === 'effect') return byEffect;
    if (op.mode === 'battle') return !byEffect && (op.by !== 'leader' || byLeaderBattle);
    return false;
  }

  register(card) {
    this.cardsById.set(card.id, card);
    card.game = this;   // backref: el coste efectivo consulta estáticas
    return card;
  }
  byId(id) { return this.cardsById.get(id) ?? null; }

  log(msg) {
    if (this._mute) return;   // simulaciones internas del bot: sin ruido
    this.logLines.push(msg);
    if (this.onLog) this.onLog(msg);
  }

  // Narración estructurada de una jugada (la UI decide si mostrar cartel).
  async narrate(player, ev) {
    if (this._mute) return;
    if (this.onNarrate) {
      await this.onNarrate({
        actor: player.name, isBot: player.isBot,
        actorIdx: this.players.indexOf(player), ...ev,
      });
    }
  }

  // Descripción legible de una lista de ops (para modales de elección).
  describeOps(ops) {
    const T = {
      trashOppLife: 'Descartar 1 carta de tu Vida', lifeAddFromDeck: 'Añadir 1 carta a tu Vida',
      ko: 'KO a un personaje', draw: 'Robar', bounce: 'Devolver a la mano',
      powerDown: 'Restar poder', rest: 'Girar un personaje',
    };
    return ops.map((o) => T[o.op] ?? o.op).join(' + ') || 'Nada';
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  get activePlayer() { return this.players[this.activeIdx]; }
  opponentOf(p) { return this.players[0] === p ? this.players[1] : this.players[0]; }

  // ---- preparación -------------------------------------------------------

  async start() {
    this.log(`Comienza: ${this.players[0].name} (${this.players[0].deck.name}) vs ${this.players[1].name} (${this.players[1].deck.name}).`);
    for (const p of this.players) {
      this.draw(p, 5, true);
      const wants = await p.controller.mulligan(this, p.hand.map((c) => c.id));
      if (wants) {
        p.library.push(...p.hand.splice(0));
        this.shuffle(p.library);
        this.draw(p, 5, true);
        this.log(`${p.name} hace mulligan.`);
      }
      // Vidas: tantas como la vida del líder.
      const n = p.leader.data.life ?? 5;
      for (let i = 0; i < n; i++) {
        const c = p.library.shift();
        c.zone = 'life';
        c.faceUp = false;
        p.life.push(c);
      }
    }
  }

  async run() {
    await this.start();
    this.log('📜 Regla (6-5-6-1): NINGÚN jugador puede atacar en su primer turno — el primer ataque posible es en el turno 3. Además, quien empieza no roba y coloca solo 1 DON!! en su primer turno.');
    while (!this.over) await this.playTurn();
    return this.winner;
  }

  // ---- turno -------------------------------------------------------------

  async playTurn() {
    if (this.over) return;
    const p = this.activePlayer;
    this.turn++;
    if (this.turn > this.maxTurns) {
      // Desempate por vidas restantes (evita partidas eternas entre bots).
      const [a, b] = this.players;
      this.winner = a.life.length >= b.life.length ? a : b;
      this.over = true;
      this.log(`Límite de turnos: gana ${this.winner.name} por vidas.`);
      return;
    }
    this.log(`— Turno ${this.turn}: ${p.name} (vidas ${p.life.length}·${this.opponentOf(p).life.length}, mano ${p.hand.length}) —`);

    // 1. Refresh: los DON dados vuelven al área de coste; endereza todo.
    this.phase = 'refresh';
    for (const c of p.board()) {
      p.donActive += c.givenDon;
      c.givenDon = 0;
      // Congelado: permanece girado este refresco y se libera el marcador.
      if (c._frozenUntil === this.turn) c._frozenUntil = 0;
      else c.rested = false;
    }
    const frozenDon = Math.min(p._donFrozenNext ?? 0, p.donRested);
    p.donActive += p.donRested - frozenDon;
    p.donRested = frozenDon;
    if (frozenDon) this.log(`❄ ${frozenDon} DON!! de ${p.name} siguen girados este refresh.`);
    p._donFrozenNext = 0;

    // 2. Draw (el jugador inicial no roba en el turno 1).
    this.phase = 'draw';
    if (this.turn > 1) {
      this.draw(p, 1);
      if (this.over) return;
    }

    // 3. DON: coloca 2 (el jugador inicial solo 1 en su primer turno).
    this.phase = 'don';
    const gain = this.turn === 1 ? 1 : 2;
    const real = Math.min(gain, p.donDeck);
    p.donDeck -= real;
    p.donActive += real;
    // Sandbox: DON!! de sobra cada turno para poder probar cualquier carta.
    if (this.sandbox) p.donActive = Math.max(p.donActive, 10);

    // 4. Main.
    this.phase = 'main';
    if (p._restDonAtMain) {
      const nRest = Math.min(p._restDonAtMain, p.donActive);
      p.donActive -= nRest; p.donRested += nRest;
      if (nRest) this.log(`${p.name} gira ${nRest} DON!! (efecto rival).`);
      p._restDonAtMain = 0;
    }
    await this.mainPhase(p);
    if (this.over) return;

    // 5. End: habilidades [End of Your Turn] del jugador activo.
    await this.endPhase(p);
  }

  // Fase final del turno (también la usa el bot con búsqueda para "imaginar"
  // el cierre de su turno y el turno de respuesta del rival).
  async endPhase(p) {
    this.phase = 'end';
    for (const c of [...p.board()]) {
      await this.runTaggedAbilities(c, 'endOfTurn');
      if (this.over) return;
    }
    for (const q of this.players) {
      for (const c of q.board()) { c.cleanupEndOfTurn(); c.expireMods(this.turn); }
      if (q.stage) q.stage.expireMods(this.turn);
    }
    this.activeIdx = 1 - this.activeIdx;
  }

  async mainPhase(p) {
    let guard = 0;
    while (!this.over && guard++ < 100) {
      const action = await p.controller.mainAction(this);
      if (!action || action.type === 'pass') return;
      try {
        await this.performAction(p, action);
      } catch (err) {
        this.log(`(!) Acción inválida de ${p.name}: ${err.message}`);
      }
    }
  }

  // Acciones en JSON plano con referencias por id (serializables tal cual).
  async performAction(p, action) {
    switch (action.type) {
      case 'playCharacter': return this.playCharacter(p, action);
      case 'playStage': return this.playStage(p, action);
      case 'giveDon': return this.giveDon(p, action);
      case 'attack': return this.attack(p, action);
      case 'playEvent': return this.playEvent(p, action);
      case 'activate': return this.activateAbility(p, action);
      default: throw new Error(`acción desconocida ${action.type}`);
    }
  }

  // ---- habilidades -------------------------------------------------------

  canPayAbilityCost(p, source, cost) {
    if (!cost) return true;
    if (cost.donRest > p.donActive) return false;
    if (cost.donReturn > p.donActive + p.donRested) return false;
    if (cost.donReturnVar && p.donActive + p.donRested < 1) return false;
    if (cost.returnGivenDon && p.donGiven < cost.returnGivenDon) return false;
    if (cost.trashHand > p.hand.length) return false;
    if (cost.trashLife > p.life.length) return false;
    if (cost.lifeToHand > p.life.length) return false;
    if (cost.trashToBottom > p.trash.length) return false;
    if (cost.turnLifeDown && this.lifeFlipCandidates(p, cost.turnLifeEnds, true).length < cost.turnLifeDown) return false;
    if (cost.turnLifeUp && this.lifeFlipCandidates(p, cost.turnLifeEnds, false).length < cost.turnLifeUp) return false;
    if (cost.restSelf && source.rested) return false;
    if (cost.tuckSelf && source.zone !== 'characters') return false;
    if (cost.selfToDeckBottom && !['characters', 'stage'].includes(source.zone)) return false;
    if (cost.handToBottom > p.hand.length) return false;
    if (cost.tuckOwnN && p.characters.length < cost.tuckOwnN) return false;
    if (cost.tuckAny) {
      const oppT = this.opponentOf(p);
      const pool = [...p.characters, ...oppT.characters]
        .filter((c) => c.cost <= cost.tuckAny.maxCost && (c.owner === p || !this.isProtectedFromRemoval(c)));
      if (pool.length < cost.tuckAny.n) return false;
    }
    if (cost.restLeader && p.leader.rested) return false;
    if (cost.giveOppDon && (this.opponentOf(p).donRested < cost.giveOppDon || !this.opponentOf(p).characters.length)) return false;
    if (cost.giveActiveDon && (p.donActive < cost.giveActiveDon.n ||
      !p.characters.some((c) => this.matchesFilter(c, cost.giveActiveDon.filter)))) return false;
    if (cost.trashToBottomFilter && p.trash.filter((c) => this.matchesFilter(c, cost.trashToBottomFilter)).length < cost.trashToBottom) return false;
    if (cost.restLeaderOrDon && p.donActive < 1 && p.leader.rested) return false;
    if (cost.trashHandFilter && p.hand.filter((c) => this.matchesFilter(c, cost.trashHandFilter)).length < cost.trashHand) return false;
    // "rest N of your [X] cards" puede referirse a personajes, escenario o líder.
    if (cost.restOwn && [...p.characters, p.stage, p.leader].filter(Boolean)
      .filter((c) => !c.rested && this.matchesFilter(c, cost.restOwn.filter)).length < cost.restOwn.n) return false;
    if (cost.bounceOwn && p.characters.filter((c) => this.matchesFilter(c, cost.bounceOwn.filter)).length < cost.bounceOwn.n) return false;
    if (cost.charToLife && p.characters.filter((c) => this.matchesFilter(c, cost.charToLife.filter)).length < cost.charToLife.n) return false;
    if (cost.revealHand && p.hand.filter((c) => this.matchesFilter(c, cost.revealHand.filter)).length < cost.revealHand.n) return false;
    return true;
  }

  effectiveTrashHand(p, cost) { return cost?.trashHand ?? 0; }

  async payAbilityCost(p, source, cost, ctx = {}) {
    if (!cost) return;
    if (cost.donRest) { p.donActive -= cost.donRest; p.donRested += cost.donRest; }
    if (cost.donReturn) {
      let left = cost.donReturn;
      const fromActive = Math.min(left, p.donActive);
      p.donActive -= fromActive; left -= fromActive;
      p.donRested -= left;
      p.donDeck += cost.donReturn;
      this.log(`${p.name} devuelve ${cost.donReturn} DON!! a su mazo de DON.`);
    }
    if (cost.trashHand) {
      const ids = await p.controller.discardFromHand(this, cost.trashHand);
      for (const id of ids.slice(0, cost.trashHand)) {
        const c = this.byId(id);
        if (c && c.zone === 'hand' && c.owner === p) {
          this.trashFromHand(c);
          this.log(`${p.name} descarta ${c.name} como coste.`);
        }
      }
    }
    if (cost.trashLife) {
      // Descartar N cartas de tu Vida (de arriba o de abajo, si el texto lo permite).
      for (let i = 0; i < cost.trashLife && p.life.length; i++) {
        const idx = await this.pickLifeIndex(p, cost.trashLifePick);
        const c = p.life.splice(idx, 1)[0];
        c.zone = 'trash';
        c.faceUp = false;
        p.trash.push(c);
        this.log(`${p.name} descarta una carta de su Vida como coste (${c.name}). Vidas: ${p.life.length}.`);
      }
    }
    if (cost.donReturnVar) {
      // Devuelve al menos 1 DON!! (el bot/humano podría afinar; aquí 1).
      const back = Math.min(1, p.donActive + p.donRested);
      const fromActive = Math.min(back, p.donActive);
      p.donActive -= fromActive; p.donRested -= (back - fromActive); p.donDeck += back;
      this._donReturnedThisResolve = back;
      this.log(`${p.name} devuelve ${back} DON!! a su mazo de DON.`);
    }
    if (cost.returnGivenDon) {
      let need = cost.returnGivenDon;
      for (const c of p.board()) {
        while (need > 0 && c.givenDon > 0) { c.givenDon--; p.donRested++; need--; }
      }
      this.log(`${p.name} devuelve ${cost.returnGivenDon} DON!! dado(s) al área de coste (girados).`);
    }
    if (cost.lifeToHand) {
      for (let i = 0; i < cost.lifeToHand && p.life.length; i++) {
        const idx = await this.pickLifeIndex(p, cost.lifeToHandPick);
        const c = p.life.splice(idx, 1)[0]; c.zone = 'hand'; c.faceUp = false; p.hand.push(c);
        this.log(`${p.name} añade a la mano ${c.name} desde su Vida (Vida: ${p.life.length}).`);
      }
    }
    if (cost.restLeader && !p.leader.rested) {
      await this.restCard(p.leader);
      this.log(`${p.name} gira su líder como coste.`);
    }
    if (cost.giveOppDon) {
      const oppC = this.opponentOf(p);
      const moved = Math.min(cost.giveOppDon, oppC.donRested);
      if (moved && oppC.characters.length) {
        oppC.donRested -= moved;
        oppC.characters[0].givenDon += moved;
        this.log(`${moved} DON!! girado(s) de ${oppC.name} pasan a ${oppC.characters[0].name} (coste).`);
      }
    }
    if (cost.leaderPowerDown) {
      p.leader.addMod({ stat: 'power', delta: -cost.leaderPowerDown, expireTurn: this.turn });
      this.log(`${p.name} da -${cost.leaderPowerDown} a su líder este turno como coste.`);
    }
    if (cost.selfToDeckBottom && ['characters', 'stage'].includes(source.zone)) {
      if (source.zone === 'characters') { p.donActive += source.givenDon; source.givenDon = 0; p.characters.splice(p.characters.indexOf(source), 1); }
      else p.stage = null;
      source.zone = 'deck'; source.rested = false; p.library.push(source);
      this.log(`⤵ ${source.name} va al fondo del mazo como coste.`);
    }
    if (cost.handToBottom) {
      const ids = await p.controller.discardFromHand(this, cost.handToBottom, {});
      const chosen = (ids ?? []).map((id) => this.byId(id)).filter((c) => c && c.zone === 'hand' && c.owner === p).slice(0, cost.handToBottom);
      while (chosen.length < cost.handToBottom && p.hand.length > chosen.length) {
        const extra = p.hand.find((c) => !chosen.includes(c));
        if (!extra) break;
        chosen.push(extra);
      }
      for (const c of chosen) { p.hand.splice(p.hand.indexOf(c), 1); c.zone = 'deck'; p.library.push(c); }
      this.log(`${p.name} pone ${chosen.length} carta(s) de su mano al fondo del mazo como coste.`);
    }
    if (cost.tuckAny) {
      const oppT = this.opponentOf(p);
      for (let i = 0; i < cost.tuckAny.n; i++) {
        const pool = [...p.characters, ...oppT.characters]
          .filter((c) => c.cost <= cost.tuckAny.maxCost && (c.owner === p || !this.isProtectedFromRemoval(c)));
        if (!pool.length) break;
        const id = await p.controller.chooseTarget(this, { purpose: 'tuckBottom', candidateIds: pool.map((c) => c.id), optional: false });
        const t = this.byId(id) ?? pool[0];
        const q = t.owner;
        q.donActive += t.givenDon; t.givenDon = 0;
        q.characters.splice(q.characters.indexOf(t), 1);
        t.zone = 'deck'; t.rested = false; t.tempPower = 0; t.mods = [];
        q.library.push(t);
        this.log(`⤵ ${t.name} va al fondo del mazo de ${q.name} como coste.`);
      }
    }
    if (cost.tuckOwnN) {
      for (let i = 0; i < cost.tuckOwnN && p.characters.length; i++) {
        const id = await p.controller.chooseTarget(this, { purpose: 'tuckBottom', candidateIds: p.characters.map((c) => c.id), optional: false });
        const t = this.byId(id) ?? p.characters[0];
        p.donActive += t.givenDon; t.givenDon = 0;
        p.characters.splice(p.characters.indexOf(t), 1);
        t.zone = 'deck'; t.rested = false; p.library.push(t);
        this.log(`⤵ ${t.name} va al fondo del mazo como coste.`);
      }
    }
    if (cost.giveActiveDon) {
      const cands = p.characters.filter((c) => this.matchesFilter(c, cost.giveActiveDon.filter));
      if (cands.length && p.donActive >= cost.giveActiveDon.n) {
        const id = await p.controller.chooseTarget(this, { purpose: 'giveDon', candidateIds: cands.map((c) => c.id), optional: false });
        const t = this.byId(id) ?? cands[0];
        p.donActive -= cost.giveActiveDon.n;
        t.givenDon += cost.giveActiveDon.n;
        this.log(`${p.name} da ${cost.giveActiveDon.n} DON!! a ${t.name} como coste.`);
        await this.fireOnBoard(p, 'onDonGiven', { given: t });
      }
    }
    if (cost.tuckSelf && source.zone === 'characters') {
      p.donActive += source.givenDon; source.givenDon = 0;
      p.characters.splice(p.characters.indexOf(source), 1);
      source.zone = 'deck'; source.rested = false; p.library.push(source);
      this.log(`⤵ ${source.name} va al fondo del mazo como coste.`);
    }
    if (cost.trashToBottom) {
      const pool = cost.trashToBottomFilter ? p.trash.filter((c) => this.matchesFilter(c, cost.trashToBottomFilter)) : p.trash;
      for (let i = 0; i < cost.trashToBottom && pool.length; i++) {
        const c = pool.shift();
        p.trash.splice(p.trash.indexOf(c), 1);
        c.zone = 'deck'; p.library.push(c);
      }
      this.log(`${p.name} pone ${cost.trashToBottom} carta(s) del descarte al fondo del mazo.`);
    }
    if (cost.trashHandAny) {
      // "Trash any number of X cards": el jugador elige cuántas (incluso 0);
      // el número descartado alimenta multiplicadores "for every card trashed".
      const pool = p.hand.filter((c) => this.matchesFilter(c, cost.trashAnyFilter));
      let trashed = 0;
      if (pool.length) {
        const ids = await p.controller.discardFromHand(this, pool.length, { min: 0, fromIds: pool.map((c) => c.id) });
        for (const id of ids ?? []) {
          const c = this.byId(id);
          if (c && c.zone === 'hand' && c.owner === p && pool.includes(c)) {
            this.trashFromHand(c);
            trashed++;
            this.log(`${p.name} descarta ${c.name} como coste.`);
          }
        }
      }
      ctx.trashedNow = trashed;
    }
    if (cost.trashHandFilter) {
      const cands = p.hand.filter((c) => this.matchesFilter(c, cost.trashHandFilter)).slice(0, cost.trashHand);
      for (const c of cands) { this.trashFromHand(c); this.log(`${p.name} descarta ${c.name} como coste.`); }
    }
    if (cost.restOwn) {
      const pool = [...p.characters, p.stage, p.leader].filter(Boolean)
        .filter((c2) => !c2.rested && this.matchesFilter(c2, cost.restOwn.filter));
      for (const c of pool.slice(0, cost.restOwn.n)) {
        c.rested = true; this.log(`${p.name} gira ${c.name} como coste.`);
      }
    }
    if (cost.bounceOwn) {
      for (const c of p.characters.filter((c2) => this.matchesFilter(c2, cost.bounceOwn.filter)).slice(0, cost.bounceOwn.n)) {
        p.donActive += c.givenDon; c.givenDon = 0;
        p.characters.splice(p.characters.indexOf(c), 1);
        c.rested = false; c.tempPower = 0; c.mods = [];
        c.zone = 'hand'; p.hand.push(c);
        this.log(`${p.name} devuelve ${c.name} a su mano como coste.`);
      }
    }
    if (cost.charToLife) {
      for (const c of p.characters.filter((c2) => this.matchesFilter(c2, cost.charToLife.filter)).slice(0, cost.charToLife.n)) {
        p.donActive += c.givenDon; c.givenDon = 0;
        p.characters.splice(p.characters.indexOf(c), 1);
        c.rested = false; c.tempPower = 0; c.mods = []; c.faceUp = false;
        c.zone = 'life'; p.life.unshift(c);
        this.log(`${p.name} pone ${c.name} en lo alto de su Vida como coste (Vida: ${p.life.length}).`);
      }
    }
    if (cost.revealHand) {
      // Recuerda QUÉ se reveló: algunos efectos actúan sobre esas cartas.
      const pool = p.hand.filter((c) => this.matchesFilter(c, cost.revealHand.filter)).slice(0, cost.revealHand.n);
      ctx.revealedIds = pool.map((c) => c.id);
      this.log(`${p.name} revela como coste: ${pool.map((c) => c.name).join(', ') || 'nada'}.`);
    }
    if (cost.turnLifeDown) await this.flipLifeCards(p, cost.turnLifeDown, cost.turnLifeEnds, false);
    if (cost.turnLifeUp) await this.flipLifeCards(p, cost.turnLifeUp, cost.turnLifeEnds, true);
    if (cost.restLeaderOrDon) {
      // Coste alternativo: girar 1 DON!! (preferido) o girar tu líder.
      if (p.donActive >= 1) {
        p.donActive -= 1; p.donRested += 1;
        this.log(`${p.name} gira 1 DON!! como coste.`);
      } else {
        await this.restCard(p.leader);
        this.log(`${p.name} gira a su líder como coste.`);
      }
    }
    if (cost.restSelf) await this.restCard(source);
    if (cost.trashSelf) this.trashCard(source);
  }

  async playEvent(p, { cardId }) {
    const card = this.byId(cardId);
    if (!card || card.owner !== p || card.zone !== 'hand' || !card.isEvent) throw new Error('evento inválido');
    const main = abilitiesOf(card, 'main')[0];
    if (!main) throw new Error('el evento no tiene efecto [Main]');
    if (!this.canPayAbilityCost(p, card, main.cost)) throw new Error('coste no pagable');
    this.payDon(p, card.cost);
    p.hand.splice(p.hand.indexOf(card), 1);
    this.log(`${p.name} juega el evento ${card.name}.`);
    await this.narrate(p, { kind: 'event', card: card.name });
    const rctx = { source: card, p };
    await this.payAbilityCost(p, card, main.cost, rctx);
    if (this.costReturnsDon(main.cost)) await this.fireOnBoard(p, 'onDonReturn');
    await this.resolveOps(main.ops, rctx);
    card.zone = 'trash';
    p.trash.push(card);
    await this.fireOnBoard(p, 'onSelfEvent');
    await this.fireOnBoard(this.opponentOf(p), 'onOppEvent');
  }

  async activateAbility(p, { cardId }) {
    const card = this.byId(cardId);
    if (!card || card.owner !== p || !['characters', 'leader', 'stage'].includes(card.zone)) {
      throw new Error('carta inválida para activar');
    }
    const ab = abilitiesOf(card, 'activateMain')[0];
    if (!ab) throw new Error('sin habilidad [Activate: Main]');
    if (ab.once && card._activatedTurn === this.turn) throw new Error('ya activada este turno');
    if (ab.donX && card.givenDon < ab.donX) throw new Error(`requiere DON!! x${ab.donX}`);
    if (!this.canPayAbilityCost(p, card, ab.cost)) throw new Error('coste no pagable');
    card._activatedTurn = this.turn;
    this.log(`${p.name} activa ${card.name}.`);
    await this.narrate(p, { kind: 'ability', card: card.name });
    const rctx = { source: card, p };
    await this.payAbilityCost(p, card, ab.cost, rctx);
    if (this.costReturnsDon(ab.cost)) await this.fireOnBoard(p, 'onDonReturn');
    await this.resolveOps(ab.ops, rctx);
  }

  // Dispara un timing en todas las cartas del tablero de un jugador.
  async fireOnBoard(p, when, ctx = {}) {
    for (const c of [...p.board()]) {
      if (this.over) return;
      await this.runTaggedAbilities(c, when, ctx);
    }
  }

  costReturnsDon(cost) { return !!(cost && (cost.donReturn || cost.donReturnVar || cost.returnGivenDon)); }

  // Índices de la Vida elegibles para voltear: `ends` limita la posición
  // ('top' = solo la superior, 'both' = superior o inferior, 'any' = todas)
  // y `wantUp` filtra por el estado actual (voltear boca abajo exige boca arriba).
  lifeFlipCandidates(p, ends, wantUp) {
    const n = p.life.length;
    if (!n) return [];
    const idxs = ends === 'top' ? [0] : ends === 'both' ? [...new Set([0, n - 1])] : p.life.map((_, i) => i);
    return idxs.filter((i) => !!p.life[i].faceUp === wantUp);
  }

  // Voltea `count` cartas de Vida (coste): si ambos extremos valen, el dueño
  // elige. Boca arriba es información pública: se revela el nombre a ambos.
  async flipLifeCards(p, count, ends, toUp) {
    for (let i = 0; i < count; i++) {
      const cands = this.lifeFlipCandidates(p, ends, !toUp);
      if (!cands.length) break;
      let idx = cands[0];
      if (cands.length > 1 && ends === 'both') {
        const pick = await p.controller.chooseOption(this, {
          prompt: `¿Qué carta de tu Vida volteas boca ${toUp ? 'arriba' : 'abajo'}?`,
          options: ['La SUPERIOR', 'La INFERIOR'],
        });
        idx = pick === 1 ? cands[cands.length - 1] : cands[0];
      }
      const c = p.life[idx];
      c.faceUp = toUp;
      const pos = idx === 0 ? 'superior' : idx === p.life.length - 1 ? 'inferior' : `${idx + 1}ª`;
      if (toUp) this.log(`${p.name} voltea la carta ${pos} de su Vida boca arriba: ¡${c.name}!`);
      else this.log(`${p.name} voltea la carta ${pos} de su Vida boca abajo.`);
    }
  }

  // Elige el índice de la carta de Vida a usar. Cuando el efecto permite
  // "de arriba o de abajo", el dueño decide (a ciegas: no ve las cartas).
  async pickLifeIndex(player, pick) {
    if (!player.life.length) return -1;
    if (!pick || player.life.length < 2) return 0;
    const idx = await player.controller.chooseOption(this, {
      prompt: `Tu Vida (${player.life.length} cartas boca abajo): ¿cuál usas?`,
      options: ['La de ARRIBA', 'La de ABAJO'],
    });
    return idx === 1 ? player.life.length - 1 : 0;
  }

  async runTaggedAbilities(card, when, ctx = {}) {
    if (card._negatedUntil === this.turn) return;   // "negate the effect of ..."
    for (const ab of abilitiesOf(card, when)) {
      // "When this Character is KO'd by your opponent's effect": solo por efecto.
      if (ab.koByOppEffect && !ctx.byEffect) continue;
      // "When you play a <filtro> Character": la carta jugada debe cumplirlo.
      if (ab.playFilter && !(ctx.played && this.matchesFilter(ctx.played, ab.playFilter))) continue;
      // "When THIS card's attack deals damage...": solo si fue la atacante.
      if (ab.selfAttackOnly && ctx.attacker !== card) continue;
      // [On K.O.]: los DON dados ya volvieron al coste; usa los que tenía al morir.
      const effDon = when === 'onKO' ? (card._givenDonAtKO ?? card.givenDon) : card.givenDon;
      if (ab.donX && effDon < ab.donX) continue;
      if (ab.once && card._usedTurn?.[when] === this.turn) continue;
      const p = card.owner;
      if (ab.cost) {
        // Costes internos opcionales ("You may..."): se pagan si se puede.
        if (!this.canPayAbilityCost(p, card, ab.cost)) continue;
        const wants = await p.controller.payOptionalCost(this, { cardId: card.id, when });
        if (!wants) continue;
        const rctx = { source: card, p, ...ctx };
        await this.payAbilityCost(p, card, ab.cost, rctx);
        if (this.costReturnsDon(ab.cost) && when !== 'onDonReturn') await this.fireOnBoard(p, 'onDonReturn');
        (card._usedTurn ??= {})[when] = this.turn;
        await this.resolveOps(ab.ops, rctx);
        continue;
      }
      (card._usedTurn ??= {})[when] = this.turn;
      await this.resolveOps(ab.ops, { source: card, p, ...ctx });
    }
  }

  // ---- ejecutor de operaciones ------------------------------------------

  async resolveOps(ops, ctx) {
    const p = ctx.p;
    const opp = this.opponentOf(p);
    this._resolveDepth = (this._resolveDepth ?? 0) + 1;
    try {
    for (const op of ops) {
      if (this.over) return;
      // Traza de depuración (sandbox): registra cada op que llega a ejecutarse.
      if (this.opTrace) this.opTrace.push(op.op);
      // Sonda semántica del sandbox: verifica el efecto de la op anterior y
      // captura el estado previo de la siguiente.
      if (this.opProbe) this.opProbe(op, ctx);
      switch (op.op) {
        case 'giveRestedDon': {
          const give = Math.min(op.n, p.donRested);
          if (give <= 0) break;
          // "to your Leader" (sin personajes): el único destino es el líder.
          const cands = op.toSelf ? [ctx.source] : op.leaderOnly ? [p.leader] : p.board();
          const targetId = await p.controller.chooseTarget(this, {
            purpose: 'giveDon', candidateIds: cands.map((c) => c.id), optional: true,
          });
          const t = this.byId(targetId);
          if (t && t.owner === p) {
            const real = Math.min(op.n, p.donRested);
            p.donRested -= real;
            t.givenDon += real;
            this.log(`${p.name} da ${real} DON!! (girados) a ${t.name}.`);
          }
          break;
        }
        case 'donFromDeck': {
          const real = Math.min(op.n, p.donDeck);
          p.donDeck -= real;
          if (op.active) p.donActive += real; else p.donRested += real;
          if (real) this.log(`${p.name} añade ${real} DON!! ${op.active ? 'activo(s)' : 'girado(s)'}.`);
          break;
        }
        case 'unrestDon': {
          if (p._noDonUnrestTurn === this.turn && ctx.source?.isCharacter) { this.log(`${p.name} no puede enderezar DON!! (restricción).`); break; }
          const real = Math.min(op.n, p.donRested);
          p.donRested -= real;
          p.donActive += real;
          if (real) this.log(`${p.name} endereza ${real} DON!!.`);
          break;
        }
        case 'restOppDon': {
          const real = Math.min(op.n, opp.donActive);
          opp.donActive -= real;
          opp.donRested += real;
          if (real) this.log(`${opp.name} gira ${real} DON!!.`);
          break;
        }
        case 'buff': {
          const expireTurn = op.dur === 'next' ? this.turn + 1 : this.turn;
          const inBattle = op.dur === 'battle';
          const owner = op.side === 'opp' ? opp : p;
          const factor = this.perFactor(op.per, p, ctx);
          const poolAll = () => {
            let arr;
            if (op.scope === 'leader') arr = [owner.leader];
            else if (op.scope === 'leaderChar') arr = [owner.leader, ...owner.characters];
            else arr = [...owner.characters];
            return arr.filter(Boolean).filter((c) => this.matchesFilter(c, op.filter));
          };
          const label = () => {
            const parts = op.changes.filter(() => factor > 0)
              .map((ch) => `${ch.delta * factor >= 0 ? '+' : ''}${ch.delta * factor} ${ch.stat === 'power' ? 'poder' : 'coste'}`);
            for (const kw of op.kws) parts.push(`[${kw}]`);
            return parts.join(' y ');
          };
          const apply = (t) => {
            for (const ch of op.changes) if (factor > 0) t.addMod({ stat: ch.stat, delta: ch.delta * factor, expireTurn, battle: inBattle });
            for (const kw of op.kws) t.addMod({ stat: 'kw', kw, expireTurn, battle: inBattle });
            const lbl = label();
            if (lbl) this.log(`${t.name} recibe ${lbl} (${t.power(this)}).`);
          };
          if (op.all) { poolAll().forEach(apply); break; }
          const chosen = new Set();
          const purpose = op.side === 'opp'
            ? (op.changes.some((c) => c.stat === 'cost') ? 'costDown' : 'powerDown')
            : 'powerUp';
          for (let i = 0; i < op.targets; i++) {
            const cands = poolAll().filter((c) => !chosen.has(c.id));
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, {
              purpose, candidateIds: cands.map((c) => c.id), optional: true, battle: ctx.battle ?? null,
            });
            const t = this.byId(id);
            if (t && cands.includes(t)) { chosen.add(t.id); apply(t); }
          }
          break;
        }
        case 'selfGrant': {
          if (op.static) break;   // las estáticas se evalúan en staticPowerFor/staticCostFor
          const expireTurn = op.dur === 'next' ? this.turn + 1 : this.turn;
          const inBattle = op.dur === 'battle';
          const t = op.target === 'leader' ? p.leader : ctx.source;
          const f = this.perFactor(op.per, p, ctx);
          for (const ch of op.changes) if (f > 0) t.addMod({ stat: ch.stat, delta: ch.delta * f, expireTurn, battle: inBattle });
          for (const kw of op.kws) t.addMod({ stat: 'kw', kw, expireTurn, battle: inBattle });
          const parts = op.changes.filter(() => f > 0)
            .map((c) => `${c.delta * f >= 0 ? '+' : ''}${c.delta * f} ${c.stat === 'power' ? 'poder' : 'coste'}`)
            .concat(op.kws.map((k) => `[${k}]`));
          if (parts.length) this.log(`${t.name} gana ${parts.join(' y ')} (${t.power(this)}).`);
          break;
        }
        case 'powerUp': {
          for (let i = 0; i < (op.targets ?? 1); i++) {
            const cands = p.board().filter((c) => !(op.other && c === ctx.source));
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'powerUp', n: op.n, candidateIds: cands.map((c) => c.id),
              optional: true, battle: ctx.battle ?? null,
            });
            const t = this.byId(targetId);
            if (t && t.owner === p) {
              t.tempPower += op.n;
              this.log(`${t.name} gana +${op.n} (${t.power(this)}).`);
            }
          }
          break;
        }
        case 'ko': {
          if (op.scope === 'self') { this.log(`💥 ${ctx.source.name} se va al descarte.`); this.trashCard(ctx.source); break; }
          const pool = () => {
            const base = op.scope === 'all' ? [...p.characters, ...opp.characters] : [...opp.characters];
            return base.filter((c) =>
              this.matchesFilter(c, op.filter) &&
              (!op.restedOnly || c.rested) && (!op.activeOnly || !c.rested) &&
              (!op.blockerOnly || c.hasBlocker) &&
              this.canBeKOd(c, { byEffect: true }));
          };
          if (op.all) {
            const dead = pool();
            for (const c of dead) { this.log(`💥 ${c.name} es KO por efecto.`); this.koCharacter(c); }
            for (const c of dead) await this.runTaggedAbilities(c, 'onKO');
            if (dead.length) await this.fireOnCharKO();
            break;
          }
          let anyKO = false;
          for (let i = 0; i < op.targets; i++) {
            const cands = pool();
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'ko', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) {
              if (await this.tryPreventKO(t, { byEffect: true })) continue;
              this.log(`💥 ${t.name} es KO por efecto.`); this.koCharacter(t); anyKO = true;
              await this.runTaggedAbilities(t, 'onKO');   // [On K.O.] de la víctima
            }
          }
          if (anyKO) await this.fireOnCharKO();
          // "...and add this card to your hand" (la propia carta del efecto).
          if (op.thenSelfToHand && ctx.source && ctx.source.owner === p) {
            const c = ctx.source;
            for (const z of [p.trash, p.characters, p.life]) {
              const i = z.indexOf(c); if (i !== -1) z.splice(i, 1);
            }
            c.zone = 'hand';
            p.hand.push(c);
            this.log(`${p.name} añade ${c.name} a su mano.`);
          }
          break;
        }
        case 'bounce': case 'tuckBottom': {
          for (let i = 0; i < op.targets; i++) {
            const pool = op.side === 'opp' ? [...opp.characters] : [...opp.characters, ...p.characters];
            const cands = pool.filter((c) => c.cost <= (op.maxCost ?? 99) &&
              (op.maxPower == null || c.power(this) <= op.maxPower) &&
              this.matchesFilter(c, op.filter) &&
              (c.owner === p || !this.isProtectedFromRemoval(c)));
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: op.op, candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (!t || !cands.includes(t)) break;
            const q = t.owner;
            q.donActive += t.givenDon; t.givenDon = 0;
            q.characters.splice(q.characters.indexOf(t), 1);
            t.rested = false; t.tempPower = 0;
            if (op.op === 'bounce') {
              t.zone = 'hand'; q.hand.push(t);
              this.log(`↩ ${t.name} vuelve a la mano de ${q.name}.`);
              ctx.lastReturned = t;
              if (q !== p) await this.fireOnBoard(p, 'onOppBounced', { bounced: t });
            } else {
              t.zone = 'deck'; q.library.push(t);
              this.log(`⤵ ${t.name} va al fondo del mazo de ${q.name}.`);
            }
          }
          break;
        }
        case 'restTarget': {
          for (let i = 0; i < op.targets; i++) {
            let cands = [...opp.characters];
            if (op.includeLeader && opp.leader) cands.push(opp.leader);
            if (op.includeStage && opp.stage) cands.push(opp.stage);
            cands = cands.filter((c) => !c.rested && (!op.blockerOnly || c.hasBlocker) && this.matchesFilter(c, op.filter) && !(c._noRestUntil >= this.turn) && !this.cardHasStatic(c, 'cannotRestOpp'));
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) { await this.restCard(t); p._restedByEffectTurn = this.turn; this.log(`${t.name} queda girado.`); }
          }
          break;
        }
        case 'unrestChar': {
          const okCand = (c) => c.rested && this.matchesFilter(c, op.filter) &&
            (op.maxCost == null || c.cost <= op.maxCost);
          if (op.all) { for (const c of p.characters.filter(okCand)) { c.rested = false; this.log(`${c.name} se endereza.`); } break; }
          for (let i = 0; i < op.targets; i++) {
            const cands = p.characters.filter(okCand);
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'unrest', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) {
              t.rested = false;
              ctx.lastTargetId = t.id;   // "That Character gains..." apunta aquí
              this.log(`${t.name} se endereza.`);
            }
          }
          break;
        }
        case 'grantToLast': {
          const t = this.byId(ctx.lastTargetId);
          if (!t) break;
          const expireTurn = op.dur === 'next' ? this.turn + 1 : this.turn;
          const inBattle = op.dur === 'battle';
          for (const ch of op.changes) t.addMod({ stat: ch.stat, delta: ch.delta, expireTurn, battle: inBattle });
          for (const kw of op.kws) t.addMod({ stat: 'kw', kw, expireTurn, battle: inBattle });
          this.log(`${t.name} gana ${op.changes.map((c) => `${c.delta >= 0 ? '+' : ''}${c.delta} ${c.stat === 'power' ? 'poder' : 'coste'}`).concat(op.kws.map((k) => `[${k}]`)).join(' y ')}.`);
          break;
        }
        case 'redirectAttack': {
          if (!ctx.battle) break;
          const cands = [p.leader, ...p.characters].filter(Boolean)
            .filter((c) => this.matchesFilter(c, op.filter));
          if (!cands.length) break;
          const id = await p.controller.chooseTarget(this, {
            purpose: 'redirect', candidateIds: cands.map((c) => c.id), optional: true,
          });
          const t = this.byId(id);
          if (t && cands.includes(t)) {
            ctx.battle.redirectTo = t.id;
            this.log(`🔁 El objetivo del ataque pasa a ser ${t.name}.`);
          }
          break;
        }
        case 'unrestSelf': {
          ctx.source.rested = false;
          this.log(`${ctx.source.name} se endereza.`);
          break;
        }
        case 'bounceSelf': {
          const c = ctx.source; const q = c.owner;
          if (c.zone === 'characters') {
            q.donActive += c.givenDon; c.givenDon = 0;
            q.characters.splice(q.characters.indexOf(c), 1);
            c.rested = false; c.tempPower = 0; c.mods = [];
            c.zone = 'hand'; q.hand.push(c);
            this.log(`↩ ${c.name} vuelve a la mano de ${q.name}.`);
          }
          break;
        }
        case 'bounceOwn': {
          const cands = p.characters.filter((c) => this.matchesFilter(c, op.filter));
          const list = op.all ? cands : cands.slice(0, op.targets ?? 1);
          for (const t of [...list]) {
            p.donActive += t.givenDon; t.givenDon = 0;
            p.characters.splice(p.characters.indexOf(t), 1);
            t.rested = false; t.tempPower = 0; t.mods = [];
            t.zone = 'hand'; p.hand.push(t);
            this.log(`↩ ${t.name} vuelve a tu mano.`);
          }
          // Alimenta multiplicadores "for every returned Character".
          ctx.returnedNow = (ctx.returnedNow ?? 0) + list.length;
          break;
        }
        case 'oppDiscard': {
          for (let i = 0; i < op.n && opp.hand.length; i++) {
            let id;
            if (op.oppChooses) {
              const ids = await opp.controller.discardFromHand(this, 1);
              id = ids[0];
            } else {
              // El defensor elige qué descartar salvo que sea "aleatorio"; en la
              // práctica siempre elige el dueño de la carta.
              const ids = await opp.controller.discardFromHand(this, 1);
              id = ids[0];
            }
            const c = this.byId(id) ?? opp.hand[0];
            if (c && c.zone === 'hand' && c.owner === opp) { this.trashFromHand(c); this.log(`${opp.name} descarta ${c.name}.`); }
          }
          break;
        }
        case 'canAttackActive': { ctx.source._canAttackActive = true; break; }
        case 'freeze': {
          if (op.restedOnly) {
            let left = op.targets;
            if (op.includeLeader && opp.leader?.rested && !opp.leader._frozenUntil && left > 0) {
              opp.leader._frozenUntil = this.turn + 1; left--;
              this.log(`❄ ${opp.leader.name} (líder) no se enderezará en el próximo refresco.`);
            }
            for (const c of opp.characters.filter((x) => x.rested && !x._frozenUntil).slice(0, left)) {
              c._frozenUntil = this.turn + 1;
              this.log(`❄ ${c.name} no se enderezará en el próximo refresco.`);
            }
            break;
          }
          // "Select your opponent's rested Leader and ...": el líder también.
          if (op.includeLeader && opp.leader?.rested && !opp.leader._frozenUntil) {
            opp.leader._frozenUntil = this.turn + 1;
            this.log(`${opp.leader.name} (líder) no se enderezará en el próximo refresco.`);
          }
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters.filter((c) => this.matchesFilter(c, op.filter) && !c._frozenUntil && !(c._noRestUntil >= this.turn));
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { await this.restCard(t); t._frozenUntil = this.turn + 1; this.log(`${t.name} no se enderezará en el próximo refresco del rival.`); }
          }
          break;
        }
        case 'cannotAttack': {
          const until = op.dur === 'turn' ? this.turn : this.turn + 1;
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters.filter((c) => this.matchesFilter(c, op.filter) &&
              (!op.filter?.activeOnly || !c.rested) && (!op.filter?.restedOnly || c.rested) &&
              (c._cannotAttackUntil ?? 0) < until);
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { t._cannotAttackUntil = until; this.log(`${t.name} no podrá atacar ${op.dur === 'turn' ? 'este turno' : 'hasta el próximo turno del rival'}.`); }
          }
          break;
        }
        case 'noBlockerGroup': { if (ctx.battle) ctx.battle.noBlocker = { minPower: 0 }; break; }
        case 'setBasePower': {
          const t = op.who === 'leader' ? p.leader : ctx.source;
          const expireTurn = op.dur === 'next' ? this.turn + 1 : this.turn;
          const delta = op.value - (t.data.power ?? 0);
          t.addMod({ stat: 'power', delta, expireTurn });
          this.log(`${t.name}: poder base pasa a ${op.value} (${t.power(this)}).`);
          break;
        }
        case 'selfCost': { ctx.source.tempCost += op.delta; this.log(`${ctx.source.name}: coste ${op.delta >= 0 ? '+' : ''}${op.delta} (ahora ${ctx.source.cost}).`); break; }
        case 'selfDiscard': {
          const ids = await p.controller.discardFromHand(this, op.n, op.upTo ? { min: 0 } : {});
          for (const id of ids.slice(0, op.n)) { const c = this.byId(id); if (c && c.zone === 'hand' && c.owner === p) { this.trashFromHand(c); this.log(`${p.name} descarta ${c.name}.`); } }
          break;
        }
        case 'trashThenDraw': {
          const ids = await p.controller.discardFromHand(this, op.trash);
          for (const id of ids.slice(0, op.trash)) { const c = this.byId(id); if (c && c.zone === 'hand' && c.owner === p) this.trashFromHand(c); }
          this.draw(p, op.n);
          break;
        }
        case 'trashAnyNow': {
          const pool = p.hand.filter((c) => this.matchesFilter(c, op.filter));
          let trashed = 0;
          if (pool.length) {
            const ids = await p.controller.discardFromHand(this, pool.length, { min: 0, fromIds: pool.map((c) => c.id) });
            for (const id of ids ?? []) {
              const c = this.byId(id);
              if (c && c.zone === 'hand' && c.owner === p && pool.includes(c)) {
                this.trashFromHand(c);
                trashed++;
                this.log(`${p.name} descarta ${c.name}.`);
              }
            }
          }
          ctx.trashedNow = (ctx.trashedNow ?? 0) + trashed;
          break;
        }
        case 'ownChoose': {
          const idx = await p.controller.chooseOption(this, {
            prompt: 'Elige una opción:', options: op.options.map((o) => this.describeOps(o)),
          });
          const chosen = op.options[Math.max(0, Math.min(idx ?? 0, op.options.length - 1))];
          await this.resolveOps(chosen, ctx);
          break;
        }
        case 'trashOppLife': {
          for (let i = 0; i < op.n && opp.life.length; i++) {
            const c = opp.life.shift();
            c.zone = 'trash';
            c.faceUp = false;
            opp.trash.push(c);
            this.log(`☠ ${opp.name} pierde 1 vida al descarte (${c.name}). Le quedan ${opp.life.length}.`);
          }
          if (!opp.life.length) { /* siguiente golpe gana; no elimina por sí solo */ }
          break;
        }
        case 'draw': {
          if (op.ifHandMax !== null && op.ifHandMax !== undefined && p.hand.length > op.ifHandMax) break;
          let nDraw = op.n;
          if (op.upTo && !p.isBot) {
            const pick = await p.controller.chooseOption(this, {
              prompt: `¿Cuántas cartas robas (hasta ${op.n})?`,
              options: Array.from({ length: op.n + 1 }, (_, i) => `${i}`),
            });
            nDraw = Math.max(0, Math.min(op.n, pick ?? op.n));
          }
          this.draw(p, nDraw);
          if (this.over) return;
          if (op.trash) {
            const ids = await p.controller.discardFromHand(this, op.trash);
            for (const id of ids.slice(0, op.trash)) {
              const c = this.byId(id);
              if (c && c.zone === 'hand' && c.owner === p) {
                this.trashFromHand(c);
                this.log(`${p.name} descarta ${c.name}.`);
              }
            }
          }
          break;
        }
        case 'tutorTop': {
          const seen = p.library.splice(0, Math.min(op.n, p.library.length));
          if (!seen.length) break;
          const f = op.filter ?? (op.type ? { types: [op.type] } : {});
          const matches = (c) => {
            if (f.names && !f.names.some((nm) => c.name.toLowerCase().includes(nm.toLowerCase()))) return false;
            if (f.notName && c.name.toLowerCase().includes(f.notName.toLowerCase())) return false;
            if (f.types && !f.types.some((t) => (c.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase())))) return false;
            if (f.cardType && c.type !== f.cardType) return false;
            if (f.power !== undefined && (c.data.power ?? -1) !== f.power) return false;
            if (f.maxCost !== undefined && c.cost > f.maxCost) return false;
            return true;
          };
          const pickable = seen.filter(matches);
          this.log(`${p.name} mira ${seen.length} carta(s): ${seen.map((c) => c.name).join(', ')}.`);
          // El jugador ve TODAS las reveladas y elige 1 de entre las que cumplen.
          const chosenIds = await p.controller.chooseRevealed(this, {
            revealedIds: seen.map((c) => c.id),
            pickableIds: pickable.map((c) => c.id),
            min: 0, max: op.take ?? 1,
            prompt: pickable.length
              ? `Añade hasta ${op.take ?? 1} a tu mano; el resto irá al fondo del mazo.`
              : 'Ninguna cumple los requisitos; todas irán al fondo del mazo.',
          });
          const chosen = (chosenIds ?? []).map((id) => this.byId(id)).filter((c) => c && seen.includes(c) && pickable.includes(c));
          for (const c of chosen) {
            seen.splice(seen.indexOf(c), 1);
            c.zone = 'hand'; p.hand.push(c);
            this.log(`${p.name} añade ${c.name} a su mano.`);
          }
          if (!chosen.length) this.log(`${p.name} no añade ninguna carta.`);
          // El resto va al fondo del mazo (en el orden revelado).
          for (const c of seen) { c.zone = 'deck'; p.library.push(c); }
          break;
        }
        case 'powerDown': {
          for (let i = 0; i < (op.targets ?? 1); i++) {
            const cands = opp.characters.filter((c) => c.power(this) > -5000);
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'powerDown', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && t.owner === opp) {
              t.tempPower -= op.n;
              this.log(`${t.name} pierde ${op.n} de poder (${t.power(this)}).`);
            }
          }
          break;
        }
        case 'costDown': {
          for (let i = 0; i < (op.targets ?? 1); i++) {
            const cands = opp.characters;
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'costDown', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && t.owner === opp) {
              t.tempCost -= op.n;
              this.log(`${t.name} reduce su coste en ${op.n} (${t.cost}).`);
            }
          }
          break;
        }
        case 'ifCond': {
          if (this.evalCond(op.cond, ctx)) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'ifOppLife': {
          if (opp.life.length <= op.max) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'ifYouHaveChar': {
          const ok = p.characters.filter((c) =>
            op.dir === 'more' ? (c.data.cost ?? 0) >= op.cost : (c.data.cost ?? 0) <= op.cost).length >= op.count;
          if (ok) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'ifDon': {
          if (p.donActive + p.donRested >= op.min) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'revealPlay': {
          if (!p.library.length) break;
          const c = p.library[0];
          const okType = (!op.filter?.cardType || c.type === op.filter.cardType) &&
            (op.maxCost === null || c.cost <= op.maxCost) &&
            (!op.filter?.types || op.filter.types.some((t) => (c.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase()))));
          this.log(`${p.name} revela ${c.name}.`);
          if (okType && c.isCharacter && await this.makeRoom(p, c)) {
            p.library.shift();
            c.zone = 'characters'; c.rested = false; c.summonedThisTurn = true;
            p.characters.push(c);
            this.log(`${p.name} pone en juego ${c.name} gratis.`);
            await this.runTaggedAbilities(c, 'onPlay');
          } else {
            p.library.shift();
            c.zone = 'hand'; p.hand.push(c);
            this.log(`${p.name} añade ${c.name} a su mano.`);
          }
          break;
        }
        case 'lifeToHand': {
          if (p._noLifeToHandTurn === this.turn) { this.log(`${p.name} no puede añadir Vidas a su mano este turno.`); break; }
          for (let i = 0; i < op.n && p.life.length; i++) {
            const idx = await this.pickLifeIndex(p, op.pick);
            const c = p.life.splice(idx, 1)[0];
            c.zone = 'hand';
            c.faceUp = false;
            p.hand.push(c);
            this.log(`${p.name} añade ${c.name} de su Vida a la mano. Le quedan ${p.life.length}.`);
          }
          break;
        }
        case 'deckToLife': {
          for (let i = 0; i < op.n && p.library.length; i++) {
            const c = p.library.shift();
            c.zone = 'life';
            c.faceUp = false;
            p.life.unshift(c);
            this.log(`${p.name} pone la carta superior del mazo en su Vida (${p.life.length}).`);
          }
          break;
        }
        case 'handToLife': {
          // Elige una carta de la mano que cumpla el filtro (el jugador decide).
          const f = op.filter ?? {};
          const cands = p.hand.filter((c) =>
            (!f.cardType || c.type === f.cardType) &&
            (f.maxCost === undefined || c.cost <= f.maxCost) &&
            (f.names === undefined || f.names.some((nm) => c.name.toLowerCase().includes(nm.toLowerCase()))) &&
            (f.power === undefined || (c.data.power ?? -1) === f.power));
          if (!cands.length) break;
          const id = await p.controller.chooseTarget(this, {
            purpose: 'toLife', candidateIds: cands.map((c) => c.id), optional: true,
          });
          const cand = this.byId(id);
          if (cand && cand.zone === 'hand' && cand.owner === p) {
            p.hand.splice(p.hand.indexOf(cand), 1);
            cand.zone = 'life';
            cand.faceUp = !!op.faceUp;
            p.life.unshift(cand);
            this.log(`${p.name} pone ${cand.name} en lo alto de su Vida (ahora ${p.life.length}).`);
          }
          break;
        }
        case 'lifeAddFromDeck': {
          for (let i = 0; i < op.n && p.library.length; i++) {
            const c = p.library.shift();
            c.zone = 'life';
            c.faceUp = false;
            p.life.unshift(c);
          }
          this.log(`${p.name} añade ${op.n} carta(s) del mazo a lo alto de su Vida (ahora ${p.life.length}).`);
          break;
        }
        case 'lifeToTopDeck': {
          if (!p.life.length) break;
          // Miras tus vidas y colocas una en lo alto del mazo.
          const id = await p.controller.chooseTarget(this, {
            purpose: 'lifeToDeck', candidateIds: p.life.map((c) => c.id), optional: true,
          });
          const c = this.byId(id) ?? p.life[0];
          if (c && p.life.includes(c)) {
            p.life.splice(p.life.indexOf(c), 1);
            c.zone = 'deck';
            c.faceUp = false;
            p.library.unshift(c);
            this.log(`${p.name} pone una carta de su Vida en lo alto del mazo (Vida: ${p.life.length}).`);
          }
          break;
        }
        case 'revealTopThen': {
          if (!p.library.length) break;
          const c = p.library[0];
          ctx.lastRevealed = c;
          this.log(`${p.name} revela ${c.name}.`);
          const ok = this.matchesFilter(c, op.filter) ||
            (op.filter.types && op.filter.types.some((t) => (c.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase()))));
          if (ok) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'revealLifePlay': {
          if (!p.life.length) break;
          const c = p.life[0];
          this.log(`${p.name} revela de su Vida: ${c.name}.`);
          const ok = this.matchesFilter(c, op.filter) && c.cost <= (op.maxCost ?? 99) && c.isCharacter;
          if (ok) {
            const wants = p.isBot ? true : await p.controller.chooseOption(this, { prompt: `¿Jugar ${c.name} desde tu Vida?`, options: ['Sí, jugarla', 'No'] }) === 0;
            if (wants && await this.makeRoom(p, c)) {
              p.life.shift();
              c.zone = 'characters'; c.faceUp = false; c.rested = false; c.summonedThisTurn = true; c.enteredTurn = this.turn;
              p.characters.push(c);
              ctx.didPlay = true;
              this.log(`${p.name} juega ${c.name} desde su Vida.`);
              await this.runTaggedAbilities(c, 'onPlay');
            }
          }
          break;
        }
        case 'lookAddToLife': {
          const seen = p.library.splice(0, Math.min(op.n, p.library.length));
          const hit = seen.find((c) => this.matchesFilter(c, op.filter));
          if (hit) { seen.splice(seen.indexOf(hit), 1); hit.zone = 'life'; hit.faceUp = !!op.faceUp; p.life.unshift(hit); this.log(`${p.name} añade ${hit.name} a lo alto de su Vida (${p.life.length}).`); }
          this.shuffle(seen); p.library.push(...seen);
          break;
        }
        case 'lifeReorder': { this.log(`${p.name} mira y reordena sus cartas de Vida.`); break; }
        case 'trashOwnLife': {
          for (let i = 0; i < op.n && p.life.length; i++) {
            const c = p.life.shift();
            c.zone = 'trash';
            c.faceUp = false;
            p.trash.push(c);
            this.log(`${p.name} trashea la carta superior de su Vida (${c.name}). Vidas: ${p.life.length}.`);
          }
          break;
        }
        case 'cannotKOAll': {
          p._noKOTurn = this.turn;
          this.log(`🛡 Los personajes de ${p.name} no pueden ser KO este turno.`);
          break;
        }
        case 'revealedToDeckTop': {
          for (const id of ctx.revealedIds ?? []) {
            const c = this.byId(id);
            if (c && c.zone === 'hand' && c.owner === p) {
              p.hand.splice(p.hand.indexOf(c), 1);
              c.zone = 'deck';
              p.library.unshift(c);
              this.log(`${p.name} pone ${c.name} (revelada) en lo alto de su mazo.`);
            }
          }
          break;
        }
        case 'handToDeck': {
          const ids = await p.controller.discardFromHand(this, op.n, { min: Math.min(op.n, p.hand.length) });
          for (const id of (ids ?? []).slice(0, op.n)) {
            const c = this.byId(id);
            if (c && c.zone === 'hand' && c.owner === p) {
              p.hand.splice(p.hand.indexOf(c), 1);
              c.zone = 'deck';
              if (op.top) p.library.unshift(c); else p.library.push(c);
              this.log(`${p.name} pone 1 carta de su mano ${op.top ? 'en lo alto' : 'al fondo'} del mazo.`);
            }
          }
          break;
        }
        case 'lifeScryOpp': {
          if (opp.life.length) {
            const toBottom = await p.controller.chooseOption(this, {
              prompt: `Carta superior de la Vida de ${opp.name}: ¿al fondo?`,
              options: ['Dejar arriba', 'Al fondo'],
            });
            if (toBottom === 1) opp.life.push(opp.life.shift());
            this.log(`${p.name} escruta la Vida de ${opp.name}.`);
          }
          break;
        }
        case 'lifeScryEither': {
          const side = await p.controller.chooseOption(this, { prompt: '¿Mirar tu Vida o la del rival?', options: ['Tu Vida', 'La del rival'] });
          const who = side === 1 ? opp : p;
          if (who.life.length) {
            const toBottom = await p.controller.chooseOption(this, { prompt: `Carta superior de la Vida de ${who.name}: ¿al fondo?`, options: ['Dejar arriba', 'Al fondo'] });
            if (toBottom === 1) { who.life.push(who.life.shift()); }
          }
          this.log(`${p.name} escruta una Vida.`);
          break;
        }
        case 'cardsToLifeFromZone': {
          for (let i = 0; i < op.n; i++) {
            const zones = op.from === 'trash' ? [p.trash] : op.from === 'handTrash' ? [p.hand, p.trash] : [p.hand];
            const cands = zones.flat().filter((c) => this.matchesFilter(c, op.filter));
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'toLife', candidateIds: cands.map((c) => c.id), optional: true });
            const c = this.byId(id);
            if (!c || !cands.includes(c)) break;
            const zone = c.zone === 'trash' ? p.trash : p.hand;
            zone.splice(zone.indexOf(c), 1);
            c.zone = 'life'; c.faceUp = !!op.faceUp; p.life.unshift(c);
            this.log(`${p.name} pone ${c.name} en lo alto de su Vida (${p.life.length}).`);
          }
          break;
        }
        case 'charToLifeEffect': {
          const src = op.side === 'opp' ? opp : p;
          const anySide = op.side === 'any';
          for (let i = 0; i < op.targets; i++) {
            const cands = (anySide ? [...p.characters, ...opp.characters] : src.characters)
              .filter((c) => this.matchesFilter(c, op.filter) && (c.owner === p || !this.isProtectedFromRemoval(c)));
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: op.side === 'opp' ? 'ko' : 'toLife', candidateIds: cands.map((c) => c.id), optional: true });
            const c = this.byId(id);
            if (!c || !cands.includes(c)) break;
            const q = c.owner;
            q.donActive += c.givenDon; c.givenDon = 0;
            q.characters.splice(q.characters.indexOf(c), 1);
            c.rested = false; c.tempPower = 0; c.mods = [];
            c.zone = 'life'; c.faceUp = !!op.faceUp; q.life.unshift(c);
            this.log(`${c.name} pasa a lo alto de la Vida de ${q.name} (${q.life.length}).`);
          }
          break;
        }
        case 'trashFaceUpLife': {
          const ups = p.life.filter((c) => c.faceUp);
          for (const c of ups) {
            p.life.splice(p.life.indexOf(c), 1);
            c.zone = 'trash'; c.faceUp = false; p.trash.push(c);
          }
          this.log(`${p.name} trashea sus ${ups.length} carta(s) de Vida boca arriba.`);
          break;
        }
        case 'activationWindow': break;   // ventana de activación: informativa
        case 'taunt': {
          p._tauntUntil = this.turn + 1;
          p._tauntName = op.name;
          this.log(`🧲 El rival solo podrá atacar a [${op.name}] mientras esté en juego.`);
          break;
        }
        case 'wheelReturn': {
          ctx.wheelCount = p.hand.length;
          for (const c of [...p.hand]) { c.zone = 'deck'; p.library.push(c); }
          p.hand = [];
          this.shuffle(p.library);
          this.log(`${p.name} devuelve su mano (${ctx.wheelCount}) al mazo y baraja.`);
          break;
        }
        case 'wheelDraw': {
          this.draw(p, ctx.wheelCount ?? 0);
          break;
        }
        case 'restSelfEffect': {
          if (!ctx.source.rested) { await this.restCard(ctx.source); this.log(`${ctx.source.name} se gira.`); }
          break;
        }
        case 'tuckAllLowCost': {
          for (const q of this.players) {
            for (const c of [...q.characters].filter((x) => x.cost <= op.maxCost && (x.owner === p || !this.isProtectedFromRemoval(x)))) {
              q.donActive += c.givenDon; c.givenDon = 0;
              q.characters.splice(q.characters.indexOf(c), 1);
              c.zone = 'deck'; c.rested = false; q.library.push(c);
              this.log(`⤵ ${c.name} va al fondo del mazo.`);
            }
          }
          break;
        }
        case 'oppTrashToDeck': {
          for (let i = 0; i < op.n && opp.trash.length; i++) {
            const c = opp.trash.shift();
            c.zone = 'deck'; opp.library.push(c);
          }
          this.log(`${opp.name} pone ${Math.min(op.n, 99)} carta(s) de su descarte al fondo de su mazo.`);
          break;
        }
        case 'restOppMixed': {
          let left = op.n;
          for (const c of opp.characters.filter((x) => !x.rested)) {
            if (left <= 0) break;
            await this.restCard(c); left--;
            this.log(`${c.name} queda girado.`);
          }
          const donRest = Math.min(left, opp.donActive);
          opp.donActive -= donRest; opp.donRested += donRest;
          if (donRest) this.log(`${opp.name} gira ${donRest} DON!!.`);
          break;
        }
        case 'restAllOpp': {
          for (const c of opp.characters.filter((x) => !x.rested && !(x._noRestUntil >= this.turn) && !this.cardHasStatic(x, 'cannotRestOpp'))) {
            await this.restCard(c);
            this.log(`${c.name} queda girado.`);
          }
          break;
        }
        case 'triggerToHand': {
          const c = ctx.source;
          if (c && c.zone === 'trigger') { c.zone = 'hand'; p.hand.push(c); this.log(`${c.name} va a la mano de ${p.name}.`); }
          break;
        }
        case 'condDiscard': {
          const ids = await p.controller.discardFromHand(this, op.n, { min: 0 });
          let done = 0;
          for (const id of (ids ?? []).slice(0, op.n)) {
            const c = this.byId(id);
            if (c && c.zone === 'hand' && c.owner === p) { this.trashFromHand(c); done++; this.log(`${p.name} descarta ${c.name}.`); }
          }
          if (done >= op.n) await this.resolveOps(op.ops, ctx);
          break;
        }
        case 'restrictDonUnrest': { p._noDonUnrestTurn = this.turn; this.log(`${p.name} no puede enderezar DON!! con efectos de personaje este turno.`); break; }
        case 'oppDamage': {
          for (let i = 0; i < op.n && !this.over; i++) {
            await this.dealLeaderDamage(opp, ctx.source);
          }
          break;
        }
        case 'cannotAttackLeader': {
          if (opp.leader) { opp.leader._cannotAttackUntil = this.turn + 1; this.log(`${opp.leader.name} (líder) no podrá atacar hasta el próximo turno.`); }
          break;
        }
        case 'lookPlay': {
          const seen = p.library.splice(0, Math.min(op.n, p.library.length));
          if (!seen.length) break;
          const ok = seen.filter((c) => c.isCharacter && c.cost <= (op.maxCost ?? 99) && this.matchesFilter(c, op.filter));
          this.log(`${p.name} mira ${seen.length} carta(s) de su mazo.`);
          for (let i = 0; i < (op.targets ?? 1) && ok.length; i++) {
            const ids = await p.controller.chooseRevealed(this, {
              revealedIds: seen.map((c) => c.id), pickableIds: ok.map((c) => c.id),
              min: 0, max: 1, prompt: 'Elige una para ponerla en juego; el resto va al fondo.',
            });
            const hit = this.byId((ids ?? [])[0]);
            if (!hit || !ok.includes(hit)) break;
            if (!(await this.makeRoom(p, hit))) break;
            seen.splice(seen.indexOf(hit), 1); ok.splice(ok.indexOf(hit), 1);
            hit.zone = 'characters'; hit.rested = false; hit.summonedThisTurn = true; hit.enteredTurn = this.turn;
            p.characters.push(hit);
            this.log(`${p.name} pone en juego ${hit.name} gratis.`);
            await this.runTaggedAbilities(hit, 'onPlay');
          }
          for (const c of seen) { c.zone = 'deck'; p.library.push(c); }
          break;
        }
        case 'lifeReorderOpp': { this.log(`${p.name} mira y reordena la Vida de ${opp.name}.`); break; }
        case 'selectStore': {
          const pool = op.side === 'opp' ? opp.characters : p.characters;
          const cands = pool.filter((c) => this.matchesFilter(c, op.filter));
          if (!cands.length) break;
          const id = await p.controller.chooseTarget(this, { purpose: 'powerUp', candidateIds: cands.map((c) => c.id), optional: true });
          const t = this.byId(id);
          if (t && cands.includes(t)) { ctx.lastTargetId = t.id; this.log(`${p.name} selecciona a ${t.name}.`); }
          break;
        }
        case 'koLast': {
          const t = this.byId(ctx.lastTargetId);
          if (t && t.zone === 'characters' && this.canBeKOd(t, { byEffect: true })) {
            this.log(`💥 ${t.name} es KO.`);
            this.koCharacter(t);
            await this.runTaggedAbilities(t, 'onKO', { byEffect: true });
          }
          break;
        }
        case 'restrictAttackLeader': { p._noAttackLeaderTurn = this.turn; this.log(`${p.name} no puede atacar al líder este turno.`); break; }
        case 'aliasAbility': {
          // "[Trigger] Activate this card's [On Play] effect."
          const ab2 = abilitiesOf(ctx.source, op.when)[0];
          if (!ab2) break;
          if (ab2.donX && ctx.source.givenDon < ab2.donX) break;
          if (ab2.cost) {
            if (!this.canPayAbilityCost(p, ctx.source, ab2.cost)) break;
            const wants = await p.controller.payOptionalCost(this, { cardId: ctx.source.id, when: op.when });
            if (!wants) break;
            await this.payAbilityCost(p, ctx.source, ab2.cost, ctx);
          }
          await this.resolveOps(ab2.ops, ctx);
          break;
        }
        case 'koStage': {
          const st = opp.stage;
          if (!st || st.cost > (op.maxCost ?? 99) || this.isProtectedFromRemoval(st)) break;
          opp.stage = null;
          st.zone = 'trash'; opp.trash.push(st);
          this.log(`💥 El escenario ${st.name} es eliminado.`);
          break;
        }
        case 'trashOwnStage': {
          const st = p.stage;
          if (!st) break;
          p.stage = null;
          st.zone = 'trash'; p.trash.push(st);
          this.log(`${p.name} trashea su escenario ${st.name}.`);
          break;
        }
        case 'oppDonReturn': {
          let left = op.n;
          const fromRested = Math.min(left, opp.donRested);
          opp.donRested -= fromRested; left -= fromRested;
          const fromActive = Math.min(left, opp.donActive);
          opp.donActive -= fromActive; left -= fromActive;
          opp.donDeck += (op.n - left);
          this.log(`${opp.name} devuelve ${op.n - left} DON!! a su mazo de DON!!.`);
          break;
        }
        case 'oppHandToDeck': {
          const nMove = Math.min(op.n, opp.hand.length);
          if (!nMove) break;
          const ids = await opp.controller.discardFromHand(this, nMove, {});
          const chosen = (ids ?? []).map((id) => this.byId(id)).filter((c) => c && c.zone === 'hand' && c.owner === opp).slice(0, nMove);
          while (chosen.length < nMove && opp.hand.length > chosen.length) {
            const extra = opp.hand.find((c) => !chosen.includes(c));
            if (!extra) break;
            chosen.push(extra);
          }
          for (const c of chosen) {
            opp.hand.splice(opp.hand.indexOf(c), 1);
            c.zone = 'deck'; opp.library.push(c);
          }
          this.log(`${opp.name} pone ${chosen.length} carta(s) de su mano al fondo de su mazo.`);
          break;
        }
        case 'oppLifeToHand': {
          for (let i = 0; i < op.n && opp.life.length; i++) {
            const c = opp.life.shift();
            c.zone = 'hand'; c.faceUp = false; opp.hand.push(c);
            this.log(`${opp.name} añade ${c.name} de su Vida a su mano (Vida: ${opp.life.length}).`);
          }
          break;
        }
        case 'negate': {
          for (let i = 0; i < op.targets; i++) {
            const cands = [...opp.characters, opp.leader].filter(Boolean)
              .filter((c) => this.matchesFilter(c, op.filter) && c._negatedUntil !== this.turn);
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'negate', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { t._negatedUntil = this.turn; this.log(`🚫 Los efectos de ${t.name} quedan anulados este turno.`); }
          }
          break;
        }
        case 'restrictLifeToHand': { p._noLifeToHandTurn = this.turn; this.log(`${p.name} no puede añadir Vidas a su mano con sus efectos este turno.`); break; }
        case 'restrictPlay': { p._noPlayCostGE = { turn: this.turn, v: op.minCost }; this.log(`${p.name} no puede jugar personajes de coste base ${op.minCost}+ este turno.`); break; }
        case 'flipLife': {
          const nFlip = op.all ? p.life.length : Math.min(op.n, p.life.length);
          let done = 0;
          for (const c of p.life) {
            if (done >= nFlip) break;
            if (c.faceUp !== op.up) { c.faceUp = op.up; done++; }
          }
          this.log(`${p.name} voltea ${done} carta(s) de su Vida boca ${op.up ? 'arriba' : 'abajo'}.`);
          break;
        }
        case 'selfNoAttack': {
          ctx.source._cannotAttackUntil = this.turn;
          this.log(`${ctx.source.name} no puede atacar este turno.`);
          break;
        }
        case 'freezeAllLowCost': {
          for (const q of this.players) {
            const next = q === this.activePlayer ? this.turn + 2 : this.turn + 1;
            for (const c of q.characters.filter((x) => x.cost <= op.maxCost)) c._frozenUntil = next;
          }
          this.log(`❄ Los personajes de coste ${op.maxCost} o menos no se enderezarán en el próximo refresh.`);
          break;
        }
        case 'freezeOppDon': {
          opp._donFrozenNext = Math.max(opp._donFrozenNext ?? 0, Math.min(op.n, opp.donRested));
          this.log(`❄ ${opp._donFrozenNext} DON!! girado(s) de ${opp.name} no se enderezarán en su refresh.`);
          break;
        }
        case 'restOppDonNext': {
          opp._restDonAtMain = (opp._restDonAtMain ?? 0) + op.n;
          this.log(`${opp.name} girará ${op.n} DON!! al inicio de su próxima fase principal.`);
          break;
        }
        case 'giveOppDonToChar': {
          const cands = opp.characters;
          if (!cands.length || opp.donRested < 1) break;
          const moved = Math.min(op.n, opp.donRested);
          opp.donRested -= moved;
          cands[0].givenDon += moved;
          this.log(`${moved} DON!! girado(s) de ${opp.name} pasan a ${cands[0].name} (tempo perdido).`);
          break;
        }
        case 'cannotKOGroup': {
          for (const c of p.characters.filter((x) => this.matchesFilter(x, op.filter))) c._noKOEffectUntil = this.turn + 1;
          this.log(`Los personajes protegidos de ${p.name} no pueden ser KO por efectos hasta su próximo turno.`);
          break;
        }
        case 'setBasePowerGroup': {
          for (const c of [...p.characters, p.leader].filter(Boolean).filter((x) => this.matchesFilter(x, op.filter))) {
            c.addMod({ stat: 'power', delta: op.value - (c.data.power ?? 0), expireTurn: this.turn });
          }
          this.log(`El poder base del grupo pasa a ${op.value} este turno.`);
          break;
        }
        case 'copyLeaderBasePower': {
          const c = ctx.source;
          c.addMod({ stat: 'power', delta: (p.leader.data.power ?? 0) - (c.data.power ?? 0), expireTurn: this.turn });
          this.log(`${c.name} copia el poder base de tu líder (${p.leader.data.power}).`);
          break;
        }
        case 'copyOppLeaderBasePower': {
          const c = ctx.source;
          c.addMod({ stat: 'power', delta: (opp.leader.data.power ?? 0) - (c.data.power ?? 0), expireTurn: this.turn });
          this.log(`${c.name} copia el poder base del líder rival (${opp.leader.data.power}).`);
          break;
        }
        case 'copyPowerFromOpp': {
          const cands = opp.characters.filter((c) => this.matchesFilter(c, op.filter));
          if (!cands.length) break;
          const id = await p.controller.chooseTarget(this, { purpose: 'powerUp', candidateIds: cands.map((c) => c.id), optional: true });
          const t = this.byId(id);
          if (!t || !cands.includes(t)) break;
          ctx.source.addMod({ stat: 'power', delta: t.power(this) - (ctx.source.data.power ?? 0), expireTurn: this.turn });
          this.log(`${ctx.source.name} copia el poder de ${t.name} (${t.power(this)}).`);
          break;
        }
        case 'trashLifeTo': {
          while (p.life.length > op.n) {
            const c = p.life.shift();
            c.zone = 'trash'; c.faceUp = false; p.trash.push(c);
          }
          this.log(`${p.name} trashea su Vida hasta quedarse con ${p.life.length}.`);
          break;
        }
        case 'revealedToDeckBottom': {
          for (const id of ctx.revealedIds ?? []) {
            const c = this.byId(id);
            if (c && c.zone === 'hand' && c.owner === p) {
              p.hand.splice(p.hand.indexOf(c), 1);
              c.zone = 'deck'; p.library.push(c);
              this.log(`${p.name} pone la carta revelada al fondo del mazo.`);
            }
          }
          break;
        }
        case 'canAttackActiveGroup': {
          for (let i = 0; i < op.targets; i++) {
            const pool = op.includeLeader ? [p.leader, ...p.characters].filter(Boolean) : [...p.characters];
            const cands = pool.filter((c) => this.matchesFilter(c, op.filter) && c._canAttackActiveTurn !== this.turn);
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'powerUp', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { t._canAttackActiveTurn = this.turn; this.log(`${t.name} puede atacar personajes activos este turno.`); }
          }
          break;
        }
        case 'tuckSelf': {
          const c = ctx.source; const q = c.owner;
          if (c.zone === 'characters') {
            q.donActive += c.givenDon; c.givenDon = 0;
            q.characters.splice(q.characters.indexOf(c), 1);
            c.rested = false; c.tempPower = 0; c.mods = [];
            c.zone = 'deck'; q.library.push(c);
            this.log(`⤵ ${c.name} va al fondo del mazo.`);
          }
          break;
        }
        case 'giveRestedDonEach': {
          const cands = p.characters.filter((c) => this.matchesFilter(c, op.filter));
          for (const t of cands.slice(0, op.targets)) {
            const give = Math.min(op.each, p.donRested);
            if (give <= 0) break;
            p.donRested -= give; t.givenDon += give;
            this.log(`${p.name} da ${give} DON!! (girado) a ${t.name}.`);
          }
          break;
        }
        case 'battleAttrBuff': break; // estática de combate: se aplica en attack().
        case 'koReplace': break; // se consulta en tryKOReplace al ir a eliminar.
        case 'chooseCostReveal': {
          // Katakuri púrpura: eliges un coste, revelas la carta superior del
          // mazo RIVAL y, si coincide, se resuelve el efecto interior.
          const options = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
          const idx = await p.controller.chooseOption(this, { prompt: 'Elige un coste (revelarás la carta superior del mazo rival):', options });
          const chosen = Math.max(0, Math.min(idx ?? 0, options.length - 1));
          const top = opp.library[0];
          if (!top) break;
          const topCost = top.data.cost ?? null;
          this.log(`${p.name} elige coste ${chosen}; se revela ${top.name} (coste ${topCost ?? '—'}).`);
          if (topCost === chosen) {
            this.log('¡Coincide! Se activa el efecto.');
            await this.resolveOps(op.ops, ctx);
          }
          break;
        }
        case 'unrestLeader': {
          const okName = !op.name || p.leader.name.toLowerCase().includes(op.name.toLowerCase());
          const okType = !op.type || (p.leader.data.subTypes ?? []).some((t) => t.toLowerCase().includes(op.type.toLowerCase()));
          if (p.leader.rested && okName && okType) {
            p.leader.rested = false;
            this.log(`${p.leader.name} se endereza.`);
          }
          break;
        }
        case 'peekOppTop': {
          this.log(`${p.name} mira la carta superior del mazo rival.`);
          break;
        }
        case 'millSelf': {
          for (let i = 0; i < op.n && p.library.length; i++) {
            const c = p.library.shift();
            c.zone = 'trash'; p.trash.push(c);
            this.log(`${p.name} trashea ${c.name} de lo alto de su mazo.`);
          }
          break;
        }
        case 'setBasePowerOpp': {
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters;
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'powerDown', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) {
              const expireTurn = op.dur === 'next' ? this.turn + 1 : this.turn;
              t.addMod({ stat: 'power', delta: op.value - (t.data.power ?? 0), expireTurn, battle: op.dur === 'battle' });
              this.log(`${t.name}: su poder base pasa a ${op.value}.`);
            }
          }
          break;
        }
        case 'cannotBeRested': {
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters.filter((c) => this.matchesFilter(c, op.filter) && !(c._noRestUntil >= this.turn));
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { t._noRestUntil = this.turn + 1; this.log(`${t.name} no puede ser girado hasta el final del próximo turno.`); }
          }
          break;
        }
        case 'selfNoAttackLowCost': {
          ctx.source._noAtkCharMax = { turn: this.turn, v: op.maxBaseCost };
          this.log(`${ctx.source.name} no puede atacar personajes de coste base ${op.maxBaseCost} o menos este turno.`);
          break;
        }
        case 'drawTrashedCount': {
          const n2 = ctx.trashedCount ?? 0;
          if (n2 > 0) this.draw(p, n2);
          break;
        }
        case 'handCostAfterTrash': break; // estática de mano: la lee staticCostFor.
        case 'oppChoose': {
          // El rival elige cuál de las opciones sufre; el efecto se resuelve
          // desde la perspectiva del controlador de la carta (p).
          const opp2 = this.opponentOf(p);
          const idx = await opp2.controller.chooseOption(this, {
            prompt: 'Tu rival te obliga a elegir una opción:',
            options: op.options.map((ops2) => this.describeOps(ops2)),
          });
          const chosen = op.options[Math.max(0, Math.min(idx ?? 0, op.options.length - 1))];
          await this.resolveOps(chosen, ctx);
          break;
        }
        case 'peekReorder': {
          this.log(`${p.name} mira las ${Math.min(op.n, p.library.length)} primeras cartas de su mazo.`);
          break;
        }
        case 'trashToHand': {
          for (let i = 0; i < op.targets; i++) {
            const cands = p.trash.filter((c) => c.cost <= (op.maxCost ?? 99) && this.matchesFilter(c, op.filter));
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'recover', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) {
              p.trash.splice(p.trash.indexOf(t), 1);
              t.zone = 'hand';
              p.hand.push(t);
              this.log(`${p.name} recupera ${t.name} del descarte.`);
            }
          }
          break;
        }
        case 'playFromZone': {
          const zones = op.zone === 'deck' ? [p.library] : op.zone === 'trash' ? [p.trash]
            : op.zone === 'hand or trash' ? [p.hand, p.trash] : [p.hand];
          const matchesAlt = (c) => !op.orNameAttr ||
            c.name.toLowerCase().includes(op.orNameAttr.toLowerCase()) ||
            (!!c.data.attribute && c.data.attribute === ctx.source?.data?.attribute);
          // Variante evento: juega gratis el [Main] de un evento de la mano.
          if (op.asEvent) {
            for (let i = 0; i < (op.targets ?? 1); i++) {
              const cands = p.hand.filter((c) => c.isEvent && this.matchesFilter(c, op.filter) && abilitiesOf(c, 'main')[0]);
              if (!cands.length) break;
              const id = await p.controller.chooseTarget(this, { purpose: 'playFree', candidateIds: cands.map((c) => c.id), optional: true });
              const ev = this.byId(id);
              if (!ev || !cands.includes(ev)) break;
              p.hand.splice(p.hand.indexOf(ev), 1);
              ev.zone = 'trash'; p.trash.push(ev);
              this.log(`${p.name} activa gratis el evento ${ev.name}.`);
              const mainAb = abilitiesOf(ev, 'main')[0];
              if (mainAb) await this.resolveOps(mainAb.ops, { source: ev, p });
            }
            break;
          }
          // "each of [A],[B],[C]": juega uno por cada nombre; si no, hasta N.
          const rounds = op.each && op.filter?.names ? op.filter.names.map((nm) => ({ names: [nm] })) : Array(op.targets ?? 1).fill(op.filter);
          for (const rf of rounds) {
            const dynMax = op.maxCostOppDon ? (opp.donActive + opp.donRested + opp.donGiven) : (op.maxCost ?? 99);
            const cands = zones.flat().filter((c) => c.isCharacter && c.cost <= dynMax && (op.minCost == null || c.cost >= op.minCost) && this.matchesFilter(c, rf) && this.matchesFilter(c, op.filter) && matchesAlt(c));
            if (!cands.length) continue;
            const id = await p.controller.chooseTarget(this, {
              purpose: 'playFree', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const hit = this.byId(id);
            if (!hit || !cands.includes(hit)) break;
            if (!(await this.makeRoom(p, hit))) break;
            const srcZone = zones.find((z) => z.includes(hit));
            srcZone.splice(srcZone.indexOf(hit), 1);
            hit.zone = 'characters';
            hit.rested = !!op.rested;
            hit.summonedThisTurn = true;
            hit.enteredTurn = this.turn;
            p.characters.push(hit);
            this.log(`${p.name} pone en juego ${hit.name} gratis${op.rested ? ' (girado)' : ''}.`);
            await this.runTaggedAbilities(hit, 'onPlay');
          }
          if (op.zone === 'deck') this.shuffle(p.library);
          break;
        }
        case 'playSelf': {
          const c = ctx.source;
          if (c.isCharacter && c.zone !== 'characters' && await this.makeRoom(p, c)) {
            if (c.zone === 'hand') p.hand.splice(p.hand.indexOf(c), 1);
            else if (c.zone === 'trash') p.trash.splice(p.trash.indexOf(c), 1);
            else if (c.zone === 'life') { p.life.splice(p.life.indexOf(c), 1); c.faceUp = false; }
            c.zone = 'characters';
            c.rested = !!op.rested;
            c.summonedThisTurn = true;
            c.enteredTurn = this.turn;
            p.characters.push(c);
            this.log(`${p.name} pone en juego ${c.name} gratis${op.rested ? ' (girado)' : ''}.`);
            await this.runTaggedAbilities(c, 'onPlay');
          } else if (ctx.toHandFallback) {
            c.zone = 'hand';
            p.hand.push(c);
          }
          break;
        }
        case 'restOwnAction': {
          const cands = p.characters.filter((c) => !c.rested && this.matchesFilter(c, op.filter));
          for (let i = 0; i < op.n && cands.length; i++) {
            const id = await p.controller.chooseTarget(this, { purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (!t || !cands.includes(t)) break;
            t.rested = true; cands.splice(cands.indexOf(t), 1);
            this.log(`${p.name} gira ${t.name}.`);
          }
          break;
        }
        case 'koBattled': break;   // lo ejecuta afterCharBattle con el objetivo real.
        case 'negate': break;      // negación de efectos no modelada.
        case 'runAbility': {
          const ab = abilitiesOf(ctx.source, op.which)[0];
          if (ab) {
            if (ab.cost && !this.canPayAbilityCost(p, ctx.source, ab.cost)) break;
            if (ab.cost) await this.payAbilityCost(p, ctx.source, ab.cost);
            await this.resolveOps(ab.ops, ctx);
          }
          break;
        }
        case 'noBlocker': {
          if (ctx.battle) ctx.battle.noBlocker = { minPower: op.minPower, maxCost: op.maxCost ?? null };
          break;
        }
        case 'grantNoBlocker': {
          const targetId = await p.controller.chooseTarget(this, {
            purpose: 'grantNoBlocker', candidateIds: p.board().map((c) => c.id), optional: true,
          });
          const t = this.byId(targetId);
          if (t) { t._noBlockerTurn = this.turn; this.log(`${t.name}: el rival no podrá bloquear sus ataques este turno.`); }
          break;
        }
        case 'gainKeyword': {
          (ctx.source._tempKw ??= new Set()).add(op.kw);
          this.log(`${ctx.source.name} gana [${op.kw}] este turno.`);
          break;
        }
        case 'grantKeywordGroup': {
          for (let i = 0; i < (op.targets ?? 1); i++) {
            const cands = p.board().filter((c) => !c._tempKw?.has(op.kw));
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'powerUp', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && t.owner === p) {
              (t._tempKw ??= new Set()).add(op.kw);
              this.log(`${t.name} gana [${op.kw}].`);
            }
          }
          break;
        }
        case 'ifLeaderType': {
          if ((p.leader.data.subTypes ?? []).some((s) => s.toLowerCase() === op.type.toLowerCase())) {
            await this.resolveOps(op.ops, ctx);
          }
          break;
        }
        // Estáticas: se evalúan en staticPowerFor / staticKeyword, no aquí.
        case 'powerSelf': {
          if (ctx.dynamic) break;
          ctx.source.tempPower += op.n;
          break;
        }
        case 'staticSelfPower': case 'auraWhileRested': case 'unrestAfterCharBattle': break;
        default: break;
      }
    }
    } finally {
      // Cierra la ventana de verificación de la última op de esta lista antes
      // de que sigan otros eventos (daño, triggers, descarte del evento...).
      if (this.opProbe) this.opProbe(null, ctx);
      this._resolveDepth--;
      // Al cerrar la resolución más externa, dispara "cuando trasheas de tu
      // mano por un efecto" con el recuento acumulado (líder Kuzan).
      if (this._resolveDepth === 0 && this._pendingHandTrash?.size) {
        const pending = [...this._pendingHandTrash.entries()];
        this._pendingHandTrash.clear();
        for (const [player, count] of pending) {
          if (!this.over) await this.fireOnBoard(player, 'onHandTrash', { trashedCount: count });
        }
      }
    }
  }

  payDon(p, cost) {
    if (cost > p.donActive) throw new Error('DON insuficiente');
    p.donActive -= cost;
    p.donRested += cost;
  }

  async playCharacter(p, { cardId, trashId = null }) {
    {
      const r = p._noPlayCostGE;
      const cc = this.byId(cardId);
      if (r && r.turn === this.turn && cc && (cc.data.cost ?? 0) >= r.v) {
        this.log(`${p.name} no puede jugar ${cc.name}: personajes de coste base ${r.v}+ vetados este turno.`);
        return;
      }
    }
    const card = this.byId(cardId);
    if (!card || card.owner !== p || card.zone !== 'hand' || !card.isCharacter) {
      throw new Error('carta de personaje inválida');
    }
    if (p.characters.length >= 5) {
      const victim = this.byId(trashId);
      if (!victim || victim.zone !== 'characters' || victim.owner !== p) {
        throw new Error('área de personajes llena (elige uno para el descarte)');
      }
      this.ruleTrashCharacter(victim);
      this.log(`${p.name} manda ${victim.name} al descarte para hacer sitio (regla 3-7-6-1).`);
    }
    this.payDon(p, card.cost);
    p.hand.splice(p.hand.indexOf(card), 1);
    card.zone = 'characters';
    card.rested = false;
    card.summonedThisTurn = true;
    card.enteredTurn = this.turn;
    p.characters.push(card);
    this.log(`${p.name} juega ${card.name} (${card.cost} DON, ${card.data.power ?? 0}).`);
    await this.narrate(p, { kind: 'play', card: card.name });
    await this.runTaggedAbilities(card, 'onPlay');
    // "When you play a <filtro> Character from your hand, ..."
    await this.fireOnBoard(p, 'onCharPlayed', { played: card });
  }

  async playStage(p, { cardId }) {
    const card = this.byId(cardId);
    if (!card || card.owner !== p || card.zone !== 'hand' || !card.isStage) {
      throw new Error('escenario inválido');
    }
    this.payDon(p, card.cost);
    p.hand.splice(p.hand.indexOf(card), 1);
    if (p.stage) this.trashCard(p.stage);
    card.zone = 'stage';
    p.stage = card;
    this.log(`${p.name} juega el escenario ${card.name}.`);
    await this.narrate(p, { kind: 'play', card: card.name });
    await this.runTaggedAbilities(card, 'onPlay');   // los escenarios también tienen [On Play]
  }

  async giveDon(p, { cardId, n = 1 }) {
    const card = this.byId(cardId);
    if (!card || card.owner !== p || (card.zone !== 'characters' && card.zone !== 'leader')) {
      throw new Error('objetivo de DON inválido');
    }
    if (p.donActive < n) throw new Error('DON insuficiente');
    p.donActive -= n;
    card.givenDon += n;
    this.log(`${p.name} da ${n} DON!! a ${card.name} (${card.power(this)}).`);
    this.narrate(p, { kind: 'don', n, card: card.name });
    // "When this Leader or 1 of your Characters is given a DON!! card, ..."
    await this.fireOnBoard(p, 'onDonGiven', { given: card });
  }

  // ---- combate -----------------------------------------------------------

  async attack(p, { attackerId, targetId }) {
    const attacker = this.byId(attackerId);
    const opp = this.opponentOf(p);
    if (!attacker || attacker.owner !== p || !attacker.canAttack(this)) {
      throw new Error('atacante inválido');
    }
    let target = targetId === 'leader' ? opp.leader : this.byId(targetId);
    const canHitActive = attacker._canAttackActiveTurn === this.turn ||
      attacker.script?.abilities?.some((ab) => ab.ops.some((o) => o.op === 'canAttackActive'));
    const validTarget = target === opp.leader ||
      (target && target.owner === opp && target.zone === 'characters' && (target.rested || canHitActive));
    if (!validTarget) throw new Error('objetivo inválido (líder o personaje girado)');
    if (target === opp.leader && p._noAttackLeaderTurn === this.turn) {
      throw new Error('no puedes atacar al líder este turno (efecto rival)');
    }
    // Provocación ("your opponent cannot attack any card other than [X]"):
    // puntual (op taunt) o continua (estática, p. ej. "si está girado").
    {
      let tauntName = (opp._tauntUntil >= this.turn) ? opp._tauntName : null;
      if (!tauntName) {
        for (const c of opp.board()) {
          this.walkStatics(c, (op2, holder, self) => {
            if (!tauntName && self && op2.op === 'taunt') tauntName = op2.name;
          });
          if (tauntName) break;
        }
      }
      if (tauntName) {
        const forced = [...opp.characters, opp.leader].filter(Boolean)
          .find((c) => c.name.toLowerCase().includes(tauntName.toLowerCase()));
        if (forced && target !== forced) {
          target = forced;
          this.log(`🧲 Provocación: el ataque se desvía a ${forced.name}.`);
        }
      }
    }

    // [Rush: Character]: el turno que entra solo puede atacar PERSONAJES.
    if (attacker.summonedThisTurn && target.isLeader &&
        !attacker.text.includes('[Rush]') && attacker.hasKeyword('Rush: Character')) {
      throw new Error('con [Rush: Character] solo puede atacar personajes este turno');
    }
    // Restricción del líder Zoro ST-32: no atacar personajes baratos.
    const noAtk = attacker._noAtkCharMax;
    if (noAtk?.turn === this.turn && !target.isLeader && (target.data.cost ?? 0) <= noAtk.v) {
      throw new Error(`no puede atacar personajes de coste base ${noAtk.v} o menos este turno`);
    }
    await this.restCard(attacker);
    this.log(`⚔ ${attacker.name} (${attacker.power(this)}) ataca a ${target.name} (${target.power(this)}).`);
    await this.narrate(p, { kind: 'attack', attacker: attacker.name, targetName: target.name, targetIsLeader: target.isLeader });
    if (this.onAnimate && !this._mute) await this.onAnimate({ type: 'attack', attackerId: attacker.id, targetId: target.id });

    // [When Attacking] (con condición [DON!! xN]); puede vetar bloqueadores.
    const battle = { noBlocker: null };
    await this.runTaggedAbilities(attacker, 'whenAttacking', { battle });
    if (this.over) return;

    // [On Your Opponent's Attack]: habilidades del DEFENSOR al declararse el ataque.
    await this.fireOnBoard(opp, 'onOppAttack', { battle });
    if (this.over) return;
    // Redirección (ST36-005 Kid): el defensor cambia el objetivo del ataque.
    if (battle.redirectTo) {
      const r = this.byId(battle.redirectTo);
      if (r && r.owner === opp && (r === opp.leader || opp.characters.includes(r))) {
        target = r;
        this.log(`⚔ El ataque ahora va contra ${target.name} (${target.power(this)}).`);
      }
    }

    // Paso de bloqueo (respetando vetos de la batalla y del turno).
    let blockers = opp.characters.filter((c) => c.hasBlocker && !c.rested && c !== target);
    if (attacker._noBlockerTurn === this.turn) blockers = [];
    if (battle.noBlocker) {
      if (battle.noBlocker.maxCost != null) blockers = blockers.filter((c) => c.cost > battle.noBlocker.maxCost);
      else if (battle.noBlocker.maxPower != null) blockers = blockers.filter((c) => c.power(this) > battle.noBlocker.maxPower);
      else if (battle.noBlocker.minPower) blockers = blockers.filter((c) => c.power(this) < battle.noBlocker.minPower);
      else blockers = [];
    }
    if (blockers.length) {
      const blockId = await opp.controller.chooseBlocker(this, {
        attackerId: attacker.id,
        targetId: target === opp.leader ? 'leader' : target.id,
        blockerIds: blockers.map((b) => b.id),
      });
      const blocker = this.byId(blockId);
      if (blocker && blockers.includes(blocker)) {
        await this.restCard(blocker);
        target = blocker;
        this.log(`🛡 ${blocker.name} bloquea (${blocker.power(this)}).`);
        // "When your opponent activates a [Blocker]": lo activó el DEFENSOR,
        // así que dispara las habilidades del atacante (p).
        await this.fireOnBoard(p, 'onOppBlocker');
        if (this.over) return;
        await this.runTaggedAbilities(blocker, 'onBlock');
        if (this.over) return;
      }
    }

    // Paso de counter: descartes con valor de counter y/o eventos [Counter].
    const resp = await opp.controller.counterStep(this, {
      attackerId: attacker.id,
      targetId: target === opp.leader ? 'leader' : target.id,
      attackPower: attacker.power(this),
      targetPower: target.power(this),
    });
    const counterIds = Array.isArray(resp) ? resp : resp?.discardIds ?? [];
    const eventIds = Array.isArray(resp) ? [] : resp?.eventIds ?? [];
    let counterBonus = 0;
    for (const id of counterIds) {
      const c = this.byId(id);
      if (!c || c.owner !== opp || c.zone !== 'hand' || !c.counterValue) continue;
      counterBonus += c.counterValue;
      this.trashFromHand(c, false);
      this.log(`✋ ${opp.name} descarta ${c.name} como counter (+${c.counterValue}).`);
    }
    target.tempPower += counterBonus;
    // Eventos [Counter]: se pagan con DON y su efecto sube poder / interviene.
    for (const id of eventIds) {
      const c = this.byId(id);
      if (!c || c.owner !== opp || c.zone !== 'hand' || !c.isEvent) continue;
      const ab = abilitiesOf(c, 'counter')[0];
      if (!ab) continue;
      if (c.cost > opp.donActive || !this.canPayAbilityCost(opp, c, ab.cost)) continue;
      this.payDon(opp, c.cost);
      opp.hand.splice(opp.hand.indexOf(c), 1);
      this.log(`⚡ ${opp.name} juega el evento counter ${c.name}.`);
      const cctx = { source: c, p: opp, battle: { defenderId: target.id } };
      await this.payAbilityCost(opp, c, ab.cost, cctx);
      await this.resolveOps(ab.ops, cctx);
      c.zone = 'trash';
      opp.trash.push(c);
      if (this.over) return;
    }

    // Buff condicional de combate: "cuando batalla contra X de atributo Y, +N".
    let attrBonus = 0;
    for (const ab of attacker.script?.abilities ?? []) {
      for (const o of ab.ops) {
        if (o.op === 'battleAttrBuff' && (target.data.attribute ?? '').toLowerCase() === o.attribute.toLowerCase()) {
          attrBonus += o.n; attacker.tempPower += o.n;
          this.log(`${attacker.name} gana +${o.n} por batallar contra ${o.attribute} (${attacker.power(this)}).`);
        }
      }
    }

    // Resolución.
    const atkPower = attacker.power(this);
    const defPower = target.power(this);
    if (atkPower >= defPower) {
      if (target.isLeader) {
        const hits = attacker.hasDoubleAttack ? 2 : 1;
        for (let i = 0; i < hits; i++) {
          if (this.over) return;
          await this.dealLeaderDamage(opp, attacker);
          if (this.over) return;
          // "When this card's attack deals damage to your opponent's life, ..."
          await this.fireOnBoard(p, 'onLifeDamage', { attacker });
        }
      } else if (!this.canBeKOd(target, { byEffect: false, byLeaderBattle: attacker.isLeader })) {
        this.log(`🛡 ${target.name} no puede ser KO en batalla (efecto).`);
        await this.afterCharBattle(attacker, target);
      } else if (await this.tryPreventKO(target, { byEffect: false })) {
        await this.afterCharBattle(attacker, target);
      } else {
        this.log(`💥 ${target.name} es KO.`);
        this.koCharacter(target);
        await this.runTaggedAbilities(target, 'onKO');   // [On K.O.] del caído
        // ST02-010: "si esta carta batalla contra un personaje, enderézala".
        await this.afterCharBattle(attacker, target);
        await this.fireOnCharKO();
      }
    } else {
      this.log(`El ataque no supera al defensor (${atkPower} vs ${defPower}).`);
      if (!target.isLeader) await this.afterCharBattle(attacker, target);
    }
    // El bono de counter dura solo esta batalla.
    if (target.zone !== 'trash') target.tempPower -= counterBonus;
    // Los modificadores "durante esta batalla" expiran al terminar el combate.
    for (const q of this.players) {
      for (const c of [...q.board(), q.stage].filter(Boolean)) {
        c.mods = c.mods.filter((m) => !m.battle);
      }
    }
    this.checkState();
  }

  async fireOnCharKO() {
    const owners = this._recentKOOwners ?? new Set();
    this._recentKOOwners = new Set();
    for (const q of this.players) {
      await this.fireOnBoard(q, 'onCharKO');
      // "When one of your opponent's Characters is KO'd": murió del rival de q.
      if ([...owners].some((o) => o !== q)) await this.fireOnBoard(q, 'onOppCharKO');
    }
  }

  async afterCharBattle(attacker, battled = null) {
    if (attacker.zone !== 'characters' && !attacker.isLeader) return;
    for (const ab of attacker.script?.abilities ?? []) {
      if (ab.donX && attacker.givenDon < ab.donX) continue;
      if (ab.ops.some((op) => op.op === 'unrestAfterCharBattle')) {
        if (ab.once && attacker._usedTurn?.afterBattle === this.turn) continue;
        (attacker._usedTurn ??= {}).afterBattle = this.turn;
        attacker.rested = false;
        this.log(`${attacker.name} se endereza tras la batalla.`);
      }
      // ST08-013: "al final de una batalla contra un personaje, puedes KO ese personaje".
      if (ab.when === 'afterBattle' && battled && !battled.isLeader && battled.zone === 'characters') {
        const p = attacker.owner;
        const wants = p.isBot ? true : await p.controller.chooseOption(this, {
          prompt: `¿KO a ${battled.name} tras la batalla?`, options: ['Sí', 'No'],
        }) === 0;
        if (wants && this.canBeKOd(battled, { byEffect: true }) && !(await this.tryPreventKO(battled, { byEffect: true }))) {
          this.log(`💥 ${battled.name} es KO tras la batalla.`);
          this.koCharacter(battled);
          await this.runTaggedAbilities(battled, 'onKO');
          await this.fireOnCharKO();
        }
      }
    }
  }

  async dealLeaderDamage(defender, source) {
    if (!defender.life.length) {
      this.endGame(this.opponentOf(defender), `${defender.name} recibe el golpe final`);
      return;
    }
    const lifeCard = defender.life.shift();
    const wasUp = lifeCard.faceUp;
    lifeCard.faceUp = false;
    if (source?.hasBanish) {
      lifeCard.zone = 'trash';
      defender.trash.push(lifeCard);
      this.log(`☠ ${defender.name} pierde 1 vida (desterrada: ${lifeCard.name}). Le quedan ${defender.life.length}.`);
      return;
    }
    this.log(`💔 ${defender.name} pierde 1 vida (${lifeCard.name}${wasUp ? ', estaba boca arriba' : ''}). Le quedan ${defender.life.length}.`);
    // [Trigger]: el defensor decide si lo activa en lugar de llevársela a la mano.
    const trigAb = abilitiesOf(lifeCard, 'trigger')[0];
    // Solo se ofrece si su coste (si lo tiene) es pagable ahora mismo.
    if (trigAb && trigAb.ops.length && this.canPayAbilityCost(defender, lifeCard, trigAb.cost)) {
      const wants = await defender.controller.triggerDecision(this, { cardId: lifeCard.id });
      if (wants) {
        this.log(`✨ ${defender.name} activa el [Trigger] de ${lifeCard.name}.`);
        lifeCard.zone = 'trigger';
        const tctx = { source: lifeCard, p: defender, toHandFallback: true };
        await this.payAbilityCost(defender, lifeCard, trigAb.cost, tctx);
        await this.resolveOps(trigAb.ops, tctx);
        // Si el trigger no la puso en juego, va al descarte.
        if (lifeCard.zone === 'trigger') {
          lifeCard.zone = 'trash';
          defender.trash.push(lifeCard);
        }
        return;
      }
    }
    lifeCard.zone = 'hand';
    defender.hand.push(lifeCard);
  }

  // ---- utilidades de zona ------------------------------------------------

  draw(p, n, silent = false) {
    for (let i = 0; i < n; i++) {
      if (!p.library.length) {
        this.endGame(this.opponentOf(p), `${p.name} no puede robar`);
        return;
      }
      const c = p.library.shift();
      c.zone = 'hand';
      p.hand.push(c);
    }
    if (!silent && n > 0) this.log(`${p.name} roba ${n}.`);
  }

  koCharacter(c) {
    const p = c.owner;
    (this._recentKOOwners ??= new Set()).add(p);
    // Recuerda los DON que tenía al morir: [DON!! xN] [On K.O.] se evalúa
    // con el estado en el momento del KO, no después de devolverlos.
    c._givenDonAtKO = c.givenDon;
    p.donActive += c.givenDon; // los DON dados vuelven al coste... (girados por regla; simplificado)
    c.givenDon = 0;
    const i = p.characters.indexOf(c);
    if (i !== -1) p.characters.splice(i, 1);
    c.zone = 'trash';
    c.rested = false;
    c.tempPower = 0;
    p.trash.push(c);
  }

  // Regla 3-7-6-1-1: descartar por el límite de 5 personajes es un proceso de
  // regla, no un KO ni un efecto — no dispara [On K.O.] ni cuenta como KO.
  ruleTrashCharacter(c) {
    const p = c.owner;
    p.donActive += c.givenDon;
    c.givenDon = 0;
    const i = p.characters.indexOf(c);
    if (i !== -1) p.characters.splice(i, 1);
    c.zone = 'trash';
    c.rested = false;
    c.tempPower = 0;
    p.trash.push(c);
  }

  // Regla 3-7-6-1: con el área de personajes llena, jugar uno nuevo (también
  // cuando lo pone en juego un efecto) exige descartar antes 1 personaje
  // propio. Devuelve false si el jugador renuncia (no se juega la carta).
  async makeRoom(p, incoming) {
    if (p.characters.length < 5) return true;
    const id = await p.controller.chooseTarget(this, {
      purpose: 'makeRoom', candidateIds: p.characters.map((c) => c.id),
      optional: true, incomingId: incoming?.id ?? null,
      prompt: `Área de personajes llena: descarta 1 para jugar ${incoming?.name ?? 'el nuevo personaje'} (regla 3-7-6-1)`,
    });
    const victim = this.byId(id);
    if (!victim || victim.owner !== p || victim.zone !== 'characters') return false;
    this.ruleTrashCharacter(victim);
    this.log(`${p.name} manda ${victim.name} al descarte para hacer sitio (regla 3-7-6-1).`);
    return true;
  }

  trashCard(c) {
    if (c.zone === 'characters') return this.koCharacter(c);
    if (c.zone === 'stage' && c.owner.stage === c) c.owner.stage = null;
    c.zone = 'trash';
    c.owner.trash.push(c);
  }

  trashFromHand(c, byEffect = true) {
    const p = c.owner;
    p.hand.splice(p.hand.indexOf(c), 1);
    c.zone = 'trash';
    p.trash.push(c);
    if (byEffect) {
      // Marca para condicionales ("during the turn in which...") y acumula
      // para "when a card is trashed from your hand..." (líder Kuzan).
      p._handTrashedTurn = this.turn;
      (this._pendingHandTrash ??= new Map()).set(p, (this._pendingHandTrash?.get(p) ?? 0) + 1);
    }
  }

  checkState() { /* condiciones continuas (F3+); la victoria se evalúa en el daño */ }

  endGame(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    const loser = this.opponentOf(winner);
    loser.lost = true;
    loser.lossReason = reason;
    this.log(`🏆 ¡${winner.name} gana! (${reason}).`);
  }

  // Herramienta del modo sandbox: crea una instancia nueva de cualquier carta
  // del catálogo y la pone en la mano del jugador.
  addCardToHand(p, data) {
    const c = this.register(new CardInstance(data, p));
    c.script = buildScript(data);
    c.zone = 'hand';
    p.hand.push(c);
    this.log(`🧪 ${p.name} añade ${c.name} a su mano (sandbox).`);
    return c;
  }

  // ---- snapshot / restore (bot con búsqueda) -----------------------------
  // Copia y restaura TODO el estado mutable de la partida (cartas, zonas,
  // DON!!, RNG, flags temporales) sin tocar los inmutables compartidos
  // (data, script, controllers, callbacks). Permite al bot "imaginar" el
  // resto del turno sobre el estado real y luego deshacerlo.

  static _EXC_CARD = new Set(['id', 'data', 'owner', 'game', 'script']);
  static _EXC_PLAYER = new Set(['deck', 'controller', 'leader', 'library', 'hand', 'characters', 'stage', 'life', 'trash']);

  _cloneVal(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof CardInstance) return { __cardRef: v.id };
    if (v instanceof Set) return new Set([...v].map((x) => this._cloneVal(x)));
    if (v instanceof Map) return new Map([...v.entries()].map(([k, x]) => [this._cloneVal(k), this._cloneVal(x)]));
    if (Array.isArray(v)) return v.map((x) => this._cloneVal(x));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = this._cloneVal(x);
    return o;
  }

  _thawVal(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v.__cardRef !== undefined) return this.byId(v.__cardRef);
    if (v instanceof Set) return new Set([...v].map((x) => this._thawVal(x)));
    if (v instanceof Map) return new Map([...v.entries()].map(([k, x]) => [this._thawVal(k), this._thawVal(x)]));
    if (Array.isArray(v)) return v.map((x) => this._thawVal(x));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = this._thawVal(x);
    return o;
  }

  _snapObj(obj, exc) {
    const o = {};
    for (const k of Object.keys(obj)) {
      if (exc.has(k)) continue;
      const v = obj[k];
      if (typeof v === 'function') continue;
      o[k] = this._cloneVal(v);
    }
    return o;
  }

  _restoreObj(obj, snap, exc) {
    // Borra flags añadidos después del snapshot y repone los guardados.
    for (const k of Object.keys(obj)) {
      if (exc.has(k) || typeof obj[k] === 'function') continue;
      if (!(k in snap)) delete obj[k];
    }
    for (const [k, v] of Object.entries(snap)) obj[k] = this._thawVal(v);
  }

  snapshotState() {
    return {
      cards: [...this.cardsById.values()].map((c) => [c.id, this._snapObj(c, Game._EXC_CARD)]),
      players: this.players.map((p) => ({
        fields: this._snapObj(p, Game._EXC_PLAYER),
        library: p.library.map((c) => c.id),
        hand: p.hand.map((c) => c.id),
        characters: p.characters.map((c) => c.id),
        life: p.life.map((c) => c.id),
        trash: p.trash.map((c) => c.id),
        stageId: p.stage?.id ?? null,
      })),
      turn: this.turn, phase: this.phase, activeIdx: this.activeIdx,
      over: this.over, winnerIdx: this.winner ? this.players.indexOf(this.winner) : null,
      rngState: this.rngState,
      pendingHandTrash: this._pendingHandTrash
        ? [...this._pendingHandTrash.entries()].map(([p, n]) => [this.players.indexOf(p), n]) : null,
      resolveDepth: this._resolveDepth ?? 0,
    };
  }

  restoreState(s) {
    for (const [id, snap] of s.cards) {
      const c = this.byId(id);
      if (c) this._restoreObj(c, snap, Game._EXC_CARD);
    }
    s.players.forEach((ps, i) => {
      const p = this.players[i];
      this._restoreObj(p, ps.fields, Game._EXC_PLAYER);
      p.library = ps.library.map((id) => this.byId(id));
      p.hand = ps.hand.map((id) => this.byId(id));
      p.characters = ps.characters.map((id) => this.byId(id));
      p.life = ps.life.map((id) => this.byId(id));
      p.trash = ps.trash.map((id) => this.byId(id));
      p.stage = ps.stageId != null ? this.byId(ps.stageId) : null;
    });
    this.turn = s.turn; this.phase = s.phase; this.activeIdx = s.activeIdx;
    this.over = s.over;
    this.winner = s.winnerIdx != null ? this.players[s.winnerIdx] : null;
    this.rngState = s.rngState;
    this._pendingHandTrash = s.pendingHandTrash
      ? new Map(s.pendingHandTrash.map(([i, n]) => [this.players[i], n])) : undefined;
    if (this._pendingHandTrash === undefined) delete this._pendingHandTrash;
    this._resolveDepth = s.resolveDepth;
  }

  // Descriptor público y serializable de una carta, con lo que el cliente
  // necesita para pintarla y ofrecer acciones (sin información oculta).
  pubCard(c, { forOwner = false } = {}) {
    if (!c) return null;
    const onField = ['characters', 'leader', 'stage'].includes(c.zone);
    const d = {
      id: c.id, dataId: c.data.id, name: c.name, type: c.type, color: c.color,
      cost: c.cost, power: onField ? c.power(this) : (c.data.power ?? null),
      basePower: c.data.power ?? null, counter: c.counterValue,
      rested: !!c.rested, givenDon: c.givenDon, text: c.text, image: c.data.image,
      zone: c.zone, ownerIdx: this.players.indexOf(c.owner),
      subTypes: c.data.subTypes ?? [],
      hasBlocker: c.hasBlocker, hasRush: c.hasRush,
    };
    if (forOwner && onField) {
      d.canAttack = c.canAttack(this);
      const ab = abilitiesOf(c, 'activateMain')[0];
      d.canActivate = !!ab && !(ab.once && c._activatedTurn === this.turn) &&
        !(ab.donX && c.givenDon < ab.donX) && this.canPayAbilityCost(c.owner, c, ab.cost);
    }
    return d;
  }

  // Vista serializable de la partida para un jugador. Es EXACTAMENTE lo que
  // el servidor de F8 envía a cada cliente: sin zonas ocultas del rival.
  viewFor(p) {
    const opp = this.opponentOf(p);
    const mine = (c) => this.pubCard(c, { forOwner: true });
    const pub = (c) => this.pubCard(c);
    return {
      turn: this.turn, phase: this.phase,
      activeIdx: this.activeIdx, youIdx: this.players.indexOf(p),
      over: this.over, winnerIdx: this.winner ? this.players.indexOf(this.winner) : null,
      you: {
        name: p.name, hand: p.hand.map(mine), leader: mine(p.leader),
        characters: p.characters.map(mine), stage: mine(p.stage),
        life: p.life.length, lifeIds: p.life.map((c) => c.id), deck: p.library.length,
        // Vida boca arriba = información pública (posición a posición).
        lifeFaces: p.life.map((c) => (c.faceUp ? pub(c) : null)),
        trash: p.trash.map(pub),
        don: { deck: p.donDeck, active: p.donActive, rested: p.donRested, given: p.donGiven },
      },
      opponent: {
        name: opp.name, handCount: opp.hand.length, leader: pub(opp.leader),
        characters: opp.characters.map(pub), stage: pub(opp.stage),
        life: opp.life.length, deck: opp.library.length, trash: opp.trash.map(pub),
        lifeFaces: opp.life.map((c) => (c.faceUp ? pub(c) : null)),
        don: { deck: opp.donDeck, active: opp.donActive, rested: opp.donRested, given: opp.donGiven },
      },
    };
  }
}
