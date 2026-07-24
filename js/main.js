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

async function loadDecks() {
  const index = await (await fetch('data/precons/index.json')).json();
  const decks = {};
  await Promise.all(index.map(async (d) => {
    decks[d.slug] = await (await fetch(`data/precons/${d.slug}.json`)).json();
  }));
  return { index, decks };
}

async function main() {
  const { index, decks } = await loadDecks();
  let selected = null;

  const list = $('deckList');
  list.innerHTML = '';
  for (const d of index) {
    const deck = decks[d.slug];
    const div = document.createElement('div');
    div.className = 'deck-card';
    const img = deck.commanders[0]?.image;
    div.innerHTML = `
      ${img ? `<img src="${img}" alt="${d.name}" loading="lazy">` : ''}
      <div class="dname">${d.name}</div>
      <div class="dtheme">${d.theme}</div>
      <div class="dcmd">⭐ ${d.commanders.join(' + ')}</div>`;
    div.onclick = () => {
      list.querySelectorAll('.deck-card').forEach((e) => e.classList.remove('selected'));
      div.classList.add('selected');
      selected = d.slug;
      $('startBtn').disabled = false;
    };
    list.appendChild(div);
  }

  $('startBtn').onclick = () => startGame(selected, decks, index);
}

async function startGame(mySlug, decks, index) {
  const nBots = parseInt($('botCount').value, 10);
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  // Mazos distintos para los bots.
  const others = index.map((d) => d.slug).filter((s) => s !== mySlug);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }

  const ui = new UI();
  const human = new HumanController(ui);
  const configs = [
    { name: 'Tú', deck: decks[mySlug], controller: human, isBot: false },
  ];
  for (let i = 0; i < nBots; i++) {
    const slug = others[i];
    configs.push({
      name: `${decks[slug].name} (Bot)`,
      deck: decks[slug],
      controller: watchableBot(`Bot${i + 1}`),
      isBot: true,
    });
  }
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
