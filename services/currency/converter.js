/**
 * services/currency/converter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Currency conversion on top of rates.js. Pure functions: no stored
 * preference, no DOM, no Atmos APIs, so the module runs unchanged in the
 * Atmos page and inside a framed consumer (Currency is a library service).
 * Which currency to *display* is the consumer's own choice and state; pass
 * it to convertFromGbp().
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getRates, ratesReady, BASE_CURRENCY } from './rates.js';

// symbol → ISO  (used to decode plugin currency strings)
const _SYM_TO_ISO = { '£':'GBP', '$':'USD', '€':'EUR', 'Fr':'CHF', 'C$':'CAD', 'A$':'AUD' };
// ISO → display symbol
const _ISO_TO_SYM = { GBP:'£', USD:'$', EUR:'€', CHF:'Fr', CAD:'C$', AUD:'A$' };

// Currencies offered in any output-currency selector
export const OUTPUT_CURRENCIES = [
  { iso:'GBP', label:'£ GBP' },
  { iso:'USD', label:'$ USD' },
  { iso:'EUR', label:'€ EUR' },
  { iso:'CHF', label:'Fr CHF' },
];

export function isoFromSymbol(sym) { return _SYM_TO_ISO[sym] ?? sym; }
export function symbolForIso(iso) { return _ISO_TO_SYM[iso] ?? iso; }
export function isOutputCurrency(iso) { return OUTPUT_CURRENCIES.some(c => c.iso === iso); }

// amount in fromCurrency (ISO code or symbol) → GBP
export function convertToGbp(amount, fromCurrency) {
  if (!amount || !isFinite(amount)) return 0;
  const iso = isoFromSymbol(fromCurrency);
  if (iso === BASE_CURRENCY) return amount;
  const rates = getRates();
  if (!ratesReady() || !rates[iso]) return amount; // graceful fallback
  return amount / rates[iso];
}

// GBP → toCurrency (ISO code or symbol; GBP when omitted)
export function convertFromGbp(gbpAmount, toCurrency = BASE_CURRENCY) {
  const iso = isoFromSymbol(toCurrency);
  if (iso === BASE_CURRENCY || !ratesReady()) return gbpAmount;
  const rate = getRates()[iso];
  return rate ? gbpAmount * rate : gbpAmount;
}
