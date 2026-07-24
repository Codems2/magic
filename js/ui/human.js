// Controlador del jugador humano: traduce las decisiones del motor a
// interacciones de la interfaz (selecciones y diálogos).

import { canPay, solvePayment, manaSources, sourcesFor } from '../engine/mana.js';
import { Player } from '../engine/game.js';

export class HumanController {
  constructor(ui) {
    this.ui = ui;
    this.player = null;
  }

  // ---- mano inicial ------------------------------------------------------

  async mulligan(game, hand, mulls) {
    const res = await this.ui.dialog({
      title: `Tu mano inicial${mulls ? ` (mulligan ${mulls})` : ''}`,
      cards: hand,
      buttons: [
        { label: 'Quedármela', value: false, primary: true },
        { label: 'Mulligan', value: true },
      ],
    });
    return res;
  }

  async chooseBottom(game, n) {
    const out = [];
    while (out.length < n) {
      const res = await this.ui.pick({
        cards: this.player.hand.filter((c) => !out.includes(c)),
        text: `Mulligan: elige ${n - out.length} carta(s) para el fondo de la biblioteca.`,
      });
      if (res.type === 'card') out.push(res.card);
    }
    return out;
  }

  async discardTo(game, n) {
    const out = [];
    while (out.length < n) {
      const res = await this.ui.pick({
        cards: this.player.hand.filter((c) => !out.includes(c)),
        text: `Descarta ${n - out.length} carta(s).`,
      });
      if (res.type === 'card') out.push(res.card);
    }
    return out;
  }

  async chooseCards(game, cards, n, label) {
    return this.ui.chooseCardsDialog(label ?? `Elige ${n} carta(s)`, cards, n);
  }

  async scryDecision(game, cards) {
    const top = []; const bottom = [];
    for (const c of cards) {
      const res = await this.ui.dialog({
        title: 'Adivinar',
        body: `¿Dónde pones ${c.name}?`,
        cards: [c],
        buttons: [
          { label: 'Arriba', value: 'top', primary: true },
          { label: 'Al fondo', value: 'bottom' },
        ],
      });
      (res === 'top' ? top : bottom).push(c);
    }
    return { top, bottom };
  }

  // ---- fase principal ----------------------------------------------------

  playableCards(game) {
    const p = this.player;
    const out = [];
    for (const c of p.hand) {
      if (c.isLand) { if (p.landsPlayedThisTurn < 1) out.push(c); continue; }
      if (solvePayment(c.parsedCost, sourcesFor(p, game, c), 0)) out.push(c);
    }
    for (const c of p.command) {
      if (canPay(game.commanderCost(c), p, game, 0)) out.push(c);
    }
    // Equipos, vehículos y habilidades activadas.
    for (const perm of p.battlefield) {
      if (perm.isEquipment && perm.script.equipCost && p.creatures().length &&
          solvePayment(perm.script.equipCost, manaSources(p, game))) out.push(perm);
      else if (perm.script?.crew && !perm.crewed && !perm.summoningSick &&
          p.creatures().filter((c) => !c.tapped && c !== perm)
            .reduce((s, c) => s + c.power(game), 0) >= perm.script.crew) out.push(perm);
      else if ((perm.script?.activated ?? []).some((ab) =>
        solvePayment(ab.mana, manaSources(p, game)) &&
        !(ab.tap && (perm.tapped || (perm.isCreature && perm.summoningSick))))) out.push(perm);
    }
    return out;
  }

  async mainAction(game) {
    const p = this.player;
    while (true) {
      const playable = this.playableCards(game);
      const res = await this.ui.pick({
        cards: playable,
        text: `Fase principal: juega tierras, lanza hechizos o pasa. (Maná disponible: ${manaSources(p, game).length})`,
        buttons: [{ label: game.phase === 'main1' ? 'Ir a combate ▶' : 'Terminar turno ▶', value: 'pass' }],
      });
      if (res.type === 'button') return { type: 'pass' };
      const card = res.card;

      if (card.zone === 'battlefield') {
        if (card.isEquipment && card.script.equipCost) {
          const target = await this.pickOwnCreature(game, `¿A qué criatura equipas ${card.name}?`);
          if (!target) continue;
          return { type: 'equip', equipment: card, creature: target };
        }
        if (card.script?.crew && !card.crewed) return { type: 'crew', vehicle: card };
        const ab = (card.script?.activated ?? []).find((a) =>
          solvePayment(a.mana, manaSources(p, game)) &&
          !(a.tap && (card.tapped || (card.isCreature && card.summoningSick))));
        if (ab) return { type: 'activate', permanent: card, ability: ab };
        continue;
      }
      if (card.isLand) return { type: 'playLand', card };
      return { type: 'cast', card };
    }
  }

  async pickOwnCreature(game, text) {
    const res = await this.ui.pick({
      cards: this.player.creatures(),
      text,
      buttons: [{ label: 'Cancelar', value: null, warn: true }],
    });
    return res.type === 'card' ? res.card : null;
  }

  async chooseTarget(game, source, op, candidates) {
    const cards = candidates.filter((t) => !(t instanceof Player));
    const players = candidates.filter((t) => t instanceof Player);
    const OP_LABELS = {
      damage: 'daño', destroy: 'destruir', exile: 'exiliar', bounce: 'devolver a la mano',
      pump: 'bonificación', counters: 'contador +1/+1', support: 'contador +1/+1 (apoyo)',
      distribute: 'repartir contadores', tap: 'girar', loseLife: 'pérdida de vida',
      mill: 'moler', discard: 'descarte', draw: 'robar',
    };
    const res = await this.ui.pick({
      cards, players,
      text: `Elige objetivo para ${source.name} (${OP_LABELS[op.op] ?? op.op}).`,
      buttons: [{ label: 'Cancelar', value: null, warn: true }],
    });
    if (res.type === 'card') return res.card;
    if (res.type === 'player') return res.player;
    return null;
  }

  async chooseX(game, card, maxX) {
    const buttons = [];
    for (let i = 0; i <= Math.min(maxX, 12); i++) buttons.push({ label: `X=${i}`, value: i });
    const res = await this.ui.dialog({
      title: `Elige X para ${card.name}`,
      body: `Puedes pagar hasta X=${maxX}.`,
      buttons,
    });
    return res ?? 0;
  }

  // ---- respuestas --------------------------------------------------------

  counterspells(game) {
    return this.player.hand.filter((c) =>
      c.isInstant && c.script.castOps.some((op) => op.op === 'counterSpell') &&
      canPay(c.parsedCost, this.player, game));
  }

  async respond(game, spell) {
    const counters = this.counterspells(game);
    if (!counters.length) return null;
    const res = await this.ui.pick({
      cards: counters,
      text: `${spell.controller?.name ?? spell.owner.name} lanza ${spell.name}. ¿Quieres contrarrestarlo?`,
      buttons: [{ label: 'No responder', value: null }],
    });
    if (res.type === 'card') return { card: res.card };
    return null;
  }

  async combatInstant(game) {
    const p = this.player;
    const instants = p.hand.filter((c) => c.isInstant && canPay(c.parsedCost, p, game) && c.script.castOps.length);
    if (!instants.length) return null;
    const res = await this.ui.pick({
      cards: instants,
      text: '¡Te atacan! Puedes lanzar un instantáneo antes de bloquear.',
      buttons: [{ label: 'Continuar a bloqueos', value: null }],
    });
    if (res.type === 'card') return { card: res.card };
    return null;
  }

  // ---- combate -----------------------------------------------------------

  async declareAttackers(game) {
    const p = this.player;
    const ready = () => p.creatures().filter((c) => c.canAttack(game));
    if (!ready().length) return [];
    const decls = [];
    const assigned = new Set();
    this.ui.attackingIds = new Set();

    while (true) {
      const pending = [...this.ui.attackingIds];
      const res = await this.ui.pick({
        cards: ready().filter((c) => !assigned.has(c.id)),
        players: pending.length ? game.opponentsOf(p) : [],
        text: pending.length
          ? `${pending.length} atacante(s) seleccionado(s): haz clic en el oponente a atacar.`
          : `Combate: selecciona atacantes (${decls.length} ya declarados) o pasa.`,
        buttons: [{ label: decls.length ? 'Confirmar ataque ▶' : 'No atacar ▶', value: 'done' }],
      });
      if (res.type === 'button') break;
      if (res.type === 'card') {
        if (this.ui.attackingIds.has(res.card.id)) this.ui.attackingIds.delete(res.card.id);
        else this.ui.attackingIds.add(res.card.id);
      }
      if (res.type === 'player') {
        for (const id of this.ui.attackingIds) {
          const c = p.creatures().find((x) => x.id === id);
          if (c) { decls.push({ attacker: c, defender: res.player }); assigned.add(id); }
        }
        this.ui.attackingIds.clear();
      }
    }
    this.ui.attackingIds.clear();
    return decls;
  }

  async declareBlockers(game, attackers) {
    const p = this.player;
    const blocks = [];
    const usedBlockers = new Set();
    while (true) {
      const res = await this.ui.pick({
        cards: attackers.filter((a) => a.zone === 'battlefield'),
        text: `Te atacan ${attackers.map((a) => `${a.name} (${a.power(game)}/${a.toughness(game)})`).join(', ')}. Haz clic en un atacante para bloquearlo (${blocks.length} bloqueos).`,
        buttons: [{ label: blocks.length ? 'Confirmar bloqueos ▶' : 'No bloquear ▶', value: 'done' }],
      });
      if (res.type === 'button') break;
      const attacker = res.card;
      const eligible = p.creatures().filter((c) =>
        !usedBlockers.has(c.id) && c.canBlock(attacker, game));
      if (!eligible.length) continue;
      const res2 = await this.ui.pick({
        cards: eligible,
        text: `¿Con qué criatura bloqueas a ${attacker.name}?`,
        buttons: [{ label: 'Cancelar', value: null, warn: true }],
      });
      if (res2.type === 'card') {
        blocks.push({ blocker: res2.card, attacker });
        usedBlockers.add(res2.card.id);
      }
    }
    return blocks;
  }
}
