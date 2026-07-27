# 🏴‍☠️ Simulador de One Piece Card Game

Simulador web para jugar 1v1 al **One Piece Card Game** contra un bot, con
los **Starter Decks oficiales** y datos de carta de una API pública.

Ver [`PLAN.md`](PLAN.md) para el diseño completo y las fases (incluido el
multijugador online planificado en F7–F9).

## Cómo jugar

Aplicación web estática, sin build ni dependencias. Sirve la carpeta y abre
el navegador:

```bash
python3 -m http.server 8000
```

Abre <http://localhost:8000>, elige tu mazo y el del bot, y a jugar.
Funciona en escritorio y **móvil** (mantén pulsada una carta para verla en
grande; el botón 📜 muestra u oculta el registro).

## 🌐 Multijugador online (1v1 con un amigo)

El online usa un **servidor autoritativo**: el motor corre solo en el
servidor y cada navegador recibe únicamente SU vista (la mano y las vidas
del rival nunca llegan a tu navegador — no se puede hacer trampa).

### Probarlo en local

```bash
# terminal 1: el servidor de salas
cd server && npm install && npm start        # ws://localhost:8765

# terminal 2: el estático
python3 -m http.server 8000
```

Abre dos pestañas en <http://localhost:8000>: en una elige mazo, pon tu
nombre y **⚓ Crear sala** (te da un código de 4 letras); en la otra pega el
código y **Unirse**. Recargar la página no pierde la partida (reconexión
por token de sesión).

### Desplegarlo en Internet

- El **estático** sigue en Vercel tal cual (el `.vercelignore` excluye el
  servidor).
- El **servidor** necesita procesos persistentes (Vercel no vale). En
  [Render](https://render.com) (gratis): *New Web Service* → este repo →
  Root Directory `server` → Build `npm install` → Start `npm start`.
  Render te da una URL `https://tu-app.onrender.com`.
- En el juego, desplegable **"Servidor"** del lobby online → escribe
  `wss://tu-app.onrender.com` (con `wss://`, no `ws://`). Se guarda en el
  navegador.

En el plan gratuito de Render el servidor se duerme tras 15 min de
inactividad: la primera conexión del día tarda ~30 s en despertarlo.

Necesitas conexión a Internet para las imágenes (se cargan de OPTCG API);
sin ellas el juego funciona igual mostrando el texto de cada carta.

## Reglas implementadas

Preparación (líder, 5 de mano con mulligan, vidas según el líder, 10 DON!!),
turnos completos (Refresh / Draw / DON!! / Main / End con las excepciones del
primer turno), economía de DON!! (colocar, pagar costes, **dar +1000**,
retorno en refresh, devolver al mazo), personajes (límite de 5), escenarios,
y combate íntegro: atacar al líder o a personajes girados, **paso de bloqueo**
(`[Blocker]`), **paso de counter** (descartes con valor de counter y eventos
`[Counter]`), `[Rush]`, `[Double Attack]`, `[Banish]`, vidas con `[Trigger]`
y victoria por golpe final o por quedarse sin mazo.

## Efectos de carta

`js/engine/effects.js` interpreta el texto etiquetado de OPTCG
(`[On Play]`, `[When Attacking]`, `[Activate: Main]`, `[Main]`, `[Counter]`,
`[Trigger]`, `[On Block]`, `[On K.O.]`, `[End of Your Turn]`), sus
modificadores (`[DON!! xN]`, `[Once Per Turn]`, `[Your Turn]`) y costes
internos (`(2)`, `DON!! -N`, descartar, girarse).

Cobertura sobre las cartas con texto de los 25 mazos importados: los cuatro
starter decks originales (ST-01 a ST-04) están al **100 %**; en el conjunto,
~1 de cada 3 cartas se interpreta por completo y ~57 % ejecuta al menos su
efecto principal. Los sets recientes traen cartas más complejas cuyo texto
aún no está totalmente simulado — esas cartas se marcan con ⚠ en la interfaz
y siguen siendo jugables (como cuerpos, sin su efecto). Lo no reconocido
queda registrado y nunca rompe la partida.

## Los bots

`js/ai/bot.js` juega a buen nivel: mulligan por curva, despliegue por coste,
plan de ataque por turno (presiona al líder para drenar counters, invierte
DON!! cuando el golpe compensa, KOs por valor real), y defensa por eficiencia
de intercambio (counters solo en golpes letales o rentables, eventos
`[Counter]` primero, bloqueos ventajosos). No mira la mano rival: estima el
counter esperado. Medido contra un bot de referencia: **100 %** de victorias.

## Datos

| Qué | Fuente |
|---|---|
| Listas y datos de carta | [OPTCG API](https://optcgapi.com) (`/api/decks/<ID>/`) |
| Imágenes | CDN de OPTCG API |

Mazos importados: **los 25 starter/ultra decks** que la API sirve completos
(ST-01 a ST-30; los cuatro con datos incompletos en la API —ST-11, 15, 17,
20— se omiten automáticamente). Las cantidades por carta se ajustan a
exactamente 50 con la estructura estándar de los starter decks (máximo 4
copias por carta) y se marcan con `quantitiesExact: false` cuando hubo ajuste.

Reimportar todos, o solo algunos:

```bash
node scripts/fetch-cards.mjs            # todos los del catálogo
node scripts/fetch-cards.mjs ST-01 ST-13   # solo los indicados
```

## Validación headless

```bash
node scripts/simulate.mjs 12          # partidas bot vs bot
node scripts/simulate.mjs 1 --verbose # con log completo
node scripts/eval.mjs 40              # bot bueno vs bot de referencia
```

## Estructura

```
data/decks/          # starter decks importados (carta a carta)
scripts/             # importación, simulación y evaluación
js/engine/           # cartas, motor de partida, intérprete de efectos (sin DOM)
js/ai/               # bot heurístico
js/ui/               # render del tablero y controlador humano
index.html + css/    # interfaz estática, responsive y táctil
```

La arquitectura está preparada para el multijugador online (acciones
serializables por id, RNG con semilla, motor sin DOM, `game.viewFor(player)`);
ver F7–F9 en `PLAN.md`.
