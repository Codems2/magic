#!/usr/bin/env node
// Importa TODO el pool de One Piece TCG (inglés) desde TCGCSV: los 84 grupos
// de la categoría 68, deduplicando artes alternativas/foils por Number.
// Escribe data/cards/catalog.json (el catálogo que usan el constructor de
// mazos custom y el buscador del sandbox).
// Uso: node scripts/fetch-all.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'cards');
mkdirSync(OUT, { recursive: true });
const UA = { headers: { 'User-Agent': 'optcg-sim-importer/1.0 (github.com/Codems2/magic)' } };

const cleanText = (s) => (s ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .trim();

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, UA);
      if (r.ok) return await r.json();
    } catch { /* reintento */ }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw new Error(`no se pudo leer ${url}`);
}

const groups = (await getJson('https://tcgcsv.com/tcgplayer/68/groups')).results;
console.log(`${groups.length} grupos.`);

// id → carta. Deduplicación: prefiere la versión "base" (no alt-art/foil):
// menor productId con texto no vacío suele ser la impresión original.
const cards = new Map();
let products = 0;

for (const g of groups) {
  const data = await getJson(`https://tcgcsv.com/tcgplayer/68/${g.groupId}/products`);
  let added = 0;
  for (const p of data.results) {
    const ext = Object.fromEntries((p.extendedData ?? []).map((e) => [e.name, e.value]));
    if (!ext.Number || !ext.CardType) continue;
    products++;
    const card = {
      id: ext.Number,
      name: p.name.replace(/\s*\(([A-Z0-9-]+)\)\s*$/, '').replace(/\s*\((Alternate Art|Manga|Parallel|Reprint|Box Topper|Wanted Poster|Full Art|Jolly Roger Foil|Gold|Textured)\)\s*$/i, ''),
      type: ext.CardType,
      color: ext.Color ?? null,
      cost: ext.Cost != null ? parseInt(ext.Cost, 10) : null,
      power: ext.Power != null ? parseInt(ext.Power, 10) : null,
      counter: ext.Counterplus != null ? parseInt(ext.Counterplus, 10) : null,
      life: ext.Life != null ? parseInt(ext.Life, 10) : null,
      attribute: ext.Attribute ?? null,
      subTypes: (ext.Subtypes ?? '').split(';').map((s) => s.trim()).filter(Boolean),
      rarity: ext.Rarity ?? null,
      text: cleanText(ext.Description) || 'NULL',
      image: (p.imageUrl ?? '').replace('_200w', '_400w'),
      set: g.abbreviation ?? String(g.groupId),
      _pid: p.productId,
    };
    const prev = cards.get(card.id);
    const better = !prev ||
      (prev.text === 'NULL' && card.text !== 'NULL') ||
      (card.text !== 'NULL' && card._pid < prev._pid && prev.text !== 'NULL') ||
      (prev.text === 'NULL' && card.text === 'NULL' && card._pid < prev._pid);
    if (better) cards.set(card.id, card);
    added++;
  }
  console.log(`  ${g.groupId} ${g.name}: ${added} productos`);
}

const list = [...cards.values()].map(({ _pid, ...c }) => c)
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(list));
const types = {};
for (const c of list) types[c.type] = (types[c.type] ?? 0) + 1;
console.log(`\n${products} productos → ${list.length} cartas únicas.`);
console.log('Por tipo:', types);
console.log(`catalog.json: ${(JSON.stringify(list).length / 1e6).toFixed(1)} MB`);
