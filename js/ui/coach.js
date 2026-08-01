// Coach del ST-36 (Eustass"Captain"Kid). Mira la partida con los mismos ojos
// que el bot (heurísticas de ai/bot.js) y traduce cada decisión a un consejo
// razonado en español: mulligan, plan del turno, bloqueos, counters, triggers
// y costes opcionales. Funciona offline y online (ClientGame) y también sin
// DOM (los tests headless leen `lastPlan` y los textos devueltos).

import { BotController } from '../ai/bot.js';
import { abilitiesOf } from '../engine/effects.js';

// Conocimiento carta a carta del mazo: [prioridad extra, por qué es buena].
const PRIORITY = {
  'ST36-002': [3.0, 'te regala +1 Vida al jugarlo en tu turno'],
  'P-085': [2.5, 'tu único "removal": mete un personaje rival (coste ≤4) en su Vida'],
  'ST36-005': [2.5, 'muro de 7000 con redirect que protege al líder'],
  'OP10-101': [2.0, '7000 planos: el mejor cuerpo para el combo del líder'],
  'P-088': [1.5, 'cuerpo de 5000 con counter 2000 y [Trigger] que lo juega gratis'],
  'OP10-109': [1.2, 'al morir quema 1 Vida del rival'],
  'OP12-113': [1.2, 'al morir deja otro Supernovas de coste ≤4 en juego'],
  'OP10-114': [1.0, 'gira personajes rivales de coste ≤4 (prepara tus KO)'],
  'ST36-001': [0.8, 'muro barato que convierte 1 carta en +1 Vida al morir'],
  'ST36-003': [0.5, 'su [Trigger] roba y pone tu líder a 7000'],
  'ST36-004': [0.5, 'motor de robo: 1 carta sobrante → 2 nuevas'],
  'OP10-111': [0.5, 'buscador: rellena la mano con lo que te falte'],
  'OP10-103': [0.5, 'coloca un [Trigger] de tu mano en tu Vida'],
};

const SEARCHERS = new Set(['OP10-111', 'OP13-116', 'ST36-004']);
const isSupernova = (c) => (c?.data?.subTypes ?? []).some((s) => /Supernovas/.test(s));
const pow = (c, game) => (typeof c?.power === 'function' ? c.power(game) : 0) ?? 0;

export class Coach {
  constructor(human) {
    this.human = human;
    this.bot = new BotController('Coach');
    this.lastPlan = [];   // [{title, lines[]}] — la fuente del panel y de los tests
    this.el = null;
    this.mount();
  }

  // El bot sombra siempre "es" el jugador humano.
  sync(game) {
    this.bot.player = this.human.player;
    return this.human.player;
  }

  // ---- panel lateral -------------------------------------------------------

  mount() {
    if (typeof document === 'undefined') return;
    document.getElementById('coach')?.remove();
    const el = document.createElement('aside');
    el.id = 'coach';
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('opCoachMin') : null;
    const min = saved === '1' || (saved === null && window.innerWidth < 1100);
    if (min) el.classList.add('min');
    el.innerHTML = `<header><span>🧭 Coach ST-36</span><button type="button">${min ? '▸' : '▾'}</button></header><div class="coachBody"></div>`;
    el.querySelector('header').onclick = () => {
      const isMin = el.classList.toggle('min');
      try { localStorage.setItem('opCoachMin', isMin ? '1' : '0'); } catch { /* privado */ }
      el.querySelector('header button').textContent = isMin ? '▸' : '▾';
    };
    document.body.appendChild(el);
    this.el = el;
  }

  renderPanel() {
    if (!this.el) return;
    this.el.querySelector('.coachBody').innerHTML = this.lastPlan.map((s) =>
      `<section><h3>${s.title}</h3>${s.lines.map((l) => `<div class="cLine">${l}</div>`).join('')}</section>`
    ).join('');
  }

  // Recalcula el plan completo (se llama en cada vuelta de tu fase principal).
  updatePanel(game) {
    const p = this.sync(game);
    if (!p?.leader) return;
    const opp = game.opponentOf(p);
    const secs = [
      { title: '📊 Situación', lines: this.situation(game, p, opp) },
      { title: '🎯 Plan del turno', lines: this.plan(game, p, opp) },
    ];
    const w = this.warnings(game, p, opp);
    if (w.length) secs.push({ title: '⚠ Vigila', lines: w });
    this.lastPlan = secs;
    this.renderPanel();
  }

  situation(game, p, opp) {
    const board = (q) => (q.characters ?? []).reduce((n, c) => n + pow(c, game), 0);
    const lines = [
      `❤ Vidas <b>${p.life.length}</b>–${opp.life.length} · ✋ mano <b>${p.hand.length ?? 0}</b>–${opp.hand.length ?? 0} · tablero ${board(p)}–${board(opp)}`,
    ];
    const race = this.bot.raceScore(game);
    if (race > 1500) lines.push('Vas <b>ganando la carrera</b>: sigue presionando al líder rival; no gastes counters en golpes pequeños.');
    else if (race < -1500) lines.push('Vas <b>detrás</b>: estabiliza — combo del líder cada turno, muros (Urouge, Kid) y deja que tus [Trigger] trabajen.');
    else lines.push('Carrera <b>igualada</b>: deciden los intercambios eficientes. No regales cartas defendiendo golpes baratos.');
    return lines;
  }

  // Recomendaciones ordenadas de la fase principal.
  plan(game, p, opp) {
    const lines = [];
    if (game.activePlayer !== p) {
      lines.push('Turno del rival: decide bloqueos y counters con calma. Regla de oro: <b>el empate lo gana el atacante</b>.');
      return lines;
    }
    let don = p.donActive;

    // 1) Bajadas por prioridad del mazo (greedy sobre el DON disponible).
    for (const pl of this.rankPlays(game, p, opp)) {
      if (pl.card.cost > don) continue;
      lines.push(`🃏 Juega <b>${pl.card.name}</b> (${pl.card.cost}): ${pl.why}`);
      don -= pl.card.cost;
    }

    // 2) Activaciones que preparan el combate.
    const drake = (p.characters ?? []).find((c) => c.data?.id === 'OP10-114' && !c.rested);
    if (drake && p.life.length <= opp.life.length) {
      const t = (opp.characters ?? []).find((c) => !c.rested && c.cost <= 4);
      if (t) lines.push(`🔄 Gira a <b>X.Drake</b> para girar a <b>${t.name}</b>: luego pégale y llévatelo por KO sin que pueda defenderse enderezado.`);
    }
    const kidChar = (p.characters ?? []).find((c) => c.data?.id === 'ST36-005');
    if (kidChar && p.donRested > 0 && p.life.length > 0) {
      lines.push('🔶 Activa a <b>Kid</b> (personaje): voltea 1 Vida boca arriba → 1 DON!! girado pasa a tu líder (+1000 de pegada este turno).');
    }

    // 3) Ataques (con la cuenta exacta y la regla del empate).
    const attackers = [...(p.characters ?? []), p.leader].filter((c) => c?.canAttack?.(game));
    let anyAttack = false;
    for (const atk of attackers) {
      const ap = this.bot.planAttack(game, atk);
      if (!ap) continue;
      anyAttack = true;
      const tgt = ap.targetId === 'leader' ? 'al <b>Líder</b> rival' : `a <b>${game.byId(ap.targetId)?.name ?? '?'}</b>`;
      const base = pow(atk, game);
      if (ap.donNeeded > 0) {
        lines.push(`⚔ Dale ${ap.donNeeded} DON!! a <b>${atk.name}</b> y ataca ${tgt}: ${base}+${ap.donNeeded * 1000} = <b>${base + ap.donNeeded * 1000}</b> (el atacante gana el empate).`);
      } else {
        lines.push(`⚔ Ataca con <b>${atk.name}</b> (${base}) ${tgt}.`);
      }
    }
    if (!anyAttack) {
      if (game.turn <= 1) lines.push('Turno 1: nadie puede atacar. Baja tu curva y pasa.');
      else if (!attackers.length) lines.push('Sin atacantes listos este turno: desarrolla el tablero.');
      else lines.push('Ningún ataque rentable ahora: mejor desarrolla y deja el tablero enderezado para defender.');
    } else {
      lines.push('Orden: pega <b>primero con los personajes</b> y deja el líder para el final — así ves cuántos counters gasta el rival antes de comprometer tu líder.');
    }

    // 4) El combo del líder, SIEMPRE antes de pasar.
    const targets = (p.characters ?? []).filter((c) => isSupernova(c) && c.cost >= 3 && c.cost <= 8);
    if (p.leader?.data?.id === 'OP10-099' && targets.length && p.life.length > 0) {
      const best = targets.slice().sort((a, b) => (Number(b.rested) - Number(a.rested)) || (pow(b, game) - pow(a, game)))[0];
      lines.push(`🧲 <b>ANTES de pasar</b>: habilidad del líder — voltea 1 Vida boca arriba y endereza a <b>${best.name}</b>${best.rested ? ' (recuperas su ataque de este turno)' : ''}: gana [Blocker] hasta tu próximo turno. Hazla casi todos los turnos: es un muro gratis.`);
    }
    return lines;
  }

  // Ordena las bajadas jugables con el conocimiento del mazo.
  rankPlays(game, p, opp) {
    const out = [];
    for (const c of (p.hand ?? []).filter?.((x) => x.isCharacter && x.cost <= p.donActive) ?? []) {
      let score = c.cost;
      let why = PRIORITY[c.data?.id]?.[1] ?? 'buen cuerpo para la curva';
      switch (c.data?.id) {
        case 'ST36-002':
          score += 3; why = 'jugado en TU turno añade +1 Vida — casi siempre la mejor bajada'; break;
        case 'P-085': {
          const target = (opp.characters ?? []).filter((x) => x.cost <= 4).sort((a, b) => pow(b, game) - pow(a, game))[0];
          if (p.life.length <= opp.life.length && target) { score += 4; why = `condición cumplida: mete a <b>${target.name}</b> en la Vida rival (removal limpio)`; }
          else { score -= 2; why = 'ahora es solo un 6000: necesita Vida ≤ que el rival y un objetivo de coste ≤4 — valora guardarla'; }
          break;
        }
        case 'ST36-005':
          score += 2; why = 'muro de 7000 con redirect (1/turno) que protege a tu líder'; break;
        case 'ST36-004': {
          const spare = (p.hand ?? []).filter((x) => x !== c && isSupernova(x)).length;
          if (spare) { score += 1.5; why = 'descarta tu carta más floja y roba 2: el motor del mazo'; }
          else { why = 'sin nada que descartar pierde fuelle: mejor con la mano más ancha'; }
          break;
        }
        case 'OP10-103': {
          const trig = (p.hand ?? []).filter((x) => x !== c && x.isCharacter && x.hasTrigger);
          if (trig.length) { score += 1.5; why = `coloca a <b>${trig[0].name}</b> (con [Trigger]) en tu Vida: defensa + sorpresa`; }
          break;
        }
        case 'OP10-101': score += 1; break;
        default: break;
      }
      out.push({ card: c, score, why });
    }
    // El evento buscador, si sobra 1 DON.
    const ev = (p.hand ?? []).find?.((c) => c.data?.id === 'OP13-116');
    if (ev && p.donActive >= 1) out.push({ card: ev, score: 0.8, why: 'con 1 DON suelto: busca un Supernovas entre 5 cartas' });
    return out.sort((a, b) => b.score - a.score);
  }

  warnings(game, p, opp) {
    const lines = [];
    // Genérico: si llevas eventos [Counter], resérvales DON antes de pasar.
    const cevs = (p.hand ?? []).filter?.((c) => c.isEvent && abilitiesOf(c, 'counter')[0]) ?? [];
    if (cevs.length) {
      const maxCost = Math.max(...cevs.map((c) => c.cost ?? 0));
      lines.push(`🛡 Llevas <b>${cevs.map((c) => c.name).join(', ')}</b> ([Counter]): termina el turno con ≥${maxCost} DON!! activos para poder pagarlo en defensa.`);
    }
    if ((p.hand.length ?? 0) <= 2) lines.push('Mano corta: cada carta también es un counter. No la quemes en bajadas mediocres.');
    if (p.life.length <= 2) lines.push(`☠ A ${p.life.length} vida(s): desde ya, bloquea o countera los golpes grandes; un [Double Attack] puede rematarte.`);
    const kidChar = (p.characters ?? []).find((c) => c.data?.id === 'ST36-005');
    if (kidChar) lines.push('Recuerda el redirect de <b>Kid</b> (1/turno) al defender: la Vida que volteas boca abajo recarga el combo del líder.');
    return lines;
  }

  // ---- consejos por decisión ----------------------------------------------

  adviseMulligan(game) {
    const p = this.sync(game);
    const hand = p.hand ?? [];
    const early = hand.filter((c) => c.isCharacter && c.cost <= 4);
    const cheap = hand.filter((c) => c.isCharacter && c.cost <= 3);
    const searchers = hand.filter((c) => SEARCHERS.has(c.data?.id));
    const killer = hand.find((c) => c.data?.id === 'ST36-002');
    const keep = (early.length >= 2 && cheap.length >= 1) || (searchers.length >= 1 && early.length >= 1);
    const reasons = [];
    if (killer) reasons.push('tienes a <b>Killer</b> (+1 Vida al jugarlo)');
    if (searchers.length) reasons.push(`tienes buscador (<b>${searchers[0].name}</b>) para rellenar lo que falte`);
    if (cheap.length) reasons.push(`${cheap.length} bajada(s) temprana(s) de coste ≤3`);
    if (!early.length) reasons.push('no tienes NADA jugable en los primeros turnos');
    else if (early.length === 1 && !searchers.length) reasons.push('solo 1 carta temprana y sin buscador: la mano se atasca');
    return `<b>🧭 Coach: yo ${keep ? 'me quedaría esta mano' : 'haría mulligan'}.</b> ` +
      (reasons.length ? `Motivo: ${reasons.join('; ')}. ` : '') +
      'Lo que buscas: bajada de coste 1–3, un buscador (Luffy / el evento) y cuerpos de 4–5. Killer vale oro.';
  }

  async adviseBlocker(game, ask) {
    const p = this.sync(game);
    const rec = await this.bot.chooseBlocker(game, ask);
    const atk = game.byId(ask.attackerId);
    const apw = pow(atk, game);
    if (rec) {
      const b = game.byId(rec);
      const surv = pow(b, game) > apw;
      return `Yo bloquearía con ${b?.name}${surv ? ` — sobrevive (${pow(b, game)} vs ${apw})` : ' — se sacrifica para salvar algo más valioso'}.`;
    }
    if (ask.targetId === 'leader') {
      return `Yo NO bloquearía: con ${p.life.length} vida(s) compensa tanquear — la Vida perdida va a tu mano y puede voltear un [Trigger].`;
    }
    return 'Yo NO bloquearía: no compensa perder el bloqueador por ese objetivo.';
  }

  async adviseCounter(game, ask) {
    const p = this.sync(game);
    const { attackPower, targetPower, targetId } = ask;
    const deficit = attackPower - targetPower;
    const lethal = targetId === 'leader' && p.life.length === 0;
    const rec = await this.bot.counterStep(game, ask);
    const chosen = [...rec.eventIds, ...rec.discardIds].map((id) => game.byId(id)).filter(Boolean);
    if (!chosen.length) {
      let why;
      if (deficit < 0) why = `ya ganas la batalla (${targetPower} vs ${attackPower})`;
      else if (targetId === 'leader' && p.life.length >= 3) why = `con ${p.life.length} vidas sale mejor tanquear: la Vida va a tu mano y puede ser un [Trigger] (Apoo, Law, Hawkins, Zoro…)`;
      else why = `frenarlo pediría más de +${deficit} de counter y esas cartas valen más en otro golpe`;
      return `🧭 <b>Coach:</b> yo lo dejaría pasar — ${why}.`;
    }
    let bonus = 0;
    for (const c of chosen) {
      if (c.isEvent) bonus += (abilitiesOf(c, 'counter')[0]?.ops ?? []).filter((o) => o.op === 'powerUp').reduce((n, o) => n + o.n, 0);
      else bonus += c.counterValue;
    }
    const list = chosen.map((c) => `<b>${c.name}</b> (${c.isEvent ? 'evento' : `+${c.counterValue}`})`).join(' + ');
    return `🧭 <b>Coach:</b> ${lethal ? '¡es LETAL, defiende sí o sí! ' : ''}yo soltaría ${list}: defensa ${targetPower + bonus} vs ${attackPower} → el golpe NO entra (el empate lo ganaría el atacante).`;
  }

  adviseTrigger(game, cardId) {
    const p = this.sync(game);
    const opp = game.opponentOf(p);
    const c = game.byId(cardId);
    switch (c?.data?.id) {
      case 'ST36-002':
        return opp.life.length <= 3
          ? '🧭 <b>Coach:</b> ¡actívalo! El rival está a ≤3 vidas: juegas a Killer (6000) gratis.'
          : `🧭 <b>Coach:</b> a tu mano — pide rival con ≤3 vidas (tiene ${opp.life.length}); activarlo ahora no haría nada.`;
      case 'ST36-003':
        return '🧭 <b>Coach:</b> actívalo: robas 1 y tu líder pasa a base 7000 el resto del turno — defiende mucho mejor los ataques que le queden al rival.';
      case 'OP10-109':
        return '🧭 <b>Coach:</b> actívalo: robar 2 y descartar 1 casi siempre compensa (te quedas la mejor).';
      case 'OP12-113':
        return '🧭 <b>Coach:</b> actívalo SIEMPRE: Zoro vuelve a tu mano igualmente y, si el rival tiene un coste ≤1, se lo lleva por delante.';
      case 'P-088': {
        const total = p.life.length + opp.life.length;
        return total <= 5
          ? '🧭 <b>Coach:</b> ¡actívalo! Vidas totales ≤5: juegas a Law (5000) gratis.'
          : `🧭 <b>Coach:</b> a tu mano — pide ≤5 vidas entre ambos (hay ${total}); en mano al menos countera 2000.`;
      }
      case 'OP13-116':
        return '🧭 <b>Coach:</b> actívalo: buscas un Supernovas entre 5 cartas, gratis y sin gastar el turno.';
      default:
        return '🧭 <b>Coach:</b> regla del mazo: casi todos los triggers compensan; actívalo salvo que su condición no se cumpla.';
    }
  }

  advisePayCost(game, { cardId, when }) {
    const p = this.sync(game);
    const c = game.byId(cardId);
    const key = `${c?.data?.id}:${when}`;
    switch (key) {
      case 'OP10-099:endOfTurn': {
        const targets = (p.characters ?? []).filter((x) => isSupernova(x) && x.cost >= 3 && x.cost <= 8);
        if (!targets.length) return '🧭 <b>Coach:</b> no: no tienes ningún Supernovas de coste 3–8 al que enderezar — no pagues por nada.';
        const best = targets.slice().sort((a, b) => (Number(b.rested) - Number(a.rested)) || (pow(b, game) - pow(a, game)))[0];
        return `🧭 <b>Coach:</b> sí, casi siempre: endereza a <b>${best.name}</b> y dale [Blocker] — tu mejor defensa. Voltear la Vida boca arriba apenas te cuesta nada.`;
      }
      case 'ST36-005:onOppAttack':
        return '🧭 <b>Coach:</b> redirige si el golpe iba a tu líder o a una pieza clave: Kid (7000) lo tanquea. Bonus: la Vida boca abajo recarga el combo del líder. No lo hagas si Kid muere por nada.';
      case 'ST36-004:onPlay': {
        const spare = (p.hand ?? []).filter((x) => x.id !== cardId && isSupernova(x));
        return spare.length
          ? `🧭 <b>Coach:</b> sí: descarta lo más prescindible (¿<b>${spare.sort((a, b) => this.bot.handValue(a) - this.bot.handValue(b))[0]?.name}</b>?) y roba 2 — cambiar 1 por 2 es el motor del mazo.`
          : '🧭 <b>Coach:</b> solo si de verdad te sobra algo: no descartes una pieza clave por robar.';
      }
      case 'ST36-001:onKO':
        return (p.hand.length ?? 0) >= 2
          ? '🧭 <b>Coach:</b> sí: conviertes tu peor carta en +1 Vida — casi siempre correcto.'
          : '🧭 <b>Coach:</b> con la mano tan corta, valora decir no: la carta en mano puede valer más que la Vida.';
      case 'OP10-103:onPlay': {
        const trig = (p.hand ?? []).filter((x) => x.isCharacter && x.hasTrigger && isSupernova(x));
        return trig.length
          ? `🧭 <b>Coach:</b> sí: sube a <b>${trig[0].name}</b> a tu Vida — defensa extra y un [Trigger] sorpresa.`
          : '🧭 <b>Coach:</b> opcional: sin un [Trigger] que colocar, solo reciclas 1 Vida a la mano — hazlo si necesitas la carta.';
      }
      case 'OP12-113:onKO': {
        const cheap = (p.hand ?? []).filter((x) => x.isCharacter && isSupernova(x) && x.cost <= 4);
        return cheap.length
          ? `🧭 <b>Coach:</b> sí: saca a <b>${cheap[0].name}</b> girado — el combo del líder puede enderezarlo al final del turno.`
          : '🧭 <b>Coach:</b> no tienes Supernovas de coste ≤4 en mano: no hay nada que sacar.';
      }
      default:
        return '';
    }
  }

  async adviseTarget(game, ask) {
    const rec = await this.bot.chooseTarget(game, ask);
    const name = rec ? game.byId(rec)?.name : null;
    return name ? `🧭 Yo elegiría a ${name}.` : '';
  }

  async adviseDiscard(game, n, opts) {
    const rec = await this.bot.discardFromHand(game, n, opts);
    const names = rec.map((id) => game.byId(id)?.name).filter(Boolean);
    return names.length ? `🧭 <b>Coach:</b> yo soltaría ${names.map((x) => `<b>${x}</b>`).join(' y ')} (lo de menor valor).` : '';
  }

  adviseRevealed(game, ask) {
    const picks = (ask.pickableIds ?? []).map((id) => game.byId(id)).filter(Boolean);
    if (!picks.length) return '🧭 <b>Coach:</b> nada elegible: mira el orden y pásalas al fondo.';
    this.sync(game);
    const best = picks.slice().sort((a, b) =>
      ((PRIORITY[b.data?.id]?.[0] ?? 0) + this.bot.handValue(b)) -
      ((PRIORITY[a.data?.id]?.[0] ?? 0) + this.bot.handValue(a)))[0];
    const why = PRIORITY[best.data?.id]?.[1] ?? 'la que mejor encaja en tu curva';
    return `🧭 <b>Coach:</b> yo cogería <b>${best.name}</b>: ${why}.`;
  }
}
