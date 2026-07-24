#!/usr/bin/env node
/**
 * Importa mazos preconstruidos de Commander desde APIs publicas:
 *  - Listas de mazos: MTGJSON (https://mtgjson.com/api/v5/decks/<fileName>.json)
 *  - Datos de cartas: Scryfall (https://api.scryfall.com/cards/collection)
 *
 * Genera data/precons/<slug>.json con la lista del mazo y los datos de cada
 * carta (coste, tipo, texto de oraculo, fuerza/resistencia, imagen, etc.).
 *
 * Uso:  node scripts/fetch-precons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'precons');

// Precons de Commander seleccionados (fileName de MTGJSON).
const DECKS = [
  { file: 'SpiritSquadron_VOC',    slug: 'spirit-squadron',    theme: 'Espíritus (Blanco-Azul)' },
  { file: 'VampiricBloodline_VOC', slug: 'vampiric-bloodline', theme: 'Vampiros (Negro-Rojo)' },
  { file: 'FaeDominion_WOC',       slug: 'fae-dominion',       theme: 'Hadas (Azul-Negro)' },
  { file: 'VirtueAndValor_WOC',    slug: 'virtue-and-valor',   theme: 'Encantamientos (Verde-Blanco)' },
  { file: 'LandSWrath_ZNC',        slug: 'lands-wrath',        theme: 'Tierras (Rojo-Verde-Blanco)' },
  { file: 'SneakAttack_ZNC',       slug: 'sneak-attack',       theme: 'Pícaros (Azul-Negro)' },
  { file: 'AbzanArmor_TDC',        slug: 'abzan-armor',        theme: 'Contadores (Blanco-Negro-Verde)' },
  { file: 'TemurRoar_TDC',         slug: 'temur-roar',         theme: 'Criaturas grandes (Verde-Azul-Rojo)' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const headers = { 'User-Agent': 'magic-commander-sim/1.0', Accept: 'application/json', ...(opts.headers || {}) };
      const res = await fetch(url, { ...opts, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1000 * 2 ** i);
    }
  }
}

// Reduce los datos de Scryfall a lo que necesita el simulador.
function slimCard(sc) {
  const face = sc.card_faces && !sc.image_uris ? sc.card_faces[0] : sc;
  const img = (sc.image_uris || (sc.card_faces && sc.card_faces[0].image_uris) || {});
  return {
    name: sc.name,
    manaCost: face.mana_cost ?? sc.mana_cost ?? '',
    cmc: sc.cmc ?? 0,
    typeLine: sc.type_line ?? '',
    oracleText: sc.card_faces ? sc.card_faces.map((f) => f.oracle_text).join('\n//\n') : (sc.oracle_text ?? ''),
    power: face.power ?? sc.power ?? null,
    toughness: face.toughness ?? sc.toughness ?? null,
    colors: face.colors ?? sc.colors ?? [],
    colorIdentity: sc.color_identity ?? [],
    keywords: sc.keywords ?? [],
    producedMana: sc.produced_mana ?? null,
    image: img.normal ?? img.large ?? null,
    imageSmall: img.small ?? null,
    scryfallId: sc.id,
  };
}

async function scryfallCollection(names) {
  const byName = new Map();
  for (let i = 0; i < names.length; i += 75) {
    const chunk = names.slice(i, i + 75);
    // Scryfall busca cartas de doble cara/aventura por la cara frontal.
    const body = JSON.stringify({ identifiers: chunk.map((name) => ({ name: name.split(' // ')[0] })) });
    const data = await fetchJson('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    for (const card of data.data) byName.set(card.name.toLowerCase(), slimCard(card));
    if (data.not_found?.length) {
      console.warn('  Scryfall no encontró:', data.not_found.map((n) => n.name).join(', '));
    }
    await sleep(120); // cortesía con la API
  }
  return byName;
}

function lookup(byName, name) {
  const key = name.toLowerCase();
  return (
    byName.get(key) ||
    byName.get(key.split(' // ')[0]) ||
    [...byName.values()].find((c) => c.name.toLowerCase().split(' // ')[0] === key.split(' // ')[0])
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const index = [];

  for (const deck of DECKS) {
    console.log(`Descargando lista: ${deck.file} (MTGJSON)...`);
    const raw = (await fetchJson(`https://mtgjson.com/api/v5/decks/${deck.file}.json`)).data;

    const commanderEntries = raw.commander.map((c) => ({ name: c.name, count: c.count }));
    const mainEntries = raw.mainBoard.map((c) => ({ name: c.name, count: c.count }));
    const allNames = [...new Set([...commanderEntries, ...mainEntries].map((c) => c.name))];

    console.log(`  ${allNames.length} cartas únicas → Scryfall...`);
    const byName = await scryfallCollection(allNames);

    const resolve = (entry) => {
      const card = lookup(byName, entry.name);
      if (!card) throw new Error(`Sin datos de Scryfall para: ${entry.name}`);
      return { count: entry.count, ...card };
    };

    const out = {
      slug: deck.slug,
      name: raw.name,
      theme: deck.theme,
      setCode: raw.code,
      releaseDate: raw.releaseDate,
      sources: {
        decklist: `https://mtgjson.com/api/v5/decks/${deck.file}.json`,
        cards: 'https://api.scryfall.com/cards/collection',
      },
      commanders: commanderEntries.map(resolve),
      cards: mainEntries.map(resolve),
    };

    const total = out.cards.reduce((n, c) => n + c.count, 0) + out.commanders.length;
    console.log(`  OK: ${raw.name} — ${total} cartas (${out.commanders.map((c) => c.name).join(' + ')})`);

    writeFileSync(join(OUT_DIR, `${deck.slug}.json`), JSON.stringify(out, null, 1));
    index.push({
      slug: deck.slug,
      name: raw.name,
      theme: deck.theme,
      commanders: out.commanders.map((c) => c.name),
      colorIdentity: [...new Set(out.commanders.flatMap((c) => c.colorIdentity))],
    });
  }

  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`\nListo: ${index.length} mazos en data/precons/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
