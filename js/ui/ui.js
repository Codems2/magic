// Render del tablero 1v1 y mecanismo de selección por promesas.

const $ = (id) => document.getElementById(id);
const failedImages = new Set();
// Arte oficial de la carta DON!! (TCGCSV/tcgplayer, producto 672598). Si no
// carga, el CSS de .donTok (estallido dorado) queda como respaldo.
const DON_IMG = 'assets/don.jpg';
let donImgFailed = false;
const IS_TOUCH = window.matchMedia?.('(hover: none)').matches ?? false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UI {
  constructor(ctrl) {
    this.game = null;
    this.human = null;
    this.pickState = null;
    this.ctrl = ctrl ?? { speed: 1 }; // factor de velocidad compartido con el bot
  }

  bind(game, human) {
    this.game = game;
    this.human = human;
    $('log').innerHTML = '';
    const t = $('logToggle');
    if (t) t.onclick = () => document.body.classList.toggle('show-log');
    // El tablero SIEMPRE cabe en pantalla: re-escala al cambiar el viewport.
    if (!this._fitBound) {
      this._fitBound = true;
      window.addEventListener('resize', () => this.fitBoard());
      window.visualViewport?.addEventListener('resize', () => this.fitBoard());
    }
    // Selector de velocidad del bot.
    const sel = $('speedSel');
    if (sel) {
      sel.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          this.ctrl.speed = parseFloat(b.dataset.sp);
          sel.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        };
      });
    }
  }

  // Cartel grande y legible con lo que hace el rival (bot o humano remoto).
  async banner(ev) {
    const remoteRival = typeof ev.actorIdx === 'number' &&
      this.game?.youIdx !== undefined && ev.actorIdx !== this.game.youIdx;
    if (!ev.isBot && !remoteRival) return; // solo narramos las jugadas del rival
    const me = this.human?.player;
    const ICON = { play: '🃏', event: '🎴', ability: '✨', don: '🔶', attack: '⚔️' };
    let text;
    switch (ev.kind) {
      case 'play': text = `juega <b>${ev.card}</b>`; break;
      case 'event': text = `usa el evento <b>${ev.card}</b>`; break;
      case 'ability': text = `usa el efecto de <b>${ev.card}</b>`; break;
      case 'don': text = `da ${ev.n} DON!! a <b>${ev.card}</b>`; break;
      case 'attack': {
        const tgt = ev.targetIsLeader ? 'tu <b>Líder</b>' : `tu <b>${ev.targetName}</b>`;
        text = `ataca con <b>${ev.attacker}</b> a ${tgt}`;
        break;
      }
      default: return;
    }
    const el = $('banner');
    const token = (this._bannerToken = (this._bannerToken ?? 0) + 1);
    el.innerHTML = `<span class="bIcon">${ICON[ev.kind] ?? '🏴‍☠️'}</span>
      <span class="bText"><span class="bWho">El rival</span> ${text}</span>`;
    el.classList.remove('hidden');
    el.classList.add('show');
    // Duración proporcional a la velocidad elegida (más lento = más tiempo de lectura).
    const dur = Math.max(700, 1150 * this.ctrl.speed);
    await sleep(dur);
    if (this._bannerToken !== token) return; // otra jugada ya tomó el cartel
    el.classList.remove('show');
    await sleep(180);
    if (this._bannerToken === token) el.classList.add('hidden');
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
  chooseCards({ title, body = '', cardIds, selectableIds = null, max = 99, min = 0, confirmLabel = 'Confirmar', extra = null }) {
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
      const canPick = selectableIds ? new Set(selectableIds) : null;
      const chosen = new Set();
      const update = () => { if (extra) info.textContent = extra(chosen); };
      for (const id of cardIds) {
        const el = this.cardEl(this.game.byId(id), {});
        if (canPick && !canPick.has(id)) {
          el.classList.add('notSelectable');   // visible pero no elegible
        } else {
          el.classList.add('selectable');
          el.onclick = () => {
            if (chosen.has(id)) { chosen.delete(id); el.classList.remove('selected'); }
            else if (chosen.size < max) { chosen.add(id); el.classList.add('selected'); }
            update();
          };
        }
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
    if (!me || !me.leader) return;   // online: aún sin primera vista
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

    // Tras pintar, garantiza que TODO el tablero cabe en el viewport.
    if (!this._fitReq) {
      this._fitReq = requestAnimationFrame(() => {
        this._fitReq = null;
        this.fitBoard();
      });
    }
  }

  // Autoescalado del tablero: mide su tamaño natural y, si no cabe en el
  // hueco disponible (alto o ancho), lo encoge con transform: scale(). Así
  // la partida entera es visible sin scroll en cualquier dispositivo.
  fitBoard() {
    const t = $('table');
    if (!t || t.offsetParent === null) return;   // pantalla de juego oculta
    t.style.transform = 'none';
    const rect = t.getBoundingClientRect();
    const viewportH = window.visualViewport?.height ?? window.innerHeight;
    const availH = viewportH - rect.top - 2;
    const availW = t.parentElement?.clientWidth || window.innerWidth;
    const naturalH = t.scrollHeight;
    const naturalW = t.scrollWidth;
    if (naturalH <= 0 || availH <= 0) return;
    const s = Math.min(1, availH / naturalH, availW / Math.max(1, naturalW));
    if (s < 0.995) t.style.transform = `scale(${s.toFixed(4)})`;
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

    // Columna izquierda: pila de vidas (cartas reales boca abajo, apiladas).
    const leftCol = document.createElement('div');
    leftCol.className = 'matCol';
    leftCol.appendChild(this.lifeStack(p));

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
      if (!donImgFailed) {
        const im = document.createElement('img');
        im.src = DON_IMG; im.alt = 'DON!!'; im.loading = 'lazy';
        im.onerror = () => { donImgFailed = true; im.remove(); };
        tok.appendChild(im);
      }
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

  // Pila de vidas: cartas reales apiladas de arriba (i=0) a abajo. Las que
  // están boca arriba (mecánica del ST-36) muestran su arte: son públicas.
  lifeStack(p) {
    const wrap = document.createElement('div');
    wrap.className = 'lifeStack';
    const n = p.life.length;
    // Offline: p.life[i] es la carta (con .faceUp). Online: p.life.faces[i]
    // es la carta pública si esa posición está boca arriba, o null.
    const faceCard = (i) => {
      if (Array.isArray(p.life)) return p.life[i]?.faceUp ? p.life[i] : null;
      return p.life.faces?.[i] ?? null;
    };
    const anyUp = Array.from({ length: n }, (_, i) => faceCard(i)).some(Boolean);
    for (let i = 0; i < n; i++) {
      const up = faceCard(i);
      const card = document.createElement('div');
      if (up) {
        card.className = 'lifeCardBack lifeCardUp';
        const img = up.data?.image;
        if (img && !failedImages.has(img)) {
          card.innerHTML = `<img src="${img}" alt="${up.name}" loading="lazy">`;
          card.querySelector('img').onerror = (e) => {
            failedImages.add(img);
            e.target.remove();
            card.innerHTML = `<span class="lifeUpName">${up.name}</span>`;
          };
        } else {
          card.innerHTML = `<span class="lifeUpName">${up.name}</span>`;
        }
        card.title = `${up.name} (boca arriba)`;
        card.onmouseenter = () => this.showPreview(up);
        card.onmouseleave = () => { $('preview').innerHTML = ''; };
        card.onclick = () => this.showPreviewModal(up);
      } else {
        card.className = 'lifeCardBack';
      }
      card.style.top = `${i * (anyUp ? 14 : 9)}px`;
      card.style.zIndex = String(n - i);   // la superior (próxima en perderse) delante
      wrap.appendChild(card);
    }
    const badge = document.createElement('div');
    badge.className = 'lifeStackCount';
    badge.innerHTML = `<span>${n}</span><small>VIDAS</small>`;
    wrap.appendChild(badge);
    wrap.style.height = `${Math.max(92, 84 + (n - 1) * (anyUp ? 14 : 9))}px`;
    return wrap;
  }

  pileEl(label, count, kind, area = null, topCard = null) {
    const d = document.createElement('div');
    d.className = `pile pile-${kind}`;
    if (area) d.style.gridArea = area;
    if (kind === 'trash' && topCard?.data.image && !failedImages.has(topCard.data.image)) {
      d.innerHTML = `<img src="${topCard.data.image}" alt="descarte">`;
    }
    if (kind === 'don' && !donImgFailed) {
      d.innerHTML = `<img src="${DON_IMG}" alt="DON!!" loading="lazy" onerror="this.remove()">`;
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

  // Flecha de ataque con pausa, para poder seguir el combate.
  async animateAttack({ attackerId, targetId }) {
    const fx = $('fxLayer');
    const aEl = document.querySelector(`[data-cid="${attackerId}"]`);
    const tEl = document.querySelector(`[data-cid="${targetId}"]`);
    if (!aEl || !tEl || !fx) { await sleep(250); return; }

    aEl.classList.add('fx-attacker');
    tEl.classList.add('fx-target');

    const a = aEl.getBoundingClientRect();
    const t = tEl.getBoundingClientRect();
    const x1 = a.left + a.width / 2, y1 = a.top + a.height / 2;
    const x2 = t.left + t.width / 2, y2 = t.top + t.height / 2;
    fx.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
    fx.style.display = 'block';
    fx.innerHTML = `
      <defs>
        <marker id="ah" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6 Z" fill="#f5c542"/>
        </marker>
      </defs>
      <line x1="${x1}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="#f5c542" stroke-width="5"
            stroke-linecap="round" marker-end="url(#ah)" filter="drop-shadow(0 0 6px #e63946)">
        <animate attributeName="x2" to="${x2}" dur="0.28s" fill="freeze"/>
        <animate attributeName="y2" to="${y2}" dur="0.28s" fill="freeze"/>
      </line>`;

    await sleep(Math.max(500, 750 * this.ctrl.speed));
    fx.innerHTML = '';
    fx.style.display = 'none';
    aEl.classList.remove('fx-attacker');
    tEl.classList.remove('fx-target');
  }

  cardEl(card, { leader = false, hand = false }) {
    const div = document.createElement('div');
    if (!card) return div;
    div.className = 'card' + (leader ? ' leaderCard' : '') + (hand ? ' hand-card' : '');
    div.dataset.cid = card.id;
    div.dataset.color = (card.color || '').split(' ')[0].toLowerCase();
    if (card.rested) div.classList.add('rested');

    const img = card.data.image;
    const fallback = `<div class="noimg"><b>${card.name}</b><br><span class="noimg-type">${card.type}</span>${card.data.power != null ? `<br>${card.data.power}` : ''}</div>`;
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

    // Indicadores didácticos (solo tus cartas).
    const mine = card.owner === this.human?.player;
    const sc = card.script;
    if (mine && sc) {
      // ✨ Habilidad activable ahora mismo (hay que tocar la carta para usarla).
      if (card.zone !== 'hand' && this.human?.canActivate?.(this.game, card)) {
        div.innerHTML += `<span class="useB" title="Toca la carta y elige «Activar habilidad»">✨ USAR</span>`;
        div.classList.add('has-use');
      }
      // ⚠ Parte del texto de esta carta no está simulada.
      if (sc.unknown?.length) {
        div.innerHTML += `<span class="warnB" title="Parte del efecto de esta carta aún no está simulado">⚠</span>`;
      }
    }

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

  // Resumen en lenguaje llano de CUÁNDO actúa cada carta (para aprender).
  timingHint(card) {
    const WHEN = {
      onPlay: '▸ Al jugarla', whenAttacking: '▸ Al atacar con ella',
      activateMain: '▸ Tú la activas (tócala en tu turno)', main: '▸ Al jugar este evento',
      trigger: '▸ Si la pierdes como carta de Vida', counter: '▸ En defensa (paso de counter)',
      onBlock: '▸ Al bloquear con ella', endOfTurn: '▸ Al final de tu turno',
      onKO: '▸ Cuando la eliminan', static: '▸ Efecto continuo mientras esté en juego',
    };
    const abs = card.script?.abilities ?? [];
    const seen = new Set();
    const hints = [];
    for (const ab of abs) {
      if (!ab.ops.length && ab.when !== 'static') continue;
      if (seen.has(ab.when)) continue;
      seen.add(ab.when);
      let h = WHEN[ab.when];
      if (h && ab.donX) h += ` (dale ${ab.donX} DON!!)`;
      if (h) hints.push(h);
    }
    if (card.hasBlocker) hints.push('🛡 [Blocker]: puede desviar un ataque hacia ella');
    if (card.hasRush) hints.push('⚡ [Rush]: puede atacar el turno que entra');
    if (card.script?.unknown?.length) hints.push('⚠ Parte de su efecto aún no está simulado');
    return hints;
  }

  previewText(card) {
    const hints = this.timingHint(card);
    const hintBlock = hints.length ? `\n\n${hints.join('\n')}` : '';
    return `<div class="ptext"><b>${card.name}</b>  ${card.type} · coste ${card.cost ?? '—'} · ${card.data.power ?? '—'}\n${(card.data.subTypes ?? []).join(' / ')}\n\n${card.text || '(sin texto)'}<span class="hint">${hintBlock}</span></div>`;
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
