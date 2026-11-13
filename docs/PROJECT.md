# Bandlot

Bandlot is a two-sided book for an indexed power lot.

A seller offers a whole number of megawatt-hours on one interval of a bidding zone. They do not type a euro price. They type a markup, in basis points, over the day-ahead print. A buyer names the highest markup they will pay and escrows that amount. The contract fetches the print, chooses the cheapest compatible ask, pays the seller the matched notional, and refunds the rest of the escrow.

The lot is a GEN notional indexed to the published price. Bandlot does not schedule a power plant and does not claim that GEN trades at the euro figure on screen.

The Studionet deployment is `0xfBC7386748Ea1176a3501d11d368430acde28cf6` on chain 61999. The desk binds that address from `src/deployed.json`.

## The trust problem

On an OTC desk, the same person usually picks the "official" print and decides which offer won. A screenshot of a price site is not a record both sides can re-check, and a platform match is not a rule either side can read. Bandlot puts both steps in one Intelligent Contract:

- The URL is built by the contract. Neither party submits the price.
- Validators fetch that URL and keep the integer euro-cents only when they agree.
- The match is price-time priority: lowest markup, then the earlier ask. A seller cannot take their own bid.
- GEN moves only inside `clear_bid`. A failed fetch does not pin, and an unpinned day cannot take an order.

## What is live data

The series is `https://api.energy-charts.info/price?bzn=<zone>&start=<date>&end=<date>`.

For the worked example, DE-LU on 12 Nov 2026, energy-charts labels the body as CC BY 4.0 from Bundesnetzagentur | SMARD.de. The contract stores the parsed euro-cents, the interval count, and the first timestamp. It does not store the raw page.

Zones the contract will ask for: DE-LU, AT, BE, FR, NL. A zone whose body is not EUR/MWh on a 15-minute grid of 92, 96, or 100 points does not pin.

## Settlement scale

One euro-cent of indexed notional settles as 10^12 wei (0.000001 GEN). A 227.14 EUR/MWh lot of 1 MWh is 0.022714 GEN. This scale exists so a Studionet faucet can clear a lot. It is not an exchange rate.

Rounding is floor division. 224.90 EUR/MWh at +100 bps is 227.14, not 227.15. At +400 bps it is 233.89. The buyer who capped at 400 bps escrows 233.89 and, matched to a 100 bps ask, is refunded the difference.

## What it will not do

- Call a model.
- Accept a user-supplied URL or a user-supplied euro price.
- Treat an unreadable or rate-limited response as a price.
- Clear a zero or negative interval.
- Match an account to itself.
- Claim physical delivery.

The book holds 48 asks and 48 bids. That is the size of this contract, not a promise of an exchange.
