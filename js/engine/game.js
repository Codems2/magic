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
  constructor(configs, { seed = 42, onLog = null, maxTurns = 60 } = {}) {
    resetIds();
    this.rng = mulberry32(seed);
    this.onLog = onLog;
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

  staticPowerFor(card) {
    let bonus = 0;
    const p = card.owner;
    for (const ab of card.script?.abilities ?? []) {
      if (ab.donX && card.givenDon < ab.donX) continue;
      for (const op of ab.ops) {
        if (op.op === 'powerSelf' && ab.when === 'static') bonus += op.n;
        else if (op.op === 'staticSelfPower' && p.characters.length >= (op.cond?.minChars ?? 0)) bonus += op.n;
      }
    }
    // Auras de otras cartas del mismo jugador (p. ej. "si está girada, +1000").
    for (const other of p.board()) {
      if (other === card) continue;
      for (const ab of other.script?.abilities ?? []) {
        if (ab.donX && other.givenDon < ab.donX) continue;
        if (ab.yourTurn && this.activePlayer !== p) continue;
        for (const op of ab.ops) {
          if (op.op === 'auraWhileRested' && other.rested) bonus += op.n;
        }
      }
    }
    return bonus;
  }

  staticKeyword(card, kw) {
    for (const ab of card.script?.abilities ?? []) {
      if (ab.when !== 'static') continue;
      if (ab.donX && card.givenDon < ab.donX) continue;
      if (ab.ops.some((op) => op.op === 'gainKeyword' && op.kw === kw)) return true;
    }
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
      c.rested = false;
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
    for (const q of this.players) for (const c of q.board()) c.cleanupEndOfTurn();
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
    if (cost.trashHand > p.hand.length) return false;
    if (cost.restSelf && source.rested) return false;
    return true;
  }

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
    if (cost.restSelf) source.rested = true;
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
    await this.payAbilityCost(p, card, main.cost);
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
    await this.payAbilityCost(p, card, ab.cost);
    await this.resolveOps(ab.ops, { source: card, p });
  }

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
          for (let i = 0; i < op.targets; i++) {
            const cands = opp.characters.filter((c) =>
              (op.maxCost === null || c.cost <= op.maxCost) &&
              (op.maxPower === null || c.power(this) <= op.maxPower) &&
              (!op.restedOnly || c.rested) &&
              (!op.blockerOnly || c.hasBlocker));
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'ko', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) {
              this.log(`💥 ${t.name} es KO por efecto.`);
              this.koCharacter(t);
            }
          }
          break;
        }
        case 'bounce': case 'tuckBottom': {
          for (let i = 0; i < op.targets; i++) {
            const cands = [...opp.characters, ...p.characters].filter((c) => c.cost <= op.maxCost);
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
            const cands = opp.characters.filter((c) => !c.rested);
            if (!cands.length) break;
            const targetId = await p.controller.chooseTarget(this, {
              purpose: 'rest', candidateIds: cands.map((c) => c.id), optional: true,
            });
            const t = this.byId(targetId);
            if (t && cands.includes(t)) { t.rested = true; this.log(`${t.name} queda girado.`); }
          }
          break;
        }
        case 'unrestChar': {
          for (let i = 0; i < op.targets; i++) {
            const cands = p.characters.filter((c) => c.rested && c.cost <= op.maxCost);
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
        case 'peekReorder': {
          this.log(`${p.name} mira las ${Math.min(op.n, p.library.length)} primeras cartas de su mazo.`);
          break;
        }
        case 'trashToHand': {
          for (let i = 0; i < op.targets; i++) {
            const cands = p.trash.filter((c) => c.isCharacter && c.cost <= op.maxCost);
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
          const zone = op.zone === 'deck' ? p.library : p.hand;
          const hit = zone.find((c) => c.isCharacter && c.cost <= op.maxCost &&
            c.name.toLowerCase().includes(op.name.toLowerCase()));
          if (hit && p.characters.length < 5) {
            zone.splice(zone.indexOf(hit), 1);
            hit.zone = 'characters';
            hit.rested = false;
            hit.summonedThisTurn = true;
            p.characters.push(hit);
            this.log(`${p.name} pone en juego ${hit.name} gratis.`);
            await this.runTaggedAbilities(hit, 'onPlay');
          }
          if (op.zone === 'deck') this.shuffle(p.library);
          break;
        }
        case 'playSelf': {
          const c = ctx.source;
          if (c.isCharacter && p.characters.length < 5 && c.zone !== 'characters') {
            if (c.zone === 'hand') p.hand.splice(p.hand.indexOf(c), 1);
            c.zone = 'characters';
            c.rested = false;
            c.summonedThisTurn = true;
            p.characters.push(c);
            this.log(`${p.name} pone en juego ${c.name} gratis.`);
            await this.runTaggedAbilities(c, 'onPlay');
          } else if (ctx.toHandFallback) {
            c.zone = 'hand';
            p.hand.push(c);
          }
          break;
        }
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
  }

  // ---- combate -----------------------------------------------------------

  async attack(p, { attackerId, targetId }) {
    const attacker = this.byId(attackerId);
    const opp = this.opponentOf(p);
    if (!attacker || attacker.owner !== p || !attacker.canAttack(this)) {
      throw new Error('atacante inválido');
    }
    let target = targetId === 'leader' ? opp.leader : this.byId(targetId);
    const validTarget = target === opp.leader ||
      (target && target.owner === opp && target.zone === 'characters' && target.rested);
    if (!validTarget) throw new Error('objetivo inválido (líder o personaje girado)');

    attacker.rested = true;
    this.log(`⚔ ${attacker.name} (${attacker.power(this)}) ataca a ${target.name} (${target.power(this)}).`);

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
      } else {
        this.log(`💥 ${target.name} es KO.`);
        this.koCharacter(target);
        // ST02-010: "si esta carta batalla contra un personaje, enderézala".
        await this.afterCharBattle(attacker);
      }
    } else {
      this.log(`El ataque no supera al defensor (${atkPower} vs ${defPower}).`);
      if (!target.isLeader) await this.afterCharBattle(attacker);
    }
    // El bono de counter dura solo esta batalla.
    if (target.zone !== 'trash') target.tempPower -= counterBonus;
    this.checkState();
  }

  async afterCharBattle(attacker) {
    if (attacker.zone !== 'characters') return;
    for (const ab of attacker.script?.abilities ?? []) {
      if (!ab.ops.some((op) => op.op === 'unrestAfterCharBattle')) continue;
      if (ab.donX && attacker.givenDon < ab.donX) continue;
      if (ab.once && attacker._usedTurn?.afterBattle === this.turn) continue;
      (attacker._usedTurn ??= {}).afterBattle = this.turn;
      attacker.rested = false;
      this.log(`${attacker.name} se endereza tras la batalla.`);
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
