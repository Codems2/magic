// Render del tablero 1v1 y mecanismo de selección por promesas.

const $ = (id) => document.getElementById(id);
const failedImages = new Set();
const IS_TOUCH = window.matchMedia?.('(hover: none)').matches ?? false;

export class UI {
  constructor() {
    this.game = null;
    this.human = null;
    this.pickState = null;
  }

  bind(game, human) {
    this.game = game;
    this.human = human;
    $('log').innerHTML = '';
    const t = $('logToggle');
    if (t) t.onclick = () => document.body.classList.toggle('show-log');
  }

  logLine(msg) {
    const el = $('log');
    const div = document.createElement('div');
    if (msg.startsWith('—')) div.className = 'trn';
    div.textContent = msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ---- selección ---------------------------------------------------------

  pick({ cardIds = [], buttons = [], text = '' }) {
    return new Promise((resolve) => {
      this.pickState = { cards: new Set(cardIds), buttons, text, resolve };
      this.render();
    });
  }

  resolvePick(result) {
    const st = this.pickState;
    if (!st) return;
    this.pickState = null;
    st.resolve(result);
  }

  dialog({ title, body = '', cardIds = [], buttons }) {
    return new Promise((resolve) => {
      const ov = $('overlay');
      ov.classList.remove('hidden');
      const dlg = document.createElement('div');
      dlg.className = 'dialog';
      dlg.innerHTML = `<h2>${title}</h2>${body ? `<p>${body}</p>` : ''}`;
      if (cardIds.length) {
        const wrap = document.createElement('div');
        wrap.className = 'cards';
        for (const id of cardIds) wrap.appendChild(this.cardEl(this.game.byId(id), {}));
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

  // Diálogo de selección múltiple de cartas (mulligan-descartes-counters).
  chooseCards({ title, body = '', cardIds, max = 99, min = 0, confirmLabel = 'Confirmar', extra = null }) {
    return new Promise((resolve) => {
      const ov = $('overlay');
      ov.classList.remove('hidden');
      const dlg = document.createElement('div');
      dlg.className = 'dialog';
      dlg.innerHTML = `<h2>${title}</h2>${body ? `<p>${body}</p>` : ''}`;
      const info = document.createElement('div');
      info.className = 'counterTotal';
      dlg.appendChild(info);
      const wrap = document.createElement('div');
      wrap.className = 'cards';
      const chosen = new Set();
      const update = () => { if (extra) info.textContent = extra(chosen); };
      for (const id of cardIds) {
        const el = this.cardEl(this.game.byId(id), {});
        el.classList.add('selectable');
        el.onclick = () => {
          if (chosen.has(id)) { chosen.delete(id); el.classList.remove('selected'); }
          else if (chosen.size < max) { chosen.add(id); el.classList.add('selected'); }
          update();
        };
        wrap.appendChild(el);
      }
      update();
      dlg.appendChild(wrap);
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = confirmLabel;
      ok.onclick = () => {
        if (chosen.size < min) return;
        ov.classList.add('hidden'); ov.innerHTML = '';
        resolve([...chosen]);
      };
      dlg.appendChild(ok);
      ov.innerHTML = '';
      ov.appendChild(dlg);
    });
  }

  // ---- render ------------------------------------------------------------

  render() {
    const g = this.game;
    if (!g) return;
    const me = this.human.player;
    const opp = g.opponentOf(me);
    const PH = { setup: 'Preparación', refresh: 'Refresh', draw: 'Robo', don: 'DON!!', main: 'Principal', end: 'Final' };
    $('turnInfo').textContent = `Turno ${g.turn} · ${g.activePlayer?.name ?? ''} · ${PH[g.phase] ?? g.phase}`;
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

    this.renderSide($('oppArea'), opp, true);
    this.renderSide($('selfArea'), me, false);
    this.renderHand(me);
  }

  donText(p) {
    return `●${p.donActive} ◐${p.donRested} ▲${p.donGiven} · mazo ${p.donDeck}`;
  }

  renderSide(root, p, isOpp) {
    root.innerHTML = '';
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = `
      <b>${p.name}</b>
      <span class="lifeBadge">❤ ${p.life.length}</span>
      <span class="donView">DON ${this.donText(p)}</span>
      <span>✋ ${p.hand.length} · 📚 ${p.library.length} · 🗑 ${p.trash.length}</span>`;
    const row = document.createElement('div');
    row.className = 'playerRow';
    row.appendChild(this.cardEl(p.leader, { leader: true }));
    if (p.stage) row.appendChild(this.cardEl(p.stage, {}));
    const chars = document.createElement('div');
    chars.className = 'charRow';
    for (const c of p.characters) chars.appendChild(this.cardEl(c, {}));
    row.appendChild(chars);
    if (isOpp) { root.appendChild(stats); root.appendChild(row); }
    else { root.appendChild(row); root.appendChild(stats); }
  }

  renderHand(me) {
    const cont = $('hand');
    cont.innerHTML = '';
    for (const c of me.hand) cont.appendChild(this.cardEl(c, { hand: true }));
  }

  cardEl(card, { leader = false, hand = false }) {
    const div = document.createElement('div');
    if (!card) return div;
    div.className = 'card' + (leader ? ' leaderCard' : '') + (hand ? ' hand-card' : '');
    if (card.rested) div.classList.add('rested');

    const img = card.data.image;
    const fallback = `<div class="noimg"><b>${card.name}</b><br>${card.type} ${card.data.power ?? ''}</div>`;
    if (img && !failedImages.has(img)) div.innerHTML = `<img src="${img}" alt="${card.name}" loading="lazy">`;
    else div.innerHTML = fallback;

    if (card.cost !== null && card.cost !== undefined && !leader) {
      div.innerHTML += `<span class="costB">${card.cost}</span>`;
    }
    if (card.isCharacter || card.isLeader) {
      const p = card.power(this.game);
      const boosted = p !== (card.data.power ?? 0);
      if (card.zone !== 'hand') div.innerHTML += `<span class="pw${boosted ? ' boosted' : ''}">${p}</span>`;
      else div.innerHTML += `<span class="pw">${card.data.power ?? 0}</span>`;
    }
    if (card.givenDon > 0) div.innerHTML += `<span class="donB">+${card.givenDon}</span>`;
    if (hand && card.counterValue) div.innerHTML += `<span class="cntB">C${card.counterValue}</span>`;

    const imgEl = div.querySelector('img');
    if (imgEl) imgEl.onerror = () => { failedImages.add(img); imgEl.remove(); div.insertAdjacentHTML('afterbegin', fallback); };

    if (this.pickState?.cards.has(card.id)) {
      div.classList.add('selectable');
      div.onclick = () => this.resolvePick({ type: 'card', id: card.id });
    }

    if (IS_TOUCH) {
      let timer = null; let long = false;
      div.addEventListener('touchstart', () => {
        long = false;
        timer = setTimeout(() => { long = true; this.showPreviewModal(card); }, 450);
      }, { passive: true });
      div.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
      div.addEventListener('touchend', (e) => {
        clearTimeout(timer);
        if (long) { e.preventDefault(); return; }
        if (!div.classList.contains('selectable')) this.showPreviewModal(card);
      });
    } else {
      div.onmouseenter = () => this.showPreview(card);
      div.onmouseleave = () => { $('preview').innerHTML = ''; };
    }
    return div;
  }

  previewText(card) {
    return `<div class="ptext"><b>${card.name}</b>  ${card.type} · coste ${card.cost ?? '—'} · ${card.data.power ?? '—'}\n${(card.data.subTypes ?? []).join(' / ')}\n\n${card.text || '(sin texto)'}</div>`;
  }

  showPreview(card) {
    const pv = $('preview');
    const img = card.data.image;
    if (img && !failedImages.has(img)) {
      pv.innerHTML = `<img src="${img}" alt="${card.name}">`;
      pv.querySelector('img').onerror = () => { failedImages.add(img); pv.innerHTML = this.previewText(card); };
    } else pv.innerHTML = this.previewText(card);
  }

  showPreviewModal(card) {
    document.getElementById('previewModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'previewModal';
    const img = card.data.image;
    if (img && !failedImages.has(img)) {
      modal.innerHTML = `<img src="${img}" alt="${card.name}">`;
      modal.querySelector('img').onerror = () => { failedImages.add(img); modal.innerHTML = this.previewText(card); };
    } else modal.innerHTML = this.previewText(card);
    modal.onclick = () => modal.remove();
    document.body.appendChild(modal);
  }
}
