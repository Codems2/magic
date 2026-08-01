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

### 🛠 Mazos custom (todo el pool)

`data/cards/catalog.json` contiene el pool completo en inglés (2.721 cartas
únicas de los 84 sets, importadas con `node scripts/fetch-all.mjs`). El botón
**🛠 Mis mazos** abre el constructor: elige líder, busca por nombre/ID/tipo/
subtipo con filtros de color, y monta el mazo con las reglas reales (50
cartas exactas, máx. 4 copias, colores del líder). Los mazos se guardan en tu
navegador, aparecen en el selector (etiqueta CUSTOM), se pueden duplicar,
exportar/importar como JSON, y valen contra el bot, en sandbox (cuyo buscador
ahora usa el catálogo completo) y **online** (el cliente envía la lista y el
servidor la valida y materializa).

Cobertura de efectos sobre el pool completo: **~82% de las cartas totalmente
simuladas** (82,4% de las frases de reglas). El resto muestra ⚠ con la frase
exacta que aún no se simula y juega con normalidad todo lo demás (cuerpo,
counter y las habilidades que sí se reconocen). `node scripts/catalog-smoke.mjs`
juega las 2.721 cartas en el motor real: 0 errores.

### 🏆 Niveles del bot

En la pantalla de mazos eliges el nivel del rival:

- **🐣 Normal** (`js/ai/bot.js`): heurístico de una jugada — curva, ataques
  con cuentas simples y defensa por reglas fijas.
- **🏆 Competitivo** (`js/ai/hardbot.js`): añade cálculo de **letal**
  (detecta cuándo puede rematar y va all-in con el DON!! y el orden de
  ataques correctos), disciplina de counters según el calendario de vidas,
  banca de DON!! para sus eventos [Counter], secuencia de ataques por valor y
  mulligan por calidad de curva. Arena espejo: gana ~78% al normal
  (`node scripts/arena.mjs 32 hard-normal`).
- **🧠 Maestro** (`js/ai/searchbot.js`, por defecto): búsqueda por
  simulación (PIMC) sobre el motor real. En cada decisión enumera sus
  acciones legales y, para cada una, fotografía el estado
  (`Game.snapshotState/restoreState`), **baraja lo que no ha visto** (mano y
  mazo del rival, su propio mazo — se adapta al robo sin hacer trampas),
  aplica la acción, termina el turno con una política rápida, cierra el
  turno de verdad ([End of Your Turn] incluido) y simula el **turno de
  respuesta del rival**; puntúa con vidas marginales (la última vale mucho
  más que la quinta), tablero, mano y tempo de DON!!. Usa números
  aleatorios comunes entre candidatas (misma "suerte" imaginada) para que
  la comparación mida la jugada y no la varianza. Arena espejo: gana ~80%
  al Competitivo (`node scripts/arena.mjs 64 search-hard`). Si algo falla
  en simulación, degrada solo a Competitivo.

### 🧭 Coach del ST-36

Si juegas el **ST-36 (Eustass"Captain"Kid)** se activa solo un entrenador
(`js/ui/coach.js`): un panel lateral con la situación y el plan del turno
(bajadas, activaciones, ataques con la cuenta exacta y el combo del líder), y
consejos razonados dentro de cada diálogo — mulligan, bloqueos, counters,
triggers y costes opcionales. Usa las mismas heurísticas que el bot y el
conocimiento del mazo carta a carta. La cabecera del panel lo pliega/despliega
(se recuerda). Se valida en headless con `node scripts/coach-check.mjs`.

## 🌐 Multijugador online (1v1 con un amigo)

El online usa un **servidor autoritativo**: el motor corre solo en el
servidor y cada navegador recibe únicamente SU vista (la mano y las vidas
del rival nunca llegan a tu navegador — no se puede hacer trampa).

El servidor es **unificado**: un mismo proceso sirve el juego Y las salas
online. Así el multijugador funciona **sin configurar nada** (la página y el
WebSocket salen del mismo origen, `wss://` automático).

### Desplegarlo en Internet (recomendado, 1 clic)

El estático de Vercel no soporta WebSockets, así que el online vive en el
servidor. Con [Render](https://render.com) (gratis) y el `render.yaml` del
repo es un clic:

1. En Render: **New → Blueprint** → elige este repositorio → **Apply**.
2. Render provisiona un servicio y te da una URL
   `https://optcg-simulator.onrender.com`.
3. Abre esa URL y juega: **⚓ Crear sala** te da un código; tu amigo lo pega
   en **Unirse**. Nada más — el campo "Servidor" se deja vacío.

Recargar la página no pierde la partida (reconexión por token). En el plan
gratuito el servidor se duerme tras 15 min de inactividad: la primera
conexión del día tarda ~30 s en despertarlo.

### Probarlo en local

```bash
cd server && npm install && npm start     # sirve juego + salas en :8765
```

Abre dos pestañas en <http://localhost:8765> (el mismo servidor sirve el
juego): crea sala en una, únete con el código en la otra.

### Variante: juego en Vercel + servidor aparte

Si prefieres seguir sirviendo el estático desde Vercel, despliega solo el
servidor y en el lobby, desplegable **"Servidor"**, escribe
`wss://tu-app.onrender.com`. Debe ser `wss://` (una web HTTPS no puede
hablar con `ws://`).

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
