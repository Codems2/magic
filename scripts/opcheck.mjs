// Verificador semántico de ops: comprueba que cada operación de efecto
// produce EXACTAMENTE el cambio de estado que promete (no solo "algo").
// Lo usa scripts/sandbox.mjs a través del gancho game.opProbe.

// Ops "envoltorio": no cambian estado por sí mismas (delegan en ops anidadas).
export const WRAPPERS = new Set([
  'ifCond', 'ifOppLife', 'ifYouHaveChar', 'ifDon', 'ifLeaderType',
  'ownChoose', 'oppChoose', 'revealTopThen', 'runAbility',
]);

// Ops-marcador: dejan una señal para otra fase (combate, KO...) y se
// verifican con flags, o son informativas sin efecto de estado comprobable.
const MARKERS = new Set([
  'noBlocker', 'noBlockerGroup', 'grantNoBlocker', 'cannotKO', 'koReplace',
  'canAttackActive', 'battleAttrBuff', 'negate', 'koBattled', 'lifeReorder',
  'lifeScryEither', 'peekReorder', 'staticSelfPower', 'auraWhileRested',
  'unrestAfterCharBattle', 'trashFaceUpLife', 'playedThisTurn',
  'redirectAttack', 'grantToLast',
]);

export function snap(g) {
  const P = (p) => ({
    hand: p.hand.length, lib: p.library.length, trash: p.trash.length,
    life: p.life.length, donA: p.donActive, donR: p.donRested, donD: p.donDeck,
    chars: p.characters.length, given: p.donGiven,
  });
  const cards = new Map();
  for (const c of g.cardsById.values()) {
    const onField = ['characters', 'leader', 'stage'].includes(c.zone);
    cards.set(c.id, {
      zone: c.zone, rested: !!c.rested, owner: g.players.indexOf(c.owner),
      power: onField ? c.power(g) : null, cost: c.cost, givenDon: c.givenDon,
      mods: c.mods.length,
      maxExpire: c.mods.reduce((mx, m) => Math.max(mx, m.expireTurn), 0),
      frozen: c._frozenUntil ?? 0, noAtk: c._cannotAttackUntil ?? 0,
      kw: [
        ...(c._tempKw ?? []),
        ...c.mods.filter((m) => m.stat === 'kw').map((m) => m.kw),
      ].join(',').toLowerCase(),
    });
  }
  return { p: [P(g.players[0]), P(g.players[1])], cards, turn: g.turn, logIdx: g.logLines.length };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Devuelve null si la op cumplió su función, o un mensaje si NO.
// b = snapshot antes; a = snapshot después; i = índice del jugador que resuelve.
export function checkOp(op, b, a, g, i, srcId) {
  if (WRAPPERS.has(op.op) || MARKERS.has(op.op)) return null;
  const j = 1 - i;
  const bp = b.p[i], ap = a.p[i], bo = b.p[j], ao = a.p[j];
  const logs = g.logLines.slice(b.logIdx).join(' | ');
  const bs = srcId != null ? b.cards.get(srcId) : null;
  const as = srcId != null ? a.cards.get(srcId) : null;
  // Cartas del bando `who` cuyo campo cambió según `pred(before, after)`.
  const changed = (who, pred) => {
    let n = 0;
    for (const [id, bc] of b.cards) {
      const ac = a.cards.get(id);
      if (!ac || bc.owner !== who) continue;
      if (pred(bc, ac)) n++;
    }
    return n;
  };

  switch (op.op) {
    case 'draw': {
      if (op.ifHandMax != null && bp.hand > op.ifHandMax) {
        return ap.hand !== bp.hand ? `draw condicionado a mano<=${op.ifHandMax} robó igual` : null;
      }
      const drawn = Math.min(op.n, bp.lib);
      const net = drawn - Math.min(op.trash ?? 0, bp.hand + drawn);
      if (ap.hand - bp.hand !== net) return `draw ${op.n}: mano ${bp.hand}→${ap.hand}, esperaba +${net}`;
      return null;
    }
    case 'trashThenDraw': {
      const t = Math.min(op.trash, bp.hand);
      if (ap.trash - bp.trash < t) return `trashThenDraw: descarte no subió ${t}`;
      if (ap.hand - bp.hand !== Math.min(op.n, bp.lib) - t) return `trashThenDraw: mano ${bp.hand}→${ap.hand}`;
      return null;
    }
    case 'trashAnyNow': {
      if (ap.hand > bp.hand) return 'trashAnyNow: la mano subió';
      const gone = bp.hand - ap.hand;
      return ap.trash - bp.trash < gone ? 'trashAnyNow: lo descartado no llegó al descarte' : null;
    }
    case 'selfDiscard': {
      const t = Math.min(op.n, bp.hand);
      return ap.hand !== bp.hand - t ? `selfDiscard ${op.n}: mano ${bp.hand}→${ap.hand}` : null;
    }
    case 'oppDiscard': {
      const t = Math.min(op.n, bo.hand);
      return ao.hand !== bo.hand - t ? `oppDiscard ${op.n}: mano rival ${bo.hand}→${ao.hand}` : null;
    }
    case 'ko': {
      if (op.scope === 'self') {
        return as?.zone !== 'trash' ? `ko self: la fuente sigue en ${as?.zone}` : null;
      }
      const pool = op.scope === 'all' ? bp.chars + bo.chars : bo.chars;
      if (pool === 0) return null;
      const died = (bp.chars - ap.chars) + (bo.chars - ao.chars);
      if (died === 0 && !/no puede ser KO|evita ser eliminado|se gira en vez/.test(logs) && /es KO/.test(logs)) {
        return 'ko: el log dice KO pero nadie salió del campo';
      }
      // Si había objetivos elegibles y no pasó nada de nada, es sospechoso solo
      // si el filtro era vacío (sin restricciones) — con filtros, puede no haber match.
      const unfiltered = !op.filter || Object.keys(op.filter).length === 0;
      if (died === 0 && unfiltered && !op.restedOnly && !op.activeOnly && !op.blockerOnly &&
          !/no puede ser KO|evita ser eliminado|se gira en vez/.test(logs)) {
        return `ko sin filtro con ${pool} objetivos: nadie murió`;
      }
      return null;
    }
    case 'bounce': case 'tuckBottom': {
      const total = bp.chars + bo.chars;
      if (total === 0) return null;
      const left = (bp.chars - ap.chars) + (bo.chars - ao.chars);
      const gain = op.op === 'bounce'
        ? (ap.hand - bp.hand) + (ao.hand - bo.hand)
        : (ap.lib - bp.lib) + (ao.lib - bo.lib);
      if (left > 0 && gain < left) return `${op.op}: salieron ${left} del campo pero llegaron ${gain} al destino`;
      return null;
    }
    case 'bounceSelf': {
      if (bs?.zone !== 'characters') return null;
      return as?.zone !== 'hand' ? `bounceSelf: fuente en ${as?.zone}, esperaba mano` : null;
    }
    case 'tuckSelf': {
      if (bs?.zone !== 'characters') return null;
      return as?.zone !== 'deck' ? `tuckSelf: fuente en ${as?.zone}, esperaba mazo` : null;
    }
    case 'bounceOwn': {
      const n = changed(i, (bc, ac) => bc.zone === 'characters' && ac.zone === 'hand');
      const eligible = bp.chars > 0;
      if (op.all && eligible && n === 0 && Object.keys(op.filter ?? {}).length === 0) {
        return 'bounceOwn all: ningún personaje volvió a la mano';
      }
      return null;
    }
    case 'restTarget': {
      const n = changed(j, (bc, ac) => !bc.rested && ac.rested);
      const anyActive = changed(j, (bc) => !bc.rested && bc.zone === 'characters') > 0 ||
        (op.includeLeader && !b.cards.get(g.players[j].leader.id)?.rested);
      const unfiltered = Object.keys(op.filter ?? {}).length === 0 && !op.blockerOnly;
      if (anyActive && unfiltered && n === 0) return 'restTarget: había objetivos activos y nadie quedó girado';
      return null;
    }
    case 'unrestChar': {
      const n = changed(i, (bc, ac) => bc.rested && !ac.rested);
      const anyRested = changed(i, (bc) => bc.rested && bc.zone === 'characters') > 0;
      const unfiltered = Object.keys(op.filter ?? {}).length === 0 && op.maxCost == null;
      if (anyRested && unfiltered && n === 0) return 'unrestChar: había girados y nadie se enderezó';
      return null;
    }
    case 'unrestSelf': return as?.rested ? 'unrestSelf: la fuente sigue girada' : null;
    case 'restOwnAction': return null; // opcional con filtro: puede no aplicar
    case 'freeze': {
      const n = changed(j, (bc, ac) => !bc.frozen && ac.frozen);
      const unfiltered = Object.keys(op.filter ?? {}).length === 0;
      if (bo.chars > 0 && unfiltered && n === 0) return 'freeze: nadie quedó congelado';
      return n > 0 ? null : null;
    }
    case 'cannotAttack': {
      const n = changed(j, (bc, ac) => !bc.noAtk && ac.noAtk);
      const unfiltered = Object.keys(op.filter ?? {}).length === 0;
      if (bo.chars > 0 && unfiltered && n === 0) return 'cannotAttack: nadie quedó marcado';
      return null;
    }
    case 'powerUp': {
      const n = changed(i, (bc, ac) => ac.power != null && bc.power != null && ac.power - bc.power >= op.n);
      if (n === 0 && (bp.chars > 0 || true)) return `powerUp +${op.n}: ningún aliado subió`;
      return null;
    }
    case 'powerDown': {
      if (bo.chars === 0) return null;
      const n = changed(j, (bc, ac) => ac.power != null && bc.power != null && bc.power - ac.power >= op.n);
      return n === 0 ? `powerDown -${op.n}: ningún rival bajó` : null;
    }
    case 'powerSelf': {
      if (!as || as.power == null || bs.power == null) return null;
      return as.power - bs.power < op.n ? `powerSelf +${op.n}: ${bs.power}→${as.power}` : null;
    }
    case 'selfGrant': {
      if (op.static) return null;   // se evalúa como estática, no añade mods
      if (op.per) return null;      // multiplicador contextual: puede ser 0
      const tid = op.target === 'leader' ? g.players[i].leader.id : srcId;
      const bt = b.cards.get(tid), at = a.cards.get(tid);
      if (!bt || !at) return null;
      if (at.mods <= bt.mods) return 'selfGrant: no se añadió ningún modificador';
      if (op.dur === 'next' && at.maxExpire < b.turn + 1) return `selfGrant dur=next: expira en ${at.maxExpire}, esperaba ≥${b.turn + 1}`;
      for (const kw of op.kws ?? []) {
        if (!at.kw.includes(kw.toLowerCase())) return `selfGrant: falta keyword [${kw}]`;
      }
      return null;
    }
    case 'buff': {
      if (op.per) return null;   // multiplicador contextual: puede ser 0
      const side = op.side === 'opp' ? j : i;
      const n = changed(side, (bc, ac) => ac.mods > bc.mods);
      const pool = op.scope === 'leader' ? 1 : b.p[side].chars + (op.scope === 'leaderChar' ? 1 : 0);
      const unfiltered = Object.keys(op.filter ?? {}).length === 0;
      if (pool > 0 && unfiltered && n === 0) return `buff(${op.side}): nadie recibió modificadores`;
      if (n > 0 && op.dur === 'next') {
        const okDur = changed(side, (bc, ac) => ac.mods > bc.mods && ac.maxExpire >= b.turn + 1);
        if (okDur === 0) return 'buff dur=next: los modificadores expiran demasiado pronto';
      }
      return null;
    }
    case 'gainKeyword': {
      return as && !as.kw.includes(op.kw.toLowerCase()) ? `gainKeyword: falta [${op.kw}]` : null;
    }
    case 'grantKeywordGroup': {
      const n = changed(i, (bc, ac) => ac.kw.length > bc.kw.length);
      return n === 0 ? `grantKeywordGroup [${op.kw}]: nadie lo ganó` : null;
    }
    case 'costDown': {
      if (bo.chars === 0) return null;
      const n = changed(j, (bc, ac) => bc.cost - ac.cost >= Math.min(op.n, bc.cost));
      return n === 0 ? `costDown -${op.n}: ningún rival bajó de coste` : null;
    }
    case 'selfCost': {
      if (!bs || !as) return null;
      const expected = clamp(bs.cost + op.delta, 0, 99);
      return as.cost !== expected ? `selfCost ${op.delta}: coste ${bs.cost}→${as.cost}, esperaba ${expected}` : null;
    }
    case 'giveRestedDon': {
      const given = ap.given - bp.given;
      const avail = Math.min(op.n, bp.donR);
      if (avail > 0 && given === 0) return `giveRestedDon: había ${bp.donR} DON girados y no se dio ninguno`;
      if (given > 0 && ap.donR !== bp.donR - given) return 'giveRestedDon: el área de coste no cuadra';
      return null;
    }
    case 'giveRestedDonEach': {
      const given = ap.given - bp.given;
      if (bp.donR > 0 && given === 0 && Object.keys(op.filter ?? {}).length === 0) return 'giveRestedDonEach: no se dio ningún DON';
      return null;
    }
    case 'donFromDeck': {
      const real = Math.min(op.n, bp.donD);
      if (ap.donD !== bp.donD - real) return `donFromDeck: mazo DON ${bp.donD}→${ap.donD}`;
      const dest = op.active ? ap.donA - bp.donA : ap.donR - bp.donR;
      return dest !== real ? `donFromDeck: no llegaron ${real} DON ${op.active ? 'activos' : 'girados'}` : null;
    }
    case 'unrestDon': {
      const real = Math.min(op.n, bp.donR);
      return ap.donA - bp.donA !== real ? `unrestDon ${op.n}: activos ${bp.donA}→${ap.donA}` : null;
    }
    case 'restOppDon': {
      const real = Math.min(op.n, bo.donA);
      return ao.donR - bo.donR !== real ? `restOppDon ${op.n}: girados rival ${bo.donR}→${ao.donR}` : null;
    }
    case 'trashOppLife': {
      const real = Math.min(op.n, bo.life);
      if (ao.life !== bo.life - real) return `trashOppLife ${op.n}: vida rival ${bo.life}→${ao.life}`;
      return ao.trash - bo.trash < real ? 'trashOppLife: la vida no llegó al descarte' : null;
    }
    case 'lifeToHand': {
      const real = Math.min(op.n, bp.life);
      if (ap.life !== bp.life - real) return `lifeToHand ${op.n}: vida ${bp.life}→${ap.life}`;
      return ap.hand - bp.hand !== real ? 'lifeToHand: la carta no llegó a la mano' : null;
    }
    case 'deckToLife': case 'lifeAddFromDeck': {
      const real = Math.min(op.n, bp.lib);
      if (ap.life !== bp.life + real) return `${op.op} ${op.n}: vida ${bp.life}→${ap.life}`;
      return ap.lib !== bp.lib - real ? `${op.op}: el mazo no bajó ${real}` : null;
    }
    case 'handToLife': {
      // Opcional con elección: si había candidatos, mano→vida 1.
      if (ap.life > bp.life && ap.hand !== bp.hand - (ap.life - bp.life)) {
        return 'handToLife: la vida subió pero la mano no bajó igual';
      }
      return null;
    }
    case 'lifeToTopDeck': {
      if (bp.life === 0) return null;
      if (ap.life !== bp.life - 1) return `lifeToTopDeck: vida ${bp.life}→${ap.life}`;
      return ap.lib !== bp.lib + 1 ? 'lifeToTopDeck: el mazo no subió 1' : null;
    }
    case 'cardsToLifeFromZone': {
      if (ap.life > bp.life) {
        const moved = ap.life - bp.life;
        const spent = (bp.hand - ap.hand) + (bp.trash - ap.trash);
        return spent !== moved ? 'cardsToLifeFromZone: origen y vida no cuadran' : null;
      }
      return null;
    }
    case 'charToLifeEffect': {
      const side = op.side === 'opp' ? j : i;
      const bS = b.p[side], aS = a.p[side];
      if (aS.life > bS.life && bS.chars - aS.chars !== aS.life - bS.life) {
        return 'charToLifeEffect: personajes y vida no cuadran';
      }
      return null;
    }
    case 'tutorTop': {
      if (bp.lib === 0) return null;
      const seen = Math.min(op.n, bp.lib);
      const took = ap.hand - bp.hand;
      if (took < 0 || took > (op.take ?? 1)) return `tutorTop: mano ${bp.hand}→${ap.hand}`;
      return ap.lib !== bp.lib - took ? `tutorTop: mazo ${bp.lib}→${ap.lib} tras coger ${took}` : null;
    }
    case 'revealPlay': {
      if (bp.lib === 0) return null;
      const played = ap.chars - bp.chars;
      const toHand = ap.hand - bp.hand;
      return (played + toHand) !== 1 ? `revealPlay: ni se jugó ni fue a la mano (${played}/${toHand})` : null;
    }
    case 'revealLifePlay': {
      if (bp.life === 0) return null;
      const played = ap.chars - bp.chars;
      if (played === 1 && ap.life !== bp.life - 1) return 'revealLifePlay: se jugó pero la vida no bajó';
      return null;
    }
    case 'lookAddToLife': {
      if (ap.life > bp.life && ap.lib >= bp.lib) return 'lookAddToLife: la vida subió sin salir del mazo';
      return null;
    }
    case 'playFromZone': {
      // Opcional: si entró alguien, que venga de la zona correcta.
      const played = ap.chars - bp.chars;
      if (played > 0) {
        const src = op.zone === 'deck' ? bp.lib - ap.lib : op.zone === 'trash' ? bp.trash - ap.trash : bp.hand - ap.hand;
        if (src < played) return `playFromZone(${op.zone}): entraron ${played} pero la zona solo perdió ${src}`;
      }
      return null;
    }
    case 'playSelf': {
      if (bs?.zone === 'characters') return null;
      if (as?.zone === 'characters') {
        if (op.rested && !as.rested) return 'playSelf rested: entró enderezado';
        return null;
      }
      return null; // área llena o toHandFallback
    }
    case 'trashToHand': {
      const took = ap.hand - bp.hand;
      if (took > 0 && bp.trash - ap.trash !== took) return 'trashToHand: mano y descarte no cuadran';
      return null;
    }
    case 'setBasePower': {
      const tid = op.who === 'leader' ? g.players[i].leader.id : srcId;
      const at = a.cards.get(tid);
      return at && at.power !== null && at.power !== op.value ? `setBasePower ${op.value}: quedó en ${at.power}` : null;
    }
    default: return null;
  }
}
