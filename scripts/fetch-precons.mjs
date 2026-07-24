#!/usr/bin/env node
/**
 * Importa TODOS los mazos preconstruidos de Commander desde APIs publicas:
 *  - Catálogo y listas de mazos: MTGJSON (https://mtgjson.com/api/v5/DeckList.json
 *    y /api/v5/decks/<fileName>.json)
 *  - Datos de cartas: Scryfall (https://api.scryfall.com/cards/collection)
 *
 * Genera data/precons/<slug>.json con la lista del mazo y los datos de cada
 * carta, y data/precons/index.json con el catálogo.
 *
 * Uso:  node scripts/fetch-precons.mjs
 */
import { writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'precons');

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

// Caché global de cartas (compartida entre mazos: básicas y staples se piden una vez).
const cardCache = new Map();

async function resolveCards(names) {
  const missing = [...new Set(names.map((n) => n.split(' // ')[0].toLowerCase()))]
    .filter((n) => !cardCache.has(n));
  for (let i = 0; i < missing.length; i += 75) {
    const chunk = missing.slice(i, i + 75);
    const body = JSON.stringify({ identifiers: chunk.map((name) => ({ name })) });
    const data = await fetchJson('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    for (const card of data.data) {
      const slim = slimCard(card);
      cardCache.set(card.name.toLowerCase(), slim);
      cardCache.set(card.name.toLowerCase().split(' // ')[0], slim);
    }
    if (data.not_found?.length) {
      console.warn('  Scryfall no encontró:', data.not_found.map((n) => n.name).join(', '));
    }
    await sleep(120); // cortesía con la API
  }
}

const lookup = (name) =>
  cardCache.get(name.toLowerCase()) ?? cardCache.get(name.toLowerCase().split(' // ')[0]);

const COLOR_NAMES = { W: 'Blanco', U: 'Azul', B: 'Negro', R: 'Rojo', G: 'Verde' };
const WUBRG = ['W', 'U', 'B', 'R', 'G'];

function themeFor(colorIdentity) {
  const colors = WUBRG.filter((c) => colorIdentity.includes(c));
  return colors.length ? colors.map((c) => COLOR_NAMES[c]).join('-') : 'Incoloro';
}

function slugFor(fileName) {
  return fileName
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // Regeneración completa: fuera los JSON anteriores.
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.json')) rmSync(join(OUT_DIR, f));
  }

  console.log('Descargando catálogo de mazos (MTGJSON)...');
  const catalog = (await fetchJson('https://mtgjson.com/api/v5/DeckList.json')).data;
  const precons = catalog.filter((d) => d.type === 'Commander Deck');
  console.log(`${precons.length} precons de Commander en el catálogo.`);

  const index = [];
  const seen = new Set();
  let done = 0; let skipped = 0;

  for (const entry of precons) {
    const slug = slugFor(entry.fileName);
    if (seen.has(slug)) continue;
    seen.add(slug);
    done++;
    const tag = `[${done}/${precons.length}]`;
    try {
      const raw = (await fetchJson(`https://mtgjson.com/api/v5/decks/${entry.fileName}.json`)).data;
      if (!raw.commander?.length || !raw.mainBoard?.length) {
        console.warn(`${tag} ${entry.name}: sin comandante o sin mazo, omitido.`);
        skipped++;
        continue;
      }
      const commanderEntries = raw.commander.map((c) => ({ name: c.name, count: c.count }));
      const mainEntries = raw.mainBoard.map((c) => ({ name: c.name, count: c.count }));
      await resolveCards([...commanderEntries, ...mainEntries].map((c) => c.name));

      const missing = [...commanderEntries, ...mainEntries].filter((c) => !lookup(c.name));
      if (missing.length) {
        console.warn(`${tag} ${entry.name}: ${missing.length} carta(s) sin datos (${missing.slice(0, 3).map((c) => c.name).join(', ')}…), omitido.`);
        skipped++;
        continue;
      }
      const resolve = (e) => ({ count: e.count, ...lookup(e.name) });
      const commanders = commanderEntries.map(resolve);
      const colorIdentity = [...new Set(commanders.flatMap((c) => c.colorIdentity))];

      const out = {
        slug,
        name: raw.name,
        theme: themeFor(colorIdentity),
        setCode: raw.code,
        releaseDate: raw.releaseDate,
        sources: {
          decklist: `https://mtgjson.com/api/v5/decks/${entry.fileName}.json`,
          cards: 'https://api.scryfall.com/cards/collection',
        },
        commanders,
        cards: mainEntries.map(resolve),
      };
      writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify(out));
      index.push({
        slug,
        name: raw.name,
        theme: out.theme,
        setCode: raw.code,
        releaseDate: raw.releaseDate,
        commanders: commanders.map((c) => c.name),
        colorIdentity,
        image: commanders[0].image,
      });
      console.log(`${tag} OK ${raw.name} (${raw.code}) — ${commanders.map((c) => c.name).join(' + ')}`);
    } catch (err) {
      console.warn(`${tag} ${entry.name}: error (${err.message}), omitido.`);
      skipped++;
    }
  }

  index.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.name.localeCompare(b.name));
  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`\nListo: ${index.length} mazos importados, ${skipped} omitidos, ${cardCache.size} entradas de carta en caché.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
