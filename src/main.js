import deployed from "./deployed.json";
import { explorerAddressUrl, explorerTxUrl } from "./genlayer/networks.js";
import {
  connectInjectedWallet,
  fundStudioAccount,
  generatePrivateKey,
  getActiveAccount,
  getWalletMode,
  probeNetworkHealth,
  readBalance,
  setNetwork,
  usePrivateKey,
} from "./genlayer/client.js";
import {
  activeNetwork,
  appealTx,
  asWei,
  cancelAsk,
  cancelBid,
  clearBid,
  deployBandlot,
  finalizeTx,
  loadSavedAddress,
  pinPrint,
  postAsk,
  postBid,
  readBook,
  readMeta,
  readPreviewMatch,
  readPrint,
  readQuote,
  readSource,
  retireAsk,
  retireBid,
  saveAddress,
  summarizeConsensus,
  voteEntries,
} from "./genlayer/bandlot.js";
import {
  DEMO_DATE,
  DEMO_ZONE,
  errorText,
  formatBps,
  formatEur,
  formatGen,
  intervalLabel,
  isAddress,
  parseCents,
  shortAddress,
  sourceUrl,
} from "./genlayer/rules.js";

const $ = (id) => document.getElementById(id);

const state = {
  address: "",
  busy: false,
  health: null,
  meta: null,
  print: null,
  asks: [],
  bids: [],
  plans: {},
  quarter: 0,
  desk: "",
  balance: null,
  askQuote: null,
  bidQuote: null,
  life: { phase: "idle", message: "No transaction yet.", txHash: "", details: [], votes: [], canAppeal: false },
};

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let scopeFrame = 0;
let quoteTimer = 0;

function fieldValue(id) {
  return $(id).value.trim();
}

function market() {
  return {
    zone: fieldValue("zone") || DEMO_ZONE,
    date: fieldValue("date") || DEMO_DATE,
    quarter: String(state.quarter),
  };
}

function orderFields(prefix) {
  return {
    ...market(),
    mwh: fieldValue(prefix + "Mwh"),
    markup: fieldValue(prefix + "Markup"),
    partial: fieldValue(prefix + "Partial"),
    note: fieldValue(prefix + "Note"),
    expiry: fieldValue(prefix + "Expiry"),
  };
}

function setLife(patch) {
  state.life = { ...state.life, ...patch };
  renderLife();
}

function onProgress(info) {
  const snapshot = info.txHash ? { transaction: info.transaction, lastRound: info.lastRound, canAppeal: info.canAppeal, receiptStatus: info.receiptStatus } : null;
  setLife({
    phase: info.phase || state.life.phase,
    message: info.message || state.life.message,
    txHash: info.txHash || state.life.txHash,
    error: false,
    details: info.transaction || info.lastRound || info.canAppeal != null ? summarizeConsensus(info) : state.life.details,
    votes: info.transaction ? voteEntries(info) : state.life.votes,
    canAppeal: info.canAppeal != null ? Boolean(info.canAppeal) : state.life.canAppeal,
    snapshot: snapshot || state.life.snapshot,
  });
}

function setBusy(busy) {
  state.busy = busy;
  document.body.classList.toggle("is-busy", busy);
  for (const id of ["btnPin", "btnAsk", "btnBid", "btnDeploy", "btnFaucet", "btnSeller", "btnBuyer", "btnWallet"]) {
    const node = $(id);
    if (node) node.disabled = busy;
  }
}

function activeAddress() {
  const account = getActiveAccount();
  if (!account) return "";
  return typeof account === "string" ? account : account.address || "";
}

function loadDesks() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem("bandlot.desks") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDesks(desks) {
  sessionStorage.setItem("bandlot.desks", JSON.stringify(desks));
}

function activateDesk(slot) {
  const desks = loadDesks();
  let desk = desks.find((item) => item.slot === slot);
  if (!desk) {
    const privateKey = generatePrivateKey();
    const opened = usePrivateKey(privateKey);
    desk = { slot, privateKey, address: opened.address };
    saveDesks(desks.filter((item) => item.slot !== slot).concat(desk));
  } else {
    usePrivateKey(desk.privateKey);
  }
  state.desk = slot;
  return desk;
}

async function refreshBalance() {
  const address = activeAddress();
  if (!address) {
    state.balance = null;
    renderAccount();
    return;
  }
  try {
    state.balance = await readBalance(address);
  } catch (error) {
    state.balance = null;
    console.warn(error);
  }
  renderAccount();
}

async function refreshHealth() {
  state.health = await probeNetworkHealth();
  const pip = $("healthPip");
  pip.classList.toggle("is-ok", Boolean(state.health.ok));
  pip.classList.toggle("is-bad", !state.health.ok);
  $("healthText").textContent = state.health.ok
    ? `${state.health.label} · ${state.health.latencyMs} ms`
    : state.health.error || "Network unreachable";
}

async function refresh() {
  renderAccount();
  if (!isAddress(state.address)) {
    state.meta = null;
    state.print = null;
    state.asks = [];
    state.bids = [];
    $("metaLine").textContent = "Bind a Bandlot address, or deploy from this desk.";
    renderTape();
    renderBook();
    return;
  }
  try {
    const { zone, date } = market();
    const [meta, print, book, source] = await Promise.all([
      readMeta(state.address),
      readPrint(state.address, zone, date),
      readBook(state.address),
      readSource(state.address, zone, date),
    ]);
    state.meta = meta;
    state.print = print && !print.error ? print : null;
    state.asks = book.asks;
    state.bids = book.bids;
    const count = state.print ? parseCents(state.print).length : 96;
    if (state.quarter >= count) state.quarter = 0;
    $("metaLine").textContent = meta?.version
      ? `${meta.version} · ${meta.llm_rule === "none" ? "no LLM" : meta.llm_rule} · ${meta.ask_count || 0} asks · ${meta.bid_count || 0} bids`
      : "Meta did not return a version.";
    const link = $("sourceLink");
    const href = source?.source || sourceUrl(zone, date);
    link.href = href;
    link.textContent = href.replace("https://", "");
    await loadPlans();
  } catch (error) {
    $("metaLine").textContent = errorText(error);
  }
  renderTape();
  renderBook();
  scheduleQuotes();
}

async function loadPlans() {
  const funded = state.bids.filter((bid) => bid.status === "FUNDED").slice(0, 8);
  const entries = await Promise.all(
    funded.map(async (bid) => {
      try {
        return [bid.bid_id, await readPreviewMatch(state.address, bid.bid_id)];
      } catch {
        return [bid.bid_id, null];
      }
    })
  );
  state.plans = Object.fromEntries(entries);
}

function scheduleQuotes() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => {
    refreshQuotes().catch(() => {});
  }, 280);
}

async function refreshQuotes() {
  if (!isAddress(state.address) || !state.print) {
    state.askQuote = null;
    state.bidQuote = null;
    renderQuotes();
    return;
  }
  const askFields = orderFields("ask");
  const bidFields = orderFields("bid");
  const [askQuote, bidQuote] = await Promise.all([
    readQuote(state.address, askFields).catch((error) => ({ error: error.message })),
    readQuote(state.address, bidFields).catch((error) => ({ error: error.message })),
  ]);
  state.askQuote = askQuote;
  state.bidQuote = bidQuote;
  renderQuotes();
}

function renderQuotes() {
  $("askQuote").textContent = quoteLine(state.askQuote, "Seller receives this if the bid's cap covers it.");
  $("bidQuote").textContent = quoteLine(state.bidQuote, "Buyer escrows this amount. The contract recomputes it.");
}

function quoteLine(quote, fallback) {
  if (!state.print) return "Pin the print first. The form will not invent a euro price.";
  if (!quote) return fallback;
  if (quote.error) return errorText(quote.error);
  return `${formatEur(quote.unit_cents)} EUR/MWh indexed · escrow ${formatGen(quote.wei)} · print ${formatEur(quote.print_cents)}`;
}

function renderAccount() {
  const address = activeAddress();
  const mode = getWalletMode();
  const desk = state.desk === "seller" ? "Seller desk" : state.desk === "buyer" ? "Buyer desk" : mode === "injected" ? "Wallet" : "No account";
  const balance = state.balance == null ? "balance unread" : formatGen(state.balance);
  $("accountLine").textContent = address ? `${desk} · ${address} · ${balance}` : "Open a seller desk and a buyer desk. The bid has to come from a different account.";
  $("btnSeller").classList.toggle("is-on", state.desk === "seller" && mode === "ephemeral");
  $("btnBuyer").classList.toggle("is-on", state.desk === "buyer" && mode === "ephemeral");
  const mine = address.toLowerCase();
  const ownAsk = state.asks.some(
    (ask) => ask.seller === mine && ask.quarter === String(state.quarter) && (ask.status === "OPEN" || ask.status === "PARTIAL")
  );
  $("selfHint").textContent = ownAsk
    ? "This account already has an open ask on the selected interval. A bid from the same account cannot take it."
    : "Asks and bids on the same interval match only across two accounts.";
}

function renderLife() {
  const phases = ["submitting", "consensus", "accepted", "finality"];
  const current = phases.indexOf(state.life.phase);
  document.querySelectorAll("[data-phase]").forEach((node) => {
    const index = phases.indexOf(node.dataset.phase);
    node.classList.toggle("is-done", current > index && current !== -1);
    node.classList.toggle("is-now", node.dataset.phase === state.life.phase);
    node.classList.toggle("is-bad", Boolean(state.life.error) && node.dataset.phase === state.life.phase);
  });
  $("lifeMessage").textContent = state.life.message || "";
  const link = $("txLink");
  if (state.life.txHash) {
    const href = explorerTxUrl(activeNetwork(), state.life.txHash);
    link.hidden = !href;
    link.href = href || "#";
    link.textContent = state.life.txHash;
  } else {
    link.hidden = true;
  }
  const votes = $("lifeVotes");
  votes.replaceChildren();
  const entries = state.life.votes || [];
  if (!entries.length) {
    votes.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Validator votes appear here when the chain returns them." }));
  } else {
    for (const entry of entries) {
      const lamp = document.createElement("span");
      lamp.className = `lamp-vote is-${String(entry.vote).toLowerCase()}`;
      lamp.textContent = `${shortAddress(entry.address)} ${entry.vote}`;
      votes.append(lamp);
    }
  }
  const detail = $("lifeDetail");
  detail.replaceChildren();
  for (const [key, value] of state.life.details || []) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    detail.append(row);
  }
  $("btnAppeal").disabled = state.busy || !state.life.txHash || !state.life.canAppeal;
  $("btnFinalize").disabled = state.busy || !state.life.txHash || state.life.phase === "idle";
}

function renderTape() {
  const cents = state.print ? parseCents(state.print) : [];
  const tape = $("tape");
  tape.replaceChildren();
  const count = cents.length || 96;
  const finite = cents.filter((value) => Number.isFinite(value));
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 1;
  const span = Math.max(1, max - min);
  for (let index = 0; index < count; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tooth";
    button.dataset.index = String(index);
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", index === state.quarter ? "true" : "false");
    const value = cents[index];
    const known = Number.isFinite(value);
    if (known && value <= 0) button.classList.add("is-dead");
    if (index === state.quarter) button.classList.add("is-selected");
    const heat = known ? (value - min) / span : 0.15;
    const bar = document.createElement("span");
    bar.className = "tooth-bar";
    bar.style.setProperty("--heat", heat.toFixed(3));
    button.append(bar);
    button.title = known ? `${intervalLabel(index)} ${formatEur(value)} EUR/MWh` : intervalLabel(index);
    button.addEventListener("click", () => selectQuarter(index));
    tape.append(button);
  }
  const selected = Number.isFinite(cents[state.quarter]) ? cents[state.quarter] : null;
  $("readoutKicker").textContent = `${market().zone} · ${market().date} · ${intervalLabel(state.quarter)}`;
  if (!state.print) {
    $("readoutFigure").textContent = "—";
    $("readoutUnit").textContent = "EUR/MWh";
    $("readoutSub").textContent = "Empty grid. Pin the delivery day and these cells become the contract's print.";
  } else if (selected == null) {
    $("readoutFigure").textContent = "—";
    $("readoutSub").textContent = "Pinned series has no value at this interval.";
  } else {
    $("readoutFigure").textContent = formatEur(selected);
    $("readoutUnit").textContent = "EUR/MWh";
    $("readoutSub").textContent =
      selected <= 0
        ? "Pinned, and not clearable. The print is zero or negative."
        : `Pinned on the contract. ${count} intervals. A label is index × 15 minutes from the first point, not a timezone conversion.`;
  }
  $("quarterLabel").textContent = intervalLabel(state.quarter);
  drawScope($("scope"), cents, state.quarter, performance.now());
  renderAccount();
}

function selectQuarter(index) {
  state.quarter = index;
  renderTape();
  renderBook();
  scheduleQuotes();
}

function renderBook() {
  renderColumn($("bookAsks"), state.asks, "ask");
  renderColumn($("bookBids"), state.bids, "bid");
  const mine = activeAddress().toLowerCase();
  const onSlot = (row) => row.zone === market().zone && row.date === market().date && row.quarter === String(state.quarter);
  $("askCount").textContent = String(state.asks.filter(onSlot).length);
  $("bidCount").textContent = String(state.bids.filter(onSlot).length);
  $("bookNote").textContent = mine
    ? `Showing the latest orders on this contract. Highlighted rows are ${market().zone} ${market().date} ${intervalLabel(state.quarter)}.`
    : "Open an account to post. The book below is whatever the contract already stores.";
}

function renderColumn(node, rows, kind) {
  node.replaceChildren();
  const slot = market();
  if (!rows.length) {
    node.append(Object.assign(document.createElement("p"), { className: "empty", textContent: kind === "ask" ? "No asks yet." : "No bids yet." }));
    return;
  }
  const mine = activeAddress().toLowerCase();
  for (const row of rows) {
    const card = document.createElement("article");
    const here = row.zone === slot.zone && row.date === slot.date && row.quarter === slot.quarter;
    card.className = `ticket is-${String(row.status || "").toLowerCase()}${here ? " is-here" : ""}`;
    const title = document.createElement("header");
    const id = document.createElement("strong");
    id.textContent = kind === "ask" ? `Ask ${row.ask_id}` : `Bid ${row.bid_id}`;
    const status = document.createElement("span");
    status.textContent = row.status || "";
    title.append(id, status);
    const body = document.createElement("p");
    const who = kind === "ask" ? row.seller : row.buyer;
    const markup = kind === "ask" ? row.markup_bps : row.max_markup_bps;
    body.textContent = `${row.zone} ${row.date} ${intervalLabel(row.quarter)} · ${row.mwh} MWh · ${formatBps(markup)} · print ${formatEur(row.print_cents)} · ${shortAddress(who)}`;
    card.append(title, body);
    if (row.note) {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = row.note;
      card.append(note);
    }
    if (kind === "bid" && row.status === "CLEARED") {
      const done = document.createElement("p");
      done.className = "cleared-line";
      done.textContent = `Matched ask ${row.matched_ask} · paid ${formatGen(row.pay_wei)} · refunded ${formatGen(row.refund_wei)}`;
      card.append(done);
    }
    if (kind === "bid" && row.status === "FUNDED" && state.plans[row.bid_id]) {
      const plan = state.plans[row.bid_id];
      const preview = document.createElement("p");
      preview.className = "note";
      preview.textContent = plan.error
        ? `Preview: ${errorText(plan.error)}`
        : `Preview, not a hold: ask ${plan.ask_id} at ${formatBps(plan.markup_bps)} · pay ${formatGen(plan.pay_wei)}`;
      card.append(preview);
    }
    const actions = document.createElement("div");
    actions.className = "ticket-actions";
    if (kind === "ask" && (row.status === "OPEN" || row.status === "PARTIAL") && row.seller === mine) {
      actions.append(actionButton("Cancel ask", "cancel-ask", row.ask_id));
    }
    if (kind === "ask" && (row.status === "OPEN" || row.status === "PARTIAL")) {
      actions.append(actionButton("Retire if expired", "retire-ask", row.ask_id));
    }
    if (kind === "bid" && row.status === "FUNDED") {
      actions.append(actionButton("Clear", "clear-bid", row.bid_id));
      if (row.buyer === mine) actions.append(actionButton("Refund", "cancel-bid", row.bid_id));
      actions.append(actionButton("Retire if expired", "retire-bid", row.bid_id));
    }
    if (actions.childNodes.length) card.append(actions);
    node.append(card);
  }
}

function actionButton(label, act, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = act === "clear-bid" ? "solid tiny" : "ghost tiny";
  button.dataset.act = act;
  button.dataset.id = id;
  button.textContent = label;
  button.disabled = state.busy;
  return button;
}

function drawScope(canvas, cents, selected) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(223, 242, 106, 0.08)";
  ctx.lineWidth = 1;
  for (let y = 28; y < h - 10; y += 32) {
    ctx.beginPath();
    ctx.moveTo(16, y + 0.5);
    ctx.lineTo(w - 16, y + 0.5);
    ctx.stroke();
  }
  const live = cents.length > 1;
  const series = live ? cents : searchingSeries(performance.now());
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(1, max - min);
  const left = 18;
  const right = w - 18;
  const top = 18;
  const bottom = h - 28;
  ctx.beginPath();
  series.forEach((value, index) => {
    const x = left + (index / (series.length - 1)) * (right - left);
    const y = top + (1 - (value - min) / span) * (bottom - top);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = live ? "rgba(223, 242, 106, 0.92)" : "rgba(223, 242, 106, 0.28)";
  ctx.lineWidth = live ? 1.7 : 1.2;
  ctx.shadowColor = "rgba(223, 242, 106, 0.55)";
  ctx.shadowBlur = live ? 14 : 0;
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (live && selected >= 0 && selected < series.length) {
    const x = left + (selected / (series.length - 1)) * (right - left);
    const y = top + (1 - (series[selected] - min) / span) * (bottom - top);
    ctx.strokeStyle = "rgba(226, 163, 106, 0.85)";
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, h - 12);
    ctx.stroke();
    ctx.fillStyle = "#e2a36a";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function searchingSeries(now) {
  const series = [];
  const phase = reduce ? 0 : now / 900;
  for (let index = 0; index < 96; index += 1) {
    series.push(Math.sin(index / 7 + phase) * 0.35);
  }
  return series;
}

function startScope() {
  const canvas = $("scope");
  const tick = (now) => {
    if (!state.print && !reduce && !document.hidden) drawScope(canvas, [], state.quarter, now);
    scopeFrame = requestAnimationFrame(tick);
  };
  scopeFrame = requestAnimationFrame(tick);
  window.addEventListener("resize", () => drawScope(canvas, state.print ? parseCents(state.print) : [], state.quarter));
}

async function run(action) {
  if (state.busy) return;
  setBusy(true);
  try {
    await action();
    await refreshBalance();
    await refresh();
  } catch (error) {
    setLife({ phase: state.life.phase === "idle" ? "consensus" : state.life.phase, error: true, message: errorText(error) });
  } finally {
    setBusy(false);
    renderBook();
  }
}

async function onPin() {
  await run(async () => {
    const { zone, date } = market();
    await pinPrint(state.address, zone, date, { onProgress });
    $("tape").classList.add("sweeping");
    setTimeout(() => $("tape").classList.remove("sweeping"), 1600);
  });
}

async function onAsk() {
  await run(async () => {
    await postAsk(state.address, orderFields("ask"), { onProgress });
  });
}

async function onBid() {
  await run(async () => {
    const fields = orderFields("bid");
    const quote = await readQuote(state.address, fields);
    if (!quote || quote.error) throw new Error(quote?.error || "quote_failed");
    fields.valueWei = asWei(quote.wei);
    setLife({ phase: "submitting", message: `Escrow from the contract is ${formatGen(fields.valueWei)}. Submitting post_bid…` });
    await postBid(state.address, fields, { onProgress });
  });
}

async function onBookClick(event) {
  const button = event.target.closest("[data-act]");
  if (!button || state.busy) return;
  const id = button.dataset.id;
  const act = button.dataset.act;
  await run(async () => {
    if (act === "clear-bid") await clearBid(state.address, id, { onProgress });
    if (act === "cancel-ask") await cancelAsk(state.address, id, { onProgress });
    if (act === "cancel-bid") await cancelBid(state.address, id, { onProgress });
    if (act === "retire-ask") await retireAsk(state.address, id, { onProgress });
    if (act === "retire-bid") await retireBid(state.address, id, { onProgress });
  });
}

function boot() {
  const saved = loadSavedAddress();
  state.address = saved || deployed.address || "";
  $("contractAddress").value = state.address;
  if (deployed.network) $("networkSelect").value = deployed.network;
  setNetwork($("networkSelect").value || "studionet");
  $("zone").value = DEMO_ZONE;
  $("date").value = DEMO_DATE;
  const stored = loadDesks();
  const prior = stored.find((item) => item.slot === "seller") || stored[0];
  if (prior) {
    usePrivateKey(prior.privateKey);
    state.desk = prior.slot;
  }
  renderLife();
  renderTape();
  startScope();
  $("networkSelect").addEventListener("change", async () => {
    setNetwork($("networkSelect").value);
    await refreshHealth();
    await refresh();
  });
  $("btnSeller").addEventListener("click", () => run(async () => activateDesk("seller")));
  $("btnBuyer").addEventListener("click", () => run(async () => activateDesk("buyer")));
  $("btnWallet").addEventListener("click", () =>
    run(async () => {
      await connectInjectedWallet();
      state.desk = "wallet";
    })
  );
  $("btnFaucet").addEventListener("click", () =>
    run(async () => {
      const address = activeAddress();
      if (!address) throw new Error("Open a desk before funding it.");
      setLife({ phase: "submitting", message: "Requesting Studionet funds…" });
      await fundStudioAccount(address);
      setLife({ phase: "accepted", message: "Fund request returned. Balance reloads from the chain." });
    })
  );
  $("btnBind").addEventListener("click", () =>
    run(async () => {
      const value = $("contractAddress").value.trim();
      if (!isAddress(value)) throw new Error("bad_address");
      state.address = value;
      saveAddress(value);
    })
  );
  $("btnDeploy").addEventListener("click", () =>
    run(async () => {
      const result = await deployBandlot({ onProgress });
      state.address = result.address;
      $("contractAddress").value = result.address;
    })
  );
  $("btnPin").addEventListener("click", onPin);
  $("btnAsk").addEventListener("click", onAsk);
  $("btnBid").addEventListener("click", onBid);
  $("book").addEventListener("click", onBookClick);
  for (const id of ["zone", "date", "askMwh", "askMarkup", "askPartial", "bidMwh", "bidMarkup", "bidPartial"]) {
    $(id).addEventListener("input", () => {
      renderTape();
      scheduleQuotes();
    });
    $(id).addEventListener("change", () => {
      refresh().catch(() => {});
    });
  }
  $("tape").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const count = state.print ? parseCents(state.print).length : 96;
    const next = event.key === "ArrowRight" ? state.quarter + 1 : state.quarter - 1;
    selectQuarter(Math.max(0, Math.min(count - 1, next)));
  });
  $("btnAppeal").addEventListener("click", () =>
    run(async () => {
      await appealTx(state.life.txHash, { onProgress });
    })
  );
  $("btnFinalize").addEventListener("click", () =>
    run(async () => {
      await finalizeTx(state.life.txHash, { onProgress });
    })
  );
  $("btnRefreshTx").addEventListener("click", () =>
    run(async () => {
      if (!state.life.txHash) return;
      const { fetchConsensusSnapshot, summarizeConsensus: sum, voteEntries: votes } = await import("./genlayer/bandlot.js");
      const snapshot = await fetchConsensusSnapshot(state.life.txHash);
      setLife({
        message: "Reloaded this transaction from the chain.",
        details: sum(snapshot),
        votes: votes(snapshot),
        canAppeal: Boolean(snapshot.canAppeal),
      });
    })
  );
  const contractLink = $("contractLink");
  const syncContractLink = () => {
    const href = explorerAddressUrl(activeNetwork(), state.address);
    contractLink.hidden = !href;
    contractLink.href = href || "#";
  };
  syncContractLink();
  refreshHealth();
  refresh();
  refreshBalance();
  setInterval(() => {
    if (!state.busy && !document.hidden) {
      refresh().catch(() => {});
      refreshBalance().catch(() => {});
      syncContractLink();
    }
  }, 25000);
}

boot();
