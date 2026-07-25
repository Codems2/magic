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
  'On K.O.': 'onKO', "On Your Opponent's Attack": 'onOppAttack',
};

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const n = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : NUM[w?.toLowerCase()] ?? 1);

// ---- efectos (frases → ops) ----------------------------------------------

function parseOps(text, unknown) {
  const ops = [];
  let mm;
  // Patrones multi-frase (se consumen antes del troceo).
  if ((mm = text.match(/select up to 1 of your .*?leader or character cards?\.\s*your opponent cannot activate \[blocker\] if that .*? attacks during this turn/i))) {
    ops.push({ op: 'grantNoBlocker' });
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/look at (\d+) cards? from the top of your deck;?\s*reveal up to 1 (?:"([^"]+)"|\{([^}]+)\}) type card and add it to your hand/i))) {
    ops.push({ op: 'tutorTop', n: n(mm[1]), type: mm[2] ?? mm[3] });
    text = text.replace(mm[0], '');
  }
  if ((mm = text.match(/^if your leader has the \{([^}]+)\} type,\s*(.+)$/i))) {
    ops.push({ op: 'ifLeaderType', type: mm[1], ops: parseOps(mm[2], unknown) });
    return ops;
  }
  // Frases separadas por ". " / "; " / ", then " / ". Then,".
  const sentences = text.split(/(?<=\.)\s+|;\s*|,\s*then\s+/i).map((s) => s.trim()).filter(Boolean);
  for (let s of sentences) {
    s = s.replace(/\.$/, '').replace(/^then,?\s*/i, '').trim();
    if (!s) continue;
    const l = s.toLowerCase();
    let m;

    // — DON —
    if ((m = l.match(/^give (?:this leader or 1 of your characters|up to (\d+) rested don!! cards?(?: to your leader or 1 of your characters)?)(?: up to (\d+) rested don!! cards?)?/))) {
      ops.push({ op: 'giveRestedDon', n: n(m[1] ?? m[2] ?? 1) });
      continue;
    }
    if ((m = l.match(/^add up to (\d+) don!! cards? from your don!! deck and (set it as active|rest it)/))) {
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

    // — poder —
    if ((m = l.match(/^up to (\d+) (?:of your )?(?:\{[^}]+\} type )?leader or character cards?(?: on your field)?(?: other than this card)? gains? \+(\d+) power during this (turn|battle)/))) {
      ops.push({ op: 'powerUp', n: parseInt(m[2], 10), targets: n(m[1]), duration: m[3], other: l.includes('other than this card') });
      continue;
    }
    if ((m = l.match(/^this (?:character|leader|card) gains \+(\d+) power(?: during this turn)?$/))) {
      ops.push({ op: 'powerSelf', n: parseInt(m[1], 10) });
      continue;
    }
    if ((m = l.match(/^this character gains \[(\w[\w ]*)\](?: during this turn)?$/))) {
      ops.push({ op: 'gainKeyword', kw: m[1] });
      continue;
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
    if ((m = l.match(/^ko up to (\d+) of your opponent'?s( rested)? (?:\[blocker\] )?characters? with (?:(\d+) power or less|a cost of (\d+) or less)/))) {
      ops.push({
        op: 'ko', targets: n(m[1]), restedOnly: !!m[2],
        maxPower: m[3] ? parseInt(m[3], 10) : null,
        maxCost: m[4] ? parseInt(m[4], 10) : null,
        blockerOnly: l.includes('[blocker]'),
      });
      continue;
    }
    if ((m = l.match(/^return up to (\d+) characters? with a cost of (\d+) or less to the owner'?s hand/))) {
      ops.push({ op: 'bounce', targets: n(m[1]), maxCost: parseInt(m[2], 10) });
      continue;
    }
    if ((m = l.match(/^place up to (\d+) characters? with a cost of (\d+) or less at the bottom of the owner'?s deck/))) {
      ops.push({ op: 'tuckBottom', targets: n(m[1]), maxCost: parseInt(m[2], 10) });
      continue;
    }
    if ((m = l.match(/^rest up to (\d+) of your opponent'?s characters?/))) {
      ops.push({ op: 'restTarget', targets: n(m[1]) });
      continue;
    }
    if ((m = l.match(/^set up to (\d+) of your .*?rested characters? with a cost of (\d+) or less as active/))) {
      ops.push({ op: 'unrestChar', targets: n(m[1]), maxCost: parseInt(m[2], 10) });
      continue;
    }
    if (/^set this (?:leader|card) as active$/.test(l)) {
      ops.push({ op: 'unrestSelf' });
      continue;
    }
    if ((m = l.match(/^trash up to (\d+) of your opponent'?s life cards?/))) {
      ops.push({ op: 'trashOppLife', n: n(m[1]) });
      continue;
    }

    // — cartas —
    if ((m = l.match(/^draw (\d+) cards?(?: and trash (\d+) cards? from your hand)?(?: if you have (\d+) or less cards in your hand)?/))) {
      ops.push({ op: 'draw', n: n(m[1]), trash: m[2] ? n(m[2]) : 0, ifHandMax: m[3] ? parseInt(m[3], 10) : null });
      continue;
    }
    if ((m = l.match(/^look at (\d+) cards? from the top of your deck; reveal up to 1 (?:"([^"]+)"|\{([^}]+)\}) type card and add it to your hand/))) {
      ops.push({ op: 'tutorTop', n: n(m[1]), type: m[2] ?? m[3] });
      continue;
    }
    if ((m = l.match(/^place the rest at the bottom of your deck/))) continue; // parte del tutorTop
    if ((m = l.match(/^look at (\d+) cards? from the top of your deck and return them to the top or bottom/))) {
      ops.push({ op: 'peekReorder', n: n(m[1]) });
      continue;
    }
    if ((m = l.match(/^add up to (\d+) .*?characters? with a cost of (\d+) or less.*? from your trash to your hand/))) {
      ops.push({ op: 'trashToHand', targets: n(m[1]), maxCost: parseInt(m[2], 10) });
      continue;
    }
    if ((m = l.match(/^play up to (\d+) \[([^\]]+)\](?: card)? with a cost of (\d+) or less from your (deck|hand)(?:, shuffle your deck)?/))) {
      ops.push({ op: 'playFromZone', targets: n(m[1]), name: m[2], maxCost: parseInt(m[3], 10), zone: m[4] });
      continue;
    }
    if (/^shuffle your deck$/.test(l)) continue;
    if (/^play this card$/.test(l)) { ops.push({ op: 'playSelf' }); continue; }
    if ((m = l.match(/^activate this card'?s (main|counter) effect$/))) {
      ops.push({ op: 'runAbility', which: m[1] });
      continue;
    }

    // — condicionales/estáticas dentro del texto —
    if ((m = l.match(/^if you have (\d+) or more characters, this card gains \+(\d+) power/))) {
      ops.push({ op: 'staticSelfPower', n: parseInt(m[2], 10), cond: { minChars: parseInt(m[1], 10) } });
      continue;
    }
    if ((m = l.match(/^if this character is rested, your .*?leaders? and characters? gain \+(\d+) power/))) {
      ops.push({ op: 'auraWhileRested', n: parseInt(m[1], 10) });
      continue;
    }
    if (/^if this character battles your opponent'?s character, set this card as active/.test(l)) {
      ops.push({ op: 'unrestAfterCharBattle' });
      continue;
    }

    unknown.push(s);
  }
  return ops;
}

// ---- costes internos ("(2)", "DON!! -1", "trash 1 card...", "rest this") --

function parseCost(text) {
  const cost = { donRest: 0, donReturn: 0, trashHand: 0, restSelf: false, optional: true };
  const l = text.toLowerCase();
  let m;
  if ((m = l.match(/\((\d+)\)/))) cost.donRest = parseInt(m[1], 10);
  if ((m = l.match(/don!!\s*[-−](\d+)/))) cost.donReturn = parseInt(m[1], 10);
  if ((m = l.match(/trash (\d+) cards? from your hand/))) cost.trashHand = n(m[1]);
  if (/rest this (?:card|stage)/.test(l)) cost.restSelf = true;
  return cost;
}

// ---- construcción del script ---------------------------------------------

export function buildScript(card) {
  const script = { abilities: [], unknown: [], donXStatics: [] };
  // Quita recordatorios "(texto...)" pero conserva costes numéricos "(2)".
  let text = (card.text ?? '').replace(/\((?=[^)]*[a-z])[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text === 'NULL') return script;
  text = text
    .replace(/This card has been officially errata'd\.?/i, '')
    .replace(/K\.O\./g, 'KO')                                   // que el punto no rompa frases
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

  let mods = { donX: 0, once: false, yourTurn: false };
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
      if (TRIGGER_KEY[tag]) {
        current = {
          when: TRIGGER_KEY[tag],
          donX: mods.donX, once: mods.once, yourTurn: mods.yourTurn,
          cost: null, ops: [], raw: '',
        };
        script.abilities.push(current);
        mods = { donX: 0, once: false, yourTurn: false };
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
      current = { when: 'static', donX: mods.donX, once: mods.once, yourTurn: mods.yourTurn, cost: null, ops: [], raw: t.text };
      script.abilities.push(current);
      mods = { donX: 0, once: false, yourTurn: false };
    }
  }

  // Parsear cada habilidad: separar coste ("...: efecto") y ops.
  for (const ab of script.abilities) {
    let body = ab.raw.trim();
    const colon = body.indexOf(':');
    // El coste va antes de ':' solo si contiene marcadores de coste reales.
    if (colon !== -1) {
      const head = body.slice(0, colon);
      if (/\(\d+\)|don!!\s*[-−]\d+|trash \d+ card|rest this/i.test(head)) {
        ab.cost = parseCost(head);
        body = body.slice(colon + 1).trim();
      }
    }
    ab.ops = parseOps(body, script.unknown);
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
      case 'powerSelf': case 'staticSelfPower': v += op.n / 1500; break;
      case 'giveRestedDon': v += op.n * 0.8; break;
      case 'donFromDeck': v += op.n * 1.2; break;
      case 'unrestDon': v += op.n * 0.8; break;
      case 'unrestChar': case 'unrestSelf': v += 1.5; break;
      case 'restTarget': case 'restOppDon': v += 1; break;
      case 'trashOppLife': v += 3; break;
      case 'tutorTop': case 'trashToHand': v += 1.5; break;
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
