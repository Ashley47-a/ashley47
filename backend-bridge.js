/**
 * BigEA Claude Bridge
 * -----------------------------------------------------------------------
 * Sits between:
 *   - the MT5 EA (polls this server over WebRequest)
 *   - the web dashboard (config, market scan, logs)
 *   - the Claude API (does the actual market analysis)
 *
 * Why this exists: MT5's WebRequest and a browser's fetch() can both only
 * talk to a real HTTP server. Neither can call api.anthropic.com directly
 * with your key safely (the EA would expose it in plaintext, the browser
 * would hit CORS). This server holds the key once, server-side, and is
 * the single source of truth both sides poll.
 *
 * Run:
 *   npm init -y
 *   npm install express cors
 *   ANTHROPIC_API_KEY=sk-ant-... BRIDGE_TOKEN=choose-a-secret node backend-bridge.js
 *
 * Deploy this on any small VPS (or Render/Railway/Fly.io) with a public
 * HTTPS URL — MT5's WebRequest requires HTTPS and requires the domain to
 * be allow-listed in Tools > Options > Expert Advisors in the terminal.
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || ""; // shared secret for EA + dashboard

// ---------------------------------------------------------------------
// In-memory state. Swap for a real DB (SQLite/Postgres) if you need
// history to survive a restart, or multiple EAs/accounts at once.
// ---------------------------------------------------------------------
const state = {
  config: {
    symbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "XAUUSD"],
    useMartingale: true,
    useStochastic: true,
    useDigitPsychology: true,
    riskPercent: 1.0,
    maxPositions: 8,
  },
  pendingSignals: [], // queue the EA polls and drains
  tradeLog: [],        // trades the EA reports back
  commLog: [],          // every request/response for the dashboard to inspect
  lastScan: null,
};

function logComm(direction, payload) {
  state.commLog.unshift({
    ts: new Date().toISOString(),
    direction, // "dashboard->claude" | "claude->dashboard" | "ea->bridge" | "bridge->ea"
    payload,
  });
  state.commLog = state.commLog.slice(0, 200);
}

function requireAuth(req, res, next) {
  if (!BRIDGE_TOKEN) return next(); // no token configured = open (fine for local testing only)
  const supplied = req.headers["x-bridge-token"];
  if (supplied !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: "invalid or missing x-bridge-token header" });
  }
  next();
}

app.use(requireAuth);

// ---------------------------------------------------------------------
// Config: dashboard reads/writes the strategy config the EA should use
// ---------------------------------------------------------------------
app.get("/config", (req, res) => res.json(state.config));

app.post("/config", (req, res) => {
  state.config = { ...state.config, ...req.body };
  res.json(state.config);
});

// ---------------------------------------------------------------------
// Market scan: dashboard (or a scheduled job) asks Claude to analyze
// the configured symbols and produce a trade signal. Real market data
// should be fetched here server-side (see fetchMarketSnapshot below)
// and passed to Claude — Claude cannot see live prices on its own.
// ---------------------------------------------------------------------
async function fetchMarketSnapshot(symbols) {
  // Placeholder: wire this up to a real data provider (your broker's
  // price API, a futures data feed, Twelve Data, Polygon, etc).
  // Claude's analysis is only as good as the data you hand it here —
  // without this, it will reason from general knowledge only, not
  // live prices, and should not be trusted for real-time signals.
  return symbols.map((s) => ({ symbol: s, note: "no live feed connected yet" }));
}

app.post("/scan", async (req, res) => {
  try {
    const symbols = req.body.symbols || state.config.symbols;
    const snapshot = await fetchMarketSnapshot(symbols);

    const systemPrompt = `You are a market analyst assisting a semi-automated trading system.
You will be given a snapshot of instruments (forex, indices, futures, synthetics).
Respond with ONLY a JSON array, one object per instrument you have an opinion on, no prose outside the JSON.
Each object: {"symbol": string, "action": "BUY"|"SELL"|"HOLD", "reason": string (max 200 chars), "confidence": number 0-1}.
If the snapshot has no real price data for a symbol, return "action":"HOLD" and say why in "reason" — never invent a price or a directional call from no data.`;

    const userPrompt = `Instrument snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nStrategy flags: ${JSON.stringify(
      {
        useMartingale: state.config.useMartingale,
        useStochastic: state.config.useStochastic,
        useDigitPsychology: state.config.useDigitPsychology,
      }
    )}`;

    logComm("dashboard->claude", { symbols, snapshot });

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on the server" });
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    const data = await claudeRes.json();
    const text = (data.content || []).map((b) => b.text || "").join("\n");

    let signals = [];
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      signals = JSON.parse(cleaned);
      if (!Array.isArray(signals)) signals = [signals];
    } catch (e) {
      logComm("claude->dashboard", { raw: text, parseError: String(e) });
      return res.status(502).json({ error: "Claude did not return parseable JSON", raw: text });
    }

    logComm("claude->dashboard", { signals });
    state.lastScan = { ts: new Date().toISOString(), signals };

    // Only BUY/SELL calls with data-backed reasoning get queued for the EA.
    const actionable = signals.filter((s) => s.action === "BUY" || s.action === "SELL");
    state.pendingSignals.push(...actionable.map((s) => ({ ...s, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })));

    res.json({ signals, queued: actionable.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/scan/last", (req, res) => res.json(state.lastScan || {}));

// ---------------------------------------------------------------------
// New: the futures-desk.html webapp now calls Claude directly (with
// web search) instead of asking this server to do it. It posts its
// actionable results here so they still flow into the same EA queue.
// ---------------------------------------------------------------------
app.post("/scan-result", (req, res) => {
  const signals = Array.isArray(req.body.signals) ? req.body.signals : [];
  const withIds = signals.map((s) => ({ ...s, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }));
  state.pendingSignals.push(...withIds);
  state.lastScan = { ts: new Date().toISOString(), signals };
  logComm("webapp->bridge", { queued: withIds.length });
  res.json({ ok: true, queued: withIds.length });
});

// ---------------------------------------------------------------------
// EA polling: the EA calls this on a timer to pick up the next signal
// ---------------------------------------------------------------------
app.get("/signal/next", (req, res) => {
  const next = state.pendingSignals.shift() || null;
  logComm("bridge->ea", { signal: next });
  res.json({ signal: next });
});

// ---------------------------------------------------------------------
// EA reporting: after the EA executes (or rejects) a signal, it reports
// back here so the dashboard's trade log stays accurate.
// ---------------------------------------------------------------------
app.post("/report-trade", (req, res) => {
  const entry = { ts: new Date().toISOString(), ...req.body };
  state.tradeLog.unshift(entry);
  state.tradeLog = state.tradeLog.slice(0, 500);
  logComm("ea->bridge", entry);
  res.json({ ok: true });
});

app.get("/trades", (req, res) => res.json(state.tradeLog));
app.get("/logs", (req, res) => res.json(state.commLog));

app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`BigEA Claude bridge listening on :${PORT}`);
  if (!ANTHROPIC_API_KEY) console.warn("WARNING: ANTHROPIC_API_KEY not set — /scan will fail until it is.");
  if (!BRIDGE_TOKEN) console.warn("WARNING: BRIDGE_TOKEN not set — endpoints are unauthenticated.");
});
