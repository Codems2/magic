// Modelo de cartas e instancias en juego.

let nextId = 1;
export function resetIds() { nextId = 1; }

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
export function parseNum(word, xValue = 0) {
  if (word == null) return 1;
  const w = String(word).toLowerCase();
  if (w === 'x') return xValue;
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return NUM_WORDS[w] ?? 1;
}

// Descompone "{2}{W}{U}" en { generic: 2, pips: ['W','U'], x: 0 }.
// Los símbolos híbridos se guardan como arrays de opciones.
export function parseManaCost(cost) {
  const out = { generic: 0, pips: [], x: 0 };
  if (!cost) return out;
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1].toUpperCase();
    if (/^\d+$/.test(sym)) out.generic += parseInt(sym, 10);
    else if (sym === 'X') out.x += 1;
    else if (sym.includes('/')) {
      const opts = sym.split('/').filter((s) => s !== 'P');
      if (opts.every((o) => /^\d+$/.test(o))) out.generic += parseInt(opts[0], 10);
      else out.pips.push(opts.filter((o) => !/^\d+$/.test(o)));
    } else if ('WUBRGC'.includes(sym)) out.pips.push([sym]);
    else if (sym === 'S') out.pips.push(['W', 'U', 'B', 'R', 'G', 'C']); // nieve: cualquiera
    else out.generic += 1;
  }
  return out;
}

export function costCmc(parsed, xValue = 0) {
  return parsed.generic + parsed.pips.length + parsed.x * xValue;
}

// Instancia de carta (en cualquier zona). `data` es la entrada del JSON del precon.
export class CardInstance {
  constructor(data, owner) {
    this.id = nextId++;
    this.data = data;
    this.owner = owner;         // Player
    this.controller = owner;
    this.zone = 'library';
    this.tapped = false;
    this.summoningSick = false;
    this.damage = 0;
    this.counters = 0;          // contadores +1/+1 (netos)
    this.attachedTo = null;     // CardInstance (equipo/aura)
    this.attachments = [];
    this.tempPT = [0, 0];       // bonos hasta el final del turno
    this.tempKeywords = new Set();
    this.isCommander = false;
    this.commanderCasts = 0;    // para el impuesto
    this.isToken = false;
    this.attacking = null;      // Player al que ataca
    this.blocking = null;       // CardInstance a la que bloquea
    this.enteredTurn = 0;
    this.crewed = false;        // vehículos: es criatura hasta el final del turno
  }

  // Nombre para mostrar (español si está localizado). El motor y el intérprete
  // de efectos usan siempre data.name/oracleText en inglés.
  get name() { return this.data.nameEs ?? this.data.name; }
  get typeLine() { return this.data.typeLine || ''; }
  get oracleText() { return this.data.oracleText || ''; }
  get cmc() { return this.data.cmc || 0; }

  hasType(t) { return this.typeLine.toLowerCase().includes(t.toLowerCase()); }
  get isLand() { return this.hasType('Land'); }
  get isCreature() { return this.hasType('Creature') || this.crewed; }
  get isVehicle() { return this.hasSubtype('Vehicle'); }
  get isArtifact() { return this.hasType('Artifact'); }
  get isEnchantment() { return this.hasType('Enchantment'); }
  get isPlaneswalker() { return this.hasType('Planeswalker'); }
  get isInstant() { return this.hasType('Instant'); }
  get isSorcery() { return this.hasType('Sorcery'); }
  get isPermanentType() { return !this.isInstant && !this.isSorcery; }
  get isLegendary() { return this.hasType('Legendary'); }
  get isAura() { return this.hasType('Aura'); }
  get isEquipment() { return this.hasType('Equipment'); }

  hasSubtype(sub) {
    const parts = this.typeLine.split('—');
    return parts.length > 1 && parts[1].toLowerCase().includes(sub.toLowerCase());
  }

  // Palabras clave efectivas (impresas + temporales + de anclajes + estáticas del juego).
  keywords(game) {
    const kws = new Set((this.data.keywords || []).map((k) => k.toLowerCase()));
    for (const k of this.script?.selfKeywords || []) kws.add(k);
    for (const k of this.tempKeywords) kws.add(k);
    for (const att of this.attachments) {
      for (const k of att.script?.grantsKeywords || []) kws.add(k);
    }
    if (game) {
      for (const { keywords } of game.staticBonusesFor(this)) {
        for (const k of keywords) kws.add(k);
      }
    }
    return kws;
  }
  hasKeyword(kw, game) { return this.keywords(game).has(kw.toLowerCase()); }

  basePT() {
    const p = parseInt(this.data.power, 10);
    const t = parseInt(this.data.toughness, 10);
    return [Number.isNaN(p) ? 0 : p, Number.isNaN(t) ? 0 : t];
  }

  power(game) {
    let [p] = this.basePT();
    p += this.counters + this.tempPT[0];
    for (const att of this.attachments) p += att.script?.attachPT?.[0] || 0;
    if (game) for (const b of game.staticBonusesFor(this)) p += b.pt[0];
    return Math.max(0, p);
  }

  toughness(game) {
    let [, t] = this.basePT();
    t += this.counters + this.tempPT[1];
    for (const att of this.attachments) t += att.script?.attachPT?.[1] || 0;
    if (game) for (const b of game.staticBonusesFor(this)) t += b.pt[1];
    return t;
  }

  get parsedCost() {
    if (!this._parsedCost) this._parsedCost = parseManaCost(this.data.manaCost);
    return this._parsedCost;
  }

  canAttack(game) {
    return this.isCreature && !this.tapped &&
      (!this.summoningSick || this.hasKeyword('haste', game)) &&
      !this.hasKeyword('defender', game);
  }

  canBlock(attacker, game) {
    if (!this.isCreature || this.tapped) return false;
    if (this.hasKeyword('cantblock', game)) return false;
    const aKws = attacker.keywords(game);
    if (aKws.has('unblockable')) return false;
    const bKws = this.keywords(game);
    if (aKws.has('flying') && !bKws.has('flying') && !bKws.has('reach')) return false;
    if (aKws.has('fear') && !(this.isArtifact || (this.data.colors || []).includes('B'))) return false;
    if (aKws.has('intimidate') && !(this.isArtifact || (this.data.colors || []).some((c) => (attacker.data.colors || []).includes(c)))) return false;
    if (aKws.has('shadow') !== bKws.has('shadow')) return false;
    if (aKws.has('horsemanship') && !bKws.has('horsemanship')) return false;
    if (aKws.has('skulk') && this.power(game) > attacker.power(game)) return false;
    // Landwalk: imbloqueble si el defensor controla ese tipo de tierra.
    const walks = { islandwalk: 'Island', swampwalk: 'Swamp', mountainwalk: 'Mountain', forestwalk: 'Forest', plainswalk: 'Plains' };
    for (const [kw, landType] of Object.entries(walks)) {
      if (aKws.has(kw) && this.controller.battlefield.some((l) => l.isLand && l.hasSubtype(landType))) return false;
    }
    return true;
  }

  cleanupEndOfTurn() {
    this.tempPT = [0, 0];
    this.tempKeywords.clear();
    this.damage = 0;
    this.attacking = null;
    this.blocking = null;
    this.crewed = false;
  }
}

// Token sencillo creado por un efecto.
export function makeToken(spec, owner, turn) {
  const colors = spec.colors || [];
  const data = {
    name: spec.name,
    manaCost: '',
    cmc: 0,
    typeLine: `Token ${spec.types || 'Creature'} — ${spec.name}`,
    oracleText: '',
    power: String(spec.pt?.[0] ?? 1),
    toughness: String(spec.pt?.[1] ?? 1),
    colors,
    colorIdentity: colors,
    keywords: spec.keywords || [],
    producedMana: spec.producedMana || null,
    image: null,
    imageSmall: null,
  };
  const tok = new CardInstance(data, owner);
  tok.isToken = true;
  tok.zone = 'battlefield';
  tok.summoningSick = true;
  tok.enteredTurn = turn;
  return tok;
}
