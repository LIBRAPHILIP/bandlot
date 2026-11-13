/**
 * Bandlot reads and writes. Every write waits for an accepted receipt
 * and polls validator rounds while it waits.
 */
import { TransactionStatus } from "genlayer-js/types";
import contractSource from "../../contracts/bandlot.py?raw";
import { getReadClient, getWriteClient, initializeConsensus, getActiveNetworkKey } from "./client.js";
import { getNetwork } from "./networks.js";

export { contractSource };

const ADDRESS_KEY = "bandlot.contract";

export function loadSavedAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) || "";
  } catch {
    return "";
  }
}

export function saveAddress(address) {
  try {
    if (address) localStorage.setItem(ADDRESS_KEY, address);
    else localStorage.removeItem(ADDRESS_KEY);
  } catch {
    /* private mode */
  }
}

function requireAddress(address) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Set the Bandlot contract address first.");
  }
  return address;
}

export function parseMaybeJson(value) {
  if (value == null) return value;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function asWei(value) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error("The contract quote was not an integer wei amount.");
  return BigInt(text);
}

export function extractContractAddress(receipt) {
  return (
    receipt?.data?.contract_address ||
    receipt?.to_address ||
    receipt?.txDataDecoded?.contractAddress ||
    receipt?.contractAddress ||
    receipt?.data?.contractAddress ||
    null
  );
}

function executionRows(receipt) {
  const rows = [];
  const data = receipt?.consensus_data;
  const leaders = data?.leader_receipt || [];
  for (const row of Array.isArray(leaders) ? leaders : [leaders]) {
    if (row) rows.push(row);
  }
  for (const row of data?.validators || []) rows.push(row);
  if (receipt?.genvm_result) {
    rows.push({
      execution_result: receipt.genvm_result.execution_result,
      vote: "agree",
      genvm_result: receipt.genvm_result,
    });
  }
  return rows;
}

export function executionError(receipt) {
  const rows = executionRows(receipt);
  let success = false;
  let stderr = "";
  for (const row of rows) {
    if (String(row?.execution_result || "").toUpperCase() === "SUCCESS") success = true;
    const text = String(row?.genvm_result?.stderr || "").trim();
    if (!text || /cancelled after quorum/i.test(text)) continue;
    if (String(row?.vote || "") === "idle") continue;
    if (!stderr) stderr = text;
  }
  if (!stderr || success) return "";
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-4).join(" ");
}

export function receiptLooksFailed(receipt) {
  if (executionError(receipt)) return true;
  const status = String(receipt?.statusName || receipt?.status || "").toUpperCase();
  const result = String(receipt?.result_name || receipt?.resultName || receipt?.txExecutionResultName || "").toUpperCase();
  if (status.includes("REJECT") || status.includes("ERROR") || status.includes("UNDETERMINED")) return true;
  if (result.includes("ERROR") || result.includes("REVERT") || result.includes("REJECT")) return true;
  return false;
}

async function writeMethod(address, functionName, args, { onProgress, value = 0n, label } = {}) {
  const client = getWriteClient();
  await initializeConsensus();
  onProgress?.({ phase: "submitting", message: `Submitting ${label || functionName}…` });
  const tx = { address: requireAddress(address), functionName, args };
  if (value && value !== 0n) tx.value = value;
  const txHash = await client.writeContract(tx);
  onProgress?.({
    phase: "consensus",
    message: "Transaction is in flight. Validators are working the round.",
    txHash,
  });
  const receipt = await waitWithConsensus(txHash, {
    onRound: (info) => onProgress?.({ phase: "consensus", ...info, txHash }),
  });
  if (receiptLooksFailed(receipt)) {
    const detail = executionError(receipt) || receipt?.statusName || receipt?.result_name || "execution failed";
    throw new Error(`${label || functionName} reverted: ${detail}`);
  }
  onProgress?.({
    phase: "accepted",
    message: `${label || functionName} accepted. Reloading the book from the contract.`,
    txHash,
    receipt,
  });
  return { txHash, receipt };
}

export function deployBandlot({ onProgress } = {}) {
  return (async () => {
    const client = getWriteClient();
    await initializeConsensus();
    onProgress?.({ phase: "submitting", message: "Submitting Bandlot deployContract…" });
    const txHash = await client.deployContract({ code: contractSource, args: [] });
    onProgress?.({ phase: "consensus", message: "Waiting for the deploy to be accepted…", txHash });
    const receipt = await waitWithConsensus(txHash, {
      onRound: (info) => onProgress?.({ phase: "consensus", ...info, txHash }),
    });
    if (receiptLooksFailed(receipt)) {
      const detail = executionError(receipt) || "deploy failed";
      throw new Error(`Deploy reverted: ${detail}`);
    }
    const address = extractContractAddress(receipt);
    if (!address) throw new Error("Deploy was accepted but the receipt has no contract address.");
    saveAddress(address);
    onProgress?.({ phase: "accepted", message: "Bandlot deployed. Bind is saved in this browser.", txHash, address, receipt });
    return { address, txHash, receipt };
  })();
}

export function pinPrint(address, zone, date, opts) {
  return writeMethod(address, "pin_print", [zone, date], { ...opts, label: "pin_print" });
}

export function postAsk(address, fields, opts) {
  return writeMethod(
    address,
    "post_ask",
    [fields.zone, fields.date, fields.quarter, fields.mwh, fields.markup, fields.partial, fields.note || "", fields.expiry],
    { ...opts, label: "post_ask" }
  );
}

export function postBid(address, fields, opts) {
  return writeMethod(
    address,
    "post_bid",
    [fields.zone, fields.date, fields.quarter, fields.mwh, fields.markup, fields.partial, fields.note || "", fields.expiry],
    { ...opts, value: fields.valueWei, label: "post_bid" }
  );
}

export function clearBid(address, bidId, opts) {
  return writeMethod(address, "clear_bid", [String(bidId)], { ...opts, label: "clear_bid" });
}

export function cancelAsk(address, askId, opts) {
  return writeMethod(address, "cancel_ask", [String(askId)], { ...opts, label: "cancel_ask" });
}

export function cancelBid(address, bidId, opts) {
  return writeMethod(address, "cancel_bid", [String(bidId)], { ...opts, label: "cancel_bid" });
}

export function retireAsk(address, askId, opts) {
  return writeMethod(address, "retire_ask", [String(askId)], { ...opts, label: "retire_ask" });
}

export function retireBid(address, bidId, opts) {
  return writeMethod(address, "retire_bid", [String(bidId)], { ...opts, label: "retire_bid" });
}

export async function appealTx(txHash, { onProgress } = {}) {
  const client = getWriteClient();
  await initializeConsensus();
  onProgress?.({ phase: "submitting", message: "Submitting an appeal on this transaction…", txHash });
  await client.appealTransaction({ txId: txHash });
  onProgress?.({ phase: "consensus", message: "Appeal is in a new consensus round.", txHash });
  const receipt = await waitWithConsensus(txHash, {
    onRound: (info) => onProgress?.({ phase: "consensus", ...info, txHash }),
  });
  onProgress?.({ phase: "accepted", message: "Appeal round accepted.", txHash, receipt });
  return { txHash, receipt };
}

export async function finalizeTx(txHash, { onProgress } = {}) {
  const client = getWriteClient();
  await initializeConsensus();
  onProgress?.({ phase: "submitting", message: "Submitting finalize…", txHash });
  const evmHash = await client.finalizeTransaction({ txId: txHash });
  onProgress?.({ phase: "finality", message: "Finalize submitted. Checking the transaction status.", txHash, evmHash });
  return { txHash, evmHash };
}

async function read(address, functionName, args) {
  const raw = await getReadClient().readContract({
    address: requireAddress(address),
    functionName,
    args,
  });
  let value = parseMaybeJson(raw);
  if (typeof value === "string") value = parseMaybeJson(value);
  return value;
}

export async function readMeta(address) {
  return read(address, "get_meta", []);
}

export async function readPrint(address, zone, date) {
  return read(address, "get_print", [zone, date]);
}

export async function readQuote(address, fields) {
  return read(address, "quote", [fields.zone, fields.date, fields.quarter, fields.markup, fields.mwh]);
}

export async function readPreviewMatch(address, bidId) {
  return read(address, "preview_match", [String(bidId)]);
}

export async function readSource(address, zone, date) {
  return read(address, "preview_source", [zone, date]);
}

export async function readBook(address) {
  const asks = await readList(address, "list_asks");
  const bids = await readList(address, "list_bids");
  return { asks, bids };
}

async function readList(address, functionName) {
  const raw = await read(address, functionName, [0n, 48n]);
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows.map(parseMaybeJson).filter((row) => row && !row.error && (row.ask_id != null || row.bid_id != null));
}

export async function waitWithConsensus(txHash, { onRound } = {}) {
  const client = getReadClient();
  let stopped = false;
  const poll = (async () => {
    let ticks = 0;
    while (!stopped && ticks < 240) {
      ticks += 1;
      try {
        onRound?.(await fetchConsensusSnapshot(txHash));
      } catch {
        /* round data appears after the tx is known */
      }
      await sleep(2500);
    }
  })();
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      status: TransactionStatus.ACCEPTED,
      retries: 360,
      interval: 5000,
      fullTransaction: true,
    });
    try {
      onRound?.({ ...(await fetchConsensusSnapshot(txHash)), terminal: true, receiptStatus: receipt.statusName });
    } catch {
      /* snapshot is optional once the receipt exists */
    }
    try {
      const tx = await client.getTransaction({ hash: txHash });
      if (tx && typeof tx === "object") return { ...receipt, ...tx, statusName: tx.statusName || receipt.statusName };
    } catch {
      /* the receipt still carries the accepted status */
    }
    return receipt;
  } finally {
    stopped = true;
    await poll.catch(() => {});
  }
}

export async function fetchConsensusSnapshot(txHash) {
  const client = getReadClient();
  const snapshot = {
    txHash,
    network: getActiveNetworkKey(),
    at: new Date().toISOString(),
    transaction: null,
    lastRound: null,
    canAppeal: null,
    rawErrors: [],
  };
  try {
    if (typeof client.getTransaction === "function") {
      snapshot.transaction = await client.getTransaction({ hash: txHash });
    }
  } catch (error) {
    snapshot.rawErrors.push(`getTransaction: ${error.message}`);
  }
  try {
    if (typeof client.getLastRoundData === "function") {
      snapshot.lastRound = await client.getLastRoundData({ txId: txHash });
    }
  } catch (error) {
    snapshot.rawErrors.push(`getLastRoundData: ${error.message}`);
  }
  try {
    if (typeof client.canAppeal === "function") {
      snapshot.canAppeal = await client.canAppeal({ txId: txHash });
    }
  } catch (error) {
    snapshot.rawErrors.push(`canAppeal: ${error.message}`);
  }
  return snapshot;
}

export function summarizeConsensus(snapshot) {
  if (!snapshot) return [];
  const details = [];
  const tx = snapshot.transaction;
  if (tx) {
    details.push(["Tx status", String(tx.statusName || tx.status || "pending")]);
    const resultName = tx.result_name || tx.resultName;
    if (resultName) details.push(["Result", String(resultName)]);
    const votes = tx.consensus_data?.votes;
    if (votes && typeof votes === "object") {
      const entries = Object.entries(votes);
      if (entries.length) {
        details.push(["Validators", String(entries.length)]);
        details.push(["Votes", entries.map(([addr, vote]) => `${String(addr).slice(0, 6)}:${vote}`).join(" · ")]);
      }
    }
    if (tx.num_of_rounds != null) details.push(["Rounds", String(tx.num_of_rounds)]);
  }
  const round = snapshot.lastRound?.round ?? snapshot.lastRound?.roundData?.round;
  if (round != null) details.push(["Consensus round", String(round)]);
  if (snapshot.canAppeal != null) details.push(["Appealable", snapshot.canAppeal ? "yes" : "no"]);
  if (snapshot.receiptStatus) details.push(["Receipt", String(snapshot.receiptStatus)]);
  return details;
}

export function voteEntries(snapshot) {
  const votes = snapshot?.transaction?.consensus_data?.votes;
  if (!votes || typeof votes !== "object") return [];
  return Object.entries(votes).map(([address, vote]) => ({ address, vote: String(vote) }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function activeNetwork() {
  return getNetwork(getActiveNetworkKey());
}
