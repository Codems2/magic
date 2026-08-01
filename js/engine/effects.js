// F3 — Intérprete de efectos de One Piece TCG.
//
// El texto de OPTCG viene etiquetado por timing ([On Play], [When Attacking],
// [Activate: Main], [Main], [Counter], [Trigger], [On Block], [End of Your
// Turn]...), con modificadores previos ([DON!! xN], [Once Per Turn], [Your
// Turn]) y costes internos ("(2)", "DON!! -1", "You may trash 1 card...: ").
// buildScript(card) lo convierte en habilidades con operaciones ejecutables;
// lo no reconocido queda en script.unknown (y la UI lo marcará con ⚠).

const TRIGGER_TAGS = [
  'On Play', 'When Attacking', 'Activate: Main', 'Main', 'Counter',
  'Trigger', 'On Block', 'End of Your Turn', 'On K.O.', 'On Your Opponent\'s Attack',
];
const TRIGGER_KEY = {
  'On Play': 'onPlay', 'When Attacking': 'whenAttacking',
  'Activate: Main': 'activateMain', 'Main': 'main', 'Counter': 'counter',
  'Trigger': 'trigger', 'On Block': 'onBlock', 'End of Your Turn': 'endOfTurn',
  'On K.O.': 'onKO', 'On KO': 'onKO', "On Your Opponent's Attack": 'onOppAttack',
  'On Your Opponent’s Attack': 'onOppAttack', 'DON!! x1': null,
};

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const n = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : NUM[w?.toLowerCase()] ?? 1);

// Criterio de búsqueda de una carta (por nombre, tipo/subtipo, poder o coste).
function parseFilter(text) {
  const f = {};
  let m;
  // "other than [X]" excluye ANTES de recoger nombres requeridos.
  if ((m = text.match(/other than \[([^\]]+)\]/i))) {
    f.notName = m[1];
    text = text.replace(m[0], ' ');
  }
  // Nombres entre corchetes: [Sabo], [Ace], or [Luffy].
  const names = [...text.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]).filter((x) => !/^(don!!|blocker|rush)/i.test(x));
  if (names.length) f.names = names;
  // Fuera los [nombres] antes de mirar subtipos (comillas internas de nombres).
  text = text.replace(/\[[^\]]+\]/g, ' ');
  const l = text.toLowerCase();
  // Subtipos entre comillas o llaves.
  const types = [...text.matchAll(/["“]([^"”]+)["”]|\{([^}]+)\}/g)].map((x) => x[1] ?? x[2]);
  if (types.length) f.types = types;
  if ((m = l.match(/with (\d+) power/))) f.power = parseInt(m[1], 10);
  if ((m = l.match(/with a cost of (\d+) or less/))) f.maxCost = parseInt(m[1], 10);
  if (/character card/.test(l)) f.cardType = 'Character';
  else if (/event card/.test(l)) f.cardType = 'Event';
  else if (/stage card/.test(l)) f.cardType = 'Stage';
  return f;
}

// Filtro de OBJETIVOS en el tablero (personajes/líderes propios o del rival):
// color, subtipo, nombre, poder base y coste. Se evalúa en game.matchesFilter.
const COLORS = ['red', 'blue', 'green', 'purple', 'black', 'yellow'];
function parseTargetFilter(text) {
  const f = {};
  let m;
  // "other than [X]" se extrae ANTES de recoger nombres: si no, X quedaría a
  // la vez requerido y excluido y el filtro sería imposible de cumplir.
  if ((m = text.match(/other than \[([^\]]+)\]/i))) {
    f.notName = m[1];
    text = text.replace(m[0], ' ');
  }
  const names = [...text.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]).filter((x) => !/^(don!!|blocker|rush|double attack|banish|trigger)/i.test(x));
  if (names.length) f.names = names;
  // Quita los nombres [X] antes de buscar subtipos: las comillas DENTRO de un
  // nombre (Eustass"Captain"Kid) no son un subtipo.
  text = text.replace(/\[[^\]]+\]/g, ' ');
  const l = text.toLowerCase();
  const types = [...text.matchAll(/["“]([^"”]+)["”]|\{([^}]+)\}/g)].map((x) => x[1] ?? x[2]);
  if (types.length) f.types = types;
  const cols = COLORS.filter((c) => new RegExp(`\\b${c}\\b`).test(l));
  if (cols.length) f.colors = cols;
  if ((m = l.match(/with (\d+) base power(?: or (less|more))?/))) f.basePower = { v: parseInt(m[1], 10), dir: m[2] ?? 'eq' };
  else if ((m = l.match(/with (\d+) power(?: or (less|more))?/))) f.power = { v: parseInt(m[1], 10), dir: m[2] ?? 'eq' };
  if ((m = l.match(/with a base cost of (\d+)(?: or (less|more))?/))) f.baseCost = { v: parseInt(m[1], 10), dir: m[2] ?? 'eq' };
  else if ((m = l.match(/with a cost of (\d+) to (\d+)/))) f.costRange = { lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) };
  else if ((m = l.match(/with a cost of (\d+)(?: or (less|more))?/))) f.cost = { v: parseInt(m[1], 10), dir: m[2] ?? 'eq' };
  return f;
}

// Ámbito objetivo: ¿incluye líder? ¿personajes? (mira el texto del grupo).
function scopeOf(l) {
  const leader = /\bleader\b/.test(l);
  const char = /\bcharacter/.test(l);
  if (leader && char) return 'leaderChar';
  if (leader) return 'leader';
  return 'char';
}

// Duración de un modificador a partir de la coletilla temporal.
function durOf(l) {
  if (!l) return 'turn';
  if (/until the start of your next turn|until the end of your opponent'?s next (?:turn|end phase)|until the end of your next turn/.test(l)) return 'next';
  if (/during this battle/.test(l)) return 'battle';
  return 'turn'; // "during this turn" o "until the end of (this) turn"
}

// "+2000 power and [Rush]" → {changes:[{stat,delta}], kws:[...], per}.
// `per` es un multiplicador "for every N <cosa>" que escala los deltas.
function parseGrant(text) {
  let per = null;
  let m;
  if ((m = text.match(/for every (\d+ )?(cards? in your trash|returned characters?|cards? trashed|rested don!! cards?)/i))) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const kind = /trash$|in your trash/i.test(m[2]) ? 'trash'
      : /returned/i.test(m[2]) ? 'returned'
        : /trashed/i.test(m[2]) ? 'trashed' : 'restedDon';
    per = { n, kind };
    text = text.replace(m[0], ' ');
  }
  const changes = [];
  const kws = [];
  for (const part of text.split(/\s+and\s+/i)) {
    if ((m = part.match(/([+-]?\d+)\s*power/i))) changes.push({ stat: 'power', delta: parseInt(m[1], 10) });
    else if ((m = part.match(/([+-]?\d+)\s*cost/i))) changes.push({ stat: 'cost', delta: parseInt(m[1], 10) });
    else if ((m = part.match(/\[([\w: ]+)\]/))) kws.push(m[1].trim());
  }
  return { changes, kws, per };
}

// Buff/debuff a un GRUPO de cartas del tablero. Devuelve una op `buff` o null.
// Cubre: "all of your / up to N of your / your <filtro> gains ± power/cost/[Kw]"
// y "give up to N of your opponent's <filtro> -N power/cost".
function parseBuff(sentence) {
  const l = sentence.toLowerCase();
  let m;
  // Rival: "give (up to) N of your opponent's <scope> -N power/cost [dur]".
  if ((m = l.match(/^give (?:up to )?(\d+) of your opponent'?s (.+?) ([+-]?\d+ (?:power|cost)(?: and [+-]?\d+ (?:power|cost))*) ?(.*)$/))) {
    const grant = parseGrant(m[3]);
    // Las fuentes pierden el signo −: "give ... del RIVAL N power" es SIEMPRE
    // una reducción, así que un número sin signo se interpreta negativo.
    for (const ch of grant.changes) if (ch.delta > 0) ch.delta = -ch.delta;
    return {
      op: 'buff', side: 'opp', all: false, targets: n(m[1]),
      scope: scopeOf(m[2]), filter: parseTargetFilter(m[2]),
      changes: grant.changes, kws: grant.kws, per: grant.per,
      dur: durOf((m[4] || sentence).toLowerCase()),
    };
  }
  // Propio: "(all of your | up to N of your | your) <scope> gain(s) <grant> [dur]".
  if ((m = sentence.match(/^(all of your|up to (\d+) of your|your) (.+?) (?:gains?|gain) (.+?)(?:\s+(during this turn|during this battle|until the end of your opponent'?s next turn|until the end of your next turn|until the start of your next turn|until the end of (?:your |this |the )?turn))?\.?$/i))) {
    const scopeText = m[3];
    const grant = parseGrant(m[4]);
    if (!grant.changes.length && !grant.kws.length) return null;
    // Excluye el caso "this character/leader/card" (lo tratan patrones propios).
    if (/^this (character|leader|card)\b/i.test(scopeText)) return null;
    // "your Leader and all of your Characters gain..." aplica a TODOS.
    const allInScope = /^all of your/i.test(m[1]) || /\ball of your characters?\b/i.test(scopeText);
    return {
      op: 'buff', side: 'own', all: allInScope,
      targets: m[2] ? n(m[2]) : 1,
      scope: scopeOf(scopeText.toLowerCase()), filter: parseTargetFilter(scopeText),
      changes: grant.changes, kws: grant.kws, per: grant.per,
      dur: durOf((m[5] ?? sentence).toLowerCase()),
    };
  }
  return null;
}

// KO/trash de personajes (una o varias variantes). Devuelve op `ko` o null.
function parseKO(s) {
  const l = s.toLowerCase();
  let m;
  if (/^ko this (character|card)$/.test(l)) return { op: 'ko', scope: 'self' };
  if (/^return this (character|card) to the owner'?s hand$/.test(l)) return { op: 'bounceSelf' };
  // "KO ... and add this card to your hand" (Zoro OP12-113 como [Trigger]).
  if ((m = s.match(/^(.*)\s+and add this card to your hand$/i))) {
    const inner = parseKO(m[1]);
    if (inner) return { ...inner, thenSelfToHand: true };
  }
  // "KO all Characters with ..." (obligatorio, ambos bandos).
  if ((m = l.match(/^ko all characters?\b(.*)$/))) {
    return { op: 'ko', scope: 'all', all: true, targets: 99, filter: parseTargetFilter(m[1]) };
  }
  // "KO/trash up to N (of your opponent's)? (active|rested)? [blocker]? characters ..."
  if ((m = l.match(/^(?:ko|trash) up to (\d+) (of your opponent'?s )?(active |rested )?(\[blocker\] )?characters?\b(.*)$/))) {
    return {
      op: 'ko', scope: 'opp', targets: n(m[1]),
      restedOnly: m[3]?.trim() === 'rested', activeOnly: m[3]?.trim() === 'active',
      blockerOnly: !!m[4], filter: parseTargetFilter(m[5]),
    };
  }
  // "KO up to N character with ..." (sin "opponent's" → se asume del rival).
  if ((m = l.match(/^ko up to (\d+) characters?\b(.*)$/))) {
    return { op: 'ko', scope: 'opp', targets: n(m[1]), filter: parseTargetFilter(m[2]) };
  }
  return null;
}

// Protección "cannot be KO'd ...". Devuelve op `cannotKO` o null.
function parseProtect(s) {
  const l = s.toLowerCase();
  if (!/cannot be ko'?d/.test(l)) return null;
  const by = /by (?:your opponent'?s )?leaders?/.test(l) ? 'leader' : null;
  let mode = 'any';
  if (/in battle/.test(l)) mode = 'battle';
  else if (/by (?:your opponent'?s )?effects?/.test(l)) mode = 'effect';
  return { op: 'cannotKO', mode, by };
}

// Descriptor de CONDICIÓN "if ...". Devuelve objeto (evaluado en game.evalCond)
// o null. dir: 'less' (≤), 'more' (≥), 'eq' (=).
function parseCondition(text) {
  const l = text.replace(/^if\s+/i, '').trim().toLowerCase();
  const raw = text.replace(/^if\s+/i, '').trim();
  let m;
  // Conjunción "A and B" → prueba cada posible punto de corte en " and ".
  {
    let idx = -1;
    while ((idx = raw.indexOf(' and ', idx + 1)) !== -1) {
      const a = parseConditionSingle(raw.slice(0, idx));
      const b = parseCondition('if ' + raw.slice(idx + 5));
      if (a && b) return { t: 'and', a, b };
    }
  }
  return parseConditionSingle(raw);
}

// Una condición atómica (sin conjunciones).
function parseConditionSingle(raw) {
  const l = raw.trim().toLowerCase();
  let m;
  if ((m = l.match(/^you and your opponent have a total of (\d+) or less life cards?/))) return { t: 'totalLife', dir: 'less', v: +m[1] };
  if ((m = l.match(/^you have a total of (\d+) or more given don!! cards?/))) return { t: 'givenDon', v: +m[1] };
  if (/^the number of don!! cards on your field is equal to or less than the number on your opponent'?s field/.test(l)) return { t: 'donLEOpp' };
  // "your Leader has the attribute" (el icono se perdió en la fuente): se
  // interpreta como "el mismo atributo que ESTA carta".
  if (/^your leader has the attribute$/.test(l)) return { t: 'leaderAttrSelf' };
  if (/^a card in your hand (?:is|was) trashed by an effect/.test(l)) return { t: 'handTrashedThisTurn' };
  if (/^the number of your life cards is equal to or less than the number of your opponent'?s life/.test(l)) return { t: 'lifeLEOpp' };
  if (/^you have (fewer|less) life cards than your opponent/.test(l)) return { t: 'lifeLTOpp' };
  if ((m = l.match(/^you have (\d+) or (less|more) life cards?/))) return { t: 'youLife', dir: m[2], v: +m[1] };
  if ((m = l.match(/^you have (\d+) life cards?/))) return { t: 'youLife', dir: 'eq', v: +m[1] };
  if ((m = l.match(/^your opponent has (\d+) or (less|more) life cards?/))) return { t: 'oppLife', dir: m[2], v: +m[1] };
  if ((m = l.match(/^you have (\d+) or (less|more) cards? in your hand/))) return { t: 'youHand', dir: m[2], v: +m[1] };
  if ((m = l.match(/^your opponent has (\d+) or more cards? in (?:their|your opponent'?s) hand/))) return { t: 'oppHand', dir: 'more', v: +m[1] };
  if ((m = l.match(/^your opponent has a character with (\d+)(?: or more)? (base )?power/))) return { t: 'oppHasChar', filter: { [m[2] ? 'basePower' : 'power']: { v: +m[1], dir: 'more' } } };
  if ((m = l.match(/^your opponent has (\d+) or more rested characters/))) return { t: 'oppRested', v: +m[1] };
  if ((m = raw.match(/^your leader is \[([^\]]+)\]/i))) return { t: 'leaderName', name: m[1] };
  if ((m = raw.match(/^your leader has the (?:\{([^}]+)\}|["“]([^"”]+)["”]|\[([^\]]+)\]) type/i)) || (m = raw.match(/^your leader'?s type includes ["“]([^"”]+)["”]/i))) return { t: 'leaderType', type: m[1] ?? m[2] ?? m[3] ?? m[4] };
  if ((m = l.match(/^you have (\d+) or (less|more) characters?$/))) return { t: 'youHaveMatch', count: +m[1], dir: m[2], filter: {} };
  if (/^your leader is multicolored/.test(l)) return { t: 'leaderMulticolor' };
  if ((m = l.match(/^there is a character with a cost of (\d+)/))) return { t: 'boardCost', v: +m[1] };
  if ((m = l.match(/^you have (\d+) or (less|more) don!! cards? on your field or (\d+) or more don!! cards? on your field/))) return { t: 'don', any: [{ dir: m[2], v: +m[1] }, { dir: 'more', v: +m[3] }] };
  if ((m = l.match(/^you have (\d+) or (\d+) or more don!! cards? on your field/))) return { t: 'don', any: [{ dir: 'eq', v: +m[1] }, { dir: 'more', v: +m[2] }] };
  if ((m = l.match(/^you have (\d+) or (less|more) don!! cards? on your field/))) return { t: 'don', any: [{ dir: m[2], v: +m[1] }] };
  if ((m = l.match(/^you have (\d+) don!! cards? on your field/))) return { t: 'don', any: [{ dir: 'eq', v: +m[1] }] };
  if ((m = l.match(/^you have (\d+) or more rested (don!! cards?|characters?|cards?)/))) {
    const kind = m[2].startsWith('don') ? 'don' : m[2].startsWith('character') ? 'char' : 'card';
    return { t: 'rested', kind, v: +m[1] };
  }
  if (/^this character was played on this turn/.test(l)) return { t: 'playedThisTurn' };
  if (/^your opponent has more don!! cards? on their field than you/.test(l)) return { t: 'oppMoreDon' };
  if (/^a character is rested by your effect/.test(l)) return { t: 'restedByEffect' };
  // "you do not have N characters with ..." (condición negada).
  if ((m = l.match(/^you do not have (\d+) characters? (with .+)$/))) return { t: 'not', a: { t: 'youHaveMatch', count: +m[1], filter: parseTargetFilter(m[2]) } };
  // "you have a/N ... character(s) ..." con filtro (nombre/coste/poder).
  if ((m = raw.match(/^you have (?:a|an|(\d+) or more) (.+?) characters?( other than \[[^\]]+\])?(?: with (.+?))?$/i)) ||
      (m = raw.match(/^you have (?:a|an|(\d+) or more) characters? (with .+?)$/i))) {
    const count = m[1] ? +m[1] : 1;
    const filterText = [m[2], m[3], m[4]].filter(Boolean).join(' ');
    return { t: 'youHaveMatch', count, filter: parseTargetFilter(filterText) };
  }
  if ((m = raw.match(/^you have a rested \[([^\]]+)\]/i))) return { t: 'youHaveMatch', count: 1, filter: { names: [m[1]], rested: true } };
  // "you have [A] and [B] characters with <filtro>" (nombres unidos por "and").
  if ((m = raw.match(/^you have ((?:\[[^\]]+\]\s*(?:and|,)?\s*)+)characters?(?: (with .+))?$/i))) {
    const names = [...m[1].matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]);
    const f = m[2] ? parseTargetFilter(m[2]) : {};
    f.names = names;
    return { t: 'youHaveMatch', count: 1, filter: f };
  }
  return null;
}

// "if <cond>, <inner>" → [{op:'ifCond', cond, ops}]. null si no reconoce.
function parseConditional(s, unknown) {
  if (!/^if\s+/i.test(s)) return null;
  const comma = s.indexOf(',');
  if (comma === -1) return null;
  const cond = parseCondition(s.slice(0, comma));
  if (!cond) return null;
  const inner = s.slice(comma + 1).trim();
  const innerOps = parseOps(inner, unknown);
  if (!innerOps.length) return null;
  return [{ op: 'ifCond', cond, ops: innerOps }];
}

// ---- efectos (frases → ops) ----------------------------------------------

function parseOps(text, unknown) {
  const ops = [];
  let mm;
  // Restos de "You may ..." sin coste reconocido (el opcional lo gestiona el
  // paso de coste); también "You may to your hand:" (texto mutilado de la API).
  text = text.replace(/^\s*you may to your hand:\s*/i, '').replace(/^\s*you may\s*:\s*/i, '').trim();
  // Katakuri (púrpura): "Choose a cost and reveal 1 card from the top of your
  // opponent's deck. If the revealed card has the chosen cost, <efecto>."
  if ((mm = text.match(/choose a cost and reveal 1 card from the top of your opponent'?s deck\.?\s*if the revealed card has the chosen cost,?\s*([\s\S]+?)(?:\.\s|\.$|$)/i))) {
    ops.push({ op: 'chooseCostReveal', ops: parseOps(mm[1], unknown) });
    text = text.replace(mm[0], ' ');
  }
  // "For every {X} type card on your field, <efecto con números>": multiplica.
  if ((mm = text.match(/^for every (?:\{([^}]+)\}|"([^"]+)") type cards? on your field,\s*(.+)$/i))) {
    const inner = parseOps(mm[3], unknown);
    for (const op of inner) {
      if (op.op === 'buff' || op.op === 'selfGrant') op.per = { kind: 'fieldType', type: mm[1] ?? mm[2], n: 1 };
    }
    return inner;
  }
  // Condicional que abarca TODO el texto: se resuelve ANTES que los patrones
  // multi-frase, para que estos no "roben" el efecto interior del condicional.
  if (/^if\s+/i.test(text) && (mm = text.match(/^(if [^,]+),\s*([\s\S]+)$/i))) {
    const cond0 = parseCondition(mm[1]);
    if (cond0) {
      const inner0 = parseOps(mm[2], unknown);
      if (inner0.length) return [{ op: 'ifCond', cond: cond0, ops: inner0 }];
    }
  }
  // Patrones multi-frase (se consumen antes del troceo).
  if ((mm = text.match(/select up to 1 of your .*?(?:leader or character cards?|characters?[^.]*)\.\s*(?:your opponent cannot activate \[blocker\] if that .*? attacks during this turn|if the selected character attacks during this turn,? your opponent cannot activate \[blocker\])/i))) {
    ops.push({ op: 'grantNoBlocker' });
    text = text.replace(mm[0], '');
  }
  // Tutores "mira N cartas; revela 1 <criterio> y añádela a tu mano".
  if ((mm = text.match(/(?:look at|reveal) (?:up to )?(\d+) cards? from the top of your deck[.,;]?\s*(?:reveal up to 1 |add up to 1 )?(.+?) (?:and add it to your hand|to your hand)/i))) {
    ops.push({ op: 'tutorTop', n: n(mm[1]), filter: parseFilter(mm[2]) });
    text = text.replace(mm[0], '');
  } else if ((mm = text.match(/reveal 1 card from the top of your deck[.,;]?\s*(?:if it(?:'s| is) an? (.+?),?\s*)?(?:add (?:it|that card) to your hand|put (?:it|that card) into your hand)/i))) {
    ops.push({ op: 'tutorTop', n: 1, filter: mm[1] ? parseFilter(mm[1]) : {} });
    text = text.replace(mm[0], '');
  }
  // Manipulación de vidas: "añade 1 carta de tu Vida a la mano".
  if ((mm = text.match(/add 1 card from the top or bottom of your life (?:cards |area )?to your hand/i))) {
    ops.push({ op: 'lifeToHand', n: 1, pick: true });
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/add up to (\d+) cards? from the top of your life[^.]*?to (?:your|its owner'?s?) hand/i))) {
    ops.push({ op: 'lifeToHand', n: n(mm[1]) });
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/(?:trash|place) the top card of your deck (?:into|at the top of) your life/i)) ||
      (mm = text.match(/add the top card of your deck to your life/i))) {
    ops.push({ op: 'deckToLife', n: 1 });
    text = text.replace(mm[0], '');
  }
  // Revela la carta superior del mazo; si cumple, ejecuta el efecto (Whitebeard).
  if ((mm = text.match(/reveal 1 card from the top of your deck\.?\s*if that card(?:'s type includes ["“]([^"”]+)["”]|is (?:an? )?(.+?)),?\s*(.+?)(?:\.|$)/i))) {
    const filter = mm[1] ? { types: [mm[1]] } : parseFilter(mm[2] ?? '');
    ops.push({ op: 'revealTopThen', filter, ops: parseOps(mm[3], unknown) });
    text = text.replace(mm[0], '');
  }
  // Revela la carta superior de tu Vida y, si cumple, la juega (Sabo).
  if ((mm = text.match(/reveal 1 card from the top of your life cards\.?\s*if that card is (?:an? )?(.+?) with a cost of (\d+),?\s*(?:you may )?play that card/i))) {
    ops.push({ op: 'revealLifePlay', filter: parseFilter(mm[1]), maxCost: parseInt(mm[2], 10) });
    text = text.replace(mm[0], '');
  }
  // "Look at N cards from the top of your deck and add up to 1 <filtro> to the top of your life".
  if ((mm = text.match(/look at (\d+) cards? from the top of your deck and add up to 1 (.+?) to the top of your life cards?( face-up)?/i))) {
    ops.push({ op: 'lookAddToLife', n: n(mm[1]), filter: parseFilter(mm[2]), faceUp: !!mm[3] });
    text = text.replace(mm[0], '');
  }
  // Vida: mira/ordena, escruta la de ambos, añade de la mano, etc.
  if (/look at all (?:of )?your life cards and place them back in your life area in any order/i.test(text)) {
    ops.push({ op: 'lifeReorder' });
    text = text.replace(/look at all (?:of )?your life cards and place them back in your life area in any order\.?/i, '');
  }
  if ((mm = text.match(/place 1 (?:card )?at the top of your deck and place the rest back in your life area in any order/i))) {
    ops.push({ op: 'lifeToTopDeck' });
    text = text.replace(mm[0], '');
  }
  if (/look at up to 1 card from the top of your or your opponent'?s life cards,? and place it at the top or bottom of the life cards/i.test(text)) {
    ops.push({ op: 'lifeScryEither' });
    text = text.replace(/look at up to 1 card from the top of your or your opponent'?s life cards,? and place it at the top or bottom of the life cards\.?/i, '');
  }
  // Variante solo-rival: mirar su carta de Vida superior y decidir si al fondo.
  if ((mm = text.match(/look at up to 1 card from the top of your opponent'?s life cards,? and place it at the top or bottom of the life cards\.?/i))) {
    ops.push({ op: 'lifeScryOpp' });
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/add up to (\d+) cards? from your hand to the top of your life cards?/i))) {
    ops.push({ op: 'handToLife', filter: {} });
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/add up to (\d+) (.+?) from your (?:hand or trash|hand|trash) to the top of your life cards?( face-up)?/i))) {
    ops.push({ op: 'cardsToLifeFromZone', n: n(mm[1]), filter: parseFilter(mm[2]), from: /hand or trash/i.test(mm[0]) ? 'handTrash' : /trash/i.test(mm[0]) ? 'trash' : 'hand', faceUp: !!mm[3] });
    text = text.replace(mm[0], '');
  }
  // Añadir un personaje del tablero a la Vida (propio o del rival), con posible
  // condición embebida ("... if you have 2 or less life cards, add ...").
  if ((mm = text.match(/(?:if ([^,]+),\s*)?add up to (\d+) of your (opponent'?s )?characters?(?: with [^.]*?)? to the top(?: or bottom)? of the owner'?s life cards?( face-up)?/i))) {
    let op = { op: 'charToLifeEffect', side: mm[3] ? 'opp' : 'own', targets: n(mm[2]), filter: parseTargetFilter(mm[0].replace(/.*characters?/i, '')), faceUp: !!mm[4] };
    const c = mm[1] ? parseCondition('if ' + mm[1]) : null;
    if (c) op = { op: 'ifCond', cond: c, ops: [op] };
    ops.push(op);
    text = text.replace(mm[0], '');
  }
  if (/trash all your face-up life cards/i.test(text)) {
    ops.push({ op: 'trashFaceUpLife' });
    text = text.replace(/trash all your face-up life cards\.?/i, '');
  }
  if (/your face-up life cards are placed at the bottom of your deck instead[^.]*\.?/i.test(text)) {
    text = text.replace(/your face-up life cards are placed at the bottom of your deck instead[^.]*\.?/i, '');
  }
  if ((mm = text.match(/trash up to (\d+) cards? from the top of your opponent'?s life cards?/i))) {
    ops.push({ op: 'trashOppLife', n: n(mm[1]) });
    text = text.replace(mm[0], '');
  }
  // Condicional que abarca TODO el texto (su interior puede tener varias frases).
  if (/^if\s+/i.test(text) && (mm = text.match(/^(if [^,]+),\s*([\s\S]+)$/i))) {
    const cond = parseCondition(mm[1]);
    if (cond) {
      const inner = parseOps(mm[2], unknown);
      if (inner.length) return [{ op: 'ifCond', cond, ops: inner }];
    }
  }
  // Revelar y jugar la carta revelada si cumple (varias plantillas).
  if ((mm = text.match(/reveal (?:up to )?1 cards? from the top of your deck[.,;]?\s*(?:and )?play up to 1 (.+?) card with a cost of (\d+)(?: or less)?( rested)?/i))) {
    ops.push({ op: 'revealPlay', filter: parseFilter(mm[1] + ' card'), maxCost: parseInt(mm[2], 10), rested: !!mm[3] });
    text = text.replace(mm[0], '');
    text = text.replace(/^,?\s*and place the rest at the top or bottom of your deck\.?/i, '');
  } else if ((mm = text.match(/reveal (?:up to )?1 cards? from the top of your deck[.,;]?\s*(?:if (?:it|that card) is (?:an? )?(.+?)(?: with (?:a )?cost of (\d+)(?: or less)?)?,?\s*)?(?:you may )?play (?:up to 1 |it|that card)/i))) {
    ops.push({ op: 'revealPlay', filter: mm[1] ? parseFilter(mm[1]) : {}, maxCost: mm[2] ? parseInt(mm[2], 10) : null });
    text = text.replace(mm[0], '');
  }
  // El rival elige una de dos opciones (modal del oponente) — ANTES que los
  // patrones sueltos, para no consumir texto de dentro del modal.
  if ((mm = text.match(/your opponent chooses one:\s*(.+)$/i))) {
    const options = mm[1].split('•').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean).map((s) => parseOps(s, unknown));
    ops.push({ op: 'oppChoose', options });
    text = text.replace(mm[0], '');
  }
  // Trash 1 card from the top of your opponent's Life cards (suele ir en modales).
  if ((mm = text.match(/^trash (\d+) cards? from the top of your opponent's life cards?\.?$/i))) {
    return [{ op: 'trashOppLife', n: n(mm[1]) }];
  }
  // Revelar y poner una carta de la mano en lo alto de tu Vida (Ivankov).
  if ((mm = text.match(/(?:reveal up to 1 |add up to 1 )?(.+?) from your hand and add it to the top of your life cards?( face-down| face-up)?/i))) {
    ops.push({ op: 'handToLife', filter: parseFilter(mm[1]), faceUp: /face-up/i.test(mm[2] ?? '') });
    text = text.replace(mm[0], '');
  }
  // Añadir carta(s) de lo alto del mazo a lo alto de tu Vida (Newgate).
  if ((mm = text.match(/add (?:up to )?(\d+|1) cards? from the top of your deck to the top of your life cards?/i))) {
    ops.push({ op: 'lifeAddFromDeck', n: n(mm[1]) });
    text = text.replace(mm[0], '');
  }
  // Mirar toda tu Vida y colocar 1 en lo alto del mazo (reordenar, con elección).
  if ((mm = text.match(/look at all your life cards[;,.]?\s*place 1 card at the top of your deck[^.]*\.?/i))) {
    ops.push({ op: 'lifeToTopDeck' });
    text = text.replace(mm[0], '');
  }
  // Revelar la carta superior (informativo) cuando no hay más instrucción.
  if ((mm = text.match(/^reveal 1 card from the top of your deck\.?$/i))) {
    text = text.replace(mm[0], '');
  }
  // Añadir carta de la parte superior de tu Vida a la mano.
  if ((mm = text.match(/(?:reveal|add) (?:up to )?1 cards? from the top of your life cards?[.,;]?\s*(?:add (?:it|that card) to your hand)?/i))) {
    ops.push({ op: 'lifeToHand', n: 1 });
    text = text.replace(mm[0], '');
  }
  // Mirar/reordenar las cartas de vida (informativo en el simulador).
  if ((mm = text.match(/^look at all your life cards\.?/i))) {
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/(?:add|place) up to (\d+) cards? from the top of your deck to the top of your life/i))) {
    ops.push({ op: 'deckToLife', n: n(mm[1]) });
    text = text.replace(mm[0], '');
  }
  // Frases separadas por ". " / "; " / ", then " / ". Then,".
  const sentences = text.split(/(?<=\.)\s+|;\s*|,\s*then\s+/i).map((s) => s.trim()).filter(Boolean);
  for (let s of sentences) {
    s = s.replace(/\.$/, '').replace(/^then,?\s*/i, '').replace(/^if you do(?! not)(?! do)\b,?\s*/i, '').replace(/^if you do not\b/i, 'if you do not').trim();
    if (!s) continue;

    // — condicional "if <cond>, <efecto>" —
    const cond = parseConditional(s, unknown);
    if (cond) { ops.push(...cond); continue; }

    // — buff/debuff genérico a un grupo (poder/coste/keyword, con duración) —
    const buff = parseBuff(s);
    if (buff) { ops.push(buff); continue; }

    const l = s.toLowerCase();
    let m;

    // — DON —
    if ((m = l.match(/^give (?:this leader or 1 of your characters|up to (\d+) rested don!! cards?( to your leader(?: or 1 of your characters)?)?)(?: up to (\d+) rested don!! cards?)?/))) {
      const leaderOnly = !!m[2] && !/or 1 of your characters/.test(m[2]);
      ops.push({ op: 'giveRestedDon', n: n(m[1] ?? m[3] ?? 1), leaderOnly });
      continue;
    }
    if ((m = l.match(/^add (?:up to )?(\d+) don!! cards? from your don!! deck and (set (?:it|them) as active|rest (?:it|them))/))) {
      ops.push({ op: 'donFromDeck', n: n(m[1]), active: m[2].startsWith('set') });
      continue;
    }
    if ((m = l.match(/^add up to (\d+) additional don!! cards? and (set (?:it|them) as active|rest (?:it|them))/))) {
      ops.push({ op: 'donFromDeck', n: n(m[1]), active: m[2].startsWith('set') });
      continue;
    }
    if ((m = l.match(/^set up to (\d+) of your don!! cards as active/))) {
      ops.push({ op: 'unrestDon', n: n(m[1]) });
      continue;
    }
    if ((m = l.match(/^rest up to (\d+) of your opponent'?s don!! cards?/))) {
      ops.push({ op: 'restOppDon', n: n(m[1]) });
      continue;
    }

    // — poder — (duración: "during this turn/battle" o "until the end of ... turn")
    s = s.replace(/^if you do,?\s*/i, ''); const l2 = s.toLowerCase();
    const DUR = '(?:during this (?:turn|battle)|until the end of (?:your |this |the )?(?:next )?turn)';
    if ((m = l2.match(new RegExp(`^up to (\\d+) (?:of your )?(?:\\w+ )?(?:\\{[^}]+\\} type |["“][^"”]+["”] type )?(?:leader or character cards?|leader|character cards?)(?: on your field)?(?: other than this card)? gains? \\+(\\d+) power ${DUR}`)))) {
      ops.push({ op: 'powerUp', n: parseInt(m[2], 10), targets: n(m[1]), other: l2.includes('other than this card') });
      continue;
    }
    if ((m = l2.match(new RegExp(`^give up to (\\d+) of your opponent'?s characters? -(\\d+) power ${DUR}`)))) {
      ops.push({ op: 'powerDown', n: parseInt(m[2], 10), targets: n(m[1]) });
      continue;
    }
    if ((m = l2.match(/^give up to (\d+) of your opponent'?s characters? -(\d+) cost during this turn/))) {
      ops.push({ op: 'costDown', n: parseInt(m[2], 10), targets: n(m[1]) });
      continue;
    }
    // Buff de palabra clave a un grupo: "up to N of your <tipo> gains [Kw] ...".
    if ((m = l2.match(/^up to (\d+) of your (?:\{[^}]+\}|["“][^"”]+["”]|[\w ]+?) (?:type )?(?:leader or character cards?|characters?) gains? \[([\w ]+)\]/))) {
      ops.push({ op: 'grantKeywordGroup', kw: m[2], targets: n(m[1]) });
      continue;
    }
    // "this character/leader/card gains ..." — puede combinar poder, coste y keywords.
    if ((m = l.match(/^this (?:character|leader|card) gains (.+?)(?:\s+(during this turn|during this battle|until the start of your next turn|until the end of your opponent'?s next turn|until the end of (?:your |this )?turn))?$/))) {
      const grant = parseGrant(m[1]);
      if (grant.changes.length || grant.kws.length) {
        const dur = durOf((m[2] ?? s).toLowerCase());
        const isStatic = !m[2] && grant.changes.length === 1 && grant.changes[0].stat === 'power' && !grant.kws.length && !grant.per;
        // Sin coletilla temporal y solo +poder ⇒ estática (aura de sí misma).
        if (isStatic) ops.push({ op: 'powerSelf', n: grant.changes[0].delta });
        else ops.push({ op: 'selfGrant', changes: grant.changes, kws: grant.kws, per: grant.per, dur, static: !m[2] });
        continue;
      }
    }
    if ((m = l.match(/^your opponent cannot activate(?: a)? \[blocker\](?: character that has (\d+) or more power)? during this battle/))) {
      ops.push({ op: 'noBlocker', minPower: m[1] ? parseInt(m[1], 10) : 0 });
      continue;
    }
    if ((m = l.match(/^select up to 1 of your .*?leader or character cards/)) && /cannot activate \[blocker\]/.test(l)) {
      ops.push({ op: 'grantNoBlocker' });
      continue;
    }

    // — eliminación / control —
    const ko = parseKO(s);
    if (ko) { ops.push(ko); continue; }
    const prot = parseProtect(s);
    if (prot) {
      // "cannot be KO'd ... and gains +N power" combina protección y buff.
      const andPart = s.match(/\band gains? (.+)$/i);
      ops.push(prot);
      if (andPart) {
        const grant = parseGrant(andPart[1]);
        const pureP = grant.changes.length === 1 && grant.changes[0].stat === 'power' && !grant.kws.length && !/during|until/i.test(andPart[1]);
        if (pureP) ops.push({ op: 'powerSelf', n: grant.changes[0].delta }); // aura estática
        else if (grant.changes.length || grant.kws.length) ops.push({ op: 'selfGrant', changes: grant.changes, kws: grant.kws, dur: durOf(s.toLowerCase()) });
      }
      continue;
    }
    if ((m = l.match(/^return up to (\d+) characters?(?: with a cost of (\d+) or less)? to the owner'?s hand/))) {
      ops.push({ op: 'bounce', targets: n(m[1]), maxCost: m[2] ? parseInt(m[2], 10) : 99 });
      continue;
    }
    // "return all of your [X] and [Y] characters to the owner's hand".
    if ((m = s.match(/^return all of your (.+?) characters? to the owner'?s hand/i))) {
      ops.push({ op: 'bounceOwn', all: true, filter: parseTargetFilter(m[1]) });
      continue;
    }
    if ((m = l.match(/^place up to (\d+) of your opponent'?s characters?(?: with (\d+) power or less| with a cost of (\d+) or less)? at the bottom of the owner'?s deck/))) {
      ops.push({ op: 'tuckBottom', targets: n(m[1]), maxCost: m[3] ? parseInt(m[3], 10) : 99, maxPower: m[2] ? parseInt(m[2], 10) : null });
      continue;
    }
    if ((m = l.match(/^place up to (\d+) characters? with a cost of (\d+) or less at the bottom of the owner'?s deck/))) {
      ops.push({ op: 'tuckBottom', targets: n(m[1]), maxCost: parseInt(m[2], 10) });
      continue;
    }
    // Girar objetivos del rival (personajes o líder), con filtros/[Blocker].
    if ((m = s.match(/^rest up to (\d+) of your opponent'?s (leader or character cards?|\[blocker\] characters?|characters?)\b(.*)$/i))) {
      ops.push({
        op: 'restTarget', targets: n(m[1]),
        includeLeader: /leader/i.test(m[2]), blockerOnly: /\[blocker\]/i.test(m[2]),
        filter: parseTargetFilter(m[3]),
      });
      continue;
    }
    // Enderezar personajes propios (con filtros), o "set all ... as active".
    if ((m = s.match(/^set (all|up to (\d+)) of your (.+?) as active(?: at the end of this turn)?/i))) {
      ops.push({ op: 'unrestChar', all: m[1].toLowerCase() === 'all', targets: m[2] ? n(m[2]) : 99, filter: parseTargetFilter(m[3]) });
      continue;
    }
    if (/^set this (?:leader|card|character) as active$/.test(l)) {
      ops.push({ op: 'unrestSelf' });
      continue;
    }
    // "That Character/card gains (an additional) <grant> [dur]": al último objetivo.
    if ((m = s.match(/^that (?:character|card) gains (?:an additional )?(.+?)(?:\s+(during this turn|during this battle|until the end of your opponent'?s next turn|until the start of your next turn|until the end of (?:your |this )?turn))?$/i))) {
      const grant = parseGrant(m[1]);
      if (grant.changes.length || grant.kws.length) {
        ops.push({ op: 'grantToLast', changes: grant.changes, kws: grant.kws, dur: durOf((m[2] ?? s).toLowerCase()) });
        continue;
      }
    }
    // "Change the target of the attack to your <filtro>": redirigir el ataque.
    if ((m = s.match(/^change the target of the attack to your (.+)$/i))) {
      ops.push({ op: 'redirectAttack', filter: parseTargetFilter(m[1]) });
      continue;
    }
    if ((m = l.match(/^trash up to (\d+) of your opponent'?s life cards?/))) {
      ops.push({ op: 'trashOppLife', n: n(m[1]) });
      continue;
    }
    // El rival descarta / roba forzado.
    if ((m = l.match(/^trash (\d+) cards? from (?:your )?opponent'?s hand/)) ||
        (m = l.match(/^your opponent (?:chooses|trashes) (\d+) cards? from (?:their|your opponent'?s) hand/)) ||
        /^your opponent chooses \d+ card from their hand and trashes it$/.test(l)) {
      const num = m ? n(m[1]) : 1;
      ops.push({ op: 'oppDiscard', n: num, oppChooses: /your opponent chooses/.test(l) });
      continue;
    }
    // "this character can also attack your opponent's active characters".
    if (/^this character can also attack your opponent'?s active characters/.test(l)) {
      ops.push({ op: 'canAttackActive' });
      continue;
    }
    // Congelar: no se endereza en la próxima fase de refresco del rival.
    if ((m = s.match(/^(?:up to (\d+) of your opponent'?s )?(?:rested )?characters?\b.*?will not become active in your opponent'?s next refresh phase/i))) {
      ops.push({ op: 'freeze', targets: m[1] ? n(m[1]) : 1, filter: parseTargetFilter(s) });
      continue;
    }
    // No pueden atacar hasta el próximo turno del rival.
    if ((m = s.match(/^up to (\d+) of your opponent'?s characters?\b(.*?) cannot attack until the end of your opponent'?s next (?:turn|end phase)/i))) {
      ops.push({ op: 'cannotAttack', targets: n(m[1]), filter: parseTargetFilter(m[2]) });
      continue;
    }
    // "up to N of your opponent's ... cannot activate [Blocker] during this turn".
    if (/cannot activate (?:up to \d+ )?\[blocker\]/.test(l) && /opponent/.test(l)) {
      ops.push({ op: 'noBlockerGroup' });
      continue;
    }
    // "your leader's/character's base power becomes N ...".
    if ((m = s.match(/^your .*?(leader|character)'?s? base power becomes (\d+)/i))) {
      ops.push({ op: 'setBasePower', who: m[1].toLowerCase(), value: parseInt(m[2], 10), dur: durOf(l) });
      continue;
    }
    // "give this leader N power" / "give this card in your hand N cost".
    // El signo − se pierde en las fuentes: "give" con número pelado = resta.
    if ((m = l.match(/^give this leader -?(\d+) power/))) {
      ops.push({ op: 'selfGrant', target: 'leader', static: /^if|^give this leader/.test(l) && !/during|until/.test(l), changes: [{ stat: 'power', delta: -parseInt(m[1], 10) }], kws: [], dur: durOf(l) });
      continue;
    }
    if ((m = l.match(/^give this card in your hand -?(\d+) cost/))) {
      ops.push({ op: 'selfCost', delta: -parseInt(m[1], 10) });
      continue;
    }
    // Borsalino ST33-004: descuento en mano el turno en que trasheaste por efecto.
    if ((m = l.match(/^during the turn in which a card in your hand is trashed by an effect, give this card in your hand -?(\d+) cost$/))) {
      ops.push({ op: 'handCostAfterTrash', delta: -parseInt(m[1], 10) });
      continue;
    }
    // "cannot be rested" hasta el próximo turno del rival (Oden ST32-002).
    if ((m = s.match(/^up to (\d+) of your opponent'?s characters?\b(.*?) cannot be rested until the end of your opponent'?s next (?:turn|end phase)/i))) {
      ops.push({ op: 'cannotBeRested', targets: n(m[1]), filter: parseTargetFilter(m[2]) });
      continue;
    }
    // Restricción del líder Zoro ST-32: no puede atacar personajes baratos.
    if ((m = l.match(/^this leader cannot attack your opponent'?s characters with a base cost of (\d+) or less during this turn$/))) {
      ops.push({ op: 'selfNoAttackLowCost', maxBaseCost: parseInt(m[1], 10) });
      continue;
    }
    // "Set your [X] Leader as active" (evento de ST-32).
    if ((m = s.match(/^set your \[([^\]]+)\] leader as active$/i))) {
      ops.push({ op: 'unrestLeader', name: m[1] });
      continue;
    }
    // Mirar la carta superior del mazo RIVAL (líder Katakuri).
    if (/^look at (\d+) cards? from the top of your opponent'?s deck$/.test(l)) {
      ops.push({ op: 'peekOppTop' });
      continue;
    }
    // Molino propio: "trash N card(s) from the top of your deck".
    if ((m = l.match(/^trash (\d+) cards? from the top of your deck$/))) {
      ops.push({ op: 'millSelf', n: n(m[1]) });
      continue;
    }
    // Base del rival a un valor fijo (Linlin ST34-004).
    if ((m = l.match(/^up to (\d+) of your opponent'?s characters'? base power becomes (\d+)(?: during this (?:turn|battle))?$/))) {
      ops.push({ op: 'setBasePowerOpp', targets: n(m[1]), value: parseInt(m[2], 10), dur: durOf(l) });
      continue;
    }
    if (s === '/') continue;   // separador suelto de la fuente

    // — cartas —
    if ((m = l.match(/^draw (\d+) cards?(?: and trash (\d+) cards? from your hand)?(?: if you have (\d+) or less cards in your hand)?/))) {
      ops.push({ op: 'draw', n: n(m[1]), trash: m[2] ? n(m[2]) : 0, ifHandMax: m[3] ? parseInt(m[3], 10) : null });
      // "Draw 1 card and/,(...) <otro efecto>": no tragarse el resto de la frase.
      const rest = s.slice(m[0].length).replace(/^\s*(?:and|,)\s*/i, '').trim();
      if (rest) ops.push(...parseOps(rest, unknown));
      continue;
    }
    // "trash N card(s) from your hand and draw M cards" (orden inverso).
    if ((m = l.match(/^trash (\d+) cards? from your hand and draw (\d+) cards?/))) {
      ops.push({ op: 'trashThenDraw', trash: n(m[1]), n: n(m[2]) });
      continue;
    }
    if (/^trash (\d+) cards? from your hand$/.test(l)) { ops.push({ op: 'selfDiscard', n: n(l.match(/\d+/)[0]) }); continue; }
    // Efecto (no coste): trashea N cartas de lo alto de TU Vida.
    if ((m = l.match(/^trash (\d+) cards? from the top of your life cards?$/))) {
      ops.push({ op: 'trashOwnLife', n: n(m[1]) });
      continue;
    }
    // "none of your Characters can be KO'd during this turn".
    if (/^none of your characters can be ko'?d during this turn$/.test(l)) {
      ops.push({ op: 'cannotKOAll' });
      continue;
    }
    // La carta revelada como coste va a lo alto del mazo (ST22-001).
    if (/^place the revealed cards? at the top of your deck$/.test(l)) {
      ops.push({ op: 'revealedToDeckTop' });
      continue;
    }
    // "place N card(s) from your hand at the top/bottom of your deck".
    if ((m = l.match(/^place (\d+) cards? from your hand at the (top|bottom) of your deck$/))) {
      ops.push({ op: 'handToDeck', n: n(m[1]), top: m[2] === 'top' });
      continue;
    }
    if ((m = l.match(/^look at (\d+) cards? from the top of your deck; reveal up to 1 (?:"([^"]+)"|\{([^}]+)\}) type card and add it to your hand/))) {
      ops.push({ op: 'tutorTop', n: n(m[1]), type: m[2] ?? m[3] });
      continue;
    }
    if ((m = l.match(/^place the rest at the bottom of your deck/))) continue; // parte del tutorTop
    if ((m = l.match(/^look at (\d+) cards? from the top of your deck and (?:return them|place them) (?:to|at) the top or bottom/))) {
      ops.push({ op: 'peekReorder', n: n(m[1]) });
      continue;
    }
    if ((m = s.match(/^add up to (\d+) (.+?) from your trash to your hand/i))) {
      const f = parseTargetFilter(m[2]);
      ops.push({ op: 'trashToHand', targets: n(m[1]), maxCost: f.cost?.dir === 'less' ? f.cost.v : 99, filter: f });
      continue;
    }
    // "play up to N (each of) <filtros> (character card) ... from your deck/hand/trash (rested)".
    if ((m = s.match(/^play up to (\d+) (?:each of )?(.+?) from your (deck|hand or trash|hand|trash)( rested)?\.?$/i))) {
      const each = /each of/i.test(s);
      let filterText = m[2].replace(/\bwith a cost of \d+( or less)?\b/i, '').replace(/\b(character|card)s?\b/gi, '');
      // "either [X] or has the attribute": nombre O mismo atributo que la fuente.
      let orNameAttr = null;
      const alt = filterText.match(/that is either \[([^\]]+)\] or has the attribute/i);
      if (alt) { orNameAttr = alt[1]; filterText = filterText.replace(alt[0], ' '); }
      const costM = s.match(/cost of (\d+)( or less)?/i);
      ops.push({
        op: 'playFromZone', targets: n(m[1]), each,
        filter: parseTargetFilter(filterText), orNameAttr,
        maxCost: costM ? parseInt(costM[1], 10) : 99,
        zone: m[3].toLowerCase(), rested: !!m[4],
      });
      continue;
    }
    if (/^place this (?:character|card) at the bottom of the owner'?s deck$/.test(l)) { ops.push({ op: 'tuckSelf' }); continue; }
    // "give up to N of your <filtro> characters up to N rested DON!! cards each".
    if ((m = s.match(/^give up to (\d+) of your (.+?) up to (\d+) rested don!! cards? each/i))) {
      ops.push({ op: 'giveRestedDonEach', targets: n(m[1]), each: n(m[3]), filter: parseTargetFilter(m[2]) });
      continue;
    }
    // "when this character battles X attribute characters, this character gains +N power".
    if ((m = s.match(/^when this character battles ["“]([^"”]+)["”] attribute characters?, this character gains \+(\d+) power/i))) {
      ops.push({ op: 'battleAttrBuff', attribute: m[1], n: parseInt(m[2], 10) });
      continue;
    }
    // Reemplazo ante KO/retirada: "if this character would be KO'd/removed, you may ... instead".
    if ((m = s.match(/^if (?:your [^,]*?character[^,]*?|this character) would be (ko'?d|removed from the field)(?: by (?:an|your opponent'?s) effect)?, you may (.+?) instead/i))) {
      const alt = m[2].toLowerCase();
      const rep = { op: 'koReplace', trigger: /removed/.test(m[1]) ? 'remove' : 'ko' };
      if (/rest this character/.test(alt)) rep.action = 'rest';
      else if (/trash this character and draw (\d+)/.test(alt)) { rep.action = 'trashDraw'; rep.draw = parseInt(alt.match(/draw (\d+)/)[1], 10); }
      else if ((m = alt.match(/trash (\d+) cards? from your hand/))) { rep.action = 'pay'; rep.trashHand = parseInt(m[1], 10); }
      else if (/trash \d+ cards? from (?:the top or bottom of )?your life/.test(alt)) { rep.action = 'pay'; rep.trashLife = 1; rep.trashLifePick = /top or bottom/.test(alt); }
      else if (/turn 1 card from the top of your life cards face-up/.test(alt)) { rep.action = 'pay'; rep.trashLife = 0; }
      else rep.action = 'pay';
      ops.push(rep);
      continue;
    }
    // "You may trash any number of X cards from your hand" como FRASE (sin ':'):
    // descarte opcional que alimenta "for every card trashed" de la frase siguiente.
    if ((m = s.match(/^you may trash any number of (.*?) ?cards? from your hand$/i))) {
      ops.push({ op: 'trashAnyNow', filter: m[1] ? parseTargetFilter(m[1]) : null });
      continue;
    }
    if (/^shuffle your deck$/.test(l)) continue;
    if (/^play this card$/.test(l)) { ops.push({ op: 'playSelf' }); continue; }
    if ((m = l.match(/^play this character(?: card)? from your trash( rested)?$/))) { ops.push({ op: 'playSelf', fromTrash: true, rested: !!m[1] }); continue; }
    // "you may rest N of your <filtro>" (acción opcional propia).
    if ((m = s.match(/^you may rest (\d+) of your (.+)$/i))) { ops.push({ op: 'restOwnAction', n: n(m[1]), filter: parseTargetFilter(m[2]) }); continue; }
    // "you may return any number of characters on your field to the owner's hand".
    if (/^you may return any number of characters on your field to the owner'?s hand$/i.test(s)) { ops.push({ op: 'bounceOwn', all: true, filter: {} }); continue; }
    // "KO the opponent's character you battled with" (lo resuelve afterCharBattle).
    if (/^ko the opponent'?s character you battled with$/i.test(l)) { ops.push({ op: 'koBattled' }); continue; }
    // Restos/instrucciones sin efecto de estado (metadatos o colas de tutor).
    if (/^trash the rest$/.test(l)) continue;
    if (/^you may$/.test(l)) continue;
    if (/^look at all your life cards$/.test(l)) { ops.push({ op: 'lifeReorder' }); continue; }
    if (/^this effect can be activated when your opponent attacks$/.test(l)) continue;
    // Negación de efectos (no modelada por completo): se reconoce sin romper.
    if (/^your( opponent'?s)?$/.test(l)) continue;
    if (/^effects are negated( until .*)?$/.test(l)) { ops.push({ op: 'negate' }); continue; }
    if ((m = l.match(/^activate this card'?s (main|counter) effect$/))) {
      ops.push({ op: 'runAbility', which: m[1] });
      continue;
    }
    // "Choose one: • A • B" — TÚ eliges (a diferencia de oppChoose).
    if ((m = s.match(/^choose one:\s*(.+)$/i))) {
      const options = m[1].split('•').map((x) => x.trim().replace(/\.$/, '')).filter(Boolean).map((x) => parseOps(x, unknown));
      if (options.length) { ops.push({ op: 'ownChoose', options }); continue; }
    }
    if (/^[•·]/.test(s)) {
      // Viñeta suelta de un "choose one" partido por el troceo: adjúntala.
      const inner = parseOps(s.replace(/^[•·]\s*/, ''), unknown);
      if (inner.length && ops.length && ops[ops.length - 1].op === 'ownChoose') {
        ops[ops.length - 1].options.push(inner); continue;
      }
      if (inner.length) { ops.push(...inner); continue; }
    }
    // Fragmento de solo palabras clave (p. ej. "[Blocker]") ⇒ ignóralo.
    if (/^(\[[\w ]+\]\s*)+$/.test(s)) continue;
    // Barajar / colocar resto (colas de tutores).
    if (/^,?\s*and\s+/i.test(s) && /place the rest/i.test(s)) continue;
    if (/^(place|put) the rest (at the top or bottom of your deck|at the bottom of your deck)/.test(l)) continue;

    // — condicionales/estáticas dentro del texto —
    if ((m = l.match(/^if you have (\d+) or more characters, this card gains \+(\d+) power/))) {
      ops.push({ op: 'staticSelfPower', n: parseInt(m[2], 10), cond: { minChars: parseInt(m[1], 10) } });
      continue;
    }
    if ((m = l.match(/^if this character is rested, your .*?leaders? and characters? gain \+(\d+) power/))) {
      ops.push({ op: 'auraWhileRested', n: parseInt(m[1], 10) });
      continue;
    }
    if (/^if this (?:character|leader) battles your opponent'?s character(?: during this turn)?, set this (?:card|leader) as active/.test(l)) {
      ops.push({ op: 'unrestAfterCharBattle' });
      continue;
    }

    unknown.push(s);
  }
  return ops;
}

// ---- costes internos ("(2)", "DON!! -1", "trash 1 card...", "rest this") --

// Marcadores que identifican un COSTE (antes del ':' de "coste: efecto").
const COST_MARKER = /\(\d+\)|don!!\s*[-]?\d+|trash (?:\d+|any number of|this)|rest this|rest \d+ of your|rest your (?:\S+ )?attribute leader|return (?:\d+|any number of|\d+ or more|\d+ total)|add \d+ cards? from (?:the top|the top or bottom) of your life cards? to your hand|place \d+ cards? from your trash|add \d+ of your characters?[^:]*to the top[^:]*your life|turn \d+ (?:of your face-up life|cards? from the top)|reveal \d+ /i;

function parseCost(text) {
  const cost = {
    donRest: 0, donReturn: 0, donReturnVar: false, trashHand: 0, trashHandFilter: null,
    trashHandAny: false, restSelf: false, trashSelf: false, trashLife: 0, lifeToHand: 0,
    restOwn: null, bounceOwn: null, trashToBottom: 0, charToLife: null, turnLifeDown: 0,
    turnLifeUp: 0, turnLifeEnds: null, returnGivenDon: 0, revealHand: null, optional: true,
  };
  const l = text.toLowerCase();
  let m;
  if ((m = l.match(/\((\d+)\)/))) cost.donRest = parseInt(m[1], 10);
  else if ((m = l.match(/rest (\d+) of your don!! cards?/))) cost.donRest = parseInt(m[1], 10);
  // Ojo: las fuentes pierden el signo − (es una imagen en la carta), así que
  // "DON!! 4" en posición de coste significa SIEMPRE devolver 4 DON!!.
  if ((m = l.match(/don!!\s*[-](\d+)/))) cost.donReturn = parseInt(m[1], 10);
  else if ((m = l.match(/^don!!\s*(\d+)\s*$/)) || (m = l.match(/don!!\s*(\d+)\s*[:,]/))) cost.donReturn = parseInt(m[1], 10);
  // "rest your ⟨atributo⟩ Leader or 1 of your DON!! cards" (el icono del
  // atributo también se pierde): coste alternativo líder/DON.
  if (/rest your (?:\S+ )?attribute leader or 1 of your don!! cards?/.test(l)) cost.restLeaderOrDon = true;
  if (/return (?:\d+ or more|any number of) don!! cards?/.test(l)) cost.donReturnVar = true;
  if ((m = l.match(/return (\d+) total of your currently given don!! cards?/))) cost.returnGivenDon = parseInt(m[1], 10);
  // Ojo: "trash N ... your life" es un coste distinto de "trash N ... your hand".
  if ((m = l.match(/trash (\d+) cards? from (the top or bottom of )?your life/))) { cost.trashLife = n(m[1]); cost.trashLifePick = !!m[2]; }
  else if ((m = text.match(/trash any number of (.*?) ?cards? from your hand/i))) { cost.trashHandAny = true; cost.trashAnyFilter = m[1] ? parseTargetFilter(m[1]) : null; }
  else if ((m = text.match(/trash (\d+) (.+?) cards? from your hand/i))) { cost.trashHand = n(m[1]); cost.trashHandFilter = parseTargetFilter(m[2]); }
  else if ((m = text.match(/trash (\d+) cards? with (.+?) from your hand/i))) { cost.trashHand = n(m[1]); }
  // "trash 1 Character card with 6000 power from your hand" (el filtro va DESPUÉS de "card").
  else if ((m = text.match(/trash (\d+) (.+? cards?) (with .+?) from your hand/i))) { cost.trashHand = n(m[1]); cost.trashHandFilter = parseTargetFilter(m[2] + ' ' + m[3]); }
  else if ((m = l.match(/trash (\d+) cards? from your hand/))) cost.trashHand = n(m[1]);
  if ((m = l.match(/add (\d+) cards? from (the top or bottom|the top) of your life cards? to your hand/))) { cost.lifeToHand = n(m[1]); cost.lifeToHandPick = m[2] === 'the top or bottom'; }
  if ((m = text.match(/rest (\d+) of your (.+?) cards?(?::|$)/i)) && /rest \d+ of your/i.test(text) && !/don!!/i.test(m[2])) cost.restOwn = { n: n(m[1]), filter: parseTargetFilter(m[2]) };
  if ((m = text.match(/return (\d+) of your (.+?) to the owner'?s hand/i))) cost.bounceOwn = { n: n(m[1]), filter: parseTargetFilter(m[2]) };
  if ((m = l.match(/place (\d+) cards? from your trash at the bottom of your deck/))) cost.trashToBottom = n(m[1]);
  if ((m = text.match(/add (\d+) of your (.+?) to the top of your life cards?/i))) cost.charToLife = { n: n(m[1]), filter: parseTargetFilter(m[2]) };
  if ((m = l.match(/turn (\d+) of your face-up life cards? face-down/))) { cost.turnLifeDown = n(m[1]); cost.turnLifeEnds = 'any'; }
  // "turn N card(s) from the top (or bottom) of your Life cards face-up/-down"
  // (ST-36). El estado boca arriba/abajo SÍ se modela: voltear boca arriba
  // exige una carta boca abajo en esa posición, y al revés.
  else if ((m = l.match(/turn (\d+) cards? from the top( or bottom)? of your life cards? face-(up|down)/))) {
    if (m[3] === 'up') cost.turnLifeUp = n(m[1]);
    else cost.turnLifeDown = n(m[1]);
    cost.turnLifeEnds = m[2] ? 'both' : 'top';
  }
  if ((m = text.match(/reveal (\d+) (.+?) from your hand/i))) cost.revealHand = { n: n(m[1]), filter: parseTargetFilter(m[2]) };
  if (/rest this (?:card|stage|character)/.test(l)) cost.restSelf = true;
  if (/trash this character/.test(l)) cost.trashSelf = true;
  return cost;
}

// ---- construcción del script ---------------------------------------------

export function buildScript(card) {
  const script = { abilities: [], unknown: [], donXStatics: [] };
  // 1. Quita notas editoriales de la API (no son reglas de la carta):
  //    disclaimers de reimpresión, comparativas de erratas, etc.
  let text = (card.text ?? '')
    .replace(/DISCLAIMER:[\s\S]*$/i, '')
    .replace(/The main difference between this card and the original[\s\S]*$/i, '')
    .replace(/This card has been officially errata'd\.?/i, '')
    .replace(/This product page is for[\s\S]*$/i, '')
    .trim();
  // 2. Quita recordatorios "(texto...)" pero conserva costes numéricos "(2)".
  text = text.replace(/\((?=[^)]*[a-z])[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text === 'NULL') return script;
  text = text
    .replace(/K\.O\./g, 'KO')                                   // que el punto no rompa frases
    // Punto sin espacio entre frases ("effects.If your...") → añade el espacio.
    // La lista de arranques evita romper nombres como "Monkey.D.Luffy".
    .replace(/\.(?=(?:If|When|Then|You|Your|This|These|At|All|Set|Give|Draw|Add|KO|Rest|Play|Trash|Look|Reveal|Select|Place|Up)\b)/g, '. ')
    .replace(/[–—−]/g, '-')                                     // guiones tipográficos → '-'
    .replace(/([a-z])[-](\d)/gi, '$1 -$2')                       // "Characters-1000" → "Characters -1000"
    .replace(/\[Activate:Main\]/gi, '[Activate: Main]')          // etiqueta sin espacio
    .replace(/with an? \[(Trigger|Blocker|Rush|Double Attack|Banish)\]/gi, 'with a $1') // "carta con [Trigger]" no es un timing
    .replace(/\s+\/\s+/g, ' ').replace(/(^|\s)\/(\s|$)/g, ' ')   // barras sueltas de la API
    .replace(/this card's \[(Main|Counter)\] effect/g, "this card's $1 effect")
    .trim();

  // Trocea por etiquetas conservando texto intermedio.
  const tokens = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index).trim() });
    tokens.push({ tag: m[1] });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ text: text.slice(last).trim() });

  let mods = { donX: 0, once: false, yourTurn: false, oppTurn: false };
  let current = null;

  const flush = () => { current = null; };

  for (const t of tokens) {
    if (t.tag) {
      const tag = t.tag;
      let mm;
      if ((mm = tag.match(/^DON!! x(\d+)$/))) { mods.donX = parseInt(mm[1], 10); flush(); continue; }
      if (tag === 'Once Per Turn') {
        if (current) current.once = true; else mods.once = true;
        continue;
      }
      if (tag === 'Your Turn') { mods.yourTurn = true; flush(); continue; }
      if (tag === "Opponent's Turn" || tag === 'Opponent’s Turn') { mods.oppTurn = true; flush(); continue; }
      if (TRIGGER_KEY[tag]) {
        current = {
          when: TRIGGER_KEY[tag],
          donX: mods.donX, once: mods.once, yourTurn: mods.yourTurn, oppTurn: mods.oppTurn,
          cost: null, ops: [], raw: '',
        };
        script.abilities.push(current);
        mods = { donX: 0, once: false, yourTurn: false, oppTurn: false };
        continue;
      }
      // Palabras clave de combate ([Rush], [Blocker]...) ya se leen aparte;
      // dentro de un efecto forman parte de la frase y se reinyectan.
      if (current) current.raw += ` [${tag}]`;
      else if (['Rush', 'Blocker', 'Double Attack', 'Banish'].includes(tag)) continue;
      continue;
    }
    if (!t.text) continue;
    if (current) current.raw += ' ' + t.text;
    else {
      // Texto sin etiqueta de timing: estática (posiblemente condicionada a [DON!! xN] / [Your Turn]).
      current = { when: 'static', donX: mods.donX, once: mods.once, yourTurn: mods.yourTurn, oppTurn: mods.oppTurn, cost: null, ops: [], raw: t.text };
      script.abilities.push(current);
      mods = { donX: 0, once: false, yourTurn: false, oppTurn: false };
    }
  }

  // Parsear cada habilidad: separar coste ("...: efecto") y ops.
  for (const ab of script.abilities) {
    let body = ab.raw.trim();
    // Disparadores embebidos en el texto (sin etiqueta [timing]).
    let tg;
    if ((tg = body.match(/^when (?:a |\d+ or more )don!! cards? on your field (?:is|are) returned to your don!! deck,\s*([\s\S]+)$/i))) {
      ab.when = 'onDonReturn'; body = tg[1];
    } else if ((tg = body.match(/^when a character is ko'?d,\s*([\s\S]+)$/i))) {
      ab.when = 'onCharKO'; body = tg[1];
    } else if ((tg = body.match(/^when your opponent activates an? \[blocker\]\s*,?\s*([\s\S]+)$/i))) {
      ab.when = 'onOppBlocker'; body = tg[1];
    } else if ((tg = body.match(/^at the end of a battle in which this character battles your opponent'?s character,\s*(?:you may )?([\s\S]+)$/i))) {
      ab.when = 'afterBattle'; body = tg[1];
    } else if ((tg = body.match(/^when your opponent activates an? event,\s*([\s\S]+)$/i))) {
      ab.when = 'onOppEvent'; body = tg[1];
    } else if ((tg = body.match(/^when this character becomes rested,\s*([\s\S]+)$/i))) {
      ab.when = 'onSelfRested'; body = tg[1];
    } else if (/^when a card is trashed from your hand by your .*?effect,\s*draw cards equal to the number of cards trashed\.?$/i.test(body)) {
      ab.when = 'onHandTrash'; body = '';
      ab.ops = [{ op: 'drawTrashedCount' }];
    }
    if (!ab.ops.length) {   // (algún disparador embebido ya fija sus ops)
      const colon = body.indexOf(':');
      // El coste va antes de ':' solo si contiene marcadores de coste reales.
      if (colon !== -1) {
        const head = body.slice(0, colon);
        if (COST_MARKER.test(head)) {
          ab.cost = parseCost(head);
          body = body.slice(colon + 1).trim();
        }
      }
      ab.ops = parseOps(body, script.unknown);
    }
  }
  // Limpia habilidades vacías (p. ej. solo palabras clave).
  script.abilities = script.abilities.filter((a) => a.ops.length || a.cost);
  return script;
}

export function abilitiesOf(card, when) {
  return (card.script?.abilities ?? []).filter((a) => a.when === when);
}

// Valor heurístico de una habilidad (para los bots).
export function opsValue(ops) {
  let v = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'draw': v += op.n * 1.2 - (op.trash ?? 0) * 0.4; break;
      case 'ko': v += 2.5; break;
      case 'bounce': case 'tuckBottom': v += 1.8; break;
      case 'powerUp': v += op.n / 1500; break;
      case 'buff': {
        const pw = op.changes?.filter((c) => c.stat === 'power').reduce((s, c) => s + c.delta, 0) ?? 0;
        v += (op.side === 'opp' ? -pw : pw) / 1500 + (op.kws?.length ?? 0) * 0.6 + (op.side === 'opp' ? 0.4 : 0);
        break;
      }
      case 'selfGrant': {
        const pw = op.changes?.filter((c) => c.stat === 'power').reduce((s, c) => s + c.delta, 0) ?? 0;
        v += pw / 1500 + (op.kws?.length ?? 0) * 0.6;
        break;
      }
      case 'powerSelf': case 'staticSelfPower': v += op.n / 1500; break;
      case 'giveRestedDon': v += op.n * 0.8; break;
      case 'donFromDeck': v += op.n * 1.2; break;
      case 'unrestDon': v += op.n * 0.8; break;
      case 'unrestChar': case 'unrestSelf': v += 1.5; break;
      case 'restTarget': case 'restOppDon': v += 1; break;
      case 'trashOppLife': v += 3; break;
      case 'tutorTop': case 'trashToHand': v += 1.5; break;
      case 'lifeToHand': v += op.n * 1.2; break;
      case 'deckToLife': v += op.n * 1.5; break;
      case 'powerDown': v += op.n / 1500 + 0.5; break;
      case 'costDown': v += op.n * 0.4; break;
      case 'revealPlay': v += 2; break;
      case 'grantKeywordGroup': v += op.targets * 0.8; break;
      case 'handToLife': v += 0.8; break;
      case 'lifeAddFromDeck': v += op.n * 1.6; break;
      case 'lifeToTopDeck': v += 0.5; break;
      case 'oppChoose': v += 1.5; break;
      case 'ifCond': case 'ifOppLife': case 'ifYouHaveChar': case 'ifDon': v += opsValue(op.ops) * 0.7; break;
      case 'ownChoose': v += Math.max(0, ...op.options.map((o) => opsValue(o))); break;
      case 'oppDiscard': v += op.n * 1.2; break;
      case 'bounceOwn': case 'bounceSelf': v += 0.3; break;
      case 'freeze': case 'cannotAttack': v += op.targets * 1.2; break;
      case 'setBasePower': v += 1; break;
      case 'selfCost': v += -op.delta * 0.3; break;
      case 'trashThenDraw': v += op.n * 1.2 - op.trash * 0.4; break;
      case 'trashAnyNow': v += 0.5; break;
      case 'selfDiscard': v -= op.n * 0.3; break;
      case 'cannotKO': v += 1.2; break;
      case 'grantToLast': v += 0.8; break;
      case 'chooseCostReveal': v += opsValue(op.ops) * 0.35; break;
      case 'cannotBeRested': v += 0.8; break;
      case 'setBasePowerOpp': v += 2; break;
      case 'millSelf': v += 0.1; break;
      case 'unrestLeader': v += 1; break;
      case 'drawTrashedCount': v += 1.5; break;
      case 'peekOppTop': v += 0.3; break;
      case 'redirectAttack': v += 1.2; break;
      case 'canAttackActive': v += 0.5; break;
      case 'noBlockerGroup': v += 1; break;
      case 'playFromZone': case 'playSelf': v += 2.5; break;
      case 'noBlocker': case 'grantNoBlocker': v += 1; break;
      case 'gainKeyword': v += 1; break;
      case 'auraWhileRested': v += 2; break;
      case 'runAbility': v += 2; break;
      default: break;
    }
  }
  return v;
}
