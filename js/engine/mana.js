// Sistema de maná: fuentes disponibles y pago automático de costes.

// Colores que puede producir un permanente al girarse.
export function producibleColors(perm, game) {
  if (perm.zone !== 'battlefield' || perm.tapped) return null;
  const isCreatureSource = perm.isCreature;
  if (isCreatureSource && perm.summoningSick && !perm.hasKeyword('haste', game)) return null;

  if (perm.data.producedMana && perm.data.producedMana.length) {
    // Solo si de verdad es una habilidad de maná con {T} (o una tierra).
    if (perm.isLand || /\{T\}[^:]*: add/i.test(perm.oracleText)) {
      return perm.data.producedMana.filter((c) => 'WUBRGC'.includes(c));
    }
  }
  return null;
}

export function manaSources(player, game) {
  const out = [];
  for (const perm of player.battlefield) {
    const colors = producibleColors(perm, game);
    if (colors && colors.length) out.push({ perm, colors });
  }
  return out;
}

// Convocar: las criaturas sin girar pueden pagar {1} o maná de su color.
export function convokeSources(player, game) {
  return player.creatures()
    .filter((c) => !c.tapped)
    .map((c) => ({ perm: c, colors: (c.data.colors?.length ? c.data.colors : ['C']), convoke: true }));
}

export function sourcesFor(player, game, card) {
  const out = manaSources(player, game);
  if (card?.script?.convoke) out.push(...convokeSources(player, game));
  return out;
}

// Resuelve qué fuentes girar para pagar un coste { generic, pips, x } con
// xValue elegido. Devuelve la lista de fuentes o null si no alcanza.
// Estrategia: pips de color primero (fuentes con menos opciones primero),
// genérico después (prefiriendo fuentes incoloras / de más opciones).
export function solvePayment(cost, sources, xValue = 0) {
  const totalNeeded = cost.generic + cost.pips.length + cost.x * xValue;
  if (sources.length < totalNeeded) return null;

  const pool = sources.slice();
  const used = [];

  // Pips más restrictivos primero.
  const pips = cost.pips.slice().sort((a, b) => a.length - b.length);
  for (const options of pips) {
    let bestIdx = -1; let bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const src = pool[i];
      if (!src.colors.some((c) => options.includes(c))) continue;
      // Preferir la fuente menos flexible; las criaturas (convocar) al final.
      const score = src.colors.length + (src.convoke ? 10 : 0);
      if (score < bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx === -1) return null;
    used.push(pool.splice(bestIdx, 1)[0]);
  }

  let genericNeeded = cost.generic + cost.x * xValue;
  // Para el genérico, gastar primero las fuentes más flexibles/incoloras.
  pool.sort((a, b) => {
    const aC = (a.colors.includes('C') && a.colors.length === 1 ? -1 : a.colors.length) + (a.convoke ? 100 : 0);
    const bC = (b.colors.includes('C') && b.colors.length === 1 ? -1 : b.colors.length) + (b.convoke ? 100 : 0);
    return aC - bC;
  });
  while (genericNeeded > 0) {
    if (!pool.length) return null;
    used.push(pool.shift());
    genericNeeded--;
  }
  return used;
}

// Maná máximo disponible (para heurísticas de los bots).
export function availableMana(player, game) {
  return manaSources(player, game).length;
}

export function canPay(cost, player, game, xValue = 0) {
  return solvePayment(cost, manaSources(player, game), xValue) !== null;
}

// Máximo X pagable para un coste con {X}.
export function maxAffordableX(cost, player, game) {
  const sources = manaSources(player, game);
  let x = 0;
  while (solvePayment(cost, sources, x + 1)) x++;
  return x;
}
