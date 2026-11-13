/**
 * Pin the 12 Nov 2026 DE-LU print, post an ask, fund a second account's bid, and clear.
 *
 *   node scripts/demo-run.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { generatePrivateKey } from "viem/accounts";
import { notionalWei, unitCents } from "../src/genlayer/rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const RPC = "https://studio.genlayer.com/api";
const ZONE = "DE-LU";
const DATE = "2026-11-12";
const QUARTER = "0";

function parse(value) {
  let current = value;
  for (let i = 0; i < 2 && typeof current === "string"; i += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function failureDetail(receipt) {
  const rows = [];
  const leaders = receipt?.consensus_data?.leader_receipt || [];
  for (const row of Array.isArray(leaders) ? leaders : [leaders]) if (row) rows.push(row);
  for (const row of receipt?.consensus_data?.validators || []) rows.push(row);
  if (receipt?.genvm_result) rows.push({ genvm_result: receipt.genvm_result, execution_result: receipt.genvm_result.execution_result });
  let success = false;
  let stderr = "";
  for (const row of rows) {
    if (String(row?.execution_result || "").toUpperCase() === "SUCCESS") success = true;
    const text = String(row?.genvm_result?.stderr || "").trim();
    if (!text || /cancelled after quorum/i.test(text)) continue;
    if (String(row?.vote || "") === "idle") continue;
    if (!stderr) stderr = text.split("\n").slice(-4).join(" ");
  }
  if (!stderr || success) return "";
  return stderr;
}

async function fund(address) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sim_fundAccount",
      params: [address, 100 * 10 ** 18],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "sim_fundAccount failed");
  return body.result || null;
}

async function send(client, label, fn) {
  console.log(label);
  const hash = await fn();
  console.log("  tx:", hash);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: 400,
    interval: 5000,
    fullTransaction: true,
  });
  const status = String(receipt.statusName || receipt.status || "");
  const detail = failureDetail(receipt);
  console.log("  status:", status, detail ? "stderr: " + detail : "");
  if (/REJECT|ERROR|UNDETERMINED/i.test(status) || detail) {
    throw new Error(label + " failed: " + (detail || status));
  }
  return hash;
}

async function main() {
  const deployed = JSON.parse(readFileSync(path.join(root, "deployed.json"), "utf8"));
  const deployer = JSON.parse(readFileSync(path.join(root, "deploy", "deployer.local.json"), "utf8"));
  if (!deployed.address) throw new Error("Deploy first.");
  const seller = createAccount(deployer.privateKey);
  const buyerKey = generatePrivateKey();
  const buyer = createAccount(buyerKey);
  mkdirSync(path.join(root, "deploy"), { recursive: true });
  writeFileSync(
    path.join(root, "deploy", "buyer.local.json"),
    JSON.stringify({ address: buyer.address, privateKey: buyerKey }, null, 2)
  );

  const sellerClient = createClient({ chain: studionet, account: seller });
  const buyerClient = createClient({ chain: studionet, account: buyer });
  await sellerClient.initializeConsensusSmartContract();
  await buyerClient.initializeConsensusSmartContract();
  console.log("Seller", seller.address);
  console.log("Buyer", buyer.address);
  await fund(seller.address);
  await fund(buyer.address);

  const pin = await send(sellerClient, "pin_print", () =>
    sellerClient.writeContract({ address: deployed.address, functionName: "pin_print", args: [ZONE, DATE] })
  );
  const printed = parse(
    await sellerClient.readContract({ address: deployed.address, functionName: "get_print", args: [ZONE, DATE] })
  );
  if (printed?.outcome !== "pinned") throw new Error("print was not stored: " + JSON.stringify(printed));
  const cents = String(printed.cents || "").split(",");
  const printCents = Number(cents[Number(QUARTER)]);
  if (!Number.isInteger(printCents) || printCents <= 0) throw new Error("interval 0 is not a positive print");
  console.log("Interval 0 cents:", printCents, "count:", printed.count);

  const ask = await send(sellerClient, "post_ask", () =>
    sellerClient.writeContract({
      address: deployed.address,
      functionName: "post_ask",
      args: [ZONE, DATE, QUARTER, "1", "100", "no", "demo ask", "86400"],
    })
  );
  const quote = parse(
    await sellerClient.readContract({
      address: deployed.address,
      functionName: "quote",
      args: [ZONE, DATE, QUARTER, "400", "1"],
    })
  );
  if (quote?.error) throw new Error("quote failed: " + quote.error);
  const expectedEscrow = notionalWei(printCents, 400, 1);
  if (BigInt(quote.wei) !== expectedEscrow) {
    throw new Error(`quote wei ${quote.wei} != local ${expectedEscrow}`);
  }

  const bid = await send(buyerClient, "post_bid", () =>
    buyerClient.writeContract({
      address: deployed.address,
      functionName: "post_bid",
      args: [ZONE, DATE, QUARTER, "1", "400", "no", "demo bid", "86400"],
      value: BigInt(quote.wei),
    })
  );
  const bids = parse(
    await sellerClient.readContract({
      address: deployed.address,
      functionName: "list_bids",
      args: [0n, 5n],
    })
  );
  const latest = parse(Array.isArray(bids) ? bids[0] : bids);
  if (!latest?.bid_id) throw new Error("no bid returned: " + JSON.stringify(bids));

  const clear = await send(sellerClient, "clear_bid", () =>
    sellerClient.writeContract({
      address: deployed.address,
      functionName: "clear_bid",
      args: [String(latest.bid_id)],
    })
  );

  const cleared = parse(
    await sellerClient.readContract({
      address: deployed.address,
      functionName: "get_bid",
      args: [String(latest.bid_id)],
    })
  );
  const filled = parse(
    await sellerClient.readContract({
      address: deployed.address,
      functionName: "get_ask",
      args: [String(cleared.matched_ask)],
    })
  );
  const pay = notionalWei(printCents, 100, 1);
  if (cleared.status !== "CLEARED") throw new Error("bid status " + cleared.status);
  if (filled.status !== "FILLED") throw new Error("ask status " + filled.status);
  if (BigInt(cleared.pay_wei) !== pay) throw new Error(`pay ${cleared.pay_wei} != ${pay}`);
  if (cleared.escrow_wei !== "0") throw new Error("escrow remains");
  if (String(cleared.seller || filled.seller) && filled.seller === cleared.buyer) {
    throw new Error("self trade");
  }
  console.log(
    "Cleared.",
    "unit cents",
    String(unitCents(printCents, 100)),
    "pay",
    cleared.pay_wei,
    "refund",
    cleared.refund_wei
  );

  const evidence = {
    version: "1.0.0-bandlot",
    address: deployed.address,
    chainId: 61999,
    zone: ZONE,
    date: DATE,
    quarter: QUARTER,
    printCents: String(printCents),
    count: printed.count,
    source: printed.source,
    askId: filled.ask_id,
    bidId: cleared.bid_id,
    askStatus: filled.status,
    bidStatus: cleared.status,
    markupBps: filled.markup_bps,
    maxMarkupBps: cleared.max_markup_bps,
    payWei: cleared.pay_wei,
    refundWei: cleared.refund_wei,
    seller: filled.seller,
    buyer: cleared.buyer,
    txs: { pin, ask, bid, clear },
    checkedAt: new Date().toISOString(),
  };
  mkdirSync(path.join(root, "deployments"), { recursive: true });
  writeFileSync(path.join(root, "deployments", "live-check.json"), JSON.stringify(evidence, null, 2));
  console.log("Wrote deployments/live-check.json");
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exit(1);
});
