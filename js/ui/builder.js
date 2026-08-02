// Constructor de mazos custom sobre el catálogo completo (2700+ cartas).
// Los mazos se guardan en localStorage como "specs" compactas
//   { slug, name, leader: <id>, cards: { <id>: copias } }
// y se materializan con el catálogo para jugar. Reglas que se validan:
// 1 líder · exactamente 50 cartas · máx. 4 copias · colores del líder.

const LS_KEY = 'opCustomDecks';

export const loadSpecs = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]'); } catch { return []; }
};
const saveSpecs = (list) => localStorage.setItem(LS_KEY, JSON.stringify(list));

const colorsOf = (c) => (c?.color ?? '').split(/[^A-Za-z]+/).filter(Boolean);

// spec + catálogo → mazo con el formato de data/decks/*.json (o null).
export function materializeDeck(spec, byId) {
  const leader = byId.get(spec.leader);
  if (!leader || leader.type !== 'Leader') return null;
  const cards = [];
  for (const [id, n] of Object.entries(spec.cards ?? {})) {
    const c = byId.get(id);
    if (!c || n < 1) continue;
    cards.push({ ...c, count: Math.min(4, n) });
  }
  return {
    slug: spec.slug, id: 'CUSTOM', name: spec.name, custom: true,
    leader: { ...leader, count: 1 }, altLeaders: [], cards,
  };
}

export const deckSize = (spec) => Object.values(spec.cards ?? {}).reduce((a, b) => a + b, 0);

// Lista de mazo en texto → spec. Acepta el JSON exportado por la app y los
// formatos habituales de la comunidad, línea a línea:
//   "4xOP01-016" · "4x OP01-016" · "4 OP01-016 Nami" · "OP01-016 x4" ·
//   "OP01-016" (1 copia) · "Leader: OP01-001" · comentarios con // o #.
// El líder es cualquier línea cuyo ID sea una carta de tipo Leader.
export function parseDeckList(txt, byId) {
  txt = (txt ?? '').trim();
  // ¿JSON exportado?
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === 'object' && j.cards && !Array.isArray(j)) {
      return { spec: { slug: `custom-${Date.now()}`, name: String(j.name ?? 'Importado').slice(0, 40), leader: j.leader ?? null, cards: { ...j.cards } }, unknown: [], extraLeaders: [] };
    }
  } catch { /* no era JSON: sigue como lista de texto */ }

  const ID_RE = /^([A-Z]{1,4}\d{0,2}-\d{2,3})\b/i;
  const cards = {};
  let leader = null;
  const unknown = [], extraLeaders = [];
  for (const raw of txt.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^(\/\/|#)/.test(line)) continue;
    line = line.replace(/^leader:?\s*/i, '');
    // Copias delante ("4xOP01-016", "4 OP01-016"): se separan ANTES de leer
    // el ID para que la "x" no se pegue a él.
    let n = 1;
    const pre = line.match(/^(\d+)\s*[x×]?\s*/i);
    if (pre) { n = parseInt(pre[1], 10) || 1; line = line.slice(pre[0].length); }
    const idM = line.match(ID_RE);
    if (!idM) { unknown.push(raw.trim()); continue; }
    const id = idM[1].toUpperCase();
    const c = byId.get(id);
    if (!c) { unknown.push(raw.trim()); continue; }
    // Copias detrás ("OP01-016 x4") si no venían delante.
    if (!pre) {
      const after = line.slice(idM[0].length).match(/^\s*[x×]\s*(\d+)/i);
      if (after) n = parseInt(after[1], 10) || 1;
    }
    if (c.type === 'Leader') {
      if (!leader) leader = id;
      else if (leader !== id) extraLeaders.push(id);
      continue;
    }
    cards[id] = Math.min(4, (cards[id] ?? 0) + n);
  }
  const name = leader ? `${byId.get(leader).name} (importado)` : 'Importado';
  return { spec: { slug: `custom-${Date.now()}`, name: name.slice(0, 40), leader, cards }, unknown, extraLeaders };
}

export function specProblems(spec, byId) {
  const out = [];
  const leader = byId.get(spec.leader);
  if (!leader) out.push('Falta el líder.');
  const total = deckSize(spec);
  if (total !== 50) out.push(`El mazo tiene ${total}/50 cartas.`);
  if (leader) {
    const lc = colorsOf(leader);
    const off = Object.keys(spec.cards ?? {}).filter((id) => {
      const c = byId.get(id);
      return c && !colorsOf(c).some((x) => lc.includes(x));
    });
    if (off.length) out.push(`${off.length} carta(s) no comparten color con el líder.`);
  }
  return out;
}

// ---- interfaz -------------------------------------------------------------

export function openDeckBuilder({ catalog, onChanged }) {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  document.getElementById('builderModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'builderModal';
  document.body.appendChild(modal);

  const close = () => { modal.remove(); onChanged?.(); };

  // -- vista 1: lista de tus mazos --
  const home = () => {
    const specs = loadSpecs();
    modal.innerHTML = '';
    const dlg = document.createElement('div');
    dlg.className = 'dialog builderDialog';
    dlg.innerHTML = '<h2>🛠 Mis mazos</h2><p>Crea mazos con cualquier carta del juego y pruébalos contra el bot, en sandbox o online.</p>';
    const list = document.createElement('div');
    list.className = 'bDeckList';
    for (const spec of specs) {
      const probs = specProblems(spec, byId);
      const row = document.createElement('div');
      row.className = 'bDeckRow';
      const L = byId.get(spec.leader);
      row.innerHTML = `<img src="${L?.image ?? ''}" onerror="this.style.visibility='hidden'">
        <div class="bInfo"><b>${spec.name}</b><span>${L?.name ?? '¿líder?'} · ${deckSize(spec)}/50 ${probs.length ? '⚠' : '✅'}</span></div>`;
      const mk = (label, fn, title = '') => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title; b.onclick = fn;
        row.appendChild(b);
        return b;
      };
      mk('✏', () => edit(structuredClone(spec)), 'Editar');
      mk('⧉', () => { const c = structuredClone(spec); c.slug = `custom-${Date.now()}`; c.name += ' (copia)'; saveSpecs([...specs, c]); home(); }, 'Duplicar');
      mk('📤', () => { navigator.clipboard?.writeText(JSON.stringify(spec)); alert('Mazo copiado al portapapeles (JSON). Compártelo o guárdalo.'); }, 'Exportar');
      mk('🗑', () => { if (confirm(`¿Borrar "${spec.name}"?`)) { saveSpecs(specs.filter((x) => x.slug !== spec.slug)); home(); } }, 'Borrar');
      list.appendChild(row);
    }
    if (!specs.length) list.innerHTML = '<p class="bEmpty">Aún no tienes mazos custom.</p>';
    dlg.appendChild(list);
    const newBtn = document.createElement('button');
    newBtn.className = 'primary';
    newBtn.textContent = '➕ Nuevo mazo';
    newBtn.onclick = () => edit({ slug: `custom-${Date.now()}`, name: 'Mi mazo', leader: null, cards: {} });
    dlg.appendChild(newBtn);
    const impBtn = document.createElement('button');
    impBtn.textContent = '📥 Importar lista';
    impBtn.onclick = () => importer();
    dlg.appendChild(impBtn);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Cerrar';
    closeBtn.onclick = close;
    dlg.appendChild(closeBtn);
    modal.appendChild(dlg);
  };

  // -- vista 1b: importador de listas --
  const importer = () => {
    modal.innerHTML = '';
    const dlg = document.createElement('div');
    dlg.className = 'dialog builderDialog';
    dlg.innerHTML = `<h2>📥 Importar mazo</h2>
      <p>Pega una lista en cualquier formato habitual — <code>4xOP01-016</code>,
      <code>4 OP01-016 Nami</code>, <code>OP01-016 x4</code>, una carta por línea
      (el líder se detecta solo) — o el JSON exportado desde esta app.</p>`;
    const ta = document.createElement('textarea');
    ta.className = 'bImpTa';
    ta.placeholder = '1xOP01-001\n4xOP01-016\n4xOP01-025\n…';
    dlg.appendChild(ta);
    const info = document.createElement('div');
    info.className = 'bImpInfo';
    dlg.appendChild(info);
    let parsed = null;
    const analyze = () => {
      if (!ta.value.trim()) { info.innerHTML = ''; parsed = null; saveBtn.disabled = true; return; }
      parsed = parseDeckList(ta.value, byId);
      const { spec, unknown, extraLeaders } = parsed;
      const L = spec.leader ? byId.get(spec.leader) : null;
      const probs = specProblems(spec, byId);
      const lines = [];
      lines.push(L ? `👑 Líder: <b>${L.name}</b> (${spec.leader})` : '👑 <b>Sin líder</b>: añade una línea con su ID.');
      lines.push(`🃏 ${deckSize(spec)}/50 cartas en ${Object.keys(spec.cards).length} distintas.`);
      if (extraLeaders.length) lines.push(`⚠ Líderes de más ignorados: ${extraLeaders.join(', ')}.`);
      if (unknown.length) lines.push(`⚠ ${unknown.length} línea(s) sin reconocer: <i>${unknown.slice(0, 3).join(' · ').slice(0, 90)}${unknown.length > 3 ? '…' : ''}</i>`);
      for (const p of probs) lines.push(`⚠ ${p}`);
      if (!probs.length && L && !unknown.length) lines.push('✅ Lista válida y lista para jugar.');
      info.innerHTML = lines.map((x) => `<div>${x}</div>`).join('');
      saveBtn.disabled = !L || deckSize(spec) === 0;
    };
    ta.oninput = analyze;
    const row = document.createElement('div');
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = '💾 Guardar mazo';
    saveBtn.disabled = true;
    saveBtn.onclick = () => {
      if (!parsed?.spec.leader) return;
      saveSpecs([...loadSpecs(), parsed.spec]);
      home();
    };
    const backBtn = document.createElement('button');
    backBtn.textContent = '← Volver';
    backBtn.onclick = home;
    row.append(saveBtn, backBtn);
    dlg.appendChild(row);
    modal.appendChild(dlg);
    ta.focus();
  };

  // -- vista 2: editor --
  const edit = (spec) => {
    modal.innerHTML = '';
    const dlg = document.createElement('div');
    dlg.className = 'dialog builderDialog editor';
    dlg.innerHTML = '<h2>✏ Editor de mazo</h2>';

    // Cabecera: nombre + estado.
    const head = document.createElement('div');
    head.className = 'bHead';
    const nameIn = document.createElement('input');
    nameIn.value = spec.name;
    nameIn.maxLength = 40;
    nameIn.oninput = () => { spec.name = nameIn.value; };
    const status = document.createElement('div');
    status.className = 'bStatus';
    head.append(nameIn, status);
    dlg.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'bCols';
    dlg.appendChild(cols);

    // Columna izquierda: buscador del catálogo.
    const left = document.createElement('div');
    left.className = 'bCatalog';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'sbSearch';
    search.placeholder = 'Busca por nombre, ID, tipo o subtipo… (p. ej. "Zoro", "OP01", "Leader", "FILM")';
    left.appendChild(search);
    const filters = document.createElement('div');
    filters.className = 'colorChips';
    let colorSel = null; let typeSel = null; let onlyLegal = false;
    const chip = (label, on) => {
      const b = document.createElement('button');
      b.textContent = label; b.onclick = on;
      filters.appendChild(b);
      return b;
    };
    const COLORS = { Red: '🔴', Green: '🟢', Blue: '🔵', Purple: '🟣', Black: '⚫', Yellow: '🟡' };
    for (const [en, dot] of Object.entries(COLORS)) {
      const b = chip(dot, () => { colorSel = colorSel === en ? null : en; refreshChips(); grid1(); });
      b.dataset.k = `c:${en}`;
    }
    for (const t of ['Leader', 'Character', 'Event', 'Stage']) {
      const b = chip(t, () => { typeSel = typeSel === t ? null : t; refreshChips(); grid1(); });
      b.dataset.k = `t:${t}`;
    }
    const legalBtn = chip('🎨 Del color del líder', () => { onlyLegal = !onlyLegal; refreshChips(); grid1(); });
    legalBtn.dataset.k = 'legal';
    const refreshChips = () => {
      filters.querySelectorAll('button').forEach((b) => {
        const k = b.dataset.k;
        b.classList.toggle('on', k === `c:${colorSel}` || k === `t:${typeSel}` || (k === 'legal' && onlyLegal));
      });
    };
    left.appendChild(filters);
    const grid = document.createElement('div');
    grid.className = 'bGrid';
    left.appendChild(grid);

    // Columna derecha: el mazo.
    const right = document.createElement('div');
    right.className = 'bDeck';
    cols.append(left, right);

    const legalColors = () => colorsOf(byId.get(spec.leader));

    const grid1 = () => {
      const q = search.value.trim().toLowerCase();
      grid.innerHTML = '';
      const lc = legalColors();
      const hits = catalog.filter((c) =>
        (!typeSel || c.type === typeSel) &&
        (!colorSel || colorsOf(c).includes(colorSel)) &&
        (!onlyLegal || !lc.length || colorsOf(c).some((x) => lc.includes(x))) &&
        (!q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) ||
          (c.type ?? '').toLowerCase() === q || (c.subTypes ?? []).some((s) => s.toLowerCase().includes(q)) ||
          (c.set ?? '').toLowerCase().includes(q))).slice(0, 40);
      for (const c of hits) {
        const el = document.createElement('div');
        el.className = 'bCard';
        el.innerHTML = `<img src="${c.image}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'bNoImg',textContent:${JSON.stringify(c.name)}}))">
          <span class="bTag">${c.id}${c.type === 'Leader' ? ' · LÍDER' : ` · ${spec.cards[c.id] ?? 0}/4`}</span>`;
        el.title = `${c.name} · ${c.type} · ${c.color ?? ''}\n${c.text ?? ''}`;
        el.onclick = () => {
          if (c.type === 'Leader') spec.leader = c.id;
          else spec.cards[c.id] = Math.min(4, (spec.cards[c.id] ?? 0) + 1);
          paint();
        };
        grid.appendChild(el);
      }
      if (!hits.length) grid.innerHTML = '<p class="bEmpty">Sin resultados.</p>';
    };
    search.oninput = grid1;

    const paint = () => {
      // estado y lista del mazo
      const probs = specProblems(spec, byId);
      const total = deckSize(spec);
      status.innerHTML = `<b class="${total === 50 ? 'ok' : 'bad'}">${total}/50</b> ${probs.length ? `⚠ ${probs.join(' ')}` : '✅ Legal'}`;
      right.innerHTML = '';
      const L = byId.get(spec.leader);
      const lrow = document.createElement('div');
      lrow.className = 'bLeader';
      lrow.innerHTML = L
        ? `<img src="${L.image}" onerror="this.style.visibility='hidden'"><div><b>${L.name}</b><span>${L.color} · vida ${L.life}</span></div>`
        : '<div class="bEmpty">Elige un LÍDER en el catálogo (filtro "Leader").</div>';
      right.appendChild(lrow);
      const lc = legalColors();
      const entries = Object.entries(spec.cards)
        .map(([id, n]) => [byId.get(id), n])
        .filter(([c]) => c)
        .sort((a, b) => (a[0].cost ?? 0) - (b[0].cost ?? 0) || a[0].name.localeCompare(b[0].name));
      for (const [c, n] of entries) {
        const row = document.createElement('div');
        const off = lc.length && !colorsOf(c).some((x) => lc.includes(x));
        row.className = 'bRow' + (off ? ' off' : '');
        row.innerHTML = `<span class="bCost">${c.cost ?? '—'}</span><span class="bName" title="${c.text ?? ''}">${c.name}</span><span class="bId">${c.id}</span>`;
        const minus = document.createElement('button'); minus.textContent = '−';
        minus.onclick = () => { spec.cards[c.id]--; if (spec.cards[c.id] <= 0) delete spec.cards[c.id]; paint(); };
        const count = document.createElement('b'); count.textContent = `×${n}`;
        const plus = document.createElement('button'); plus.textContent = '+';
        plus.onclick = () => { spec.cards[c.id] = Math.min(4, n + 1); paint(); };
        row.append(minus, count, plus);
        right.appendChild(row);
      }
      if (!entries.length) right.insertAdjacentHTML('beforeend', '<p class="bEmpty">Toca cartas del catálogo para añadirlas (máx. 4 copias).</p>');
      grid1();
    };

    const foot = document.createElement('div');
    foot.className = 'bFoot';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = '💾 Guardar';
    saveBtn.onclick = () => {
      spec.name = (spec.name ?? '').trim() || 'Mi mazo';
      const specs = loadSpecs();
      const i = specs.findIndex((x) => x.slug === spec.slug);
      if (i === -1) specs.push(spec); else specs[i] = spec;
      saveSpecs(specs);
      home();
    };
    const backBtn = document.createElement('button');
    backBtn.textContent = '↩ Volver';
    backBtn.onclick = home;
    foot.append(saveBtn, backBtn);
    dlg.appendChild(foot);

    modal.appendChild(dlg);
    paint();
    search.focus();
  };

  home();
}
