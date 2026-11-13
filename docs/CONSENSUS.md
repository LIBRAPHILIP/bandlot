# Consensus rules

Bandlot uses one non-deterministic step: `pin_print`. Every later order and the clear are deterministic reads of that stored print.

## What validators compare

The leader fetches the contract-built URL and returns a record of strings:

- zone, date, source
- outcome and reason
- count, first unix timestamp, step (`900`)
- comma-separated integer euro-cents
- unit (`EUR / MWh`)

A validator fetches the same URL and accepts the proposal only when `print_acceptable` passes and every field above is identical. License text, headers, and key order in the raw JSON are not compared. Prices are parsed from the decimal tokens in the body, not from binary floats, so `224.9` and `224.90` both become `22490` cents.

An unreadable record is a valid consensus payload (the validators agree the fetch failed) and is then rejected by the contract. Nothing is stored. GEN does not move.

## When a body is unreadable

`fetch_failed`, `http_error`, `empty_body`, `body_too_large`, `not_json`, `missing_prices`, `bad_price_scale`, `price_out_of_range`, `bad_resolution`, `bad_step`, `bad_unix`, `clock_skew`, `bad_unit`, `deprecated_series`, `missing_fields`.

Resolution must be 92, 96, or 100 points, which covers a 23-hour, 24-hour, or 25-hour European day at 15 minutes. The first timestamp must sit within six hours of UTC midnight on the requested date. That window fits CET and CEST local midnight and rejects a series from another day. Interval labels in the UI are index times 15 minutes. They are not a timezone conversion.

More than two decimal places, or an absolute price above 1000.00 EUR/MWh, fails the pin. A negative quarter can be stored. It cannot be posted or cleared.

## After the pin

A second pin of the same day returns the stored record and does not fetch again. A disagreeing reprint is not applied. Open orders copy the quarter's cents. `clear_bid` refuses the bid if those cents no longer match the stored print (`print_moved`). The print has no rewrite method, so this is a consistency check.

## Match

`clear_bid` loads the open asks and keeps one:

- same zone, date, interval, print cents, and source
- ask still OPEN or PARTIAL, bid still FUNDED
- both expiries still ahead
- seller markup is less than or equal to the buyer's maximum
- seller and buyer are different accounts
- fill size is the overlap. An all-or-nothing side must be filled completely. A partial side may be sliced.

Lowest markup wins. Equal markups go to the smaller ask id. The preview method runs the same function and does not reserve the ask. Two clears are ordered by the contract's transaction queue. The second sees the reduced remaining size.

Pay is `unit_cents * fill_mwh * 10^12` wei, with `unit_cents = print_cents * (10000 + markup_bps) // 10000`. Pay plus refund equals the escrow, or the clear reverts with `bad_fill`. Storage is updated before the two transfers.

## Value

`post_bid` is the only payable method. The attached value must equal the escrow `build_bid` computes. Every other method reverts on unexpected value.

Cancel returns the escrow to the buyer. Retire does the same after expiry, and anyone can call it. Cancelling an ask does not move GEN. There is no fee.

## LLM

`llm_rule` is `none`. No prompt is constructed.
