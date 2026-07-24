// Arranque: pantalla de configuración y bucle de partida.

import { Game } from './engine/game.js';
import { BotController } from './ai/bot.js';
import { UI } from './ui/ui.js';
import { HumanController } from './ui/human.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bot con pequeñas pausas para que la partida se pueda seguir en pantalla.
function watchableBot(name, delay = 250) {
  const bot = new BotController(name);
  for (const method of ['mainAction', 'declareAttackers', 'declareBlockers']) {
    const orig = bot[method].bind(bot);
    bot[method] = async (...args) => { await sleep(delay); return orig(...args); };
  }
  return bot;
}

const loadDeck = (slug) => fetch(`data/precons/${slug}.json`).then((r) => r.json());

async function main() {
  const index = await (await fetch('data/precons/index.json')).json();
  let selected = null;

  const list = $('deckList');
  const renderList = (filter = '') => {
    const q = filter.trim().toLowerCase();
    const shown = !q ? index : index.filter((d) =>
      `${d.name} ${d.commanders.join(' ')} ${d.theme} ${d.setCode}`.toLowerCase().includes(q));
    $('deckCount').textContent = `${shown.length} de ${index.length} mazos`;
    list.innerHTML = '';
    for (const d of shown) {
      const div = document.createElement('div');
      div.className = 'deck-card';
      if (d.slug === selected) div.classList.add('selected');
      div.innerHTML = `
        ${d.image ? `<img src="${d.image}" alt="${d.name}" loading="lazy">` : ''}
        <div class="dname">${d.name}</div>
        <div class="dtheme">${d.theme}</div>
        <div class="dcmd">⭐ ${d.commanders.join(' + ')}</div>
        <div class="dset">${d.setCode} · ${d.releaseDate ?? ''}</div>`;
      div.onclick = () => {
        list.querySelectorAll('.deck-card').forEach((e) => e.classList.remove('selected'));
        div.classList.add('selected');
        selected = d.slug;
        $('startBtn').disabled = false;
      };
      list.appendChild(div);
    }
  };
  renderList();
  $('deckSearch').oninput = (e) => renderList(e.target.value);

  $('startBtn').onclick = () => { if (selected) startGame(selected, index); };
}

async function startGame(mySlug, index) {
  const nBots = parseInt($('botCount').value, 10);
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  // Mazos distintos al azar para los bots (solo se descargan los necesarios).
  const others = index.map((d) => d.slug).filter((s) => s !== mySlug);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const botSlugs = others.slice(0, nBots);
  const [myDeck, ...botDecks] = await Promise.all([mySlug, ...botSlugs].map(loadDeck));

  const ui = new UI();
  const human = new HumanController(ui);
  const configs = [
    { name: 'Tú', deck: myDeck, controller: human, isBot: false },
  ];
  botDecks.forEach((deck, i) => {
    configs.push({
      name: `${deck.name} (Bot)`,
      deck,
      controller: watchableBot(`Bot${i + 1}`),
      isBot: true,
    });
  });
  // Orden de turno aleatorio.
  for (let i = configs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [configs[i], configs[j]] = [configs[j], configs[i]];
  }

  const game = new Game(configs, {
    seed: (Math.random() * 2 ** 31) | 0,
    onLog: (msg) => { ui.logLine(msg); ui.render(); },
    maxTurns: 200,
  });
  ui.bind(game, human);
  ui.render();

  try {
    const winner = await game.run();
    await ui.dialog({
      title: winner === human.player ? '🏆 ¡Has ganado!' : 'Fin de la partida',
      body: `Gana ${winner?.name ?? 'nadie'}.`,
      buttons: [{ label: 'Nueva partida', value: 'again', primary: true }],
    });
    location.reload();
  } catch (err) {
    console.error(err);
    ui.logLine(`(!) Error del simulador: ${err.message}`);
  }
}

main();
