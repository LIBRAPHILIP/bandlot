# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Bandlot — a day-ahead lot book.

Sellers offer a megawatt-hour notional on one interval of a bidding zone.
They do not type the euro price. They type a markup, in basis points, over
the day-ahead print. Buyers escrow the most they will pay over that same
print. GEN moves only when this contract pins the print and then matches
the bid to the cheapest compatible ask.

The print URL is built here:

  https://api.energy-charts.info/price?bzn=<zone>&start=<date>&end=<date>

For DE-LU, AT, and BE that series is the Bundesnetzagentur | SMARD.de
day-ahead auction, republished by energy-charts.info under CC BY 4.0.
The LLM is not called. A party cannot submit the price. An unreadable
response does not pin, and a failed pin does not move GEN.

This settles an indexed notional on Studionet. It does not schedule a
power plant and it does not claim that one GEN buys one euro.
"""

from genlayer import *

import json
import time
import typing


# RULES_START
import json
import re

VERSION = "1.0.0-bandlot"
ZONES = ("DE-LU", "AT", "BE", "FR", "NL")
RESOLUTIONS = (92, 96, 100)
WEI_PER_EUR_CENT = 10**12
MIN_PAY_WEI = 10**15
PRICE_CAP_CENTS = 100000
MARKUP_MIN = -2000
MARKUP_MAX = 5000
MIN_MWH = 1
MAX_MWH = 20
MIN_EXPIRY_SECS = 600
MAX_EXPIRY_SECS = 7 * 24 * 3600
MAX_ORDERS = 48
CLOCK_SKEW_SECS = 6 * 3600
BODY_CAP = 200000
UNIT = "EUR / MWh"

PRINT_FIELDS = (
    "zone",
    "date",
    "source",
    "outcome",
    "reason",
    "count",
    "first_unix",
    "step",
    "cents",
    "unit",
)
PINNED_REASONS = ("quarter_grid",)
UNREADABLE_REASONS = (
    "fetch_failed",
    "http_error",
    "empty_body",
    "body_too_large",
    "not_json",
    "missing_prices",
    "bad_price_scale",
    "price_out_of_range",
    "bad_resolution",
    "bad_step",
    "bad_unix",
    "clock_skew",
    "bad_unit",
    "deprecated_series",
    "missing_fields",
)

_DATE = re.compile(r"^(20[2-9][0-9])-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")
_ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
_CENTS = re.compile(r"^-?\d+(?:,-?\d+)*$")


def source_url(zone: str, date: str) -> str:
    return (
        "https://api.energy-charts.info/price?bzn="
        + zone
        + "&start="
        + date
        + "&end="
        + date
    )


def print_key(zone: str, date: str) -> str:
    return zone + "|" + date


def _leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def valid_date(text: str) -> bool:
    match = _DATE.match(text or "")
    if not match:
        return False
    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    if year > 2035:
        return False
    lengths = [0, 31, 29 if _leap(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return day <= lengths[month]


def civil_to_unix(year: int, month: int, day: int) -> int:
    # Howard Hinnant, days_from_civil. Public-domain calendar math.
    year_adj = year - 1 if month <= 2 else year
    era = year_adj // 400 if year_adj >= 0 else (year_adj - 399) // 400
    yoe = year_adj - era * 400
    month_adj = month - 3 if month > 2 else month + 9
    doy = (153 * month_adj + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    days = era * 146097 + doe - 719468
    return days * 86400


def parse_zone(raw: str) -> str:
    zone = (raw or "").strip().upper()
    if zone not in ZONES:
        raise ValueError("bad_zone")
    return zone


def parse_date(raw: str) -> str:
    text = (raw or "").strip()
    if not valid_date(text):
        raise ValueError("bad_date")
    return text


def parse_market(zone: str, date: str) -> tuple:
    return parse_zone(zone), parse_date(date)


def parse_quarter(raw: str) -> int:
    text = (raw or "").strip()
    if not re.fullmatch(r"(?:0|[1-9][0-9]?)", text):
        raise ValueError("bad_quarter")
    quarter = int(text)
    if quarter > 99:
        raise ValueError("bad_quarter")
    return quarter


def parse_mwh(raw: str) -> int:
    text = (raw or "").strip()
    if not re.fullmatch(r"[1-9][0-9]{0,2}", text):
        raise ValueError("bad_mwh")
    mwh = int(text)
    if mwh < MIN_MWH or mwh > MAX_MWH:
        raise ValueError("bad_mwh")
    return mwh


def parse_markup(raw: str) -> int:
    text = (raw or "").strip()
    if not re.fullmatch(r"-?(?:0|[1-9][0-9]{0,3})", text):
        raise ValueError("bad_markup")
    markup = int(text)
    if markup < MARKUP_MIN or markup > MARKUP_MAX:
        raise ValueError("bad_markup")
    return markup


def parse_partial(raw: str) -> str:
    text = (raw or "").strip().lower()
    if text not in ("yes", "no"):
        raise ValueError("bad_partial")
    return text


def parse_expiry(raw: str) -> int:
    text = (raw or "").strip()
    if not re.fullmatch(r"[1-9][0-9]{0,7}", text):
        raise ValueError("bad_expiry")
    secs = int(text)
    if secs < MIN_EXPIRY_SECS or secs > MAX_EXPIRY_SECS:
        raise ValueError("bad_expiry")
    return secs


def parse_address(raw: str) -> str:
    text = (raw or "").strip().lower()
    if not _ADDRESS.match(text) or text == "0x" + ("0" * 40):
        raise ValueError("bad_address")
    return text


def clip_text(raw: str, limit: int, code: str) -> str:
    text = "".join(ch for ch in (raw or "") if ch >= " " and ch != "\x7f")
    text = " ".join(text.split())
    if len(text) > limit:
        raise ValueError(code)
    return text


def unit_cents(price_cents: int, markup_bps: int) -> int:
    # Floor division is the published rounding. 224.90 at +100 bps is 227.14, not 227.15.
    return int(price_cents) * (10000 + int(markup_bps)) // 10000


def notional_wei(price_cents: int, markup_bps: int, mwh: int) -> int:
    units = unit_cents(price_cents, markup_bps)
    if units <= 0:
        raise ValueError("price_too_small")
    wei = units * int(mwh) * WEI_PER_EUR_CENT
    if wei < MIN_PAY_WEI:
        raise ValueError("price_too_small")
    return wei


def _blank_print(zone: str, date: str, source: str) -> dict:
    return {
        "zone": zone,
        "date": date,
        "source": source,
        "outcome": "unreadable",
        "reason": "fetch_failed",
        "count": "0",
        "first_unix": "",
        "step": "",
        "cents": "",
        "unit": "",
    }


def _fail_print(rec: dict, reason: str) -> dict:
    rec["outcome"] = "unreadable"
    rec["reason"] = reason
    rec["count"] = "0"
    rec["first_unix"] = ""
    rec["step"] = ""
    rec["cents"] = ""
    rec["unit"] = ""
    return rec


def _token_cents(token: str) -> int:
    neg = token.startswith("-")
    body = token[1:] if neg else token
    if "." in body:
        whole, frac = body.split(".", 1)
        if frac == "" or len(frac) > 2:
            raise ValueError("bad_price_scale")
        frac = (frac + "00")[:2]
        if whole == "":
            whole = "0"
        cents = int(whole) * 100 + int(frac)
    else:
        if body == "":
            raise ValueError("bad_price_scale")
        cents = int(body) * 100
    if cents > PRICE_CAP_CENTS:
        raise ValueError("price_out_of_range")
    return -cents if neg else cents


def _array_body(body: str, key: str):
    match = re.search('"' + key + r'"\s*:\s*\[(.*?)\]', body, re.S)
    if not match:
        return None
    return match.group(1)


def _price_tokens(blob: str) -> list:
    return re.findall(r"-?\d+(?:\.\d+)?", blob or "")


def quarter_cents_of(record: dict, quarter: int) -> int:
    text = str(record.get("cents") or "")
    if not _CENTS.fullmatch(text):
        raise ValueError("missing_fields")
    parts = text.split(",")
    if quarter < 0 or quarter >= len(parts):
        raise ValueError("bad_quarter")
    return int(parts[quarter])


def extract_print(body, status: int, zone: str, date: str, source: str) -> dict:
    rec = _blank_print(zone, date, source)
    if status <= 0:
        return _fail_print(rec, "fetch_failed")
    if status >= 400:
        return _fail_print(rec, "http_error")
    text = str(body or "")
    if not text:
        return _fail_print(rec, "empty_body")
    if len(text) > BODY_CAP:
        return _fail_print(rec, "body_too_large")
    if not text.lstrip().startswith("{"):
        return _fail_print(rec, "not_json")
    if re.search(r'"deprecated"\s*:\s*true\b', text):
        return _fail_print(rec, "deprecated_series")
    unit_match = re.search(r'"unit"\s*:\s*"([^"]*)"', text)
    if not unit_match or unit_match.group(1) != UNIT:
        return _fail_print(rec, "bad_unit")
    price_blob = _array_body(text, "price")
    unix_blob = _array_body(text, "unix_seconds")
    if price_blob is None or unix_blob is None:
        return _fail_print(rec, "missing_prices")
    try:
        prices = [_token_cents(token) for token in _price_tokens(price_blob)]
    except ValueError as exc:
        return _fail_print(rec, str(exc))
    unix_tokens = _price_tokens(unix_blob)
    if any(("." in token) or token.startswith("-") for token in unix_tokens):
        return _fail_print(rec, "bad_unix")
    try:
        unix = [int(token) for token in unix_tokens]
    except ValueError:
        return _fail_print(rec, "bad_unix")
    if not prices or len(prices) != len(unix):
        return _fail_print(rec, "missing_fields")
    if len(prices) not in RESOLUTIONS:
        return _fail_print(rec, "bad_resolution")
    if unix[0] <= 0:
        return _fail_print(rec, "bad_unix")
    for index in range(1, len(unix)):
        if unix[index] - unix[index - 1] != 900:
            return _fail_print(rec, "bad_step")
    year = int(date[0:4])
    month = int(date[5:7])
    day = int(date[8:10])
    midnight = civil_to_unix(year, month, day)
    if abs(unix[0] - midnight) > CLOCK_SKEW_SECS:
        return _fail_print(rec, "clock_skew")
    rec["outcome"] = "pinned"
    rec["reason"] = "quarter_grid"
    rec["count"] = str(len(prices))
    rec["first_unix"] = str(unix[0])
    rec["step"] = "900"
    rec["cents"] = ",".join(str(value) for value in prices)
    rec["unit"] = UNIT
    return rec


def prints_equivalent(left: dict, right: dict) -> bool:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    for field in PRINT_FIELDS:
        if str(left.get(field)) != str(right.get(field)):
            return False
    return True


def print_acceptable(record: dict, zone: str, date: str, source: str) -> bool:
    if not isinstance(record, dict):
        return False
    for field in PRINT_FIELDS:
        if not isinstance(record.get(field), str):
            return False
    if record["zone"] != zone or record["date"] != date or record["source"] != source:
        return False
    if record["outcome"] == "unreadable":
        return (
            record["reason"] in UNREADABLE_REASONS
            and record["count"] == "0"
            and record["first_unix"] == ""
            and record["step"] == ""
            and record["cents"] == ""
            and record["unit"] == ""
        )
    if record["outcome"] != "pinned" or record["reason"] not in PINNED_REASONS:
        return False
    if record["unit"] != UNIT or record["step"] != "900":
        return False
    try:
        count = int(record["count"])
        first_unix = int(record["first_unix"])
    except ValueError:
        return False
    if count not in RESOLUTIONS or first_unix <= 0:
        return False
    if not _CENTS.fullmatch(record["cents"]):
        return False
    parts = record["cents"].split(",")
    if len(parts) != count:
        return False
    for part in parts:
        value = int(part)
        if abs(value) > PRICE_CAP_CENTS:
            return False
    midnight = civil_to_unix(int(date[0:4]), int(date[5:7]), int(date[8:10]))
    if abs(first_unix - midnight) > CLOCK_SKEW_SECS:
        return False
    return True


def _order_base(seller_or_buyer: str, zone: str, date: str, quarter: str, mwh: str, partial: str, note: str, expiry_secs: str, now: int, print_cents: int, source: str) -> dict:
    who = parse_address(seller_or_buyer)
    zone, date = parse_market(zone, date)
    quarter_i = parse_quarter(quarter)
    mwh_i = parse_mwh(mwh)
    partial_flag = parse_partial(partial)
    note_text = clip_text(note, 80, "bad_note")
    secs = parse_expiry(expiry_secs)
    if int(print_cents) <= 0 or int(print_cents) > PRICE_CAP_CENTS:
        raise ValueError("negative_or_zero_print")
    if int(now) <= 0:
        raise ValueError("bad_expiry")
    return {
        "who": who,
        "zone": zone,
        "date": date,
        "quarter": str(quarter_i),
        "mwh": str(mwh_i),
        "partial": partial_flag,
        "note": note_text,
        "expiry": str(int(now) + secs),
        "opened_at": str(int(now)),
        "print_cents": str(int(print_cents)),
        "source": source,
    }


def build_ask(seller: str, zone: str, date: str, quarter: str, mwh: str, markup_bps: str, partial: str, note: str, expiry_secs: str, now: int, ask_id: str, print_cents: int, source: str) -> dict:
    base = _order_base(seller, zone, date, quarter, mwh, partial, note, expiry_secs, now, print_cents, source)
    markup = parse_markup(markup_bps)
    return {
        "ask_id": str(int(ask_id)),
        "seller": base["who"],
        "zone": base["zone"],
        "date": base["date"],
        "quarter": base["quarter"],
        "mwh": base["mwh"],
        "remaining": base["mwh"],
        "markup_bps": str(markup),
        "partial": base["partial"],
        "note": base["note"],
        "status": "OPEN",
        "opened_at": base["opened_at"],
        "expiry": base["expiry"],
        "print_cents": base["print_cents"],
        "source": base["source"],
    }


def build_bid(buyer: str, zone: str, date: str, quarter: str, mwh: str, max_markup_bps: str, partial: str, note: str, expiry_secs: str, now: int, bid_id: str, print_cents: int, source: str) -> dict:
    base = _order_base(buyer, zone, date, quarter, mwh, partial, note, expiry_secs, now, print_cents, source)
    markup = parse_markup(max_markup_bps)
    wei = notional_wei(int(print_cents), markup, int(base["mwh"]))
    return {
        "bid_id": str(int(bid_id)),
        "buyer": base["who"],
        "zone": base["zone"],
        "date": base["date"],
        "quarter": base["quarter"],
        "mwh": base["mwh"],
        "max_markup_bps": str(markup),
        "partial": base["partial"],
        "note": base["note"],
        "status": "FUNDED",
        "opened_at": base["opened_at"],
        "expiry": base["expiry"],
        "print_cents": base["print_cents"],
        "source": base["source"],
        "escrow_wei": str(wei),
        "matched_ask": "",
        "fill_mwh": "0",
        "pay_wei": "0",
        "refund_wei": "0",
        "cleared_at": "",
    }


def fill_size(ask: dict, bid: dict, now: int) -> int:
    if ask.get("status") not in ("OPEN", "PARTIAL"):
        return 0
    if bid.get("status") != "FUNDED":
        return 0
    if ask.get("seller") == bid.get("buyer"):
        return 0
    if ask.get("zone") != bid.get("zone") or ask.get("date") != bid.get("date"):
        return 0
    if ask.get("quarter") != bid.get("quarter"):
        return 0
    if str(ask.get("print_cents")) != str(bid.get("print_cents")):
        return 0
    if str(ask.get("source")) != str(bid.get("source")):
        return 0
    try:
        if int(now) >= int(ask["expiry"]) or int(now) >= int(bid["expiry"]):
            return 0
        if int(ask["markup_bps"]) > int(bid["max_markup_bps"]):
            return 0
        remaining = int(ask["remaining"])
        need = int(bid["mwh"])
    except (KeyError, TypeError, ValueError):
        return 0
    if remaining <= 0 or need <= 0:
        return 0
    fill = remaining if remaining < need else need
    if ask.get("partial") != "yes" and fill != remaining:
        return 0
    if bid.get("partial") != "yes" and fill != need:
        return 0
    return fill


def ask_better(left: dict, right: dict) -> bool:
    left_markup = int(left["markup_bps"])
    right_markup = int(right["markup_bps"])
    if left_markup != right_markup:
        return left_markup < right_markup
    return int(left["ask_id"]) < int(right["ask_id"])


def match_plan(asks: list, bid: dict, quarter_cents: int, now: int) -> dict:
    if not isinstance(bid, dict) or bid.get("status") != "FUNDED":
        return {"error": "bid_not_open"}
    try:
        if int(now) >= int(bid["expiry"]):
            return {"error": "bid_expired"}
    except (KeyError, TypeError, ValueError):
        return {"error": "bid_not_open"}
    if int(quarter_cents) <= 0:
        return {"error": "negative_or_zero_print"}
    if str(bid.get("print_cents")) != str(int(quarter_cents)):
        return {"error": "print_moved"}
    chosen = None
    fill = 0
    for ask in asks:
        size = fill_size(ask, bid, now)
        if size <= 0:
            continue
        if chosen is None or ask_better(ask, chosen):
            chosen = ask
            fill = size
    if chosen is None:
        return {"error": "no_compatible_ask"}
    try:
        pay = notional_wei(int(quarter_cents), int(chosen["markup_bps"]), fill)
    except ValueError as exc:
        return {"error": str(exc)}
    escrow = int(bid["escrow_wei"])
    if pay > escrow:
        return {"error": "pay_exceeds_escrow"}
    return {
        "ask_id": str(chosen["ask_id"]),
        "fill_mwh": str(fill),
        "pay_wei": str(pay),
        "refund_wei": str(escrow - pay),
        "seller": chosen["seller"],
        "buyer": bid["buyer"],
        "markup_bps": str(chosen["markup_bps"]),
        "unit_cents": str(unit_cents(int(quarter_cents), int(chosen["markup_bps"]))),
    }


def apply_clear(ask: dict, bid: dict, plan: dict, now: int) -> tuple:
    fill = int(plan["fill_mwh"])
    pay = int(plan["pay_wei"])
    refund = int(plan["refund_wei"])
    escrow = int(bid["escrow_wei"])
    if fill <= 0 or pay + refund != escrow:
        raise ValueError("bad_fill")
    remaining = int(ask["remaining"]) - fill
    if remaining < 0:
        raise ValueError("bad_fill")
    if str(plan["ask_id"]) != str(ask["ask_id"]):
        raise ValueError("bad_fill")
    next_ask = dict(ask)
    next_bid = dict(bid)
    next_ask["remaining"] = str(remaining)
    next_ask["status"] = "FILLED" if remaining == 0 else "PARTIAL"
    next_bid["status"] = "CLEARED"
    next_bid["matched_ask"] = str(plan["ask_id"])
    next_bid["fill_mwh"] = str(fill)
    next_bid["pay_wei"] = str(pay)
    next_bid["refund_wei"] = str(refund)
    next_bid["escrow_wei"] = "0"
    next_bid["cleared_at"] = str(int(now))
    return next_ask, next_bid


def apply_refund(bid: dict, now: int) -> tuple:
    if bid.get("status") != "FUNDED":
        raise ValueError("bid_not_open")
    refund = int(bid.get("escrow_wei") or 0)
    if refund <= 0:
        raise ValueError("nothing_to_refund")
    next_bid = dict(bid)
    next_bid["status"] = "REFUNDED"
    next_bid["refund_wei"] = str(refund)
    next_bid["escrow_wei"] = "0"
    next_bid["cleared_at"] = str(int(now))
    return next_bid, refund


def cancel_ask_record(ask: dict, sender: str, now: int) -> dict:
    if ask.get("seller") != sender:
        raise ValueError("not_seller")
    if ask.get("status") not in ("OPEN", "PARTIAL"):
        raise ValueError("ask_not_open")
    next_ask = dict(ask)
    next_ask["status"] = "CANCELLED"
    next_ask["cleared_at"] = str(int(now))
    return next_ask


def expire_ask_record(ask: dict, now: int) -> dict:
    if ask.get("status") not in ("OPEN", "PARTIAL"):
        raise ValueError("ask_not_open")
    if int(now) < int(ask["expiry"]):
        raise ValueError("not_expired")
    next_ask = dict(ask)
    next_ask["status"] = "EXPIRED"
    next_ask["cleared_at"] = str(int(now))
    return next_ask


def refund_bid_record(bid: dict, sender: str, now: int, expired_only: bool) -> tuple:
    if bid.get("status") != "FUNDED":
        raise ValueError("bid_not_open")
    if expired_only:
        if int(now) < int(bid["expiry"]):
            raise ValueError("not_expired")
    elif sender != bid.get("buyer"):
        raise ValueError("not_buyer")
    return apply_refund(bid, now)

# RULES_END


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class Bandlot(gl.Contract):
    ask_count: u256
    bid_count: u256
    asks: TreeMap[str, str]
    bids: TreeMap[str, str]
    prints: TreeMap[str, str]
    version: str
    title: str

    def __init__(self):
        self.ask_count = u256(0)
        self.bid_count = u256(0)
        self.version = VERSION
        self.title = "Bandlot"

    @gl.public.view
    def get_meta(self) -> dict[str, str]:
        return {
            "title": self.title,
            "version": self.version,
            "ask_count": str(self.ask_count),
            "bid_count": str(self.bid_count),
            "primitive": "day-ahead-lot-book",
            "category": "marketplaces",
            "tag_dynamic_pricing": "day_ahead_print_plus_markup",
            "tag_matching": "lowest_markup_then_earliest_ask",
            "llm_rule": "none",
            "source_rule": "contract_built_https_only",
            "price_rule": "eur_mwh_cents_times_markup_floor",
            "match_rule": "lowest_markup_then_earliest_ask",
            "fail_rule": "unreadable_does_not_pin",
            "pay_rule": "clear_only",
            "self_trade_rule": "blocked",
            "settlement_scale": "1 euro-cent of indexed notional = 10^12 wei",
            "wei_per_eur_cent": str(WEI_PER_EUR_CENT),
            "min_pay_wei": str(MIN_PAY_WEI),
            "zones": ",".join(ZONES),
            "unit": UNIT,
        }

    @gl.public.view
    def describe(self) -> dict[str, str]:
        return {
            "name": "Bandlot",
            "problem": "An indexed power lot is usually cleared by the desk that also picks the print. Either side has to trust that screenshot and that match.",
            "print": "Validators re-fetch the day-ahead series from a URL this contract builds. A party cannot submit the price.",
            "asks": "A seller posts a markup in basis points over the pinned print, for one interval and a whole number of megawatt-hours.",
            "bids": "A buyer escrows the cost of their own maximum markup. The escrow is the contract's figure, not a typed GEN amount.",
            "match": "The cheapest still-open compatible ask wins. Equal markups go to the earlier ask. A seller cannot take their own bid.",
            "pays_on": "clear_bid, seller receives the matched notional, buyer is refunded the rest of the escrow",
            "unreadable": "does not pin and does not move GEN",
            "llm": "not used",
            "not_claimed": "physical delivery of electricity, or a euro exchange rate for GEN",
        }

    @gl.public.view
    def get_ask_count(self) -> u256:
        return self.ask_count

    @gl.public.view
    def get_bid_count(self) -> u256:
        return self.bid_count

    @gl.public.view
    def preview_source(self, zone: str, date: str) -> str:
        try:
            parsed_zone, parsed_date = parse_market(zone or "", date or "")
        except ValueError as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps(
            {
                "zone": parsed_zone,
                "date": parsed_date,
                "source": source_url(parsed_zone, parsed_date),
            },
            sort_keys=True,
        )

    @gl.public.view
    def get_print(self, zone: str, date: str) -> str:
        try:
            parsed_zone, parsed_date = parse_market(zone or "", date or "")
        except ValueError as exc:
            return json.dumps({"error": str(exc)})
        rec = self._read_map(self.prints, print_key(parsed_zone, parsed_date))
        if rec is None:
            return json.dumps({"error": "print_not_pinned", "zone": parsed_zone, "date": parsed_date})
        return json.dumps(rec, sort_keys=True)

    @gl.public.view
    def get_ask(self, ask_id: str) -> str:
        rec = self._read_map(self.asks, str(ask_id).strip())
        if rec is None:
            return json.dumps({"error": "ask_not_found", "ask_id": str(ask_id)})
        return json.dumps(rec, sort_keys=True)

    @gl.public.view
    def get_bid(self, bid_id: str) -> str:
        rec = self._read_map(self.bids, str(bid_id).strip())
        if rec is None:
            return json.dumps({"error": "bid_not_found", "bid_id": str(bid_id)})
        return json.dumps(rec, sort_keys=True)

    @gl.public.view
    def list_asks(self, offset: u256, limit: u256) -> typing.Any:
        return self._list(self.asks, int(self.ask_count), offset, limit)

    @gl.public.view
    def list_bids(self, offset: u256, limit: u256) -> typing.Any:
        return self._list(self.bids, int(self.bid_count), offset, limit)

    @gl.public.view
    def quote(self, zone: str, date: str, quarter: str, markup_bps: str, mwh: str) -> str:
        try:
            parsed_zone, parsed_date = parse_market(zone or "", date or "")
            quarter_i = parse_quarter(quarter or "")
            markup = parse_markup(markup_bps or "")
            qty = parse_mwh(mwh or "")
            rec = self._require_print(parsed_zone, parsed_date)
            cents = quarter_cents_of(rec, quarter_i)
            if cents <= 0:
                raise ValueError("negative_or_zero_print")
            wei = notional_wei(cents, markup, qty)
        except ValueError as exc:
            return json.dumps({"error": str(exc)})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps(
            {
                "wei": str(wei),
                "unit_cents": str(unit_cents(cents, markup)),
                "print_cents": str(cents),
                "mwh": str(qty),
                "markup_bps": str(markup),
                "quarter": str(quarter_i),
                "zone": parsed_zone,
                "date": parsed_date,
                "source": rec.get("source", ""),
            },
            sort_keys=True,
        )

    @gl.public.view
    def preview_match(self, bid_id: str) -> str:
        bid = self._read_map(self.bids, str(bid_id).strip())
        if bid is None:
            return json.dumps({"error": "bid_not_found"})
        try:
            rec = self._require_print(bid["zone"], bid["date"])
            cents = quarter_cents_of(rec, int(bid["quarter"]))
            plan = match_plan(self._all(self.asks, int(self.ask_count)), bid, cents, _now_ts())
        except ValueError as exc:
            return json.dumps({"error": str(exc)})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
        return json.dumps(plan, sort_keys=True)

    @gl.public.write
    def pin_print(self, zone: str, date: str) -> str:
        self._reject_value()
        try:
            parsed_zone, parsed_date = parse_market(zone or "", date or "")
        except ValueError as exc:
            raise Exception(str(exc))
        key = print_key(parsed_zone, parsed_date)
        existing = self._read_map(self.prints, key)
        if existing and existing.get("outcome") == "pinned":
            return json.dumps(existing, sort_keys=True)
        url = source_url(parsed_zone, parsed_date)
        payload = _consensus_print(parsed_zone, parsed_date, url)
        if payload.get("outcome") != "pinned":
            raise Exception(str(payload.get("reason") or "unreadable"))
        stored = dict(payload)
        stored["pinned_at"] = str(_now_ts())
        self.prints[key] = json.dumps(stored, sort_keys=True)
        return self.prints[key]

    @gl.public.write
    def post_ask(
        self,
        zone: str,
        date: str,
        quarter: str,
        mwh: str,
        markup_bps: str,
        partial: str,
        note: str,
        expiry_secs: str,
    ) -> str:
        self._reject_value()
        if int(self.ask_count) >= MAX_ORDERS:
            raise Exception("book_full")
        try:
            parsed = self._bound_order(zone, date, quarter)
            ask = build_ask(
                self._sender(),
                parsed["zone"],
                parsed["date"],
                quarter,
                mwh,
                markup_bps,
                partial,
                note or "",
                expiry_secs,
                _now_ts(),
                str(int(self.ask_count)),
                parsed["cents"],
                parsed["source"],
            )
        except ValueError as exc:
            raise Exception(str(exc))
        self.asks[ask["ask_id"]] = json.dumps(ask, sort_keys=True)
        self.ask_count = u256(int(self.ask_count) + 1)
        return self.asks[ask["ask_id"]]

    @gl.public.write.payable
    def post_bid(
        self,
        zone: str,
        date: str,
        quarter: str,
        mwh: str,
        max_markup_bps: str,
        partial: str,
        note: str,
        expiry_secs: str,
    ) -> str:
        if int(self.bid_count) >= MAX_ORDERS:
            raise Exception("book_full")
        try:
            parsed = self._bound_order(zone, date, quarter)
            bid = build_bid(
                self._sender(),
                parsed["zone"],
                parsed["date"],
                quarter,
                mwh,
                max_markup_bps,
                partial,
                note or "",
                expiry_secs,
                _now_ts(),
                str(int(self.bid_count)),
                parsed["cents"],
                parsed["source"],
            )
        except ValueError as exc:
            raise Exception(str(exc))
        if int(gl.message.value) != int(bid["escrow_wei"]):
            raise Exception("wrong_escrow")
        self.bids[bid["bid_id"]] = json.dumps(bid, sort_keys=True)
        self.bid_count = u256(int(self.bid_count) + 1)
        return self.bids[bid["bid_id"]]

    @gl.public.write
    def clear_bid(self, bid_id: str) -> str:
        self._reject_value()
        bid = self._read_map(self.bids, str(bid_id).strip())
        if bid is None:
            raise Exception("bid_not_found")
        try:
            rec = self._require_print(bid["zone"], bid["date"])
            cents = quarter_cents_of(rec, int(bid["quarter"]))
            now = _now_ts()
            plan = match_plan(self._all(self.asks, int(self.ask_count)), bid, cents, now)
            if "error" in plan:
                raise ValueError(plan["error"])
            ask = self._read_map(self.asks, str(plan["ask_id"]))
            if ask is None:
                raise ValueError("ask_not_found")
            next_ask, next_bid = apply_clear(ask, bid, plan, now)
        except ValueError as exc:
            raise Exception(str(exc))
        self.asks[next_ask["ask_id"]] = json.dumps(next_ask, sort_keys=True)
        self.bids[next_bid["bid_id"]] = json.dumps(next_bid, sort_keys=True)
        self._pay(plan["seller"], int(plan["pay_wei"]))
        self._pay(plan["buyer"], int(plan["refund_wei"]))
        return self.bids[next_bid["bid_id"]]

    @gl.public.write
    def cancel_ask(self, ask_id: str) -> str:
        self._reject_value()
        ask = self._read_map(self.asks, str(ask_id).strip())
        if ask is None:
            raise Exception("ask_not_found")
        try:
            next_ask = cancel_ask_record(ask, self._sender(), _now_ts())
        except ValueError as exc:
            raise Exception(str(exc))
        self.asks[next_ask["ask_id"]] = json.dumps(next_ask, sort_keys=True)
        return self.asks[next_ask["ask_id"]]

    @gl.public.write
    def cancel_bid(self, bid_id: str) -> str:
        self._reject_value()
        return self._refund_bid(str(bid_id).strip(), False)

    @gl.public.write
    def retire_ask(self, ask_id: str) -> str:
        self._reject_value()
        ask = self._read_map(self.asks, str(ask_id).strip())
        if ask is None:
            raise Exception("ask_not_found")
        try:
            next_ask = expire_ask_record(ask, _now_ts())
        except ValueError as exc:
            raise Exception(str(exc))
        self.asks[next_ask["ask_id"]] = json.dumps(next_ask, sort_keys=True)
        return self.asks[next_ask["ask_id"]]

    @gl.public.write
    def retire_bid(self, bid_id: str) -> str:
        self._reject_value()
        return self._refund_bid(str(bid_id).strip(), True)

    def _refund_bid(self, bid_id: str, expired_only: bool) -> str:
        bid = self._read_map(self.bids, bid_id)
        if bid is None:
            raise Exception("bid_not_found")
        try:
            next_bid, refund = refund_bid_record(bid, self._sender(), _now_ts(), expired_only)
        except ValueError as exc:
            raise Exception(str(exc))
        self.bids[next_bid["bid_id"]] = json.dumps(next_bid, sort_keys=True)
        self._pay(next_bid["buyer"], refund)
        return self.bids[next_bid["bid_id"]]

    def _bound_order(self, zone: str, date: str, quarter: str) -> dict:
        parsed_zone, parsed_date = parse_market(zone or "", date or "")
        quarter_i = parse_quarter(quarter or "")
        rec = self._require_print(parsed_zone, parsed_date)
        cents = quarter_cents_of(rec, quarter_i)
        if cents <= 0:
            raise ValueError("negative_or_zero_print")
        return {
            "zone": parsed_zone,
            "date": parsed_date,
            "cents": cents,
            "source": rec.get("source", ""),
        }

    def _require_print(self, zone: str, date: str) -> dict:
        rec = self._read_map(self.prints, print_key(zone, date))
        if rec is None or rec.get("outcome") != "pinned":
            raise ValueError("print_not_pinned")
        return rec

    def _list(self, store, total: int, offset: u256, limit: u256) -> typing.Any:
        off = max(0, int(offset))
        lim = int(limit)
        if lim <= 0:
            lim = 12
        if lim > 48:
            lim = 48
        out = []
        idx = total - 1 - off
        while idx >= 0 and len(out) < lim:
            key = str(idx)
            if key in store:
                out.append(store[key])
            idx -= 1
        return out

    def _all(self, store, total: int) -> list:
        out = []
        index = 0
        while index < total:
            rec = self._read_map(store, str(index))
            if rec is not None:
                out.append(rec)
            index += 1
        return out

    def _read_map(self, store, key: str):
        if key not in store:
            return None
        try:
            rec = json.loads(store[key])
        except Exception:
            return None
        if not isinstance(rec, dict):
            return None
        return rec

    def _sender(self) -> str:
        return gl.message.sender_address.as_hex.lower()

    def _reject_value(self) -> None:
        if int(gl.message.value) != 0:
            raise Exception("unexpected_value")

    def _pay(self, to_hex: str, amount: int) -> None:
        if int(amount) <= 0 or not to_hex:
            return
        _Recipient(Address(to_hex)).emit_transfer(value=u256(int(amount)))


def _now_ts() -> int:
    return int(time.time())


def _fetch_print(zone: str, date: str) -> dict:
    url = source_url(zone, date)
    status, body = _http_get(url)
    return extract_print(body, status, zone, date, url)


def _consensus_print(zone: str, date: str, url: str) -> dict:
    def leader_fn():
        return _fetch_print(zone, date)

    def validator_fn(leader_result) -> bool:
        if not isinstance(leader_result, gl.vm.Return):
            return False
        proposed = leader_result.calldata
        if not print_acceptable(proposed, zone, date, url):
            return False
        try:
            mine = leader_fn()
        except Exception:
            return False
        return prints_equivalent(proposed, mine)

    payload = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
    if not print_acceptable(payload, zone, date, url):
        raise Exception("invalid_consensus_payload")
    return payload


def _http_get(url: str) -> tuple:
    try:
        res = gl.nondet.web.get(url)
    except Exception:
        return 0, ""
    if isinstance(res, str):
        return 200, res
    if isinstance(res, (bytes, bytearray)):
        return 200, res.decode("utf-8", errors="replace")
    if isinstance(res, dict):
        if "price" in res and "unix_seconds" in res and "body" not in res and "status_code" not in res:
            return 200, json.dumps(res, separators=(",", ":"), ensure_ascii=True)
        status = int(res.get("status_code") or res.get("status") or 200)
        raw = res.get("body", "")
    else:
        status = int(getattr(res, "status_code", 200) or 200)
        raw = getattr(res, "body", b"")
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    text = str(raw or "")
    if status >= 400 and not text.lstrip().startswith("{"):
        return status, ""
    return status, text
