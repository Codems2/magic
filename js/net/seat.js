// F7a — Asiento del cliente: recibe una pregunta {t:'ask'} del servidor y la
// delega en un controlador local (la UI humana en el navegador, o un
// controlador automático en los tests). Devuelve el {t:'answer'}.
//
// `game` es el espejo local del estado (ClientGame en F7b) o null en tests
// que respondan sin mirar el estado.

export function makeSeat(ctrl, send, game = null) {
  return async function handleAsk(msg) {
    const { reqId, method, payload = {} } = msg;
    let value = null;
    try {
      switch (method) {
        case 'mulligan':
          value = await ctrl.mulligan(game, payload.handIds ?? []);
          break;
        case 'mainAction':
          value = await ctrl.mainAction(game);
          break;
        case 'discardFromHand':
          value = await ctrl.discardFromHand(game, payload.n ?? 1, { min: payload.min, fromIds: payload.fromIds });
          break;
        default:
          value = await ctrl[method](game, payload);
      }
    } catch (err) {
      // Nunca dejes al servidor colgado: una respuesta nula es "no hago nada".
      console.error(`seat: error resolviendo ${method}:`, err);
      value = null;
    }
    send({ t: 'answer', reqId, value: value ?? null });
  };
}
