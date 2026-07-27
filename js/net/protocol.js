// F7a — Protocolo de red del multijugador. Mensajes 100% JSON plano.
//
// Servidor → cliente:
//   {t:'hello', seat, code, token}          al entrar en una sala
//   {t:'status', msg}                       estado de la sala (esperando rival...)
//   {t:'view', view}                        tu vista de la partida (game.viewFor)
//   {t:'ask', reqId, method, payload}       pregunta de decisión; payload.cards
//                                           trae descriptores de las cartas citadas
//   {t:'log', line}                         línea del historial
//   {t:'narrate', ev}                       narración (cartel del rival)
//   {t:'animate', ev}                       animación (flecha de ataque)
//   {t:'end', winnerIdx, reason}            fin de partida
//   {t:'error', msg}
// Cliente → servidor:
//   {t:'create', name, deckSlug}
//   {t:'join', code, name, deckSlug}
//   {t:'rejoin', token}
//   {t:'answer', reqId, value}

// Métodos de decisión del controlador: la superficie completa del protocolo.
export const ASK_METHODS = [
  'mulligan', 'mainAction', 'chooseTarget', 'chooseBlocker', 'counterStep',
  'discardFromHand', 'triggerDecision', 'chooseOption', 'chooseRevealed',
  'payOptionalCost',
];

// Recoge todos los ids de carta citados en el payload de una pregunta.
export function idsInPayload(payload) {
  const ids = [];
  if (!payload) return ids;
  for (const k of ['cardIds', 'candidateIds', 'blockerIds', 'revealedIds', 'pickableIds', 'handIds', 'fromIds']) {
    if (Array.isArray(payload[k])) ids.push(...payload[k]);
  }
  for (const k of ['cardId', 'attackerId', 'targetId']) {
    if (typeof payload[k] === 'number') ids.push(payload[k]);
  }
  return ids;
}

// Mapa id → descriptor público, para que el cliente pinte cartas que aún no
// están en su vista (reveladas del mazo, del descarte, de la Vida...).
export function cardMap(game, ids) {
  const m = {};
  for (const id of ids) {
    if (m[id]) continue;
    const c = game.byId(id);
    if (c) m[id] = game.pubCard(c, { forOwner: true });
  }
  return m;
}
