#!/usr/bin/env node
// Importa todas las cartas DON!! oficiales (arte básico y promocionales)
// desde TCGCSV (categoría 68 de TCGplayer) a data/cards/dons.json.
// Solo productos que SON una carta DON!!: nombre exacto "DON!! Card" o
// "DON!! Card (...)"; los packs ("DON!! Card Pack Vol. 2"...) se excluyen.
// Uso: node scripts/fetch-dons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'cards');
mkdirSync(OUT, { recursive: true });
const UA = { headers: { 'User-Agent': 'optcg-sim-importer/1.0 (github.com/Codems2/magic)' } };

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, UA);
      if (r.ok) return await r.json();
    } catch { /* reintento */ }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw new Error(`no se pudo descargar ${url}`);
}

const groups = (await getJson('https://tcgcsv.com/tcgplayer/68/groups')).results;
const dons = [];
const seenName = new Set();
for (const g of groups) {
  const prods = (await getJson(`https://tcgcsv.com/tcgplayer/68/${g.groupId}/products`)).results;
  for (const p of prods) {
    if (!p.name.startsWith('DON!! Card (') || !p.imageUrl) continue;   // el básico ya es assets/don.jpg
    const name = p.name.match(/^DON!! Card \((.+?)\)/)[1];
    if (seenName.has(name)) continue;   // mismo arte reeditado en varios sets
    seenName.add(name);
    dons.push({ id: p.productId, name, image: p.imageUrl.replace('_200w', '_400w') });
  }
}
dons.sort((a, b) => a.id - b.id);
writeFileSync(join(OUT, 'dons.json'), JSON.stringify(dons, null, 1));
console.log(`data/cards/dons.json: ${dons.length} artes de DON!! guardados.`);
