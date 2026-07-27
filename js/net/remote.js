// F7a — RemoteController: el controlador que representa a un jugador humano
// REMOTO en el servidor. Implementa la misma interfaz que BotController y
// HumanController, pero cada decisión viaja por la red: envía {t:'ask'} y
// espera el {t:'answer'} correspondiente.

import { cardMap, idsInPayload } from './protocol.js';

export class RemoteController {
  constructor(send) {
    this._send = send;          // función de envío (se puede reemplazar al reconectar)
    this._pending = new Map();  // reqId → resolve
    this._req = 1;
    this._lastAsk = null;       // última pregunta sin responder (reenvío al reconectar)
    this.beforeAsk = null;      // hook del servidor: empujar la vista fresca antes de preguntar
    this.player = null;
  }

  // Reconecta el transporte y reenvía la pregunta pendiente si la hay.
  attach(send) {
    this._send = send;
    if (this._lastAsk) this._send(this._lastAsk);
  }

  // El servidor entrega aquí las respuestas del cliente.
  answer(reqId, value) {
    const resolve = this._pending.get(reqId);
    if (!resolve) return;
    this._pending.delete(reqId);
    this._lastAsk = null;
    resolve(value);
  }

  _ask(game, method, payload = {}) {
    if (this.beforeAsk) this.beforeAsk();
    const ids = idsInPayload(payload);
    const msg = {
      t: 'ask', reqId: this._req++, method,
      payload: { ...payload, cards: cardMap(game, ids) },
    };
    this._lastAsk = msg;
    return new Promise((resolve) => {
      this._pending.set(msg.reqId, resolve);
      this._send(msg);
    });
  }

  // --- interfaz de controlador (saneando cada respuesta remota) ---
  async mulligan(g, handIds) { return !!(await this._ask(g, 'mulligan', { handIds })); }
  async mainAction(g) {
    const v = await this._ask(g, 'mainAction', {});
    return v && typeof v === 'object' && typeof v.type === 'string' ? v : { type: 'pass' };
  }
  async chooseTarget(g, p) {
    const v = await this._ask(g, 'chooseTarget', p);
    return typeof v === 'number' || v === null ? v : null;
  }
  async chooseBlocker(g, p) {
    const v = await this._ask(g, 'chooseBlocker', p);
    return typeof v === 'number' ? v : null;
  }
  async counterStep(g, p) {
    const v = await this._ask(g, 'counterStep', p);
    return {
      discardIds: Array.isArray(v?.discardIds) ? v.discardIds : [],
      eventIds: Array.isArray(v?.eventIds) ? v.eventIds : [],
    };
  }
  async discardFromHand(g, n, opts = {}) {
    const v = await this._ask(g, 'discardFromHand', { n, min: opts.min, fromIds: opts.fromIds });
    return Array.isArray(v) ? v : [];
  }
  async triggerDecision(g, p) { return !!(await this._ask(g, 'triggerDecision', p)); }
  async chooseOption(g, p) {
    const v = await this._ask(g, 'chooseOption', p);
    return Number.isInteger(v) ? v : 0;
  }
  async chooseRevealed(g, p) {
    const v = await this._ask(g, 'chooseRevealed', p);
    return Array.isArray(v) ? v : [];
  }
  async payOptionalCost(g, p) { return !!(await this._ask(g, 'payOptionalCost', p)); }
}
