// Arranque: selección de mazos y bucle de partida.

import { Game } from './engine/game.js';
import { BotController } from './ai/bot.js';
import { UI } from './ui/ui.js';
import { HumanController } from './ui/human.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bot con pausas para que la partida se pueda seguir.
function watchableBot(delay = 350) {
  const bot = new BotController('Bot');
  for (const method of ['mainAction', 'chooseBlocker', 'counterStep']) {
    const orig = bot[method].bind(bot);
    bot[method] = async (...args) => { await sleep(delay); return orig(...args); };
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
}

async function startGame(myDeck, botDeck) {
  $('setup').classList.add('hidden');
  $('game').classList.remove('hidden');

  const ui = new UI();
  const human = new HumanController(ui);
  const configs = [
    { name: 'Tú', deck: myDeck, controller: human, isBot: false },
    { name: `${botDeck.leader.name} (Bot)`, deck: botDeck, controller: watchableBot(), isBot: true },
  ];
  // Quién empieza, al azar.
  if (Math.random() < 0.5) configs.reverse();

  const game = new Game(configs, {
    seed: (Math.random() * 2 ** 31) | 0,
    onLog: (msg) => { ui.logLine(msg); ui.render(); },
  });
  ui.bind(game, human);
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
