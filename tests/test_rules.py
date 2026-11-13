"""Rule tests for the pure section of contracts/bandlot.py."""

import datetime
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "contracts" / "bandlot.py").read_text(encoding="utf-8")
START = SOURCE.index("# RULES_START\n") + len("# RULES_START\n")
END = SOURCE.index("# RULES_END")
NS = {}
exec(SOURCE[START:END], NS)

VERSION = NS["VERSION"]
source_url = NS["source_url"]
valid_date = NS["valid_date"]
civil_to_unix = NS["civil_to_unix"]
extract_print = NS["extract_print"]
print_acceptable = NS["print_acceptable"]
prints_equivalent = NS["prints_equivalent"]
unit_cents = NS["unit_cents"]
notional_wei = NS["notional_wei"]
build_ask = NS["build_ask"]
build_bid = NS["build_bid"]
match_plan = NS["match_plan"]
apply_clear = NS["apply_clear"]
fill_size = NS["fill_size"]
cancel_ask_record = NS["cancel_ask_record"]
expire_ask_record = NS["expire_ask_record"]
refund_bid_record = NS["refund_bid_record"]
WEI_PER_EUR_CENT = NS["WEI_PER_EUR_CENT"]
parse_markup = NS["parse_markup"]
parse_market = NS["parse_market"]

FIXTURE = (ROOT / "tests" / "fixtures" / "de-lu-2026-11-12.json").read_text(encoding="utf-8")
URL = "https://api.energy-charts.info/price?bzn=DE-LU&start=2026-11-12&end=2026-11-12"
NOW = 1_800_000_000
SELLER = "0x" + ("11" * 20)
BUYER = "0x" + ("22" * 20)
OTHER = "0x" + ("33" * 20)


def grid(n=96, price="224.90", start=1794438000):
    prices = ",".join([price] * n)
    unix = ",".join(str(start + i * 900) for i in range(n))
    return (
        '{"license_info":"x","unix_seconds":['
        + unix
        + '],"price":['
        + prices
        + '],"unit":"EUR / MWh","deprecated":false}'
    )


def ask(**over):
    fields = dict(
        seller=SELLER,
        zone="DE-LU",
        date="2026-11-12",
        quarter="0",
        mwh="1",
        markup_bps="100",
        partial="no",
        note="base",
        expiry_secs="86400",
        now=NOW,
        ask_id="0",
        print_cents=22490,
        source=URL,
    )
    fields.update(over)
    return build_ask(**fields)


def bid(**over):
    fields = dict(
        buyer=BUYER,
        zone="DE-LU",
        date="2026-11-12",
        quarter="0",
        mwh="1",
        max_markup_bps="400",
        partial="no",
        note="cover",
        expiry_secs="86400",
        now=NOW,
        bid_id="0",
        print_cents=22490,
        source=URL,
    )
    fields.update(over)
    return build_bid(**fields)


class PrintTests(unittest.TestCase):
    def test_version_and_calendar(self):
        self.assertEqual(VERSION, "1.0.0-bandlot")
        self.assertEqual(civil_to_unix(1970, 1, 1), 0)
        expected = int(datetime.datetime(2026, 11, 12, tzinfo=datetime.timezone.utc).timestamp())
        self.assertEqual(civil_to_unix(2026, 11, 12), expected)
        self.assertFalse(valid_date("2026-02-31"))
        self.assertFalse(valid_date("2025-02-29"))
        self.assertTrue(valid_date("2024-02-29"))
        self.assertEqual(source_url("DE-LU", "2026-11-12"), URL)

    def test_fixture_pins_the_published_series(self):
        rec = extract_print(FIXTURE, 200, "DE-LU", "2026-11-12", URL)
        self.assertEqual(rec["outcome"], "pinned")
        self.assertEqual(rec["reason"], "quarter_grid")
        self.assertEqual(rec["count"], "96")
        self.assertEqual(rec["step"], "900")
        self.assertEqual(rec["unit"], "EUR / MWh")
        cents = [int(part) for part in rec["cents"].split(",")]
        self.assertEqual(cents[0], 22490)
        self.assertEqual(cents[-1], 12224)
        self.assertEqual(rec["first_unix"], "1794438000")
        self.assertTrue(print_acceptable(rec, "DE-LU", "2026-11-12", URL))
        self.assertTrue(prints_equivalent(rec, extract_print(FIXTURE, 200, "DE-LU", "2026-11-12", URL)))

    def test_float_reserialize_keeps_the_same_cents(self):
        data = json.loads(FIXTURE)
        rebuilt = json.dumps(data, separators=(",", ":"), ensure_ascii=True)
        original = extract_print(FIXTURE, 200, "DE-LU", "2026-11-12", URL)
        again = extract_print(rebuilt, 200, "DE-LU", "2026-11-12", URL)
        self.assertEqual(again["cents"], original["cents"])

    def test_rejects_hostile_or_thin_bodies(self):
        samples = {
            "": ("empty_body", 200),
            "<html>no</html>": ("not_json", 200),
            grid(24): ("bad_resolution", 200),
            grid(96).replace('"EUR / MWh"', '"USD"'): ("bad_unit", 200),
            grid(96).replace('"deprecated":false', '"deprecated":true'): ("deprecated_series", 200),
            grid(96, price="10.125"): ("bad_price_scale", 200),
            grid(96, price="1000.01"): ("price_out_of_range", 200),
            grid(96, start=100): ("clock_skew", 200),
        }
        for body, (reason, status) in samples.items():
            rec = extract_print(body, status, "DE-LU", "2026-11-12", URL)
            self.assertEqual(rec["outcome"], "unreadable", body[:40])
            self.assertEqual(rec["reason"], reason)
            self.assertEqual(rec["cents"], "")
            self.assertTrue(print_acceptable(rec, "DE-LU", "2026-11-12", URL))
        self.assertEqual(extract_print(grid(), 429, "DE-LU", "2026-11-12", URL)["reason"], "http_error")
        self.assertEqual(extract_print(grid(), 0, "DE-LU", "2026-11-12", URL)["reason"], "fetch_failed")
        self.assertFalse(print_acceptable({"outcome": "pinned"}, "DE-LU", "2026-11-12", URL))

    def test_negative_quarter_can_be_pinned_and_is_not_a_clearing_price(self):
        body = grid(96, price="-3.50")
        rec = extract_print(body, 200, "DE-LU", "2026-11-12", URL)
        self.assertEqual(rec["outcome"], "pinned")
        self.assertTrue(rec["cents"].startswith("-350"))


class BookTests(unittest.TestCase):
    def test_floor_and_escrow_vector(self):
        self.assertEqual(unit_cents(22490, 100), 22714)
        self.assertEqual(unit_cents(22490, 400), 23389)
        self.assertEqual(unit_cents(22490, -2000), 17992)
        self.assertEqual(notional_wei(22490, 100, 1), 22714 * WEI_PER_EUR_CENT)
        posted = bid()
        self.assertEqual(int(posted["escrow_wei"]), 23389 * WEI_PER_EUR_CENT)

    def test_cheapest_then_earliest_and_no_self_trade(self):
        early = ask(ask_id="0", markup_bps="200")
        cheap = ask(ask_id="3", markup_bps="50", seller=OTHER)
        late_tie = ask(ask_id="4", markup_bps="50", seller=OTHER)
        own = ask(ask_id="1", markup_bps="-100", seller=BUYER)
        rich = ask(ask_id="2", markup_bps="900")
        plan = match_plan([rich, late_tie, own, early, cheap], bid(), 22490, NOW + 10)
        self.assertEqual(plan["ask_id"], "3")
        self.assertEqual(plan["markup_bps"], "50")
        self.assertEqual(plan["seller"], OTHER)
        self.assertEqual(int(plan["pay_wei"]) + int(plan["refund_wei"]), int(bid()["escrow_wei"]))

    def test_partial_rules(self):
        whole = ask(mwh="2", partial="no")
        self.assertEqual(fill_size(whole, bid(mwh="1", partial="yes"), NOW + 1), 0)
        sliced = ask(mwh="2", partial="yes")
        self.assertEqual(fill_size(sliced, bid(mwh="1", partial="yes"), NOW + 1), 1)
        self.assertEqual(fill_size(sliced, bid(mwh="1", partial="no"), NOW + 1), 1)
        self.assertEqual(fill_size(ask(mwh="1", partial="yes"), bid(mwh="2", partial="no"), NOW + 1), 0)
        plan = match_plan([sliced], bid(mwh="1", partial="yes"), 22490, NOW + 1)
        next_ask, next_bid = apply_clear(sliced, bid(mwh="1", partial="yes"), plan, NOW + 1)
        self.assertEqual(next_ask["status"], "PARTIAL")
        self.assertEqual(next_ask["remaining"], "1")
        self.assertEqual(next_bid["status"], "CLEARED")
        self.assertEqual(next_bid["escrow_wei"], "0")

    def test_full_fill_and_refund_split(self):
        posted_ask = ask()
        posted_bid = bid()
        plan = match_plan([posted_ask], posted_bid, 22490, NOW + 5)
        self.assertNotIn("error", plan)
        next_ask, next_bid = apply_clear(posted_ask, posted_bid, plan, NOW + 5)
        self.assertEqual(next_ask["status"], "FILLED")
        self.assertEqual(next_ask["remaining"], "0")
        self.assertEqual(next_bid["matched_ask"], "0")
        self.assertEqual(int(next_bid["pay_wei"]), 22714 * WEI_PER_EUR_CENT)
        self.assertEqual(int(next_bid["refund_wei"]), (23389 - 22714) * WEI_PER_EUR_CENT)

    def test_rejects_bad_orders_and_dead_prints(self):
        with self.assertRaises(ValueError):
            ask(markup_bps="5001")
        with self.assertRaises(ValueError):
            ask(zone="US")
        with self.assertRaises(ValueError):
            bid(print_cents=0)
        with self.assertRaises(ValueError):
            parse_markup("+100")
        with self.assertRaises(ValueError):
            parse_market("de-lu", "2026-11-31")
        self.assertEqual(match_plan([ask()], bid(), 22490, NOW + 90000)["error"], "bid_expired")
        self.assertEqual(match_plan([ask()], bid(), 100, NOW + 1)["error"], "print_moved")
        self.assertEqual(match_plan([], bid(), 22490, NOW + 1)["error"], "no_compatible_ask")

    def test_cancel_expire_and_refund_permissions(self):
        posted_ask = ask()
        posted_bid = bid()
        with self.assertRaises(ValueError):
            cancel_ask_record(posted_ask, BUYER, NOW + 1)
        cancelled = cancel_ask_record(posted_ask, SELLER, NOW + 1)
        self.assertEqual(cancelled["status"], "CANCELLED")
        with self.assertRaises(ValueError):
            expire_ask_record(posted_ask, NOW + 10)
        expired = expire_ask_record(posted_ask, int(posted_ask["expiry"]))
        self.assertEqual(expired["status"], "EXPIRED")
        with self.assertRaises(ValueError):
            refund_bid_record(posted_bid, SELLER, NOW + 1, False)
        refunded, amount = refund_bid_record(posted_bid, BUYER, NOW + 1, False)
        self.assertEqual(refunded["status"], "REFUNDED")
        self.assertEqual(amount, int(posted_bid["escrow_wei"]))
        with self.assertRaises(ValueError):
            refund_bid_record(posted_bid, OTHER, NOW + 1, True)
        forced, _ = refund_bid_record(posted_bid, OTHER, int(posted_bid["expiry"]), True)
        self.assertEqual(forced["status"], "REFUNDED")


if __name__ == "__main__":
    unittest.main()
