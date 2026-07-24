#!/usr/bin/env node
/**
 * Localización al español de las cartas ya importadas.
 *
 * Recorre todas las cartas únicas de data/precons/*.json y busca en Scryfall
 * su impresión en español más reciente (`lang:es`), guardando en data/es.json
 * el nombre, tipo, texto e imágenes impresos en español. Las cartas sin
 * impresión española se quedan fuera (el simulador cae al inglés).
 *
 * Uso:  node scripts/fetch-spanish.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'precons');
const OUT = join(ROOT, 'data', 'es.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'magic-commander-sim/1.0', Accept: 'application/json' },
    }).catch(() => null);
    if (res?.status === 404) return null; // sin impresión española
    if (res?.ok) return res.json();
    await sleep(1000 * 2 ** i);
  }
  return null;
}

function slimEs(sc) {
  const face = sc.card_faces && !sc.image_uris ? sc.card_faces[0] : sc;
  const img = sc.image_uris || sc.card_faces?.[0]?.image_uris || {};
  const out = {};
  const name = face.printed_name ?? sc.printed_name;
  const type = face.printed_type_line ?? sc.printed_type_line;
  const text = sc.card_faces
    ? sc.card_faces.map((f) => f.printed_text ?? '').filter(Boolean).join('\n//\n')
    : sc.printed_text;
  if (name) out.n = name;
  if (type) out.y = type;
  if (text) out.t = text;
  if (img.normal) out.i = img.normal;
  if (img.small) out.s = img.small;
  return out;
}

async function findSpanish(name) {
  const tryName = async (n) => {
    const q = encodeURIComponent(`!"${n}" lang:es`);
    const data = await fetchJson(`https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=released&dir=desc`);
    // Preferir una impresión con imagen y nombre impreso.
    for (const card of data?.data ?? []) {
      const slim = slimEs(card);
      if (slim.n && (slim.i || slim.s)) return slim;
    }
    return data?.data?.length ? slimEs(data.data[0]) : null;
  };
  let res = await tryName(name);
  if (!res && name.includes(' // ')) res = await tryName(name.split(' // ')[0]);
  return res;
}

async function main() {
  const names = new Set();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const deck = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    for (const c of [...deck.commanders, ...deck.cards]) names.add(c.name);
  }
  console.log(`${names.size} cartas únicas en el catálogo.`);

  // Reanudable: conserva lo ya traducido.
  const es = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  const pending = [...names].filter((n) => !(n in es));
  console.log(`${pending.length} por consultar (${Object.keys(es).length} ya en caché).`);

  let done = 0; let found = 0;
  for (const name of pending) {
    const slim = await findSpanish(name);
    es[name] = slim ?? 0; // 0 = sin impresión española (no volver a consultar)
    if (slim) found++;
    done++;
    if (done % 100 === 0) {
      writeFileSync(OUT, JSON.stringify(es));
      console.log(`[${done}/${pending.length}] ${found} con español hasta ahora…`);
    }
    await sleep(110); // cortesía con la API
  }
  writeFileSync(OUT, JSON.stringify(es));

  const total = Object.values(es).filter(Boolean).length;
  console.log(`\nListo: ${total}/${names.size} cartas con impresión española (${Math.round((total / names.size) * 100)}%).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
