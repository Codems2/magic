// Arranque: selección de mazos y bucle de partida.

import { Game } from './engine/game.js';
import { BotController } from './ai/bot.js';
import { HardBot } from './ai/hardbot.js';
import { SearchBot } from './ai/searchbot.js';
import { UI } from './ui/ui.js';
import { HumanController } from './ui/human.js';
import { Coach } from './ui/coach.js';
import { openDeckBuilder, loadSpecs, materializeDeck } from './ui/builder.js';
import { connectOnline } from './net/client.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Control de ritmo compartido entre el bot y la UI (lo cambia el selector).
const ctrl = { speed: 1 };

// ---- tapetes (persistentes en localStorage) --------------------------------
const MATS = [
  { id: 'altamar', name: '🌊 Alta mar' },
  { id: 'madera', name: '🪵 Cubierta' },
  { id: 'wanted', name: '📜 Se busca' },
  { id: 'marina', name: '⚓ Marina' },
  { id: 'grandline', name: '🌅 Grand Line' },
  { id: 'custom', name: '🖼 Tu imagen' },
];

function applyMat() {
  const mat = localStorage.getItem('opMat') ?? 'altamar';
  const url = localStorage.getItem('opMatUrl') ?? '';
  if (mat === 'altamar') delete document.body.dataset.mat;
  else document.body.dataset.mat = mat;
  document.body.style.setProperty('--matimg', url ? `url("${url}")` : 'none');
}

function openMatPicker() {
  document.getElementById('matModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'matModal';
  const dlg = document.createElement('div');
  dlg.className = 'dialog';
  dlg.innerHTML = '<h2>🎨 Elige tu tapete</h2><p>Se guarda en este navegador.</p>';
  const grid = document.createElement('div');
  grid.className = 'matGrid';
  const current = localStorage.getItem('opMat') ?? 'altamar';
  for (const m of MATS) {
    const sw = document.createElement('div');
    sw.className = 'matSwatch' + (m.id === current ? ' on' : '');
    sw.dataset.mat = m.id;
    sw.innerHTML = `<span>${m.name}</span>`;
    sw.onclick = () => {
      localStorage.setItem('opMat', m.id);
      grid.querySelectorAll('.matSwatch').forEach((x) => x.classList.toggle('on', x === sw));
      urlBox.classList.toggle('hidden', m.id !== 'custom');
      applyMat();
    };
    grid.appendChild(sw);
  }
  dlg.appendChild(grid);
  // Imagen propia: pega la URL de cualquier imagen que quieras usar de fondo.
  const urlBox = document.createElement('div');
  urlBox.classList.toggle('hidden', current !== 'custom');
  urlBox.innerHTML = '<p style="margin:0">Pega la URL de una imagen (tuya o de donde quieras):</p>';
  const input = document.createElement('input');
  input.id = 'matUrl';
  input.type = 'url';
  input.placeholder = 'https://…/mi-tapete.jpg';
  input.value = localStorage.getItem('opMatUrl') ?? '';
  input.oninput = () => { localStorage.setItem('opMatUrl', input.value.trim()); applyMat(); };
  urlBox.appendChild(input);
  dlg.appendChild(urlBox);
  const close = document.createElement('button');
  close.textContent = 'Listo';
  close.onclick = () => modal.remove();
  dlg.appendChild(close);
  modal.appendChild(dlg);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

// Bot con pausas escaladas por el selector de velocidad.
function watchableBot(level = 'search') {
  const bot = level === 'search' ? new SearchBot('Bot')
    : level === 'hard' ? new HardBot('Bot')
    : new BotController('Bot');
  const delays = { mainAction: 650, chooseBlocker: 600, counterStep: 600, triggerDecision: 500 };
  for (const [method, delay] of Object.entries(delays)) {
    const orig = bot[method].bind(bot);
    bot[method] = async (...args) => { await sleep(delay * ctrl.speed); return orig(...args); };
  }
  return bot;
}

// Evita servir datos cacheados por el navegador o la CDN tras una actualización.
const noCache = { cache: 'no-cache' };

async function main() {
  applyMat();
  document.getElementById('matBtnSetup').onclick = openMatPicker;
  document.getElementById('matBtn').onclick = openMatPicker;
  const index = await (await fetch('data/decks/index.json', noCache)).json();
  const decks = {};
  await Promise.all(index.map(async (d) => {
    decks[d.slug] = await (await fetch(`data/decks/${d.slug}.json`, noCache)).json();
  }));

  // --- catálogo completo (2700+ cartas) y mazos custom ---
  let catalogList = null;
  const getCatalog = async () => (catalogList ??= await (await fetch('data/cards/catalog.json', noCache)).json());
  let customDecks = [];
  const customEntries = () => customDecks.map((d) => ({
    slug: d.slug, id: 'CUSTOM', name: d.name, leader: d.leader.name,
    color: d.leader.color, image: d.leader.image, custom: true,
  }));
  const allIndex = () => [...index, ...customEntries()];
  const getDeck = (slug) => decks[slug] ?? customDecks.find((d) => d.slug === slug) ?? null;
  async function refreshCustoms() {
    const specs = loadSpecs();
    if (!specs.length) { customDecks = []; return; }
    const byId = new Map((await getCatalog()).map((c) => [c.id, c]));
    customDecks = specs.map((sp) => materializeDeck(sp, byId)).filter(Boolean);
  }
  await refreshCustoms();

  // --- selección de mazos: dos "huecos" compactos que abren un buscador ---
  let mySlug = null;
  let botSlug = null;
  const valid = (s) => allIndex().some((d) => d.slug === s);

  const updateSlot = (which) => {
    const slug = which === 'my' ? mySlug : botSlug;
    const el = $(which === 'my' ? 'slotMy' : 'slotBot');
    const d = allIndex().find((x) => x.slug === slug);
    if (!d) {
      el.innerHTML = '<span class="slotEmpty">➕<br>Elegir<br>mazo</span>';
    } else {
      el.innerHTML = `
        <img src="${d.image}" alt="${d.name}" loading="lazy" onerror="this.style.display='none'">
        <div class="slotName">${d.leader}</div>
        <div class="slotMeta">${d.id} · ${d.color}</div>`;
    }
    $('startBtn').disabled = !(mySlug && botSlug);
  };

  const pickDeck = (which, slug) => {
    if (which === 'my') { mySlug = slug; localStorage.setItem('opDeckMine', slug); }
    else { botSlug = slug; localStorage.setItem('opDeckBot', slug); }
    updateSlot(which);
  };

  // Modal buscador: escribe para filtrar y toca un color para acotar.
  const COLOR_ES = { Red: '🔴 Rojo', Green: '🟢 Verde', Blue: '🔵 Azul', Purple: '🟣 Morado', Black: '⚫ Negro', Yellow: '🟡 Amarillo' };
  const openDeckPicker = (which) => {
    document.getElementById('deckModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'deckModal';
    const dlg = document.createElement('div');
    dlg.className = 'dialog deckDialog';
    dlg.innerHTML = `<h2>${which === 'my' ? '⚓ Tu mazo' : '🤖 Mazo del bot'}</h2>`;
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'sbSearch';
    search.placeholder = 'Busca por líder, ID o set (p. ej. "Kid", "ST-36")…';
    dlg.appendChild(search);
    const chips = document.createElement('div');
    chips.className = 'colorChips';
    let colorSel = null;
    for (const [en, label] of [['*', '✳ Todos'], ...Object.entries(COLOR_ES)]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = en === '*' ? 'on' : '';
      b.onclick = () => {
        colorSel = en === '*' ? null : en;
        chips.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        refresh();
      };
      chips.appendChild(b);
    }
    dlg.appendChild(chips);
    const grid = document.createElement('div');
    grid.className = 'deck-grid compact';
    dlg.appendChild(grid);
    const close = document.createElement('button');
    close.textContent = 'Cerrar';
    close.onclick = () => modal.remove();
    dlg.appendChild(close);

    const current = which === 'my' ? mySlug : botSlug;
    const refresh = () => {
      const q = search.value.trim().toLowerCase();
      grid.innerHTML = '';
      const hits = allIndex().filter((d) =>
        (!colorSel || (d.color ?? '').includes(colorSel)) &&
        (!q || d.leader.toLowerCase().includes(q) || d.name.toLowerCase().includes(q) ||
          d.id.toLowerCase().includes(q) || d.slug.includes(q)));
      for (const d of hits) {
        const div = document.createElement('div');
        div.className = 'deck-card' + (d.slug === current ? ' selected' : '');
        div.innerHTML = `
          <img src="${d.image}" alt="${d.name}" loading="lazy" onerror="this.style.display='none'">
          <div class="dname">${d.leader}</div>
          <div class="dcolor">${d.id} · ${d.color}</div>`;
        div.onclick = () => { pickDeck(which, d.slug); modal.remove(); };
        grid.appendChild(div);
      }
      if (!hits.length) grid.innerHTML = '<p class="noHits">Sin resultados: prueba otro nombre o quita el filtro de color.</p>';
    };
    search.oninput = refresh;
    refresh();
    modal.appendChild(dlg);
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
    search.focus();
  };

  $('slotMy').onclick = () => openDeckPicker('my');
  $('slotBot').onclick = () => openDeckPicker('bot');
  $('botRandom').onclick = () => { const list = allIndex(); pickDeck('bot', list[(Math.random() * list.length) | 0].slug); };
  $('botMirror').onclick = () => { if (mySlug) pickDeck('bot', mySlug); };

  // Recuerda los últimos mazos usados: en la segunda visita, un clic y a jugar.
  const savedMine = localStorage.getItem('opDeckMine');
  const savedBot = localStorage.getItem('opDeckBot');
  if (valid(savedMine)) mySlug = savedMine;
  if (valid(savedBot)) botSlug = savedBot;
  updateSlot('my');
  updateSlot('bot');

  // Nivel del bot (persistente): 🏆 Competitivo por defecto.
  const savedLevel = localStorage.getItem('opBotLevel') ?? 'search';
  document.querySelectorAll('input[name="botLevel"]').forEach((r) => {
    r.checked = r.value === savedLevel;
    r.onchange = () => localStorage.setItem('opBotLevel', r.value);
  });
  const botLevel = () => document.querySelector('input[name="botLevel"]:checked')?.value ?? 'search';

  const deckSizeOf = (d) => d.cards.reduce((n, c) => n + c.count, 0);
  $('startBtn').onclick = () => {
    const my = getDeck(mySlug);
    const bd = getDeck(botSlug);
    const bad = [my, bd].find((d) => d?.custom && deckSizeOf(d) !== 50);
    if (!my || !bd) return;
    if (bad) { $('onStatus').textContent = `⚠ "${bad.name}" no es legal: necesita exactamente 50 cartas (tiene ${deckSizeOf(bad)}).`; return; }
    startGame(my, bd, null, botLevel());
  };

  // Constructor de mazos custom.
  $('builderBtn').onclick = async () => openDeckBuilder({
    catalog: await getCatalog(),
    onChanged: async () => {
      await refreshCustoms();
      if (mySlug && !getDeck(mySlug)) mySlug = null;
      if (botSlug && !getDeck(botSlug)) botSlug = null;
      updateSlot('my'); updateSlot('bot');
    },
  });
  // Sandbox: no exige elegir mazos (usa ST-01/ST-02 si no marcaste ninguno).
  $('sandboxBtn').onclick = async () => startGame(
    getDeck(mySlug) ?? decks['st-01'],
    getDeck(botSlug) ?? decks['st-02'],
    { sandbox: true, decks, index, catalogList: await getCatalog() },
  );

  // --- lobby online ---
  const nameBox = $('onName');
  const serverBox = $('onServer');
  nameBox.value = localStorage.getItem('opName') ?? '';
  serverBox.value = localStorage.getItem('opServer') ?? '';
  nameBox.oninput = () => localStorage.setItem('opName', nameBox.value.trim());
  serverBox.oninput = () => localStorage.setItem('opServer', serverBox.value.trim());
  // Normaliza lo que escriba el usuario a un ws://host o wss://host válido, y
  // ajusta el esquema al de la página (HTTPS exige wss://; HTTP admite ws://).
  const normalizeServerUrl = (raw) => {
    let s = (raw ?? '').trim();
    const pageSecure = location.protocol === 'https:';
    if (!s) {
      // Por defecto: el MISMO origen que sirve la página. Si desplegaste el
      // servidor unificado, esto ya funciona sin tocar nada. (file:// no vale.)
      if (location.host) return { url: `${pageSecure ? 'wss' : 'ws'}://${location.host}` };
      return { error: 'Abre el juego desde el servidor (una URL http/https), no como archivo local.' };
    }
    // Admite pegar http(s):// o una URL sin esquema.
    s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!/^wss?:\/\//i.test(s)) s = (pageSecure ? 'wss://' : 'ws://') + s;
    // Mixed content: página HTTPS + ws:// → el navegador lo bloquea.
    if (pageSecure && /^ws:\/\//i.test(s)) {
      if (/localhost|127\.0\.0\.1/i.test(s)) {
        return { error: 'Estás en HTTPS: el navegador bloquea servidores locales (ws://). Abre el juego por http://localhost para probar en local, o despliega el servidor con wss://.' };
      }
      s = s.replace(/^ws:\/\//i, 'wss://');   // fuerza wss:// en producción
    }
    try { new URL(s); } catch { return { error: 'La URL del servidor no es válida.' }; }
    return { url: s };
  };
  const startNet = (mode) => {
    const { url, error } = normalizeServerUrl(serverBox.value);
    if (error) { $('onStatus').textContent = `⚠ ${error}`; return; }
    const spec = loadSpecs().find((x) => x.slug === mySlug) ?? null;
    const my = getDeck(mySlug);
    if (my?.custom && deckSizeOf(my) !== 50) { $('onStatus').textContent = `⚠ "${my.name}" no es legal para jugar online (50 cartas exactas).`; return; }
    startOnline({
      url, mode,
      code: $('onCode').value.trim().toUpperCase(),
      name: nameBox.value.trim() || 'Pirata',
      deckSlug: mySlug ?? 'st-01',
      deckSpec: spec ? { name: spec.name, leader: spec.leader, cards: spec.cards } : null,
    });
  };
  $('onCreate').onclick = () => startNet('create');
  $('onJoin').onclick = () => {
    if ($('onCode').value.trim().length !== 4) { $('onStatus').textContent = 'El código tiene 4 letras.'; return; }
    startNet('join');
  };
}

// Sala de espera: overlay con el código EN GRANDE hasta que entra el rival.
function showLobbyWait({ connecting = false, code = null, seat = 0, onCancel }) {
  const ov = $('overlay');
  ov.classList.remove('hidden');
  ov.innerHTML = '';
  const dlg = document.createElement('div');
  dlg.className = 'dialog';
  if (connecting) {
    dlg.innerHTML = '<h2>🌐 Conectando…</h2><p>Contactando con el servidor.</p>';
  } else if (code) {
    dlg.innerHTML = `
      <h2>⚓ Sala creada</h2>
      <p>Comparte este código con tu rival:</p>
      <div class="roomCode" id="roomCode">${code}</div>
      <p class="waitDots">Esperando a que se una tu rival…</p>`;
    const copy = document.createElement('button');
    copy.className = 'primary';
    copy.textContent = '📋 Copiar código';
    copy.onclick = () => {
      navigator.clipboard?.writeText(code).catch(() => {});
      copy.textContent = '✓ Copiado';
      setTimeout(() => { copy.textContent = '📋 Copiar código'; }, 1500);
    };
    dlg.appendChild(copy);
  }
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancelar';
  cancel.onclick = () => { onCancel?.(); location.reload(); };
  dlg.appendChild(cancel);
  ov.appendChild(dlg);
}

// Partida online: la UI de siempre, pero el estado llega del servidor.
function startOnline({ url, mode, code, name, deckSlug, deckSpec = null }) {
  const ui = new UI(ctrl);
  const human = new HumanController(ui);
  if (deckSlug === 'st-36') human.coach = new Coach(human);
  let started = false;

  showLobbyWait({ connecting: true, onCancel: () => conn?.close?.() });

  const conn = connectOnline({
    url, mode, code, name, deckSlug, deckSpec, human, ui,
    onCode: (roomCode, seat) => {
      // El que crea la sala ve el código y espera; el que se une, "conectando".
      if (mode === 'create') showLobbyWait({ code: roomCode, seat, onCancel: () => conn.close() });
      else showLobbyWait({ connecting: true, onCancel: () => conn.close() });
    },
    onStatus: (msg) => ui.logLine(`🌐 ${msg}`),
    onFirstView: () => {
      // Rival dentro: cerramos la sala de espera y mostramos el tablero.
      if (started) return;
      started = true;
      $('overlay').classList.add('hidden');
      $('overlay').innerHTML = '';
      $('setup').classList.add('hidden');
      $('game').classList.remove('hidden');
      ui.render();
    },
    onEnd: async (m, mySeat) => {
      const won = m.winnerSeat === mySeat;
      await ui.dialog({
        title: won ? '🏆 ¡Victoria!' : '☠ Derrota',
        body: m.reason || '',
        buttons: [{ label: 'Volver al puerto', value: true, primary: true }],
      });
      location.reload();
    },
    onError: (info) => {
      $('overlay').classList.add('hidden'); $('overlay').innerHTML = '';
      if (started) return;   // ya en partida: un corte se maneja aparte
      $('setup').classList.remove('hidden');
      $('game').classList.add('hidden');
      const saved = (localStorage.getItem('opServer') ?? '').trim();
      if (info && info.kind === 'noconnect') {
        const body = `No hay ningún servidor de salas en <b>${info.url}</b>.` +
          (saved
            ? ' Esa dirección la escribiste tú en el campo "Servidor". Si es antigua o de prueba, bórrala.'
            : ' Aún no has desplegado el servidor: mira el README (Render, 1 clic) o ejecútalo en local.');
        const buttons = [{ label: 'Entendido', value: 'ok', primary: true }];
        if (saved) buttons.unshift({ label: '🗑 Borrar dirección guardada', value: 'clear' });
        ui.dialog({ title: '🌐 Sin servidor', body, buttons }).then((v) => {
          if (v === 'clear') { localStorage.removeItem('opServer'); $('onServer').value = ''; }
          $('onStatus').textContent = saved
            ? 'Campo "Servidor" vacío: se usará este mismo sitio (necesita el servidor unificado).'
            : '';
        });
      } else {
        $('onStatus').textContent = `⚠ ${typeof info === 'string' ? info : 'Error de conexión.'}`;
      }
    },
  });
  ui.bind(conn.cg, human);
}

// Catálogo global de cartas únicas (para el buscador del sandbox).
function buildCatalog(decks, index) {
  const seen = new Map();
  for (const d of index) {
    const deck = decks[d.slug];
    for (const c of [deck.leader, ...(deck.altLeaders ?? []), ...deck.cards]) {
      if (c && !seen.has(c.id)) seen.set(c.id, c);
    }
  }
  return [...seen.values()];
}

// Rival del sandbox: no hace nada (tú controlas el ritmo de la prueba).
function passiveRival() {
  return {
    player: null,
    async mulligan() { return false; },
    async mainAction() { return { type: 'pass' }; },
    async chooseTarget(game, { candidateIds }) { return candidateIds[0] ?? null; },
    async chooseBlocker() { return null; },
    async counterStep() { return { discardIds: [], eventIds: [] }; },
    async discardFromHand(game, n, opts = {}) {
      const pool = opts.fromIds ?? (this.player?.hand ?? []).map((c) => c.id);
      return pool.slice(0, opts.min ?? n);
    },
    async triggerDecision() { return false; },
    async payOptionalCost() { return true; },
    async chooseOption() { return 0; },
    async chooseRevealed(game, { pickableIds, max = 1 }) { return pickableIds.slice(0, max); },
  };
}

// Buscador del sandbox: filtra el catálogo y añade la carta elegida a tu mano.
function sandboxSearchModal(catalog, game, human, ui) {
  const ov = $('overlay');
  ov.classList.remove('hidden');
  const dlg = document.createElement('div');
  dlg.className = 'dialog';
  dlg.innerHTML = '<h2>🧪 Añadir carta a tu mano</h2><p>Busca por nombre, ID o tipo (p. ej. "Zoro", "ST13", "Event").</p>';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Escribe para buscar…';
  input.className = 'sbSearch';
  dlg.appendChild(input);
  const grid = document.createElement('div');
  grid.className = 'cards';
  dlg.appendChild(grid);
  const close = document.createElement('button');
  close.textContent = 'Cerrar';
  close.onclick = () => { ov.classList.add('hidden'); ov.innerHTML = ''; };
  dlg.appendChild(close);

  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    grid.innerHTML = '';
    const hits = !q ? [] : catalog.filter((c) =>
      c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) ||
      (c.type ?? '').toLowerCase() === q ||
      (c.subTypes ?? []).some((s) => s.toLowerCase().includes(q))).slice(0, 24);
    for (const data of hits) {
      const div = document.createElement('div');
      div.className = 'card selectable';
      div.innerHTML = `<img src="${data.image}" alt="" loading="lazy" onerror="this.remove()">
        <span class="nm">${data.name}</span><span class="pw">${data.power ?? data.type}</span>`;
      div.title = `${data.id} · ${data.type} · ${data.text ?? ''}`;
      div.onclick = () => {
        const c = game.addCardToHand(human.player, data);
        // Si hay una selección en curso, la nueva carta entra como elegible ya.
        if (ui.pickState) ui.pickState.cards.add(c.id);
        ui.render();
      };
      grid.appendChild(div);
    }
  };
  input.oninput = refresh;
  ov.innerHTML = '';
  ov.appendChild(dlg);
  input.focus();
}

// Piedra, papel o tijera contra el bot; el ganador elige el orden.
// Devuelve 'first' si el humano empieza, 'second' si empieza el bot.
async function rpsChooseOrder(ui) {
  const OPTS = ['✊ Piedra', '✋ Papel', '✌ Tijera'];
  while (true) {
    const me = await ui.dialog({
      title: '✊✋✌ Piedra, papel o tijera',
      body: 'Como en el juego real: el ganador elige quién va primero.',
      buttons: OPTS.map((label, i) => ({ label, value: i })),
    });
    const bot = (Math.random() * 3) | 0;
    if (bot === me) {
      await ui.dialog({ title: `Empate: ${OPTS[me]} contra ${OPTS[bot]}`, body: 'Otra vez…', buttons: [{ label: 'Repetir', value: true, primary: true }] });
      continue;
    }
    const win = (me === 0 && bot === 2) || (me === 1 && bot === 0) || (me === 2 && bot === 1);
    if (win) {
      const first = await ui.dialog({
        title: `🏆 ¡Ganaste! ${OPTS[me]} contra ${OPTS[bot]}`,
        body: 'Tú eliges. Recuerda: el PRIMERO no roba, coloca 1 DON!! y no puede atacar en su primer turno; el SEGUNDO roba, coloca 2 DON!! y sí puede atacar.',
        buttons: [{ label: '🥇 Empiezo yo', value: true, primary: true }, { label: '🥈 Empieza el bot', value: false }],
      });
      return first ? 'first' : 'second';
    }
    await ui.dialog({
      title: `☠ Perdiste: ${OPTS[me]} contra ${OPTS[bot]}`,
      body: 'El bot elige empezar PRIMERO.',
      buttons: [{ label: 'Vale', value: true, primary: true }],
    });
    return 'second';
  }
}

async function startGame(myDeck, botDeck, sandboxOpts = null, level = 'search') {
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  const ui = new UI(ctrl);
  const human = new HumanController(ui);
  // Coach del ST-36: consejos en cada decisión cuando juegas el mazo de Kid.
  if (myDeck.slug === 'st-36') human.coach = new Coach(human);
  const sandbox = !!sandboxOpts;
  const configs = [
    { name: 'Tú', deck: myDeck, controller: human, isBot: false },
    {
      name: `${botDeck.leader.name} (${sandbox ? 'Rival de pruebas' : level === 'search' ? 'Bot 🧠' : level === 'hard' ? 'Bot 🏆' : 'Bot'})`,
      deck: botDeck,
      controller: sandbox ? passiveRival() : watchableBot(level),
      isBot: true,
    },
  ];
  // Quién empieza: piedra-papel-tijera (el ganador elige); en sandbox, tú.
  if (!sandbox && (await rpsChooseOrder(ui)) === 'second') configs.reverse();

  const game = new Game(configs, {
    seed: (Math.random() * 2 ** 31) | 0,
    sandbox,
    onLog: (msg) => { ui.logLine(msg); ui.render(); },
    onAnimate: (ev) => (ev.type === 'attack' ? ui.animateAttack(ev) : Promise.resolve()),
    onNarrate: (ev) => ui.banner(ev),
  });
  ui.bind(game, human);
  // Ayuda de depuración (consola y tests de navegador).
  window._game = game; window._ui = ui;

  if (sandbox) {
    // Tablero rival poblado (objetivos girados y sin girar) y herramientas.
    const origStart = game.start.bind(game);
    game.start = async () => {
      await origStart();
      const rival = game.players.find((p) => p !== human.player);
      let moved = 0;
      for (let i = rival.library.length - 1; i >= 0 && moved < 3; i--) {
        const c = rival.library[i];
        if (!c.isCharacter) continue;
        rival.library.splice(i, 1);
        c.zone = 'characters'; c.enteredTurn = 0; c.summonedThisTurn = false;
        c.rested = moved < 2;
        rival.characters.push(c);
        moved++;
      }
      rival.donActive = 5;
      game.log('🧪 Sandbox: rival pasivo con tablero poblado. Usa ➕ Carta para probar lo que quieras.');
    };
    const catalog = sandboxOpts.catalogList ?? buildCatalog(sandboxOpts.decks, sandboxOpts.index);
    $('sandboxBar').classList.remove('hidden');
    $('sbAddCard').onclick = () => sandboxSearchModal(catalog, game, human, ui);
    $('sbDraw').onclick = () => { game.draw(human.player, 1); if (ui.pickState) human.player.hand.forEach((c) => ui.pickState.cards.add(c.id)); ui.render(); };
    // El RIVAL roba: para probar efectos que miran/descartan/devuelven su mano.
    $('sbOppDraw').onclick = () => {
      const rival = game.players.find((p) => p !== human.player);
      game.draw(rival, 1);
      game.log(`🧪 El rival roba 1 (mano: ${rival.hand.length}).`);
      ui.render();
    };
    $('sbDon').onclick = () => { human.player.donActive += 2; ui.render(); };
    $('sbLife').onclick = () => {
      const p = human.player;
      if (p.library.length) { const c = p.library.shift(); c.zone = 'life'; p.life.unshift(c); game.log(`🧪 +1 Vida (${p.life.length}).`); }
      ui.render();
    };
  }

  ui.render();

  try {
    const winner = await game.run();
    await ui.dialog({
      title: winner === human.player ? '🏆 ¡Victoria!' : '☠ Derrota',
      body: `Gana ${winner?.name ?? 'nadie'}.`,
      buttons: [{ label: 'Nueva partida', value: true, primary: true }],
    });
    location.reload();
  } catch (err) {
    console.error(err);
    ui.logLine(`(!) Error del simulador: ${err.message}`);
  }
}

main();
