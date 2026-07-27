// F7b — Espejo local del estado para el cliente online. Implementa la
// superficie mínima que usan la UI y el HumanController (byId, players,
// opponentOf, canPayAbilityCost, y cartas con power()/script/keywords...),
// construida SOLO desde la vista que envía el servidor (game.viewFor) y los
// descriptores adjuntos a cada pregunta. Aquí no hay motor: la autoridad de
// reglas es siempre el servidor; esto existe para pintar y para ofrecer
// acciones razonables.

import { buildScript } from '../engine/effects.js';

class ClientCard {
  constructor(desc, cg) {
    this.id = desc.id;
    this._cg = cg;
    this.update(desc);
  }

  update(d) {
    this._d = d;
    this.zone = d.zone;
    this.rested = !!d.rested;
    this.givenDon = d.givenDon ?? 0;
    this.owner = this._cg.players[d.ownerIdx] ?? null;
    this.mods = [];
    if (this._lastText !== d.text) this._script = null; // re-parsear si cambia
    this._lastText = d.text;
  }

  get data() {
    return {
      id: this._d.dataId, power: this._d.basePower, cost: this._d.cost,
      image: this._d.image, subTypes: this._d.subTypes ?? [],
      counter: this._d.counter, text: this._d.text,
    };
  }
  get name() { return this._d.name; }
  get type() { return this._d.type; }
  get cost() { return this._d.cost ?? 0; }
  get color() { return this._d.color; }
  get counterValue() { return this._d.counter ?? 0; }
  get text() { return this._d.text ?? ''; }
  get isLeader() { return this.type === 'Leader'; }
  get isCharacter() { return this.type === 'Character'; }
  get isEvent() { return this.type === 'Event'; }
  get isStage() { return this.type === 'Stage'; }
  get hasBlocker() { return !!this._d.hasBlocker; }
  get hasRush() { return !!this._d.hasRush; }
  get hasDoubleAttack() { return this.text.includes('[Double Attack]'); }
  get hasBanish() { return this.text.includes('[Banish]'); }
  get hasTrigger() { return this.text.includes('[Trigger]'); }

  power() { return this._d.power ?? this._d.basePower ?? 0; }
  canAttack() { return !!this._d.canAttack; }
  // El servidor ya calculó si su [Activate: Main] es usable ahora mismo.
  get _srvCanActivate() { return this._d.canActivate; }

  // Script local (desde el texto) para pistas/timings de la UI.
  get script() {
    if (!this._script) this._script = buildScript({ id: this._d.dataId, text: this.text });
    return this._script;
  }
}

class ClientPlayer {
  constructor(cg, idx) {
    this._cg = cg;
    this.idx = idx;
    this.name = '';
    this.hand = [];
    this.characters = [];
    this.stage = null;
    this.leader = null;
    this.life = { length: 0 };
    this.library = { length: 0 };
    this.trash = [];
    this.donDeck = 10; this.donActive = 0; this.donRested = 0; this.donGiven = 0;
  }
  board() { return [this.leader, ...this.characters].filter(Boolean); }

  _applyCommon(v) {
    this.name = v.name;
    this.leader = this._cg.registerDesc(v.leader);
    this.characters = (v.characters ?? []).map((d) => this._cg.registerDesc(d));
    this.stage = v.stage ? this._cg.registerDesc(v.stage) : null;
    this.life = { length: v.life ?? 0 };
    this.library = { length: v.deck ?? 0 };
    this.trash = (v.trash ?? []).map((d) => this._cg.registerDesc(d));
    this.donDeck = v.don.deck; this.donActive = v.don.active;
    this.donRested = v.don.rested; this.donGiven = v.don.given;
  }
  applyOwn(v) {
    this._applyCommon(v);
    this.hand = (v.hand ?? []).map((d) => this._cg.registerDesc(d));
  }
  applyOpp(v) {
    this._applyCommon(v);
    this.hand = { length: v.handCount ?? 0 };   // solo el número: su mano es oculta
  }
}

export class ClientGame {
  constructor() {
    this.players = [new ClientPlayer(this, 0), new ClientPlayer(this, 1)];
    this.cards = new Map();
    this.turn = 0;
    this.phase = 'setup';
    this._activeIdx = 0;
    this.youIdx = 0;
    this.over = false;
  }

  registerDesc(d) {
    if (!d) return null;
    let c = this.cards.get(d.id);
    if (c) c.update(d);
    else { c = new ClientCard(d, this); this.cards.set(d.id, c); }
    return c;
  }

  // Descriptores adjuntos a una pregunta (cartas reveladas, del descarte...).
  absorbAskCards(cards) {
    for (const d of Object.values(cards ?? {})) this.registerDesc(d);
  }

  update(view) {
    this.turn = view.turn;
    this.phase = view.phase;
    this._activeIdx = view.activeIdx;
    this.youIdx = view.youIdx;
    this.over = !!view.over;
    this.players[view.youIdx].applyOwn(view.you);
    this.players[1 - view.youIdx].applyOpp(view.opponent);
  }

  get you() { return this.players[this.youIdx]; }
  get activePlayer() { return this.players[this._activeIdx] ?? null; }
  opponentOf(p) { return this.players[0] === p ? this.players[1] : this.players[0]; }
  byId(id) { return this.cards.get(id) ?? null; }

  // Aproximación de pagabilidad para filtrar la UI (la autoridad es el
  // servidor: una acción inválida simplemente se rechaza y se re-pregunta).
  canPayAbilityCost(p, source, cost) {
    if (!cost) return true;
    const handLen = Array.isArray(p.hand) ? p.hand.length : (p.hand?.length ?? 0);
    if (cost.donRest > p.donActive) return false;
    if (cost.donReturn > p.donActive + p.donRested) return false;
    if (cost.donReturnVar && p.donActive + p.donRested < 1) return false;
    if (cost.returnGivenDon && p.donGiven < cost.returnGivenDon) return false;
    if (cost.trashHand > handLen) return false;
    if (cost.trashLife > p.life.length) return false;
    if (cost.lifeToHand > p.life.length) return false;
    if (cost.trashToBottom > p.trash.length) return false;
    if (cost.restSelf && source?.rested) return false;
    return true;
  }
}
