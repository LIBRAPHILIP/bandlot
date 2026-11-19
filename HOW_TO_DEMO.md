# How to demo Bandlot

Network: Studionet, chain 61999. The live desk is https://bandlot.vercel.app. Use the contract address in `deployed.json`. Do not type a euro price into a transaction. The print has to come from `pin_print`.

## Click path

1. Open the app. The health pip should show Studionet.
2. Click **Seller desk**, then **Fund this account**. The balance line should show GEN.
3. Leave zone `DE-LU` and date `2026-11-12`. Click **Pin this print**.
4. Wait until the transaction rail says accepted and the tape fills from the contract. Interval 0 on that date was 224.90 EUR/MWh when the fixture was saved. The readout is the stored print, not a browser fetch.
5. Leave the ask at 1 MWh, markup `100`, partial `no`. Click **Post ask**. The quote line is a read of `quote`. The ask appears only after the book reloads.
6. Click **Buyer desk**, then **Fund this account**. This must be a different address. The hint under the form says so if you are still on the seller.
7. Leave the bid at 1 MWh and max markup `400`. Click **Post bid at the contract quote**. The value attached is the wei from `quote` at submit time.
8. On that bid, click **Clear**. The bid should read CLEARED, the ask FILLED, escrow 0. Pay is the 100 bps figure. The difference from the 400 bps escrow is the refund.
9. Open the transaction hash. Appeal and finalize are available when the chain says so. The clear does not depend on them.

Votes on the rail are the votes the chain returned. The page does not invent a validator set.

## If the pin reverts

A 429 or an empty body reverts with `http_error` or `fetch_failed` and stores nothing. Wait and pin again. A day that is not published yet fails closed. Do not paste a price in its place.

## Script

`npm run demo:studionet` runs the same four calls: pin, ask from the deployer, bid from a second funded account, clear. It writes `deployments/live-check.json` only after the stored bid is CLEARED and the pay matches the floor formula.

That script already ran against `0x8CAE3D453B7562FEb5E8A0Cf8eC626743e0D3319`. Pin `0x83cb8b66f6842f53a499bfdb9aeaf00db61ff1003fed994b6a5a9dc1624332de` stored 22490 cents at interval 0. Ask `0x143d82ab4b99d5f6fc53d7d8811600bbdb73ef0e8fc9ca81b7735d478e4cee66`. Bid `0xcfcf0cd9389af181b1dc8399a47ca9f6d2b563087665a703aa8cab4a77a997f5`. Clear `0xc94a7dd2342e76041e2b8c5046258f7685237ecb31960c583f7e64cd8cf98152`. Ask 0 is FILLED. Bid 0 is CLEARED. Pay is 0.022714 GEN and the refund is 0.000675 GEN.
