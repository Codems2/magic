#!/usr/bin/env node
// Importa el ST-36 (YELLOW Eustass"Captain"Kid). optcgapi aún no publica su
// lista, así que se combina:
//   - datos de carta del grupo 24754 de TCGCSV (texto, poder, counter, vida),
//   - optcgapi para las 4 cartas que TCGplayer vende bajo otros sets,
//   - y las CANTIDADES de la lista oficial (anuncio de Bandai).
// Uso: node scripts/fetch-st36.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'decks');

// Lista oficial del ST-36 (50 cartas + líder).
const LEADER_ID = 'OP10-099';
const QUANTITIES = {
  'ST36-001': 4, 'ST36-002': 2, 'ST36-003': 2, 'ST36-004': 4, 'ST36-005': 2,
  'OP10-101': 4, 'OP10-103': 4, 'OP10-109': 4, 'OP10-111': 4, 'OP10-114': 4,
  'OP12-113': 4, 'P-085': 4, 'P-088': 4, 'OP13-116': 4,
};

const cleanText = (s) => (s ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .trim();

const UA = { headers: { 'User-Agent': 'optcg-sim-importer/1.0 (github.com/Codems2/magic)' } };

// --- TCGCSV: grupo del ST-36 -----------------------------------------------
const tcg = await (await fetch('https://tcgcsv.com/tcgplayer/68/24754/products', UA)).json();
const cards = new Map();   // id → carta en nuestro esquema
for (const p of tcg.results) {
  const ext = Object.fromEntries((p.extendedData ?? []).map((e) => [e.name, e.value]));
  const id = ext.Number;
  if (!id) continue;   // producto sellado (display/deck)
  cards.set(id, {
    id,
    name: p.name.replace(/\s*\(([A-Z0-9-]+)\)\s*$/, ''),   // "Kid (OP10-099)" → "Kid"
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
console.log(`TCGCSV: ${cards.size} cartas del grupo ST-36.`);

// --- optcgapi: las que faltan ----------------------------------------------
const wanted = [LEADER_ID, ...Object.keys(QUANTITIES)];
for (const id of wanted) {
  if (cards.has(id)) continue;
  const r = await fetch(`https://optcgapi.com/api/sets/card/${id}/`, UA);
  if (!r.ok) { console.error(`✗ optcgapi no tiene ${id}`); continue; }
  const [c] = await r.json();
  cards.set(id, {
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
  });
  console.log(`optcgapi: +${id} (${c.card_name})`);
}

// --- montar el mazo ---------------------------------------------------------
const missing = wanted.filter((id) => !cards.has(id));
if (missing.length) {
  console.error(`FALTAN cartas: ${missing.join(', ')}`);
  process.exit(1);
}
const leader = { ...cards.get(LEADER_ID), count: 1 };
const deckCards = Object.entries(QUANTITIES).map(([id, count]) => ({ ...cards.get(id), count }));
const total = deckCards.reduce((n, c) => n + c.count, 0);
console.log(`Mazo: líder ${leader.name} + ${total} cartas (${deckCards.length} únicas).`);
if (total !== 50) { console.error('✗ La lista no suma 50'); process.exit(1); }

const deck = {
  slug: 'st-36',
  id: 'ST-36',
  name: 'Starter Deck 36: YELLOW Eustass"Captain"Kid',
  leader,
  altLeaders: [],
  cards: deckCards,
};
writeFileSync(join(DIR, 'st-36.json'), JSON.stringify(deck, null, 1));

// index.json
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const entry = {
  slug: 'st-36', id: 'ST-36', name: deck.name,
  leader: leader.name, color: leader.color, image: leader.image,
};
const i = index.findIndex((d) => d.slug === 'st-36');
if (i === -1) index.push(entry); else index[i] = entry;
writeFileSync(join(DIR, 'index.json'), JSON.stringify(index, null, 1));
console.log('✅ data/decks/st-36.json + index.json actualizados.');
