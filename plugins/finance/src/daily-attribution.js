/**
 * js/plugins/portfolio-tracker/src/daily-attribution.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns two composition snapshots (see totals.js's getPortfolioComposition
 * and compositionFromHoldingsSnapshot -- same { assets: [{ symbol, kind,
 * value, quantity }] } shape either way, one for "now" and one for some
 * earlier poll) into two derived views over that window:
 *
 *   - movers: each held asset's own $ change over the window, ranked by
 *     the size of that $ move rather than its %, so a large position's
 *     small % move can outrank a tiny position's big swing.
 *   - flow: how much of the total change was an actual market price move
 *     versus money added/removed (a deposit, withdrawal, or transfer).
 *
 * The flow split is an approximation, not a ledger entry. With only
 * periodic polls (not per-transaction webhooks) there's no way to know
 * exactly when in the window a quantity changed or at what price. Each
 * symbol's quantity delta is valued at its most recently known per-unit
 * price (now, if the position is still open; the window's start price,
 * if it was fully closed out) -- close enough to explain "why did my
 * balance move", not precise enough for tax/accounting use.
 * ─────────────────────────────────────────────────────────────────────────────
 */

function perUnitPrice(value, quantity) {
  return quantity > 0 ? value / quantity : null;
}

/**
 * @param {{assets: Array<{symbol: string, kind: string, value: number, quantity: number|null}>}} current
 * @param {{assets: Array<{symbol: string, kind: string, value: number, quantity: number|null}>}} previous
 * @returns {{
 *   movers: Array<{symbol: string, kind: string, valueChange: number, percentChange: number|null}>,
 *   flow: {market: number, deposits: number, withdrawals: number, net: number},
 *   flowConfident: boolean,
 * }}
 */
export function computeDailyAttribution(current, previous) {
  const now = new Map((current?.assets ?? []).map(asset => [`${asset.kind}:${asset.symbol.toUpperCase()}`, asset]));
  const then = new Map((previous?.assets ?? []).map(asset => [`${asset.kind}:${asset.symbol.toUpperCase()}`, asset]));
  const keys = new Set([...now.keys(), ...then.keys()]);

  const movers = [];
  // Per-symbol contributions behind each flow bucket -- surfaced in the
  // Flow rows' tooltips (see balance.js's _renderFlow) so "why does this
  // say +$3,300" has a concrete answer instead of just the total.
  const depositContributors = [];
  const withdrawalContributors = [];
  let market = 0, deposits = 0, withdrawals = 0, flowConfident = false;

  for (const key of keys) {
    const nowAsset = now.get(key);
    const thenAsset = then.get(key);
    const nowValue = nowAsset?.value ?? 0;
    const thenValue = thenAsset?.value ?? 0;
    const valueChange = nowValue - thenValue;
    const symbol = nowAsset?.symbol ?? thenAsset?.symbol;
    const kind = nowAsset?.kind ?? thenAsset?.kind;

    // A symbol missing from one side's map entirely -- not merely present
    // with an unknown quantity, but absent -- means the position was fully
    // closed out (or freshly opened) between the two snapshots. That side's
    // true quantity is known to be exactly 0, even for a source that
    // doesn't report quantity for symbols it's still actually holding.
    // Without this, "sold the whole position" was indistinguishable from
    // "quantity was never tracked for this symbol" below, and a full exit
    // -- even one sold at a profit -- dumped its entire value into
    // unattributed "market movement", which could read as a large loss.
    const nowQty = nowAsset
      ? nowAsset.quantity
      : (Number.isFinite(thenAsset?.quantity) ? 0 : undefined);
    const thenQty = thenAsset
      ? thenAsset.quantity
      : (Number.isFinite(nowAsset?.quantity) ? 0 : undefined);

    // Work out how much of this symbol's $ change was buying/selling
    // (flow) versus the position's price actually moving (market) --
    // same split either way, just done once up front now so Movers can
    // use the market-only figure below instead of the raw delta, which
    // otherwise conflates "price dropped" with "I sold some of it".
    let symbolMarketChange = valueChange;
    let symbolPercentChange = thenValue > 0 ? (valueChange / thenValue) * 100 : null;

    if (!Number.isFinite(nowQty) || !Number.isFinite(thenQty)) {
      // Quantity isn't tracked for this source/asset -- this symbol's
      // change can't be split into flow vs market, so it's left as
      // unattributed market movement rather than guessed at.
      market += valueChange;
    } else {
      flowConfident = true;
      const qtyChange = nowQty - thenQty;
      const thenPrice = perUnitPrice(thenValue, thenQty);
      const nowPrice = perUnitPrice(nowValue, nowQty);
      if (Math.abs(qtyChange) < 1e-9) {
        market += valueChange;
      } else {
        const price = nowPrice ?? thenPrice;
        const flowValue = price != null ? qtyChange * price : valueChange;
        if (flowValue >= 0) {
          deposits += flowValue;
          depositContributors.push({ symbol, amount: flowValue });
        } else {
          withdrawals += flowValue;
          withdrawalContributors.push({ symbol, amount: flowValue });
        }
        symbolMarketChange = valueChange - flowValue;
        market += symbolMarketChange;
      }
      // Price % move, not $-value % move -- so selling half a position
      // that hasn't budged in price still reads as ~0%, not -50%.
      if (thenPrice != null && nowPrice != null && thenPrice > 0) {
        symbolPercentChange = ((nowPrice / thenPrice) - 1) * 100;
      }
    }

    // Movers list is "what moved in price", not cash flowing in/out --
    // buying or selling a position is the flow split above, and doesn't
    // belong here even though it changes the position's $ value too. A
    // one-cent threshold just drops rounding noise from symbols that are
    // effectively unchanged in price.
    if (kind === 'invested' && Math.abs(symbolMarketChange) >= 0.01) {
      movers.push({
        symbol,
        kind,
        valueChange: symbolMarketChange,
        percentChange: symbolPercentChange,
      });
    }
  }

  movers.sort((a, b) => Math.abs(b.valueChange) - Math.abs(a.valueChange));
  depositContributors.sort((a, b) => b.amount - a.amount);
  withdrawalContributors.sort((a, b) => a.amount - b.amount);

  return {
    movers,
    flow: { market, deposits, withdrawals, net: market + deposits + withdrawals },
    flowConfident,
    depositContributors,
    withdrawalContributors,
  };
}
