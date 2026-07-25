// Modelo de carta e instancia en juego (One Piece TCG).

let nextId = 1;
export function resetIds() { nextId = 1; }

// Instancia de una carta física. `data` es la entrada del JSON del mazo.
export class CardInstance {
  constructor(data, owner) {
    this.id = nextId++;          // id estable: las acciones viajan por id
    this.data = data;
    this.owner = owner;          // Player
    this.zone = 'deck';          // deck | hand | characters | leader | stage | life | trash | don
    this.rested = false;         // girada
    this.givenDon = 0;           // DON!! dados (cada uno +1000 en tu turno)
    this.tempPower = 0;          // bonos hasta fin de turno / de batalla
    this.tempCost = 0;           // reducción de coste temporal (negativa)
    this.enteredTurn = 0;        // control de "no ataca el turno que entra"
    this.summonedThisTurn = false;
  }

  get name() { return this.data.name; }
  get type() { return this.data.type; }       // Leader | Character | Event | Stage
  get cost() { return Math.max(0, (this.data.cost ?? 0) + this.tempCost); }
  get color() { return this.data.color; }
  get counterValue() { return this.data.counter ?? 0; }
  get text() { return this.data.text ?? ''; }
  get isLeader() { return this.type === 'Leader'; }
  get isCharacter() { return this.type === 'Character'; }
  get isEvent() { return this.type === 'Event'; }
  get isStage() { return this.type === 'Stage'; }

  // Palabras clave de combate impresas (el resto de efectos llega en F3).
  hasKeyword(kw) { return this.text.includes(`[${kw}]`); }
  get hasRush() { return this.hasKeyword('Rush'); }
  get hasBlocker() { return this.hasKeyword('Blocker'); }
  get hasDoubleAttack() { return this.hasKeyword('Double Attack'); }
  get hasBanish() { return this.hasKeyword('Banish'); }
  get hasTrigger() { return this.text.includes('[Trigger]'); }

  // Poder efectivo: base + DON dados (en tu turno) + bonos temporales + estáticas.
  power(game) {
    const base = this.data.power ?? 0;
    const donBonus = game && game.activePlayer === this.owner ? this.givenDon * 1000 : 0;
    const staticBonus = game?.staticPowerFor ? game.staticPowerFor(this) : 0;
    return base + donBonus + this.tempPower + staticBonus;
  }

  canAttack(game) {
    if (this.rested) return false;
    // Nadie puede atacar durante el primer turno de la partida.
    if (game && game.turn <= 1) return false;
    if (this.isLeader) return true;
    if (!this.isCharacter || this.zone !== 'characters') return false;
    const rush = this.hasRush || this._tempKw?.has('Rush') || game?.staticKeyword?.(this, 'Rush');
    return !this.summonedThisTurn || rush;
  }

  cleanupEndOfTurn() {
    this.tempPower = 0;
    this.tempCost = 0;
    this.summonedThisTurn = false;
    this._tempKw?.clear();
    this._noBlockerTurn = 0;
  }
}
