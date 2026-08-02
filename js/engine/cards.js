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
    this.faceUp = false;         // solo relevante en la zona de Vida (pública si true)
    this.givenDon = 0;           // DON!! dados (cada uno +1000 en tu turno)
    this.tempPower = 0;          // bonos de batalla (counter) y de "este turno"
    this.tempCost = 0;           // reducción de coste temporal (negativa)
    this.enteredTurn = 0;        // control de "no ataca el turno que entra"
    this.summonedThisTurn = false;
    // Modificadores con duración: {stat:'power'|'cost'|'kw', delta|kw, expireTurn}.
    // expireTurn = último turno en el que siguen activos (se barren al final
    // de ese turno). "durante este turno" → turno actual; "hasta tu próximo
    // turno / el próximo del rival" → turno actual + 1.
    this.mods = [];
  }

  addMod(mod) { this.mods.push(mod); }

  modPower() { let s = 0; for (const m of this.mods) if (m.stat === 'power') s += m.delta; return s; }
  modCost() { let s = 0; for (const m of this.mods) if (m.stat === 'cost') s += m.delta; return s; }

  // Barre los modificadores que expiran al final del turno `turn`.
  expireMods(turn) { this.mods = this.mods.filter((m) => m.expireTurn > turn); }

  get name() { return this.data.name; }
  get type() { return this.data.type; }       // Leader | Character | Event | Stage
  get cost() {
    const staticDelta = this.game?.staticCostFor ? this.game.staticCostFor(this) : 0;
    return Math.max(0, (this.data.cost ?? 0) + this.tempCost + this.modCost() + staticDelta);
  }
  get color() { return this.data.color; }
  get counterValue() { return this.data.counter ?? 0; }
  get text() { return this.data.text ?? ''; }
  get isLeader() { return this.type === 'Leader'; }
  get isCharacter() { return this.type === 'Character'; }
  get isEvent() { return this.type === 'Event'; }
  get isStage() { return this.type === 'Stage'; }

  // Palabra clave activa = impresa, otorgada "este turno" o por un modificador
  // temporizado (p. ej. "gana [Rush] hasta tu próximo turno").
  hasKeyword(kw) {
    // "Negate the effect of ...": sin keywords (ni impresas) este turno.
    if (this._negatedUntil !== undefined && this._negatedUntil === this.game?.turn) return false;
    if (this.hasPrintedKeyword(kw)) return true;
    if (this._tempKw?.has(kw)) return true;
    if (this.mods.some((m) => m.stat === 'kw' && m.kw === kw)) return true;
    // Concedida por una estática (propia o de grupo), p. ej. "gains [Blocker]".
    if (this.zone !== 'deck' && this.zone !== 'life' && this.game?.staticKeyword?.(this, kw)) return true;
    return false;
  }
  // Keyword IMPRESA: el tag cuenta solo al inicio del texto o tras el final
  // de una frase u otro tag/paréntesis. Una MENCIÓN dentro de una frase
  // ("cannot activate [Blocker]", "K.O. up to 1 [Blocker] Character",
  // "gains [Rush]") no convierte a la carta en bloqueadora/rusher (caso
  // Hina OP12-051).
  hasPrintedKeyword(kw) {
    const text = this.text;
    if (!text.includes(`[${kw}]`)) return false;
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[.!:•)\\n]\\s*|\\]\\s*)\\[${esc}\\]`).test(text);
  }

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
    return base + donBonus + this.tempPower + this.modPower() + staticBonus;
  }

  canAttack(game) {
    if (this.rested) return false;
    // Regla oficial 6-5-6-1: NINGÚN jugador puede batallar en su primer
    // turno (turnos globales 1 y 2). El primer ataque llega en el turno 3.
    if (game && game.turn <= 2) return false;
    // Congelado por un efecto: no puede atacar este turno.
    if (game && this._cannotAttackUntil === game.turn) return false;
    if (this.isLeader) return true;
    if (!this.isCharacter || this.zone !== 'characters') return false;
    const rush = this.hasRush || this._tempKw?.has('Rush') || game?.staticKeyword?.(this, 'Rush');
    // [Rush: Character]: puede atacar el turno que entra, pero solo a
    // personajes (la restricción de objetivo se valida en attack()).
    const rushChar = this.hasKeyword('Rush: Character');
    return !this.summonedThisTurn || rush || rushChar;
  }

  cleanupEndOfTurn() {
    this.tempPower = 0;
    this.tempCost = 0;
    this.summonedThisTurn = false;
    this._tempKw?.clear();
    this._noBlockerTurn = 0;
  }
}
