#!/usr/bin/env node
/**
 * F1 — Importa los Starter Decks de One Piece Card Game desde APIs públicas:
 *  - Listas y datos de carta: OPTCG API (https://optcgapi.com/api/decks/<ID>/)
 *  - Catálogo de mazos: https://optcgapi.com/api/allDecks/
 *
 * Cantidades por carta: la API da las cartas únicas (los ST son 1 líder +
 * 16 tipos, 51 cartas). Se aplica la regla estándar de los starter decks
 * (personajes comunes ×4, el resto ×2) y se valida que sume exactamente 50;
 * si no cuadra, se ajusta y el mazo queda marcado quantitiesExact: false.
 * Verificada contra ST-01: reproduce la lista física real.
 *
 * Uso:  node scripts/fetch-cards.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'decks');

// Mazos a importar: todos los del catálogo de OPTCG API (se descubren en tiempo
// de ejecución). Puedes fijar una lista concreta pasándola por argumentos.
const DECK_FILTER = process.argv.slice(2).filter((a) => /^ST-\d+$/i.test(a)).map((a) => a.toUpperCase());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'op-tcg-sim/1.0', Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1000 * 2 ** i);
    }
  }
}

function slimCard(c) {
  return {
    id: c.card_set_id,                       // "ST01-001"
    name: c.card_name.replace(/ \(\d+\)$/, ''),
    type: c.card_type,                       // Leader | Character | Event | Stage
    color: c.card_color,                     // Red | Green | Blue | Purple...
    cost: c.card_cost === null ? null : parseInt(c.card_cost, 10),
    power: c.card_power === null ? null : parseInt(c.card_power, 10),
    counter: c.counter_amount === null ? null : parseInt(c.counter_amount, 10),
    life: c.life === null ? null : parseInt(c.life, 10),
    attribute: c.attribute ?? null,          // Strike | Slash | Ranged | Special | Wisdom
    subTypes: (c.sub_types ?? '').split(/[/;]| {2,}/).map((s) => s.trim()).filter(Boolean),
    rarity: c.rarity,                        // L | C | UC | R | SR | SEC
    text: (c.card_text ?? '').trim(),
    image: c.card_image,
  };
}

// Cantidades por carta. La API da las cartas únicas pero no cuántas copias
// lleva cada una. Se aplica la estructura habitual (personajes comunes ×4,
// el resto ×2) y luego se ajusta a exactamente 50, respetando el máximo de 4
// copias por carta (regla del juego). Si no hay tipos suficientes para 50
// (mazos con datos incompletos), devuelve ok:false para omitir el mazo.
function assignQuantities(cards) {
  const leader = cards.find((c) => c.type === 'Leader');
  const rest = cards.filter((c) => c !== leader);
  if (!rest.length || rest.length * 4 < 50) return { ok: false, exact: false, total: 0 };

  for (const c of rest) c.count = (c.type === 'Character' && c.rarity === 'C') ? 4 : 2;
  let total = rest.reduce((n, c) => n + c.count, 0);
  const exactStart = total === 50;
  let adjusted = false;

  // Recorta desde las de mayor cantidad (mín. 1 copia).
  let guard = 1000;
  while (total > 50 && guard-- > 0) {
    const c = rest.filter((x) => x.count > 1).sort((a, b) => b.count - a.count)[0];
    if (!c) break;
    c.count--; total--; adjusted = true;
  }
  // Amplía desde las de menor cantidad (máx. 4 copias).
  guard = 1000;
  while (total < 50 && guard-- > 0) {
    const c = rest.filter((x) => x.count < 4).sort((a, b) => a.count - b.count)[0];
    if (!c) break;
    c.count++; total++; adjusted = true;
  }
  if (leader) leader.count = 1;
  return { ok: total === 50, exact: exactStart && !adjusted, total };
}

// Sondea IDs de mazo que existen por endpoint directo aunque no salgan en el
// catálogo (p. ej. ST-29 hoy; recogerá ST-31+ en cuanto la API los publique).
async function probeExtraIds(known) {
  const extra = [];
  for (let n = 29; n <= 40; n++) {
    const id = `ST-${n}`;
    if (known.includes(id)) continue;
    try {
      const raw = await fetchJson(`https://optcgapi.com/api/decks/${id}/`, 1);
      if (Array.isArray(raw) && raw.some((c) => c.card_type === 'Leader')) extra.push(id);
    } catch { /* 404: no existe aún */ }
    await sleep(120);
  }
  return extra;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const catalog = await fetchJson('https://optcgapi.com/api/allDecks/');
  const catalogIds = catalog.map((d) => d.structure_deck_id);
  let ids;
  if (DECK_FILTER.length) {
    ids = DECK_FILTER;
  } else {
    const extra = await probeExtraIds(catalogIds);
    if (extra.length) console.log(`Mazos fuera del catálogo detectados: ${extra.join(', ')}`);
    ids = [...catalogIds, ...extra];
  }
  console.log(`Catálogo: ${catalog.length} mazos. A importar: ${ids.length}.`);
  const index = [];
  let skipped = 0;

  for (const id of ids) {
    const meta = catalog.find((d) => d.structure_deck_id === id);
    try {
      const raw = await fetchJson(`https://optcgapi.com/api/decks/${id}/`);
      if (!Array.isArray(raw) || !raw.length) { console.warn(`  ${id}: sin datos, omitido`); skipped++; continue; }
      const cards = raw.map(slimCard).sort((a, b) => a.id.localeCompare(b.id));

      const leaders = cards.filter((c) => c.type === 'Leader');
      const leader = leaders[0];
      if (!leader) { console.warn(`  ${id}: sin líder, omitido`); skipped++; continue; }
      // Algunos mazos EX/Ultra traen 2 líderes: se elige el primero, los demás
      // pasan a ser cartas alternativas (no entran en las 50).
      const deckCards = cards.filter((c) => c.type !== 'Leader');
      const { ok, exact, total } = assignQuantities([leader, ...deckCards]);
      if (!ok) { console.warn(`  ${id}: datos incompletos (${deckCards.length} tipos, ${total} cartas), omitido`); skipped++; continue; }

      const slug = id.toLowerCase();
      const out = {
        slug, id,
        name: meta?.structure_deck_name ?? id,
        leader,
        altLeaders: leaders.slice(1),
        cards: deckCards,
        quantitiesExact: exact,
        sources: {
          deck: `https://optcgapi.com/api/decks/${id}/`,
          catalog: 'https://optcgapi.com/api/allDecks/',
        },
      };
      writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify(out, null, 1));
      index.push({
        slug, id,
        name: out.name,
        leader: leader.name,
        color: leader.color,
        image: leader.image,
        quantitiesExact: exact,
      });
      console.log(`  OK ${id}: ${leader.name} (${leader.color}) — ${deckCards.length} tipos, ${total} cartas${exact ? '' : ' *'}`);
    } catch (err) {
      console.warn(`  ${id}: error (${err.message}), omitido`);
      skipped++;
    }
    await sleep(150);
  }

  // Orden natural por número de mazo.
  index.sort((a, b) => parseInt(a.id.replace(/\D/g, ''), 10) - parseInt(b.id.replace(/\D/g, ''), 10));
  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`\nListo: ${index.length} mazos importados, ${skipped} omitidos, en data/decks/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
