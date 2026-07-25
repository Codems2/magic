# Plan: Simulador de One Piece Card Game (OPTCG)

Simulador web para jugar al One Piece TCG contra bots, con los mazos de
inicio (Starter Decks) oficiales. Hereda la arquitectura ya probada del
simulador de Magic: Commander construido antes en este repositorio
(recuperable en el historial, commit `2cd0234`).

## 1. Objetivo y alcance (v1)

- Partidas **1 contra 1** (jugador vs bot, y bot vs bot para validación),
  el formato real del juego.
- **Starter Decks oficiales** (ST-01 en adelante) importados con sus listas.
- Reglas base completas: líder, vida, DON!!, combate con bloqueo y counter,
  triggers de vida y las palabras clave del juego.
- Efectos de cartas interpretados desde su texto etiquetado, con objetivo de
  **>90% de cobertura** en los starter decks (el texto de OPTCG es corto y
  muy plantillado; mucho más tratable que el oráculo de Magic).
- Interfaz web estática (sin build), en español, jugable en escritorio y móvil.

Fuera de alcance en v1 (pero **planificado para fases posteriores**): el
**multijugador humano 1v1 online** — ver fases F7–F9. La arquitectura de v1
se decide ya pensando en ello (ver §4b) para que añadirlo no exija reescribir
el motor.

Idioma: el texto de las cartas irá **en inglés** — One Piece TCG no tiene
edición en español, así que no hay fuente que localizar (la interfaz sí será
en español).

Fuera de alcance total: formatos por parejas, cartas promocionales sueltas,
reglas de torneo (tiempos, sideboard, etc.).

## 2. Fuentes de datos (verificadas)

| Necesidad | Fuente | Estado |
|---|---|---|
| Datos de cartas (texto, coste, poder, color, tipo, vida, counter) | **TCGCSV** (`tcgcsv.com/tcgplayer/68/...`, categoría 68 = One Piece) | ✅ Probada: abierta, sin API key, 84 sets, texto con etiquetas `[On Play]`, `[Activate: Main]`… |
| Imágenes de cartas | CDN de TCGplayer (`tcgplayer-cdn.tcgplayer.com/product/<id>_...jpg`) | ✅ URLs incluidas en TCGCSV |
| Listas de los Starter Decks | Los grupos de TCGCSV por mazo (`Starter Deck N: ...`) dan las cartas únicas; las **cantidades** por carta se completan con la lista oficial de Bandai o tabla propia | ✅/⚠ cantidades a completar en el script |
| Alternativa con key | apitcg.com (requiere registro gratuito) | Reserva |

Notas: el texto de TCGCSV trae HTML (`<br>`, `<span>`) y avisos de errata que
el importador debe limpiar. Guardaremos los datos importados en
`data/decks/*.json` como en el proyecto anterior.

## 3. Reglas a implementar

**Preparación**: líder a la zona de líder; barajar 50 cartas; 5 de mano con
un mulligan opcional (una vez); tantas cartas de vida boca abajo como la
vida del líder; 10 DON!! en el mazo de DON.

**Turno** (el primer jugador no roba en su primer turno y coloca 1 DON en
vez de 2):
1. **Refresh**: endereza DON y personajes; los DON dados vuelven al área de coste.
2. **Draw**: roba 1.
3. **DON**: coloca 2 DON del mazo de DON (1 en el primer turno del que empieza).
4. **Main**: jugar personajes (pagando DON), jugar eventos/escenarios,
   activar habilidades `[Activate: Main]`, **dar DON** al líder o personajes
   (+1000 de poder por DON hasta fin de turno), y atacar (cada personaje
   enderezado o el líder, una vez; los personajes no atacan el turno que entran
   salvo `[Rush]`).
5. **End**: efectos de fin de turno; los "hasta fin de turno" expiran.

**Combate** (atacante declara → objetivo: líder o personaje **girado**):
1. Paso de bloqueo: el defensor puede girar un `[Blocker]` para redirigir.
2. Paso de counter: el defensor puede descartar cartas con valor de
   **Counter** (+1000/+2000 al defensor) y/o jugar eventos `[Counter]`.
3. Resolución: si poder atacante ≥ poder defensor —
   - contra **líder**: pierde 1 vida → la carta de vida va a la mano del
     defensor y su `[Trigger]`, si lo tiene, puede activarse;
     con `[Double Attack]` quita 2 vidas; con `[Banish]` la vida va al
     descarte sin trigger. **Si el líder recibe daño sin vidas restantes, pierde.**
   - contra **personaje**: el personaje es KO (al descarte).

**Palabras clave**: `[Rush]`, `[Blocker]`, `[Double Attack]`, `[Banish]`,
`[Trigger]`, y restricciones comunes ("no puede atacar", "no puede ser KO
por efectos"…).

**Etiquetas de habilidades** (la gran ventaja frente a Magic — el timing
viene marcado en el texto):
- `[On Play]` — al entrar en juego.
- `[When Attacking]` — al declarar ataque.
- `[On K.O.]` — al ser KO.
- `[Activate: Main]` (+ `[Once Per Turn]`) — habilidad activada.
- `[On Your Opponent's Attack]` — al ser atacado.
- `[Counter]` — evento jugable en el paso de counter.
- `[Trigger]` — al perder esa carta de vida.
- `[End of Your Turn]`, `[On Block]`, `[DON!! xN]` (condición de DON dados).

**Condiciones de victoria**: dañar al líder rival sin vidas; o el rival no
puede robar de su mazo.

## 4. Arquitectura (heredada del simulador de Magic)

```
scripts/fetch-cards.mjs     # importa sets/mazos desde TCGCSV (+ cantidades)
data/decks/*.json           # starter decks con datos completos por carta
js/engine/cards.js          # modelo de carta/instancia, estados (girado, DON dados)
js/engine/don.js            # economía de DON: colocar, dar, pagar, refrescar
js/engine/effects.js        # intérprete: etiquetas de timing + efectos plantillados
js/engine/battle.js         # ataque → bloqueo → counter → resolución
js/engine/game.js           # turnos, zonas, vida/triggers, victoria
js/ai/bot.js                # bot heurístico
js/ui/*.js                  # tablero 1v1, controlador humano por promesas
scripts/simulate.mjs        # validación headless bot vs bot
index.html + css/           # UI estática, responsive y táctil
```

Decisiones que se conservan del proyecto anterior por haber funcionado bien:
- Motor **sin dependencias del DOM** (se valida headless con Node).
- Decisiones de jugador tras una **interfaz de controlador** (bot y humano
  intercambiables, UI por promesas resueltas con clics/toques).
- Intérprete de efectos **por patrones sobre texto normalizado**, con
  registro `unknown` y aviso ⚠ en la UI para lo no simulado.
- Validación continua: simulaciones headless masivas + Playwright (incl.
  emulación móvil) antes de cada commit.

Diferencias clave a favor: sin pila ni prioridad, un solo recurso (DON),
combate secuencial simple, texto corto y etiquetado, 1v1 (bots más fáciles
de hacer buenos).

## 4b. Decisiones de v1 que preparan el multijugador online

El multijugador llega en F7–F9, pero estas cuatro decisiones se toman desde
la F2 porque cuestan casi nada ahora y evitan una reescritura después:

1. **Toda decisión de jugador pasa por la interfaz de controlador**
   (`mulligan`, `mainAction`, `declareBlock`, `counterStep`…). Un rival
   humano remoto será solo otro controlador (`RemoteController`) que recibe
   sus decisiones por WebSocket — igual que hoy el bot y la UI local son
   intercambiables.
2. **Acciones serializables**: las decisiones se expresan como JSON plano
   referenciando cartas **por id** (`{type:'attack', attackerId, targetId}`),
   nunca por referencia de objeto. Así viajan por la red tal cual.
3. **Aleatoriedad determinista**: todo el azar (barajar, monedas) sale del
   RNG con semilla del motor. Dos réplicas con la misma semilla y la misma
   secuencia de acciones producen la misma partida (lockstep verificable).
4. **Motor sin DOM**: ya corre headless en Node, así que el **servidor
   autoritativo** de F8 ejecuta el mismo `js/engine/` sin cambios. El
   servidor es quien conoce las zonas ocultas (manos, mazos, vidas boca
   abajo) y a cada cliente solo le envía **su vista** de la partida.

## 4c. Fases de multijugador (posteriores a v1)

| Fase | Entregable |
|---|---|
| **F7. Refactor de red** | Acciones 100% serializables por id + vista filtrada del estado por jugador (`game.viewFor(player)`) + reproducción de partidas por log de acciones (replays gratis) |
| **F8. Servidor autoritativo** | Node + WebSocket ejecutando el motor; salas por código (amigo vs amigo), reconexión, relojes de turno básicos; el cliente reutiliza la UI de F5 con un `RemoteController` |
| **F9. Despliegue online** | El estático sigue en Vercel; el servidor WebSocket en un host con procesos persistentes (Fly.io/Railway/Render). Opcional: emparejamiento aleatorio y espectadores |

## 5. Fases y criterios de éxito

| Fase | Entregable | Validación |
|---|---|---|
| **F1. Datos** | `fetch-cards.mjs` + 4–6 starter decks en `data/decks/` (p. ej. ST-01 Luffy, ST-02 Zoro… con cantidades correctas) | JSON completos: 50+1 cartas, coste/poder/counter/texto limpios |
| **F2. Motor base** | Turnos, DON, jugar personajes, combate sin efectos, vida/triggers vacíos, victoria | Sim headless: 2 bots terminan partidas legales sin errores |
| **F3. Efectos** | Intérprete de etiquetas + patrones de efectos de los starter decks (draw, +poder, KO, rest, DON extra, buscar…) | >90% de cartas de los mazos importados sin ⚠ |
| **F4. Bots** | Heurísticas: curva de DON, cuándo dar DON, a qué atacar (líder vs personajes), cuándo bloquear/counterear y con cuánto | Partidas espejo y cruzadas equilibradas; decisiones razonables en logs |
| **F5. UI** | Tablero 1v1 (líder, vida, DON, personajes, mano), targeting, ventana de counter, móvil + pulsación larga | Playwright: partida completa con clics y con toques |
| **F6. Pulido** | Español donde haya fuente, más mazos, README | Igual que el proyecto anterior |

Metodología por fase: igual que hasta ahora — cada fase se cierra con tests
unitarios del parser, simulaciones headless sin crashes y commit/push.

## 6. Riesgos y decisiones abiertas

1. **Cantidades de las listas**: TCGCSV da las cartas únicas de cada Starter
   Deck pero no cuántas copias lleva; se completará con la web oficial de
   Bandai o una tabla en el importador (los ST tienen ~17 cartas únicas, es
   asumible incluso a mano).
2. **Imágenes**: el CDN de TCGplayer sirve `_200w`; hay tamaños mayores pero
   conviene mantener el respaldo de texto que ya usamos en Magic.
3. **Idioma**: resuelto — no existe edición española de OPTCG, así que el
   texto de carta queda en inglés de forma permanente y solo se localiza la
   interfaz.
4. **Erratas**: TCGCSV mezcla avisos de reimpresión en la descripción; el
   importador debe filtrarlos.
5. **Counter del rival como decisión oculta**: el bot no debe "ver" la mano
   del humano al decidir ataques (usar estimaciones, no información real).
6. **Multijugador**: los WebSockets persistentes no encajan en Vercel
   serverless → el servidor de F8 irá en un host aparte; y la información
   oculta obliga a que el árbitro sea el servidor, nunca el cliente rival.
