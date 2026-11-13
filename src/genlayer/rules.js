/**
 * Display math and input checks. The contract is the authority for escrow.
 * The vectors in tests/rules.node.test.js match tests/test_rules.py.
 */

export const VERSION = "1.0.0-bandlot";
export const ZONES = ["DE-LU", "AT", "BE", "FR", "NL"];
export const WEI_PER_EUR_CENT = 10n ** 12n;
export const MIN_PAY_WEI = 10n ** 15n;
export const DEMO_ZONE = "DE-LU";
export const DEMO_DATE = "2026-11-12";

const ERRORS = {
  bad_zone: "Zone must be DE-LU, AT, BE, FR, or NL.",
  bad_date: "Use a real calendar date, YYYY-MM-DD, through 2035.",
  bad_quarter: "That interval is not in the pinned series.",
  bad_mwh: "Size is a whole number of megawatt-hours, from 1 to 20.",
  bad_markup: "Markup is a whole number of basis points from -2000 to 5000. 100 is 1.00%.",
  bad_partial: "Partial must be yes or no.",
  bad_note: "The note is longer than 80 characters.",
  bad_expiry: "Expiry must be between 10 minutes and 7 days.",
  bad_address: "That address is not a 20-byte account.",
  print_not_pinned: "Pin this delivery day before posting. The book does not take a typed price.",
  negative_or_zero_print: "This interval's print is zero or negative, so it cannot clear.",
  book_full: "This contract holds 48 asks and 48 bids. That side of the book is full.",
  wrong_escrow: "The attached GEN is not the contract's escrow. Reload the quote and send that amount.",
  unexpected_value: "This call does not take GEN.",
  bid_not_open: "That bid is not funded.",
  bid_not_found: "No bid with that id.",
  ask_not_found: "No ask with that id.",
  ask_not_open: "That ask is no longer open.",
  not_seller: "Only the seller can cancel this ask.",
  not_buyer: "Only the buyer can refund this bid before it expires.",
  not_expired: "This order has not reached its expiry.",
  bid_expired: "This bid is past expiry. Retire it to refund the escrow.",
  no_compatible_ask: "No open ask fits this bid. Markup, size, interval, or account does not match.",
  price_too_small: "The indexed notional is below the minimum settlement of 0.001 GEN.",
  pay_exceeds_escrow: "The matched pay is larger than the escrow. Nothing was transferred.",
  bad_fill: "The fill does not add up to the escrow. Nothing was transferred.",
  nothing_to_refund: "This bid has no escrow left.",
  print_moved: "The pinned print for this interval does not match the bid. Nothing was transferred.",
  unreadable: "The print could not be read. Nothing was stored.",
  invalid_consensus_payload: "Validators did not accept the print record. Nothing was stored.",
  fetch_failed: "The price URL could not be fetched. Nothing was stored.",
  http_error: "The price URL returned an error. Nothing was stored. Wait and pin again.",
  empty_body: "The price URL returned an empty body. Nothing was stored.",
  body_too_large: "The price response was too large. Nothing was stored.",
  not_json: "The price response was not JSON. Nothing was stored.",
  missing_prices: "The response had no price series. Nothing was stored.",
  bad_price_scale: "A price had more than two decimal places. Nothing was stored.",
  price_out_of_range: "A price was outside the published cap. Nothing was stored.",
  bad_resolution: "The series was not 92, 96, or 100 intervals. Nothing was stored.",
  bad_step: "The timestamps were not 15 minutes apart. Nothing was stored.",
  bad_unix: "The timestamps were not usable. Nothing was stored.",
  clock_skew: "The series does not start near that delivery date. Nothing was stored.",
  bad_unit: "The series unit was not EUR / MWh. Nothing was stored.",
  deprecated_series: "The publisher marked this series deprecated. Nothing was stored.",
  missing_fields: "The series was missing prices or timestamps. Nothing was stored.",
};

export function errorText(error) {
  const raw = String(error?.message || error || "").trim();
  if (!raw) return "The transaction failed.";
  const code = raw.split(/\s+/).pop().replace(/[:.]+$/, "");
  if (ERRORS[code]) return ERRORS[code];
  for (const key of Object.keys(ERRORS)) {
    if (raw.includes(key)) return ERRORS[key];
  }
  return raw;
}

export function sourceUrl(zone, date) {
  return `https://api.energy-charts.info/price?bzn=${zone}&start=${date}&end=${date}`;
}

export function unitCents(priceCents, markupBps) {
  return (BigInt(priceCents) * (10000n + BigInt(markupBps))) / 10000n;
}

export function notionalWei(priceCents, markupBps, mwh) {
  const units = unitCents(priceCents, markupBps);
  if (units <= 0n) throw new Error("price_too_small");
  const wei = units * BigInt(mwh) * WEI_PER_EUR_CENT;
  if (wei < MIN_PAY_WEI) throw new Error("price_too_small");
  return wei;
}

export function formatGen(wei) {
  const value = BigInt(wei);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${neg ? "-" : ""}${whole.toString()}.${frac} GEN`;
}

export function formatEur(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return "—";
  const neg = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function formatBps(bps) {
  const value = Number(bps);
  if (!Number.isFinite(value)) return "—";
  const neg = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "−" : "+"}${whole}.${frac}%`;
}

export function intervalLabel(index) {
  const i = Number(index);
  const mins = i * 15;
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `Q${String(i).padStart(2, "0")} · ${hh}:${mm}`;
}

export function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
}

export function shortAddress(value) {
  const text = String(value || "");
  if (text.length < 12) return text || "—";
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function parseCents(record) {
  const text = String(record?.cents || "");
  if (!/^-?\d+(?:,-?\d+)*$/.test(text)) return [];
  return text.split(",").map((part) => Number(part));
}
