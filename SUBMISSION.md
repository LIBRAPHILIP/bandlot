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
| Live app | (set after the Vercel alias is assigned) |
| Network | Studionet, chain 61999 |
| Contract | `0xfBC7386748Ea1176a3501d11d368430acde28cf6` |
| Deploy tx | `0xeb34178c7846a7898c95fcf85465597123fd835ee9e3f1d5bc2e3b1fb7bfe4dd` |
| Explorer | https://explorer-studio.genlayer.com/address/0xfBC7386748Ea1176a3501d11d368430acde28cf6 |
| Version | `1.0.0-bandlot` |
| LLM | not used (`llm_rule=none`) |

Primary tag: **Marketplaces**. Tag 1: **Dynamic Pricing**. Tag 2: **Buyer-Selling Matching**.

`npm run demo:studionet` wrote `deployments/live-check.json` on 13 Nov 2026. DE-LU 2026-11-12 pinned 96 intervals. Interval 0 is 22490 euro-cents per MWh. Ask 0 at +100 bps is FILLED. Bid 0, escrowed at +400 bps from a second account, is CLEARED. Pay is `22714000000000000` wei. Refund is `675000000000000` wei.

| Call | Transaction |
| --- | --- |
| `pin_print` | `0xd334aa3f1307e27085b4784da977475558ad9e5a2c409ae2813240cee7ad42e3` |
| `post_ask` | `0x821f2cce97e94aeba09523e2c88f23dda7eb8540b0c222d10cb2fbf4f95ae6a5` |
| `post_bid` | `0xfcc6d2176755e271b3722d00bd53dc6041359204aa02e03519ba7a5be44ef851` |
| `clear_bid` | `0x51fc882d9423d79507a9f9bf1defa1763346ee33a5b55c2b589b80b909715301` |
