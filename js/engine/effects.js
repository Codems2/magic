// Intérprete de texto de oráculo → operaciones ejecutables por el motor.
// Cubre los patrones más comunes de los precons; lo que no reconoce queda
// registrado en script.unknown (la carta sigue siendo jugable, sin efecto).

import { parseManaCost, parseNum } from './cards.js';

const KNOWN_KEYWORDS = [
  'flying', 'trample', 'vigilance', 'haste', 'deathtouch', 'lifelink',
  'first strike', 'double strike', 'menace', 'reach', 'hexproof',
  'indestructible', 'defender', 'flash', 'ward',
];

// ---- especificaciones de objetivo ----------------------------------------

function targetSpec(text) {
  const t = text.trim().replace(/\.$/, '');
  const spec = { kind: 'creature', controller: 'any' };
  if (/an opponent controls|you don't control/.test(t)) spec.controller = 'opponent';
  if (/you control/.test(t)) spec.controller = 'you';
  if (/^player$|^opponent$/.test(t)) { spec.kind = t.includes('opponent') ? 'opponentPlayer' : 'player'; return spec; }
  if (t.includes('any target')) { spec.kind = 'any'; return spec; }
  if (t.includes('creature or planeswalker')) spec.kind = 'creature';
  else if (t.includes('artifact or enchantment')) spec.kind = 'artifact-or-enchantment';
  else if (t.includes('artifact creature')) spec.kind = 'creature';
  else if (t.includes('nonland permanent')) spec.kind = 'nonland-permanent';
  else if (t.includes('permanent')) spec.kind = 'permanent';
  else if (t.includes('planeswalker')) spec.kind = 'planeswalker';
  else if (t.includes('artifact')) spec.kind = 'artifact';
  else if (t.includes('enchantment')) spec.kind = 'enchantment';
  else if (t.includes('land')) spec.kind = 'land';
  else if (t.includes('attacking or blocking')) spec.kind = 'attacking-or-blocking';
  else if (t.includes('creature')) spec.kind = 'creature';
  if (/attacking/.test(t)) spec.attacking = true;
  if (/with flying/.test(t)) spec.withFlying = true;
  if (/without flying/.test(t)) spec.withoutFlying = true;
  if (/tapped/.test(t) && !/untapped/.test(t)) spec.tapped = true;
  return spec;
}

// ---- parseo de frases de efecto ------------------------------------------

function kwList(text) {
  const found = [];
  for (const kw of KNOWN_KEYWORDS) if (text.includes(kw)) found.push(kw);
  return found;
}

// Devuelve ops de una frase, o null si no la entiende.
function parseSentence(s) {
  s = s.trim().toLowerCase().replace(/\.$/, '').replace(/^you may /, '').replace(/^then /, '');
  if (!s) return [];
  // Ruido sin efecto en el simulador.
  if (/^shuffle$|^(?:it|they) can't be regenerated$|^it's still a land$|^activate only|^exile ~$|^(?:it|they) gains? haste(?: until end of turn)?$|^untap up to \w+ lands?$|^regenerate ~$|^you may choose new targets|^put the rest on the bottom of your library|^shuffle your library$|^then shuffle$/.test(s)) return [];
  let m;

  if ((m = s.match(/^(?:you )?mills? (\w+) cards?$/))) return [{ op: 'mill', n: parseNum(m[1]), who: 'you' }];
  if ((m = s.match(/^each player mills (\w+) cards?/))) return [{ op: 'mill', n: parseNum(m[1]), who: 'each' }];
  if ((m = s.match(/^(?:you )?discards? (a|an|one|two|three|\w+) cards?(?: at random)?$/)))
    return [{ op: 'discard', n: parseNum(m[1]), who: 'you' }];
  if (/^as an additional cost to cast this spell, discard a card/.test(s))
    return [{ op: 'discard', n: 1, who: 'you' }];
  if (/^each player discards their hand/.test(s)) return [{ op: 'discardHandEach' }];
  if (/^you become the monarch/.test(s)) return [{ op: 'monarch' }];
  if ((m = s.match(/^(?:you )?loses? (\w+) life$/))) return [{ op: 'loseLife', n: parseNum(m[1]), who: 'you' }];
  if ((m = s.match(/^target player draws (\w+) cards?/)))
    return [{ op: 'draw', n: parseNum(m[1]), who: 'target', target: { kind: 'player' }, targeted: true }];

  if ((m = s.match(/^surveil (\w+)/))) return [{ op: 'scry', n: parseNum(m[1]) }];
  if (/^put target creature card from a graveyard onto the battlefield under your control/.test(s))
    return [{ op: 'reanimateAny' }];

  // Acciones de palabra clave.
  if ((m = s.match(/^support (\w+)/))) return [{ op: 'support', n: parseNum(m[1]) }];
  if (/^proliferate/.test(s)) return [{ op: 'proliferate' }];
  if (/^investigate/.test(s)) return [{ op: 'tokenSpecial', kind: 'Clue', n: 1 }];
  if ((m = s.match(/^(?:~|it) explores?$/))) return [{ op: 'explore' }];
  if ((m = s.match(/^amass (?:[a-z]+ )?(\w+)/))) return [{ op: 'amass', n: parseNum(m[1]) }];
  if (/^populate/.test(s)) return [{ op: 'populate' }];
  if ((m = s.match(/^create (a|an|one|two|three|x|\d+) (?:tapped )?(food|blood|clue|treasure) tokens?/)))
    return [{ op: 'tokenSpecial', kind: m[2][0].toUpperCase() + m[2].slice(1), n: m[1] === 'x' ? 'x' : parseNum(m[1]) }];
  if ((m = s.match(/^put (?:a|an|one|two|three|\w+) \+1\/\+1 counters? on each of up to (\w+) (?:other )?target creatures?/)))
    return [{ op: 'support', n: parseNum(m[1]) }];
  if ((m = s.match(/^distribute (\w+) \+1\/\+1 counters? among/)))
    return [{ op: 'distribute', n: parseNum(m[1]) }];
  if ((m = s.match(/^monstrosity (\w+)/))) return [{ op: 'counters', n: parseNum(m[1]), scope: 'self' }];

  if (/^counter target .*spell/.test(s)) return [{ op: 'counterSpell' }];

  if ((m = s.match(/^(?:you )?draw (a|an|one|two|three|four|x|\d+) cards?/)))
    return [{ op: 'draw', n: m[1] === 'x' ? 'x' : parseNum(m[1]), who: 'you' }];
  if (/^each player draws a card/.test(s)) return [{ op: 'draw', n: 1, who: 'each' }];

  if ((m = s.match(/^(?:~|it) deals (a|one|two|three|four|five|six|x|\d+) damage to (.+?)(?: and | at |$)/))) {
    const n = m[1] === 'x' ? 'x' : parseNum(m[1]);
    const tgt = m[2];
    if (/each opponent/.test(tgt)) return [{ op: 'damage', n, target: { kind: 'eachOpponent' } }];
    if (/each creature(?! you control)/.test(tgt)) return [{ op: 'damage', n, target: { kind: 'eachCreature' } }];
    if (/each player/.test(tgt)) return [{ op: 'damage', n, target: { kind: 'eachPlayer' } }];
    if (/any target/.test(tgt)) return [{ op: 'damage', n, target: { kind: 'any', targeted: true } }];
    if (/target (creature|player|opponent|permanent|planeswalker)/.test(tgt))
      return [{ op: 'damage', n, target: { ...targetSpec(tgt.replace(/^target /, '')), targeted: true } }];
    return null;
  }

  if ((m = s.match(/^destroy all (creatures|artifacts|enchantments|nonland permanents)/)))
    return [{ op: 'wipe', what: m[1] }];
  if ((m = s.match(/^destroy each (creature)/))) return [{ op: 'wipe', what: 'creatures' }];
  if ((m = s.match(/^destroy target (.+)/))) return [{ op: 'destroy', target: { ...targetSpec(m[1]), targeted: true } }];
  if ((m = s.match(/^exile target (.+)/))) return [{ op: 'exile', target: { ...targetSpec(m[1]), targeted: true } }];
  if ((m = s.match(/^exile all (creatures)/))) return [{ op: 'wipe', what: 'creatures', exile: true }];

  if ((m = s.match(/^return target (.+?) to (?:its|their) owner(?:'s)? hands?/)))
    return [{ op: 'bounce', target: { ...targetSpec(m[1]), targeted: true } }];
  if ((m = s.match(/^return (?:up to (\w+) )?target (.+?) cards? from your graveyard to your hand/)))
    return [{ op: 'regrow', n: parseNum(m[1] ?? 1), filter: targetSpec(m[2]) }];
  if ((m = s.match(/^return target (.+?) card from your graveyard to the battlefield/)))
    return [{ op: 'reanimate', filter: targetSpec(m[1]) }];

  if ((m = s.match(/^create (a|an|one|two|three|four|x|\d+) (?:tapped )?(\d+)\/(\d+) ([a-z, ]*?) ?((?:[a-z]+ )*?)(?:artifact )?(?:enchantment )?creature tokens?(?: with (.+?))?(?: for each| that's| named|$)/))) {
    const colors = [];
    const colorWords = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    for (const [w, c] of Object.entries(colorWords)) if (m[4].includes(w)) colors.push(c);
    const subtype = (m[5] || '').trim().split(' ').filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'Token';
    return [{
      op: 'token', n: m[1] === 'x' ? 'x' : parseNum(m[1]),
      pt: [parseInt(m[2], 10), parseInt(m[3], 10)],
      colors, name: subtype, keywords: m[6] ? kwList(m[6]) : [],
    }];
  }
  if ((m = s.match(/^create (a|an|one|two|three|x|\d+) treasure tokens?/)))
    return [{ op: 'treasure', n: m[1] === 'x' ? 'x' : parseNum(m[1]) }];

  if ((m = s.match(/^search your library for (?:up to (\w+) )?basic land(?: card)?s?.*?put (?:it|them|that card|those cards) onto the battlefield( tapped)?/)))
    return [{ op: 'ramp', n: parseNum(m[1] ?? 1), tapped: !!m[2] }];
  if (/^search your library for (?:up to (\w+) )?basic lands?.*?(?:into|to) your hand/.test(s))
    return [{ op: 'landToHand', n: 1 }];

  if ((m = s.match(/^(target creature|creatures you control|~|it) (?:gets?|gain) ([+-]\d+)\/([+-]\d+)(?: and (?:gains?|has) (.+?))? until end of turn/))) {
    const scope = m[1] === 'target creature' ? 'target' : (m[1] === '~' || m[1] === 'it') ? 'self' : 'yours';
    return [{ op: 'pump', scope, pt: [parseInt(m[2], 10), parseInt(m[3], 10)], keywords: m[4] ? kwList(m[4]) : [], targeted: scope === 'target' }];
  }
  if ((m = s.match(/^(target creature|~|creatures you control) gains? (.+?) until end of turn/))) {
    const scope = m[1] === 'target creature' ? 'target' : m[1] === '~' ? 'self' : 'yours';
    const kws = kwList(m[2]);
    if (!kws.length) return null;
    return [{ op: 'pump', scope, pt: [0, 0], keywords: kws, targeted: scope === 'target' }];
  }

  if ((m = s.match(/^(?:you )?gain (\w+|x) life/))) return [{ op: 'gainLife', n: m[1] === 'x' ? 'x' : parseNum(m[1]) }];
  if ((m = s.match(/^each opponent loses (\w+) life/))) {
    const ops = [{ op: 'loseLife', n: parseNum(m[1]), who: 'eachOpponent' }];
    if (/you gain life equal/.test(s)) ops.push({ op: 'gainLifePerOpp', n: parseNum(m[1]) });
    return ops;
  }
  if ((m = s.match(/^target (player|opponent) loses (\w+) life/)))
    return [{ op: 'loseLife', n: parseNum(m[2]), who: 'target' }];

  if ((m = s.match(/^put (a|an|one|two|three|four|x|\d+) \+1\/\+1 counters? on (~|it|this creature|target creature|each creature you control|each other creature you control)/))) {
    const n = m[1] === 'x' ? 'x' : parseNum(m[1]);
    const where = m[2];
    const scope = /target/.test(where) ? 'target' : /each/.test(where) ? 'yours' : 'self';
    return [{ op: 'counters', n, scope, targeted: scope === 'target' }];
  }

  if ((m = s.match(/^scry (\w+)/))) return [{ op: 'scry', n: parseNum(m[1]) }];
  if ((m = s.match(/^(each opponent|target player|target opponent) mills? (\w+) cards?/)))
    return [{ op: 'mill', n: parseNum(m[2]), who: m[1].includes('each') ? 'eachOpponent' : 'target' }];
  if ((m = s.match(/^(each opponent|target player|target opponent) discards (a|one|two|\w+) cards?/)))
    return [{ op: 'discard', n: parseNum(m[2]), who: m[1].includes('each') ? 'eachOpponent' : 'target' }];

  if ((m = s.match(/^tap (target|each) (creature|permanent)/))) {
    if (m[1] === 'target') return [{ op: 'tap', target: { ...targetSpec(m[2]), targeted: true } }];
    return null;
  }
  if (/^untap (~|it)/.test(s)) return [{ op: 'untapSelf' }];

  return null;
}

// Parsea un bloque de texto de efecto en ops; las frases no entendidas van a unknown.
export function parseEffectOps(text, unknown) {
  const ops = [];
  let m;
  // Patrones multi-frase (se consumen antes del troceo por frases).
  if ((m = text.match(/look at the top (\w+) cards? of your library[.,]?\s*(?:you may )?put (?:up to )?(\w+) of (?:them|those cards?) into your hand[^.]*\.(?:\s*put the rest[^.]*\.)?/))) {
    ops.push({ op: 'dig', look: parseNum(m[1]), take: parseNum(m[2]) });
    text = text.replace(m[0], '');
  }
  if ((m = text.match(/exile the top card of your library\.?\s*(?:until end of turn, )?you may (?:play|cast) (?:that card|it)[^.]*\./))) {
    ops.push({ op: 'impulse', n: 1 });
    text = text.replace(m[0], '');
  }
  const sentences = text.split(/(?<=\.)\s+|, then /i);
  for (const sentence of sentences) {
    const parsed = parseSentence(sentence);
    if (parsed) ops.push(...parsed);
    else if (sentence.trim()) unknown.push(sentence.trim());
  }
  return ops;
}

// ---- construcción del script de carta ------------------------------------

// Líneas de reglas sin efecto simulable (o irrelevantes para el simulador).
const IGNORE_LINES = [
  /^enchant /, /^cycling/, /^basic landcycling/, /^changeling$/, /^madness/, /^persist$/,
  /^flash$/, /^shuffle\.?$/, /^it's still a land/, /^activate only/, /^they can't be regenerated/,
  /^as ~ enters, choose/, /^as this enchantment enters/, /^choose a creature type/, /^choose a color/,
  /^choose an opponent/, /^umbra armor/, /^ward/, /^partner/, /^this spell costs/, /^~ costs/,
  /spells? you cast cost/, /^split second/, /^this spell can't be countered/, /^protection from/,
  /^unearth/, /^flashback/, /^kicker/, /^landfall$/, /^storm$/, /^affinity/, /^devoid$/,
  /^~ can be your commander/, /^doctor's companion$/, /^you may look at the top card of your library/,
  /^friends forever$/, /^choose a background$/,
];

export function buildScript(card) {
  const script = {
    castOps: [], etb: [], dies: [], attack: [], upkeep: [], endStep: [],
    statics: [], activated: [], attachPT: null, grantsKeywords: [],
    equipCost: null, unknown: [], combatHit: [], entersTapped: false, selfKeywords: [],
    entersCounters: 0, crew: null, allyEtb: [], allyDies: [], eachUpkeep: [], eachEnd: [],
    convoke: false, cascade: false,
  };
  const name = card.name.split(' // ')[0];
  const shortName = name.split(',')[0];
  const raw = (card.oracleText || '').split('\n//\n')[0]; // solo cara frontal
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = raw.replace(new RegExp(`\\b${esc(name)}\\b`, 'g'), '~');
  if (shortName.length > 2 && shortName !== name) {
    text = text.replace(new RegExp(`\\b${esc(shortName)}\\b`, 'g'), '~');
  }
  text = text
    .replace(/\([^)]*\)/g, '') // recordatorios
    .toLowerCase()
    .replace(/\bthis (creature|artifact|enchantment|permanent|land|equipment|vehicle|token)\b/g, '~')
    .replace(/ enters the battlefield/g, ' enters');

  const typeLine = (card.typeLine || '').toLowerCase();
  const isSpell = typeLine.includes('instant') || typeLine.includes('sorcery');
  let modal = false; let modalDone = false;

  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (IGNORE_LINES.some((re) => re.test(l))) continue;
    if (/^~ enters tapped\.?$/.test(l)) { script.entersTapped = true; continue; }
    if (/^~ can't be blocked\.?$/.test(l)) { script.selfKeywords.push('unblockable'); continue; }
    if (/^~ can't block\.?$/.test(l)) { script.selfKeywords.push('cantblock'); continue; }
    let mm;
    if ((mm = l.match(/^~ enters(?: the battlefield)? with (\w+|x) \+1\/\+1 counters? on it/))) {
      script.entersCounters = mm[1] === 'x' ? 'x' : parseNum(mm[1]); continue;
    }
    if ((mm = l.match(/^crew (\d+)/))) { script.crew = parseInt(mm[1], 10); continue; }

    // Modales: usar el primer modo interpretable.
    if (/^choose (one|two|one or both|up to)/.test(l)) { modal = true; continue; }
    if (l.startsWith('•')) {
      if (modal && !modalDone) {
        const ops = parseEffectOps(l.replace(/^•\s*/, ''), []);
        if (ops.length) {
          (isSpell ? script.castOps : script.etb).push(...ops);
          modalDone = true;
        }
      }
      continue;
    }

    // Líneas de solo palabras clave (ya vienen en card.keywords).
    const words = l.replace(/\.$/, '').split(/[,;]\s*/);
    if (words.every((w) => KNOWN_KEYWORDS.includes(w.trim()) || /^ward \{/.test(w.trim()))) continue;

    let m;
    if (/^convoke$/.test(l)) { script.convoke = true; continue; }
    if (/^cascade$/.test(l)) { script.cascade = true; continue; }
    if (/^ravenous$/.test(l)) { script.entersCounters = 'x'; continue; }

    // Disparos "aliados" (tribales): otra criatura tuya entra o muere.
    const normSub = (w) => {
      const s2 = w.trim().replace(/s$/, '');
      return s2 === 'creature' || s2 === 'permanent' ? null : s2;
    };
    if ((m = l.match(/^whenever (~ or )?a(?:n|nother)? ([a-z' ]+?) you control enters(?: the battlefield)?, (.+)/))) {
      script.allyEtb.push({ subtype: normSub(m[2]), includeSelf: !!m[1], ops: parseEffectOps(m[3], script.unknown) });
      continue;
    }
    if ((m = l.match(/^whenever a ([a-z']+) enters the battlefield under your control, (.+)/))) {
      script.allyEtb.push({ subtype: normSub(m[1]), includeSelf: true, ops: parseEffectOps(m[2], script.unknown) });
      continue;
    }
    if ((m = l.match(/^whenever (~ or )?a(?:n|nother)? ([a-z' ]+?)( you control)? dies, (.+)/))) {
      script.allyDies.push({ subtype: normSub(m[2]), includeSelf: !!m[1], yoursOnly: !!m[3], ops: parseEffectOps(m[4], script.unknown) });
      continue;
    }
    if ((m = l.match(/^at the beginning of each (?:player's )?upkeep, (.+)/))) {
      script.eachUpkeep.push(...parseEffectOps(m[1], script.unknown)); continue;
    }
    if ((m = l.match(/^at the beginning of each (?:player's )?end step, (.+)/))) {
      script.eachEnd.push(...parseEffectOps(m[1], script.unknown)); continue;
    }

    // Disparadas.
    if ((m = l.match(/^whenever ~ deals combat damage to a player, (.+)/))) {
      script.combatHit.push({ scope: 'self', ops: parseEffectOps(m[1], script.unknown) }); continue;
    }
    if ((m = l.match(/^whenever (?:a|an|one or more) ([a-z']+?)s? you control deals? combat damage to a player, (.+)/))) {
      const sub = m[1] === 'creature' ? null : m[1];
      script.combatHit.push({ scope: 'yours', subtype: sub, ops: parseEffectOps(m[2], script.unknown) }); continue;
    }
    if ((m = l.match(/^when(?:ever)? ~ enters or attacks, (.+)/))) {
      const ops = parseEffectOps(m[1], script.unknown);
      script.etb.push(...ops); script.attack.push(...ops); continue;
    }
    if ((m = l.match(/^when(?:ever)? ~ enters, (.+)/))) {
      script.etb.push(...parseEffectOps(m[1], script.unknown)); continue;
    }
    if ((m = l.match(/^when(?:ever)? ~ dies, (.+)/))) {
      script.dies.push(...parseEffectOps(m[1], script.unknown)); continue;
    }
    if ((m = l.match(/^whenever ~ attacks, (.+)/))) {
      script.attack.push(...parseEffectOps(m[1], script.unknown)); continue;
    }
    if ((m = l.match(/^at the beginning of your upkeep, (.+)/))) {
      script.upkeep.push(...parseEffectOps(m[1], script.unknown)); continue;
    }
    if ((m = l.match(/^at the beginning of your end step, (.+)/))) {
      script.endStep.push(...parseEffectOps(m[1], script.unknown)); continue;
    }
    if (/^(when|whenever|at the beginning)/.test(l)) { script.unknown.push(l); continue; }

    // Equipar.
    if ((m = l.match(/^equip \{(.+?)\}/)) || (m = l.match(/^equip (\d+)/))) {
      script.equipCost = parseManaCost(`{${m[1]}}`); continue;
    }
    // Estáticas de equipo/aura.
    if ((m = l.match(/^(?:equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+)(?: and has (.+?))?(?:\.|$)/))) {
      script.attachPT = [parseInt(m[1], 10), parseInt(m[2], 10)];
      if (m[3]) script.grantsKeywords.push(...kwList(m[3]));
      continue;
    }
    if ((m = l.match(/^(?:equipped|enchanted) creature has (.+?)(?:\.|$)/))) {
      const kws = kwList(m[1]);
      if (kws.length) { script.grantsKeywords.push(...kws); continue; }
      script.unknown.push(l); continue;
    }

    // Anthems y estáticas de grupo.
    if ((m = l.match(/^(other )?([a-z' ]*?)(?:creatures?|permanents?) you control (?:get|have) ([+-]\d+\/[+-]\d+)?(?: and (?:have|gain) )?(.*?)(?:\.|$)/))) {
      const bonus = { other: !!m[1], subtype: m[2].trim() || null, pt: [0, 0], keywords: [] };
      if (m[3]) { const [p, t] = m[3].split('/'); bonus.pt = [parseInt(p, 10), parseInt(t, 10)]; }
      bonus.keywords = kwList(m[4] || '');
      if (bonus.pt[0] || bonus.pt[1] || bonus.keywords.length) { script.statics.push(bonus); continue; }
      script.unknown.push(l); continue;
    }

    // Activadas "coste: efecto" (ignorando habilidades de maná).
    if ((m = l.match(/^([^:."]{1,50}): (.+)/)) && (m[1].includes('{') || m[1].includes('sacrifice'))) {
      const costStr = m[1];
      const effectText = m[2];
      if (/^add /.test(effectText)) continue; // habilidad de maná: la lleva producedMana
      const tap = costStr.includes('{t}');
      const sac = /sacrifice ~/.test(costStr);
      const mana = parseManaCost(costStr.replace(/\{t\}/g, ''));
      const ops = parseEffectOps(effectText, script.unknown);
      const sorceryOnly = /activate only as a sorcery/.test(text);
      if (ops.length) script.activated.push({ mana, tap, sac, ops, sorceryOnly });
      continue;
    }
    if (/^\{t\}: add/.test(l) || /^\{t\}, (tap|sacrifice)/.test(l)) continue;

    // Texto principal de instantáneos/conjuros (y estáticas sueltas de permanentes).
    if (isSpell) {
      script.castOps.push(...parseEffectOps(l, script.unknown));
    } else {
      const ops = parseEffectOps(l, script.unknown);
      // Frases sueltas tipo "when ~ enters" implícitas no existen: si un permanente
      // tiene ops "de conjuro" en su texto principal, casi siempre es un ETB ya
      // capturado; las descartamos para no duplicar, salvo que no haya ETB.
      if (ops.length && !script.etb.length) script.unknown.push(l);
    }
  }

  // Objetivos requeridos al lanzar (en orden de aparición).
  script.targets = script.castOps.filter((op) => op.targeted || op.target?.targeted);
  return script;
}

// Valor heurístico de una lista de ops (para los bots).
export function opsValue(ops) {
  let v = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'draw': v += 1.5 * (op.n === 'x' ? 2 : op.n); break;
      case 'damage': v += (op.n === 'x' ? 3 : op.n) * (op.target?.kind?.startsWith('each') ? 1.5 : 0.8); break;
      case 'destroy': case 'exile': v += 3; break;
      case 'wipe': v += 5; break;
      case 'token': v += (op.n === 'x' ? 2 : op.n) * (op.pt[0] + op.pt[1]) * 0.5; break;
      case 'treasure': v += op.n === 'x' ? 2 : op.n; break;
      case 'ramp': v += 2.5 * op.n; break;
      case 'pump': v += (op.pt[0] + op.pt[1]) * 0.3 + op.keywords.length * 0.5; break;
      case 'gainLife': v += (op.n === 'x' ? 3 : op.n) * 0.3; break;
      case 'loseLife': v += op.n * (op.who === 'eachOpponent' ? 1.2 : 0.6); break;
      case 'counters': v += (op.n === 'x' ? 2 : op.n) * (op.scope === 'yours' ? 2 : 1); break;
      case 'counterSpell': v += 3; break;
      case 'bounce': v += 1.5; break;
      case 'regrow': case 'reanimate': v += 2; break;
      case 'reanimateAny': v += 3; break;
      case 'support': case 'distribute': v += op.n * 1.2; break;
      case 'proliferate': v += 1.5; break;
      case 'tokenSpecial': v += (op.n === 'x' ? 2 : op.n) * (op.kind === 'Treasure' ? 1 : 0.8); break;
      case 'explore': v += 1; break;
      case 'amass': v += op.n * 1.2; break;
      case 'populate': v += 1.5; break;
      case 'dig': v += op.take * 1.4; break;
      case 'impulse': v += 1.4; break;
      case 'monarch': v += 2.5; break;
      case 'discardHandEach': v += 2; break;
      case 'reanimateAll': v += 4; break;
      case 'scry': v += op.n * 0.4; break;
      case 'mill': v += op.n * 0.3; break;
      case 'discard': v += op.n * (op.who === 'eachOpponent' ? 1.5 : 0.8); break;
      case 'tap': v += 1; break;
      default: break;
    }
  }
  return v;
}
