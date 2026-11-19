# Bandlot — submission notes

**Category:** Marketplaces

**Tag 1:** Dynamic Pricing

**Tag 2:** Buyer-Selling Matching

**Title:** Bandlot

## What it does

Bandlot is a book for an indexed day-ahead lot. A seller posts a markup over the published print for one interval in a bidding zone. A buyer escrows the most they will pay over that same print. The contract fetches the day-ahead series, matches the cheapest compatible ask, pays the seller, and refunds the rest. The LLM is not called.

## The problem it solves

The broker who sells "power at the day-ahead print plus a fee" is also the witness for the print and for which offer won. A screenshot is not something the other side can re-fetch, and a platform sort is not a rule. Bandlot builds the URL, requires validators to agree on the euro-cent series, and clears only by price-time priority. GEN moves on that clear and not before. It does not schedule a power plant. The GEN amount is an indexed notional at a published wei scale, not a euro exchange rate.

## How to use it

1. Open the live app (or `npm run dev` in this repo).
2. Open a seller desk and fund it. Bind the contract below, or deploy `contracts/bandlot.py`.
3. Pin DE-LU for a published delivery date. The tape fills only after that transaction is accepted and the print is read back.
4. Post an ask as a markup in basis points. Switch to a buyer desk, fund it, and post a bid. The attached GEN is the contract's `quote`, not a typed amount.
5. Clear the bid. The ask is FILLED and the bid is CLEARED only after the receipt is accepted and the book reloads. Cancel refunds an open bid. Retire refunds it after expiry.

The transaction rail waits for an accepted receipt, shows the votes the chain returns, and links the explorer. Appeal and finalize appear when the chain allows them.

## Evidence

| | |
| --- | --- |
| GitHub | https://github.com/LIBRAPHILIP/bandlot |
| Live app | https://bandlot.vercel.app |
| Network | Studionet, chain 61999 |
| Contract | `0x8CAE3D453B7562FEb5E8A0Cf8eC626743e0D3319` |
| Deploy tx | `0x149fd95fce07ad44e6a7882e65103cf4eedb2e14d78fabaa37e8c2af869b8244` |
| Explorer | https://explorer-studio.genlayer.com/address/0x8CAE3D453B7562FEb5E8A0Cf8eC626743e0D3319 |
| Version | `1.0.1-bandlot` |
| LLM | not used (`llm_rule=none`) |

Primary tag: **Marketplaces**. Tag 1: **Dynamic Pricing**. Tag 2: **Buyer-Selling Matching**.

`npm run demo:studionet` wrote `deployments/live-check.json` on 19 Nov 2026 against version `1.0.1-bandlot`. DE-LU 2026-11-12 pinned 96 intervals. Interval 0 is 22490 euro-cents per MWh. Ask 0 at +100 bps is FILLED. Bid 0, escrowed at +400 bps from a second account, is CLEARED. Pay is `22714000000000000` wei. Refund is `675000000000000` wei. Expiry and the clear used `gl.message_raw["datetime"]`.

| Call | Transaction |
| --- | --- |
| `pin_print` | `0x83cb8b66f6842f53a499bfdb9aeaf00db61ff1003fed994b6a5a9dc1624332de` |
| `post_ask` | `0x143d82ab4b99d5f6fc53d7d8811600bbdb73ef0e8fc9ca81b7735d478e4cee66` |
| `post_bid` | `0xcfcf0cd9389af181b1dc8399a47ca9f6d2b563087665a703aa8cab4a77a997f5` |
| `clear_bid` | `0xc94a7dd2342e76041e2b8c5046258f7685237ecb31960c583f7e64cd8cf98152` |
