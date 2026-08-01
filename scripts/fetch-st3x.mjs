#!/usr/bin/env node
// Importa los Starter Decks ST-31..ST-36 (serie 2026). optcgapi aún no
// publica sus listas, así que se combinan tres fuentes por mazo:
//   1. el grupo de TCGCSV del propio mazo (texto, poder, counter, vida),
//   2. las cartas ya presentes en data/decks (reprints de otros starters),
//   3. optcgapi carta a carta para el resto (reprints de OP/EB/promos),
// y las CANTIDADES de las listas oficiales (anuncio de Bandai).
// Uso: node scripts/fetch-st3x.mjs [st-31 st-33 ...]   (sin args: los seis)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');
const UA = { headers: { 'User-Agent': 'optcg-sim-importer/1.0 (github.com/Codems2/magic)' } };

// Listas oficiales (leader + cantidades exactas = 50).
const DECKS = {
  'st-31': {
    group: 24749, name: 'Starter Deck 31: RED Monkey.D.Luffy', leader: 'ST21-001',
    // Nota: la lista difundida decía "Usopp OP11-033" por errata; el Usopp
    // de OP-11 es OP11-003 (OP11-033 es Bird Neptunian, verde).
    q: { 'ST31-001': 2, 'ST31-002': 2, 'ST31-003': 4, 'ST31-004': 4, 'ST31-005': 2, 'OP01-016': 4, 'OP11-003': 4, 'OP11-009': 4, 'OP11-012': 4, 'OP14-015': 4, 'ST23-004': 4, 'P-101': 4, 'OP04-016': 4, 'OP13-021': 4 },
  },
  'st-32': {
    group: 24750, name: 'Starter Deck 32: GREEN Roronoa Zoro', leader: 'OP12-020',
    q: { 'ST32-001': 4, 'ST32-002': 2, 'ST32-003': 2, 'ST32-004': 4, 'ST32-005': 2, 'OP10-036': 4, 'OP12-023': 4, 'OP12-026': 4, 'OP12-027': 4, 'OP12-028': 4, 'OP12-031': 4, 'OP15-036': 4, 'ST24-005': 4, 'OP12-039': 4 },
  },
  'st-33': {
    group: 24751, name: 'Starter Deck 33: BLUE Kuzan', leader: 'OP12-040',
    q: { 'ST33-001': 4, 'ST33-002': 4, 'ST33-003': 2, 'ST33-004': 2, 'ST33-005': 2, 'EB04-026': 4, 'OP12-043': 4, 'OP12-045': 4, 'OP12-046': 4, 'OP12-047': 4, 'OP12-050': 4, 'OP12-052': 4, 'EB04-028': 4, 'OP12-057': 4 },
  },
  'st-34': {
    group: 24752, name: 'Starter Deck 34: PURPLE Charlotte Katakuri', leader: 'OP11-062',
    q: { 'ST34-001': 2, 'ST34-002': 4, 'ST34-003': 2, 'ST34-004': 2, 'ST34-005': 4, 'EB03-032': 4, 'EB03-035': 4, 'OP11-065': 4, 'OP11-066': 4, 'OP11-068': 4, 'OP11-071': 4, 'P-090': 4, 'OP11-079': 4, 'OP11-081': 4 },
  },
  'st-35': {
    group: 24753, name: 'Starter Deck 35: RED/BLACK Sabo', leader: 'OP13-004',
    q: { 'ST35-001': 4, 'ST35-002': 2, 'ST35-003': 4, 'ST35-004': 2, 'ST35-005': 2, 'OP12-090': 4, 'OP12-093': 4, 'OP13-005': 4, 'OP13-008': 4, 'OP13-017': 4, 'OP13-081': 4, 'P-105': 4, 'OP12-098': 4, 'OP13-019': 4 },
  },
  'st-36': {
    group: 24754, name: 'Starter Deck 36: YELLOW Eustass"Captain"Kid', leader: 'OP10-099',
    q: { 'ST36-001': 4, 'ST36-002': 2, 'ST36-003': 2, 'ST36-004': 4, 'ST36-005': 2, 'OP10-101': 4, 'OP10-103': 4, 'OP10-109': 4, 'OP10-111': 4, 'OP10-114': 4, 'OP12-113': 4, 'P-085': 4, 'P-088': 4, 'OP13-116': 4 },
  },
};

const cleanText = (s) => (s ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .trim();

// Cartas ya importadas en otros mazos locales (reprints con el mismo id).
const local = new Map();
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const d = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  for (const c of [d.leader, ...(d.altLeaders ?? []), ...(d.cards ?? [])]) {
    if (c && !local.has(c.id)) local.set(c.id, { ...c, count: undefined });
  }
}

async function fromTcgcsv(groupId) {
  const r = await fetch(`https://tcgcsv.com/tcgplayer/68/${groupId}/products`, UA);
  const data = await r.json();
  const out = new Map();
  for (const p of data.results) {
    const ext = Object.fromEntries((p.extendedData ?? []).map((e) => [e.name, e.value]));
    if (!ext.Number) continue;
    out.set(ext.Number, {
      id: ext.Number,
      name: p.name.replace(/\s*\(([A-Z0-9-]+)\)\s*$/, ''),
      type: ext.CardType,
      color: ext.Color,
      cost: ext.Cost != null ? parseInt(ext.Cost, 10) : null,
      power: ext.Power != null ? parseInt(ext.Power, 10) : null,
      counter: ext.Counterplus != null ? parseInt(ext.Counterplus, 10) : null,
      life: ext.Life != null ? parseInt(ext.Life, 10) : null,
      attribute: ext.Attribute ?? null,
      subTypes: (ext.Subtypes ?? '').split(';').map((s) => s.trim()).filter(Boolean),
      rarity: ext.Rarity ?? null,
      text: cleanText(ext.Description) || 'NULL',
      image: (p.imageUrl ?? '').replace('_200w', '_400w'),
    });
  }
  return out;
}

async function fromOptcgapi(id) {
  const r = await fetch(`https://optcgapi.com/api/sets/card/${id}/`, UA);
  if (!r.ok) return null;
  const arr = await r.json();
  const c = Array.isArray(arr) ? arr[0] : null;
  if (!c) return null;
  return {
    id,
    name: c.card_name,
    type: c.card_type,
    color: c.card_color,
    cost: c.card_cost != null ? parseInt(c.card_cost, 10) : null,
    power: c.card_power != null ? parseInt(c.card_power, 10) : null,
    counter: c.counter_amount != null ? parseInt(String(c.counter_amount), 10) : null,
    life: c.life != null ? parseInt(c.life, 10) : null,
    attribute: c.attribute ?? null,
    subTypes: (c.sub_types ?? '').split(/[;\/]| {2,}/).map((s) => s.trim()).filter(Boolean),
    rarity: c.rarity ?? null,
    text: cleanText(c.card_text) || 'NULL',
    image: c.card_image,
  };
}

// Promos (P-xxx) que no estén en el grupo del mazo: grupo de promos de TCGCSV.
let promoCache = null;
async function fromPromos(id) {
  if (!promoCache) promoCache = await fromTcgcsv(17675);
  return promoCache.get(id) ?? null;
}

const slugs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(DECKS);
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
let fails = 0;

for (const slug of slugs) {
  const spec = DECKS[slug];
  if (!spec) { console.error(`?? ${slug}`); continue; }
  console.log(`\n=== ${slug.toUpperCase()} — ${spec.name} ===`);
  const group = await fromTcgcsv(spec.group);
  const wanted = [spec.leader, ...Object.keys(spec.q)];
  const cards = new Map();
  for (const id of wanted) {
    let c = group.get(id) ?? null;
    let src = 'tcgcsv';
    if (!c && local.has(id)) { c = { ...local.get(id) }; src = 'local'; }
    if (!c) { c = await fromOptcgapi(id); src = 'optcgapi'; }
    if (!c && id.startsWith('P-')) { c = await fromPromos(id); src = 'promos-tcgcsv'; }
    if (!c) { console.error(`  ✗ ${id} no encontrado en ninguna fuente`); fails++; continue; }
    cards.set(id, c);
    if (src !== 'tcgcsv') console.log(`  +${id} (${c.name}) vía ${src}`);
  }
  if (wanted.some((id) => !cards.has(id))) { console.error(`  ✗ ${slug} incompleto — NO se escribe`); continue; }

  const leader = { ...cards.get(spec.leader), count: 1 };
  const deckCards = Object.entries(spec.q).map(([id, count]) => ({ ...cards.get(id), count }));
  const total = deckCards.reduce((n, c) => n + c.count, 0);
  if (total !== 50) { console.error(`  ✗ ${slug} suma ${total} ≠ 50 — NO se escribe`); fails++; continue; }

  const deck = { slug, id: slug.toUpperCase(), name: spec.name, leader, altLeaders: [], cards: deckCards };
  writeFileSync(join(DIR, `${slug}.json`), JSON.stringify(deck, null, 1));
  const entry = { slug, id: slug.toUpperCase(), name: spec.name, leader: leader.name, color: leader.color, image: leader.image };
  const i = index.findIndex((d) => d.slug === slug);
  if (i === -1) index.push(entry); else index[i] = entry;
  console.log(`  ✅ ${slug}.json (líder ${leader.name}, ${total} cartas)`);
}

index.sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }));
writeFileSync(join(DIR, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\nindex.json actualizado (${index.length} mazos).`);
if (fails) process.exit(1);
