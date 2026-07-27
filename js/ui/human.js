// Controlador humano: traduce las decisiones del motor a la interfaz.
// Implementa la misma interfaz que BotController (y que el futuro RemoteController).

import { abilitiesOf } from '../engine/effects.js';

export class HumanController {
  constructor(ui) {
    this.ui = ui;
    this.player = null;
  }

  async mulligan(game, handIds) {
    const res = await this.ui.dialog({
      title: 'Tu mano inicial',
      cardIds: handIds,
      buttons: [
        { label: 'Quedármela', value: false, primary: true },
        { label: 'Mulligan', value: true },
      ],
    });
    return res;
  }

  async mainAction(game) {
    const p = this.player;
    const opp = game.opponentOf(p);
    while (true) {
      const playableHand = p.hand.filter((c) =>
        (c.isCharacter && c.cost <= p.donActive) ||
        (c.isStage && c.cost <= p.donActive) ||
        (c.isEvent && c.cost <= p.donActive && abilitiesOf(c, 'main')[0] &&
          game.canPayAbilityCost(p, c, abilitiesOf(c, 'main')[0].cost)));
      const boardActive = [p.leader, ...p.characters, p.stage].filter(Boolean).filter((c) =>
        c.canAttack?.(game) ||
        this.canActivate(game, c) ||
        (p.donActive > 0 && (c.isLeader || c.isCharacter)));

      const res = await this.ui.pick({
        cardIds: [...playableHand, ...boardActive].map((c) => c.id),
        text: `Fase principal — DON activos: ${p.donActive}. Toca una carta o pasa.`,
        buttons: [{ label: 'Terminar turno ▶', value: 'pass' }],
      });
      if (res.type === 'button') return { type: 'pass' };
      const card = game.byId(res.id);
      if (!card) continue;

      if (card.zone === 'hand') {
        if (card.isCharacter) {
          const action = { type: 'playCharacter', cardId: card.id };
          if (p.characters.length >= 5) {
            const victims = await this.ui.chooseCards({
              title: 'Área llena', body: 'Elige un personaje para mandar al descarte.',
              cardIds: p.characters.map((c) => c.id), max: 1, min: 1,
            });
            action.trashId = victims[0];
          }
          return action;
        }
        if (card.isStage) return { type: 'playStage', cardId: card.id };
        if (card.isEvent) return { type: 'playEvent', cardId: card.id };
        continue;
      }

      // Carta propia en el tablero: menú contextual.
      const opts = [];
      if (card.canAttack?.(game)) opts.push({ label: '⚔ Atacar', value: 'attack' });
      if (p.donActive > 0 && (card.isLeader || card.isCharacter)) opts.push({ label: '▲ Dar 1 DON!!', value: 'don' });
      if (this.canActivate(game, card)) opts.push({ label: '✨ Activar habilidad', value: 'activate' });
      opts.push({ label: 'Cancelar', value: null });
      const choice = await this.ui.dialog({ title: card.name, cardIds: [card.id], buttons: opts });
      if (!choice) continue;
      if (choice === 'don') return { type: 'giveDon', cardId: card.id, n: 1 };
      if (choice === 'activate') return { type: 'activate', cardId: card.id };
      if (choice === 'attack') {
        const canHitActive = card.script?.abilities?.some((ab) => ab.ops.some((o) => o.op === 'canAttackActive'));
        const targets = [opp.leader, ...opp.characters.filter((c) => c.rested || canHitActive)];
        const t = await this.ui.pick({
          cardIds: targets.map((c) => c.id),
          text: `¿A quién ataca ${card.name} (${card.power(game)})?`,
          buttons: [{ label: 'Cancelar', value: null, warn: true }],
        });
        if (t.type === 'button') continue;
        return {
          type: 'attack', attackerId: card.id,
          targetId: t.id === opp.leader.id ? 'leader' : t.id,
        };
      }
    }
  }

  canActivate(game, card) {
    const ab = abilitiesOf(card, 'activateMain')[0];
    if (!ab) return false;
    if (ab.once && card._activatedTurn === game.turn) return false;
    if (ab.donX && card.givenDon < ab.donX) return false;
    return game.canPayAbilityCost(this.player, card, ab.cost);
  }

  async chooseBlocker(game, { attackerId, targetId, blockerIds }) {
    const attacker = game.byId(attackerId);
    const targetName = targetId === 'leader' ? 'tu líder' : game.byId(targetId)?.name;
    const res = await this.ui.pick({
      cardIds: blockerIds,
      text: `${attacker.name} (${attacker.power(game)}) ataca a ${targetName}. ¿Bloqueas?`,
      buttons: [{ label: 'No bloquear', value: null }],
    });
    return res.type === 'card' ? res.id : null;
  }

  async counterStep(game, { attackerId, targetId, attackPower, targetPower }) {
    const p = this.player;
    const counters = p.hand.filter((c) => c.counterValue > 0);
    const events = p.hand.filter((c) => c.isEvent && abilitiesOf(c, 'counter')[0] &&
      c.cost <= p.donActive && game.canPayAbilityCost(p, c, abilitiesOf(c, 'counter')[0].cost));
    if (!counters.length && !events.length) return { discardIds: [], eventIds: [] };

    const targetName = targetId === 'leader' ? 'tu líder' : game.byId(targetId)?.name;
    const ids = [...new Set([...counters, ...events].map((c) => c.id))];
    const chosen = await this.ui.chooseCards({
      title: 'Paso de counter',
      body: `${game.byId(attackerId).name} (${attackPower}) golpea a ${targetName} (${targetPower}). En empate gana el ATACANTE: tu defensa debe SUPERAR ${attackPower}.`,
      cardIds: ids,
      confirmLabel: 'Resolver',
      extra: (sel) => {
        let bonus = 0;
        for (const id of sel) {
          const c = game.byId(id);
          if (c.isEvent) bonus += (abilitiesOf(c, 'counter')[0]?.ops ?? []).filter((o) => o.op === 'powerUp').reduce((n, o) => n + o.n, 0);
          else bonus += c.counterValue;
        }
        // En OPTCG el atacante gana los empates: el ataque solo se frena si la
        // defensa es ESTRICTAMENTE mayor que el poder del atacante.
        const survives = (targetPower + bonus) > attackPower;
        return `Defensa: ${targetPower + bonus} vs ${attackPower} → ${survives ? '🛡 el ataque NO entra' : '💥 el ataque ENTRA' + (targetPower + bonus === attackPower ? ' (empate → gana el atacante)' : '')}`;
      },
    });
    const discardIds = [];
    const eventIds = [];
    for (const id of chosen) {
      const c = game.byId(id);
      if (c.isEvent && abilitiesOf(c, 'counter')[0]) eventIds.push(id);
      else discardIds.push(id);
    }
    return { discardIds, eventIds };
  }

  async chooseTarget(game, { purpose, candidateIds, optional }) {
    const LABELS = {
      ko: 'KO a un personaje', bounce: 'devolver a la mano', tuckBottom: 'al fondo del mazo',
      rest: 'girar', unrest: 'enderezar', powerUp: 'dar poder', giveDon: 'dar DON!!',
      recover: 'recuperar del descarte', grantNoBlocker: 'imparable este turno',
      powerDown: 'quitar poder', costDown: 'reducir coste',
      toLife: 'poner en tu Vida (boca abajo)', lifeToDeck: 'poner en lo alto del mazo',
      playFree: 'poner en juego gratis', trashLifeTarget: 'descartar de tu Vida',
    };
    const label = LABELS[purpose] ?? purpose;
    // Cartas en zonas ocultas (descarte, mazo, Vida) no están pintadas en el
    // tapete y no se pueden señalar: se eligen en un modal que las muestra.
    const cands = candidateIds.map((id) => game.byId(id)).filter(Boolean);
    const onMat = (c) => ['characters', 'leader', 'stage'].includes(c.zone) ||
      (c.zone === 'hand' && c.owner === this.player);
    if (!cands.length) return null;
    if (cands.some((c) => !onMat(c))) {
      const chosen = await this.ui.chooseCards({
        title: `Elige: ${label}`,
        body: optional ? 'Puedes confirmar sin seleccionar nada para no aplicarlo.' : '',
        cardIds: candidateIds,
        max: 1, min: optional ? 0 : 1,
        confirmLabel: 'Confirmar',
      });
      return chosen[0] ?? null;
    }
    const res = await this.ui.pick({
      cardIds: candidateIds,
      text: `Elige objetivo: ${label}.`,
      buttons: optional ? [{ label: 'No usar', value: null }] : [],
    });
    return res.type === 'card' ? res.id : null;
  }

  async discardFromHand(game, n) {
    const chosen = await this.ui.chooseCards({
      title: `Descarta ${n} carta(s)`,
      cardIds: this.player.hand.map((c) => c.id),
      max: n, min: Math.min(n, this.player.hand.length),
    });
    return chosen;
  }

  async triggerDecision(game, { cardId }) {
    return this.ui.dialog({
      title: '✨ ¡Trigger!',
      body: 'Esta carta de vida tiene [Trigger]. ¿Lo activas (la carta no irá a tu mano) o te la quedas?',
      cardIds: [cardId],
      buttons: [
        { label: 'Activar Trigger', value: true, primary: true },
        { label: 'A mi mano', value: false },
      ],
    });
  }

  // Miras N cartas reveladas y eliges hasta `max` de entre las elegibles;
  // las no elegibles se ven pero no se pueden seleccionar (como en el juego real).
  async chooseRevealed(game, { revealedIds, pickableIds, min = 0, max = 1, prompt = '' }) {
    return this.ui.chooseCards({
      title: 'Miras la cima de tu mazo',
      body: prompt,
      cardIds: revealedIds,
      selectableIds: pickableIds,
      min: Math.min(min, pickableIds.length),
      max,
      confirmLabel: pickableIds.length ? 'Añadir a la mano' : 'Entendido',
    });
  }

  async chooseOption(game, { prompt, options }) {
    return this.ui.dialog({
      title: 'Elige una opción',
      body: prompt,
      buttons: options.map((label, i) => ({ label, value: i, primary: i === 0 })),
    });
  }

  async payOptionalCost(game, { cardId, when }) {
    const card = game.byId(cardId);
    const ab = abilitiesOf(card, when)[0];
    const c = ab?.cost ?? {};
    const parts = [];
    if (c.donRest) parts.push(`girar ${c.donRest} DON!!`);
    if (c.donReturn) parts.push(`devolver ${c.donReturn} DON!! al mazo`);
    if (c.donReturnVar) parts.push('devolver 1+ DON!! al mazo');
    if (c.returnGivenDon) parts.push(`devolver ${c.returnGivenDon} DON!! dado(s)`);
    if (c.trashHand) parts.push(`descartar ${c.trashHand} carta(s)`);
    if (c.trashHandAny) parts.push('descartar cartas (las que quieras)');
    if (c.trashLife) parts.push(`descartar ${c.trashLife} carta(s) de tu Vida`);
    if (c.lifeToHand) parts.push(`llevar ${c.lifeToHand} carta(s) de Vida a la mano`);
    if (c.restOwn) parts.push(`girar ${c.restOwn.n} personaje(s) tuyo(s)`);
    if (c.bounceOwn) parts.push(`devolver ${c.bounceOwn.n} personaje(s) tuyo(s) a la mano`);
    if (c.charToLife) parts.push(`poner ${c.charToLife.n} personaje(s) tuyo(s) en tu Vida`);
    if (c.trashToBottom) parts.push(`poner ${c.trashToBottom} del descarte al fondo del mazo`);
    if (c.revealHand) parts.push(`revelar ${c.revealHand.n} carta(s) de tu mano`);
    if (c.restSelf) parts.push('girar esta carta');
    if (c.trashSelf) parts.push('descartar esta carta');
    return this.ui.dialog({
      title: `Habilidad de ${card.name}`,
      body: `¿Pagas el coste (${parts.join(' + ') || 'gratis'}) para activar su efecto?`,
      cardIds: [cardId],
      buttons: [
        { label: 'Pagar y activar', value: true, primary: true },
        { label: 'No', value: false },
      ],
    });
  }
}
