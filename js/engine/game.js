// Motor de partida 1v1 de One Piece Card Game.
//
// Decisiones de diseño (ver PLAN.md §4b):
//  - Sin DOM: corre igual en navegador, en Node (simulación) y en un futuro
//    servidor autoritativo.
//  - Toda decisión de jugador pasa por su `controller` (bot, humano o remoto).
//  - Las acciones son JSON plano que referencia cartas POR ID.
//  - Todo el azar sale de un RNG con semilla.

import { CardInstance, resetIds } from './cards.js';

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

    for (const p of this.players) {
      p.leader = this.register(new CardInstance(p.deck.leader, p));
      p.leader.zone = 'leader';
      for (const entry of p.deck.cards) {
        for (let i = 0; i < entry.count; i++) {
          const c = this.register(new CardInstance(entry, p));
          p.library.push(c);
        }
      }
      this.shuffle(p.library);
    }
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

    // 5. End.
    this.phase = 'end';
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
      default: throw new Error(`acción desconocida ${action.type}`);
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

    // Paso de bloqueo.
    const blockers = opp.characters.filter((c) => c.hasBlocker && !c.rested && c !== target);
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
      }
    }

    // Paso de counter: descartar cartas con valor de counter.
    const counterIds = await opp.controller.counterStep(this, {
      attackerId: attacker.id,
      targetId: target === opp.leader ? 'leader' : target.id,
      attackPower: attacker.power(this),
      targetPower: target.power(this),
    });
    let counterBonus = 0;
    for (const id of counterIds ?? []) {
      const c = this.byId(id);
      if (!c || c.owner !== opp || c.zone !== 'hand' || !c.counterValue) continue;
      counterBonus += c.counterValue;
      this.trashFromHand(c);
      this.log(`✋ ${opp.name} descarta ${c.name} como counter (+${c.counterValue}).`);
    }
    target.tempPower += counterBonus;

    // Resolución.
    const atkPower = attacker.power(this);
    const defPower = target.power(this);
    if (atkPower >= defPower) {
      if (target.isLeader) {
        const hits = attacker.hasDoubleAttack ? 2 : 1;
        for (let i = 0; i < hits; i++) {
          if (this.over) return;
          this.dealLeaderDamage(opp, attacker);
        }
      } else {
        this.log(`💥 ${target.name} es KO.`);
        this.koCharacter(target);
      }
    } else {
      this.log(`El ataque no supera al defensor (${atkPower} vs ${defPower}).`);
    }
    // El bono de counter dura solo esta batalla.
    if (target.zone !== 'trash') target.tempPower -= counterBonus;
    this.checkState();
  }

  dealLeaderDamage(defender, source) {
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
    lifeCard.zone = 'hand';
    defender.hand.push(lifeCard);
    const trig = lifeCard.hasTrigger ? ' [Trigger pendiente de F3]' : '';
    this.log(`💔 ${defender.name} pierde 1 vida (${lifeCard.name} a su mano)${trig}. Le quedan ${defender.life.length}.`);
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
