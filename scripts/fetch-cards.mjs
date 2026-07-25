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

// Mazos a importar (los cuatro originales monocolor: ideales para el motor v1).
const DECKS = ['ST-01', 'ST-02', 'ST-03', 'ST-04'];

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

// Regla estándar de cantidades de los starter decks (validada con ST-01):
// personajes de rareza C ×4, todo lo demás (no líder) ×2. Ajuste fino si no suma 50.
function assignQuantities(cards) {
  const leader = cards.find((c) => c.type === 'Leader');
  const rest = cards.filter((c) => c !== leader);
  for (const c of rest) c.count = (c.type === 'Character' && c.rarity === 'C') ? 4 : 2;
  let total = rest.reduce((n, c) => n + c.count, 0);
  let exact = true;
  // Ajuste: recorta o amplía sobre los ×4 hasta cuadrar 50.
  const flex = rest.filter((c) => c.count === 4);
  let guard = 40;
  while (total !== 50 && guard-- > 0 && flex.length) {
    const c = flex[guard % flex.length];
    if (total > 50 && c.count > 1) { c.count--; total--; exact = false; }
    else if (total < 50 && c.count < 4) { c.count++; total++; exact = false; }
    else if (total < 50) { c.count++; total++; exact = false; }
  }
  if (leader) leader.count = 1;
  return { exact, total };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const catalog = await fetchJson('https://optcgapi.com/api/allDecks/');
  const index = [];

  for (const id of DECKS) {
    const meta = catalog.find((d) => d.structure_deck_id === id);
    console.log(`Importando ${id} — ${meta?.structure_deck_name ?? '(sin nombre)'}...`);
    const raw = await fetchJson(`https://optcgapi.com/api/decks/${id}/`);
    const cards = raw.map(slimCard).sort((a, b) => a.id.localeCompare(b.id));

    const leader = cards.find((c) => c.type === 'Leader');
    if (!leader) { console.warn(`  ${id}: sin líder, omitido`); continue; }
    const { exact, total } = assignQuantities(cards);
    if (total !== 50) {
      console.warn(`  ${id}: el mazo suma ${total} (esperados 50)`);
    }

    const slug = id.toLowerCase();
    const out = {
      slug,
      id,
      name: meta?.structure_deck_name ?? id,
      leader,
      cards: cards.filter((c) => c !== leader),
      quantitiesExact: exact,
      sources: {
        deck: `https://optcgapi.com/api/decks/${id}/`,
        catalog: 'https://optcgapi.com/api/allDecks/',
      },
    };
    writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify(out, null, 1));
    index.push({
      slug,
      id,
      name: out.name,
      leader: leader.name,
      color: leader.color,
      image: leader.image,
      quantitiesExact: exact,
    });
    console.log(`  OK: líder ${leader.name} (${leader.color}), ${cards.length - 1} tipos + líder, ${total} cartas${exact ? '' : ' (cantidades ajustadas)'}`);
    await sleep(150);
  }

  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`\nListo: ${index.length} mazos en data/decks/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
