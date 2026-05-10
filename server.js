const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ── API Keys ──────────────────────────────────────────────────────────────────
const TWELVE_KEYS = [
  process.env.TWELVE_DATA_KEY_1,
  process.env.TWELVE_DATA_KEY_2,
  process.env.TWELVE_DATA_KEY_3,
].filter(Boolean);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (TWELVE_KEYS.length === 0) {
  console.error("❌ No Twelve Data keys found.");
  process.exit(1);
}
if (!ANTHROPIC_KEY) {
  console.error("❌ No Anthropic API key found. Set ANTHROPIC_API_KEY in Railway variables.");
  process.exit(1);
}

function getKey(index) {
  return TWELVE_KEYS[index % TWELVE_KEYS.length];
}

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "20mb" })); // large enough for base64 chart images

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "Signal Proxy running",
    twelve_keys: TWELVE_KEYS.length,
    anthropic: !!ANTHROPIC_KEY,
    endpoints: ["/gold/all", "/spy/all", "/symbol/all", "/analyze/chart", "/health"],
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, keys: TWELVE_KEYS.length, uptime: Math.floor(process.uptime()) });
});

// ── Twelve Data Fetcher ───────────────────────────────────────────────────────
async function fetchCandles(symbol, interval, outputsize, keyIndex) {
  const key = getKey(keyIndex);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from Twelve Data`);
  const json = await res.json();
  if (json.status === "error") throw new Error(`Twelve Data: ${json.message}`);
  if (!json.values || json.values.length === 0) throw new Error(`No data for ${symbol} ${interval}`);
  return [...json.values].reverse();
}

async function fetchAll(symbol) {
  const [c5, c15, c1h] = await Promise.all([
    fetchCandles(symbol, "5min",  80, 0),
    fetchCandles(symbol, "15min", 80, 1),
    fetchCandles(symbol, "1h",    40, 2),
  ]);
  return { symbol, c5, c15, c1h };
}

// ── Market Data Endpoints ─────────────────────────────────────────────────────
app.get("/gold/all", async (req, res) => {
  try { res.json(await fetchAll("XAU/USD")); }
  catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

app.get("/spy/all", async (req, res) => {
  try { res.json(await fetchAll("SPY")); }
  catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

app.get("/symbol/all", async (req, res) => {
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker param required" });
  try { res.json(await fetchAll(ticker)); }
  catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// ── Chart Analysis (Vision + Technicals) ─────────────────────────────────────
// POST /analyze/chart
// Body: {
//   imageBase64: "data:image/png;base64,...",
//   technicals: { ...computed tech object },
//   instrument: "GOLD" | "SPY",
//   signal: { ...existing Claude signal }
// }

app.post("/analyze/chart", async (req, res) => {
  const { imageBase64, technicals, instrument, signal } = req.body;

  if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });
  if (!technicals)  return res.status(400).json({ error: "technicals required" });

  // Strip data URI prefix if present
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
  const mediaType  = imageBase64.startsWith("data:image/png") ? "image/png"
                   : imageBase64.startsWith("data:image/jpg") || imageBase64.startsWith("data:image/jpeg") ? "image/jpeg"
                   : "image/png";

  const systemPrompt = `You are an elite futures day trader and technical analyst specializing in ${instrument === "GOLD" ? "Micro Gold (MGC)" : "Micro E-mini S&P 500 (MES)"}.

You will receive:
1. A chart screenshot from the trader
2. Live computed technicals (EMA, ATR, VWAP, key levels)
3. The existing AI signal based on technicals alone

Your job is to visually analyze the chart and provide a COMBINED verdict that integrates both the visual price action AND the computed technicals.

Respond ONLY with valid JSON. No markdown. No text outside JSON.
Schema:
{
  "visual_signal": "BUY" | "SELL" | "NO TRADE",
  "combined_signal": "BUY" | "SELL" | "NO TRADE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "agreement": "CONFIRMS" | "CONFLICTS" | "NEUTRAL",
  "patterns_detected": ["list of chart patterns you see"],
  "visual_levels": ["key price levels visible on chart"],
  "candle_structure": "description of recent candle structure",
  "entry": number | null,
  "stop": number | null,
  "target": number | null,
  "risk_per_contract": number | null,
  "chart_analysis": "3-4 sentence detailed visual analysis",
  "action": "concrete actionable recommendation",
  "warnings": "any red flags or empty string",
  "setup_quality": number (1-10)
}`;

  const userContent = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64Data,
      },
    },
    {
      type: "text",
      text: `Analyze this ${instrument} chart screenshot.

LIVE TECHNICALS:
Price: $${technicals.price}
VWAP: $${technicals.vwap} (${technicals.priceVsVwap})
5M  Bias: ${technicals.emaBias5}  (EMA9: $${technicals.ema9_5} / EMA21: $${technicals.ema21_5})
15M Bias: ${technicals.emaBias15} (EMA9: $${technicals.ema9_15} / EMA21: $${technicals.ema21_15})
1H  Bias: ${technicals.emaBias1h} (EMA9: $${technicals.ema9_1h} / EMA21: $${technicals.ema21_1h})
ATR 5M: $${technicals.atr5}  ATR 15M: $${technicals.atr15}
Session High: $${technicals.pdHigh}  Session Low: $${technicals.pdLow}
Recent High: $${technicals.onHigh}  Recent Low: $${technicals.onLow}
Round Number: $${technicals.roundNum}
Session: ${technicals.session}
TF Alignment: ${technicals.alignment}

EXISTING DATA SIGNAL: ${signal ? signal.signal : "N/A"} (${signal ? signal.confidence : "N/A"} confidence)
Data Signal Reasoning: ${signal ? signal.reasoning : "N/A"}

Now analyze the CHART VISUALLY and provide your combined verdict.
Look for: trend structure, support/resistance, candle patterns, momentum, volume if visible, any divergences.
Your combined_signal should weigh both the visual evidence and the computed technicals.`,
    },
  ];

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error: ${response.status} — ${err}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "{}";

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      parsed = {
        visual_signal: "NO TRADE",
        combined_signal: "NO TRADE",
        confidence: "LOW",
        agreement: "NEUTRAL",
        patterns_detected: [],
        chart_analysis: "Could not parse chart analysis response.",
        action: "Review chart manually.",
        warnings: "Parse error",
        setup_quality: 0,
      };
    }

    res.json(parsed);
  } catch (e) {
    console.error("Chart analysis error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Signal Proxy live on port ${PORT}`);
  console.log(`   Twelve Data keys: ${TWELVE_KEYS.length}`);
  console.log(`   Anthropic Vision: ${ANTHROPIC_KEY ? "✅" : "❌"}`);
});
