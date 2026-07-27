// F8 — Cliente online del navegador: conecta con el servidor de salas,
// mantiene el espejo ClientGame y despacha las preguntas a la UI humana.

import { ClientGame } from './clientGame.js';
import { makeSeat } from './seat.js';

export function connectOnline({ url, mode, code = '', name, deckSlug, human, ui, onStatus, onCode, onFirstView, onEnd, onError }) {
  const cg = new ClientGame();
  let ws;
  try {
    ws = new WebSocket(url);      // puede lanzar (mixed content, URL inválida)
  } catch (err) {
    onError?.(`No se pudo abrir la conexión (${url}): ${err.message}`);
    return { cg, ws: null, close() {} };
  }
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const seat = makeSeat(human, send, cg);
  let myToken = sessionStorage.getItem('opToken') ?? null;
  let helloSeat = null;
  let firstView = false;
  let connected = false;
  let reported = false;
  const failNoConnect = () => { if (!reported) { reported = true; onError?.({ kind: 'noconnect', url }); } };

  ws.onopen = () => {
    connected = true;
    if (mode === 'rejoin' && myToken) send({ t: 'rejoin', token: myToken });
    else if (mode === 'join') send({ t: 'join', code, name, deckSlug });
    else send({ t: 'create', name, deckSlug });
  };
  // No pudo ni abrir el socket: casi siempre no hay servidor en esa dirección.
  ws.onerror = () => { if (!connected) failNoConnect(); };
  ws.onclose = () => {
    if (!connected) failNoConnect();
    else onStatus?.('Conexión cerrada.');
  };

  ws.onmessage = async (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m.t) {
      case 'hello':
        helloSeat = m.seat;
        myToken = m.token;
        sessionStorage.setItem('opToken', m.token);
        onCode?.(m.code, m.seat);
        break;
      case 'status':
        onStatus?.(m.msg);
        break;
      case 'view':
        cg.update(m.view);
        human.player = cg.players[m.view.youIdx];
        if (!firstView) { firstView = true; onFirstView?.(); }
        ui.render();
        break;
      case 'ask':
        cg.absorbAskCards(m.payload?.cards);
        ui.render();
        await seat(m);
        break;
      case 'log':
        ui.logLine(m.line);
        break;
      case 'narrate':
        ui.banner(m.ev);
        break;
      case 'animate':
        if (m.ev?.type === 'attack') ui.animateAttack(m.ev);
        break;
      case 'end':
        onEnd?.(m, helloSeat);
        break;
      case 'error':
        onError?.(m.msg);
        break;
      default: break;
    }
  };

  return { cg, ws, close: () => ws.close() };
}
