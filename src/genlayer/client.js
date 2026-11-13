/**
 * Reads and writes go to a GenLayer RPC. There is no local consensus stand-in.
 */
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { getNetwork } from "./networks.js";

let readClient = null;
let writeClient = null;
let activeNetworkKey = "studionet";
let activeAccount = null;
let walletMode = "none";

export { generatePrivateKey };

export function getActiveNetworkKey() {
  return activeNetworkKey;
}

export function getActiveAccount() {
  return activeAccount;
}

export function getWalletMode() {
  return walletMode;
}

export function getReadClient() {
  if (!readClient) readClient = createClient({ chain: getNetwork(activeNetworkKey).chain });
  return readClient;
}

export function getWriteClient() {
  if (!writeClient) throw new Error("Open a seller desk, a buyer desk, or a wallet first.");
  return writeClient;
}

export function setNetwork(key) {
  activeNetworkKey = key;
  readClient = createClient({ chain: getNetwork(key).chain });
  writeClient = null;
  if (activeAccount) rebuildWriteClient();
  return getNetwork(key);
}

function rebuildWriteClient() {
  const net = getNetwork(activeNetworkKey);
  if (walletMode === "injected" && typeof window !== "undefined" && window.ethereum) {
    writeClient = createClient({ chain: net.chain, account: activeAccount, provider: window.ethereum });
  } else if (activeAccount) {
    writeClient = createClient({ chain: net.chain, account: activeAccount });
  }
}

export function usePrivateKey(privateKey) {
  const account = createAccount(privateKey);
  activeAccount = account;
  walletMode = "ephemeral";
  rebuildWriteClient();
  return { address: account.address, mode: walletMode };
}

export async function connectInjectedWallet() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("No injected wallet found. The seller and buyer desks work on Studionet without one.");
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("Wallet returned no accounts.");
  activeAccount = accounts[0];
  walletMode = "injected";
  const net = getNetwork(activeNetworkKey);
  writeClient = createClient({ chain: net.chain, account: accounts[0], provider: window.ethereum });
  try {
    if (typeof writeClient.connect === "function") await writeClient.connect(net.connectName);
  } catch (err) {
    console.warn("client.connect failed", err);
    await ensureWalletChain(net);
  }
  return { address: accounts[0], mode: walletMode };
}

async function ensureWalletChain(net) {
  const chainIdHex = "0x" + net.chain.id.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError) {
    if (switchError.code === 4902 || switchError?.data?.originalError?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: net.chain.name,
            nativeCurrency: net.chain.nativeCurrency,
            rpcUrls: [net.rpc],
            blockExplorerUrls: net.explorer ? [net.explorer] : [],
          },
        ],
      });
    } else {
      throw switchError;
    }
  }
}

export async function initializeConsensus() {
  const client = writeClient || readClient || getReadClient();
  if (typeof client.initializeConsensusSmartContract === "function") {
    await client.initializeConsensusSmartContract();
  }
}

export async function fundStudioAccount(address) {
  const net = getNetwork(activeNetworkKey);
  if (net.key !== "studionet" && net.key !== "localnet") return null;
  const res = await fetch(net.rpc, {
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

export async function readBalance(address) {
  const net = getNetwork(activeNetworkKey);
  const res = await fetch(net.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "eth_getBalance failed");
  return BigInt(body.result || "0x0");
}

export async function probeNetworkHealth() {
  const net = getNetwork(activeNetworkKey);
  const started = performance.now();
  const out = { key: net.key, label: net.label, rpc: net.rpc, chainId: net.chain.id, ok: false, error: null };
  try {
    const res = await fetch(net.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || "RPC error");
    out.remoteChainId = parseInt(body.result, 16);
    out.ok = out.remoteChainId === net.chain.id;
    if (!out.ok) out.error = `RPC chain ${out.remoteChainId} does not match ${net.chain.id}`;
  } catch (error) {
    out.error = error.message || String(error);
  }
  out.latencyMs = Math.round(performance.now() - started);
  return out;
}
