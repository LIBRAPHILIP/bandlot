# Bandlot

Bandlot is a GenLayer lot book. Sellers post a markup over a day-ahead print. Buyers escrow a maximum markup. The contract fetches the print from a URL it builds, matches the cheapest compatible ask, and moves GEN only on that match.

The worked example is DE-LU on 12 Nov 2026. Interval 0 of that series is 224.90 EUR/MWh. At +100 basis points the indexed price floors to 227.14. At +400 it floors to 233.89. The buyer escrows the higher figure. A clear against the cheaper ask pays 227.14 and refunds the difference. One euro-cent of notional is `10^12` wei on this book. That is a settlement scale, not a price for GEN, and the contract does not deliver electricity.

## Run

```bash
npm install
npm test
npm run test:py
npm run dev
```

The dev server is http://127.0.0.1:5177. Open a seller desk and a buyer desk, fund each, pin a delivery day, post both sides, then clear.

```bash
npm run deploy:studionet
npm run demo:studionet
```

Deploy writes `deployed.json` and `src/deployed.json`. The deployer key stays in `deploy/deployer.local.json` and is gitignored. The demo writes `deployments/live-check.json` after a real clear.

## Contract

`contracts/bandlot.py`

Reads: `get_meta`, `get_print`, `quote`, `preview_match`, `preview_source`, `list_asks`, `list_bids`.

Writes: `pin_print`, `post_ask`, `post_bid` (payable), `clear_bid`, `cancel_ask`, `cancel_bid`, `retire_ask`, `retire_bid`.

Rules and tests: `docs/CONSENSUS.md`, `tests/test_rules.py`.

## Network

Studionet, chain 61999. RPC `https://studio.genlayer.com/api`. Explorer `https://explorer-studio.genlayer.com`.

Live app: https://bandlot.vercel.app

Live contract `0xfBC7386748Ea1176a3501d11d368430acde28cf6`. Deploy transaction `0xeb34178c7846a7898c95fcf85465597123fd835ee9e3f1d5bc2e3b1fb7bfe4dd`.

The recorded clear is in `deployments/live-check.json`. DE-LU 2026-11-12, interval 0, print 224.90 EUR/MWh. Ask 0 at +100 bps is FILLED. Bid 0 from a second account, escrowed at +400 bps, is CLEARED. Pay `22714000000000000` wei, refund `675000000000000` wei.
