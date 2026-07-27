// Arranque: selección de mazos y bucle de partida.

import { Game } from './engine/game.js';
import { BotController } from './ai/bot.js';
import { UI } from './ui/ui.js';
import { HumanController } from './ui/human.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Control de ritmo compartido entre el bot y la UI (lo cambia el selector).
const ctrl = { speed: 1 };

// Bot con pausas escaladas por el selector de velocidad.
function watchableBot() {
  const bot = new BotController('Bot');
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
  const index = await (await fetch('data/decks/index.json', noCache)).json();
  const decks = {};
  await Promise.all(index.map(async (d) => {
    decks[d.slug] = await (await fetch(`data/decks/${d.slug}.json`, noCache)).json();
  }));

  let mySlug = null;
  let botSlug = null;
  const renderGrid = (rootId, onPick) => {
    const root = $(rootId);
    root.innerHTML = '';
    for (const d of index) {
      const div = document.createElement('div');
      div.className = 'deck-card';
      div.innerHTML = `
        <img src="${d.image}" alt="${d.name}" loading="lazy" onerror="this.style.display='none'">
        <div class="dname">${d.leader}</div>
        <div class="dcolor">${d.id} · ${d.color}</div>`;
      div.onclick = () => {
        root.querySelectorAll('.deck-card').forEach((e) => e.classList.remove('selected'));
        div.classList.add('selected');
        onPick(d.slug);
        if (mySlug && botSlug) $('startBtn').disabled = false;
      };
      root.appendChild(div);
    }
  };
  renderGrid('myDecks', (s) => { mySlug = s; });
  renderGrid('botDecks', (s) => { botSlug = s; });

  $('startBtn').onclick = () => startGame(decks[mySlug], decks[botSlug]);
  // Sandbox: no exige elegir mazos (usa ST-01/ST-02 si no marcaste ninguno).
  $('sandboxBtn').onclick = () => startGame(
    decks[mySlug ?? 'st-01'],
    decks[botSlug ?? 'st-02'],
    { sandbox: true, decks, index },
  );
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
    async discardFromHand(game, n) { return (this.player?.hand ?? []).slice(0, n).map((c) => c.id); },
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

async function startGame(myDeck, botDeck, sandboxOpts = null) {
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  const ui = new UI(ctrl);
  const human = new HumanController(ui);
  const sandbox = !!sandboxOpts;
  const configs = [
    { name: 'Tú', deck: myDeck, controller: human, isBot: false },
    {
      name: `${botDeck.leader.name} (${sandbox ? 'Rival de pruebas' : 'Bot'})`,
      deck: botDeck,
      controller: sandbox ? passiveRival() : watchableBot(),
      isBot: true,
    },
  ];
  // Quién empieza: al azar en partida normal; en sandbox siempre tú.
  if (!sandbox && Math.random() < 0.5) configs.reverse();

  const game = new Game(configs, {
    seed: (Math.random() * 2 ** 31) | 0,
    sandbox,
    onLog: (msg) => { ui.logLine(msg); ui.render(); },
    onAnimate: (ev) => (ev.type === 'attack' ? ui.animateAttack(ev) : Promise.resolve()),
    onNarrate: (ev) => ui.banner(ev),
  });
  ui.bind(game, human);

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
    const catalog = buildCatalog(sandboxOpts.decks, sandboxOpts.index);
    $('sandboxBar').classList.remove('hidden');
    $('sbAddCard').onclick = () => sandboxSearchModal(catalog, game, human, ui);
    $('sbDraw').onclick = () => { game.draw(human.player, 1); if (ui.pickState) human.player.hand.forEach((c) => ui.pickState.cards.add(c.id)); ui.render(); };
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
