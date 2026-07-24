// Renderizado del tablero y mecanismo de selección (promesas resueltas por clics).

import { Player } from '../engine/game.js';

const $ = (id) => document.getElementById(id);

// URLs de imagen que fallaron (sin conexión a Scryfall): se muestra texto.
const failedImages = new Set();

export class UI {
  constructor() {
    this.game = null;
    this.human = null;
    this.pickState = null; // {cards:Set, players:Set, buttons:[], resolve}
    this.attackingIds = new Set();
    this.blockPairs = [];
  }

  bind(game, human) {
    this.game = game;
    this.human = human;
    $('log').innerHTML = '';
  }

  // ---- selección genérica ------------------------------------------------

  pick({ cards = [], players = [], buttons = [], text = '' }) {
    return new Promise((resolve) => {
      this.pickState = {
        cards: new Set(cards.map((c) => c.id)),
        players: new Set(players.map((p) => p.name)),
        buttons, text, resolve,
      };
      this.render();
    });
  }

  resolvePick(result) {
    const st = this.pickState;
    if (!st) return;
    this.pickState = null;
    st.resolve(result);
  }

  // Diálogo modal (mulligan, scry, fin de partida).
  dialog({ title, body = '', cards = [], buttons, perCardButtons = null }) {
    return new Promise((resolve) => {
      const ov = $('overlay');
      ov.classList.remove('hidden');
      const dlg = document.createElement('div');
      dlg.className = 'dialog';
      dlg.innerHTML = `<h2>${title}</h2>${body ? `<p>${body}</p>` : ''}`;
      if (cards.length) {
        const wrap = document.createElement('div');
        wrap.className = 'cards';
        for (const c of cards) {
          const el = this.cardEl(c, 'board-card');
          if (perCardButtons) {
            const cell = document.createElement('div');
            cell.appendChild(el);
            const btn = document.createElement('button');
            btn.textContent = perCardButtons.label(c);
            btn.onclick = () => { perCardButtons.onClick(c, btn); };
            cell.appendChild(btn);
            wrap.appendChild(cell);
          } else wrap.appendChild(el);
        }
        dlg.appendChild(wrap);
      }
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        if (b.primary) btn.classList.add('primary');
        btn.onclick = () => { ov.classList.add('hidden'); ov.innerHTML = ''; resolve(b.value); };
        dlg.appendChild(btn);
      }
      ov.innerHTML = '';
      ov.appendChild(dlg);
    });
  }

  // ---- log ---------------------------------------------------------------

  logLine(msg) {
    const el = $('log');
    const div = document.createElement('div');
    if (msg.startsWith('—')) div.className = 'trn';
    if (msg.startsWith('(!)') || msg.startsWith('☠')) div.className = 'warn';
    div.textContent = msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ---- render ------------------------------------------------------------

  render() {
    const g = this.game;
    if (!g) return;
    const phaseNames = {
      setup: 'Preparación', untap: 'Enderezar', upkeep: 'Mantenimiento', draw: 'Robo',
      main1: 'Principal 1', combat: 'Combate', main2: 'Principal 2', end: 'Final',
    };
    $('turnInfo').textContent = `Turno ${g.turn} · ${g.activePlayer?.name ?? ''} · ${phaseNames[g.phase] ?? g.phase}`;
    $('promptText').textContent = this.pickState?.text ?? '';

    const pb = $('promptButtons');
    pb.innerHTML = '';
    for (const b of this.pickState?.buttons ?? []) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.warn) btn.classList.add('warn');
      btn.onclick = () => this.resolvePick({ type: 'button', value: b.value });
      pb.appendChild(btn);
    }

    this.renderOpponents();
    this.renderPlayerBoard();
    this.renderPlayerBar();
    this.renderHand();
  }

  renderOpponents() {
    const g = this.game;
    const cont = $('opponents');
    cont.innerHTML = '';
    for (const p of g.players) {
      if (p === this.human.player) continue;
      const div = document.createElement('div');
      div.className = 'opp';
      if (p === g.activePlayer) div.classList.add('active-turn');
      if (!p.alive) div.classList.add('dead');
      if (this.pickState?.players.has(p.name)) {
        div.classList.add('selectable');
        div.onclick = () => this.resolvePick({ type: 'player', player: p });
      }
      const cmdDmg = [...p.commanderDamage.values()].reduce((a, b) => Math.max(a, b), 0);
      div.innerHTML = `
        <div class="phead">
          <span class="pname">${p.name}</span>
          <span class="plife">❤ ${p.life}</span>
          <span class="pmeta">✋ ${p.hand.length} · 📚 ${p.library.length}${cmdDmg ? ` · ⚔cmd ${cmdDmg}` : ''}</span>
        </div>`;
      const row = document.createElement('div');
      row.className = 'minirow';
      for (const c of p.command) row.appendChild(this.cardEl(c, 'mini', { badge: 'CMD' }));
      const lands = p.battlefield.filter((c) => c.isLand);
      if (lands.length) {
        const l = this.cardEl(lands[0], 'mini');
        const n = document.createElement('span');
        n.className = 'stack-count';
        n.textContent = `×${lands.length}`;
        l.appendChild(n);
        row.appendChild(l);
      }
      for (const c of p.battlefield.filter((c) => !c.isLand)) {
        row.appendChild(this.cardEl(c, 'board-card'));
      }
      div.appendChild(row);
      cont.appendChild(div);
    }
  }

  renderPlayerBoard() {
    const me = this.human.player;
    const cont = $('playerBoard');
    cont.innerHTML = '';
    const zones = [
      ['Zona de mando', me.command],
      ['Criaturas', me.battlefield.filter((c) => c.isCreature)],
      ['Otros permanentes', me.battlefield.filter((c) => !c.isCreature && !c.isLand)],
      ['Tierras', me.battlefield.filter((c) => c.isLand)],
    ];
    for (const [label, cards] of zones) {
      if (!cards.length && label !== 'Criaturas' && label !== 'Tierras') continue;
      const lab = document.createElement('div');
      lab.className = 'zone-label';
      lab.textContent = label;
      cont.appendChild(lab);
      const row = document.createElement('div');
      row.className = 'minirow';
      for (const c of cards) {
        row.appendChild(this.cardEl(c, 'board-card', { badge: c.isCommander ? 'CMD' : null }));
      }
      cont.appendChild(row);
    }
  }

  renderPlayerBar() {
    const me = this.human.player;
    const g = this.game;
    const cmdDmg = [...me.commanderDamage.values()].reduce((a, b) => Math.max(a, b), 0);
    $('playerBar').innerHTML = `
      <span class="pname">${me.name}</span>
      <span class="plife">❤ ${me.life}</span>
      <span class="pmeta">📚 Biblioteca: ${me.library.length} · 🪦 Cementerio: ${me.graveyard.length}${cmdDmg ? ` · ⚔ Daño de comandante: ${cmdDmg}` : ''}${me.lost ? ' · ☠ ELIMINADO (espectador)' : ''}</span>`;
  }

  renderHand() {
    const me = this.human.player;
    const cont = $('hand');
    cont.innerHTML = '';
    for (const c of me.hand) cont.appendChild(this.cardEl(c, 'hand-card'));
  }

  cardEl(card, sizeClass, { badge = null } = {}) {
    const g = this.game;
    const div = document.createElement('div');
    div.className = `card ${sizeClass}`;
    if (card.tapped) div.classList.add('tapped');
    if (card.attacking) div.classList.add('attacking');
    if (card.blocking) div.classList.add('blocking');
    if (this.attackingIds.has(card.id)) div.classList.add('selected');

    const img = sizeClass === 'hand-card' ? (card.data.image ?? card.data.imageSmall) : (card.data.imageSmall ?? card.data.image);
    const fallback = `<div class="noimg"><b>${card.name}</b><br>${card.data.manaCost ?? ''}</div>`;
    if (img && !failedImages.has(img)) {
      div.innerHTML = `<img src="${img}" alt="${card.name}" loading="lazy">`;
    } else {
      div.innerHTML = fallback;
    }
    if (badge) div.innerHTML += `<span class="badge">${badge}</span>`;
    if (card.isCreature && card.zone === 'battlefield') {
      const p = card.power(g); const t = card.toughness(g);
      const [bp, bt] = card.basePT();
      const buffed = p !== bp || t !== bt;
      div.innerHTML += `<span class="pt${buffed ? ' buffed' : ''}">${p}/${t - card.damage < t ? `${t}` : t}${card.damage ? `(-${card.damage})` : ''}</span>`;
    }

    if (this.pickState?.cards.has(card.id)) {
      div.classList.add('selectable');
      div.onclick = () => this.resolvePick({ type: 'card', card });
    }

    // El manejador se ata al final: cualquier `innerHTML +=` anterior recrearía
    // el <img> y perdería el onerror.
    const imgEl = div.querySelector('img');
    if (imgEl) imgEl.onerror = () => { failedImages.add(img); imgEl.remove(); div.insertAdjacentHTML('afterbegin', fallback); };

    div.onmouseenter = () => this.showPreview(card);
    div.onmouseleave = () => this.hidePreview();
    return div;
  }

  showPreview(card) {
    const pv = $('preview');
    const text = `<div class="ptext"><b>${card.name}</b>  ${card.data.manaCost ?? ''}\n${card.typeLine}\n\n${card.oracleText}</div>`;
    if (card.data.image) {
      pv.innerHTML = `<img src="${card.data.image}" alt="${card.name}">`;
      pv.querySelector('img').onerror = () => { pv.innerHTML = text; };
    } else {
      pv.innerHTML = text;
    }
  }
  hidePreview() { $('preview').innerHTML = ''; }
}
