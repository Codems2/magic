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
  constructor(configs, { seed = 42, onLog = null, onAnimate = null, onNarrate = null, maxTurns = 60 } = {}) {
    resetIds();
    this.rng = mulberry32(seed);
    this.onLog = onLog;
    this.onAnimate = onAnimate;   // hook opcional para animaciones de la UI
    this.onNarrate = onNarrate;   // hook opcional: la UI narra las jugadas
    this.maxTurns = maxTurns;
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
    if (f.names && !f.names.some((nm) => card.name.toLowerCase().includes(nm.toLowerCase()))) return false;
    if (f.notName && card.name.toLowerCase().includes(f.notName.toLowerCase())) return false;
    if (f.types && !f.types.some((t) => (card.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase())))) return false;
    if (f.colors && !f.colors.some((c) => (card.color ?? '').toLowerCase().includes(c))) return false;
    if (f.basePower && !cmp(card.data.power ?? 0, f.basePower)) return false;
    if (f.power && !cmp(card.data.power ?? 0, f.power)) return false;
    if (f.cost && !cmp(card.data.cost ?? 0, f.cost)) return false;
    return true;
  }

  buffInScope(op, card) {
    const inScope = (op.scope === 'leader' && card.isLeader) ||
      (op.scope === 'char' && card.isCharacter) || op.scope === 'leaderChar';
    return inScope && this.matchesFilterStatic(card, op.filter);
  }

  staticPowerFor(card) {
    let bonus = 0;
    const p = card.owner;
    for (const ab of card.script?.abilities ?? []) {
      if (ab.donX && card.givenDon < ab.donX) continue;
      if (ab.oppTurn && this.activePlayer === p) continue;
      if (ab.yourTurn && this.activePlayer !== p) continue;
      for (const op of ab.ops) {
        if (op.op === 'powerSelf' && ab.when === 'static') bonus += op.n;
        else if (op.op === 'staticSelfPower' && p.characters.length >= (op.cond?.minChars ?? 0)) bonus += op.n;
      }
    }
    // Auras estáticas de cartas del mismo jugador: "si está girada +1000" y
    // buffs de grupo ("all of your X gain +N power", "[Opponent's Turn] ...").
    for (const other of p.board()) {
      for (const ab of other.script?.abilities ?? []) {
        if (ab.when !== 'static') continue;
        if (ab.donX && other.givenDon < ab.donX) continue;
        if (ab.yourTurn && this.activePlayer !== p) continue;
        if (ab.oppTurn && this.activePlayer === p) continue;
        for (const op of ab.ops) {
          if (op.op === 'auraWhileRested' && other !== card && other.rested) bonus += op.n;
          if (op.op === 'buff' && op.side === 'own' && this.buffInScope(op, card)) {
            for (const ch of op.changes) if (ch.stat === 'power') bonus += ch.delta;
          }
        }
      }
    }
    return bonus;
  }

  // ¿La carta cumple un filtro de objetivo (color/subtipo/nombre/poder/coste)?
  matchesFilter(card, f) {
    if (!f) return true;
    const cmp = (val, spec) => spec.dir === 'less' ? val <= spec.v : spec.dir === 'more' ? val >= spec.v : val === spec.v;
    if (f.names && !f.names.some((nm) => card.name.toLowerCase().includes(nm.toLowerCase()))) return false;
    if (f.notName && card.name.toLowerCase().includes(f.notName.toLowerCase())) return false;
    if (f.types && !f.types.some((t) => (card.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase())))) return false;
    if (f.colors && !f.colors.some((c) => (card.color ?? '').toLowerCase().includes(c))) return false;
    if (f.basePower && !cmp(card.data.power ?? 0, f.basePower)) return false;
    if (f.power && !cmp(card.power(this), f.power)) return false;
    if (f.cost && !cmp(card.cost, f.cost)) return false;
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
      case 'oppRested': return opp.characters.filter((c) => c.rested).length >= cond.v;
      case 'youHaveMatch': {
        const list = p.characters.filter((c) => this.matchesFilter(c, cond.filter) && (!cond.filter.rested || c.rested));
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
      case 'oppMoreDon': return (opp.donActive + opp.donRested) > (p.donActive + p.donRested);
      case 'restedByEffect': return !!p._restedByEffectTurn && p._restedByEffectTurn === this.turn;
      default: return false;
    }
  }

  staticKeyword(card, kw) {
    for (const ab of card.script?.abilities ?? []) {
      if (ab.when !== 'static') continue;
      if (ab.donX && card.givenDon < ab.donX) continue;
      if (ab.ops.some((op) => op.op === 'gainKeyword' && op.kw === kw)) return true;
    }
    // Auras de grupo estáticas que otorgan palabras clave.
    const p = card.owner;
    for (const other of p.board()) {
      for (const ab of other.script?.abilities ?? []) {
        if (ab.when !== 'static') continue;
        if (ab.donX && other.givenDon < ab.donX) continue;
        if (ab.yourTurn && this.activePlayer !== p) continue;
        if (ab.oppTurn && this.activePlayer === p) continue;
        for (const op of ab.ops) {
          if (op.op === 'buff' && op.side === 'own' && (op.kws ?? []).some((k) => k.toLowerCase() === kw.toLowerCase()) && this.buffInScope(op, card)) return true;
        }
      }
    }
    return false;
  }

  // ¿Puede esta carta ser KO en este contexto? Consulta protecciones estáticas
  // ("cannot be KO'd in battle / by effects / by leaders").
  canBeKOd(card, { byEffect = false, byLeaderBattle = false } = {}) {
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
        const cost = { trashHand: op.trashHand ?? 0, trashLife: op.trashLife ?? 0 };
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
      }
    }
    return false;
  }

  koModeBlocks(op, byEffect, byLeaderBattle) {
    if (op.mode === 'any') return true;
    if (op.mode === 'effect') return byEffect;
    if (op.mode === 'battle') return !byEffect && (op.by !== 'leader' || byLeaderBattle);
    return false;
  }

  register(card) {
    this.cardsById.set(card.id, card);
    return card;
  }
  byId(id) { return this.cardsById.get(id) ?? null; }

  log(msg) {
    this.logLines.push(msg);
    if (this.onLog) this.onLog(msg);
  }

  // Narración estructurada de una jugada (la UI decide si mostrar cartel).
  async narrate(player, ev) {
    if (this.onNarrate) await this.onNarrate({ actor: player.name, isBot: player.isBot, ...ev });
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
        p.life.push(c);
      }
    }
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
    p.donActive += p.donRested;
    p.donRested = 0;

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

    // 4. Main.
    this.phase = 'main';
    await this.mainPhase(p);
    if (this.over) return;

    // 5. End: habilidades [End of Your Turn] del jugador activo.
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
    if (cost.turnLifeDown && p.life.length < cost.turnLifeDown) return false;
    if (cost.restSelf && source.rested) return false;
    if (cost.trashHandFilter && p.hand.filter((c) => this.matchesFilter(c, cost.trashHandFilter)).length < cost.trashHand) return false;
    if (cost.restOwn && p.characters.filter((c) => !c.rested && this.matchesFilter(c, cost.restOwn.filter)).length < cost.restOwn.n) return false;
    if (cost.bounceOwn && p.characters.filter((c) => this.matchesFilter(c, cost.bounceOwn.filter)).length < cost.bounceOwn.n) return false;
    if (cost.charToLife && p.characters.filter((c) => this.matchesFilter(c, cost.charToLife.filter)).length < cost.charToLife.n) return false;
    if (cost.revealHand && p.hand.filter((c) => this.matchesFilter(c, cost.revealHand.filter)).length < cost.revealHand.n) return false;
    return true;
  }

  effectiveTrashHand(p, cost) { return cost?.trashHand ?? 0; }

  async payAbilityCost(p, source, cost) {
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
      // Descartar N cartas de tu Vida (de arriba; el jugador ve cuáles).
      for (let i = 0; i < cost.trashLife && p.life.length; i++) {
        const c = p.life.shift();
        c.zone = 'trash';
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
        const c = p.life.shift(); c.zone = 'hand'; p.hand.push(c);
      }
      this.log(`${p.name} añade ${cost.lifeToHand} carta(s) de su Vida a la mano como coste (Vida: ${p.life.length}).`);
    }
    if (cost.trashToBottom) {
      for (let i = 0; i < cost.trashToBottom && p.trash.length; i++) {
        const c = p.trash.shift(); c.zone = 'deck'; p.library.push(c);
      }
      this.log(`${p.name} pone ${cost.trashToBottom} carta(s) del descarte al fondo del mazo.`);
    }
    if (cost.trashHandAny) {
      // Descarta las que el jugador elija (0 o más) — se simplifica a ninguna
      // salvo que el efecto lo requiera; el bot no descarta de más.
    }
    if (cost.trashHandFilter) {
      const cands = p.hand.filter((c) => this.matchesFilter(c, cost.trashHandFilter)).slice(0, cost.trashHand);
      for (const c of cands) { this.trashFromHand(c); this.log(`${p.name} descarta ${c.name} como coste.`); }
    }
    if (cost.restOwn) {
      for (const c of p.characters.filter((c2) => !c2.rested && this.matchesFilter(c2, cost.restOwn.filter)).slice(0, cost.restOwn.n)) {
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
        c.rested = false; c.tempPower = 0; c.mods = [];
        c.zone = 'life'; p.life.unshift(c);
        this.log(`${p.name} pone ${c.name} en lo alto de su Vida como coste (Vida: ${p.life.length}).`);
      }
    }
    if (cost.revealHand) {
      this.log(`${p.name} revela ${cost.revealHand.n} carta(s) de su mano como coste.`);
    }
    if (cost.turnLifeDown) { /* No modelamos Vida boca arriba/abajo: sin efecto visible. */ }
    if (cost.restSelf) source.rested = true;
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
    await this.payAbilityCost(p, card, main.cost);
    if (this.costReturnsDon(main.cost)) await this.fireOnBoard(p, 'onDonReturn');
    await this.resolveOps(main.ops, { source: card, p });
    card.zone = 'trash';
    p.trash.push(card);
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
    await this.payAbilityCost(p, card, ab.cost);
    if (this.costReturnsDon(ab.cost)) await this.fireOnBoard(p, 'onDonReturn');
    await this.resolveOps(ab.ops, { source: card, p });
  }

  // Dispara un timing en todas las cartas del tablero de un jugador.
  async fireOnBoard(p, when, ctx = {}) {
    for (const c of [...p.board()]) {
      if (this.over) return;
      await this.runTaggedAbilities(c, when, ctx);
    }
  }

  costReturnsDon(cost) { return !!(cost && (cost.donReturn || cost.donReturnVar || cost.returnGivenDon)); }

  async runTaggedAbilities(card, when, ctx = {}) {
    for (const ab of abilitiesOf(card, when)) {
      if (ab.donX && card.givenDon < ab.donX) continue;
      if (ab.once && card._usedTurn?.[when] === this.turn) continue;
      const p = card.owner;
      if (ab.cost) {
        // Costes internos opcionales ("You may..."): se pagan si se puede.
        if (!this.canPayAbilityCost(p, card, ab.cost)) continue;
        const wants = await p.controller.payOptionalCost(this, { cardId: card.id, when });
        if (!wants) continue;
        await this.payAbilityCost(p, card, ab.cost);
        if (this.costReturnsDon(ab.cost) && when !== 'onDonReturn') await this.fireOnBoard(p, 'onDonReturn');
      }
      (card._usedTurn ??= {})[when] = this.turn;
      await this.resolveOps(ab.ops, { source: card, p, ...ctx });
    }
  }

  // ---- ejecutor de operaciones ------------------------------------------

  async resolveOps(ops, ctx) {
    const p = ctx.p;
    const opp = this.opponentOf(p);
    for (const op of ops) {
      if (this.over) return;
      switch (op.op) {
        case 'giveRestedDon': {
          const give = Math.min(op.n, ctx.source.isLeader || true ? p.donRested : p.donRested);
          if (give <= 0) break;
          const targetId = await p.controller.chooseTarget(this, {
            purpose: 'giveDon', candidateIds: p.board().map((c) => c.id), optional: true,
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
          const owner = op.side === 'opp' ? opp : p;
          const poolAll = () => {
            let arr;
            if (op.scope === 'leader') arr = [owner.leader];
            else if (op.scope === 'leaderChar') arr = [owner.leader, ...owner.characters];
            else arr = [...owner.characters];
            return arr.filter(Boolean).filter((c) => this.matchesFilter(c, op.filter));
          };
          const label = (t) => {
            const parts = op.changes.map((ch) => `${ch.delta >= 0 ? '+' : ''}${ch.delta} ${ch.stat === 'power' ? 'poder' : 'coste'}`);
            for (const kw of op.kws) parts.push(`[${kw}]`);
            return parts.join(' y ');
          };
          const apply = (t) => {
            for (const ch of op.changes) t.addMod({ stat: ch.stat, delta: ch.delta, expireTurn });
            for (const kw of op.kws) t.addMod({ stat: 'kw', kw, expireTurn });
            this.log(`${t.name} recibe ${label(t)} (${t.power(this)}).`);
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
          const expireTurn = op.dur === 'next' ? this.turn + 1 : this.turn;
          const t = op.target === 'leader' ? p.leader : ctx.source;
          for (const ch of op.changes) t.addMod({ stat: ch.stat, delta: ch.delta, expireTurn });
          for (const kw of op.kws) t.addMod({ stat: 'kw', kw, expireTurn });
          this.log(`${t.name} gana ${op.changes.map((c) => `${c.delta >= 0 ? '+' : ''}${c.delta} ${c.stat === 'power' ? 'poder' : 'coste'}`).concat(op.kws.map((k) => `[${k}]`)).join(' y ')} (${t.power(this)}).`);
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
          if (op.all) { for (const c of pool()) { this.log(`💥 ${c.name} es KO por efecto.`); this.koCharacter(c); } if (!op._noTrigger) await this.fireOnCharKO(); break; }
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
            }
          }
          if (anyKO) await this.fireOnCharKO();
          break;
        }
        case 'bounce': case 'tuckBottom': {
          for (let i = 0; i < op.targets; i++) {
            const cands = [...opp.characters, ...p.characters].filter((c) => c.cost <= (op.maxCost ?? 99) &&
              (op.maxPower == null || c.power(this) <= op.maxPower));
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
            cands = cands.filter((c) => !c.rested && (!op.blockerOnly || c.hasBlocker) && this.matchesFilter(c, op.filter));
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) { t.rested = true; p._restedByEffectTurn = this.turn; this.log(`${t.name} queda girado.`); }
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
            if (t && cands.includes(t)) { t.rested = false; this.log(`${t.name} se endereza.`); }
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
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters.filter((c) => this.matchesFilter(c, op.filter) && !c._frozenUntil);
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { t.rested = true; t._frozenUntil = this.turn + 1; this.log(`${t.name} no se enderezará en el próximo refresco del rival.`); }
          }
          break;
        }
        case 'cannotAttack': {
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters.filter((c) => this.matchesFilter(c, op.filter) && c._cannotAttackUntil !== this.turn + 1);
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true });
            const t = this.byId(id);
            if (t && cands.includes(t)) { t._cannotAttackUntil = this.turn + 1; this.log(`${t.name} no podrá atacar hasta el próximo turno del rival.`); }
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
          const ids = await p.controller.discardFromHand(this, op.n);
          for (const id of ids.slice(0, op.n)) { const c = this.byId(id); if (c && c.zone === 'hand' && c.owner === p) { this.trashFromHand(c); this.log(`${p.name} descarta ${c.name}.`); } }
          break;
        }
        case 'trashThenDraw': {
          const ids = await p.controller.discardFromHand(this, op.trash);
          for (const id of ids.slice(0, op.trash)) { const c = this.byId(id); if (c && c.zone === 'hand' && c.owner === p) this.trashFromHand(c); }
          this.draw(p, op.n);
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
            opp.trash.push(c);
            this.log(`☠ ${opp.name} pierde 1 vida al descarte (${c.name}). Le quedan ${opp.life.length}.`);
          }
          if (!opp.life.length) { /* siguiente golpe gana; no elimina por sí solo */ }
          break;
        }
        case 'draw': {
          if (op.ifHandMax !== null && op.ifHandMax !== undefined && p.hand.length > op.ifHandMax) break;
          this.draw(p, op.n);
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
          const f = op.filter ?? (op.type ? { types: [op.type] } : {});
          const matches = (c) => {
            if (f.names && !f.names.some((nm) => c.name.toLowerCase().includes(nm.toLowerCase()))) return false;
            if (f.types && !f.types.some((t) => (c.data.subTypes ?? []).some((s) => s.toLowerCase().includes(t.toLowerCase())))) return false;
            if (f.cardType && c.type !== f.cardType) return false;
            if (f.power !== undefined && (c.data.power ?? -1) !== f.power) return false;
            if (f.maxCost !== undefined && c.cost > f.maxCost) return false;
            return true;
          };
          const hit = seen.find(matches);
          if (hit) {
            seen.splice(seen.indexOf(hit), 1);
            hit.zone = 'hand';
            p.hand.push(hit);
            this.log(`${p.name} revela ${hit.name} y lo añade a su mano.`);
          } else {
            this.log(`${p.name} no encuentra nada al mirar ${seen.length} carta(s).`);
          }
          this.shuffle(seen);
          p.library.push(...seen);
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
          if (okType && c.isCharacter && p.characters.length < 5) {
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
          for (let i = 0; i < op.n && p.life.length; i++) {
            const c = p.life.shift();
            c.zone = 'hand';
            p.hand.push(c);
            this.log(`${p.name} añade una carta de Vida a su mano. Le quedan ${p.life.length}.`);
          }
          break;
        }
        case 'deckToLife': {
          for (let i = 0; i < op.n && p.library.length; i++) {
            const c = p.library.shift();
            c.zone = 'life';
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
            p.life.unshift(cand);
            this.log(`${p.name} pone ${cand.name} en lo alto de su Vida (ahora ${p.life.length}).`);
          }
          break;
        }
        case 'lifeAddFromDeck': {
          for (let i = 0; i < op.n && p.library.length; i++) {
            const c = p.library.shift();
            c.zone = 'life';
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
            p.library.unshift(c);
            this.log(`${p.name} pone una carta de su Vida en lo alto del mazo (Vida: ${p.life.length}).`);
          }
          break;
        }
        case 'revealTopThen': {
          if (!p.library.length) break;
          const c = p.library[0];
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
          const ok = this.matchesFilter(c, op.filter) && c.cost <= (op.maxCost ?? 99) && c.isCharacter && p.characters.length < 5;
          if (ok) {
            const wants = p.isBot ? true : await p.controller.chooseOption(this, { prompt: `¿Jugar ${c.name} desde tu Vida?`, options: ['Sí, jugarla', 'No'] }) === 0;
            if (wants) {
              p.life.shift();
              c.zone = 'characters'; c.rested = false; c.summonedThisTurn = true; c.enteredTurn = this.turn;
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
          if (hit) { seen.splice(seen.indexOf(hit), 1); hit.zone = 'life'; p.life.unshift(hit); this.log(`${p.name} añade ${hit.name} a lo alto de su Vida (${p.life.length}).`); }
          this.shuffle(seen); p.library.push(...seen);
          break;
        }
        case 'lifeReorder': { this.log(`${p.name} mira y reordena sus cartas de Vida.`); break; }
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
            c.zone = 'life'; p.life.unshift(c);
            this.log(`${p.name} pone ${c.name} en lo alto de su Vida (${p.life.length}).`);
          }
          break;
        }
        case 'charToLifeEffect': {
          const src = op.side === 'opp' ? opp : p;
          for (let i = 0; i < op.targets; i++) {
            const cands = src.characters.filter((c) => this.matchesFilter(c, op.filter));
            if (!cands.length) break;
            const id = await p.controller.chooseTarget(this, { purpose: op.side === 'opp' ? 'ko' : 'toLife', candidateIds: cands.map((c) => c.id), optional: true });
            const c = this.byId(id);
            if (!c || !cands.includes(c)) break;
            src.donActive += c.givenDon; c.givenDon = 0;
            src.characters.splice(src.characters.indexOf(c), 1);
            c.rested = false; c.tempPower = 0; c.mods = [];
            c.zone = 'life'; src.life.unshift(c);
            this.log(`${c.name} pasa a lo alto de la Vida de ${src.name} (${src.life.length}).`);
          }
          break;
        }
        case 'trashFaceUpLife': { /* No modelamos Vida boca arriba: sin efecto. */ break; }
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
          const zone = op.zone === 'deck' ? p.library : op.zone === 'trash' ? p.trash : p.hand;
          // "each of [A],[B],[C]": juega uno por cada nombre; si no, hasta N.
          const rounds = op.each && op.filter?.names ? op.filter.names.map((nm) => ({ names: [nm] })) : Array(op.targets ?? 1).fill(op.filter);
          for (const rf of rounds) {
            if (p.characters.length >= 5) break;
            const cands = zone.filter((c) => c.isCharacter && c.cost <= (op.maxCost ?? 99) && this.matchesFilter(c, rf) && this.matchesFilter(c, op.filter));
            if (!cands.length) continue;
            const id = await p.controller.chooseTarget(this, {
              purpose: 'playFree', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const hit = this.byId(id);
            if (!hit || !cands.includes(hit)) break;
            zone.splice(zone.indexOf(hit), 1);
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
          if (c.isCharacter && p.characters.length < 5 && c.zone !== 'characters') {
            if (c.zone === 'hand') p.hand.splice(p.hand.indexOf(c), 1);
            else if (c.zone === 'trash') p.trash.splice(p.trash.indexOf(c), 1);
            else if (c.zone === 'life') p.life.splice(p.life.indexOf(c), 1);
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
          if (ctx.battle) ctx.battle.noBlocker = { minPower: op.minPower };
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
  }

  payDon(p, cost) {
    if (cost > p.donActive) throw new Error('DON insuficiente');
    p.donActive -= cost;
    p.donRested += cost;
  }

  async playCharacter(p, { cardId, trashId = null }) {
    const card = this.byId(cardId);
    if (!card || card.owner !== p || card.zone !== 'hand' || !card.isCharacter) {
      throw new Error('carta de personaje inválida');
    }
    if (p.characters.length >= 5) {
      const victim = this.byId(trashId);
      if (!victim || victim.zone !== 'characters' || victim.owner !== p) {
        throw new Error('área de personajes llena (elige uno para el descarte)');
      }
      this.trashCard(victim);
      this.log(`${p.name} manda ${victim.name} al descarte para hacer sitio.`);
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
  }

  giveDon(p, { cardId, n = 1 }) {
    const card = this.byId(cardId);
    if (!card || card.owner !== p || (card.zone !== 'characters' && card.zone !== 'leader')) {
      throw new Error('objetivo de DON inválido');
    }
    if (p.donActive < n) throw new Error('DON insuficiente');
    p.donActive -= n;
    card.givenDon += n;
    this.log(`${p.name} da ${n} DON!! a ${card.name} (${card.power(this)}).`);
    this.narrate(p, { kind: 'don', n, card: card.name });
  }

  // ---- combate -----------------------------------------------------------

  async attack(p, { attackerId, targetId }) {
    const attacker = this.byId(attackerId);
    const opp = this.opponentOf(p);
    if (!attacker || attacker.owner !== p || !attacker.canAttack(this)) {
      throw new Error('atacante inválido');
    }
    let target = targetId === 'leader' ? opp.leader : this.byId(targetId);
    const canHitActive = attacker.script?.abilities?.some((ab) => ab.ops.some((o) => o.op === 'canAttackActive'));
    const validTarget = target === opp.leader ||
      (target && target.owner === opp && target.zone === 'characters' && (target.rested || canHitActive));
    if (!validTarget) throw new Error('objetivo inválido (líder o personaje girado)');

    attacker.rested = true;
    this.log(`⚔ ${attacker.name} (${attacker.power(this)}) ataca a ${target.name} (${target.power(this)}).`);
    await this.narrate(p, { kind: 'attack', attacker: attacker.name, targetName: target.name, targetIsLeader: target.isLeader });
    if (this.onAnimate) await this.onAnimate({ type: 'attack', attackerId: attacker.id, targetId: target.id });

    // [When Attacking] (con condición [DON!! xN]); puede vetar bloqueadores.
    const battle = { noBlocker: null };
    await this.runTaggedAbilities(attacker, 'whenAttacking', { battle });
    if (this.over) return;

    // Paso de bloqueo (respetando vetos de la batalla y del turno).
    let blockers = opp.characters.filter((c) => c.hasBlocker && !c.rested && c !== target);
    if (attacker._noBlockerTurn === this.turn) blockers = [];
    if (battle.noBlocker) {
      blockers = battle.noBlocker.minPower
        ? blockers.filter((c) => c.power(this) < battle.noBlocker.minPower)
        : [];
    }
    if (blockers.length) {
      const blockId = await opp.controller.chooseBlocker(this, {
        attackerId: attacker.id,
        targetId: target === opp.leader ? 'leader' : target.id,
        blockerIds: blockers.map((b) => b.id),
      });
      const blocker = this.byId(blockId);
      if (blocker && blockers.includes(blocker)) {
        blocker.rested = true;
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
      this.trashFromHand(c);
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
      await this.payAbilityCost(opp, c, ab.cost);
      await this.resolveOps(ab.ops, { source: c, p: opp, battle: { defenderId: target.id } });
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
        }
      } else if (!this.canBeKOd(target, { byEffect: false, byLeaderBattle: attacker.isLeader })) {
        this.log(`🛡 ${target.name} no puede ser KO en batalla (efecto).`);
        await this.afterCharBattle(attacker, target);
      } else if (await this.tryPreventKO(target, { byEffect: false })) {
        await this.afterCharBattle(attacker, target);
      } else {
        this.log(`💥 ${target.name} es KO.`);
        this.koCharacter(target);
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
    this.checkState();
  }

  async fireOnCharKO() {
    for (const q of this.players) await this.fireOnBoard(q, 'onCharKO');
  }

  async afterCharBattle(attacker, battled = null) {
    if (attacker.zone !== 'characters') return;
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
    if (source?.hasBanish) {
      lifeCard.zone = 'trash';
      defender.trash.push(lifeCard);
      this.log(`☠ ${defender.name} pierde 1 vida (desterrada: ${lifeCard.name}). Le quedan ${defender.life.length}.`);
      return;
    }
    this.log(`💔 ${defender.name} pierde 1 vida (${lifeCard.name}). Le quedan ${defender.life.length}.`);
    // [Trigger]: el defensor decide si lo activa en lugar de llevársela a la mano.
    const trigAb = abilitiesOf(lifeCard, 'trigger')[0];
    if (trigAb && (trigAb.ops.length)) {
      const wants = await defender.controller.triggerDecision(this, { cardId: lifeCard.id });
      if (wants) {
        this.log(`✨ ${defender.name} activa el [Trigger] de ${lifeCard.name}.`);
        lifeCard.zone = 'trigger';
        await this.resolveOps(trigAb.ops, { source: lifeCard, p: defender, toHandFallback: true });
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
    p.donActive += c.givenDon; // los DON dados vuelven al coste... (girados por regla; simplificado)
    c.givenDon = 0;
    const i = p.characters.indexOf(c);
    if (i !== -1) p.characters.splice(i, 1);
    c.zone = 'trash';
    c.rested = false;
    c.tempPower = 0;
    p.trash.push(c);
  }

  trashCard(c) {
    if (c.zone === 'characters') return this.koCharacter(c);
    if (c.zone === 'stage' && c.owner.stage === c) c.owner.stage = null;
    c.zone = 'trash';
    c.owner.trash.push(c);
  }

  trashFromHand(c) {
    const p = c.owner;
    p.hand.splice(p.hand.indexOf(c), 1);
    c.zone = 'trash';
    p.trash.push(c);
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

  // Vista serializable de la partida para un jugador (base para F7:
  // el servidor enviará exactamente esto, sin zonas ocultas del rival).
  viewFor(p) {
    const opp = this.opponentOf(p);
    const pub = (c) => c && {
      id: c.id, name: c.name, type: c.type, cost: c.cost, color: c.color,
      power: c.power(this), basePower: c.data.power, counter: c.counterValue,
      rested: c.rested, givenDon: c.givenDon, text: c.text, image: c.data.image,
    };
    return {
      turn: this.turn, phase: this.phase, active: this.activePlayer.name,
      you: {
        name: p.name, hand: p.hand.map(pub), leader: pub(p.leader),
        characters: p.characters.map(pub), stage: pub(p.stage),
        life: p.life.length, deck: p.library.length, trash: p.trash.map(pub),
        don: { deck: p.donDeck, active: p.donActive, rested: p.donRested, given: p.donGiven },
      },
      opponent: {
        name: opp.name, handCount: opp.hand.length, leader: pub(opp.leader),
        characters: opp.characters.map(pub), stage: pub(opp.stage),
        life: opp.life.length, deck: opp.library.length, trash: opp.trash.map(pub),
        don: { deck: opp.donDeck, active: opp.donActive, rested: opp.donRested, given: opp.donGiven },
      },
    };
  }
}
