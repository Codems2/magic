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

  // Tapete con la disposición oficial de OPTCG. Para el oponente (arriba) se
  // invierte el orden de filas, de modo que las áreas de personajes de ambos
  // jugadores quedan enfrentadas en la línea de batalla central.
  renderSide(root, p, isOpp) {
    root.innerHTML = '';
    const mat = document.createElement('div');
    mat.className = 'mat' + (isOpp ? ' opp' : '');

    // Columna izquierda: pila de vidas.
    const leftCol = document.createElement('div');
    leftCol.className = 'matCol';
    leftCol.appendChild(this.pileEl('Vidas', p.life.length, 'life'));

    // Zona de personajes (la línea de batalla): siempre 5 huecos fijos.
    const chars = document.createElement('div');
    chars.className = 'zone charZone';
    chars.dataset.label = 'Área de personajes';
    for (let i = 0; i < 5; i++) {
      if (p.characters[i]) chars.appendChild(this.cardEl(p.characters[i], {}));
      else chars.appendChild(this.slotEl());
    }

    // Líder + escenario.
    const leaderRow = document.createElement('div');
    leaderRow.className = 'leaderRow';
    const leaderZone = document.createElement('div');
    leaderZone.className = 'zone leaderZone';
    leaderZone.dataset.label = 'Líder';
    leaderZone.appendChild(this.cardEl(p.leader, { leader: true }));
    const stageZone = document.createElement('div');
    stageZone.className = 'zone stageZone';
    stageZone.dataset.label = 'Escenario';
    if (p.stage) stageZone.appendChild(this.cardEl(p.stage, {}));
    else stageZone.appendChild(this.slotEl());
    // Barra de identidad, junto al líder.
    const nameBar = document.createElement('div');
    nameBar.className = 'nameBar';
    nameBar.innerHTML = `<b>${p.name}</b><span class="lifeBadge">❤ ${p.life.length}</span>
      <span class="handChip">✋ ${p.hand.length} · 📚 ${p.library.length}</span>`;
    leaderRow.append(leaderZone, stageZone, nameBar);

    // Área de coste: cartas DON!! en juego (activas / giradas).
    const cost = document.createElement('div');
    cost.className = 'zone costZone';
    cost.dataset.label = `Coste · DON!! ${p.donActive} activos / ${p.donRested} girados`;
    const totalDon = p.donActive + p.donRested;
    for (let i = 0; i < totalDon; i++) {
      const tok = document.createElement('div');
      tok.className = 'donTok' + (i >= p.donActive ? ' rested' : '');
      tok.textContent = 'DON';
      cost.appendChild(tok);
    }
    if (totalDon === 0) cost.appendChild(this.slotEl('sin DON!!'));

    // Columna central: personajes (línea de batalla) → líder → coste.
    const center = document.createElement('div');
    center.className = 'matCenter';
    center.append(chars, leaderRow, cost);

    // Columna derecha: mazo, mazo de DON!!, descarte.
    const rightCol = document.createElement('div');
    rightCol.className = 'matCol';
    rightCol.appendChild(this.pileEl('Mazo', p.library.length, 'deck'));
    rightCol.appendChild(this.pileEl('DON!!', p.donDeck, 'don'));
    rightCol.appendChild(this.pileEl('Descarte', p.trash.length, 'trash', null, p.trash[p.trash.length - 1]));

    mat.append(leftCol, center, rightCol);
    root.appendChild(mat);
  }

  slotEl(label = '') {
    const d = document.createElement('div');
    d.className = 'slot';
    if (label) d.textContent = label;
    return d;
  }

  pileEl(label, count, kind, area = null, topCard = null) {
    const d = document.createElement('div');
    d.className = `pile pile-${kind}`;
    if (area) d.style.gridArea = area;
    if (kind === 'trash' && topCard?.data.image && !failedImages.has(topCard.data.image)) {
      d.innerHTML = `<img src="${topCard.data.image}" alt="descarte">`;
    }
    d.innerHTML += `<span class="pileCount">${count}</span><span class="pileLabel">${label}</span>`;
    if (kind === 'trash' && topCard) {
      d.onmouseenter = () => this.showPreview(topCard);
      d.onmouseleave = () => { $('preview').innerHTML = ''; };
    }
    return d;
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
