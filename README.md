# ⚔️ Simulador de Magic: Commander

Simulador web para jugar **Commander (EDH)** contra bots, usando **mazos
preconstruidos reales** y datos de cartas de APIs públicas.

## Cómo jugar

Es una aplicación web estática, sin dependencias ni build. Sirve la carpeta
con cualquier servidor estático y abre el navegador:

```bash
python3 -m http.server 8000
# o: npx serve .
```

Abre <http://localhost:8000>, elige tu mazo, el número de bots (1–3) y juega.
Funciona también en **móvil** (diseño adaptable): toca para jugar cartas,
mantén pulsada cualquier carta para verla en grande y usa el botón 📜 para
mostrar u ocultar el registro de la partida.

- **Fase principal**: haz clic en una carta de la mano (o en tu comandante en
  la zona de mando) para jugarla; el maná se paga automáticamente girando
  tierras. Clic en equipos/permanentes del campo para equipar o activar
  habilidades.
- **Combate**: selecciona atacantes y haz clic en el oponente a atacar.
  Cuando te ataquen, podrás responder con instantáneos y declarar bloqueos.
- Pasa el ratón por una carta para verla en grande.

## Los datos: APIs públicas

| Qué | Fuente |
|---|---|
| Listas de los mazos preconstruidos | [MTGJSON](https://mtgjson.com) (`/api/v5/decks/…`) |
| Datos e imágenes de cada carta | [Scryfall](https://scryfall.com/docs/api) (`/cards/collection`) |

Las listas ya están **importadas** en `data/precons/`: el catálogo completo de
precons de Commander publicados en MTGJSON (178 mazos, desde los Commander
2013 hasta los más recientes, sin duplicar las ediciones de coleccionista),
con buscador por nombre, comandante, colores o colección en la pantalla
inicial. Las imágenes se cargan en tiempo real desde Scryfall; sin conexión
se muestra el texto de la carta.

**Cartas en español**: `data/es.json` guarda, para cada carta del catálogo,
su impresión española más reciente en Scryfall (nombre, tipo, texto e
imagen impresos) — cubre el 93% del catálogo (5.813 de 6.257 cartas). El
simulador la usa automáticamente para mostrar cartas, registro y vista
previa; las cartas que nunca se imprimieron en español (p. ej. Universes
Beyond recientes) se muestran en inglés. Internamente el motor sigue
interpretando el texto de oráculo en inglés (Scryfall solo lo mantiene en
ese idioma), así que la localización no cambia las reglas.

Para reimportar el catálogo completo y regenerar la localización:

```bash
node scripts/fetch-precons.mjs   # listas + datos de carta (inglés)
node scripts/fetch-spanish.mjs   # impresiones españolas → data/es.json
```

## Reglas de Commander implementadas

- 4 jugadores (tú + hasta 3 bots), 40 vidas, multijugador libre.
- Zona de mando, impuesto del comandante (+{2} por lanzamiento) y regreso a
  la zona de mando al morir/exiliarse.
- Derrota por 21+ de daño de combate de un mismo comandante.
- Mulligan de Londres, turnos completos (enderezar, mantenimiento, robo,
  principal, combate con bloqueos, segunda principal, final y descarte).
- Combate con volar, alcance, arrollar, toque mortal, vínculo vital, primer
  golpe, doble golpe, amenaza, velo, indestructible, vigilancia, prisa…

## Motor de efectos

`js/engine/effects.js` interpreta el texto de oráculo real de cada carta y lo
traduce a operaciones ejecutables: robar, daño, destruir/exiliar, barreduras,
fichas, tesoros, rampa de tierras, contadores +1/+1, anthems, equipos, auras,
contrahechizos, adivinar, molino, descarte, reanimación y disparos (al entrar,
al morir, al atacar, al hacer daño de combate, en el mantenimiento…).

Aproximadamente la mitad de las cartas no básicas de los precons tienen al
menos una mecánica simulada; el resto funciona como cuerpos/permanentes
"vanilla" (el log avisa con "parte de su texto no está simulado"). El
simulador es fiel en estructura pero no replica las ~2000 palabras clave de
Magic: es un simulador para jugar, no un juez de reglas.

## Los bots

`js/ai/bot.js` juega con heurísticas reales de Commander:

- Mulligan por calidad de mano y curva de maná (rampa temprana, tierras que
  aportan colores que faltan).
- Evaluación de amenazas por oponente (mesa, comandante, mano, vidas) y
  política multijugador: presiona al líder.
- Combate calculado: solo ataca cuando es rentable, bloquea para hacer
  trades favorables y hace chump-block para no morir.
- Removal reservado para amenazas de valor, barreduras solo cuando va por
  detrás y contrahechizos guardados para hechizos caros o barreduras.

## Validación headless

```bash
node scripts/simulate.mjs 10          # 10 partidas bot-vs-bot
node scripts/simulate.mjs 1 --verbose # con log completo de la partida
```

## Estructura

```
data/precons/        # mazos importados (JSON con datos de cada carta)
scripts/             # importación (MTGJSON+Scryfall) y simulación headless
js/engine/           # cartas, maná, efectos, partida (sin dependencias del DOM)
js/ai/               # IA de los bots
js/ui/               # render del tablero y controlador humano
```
