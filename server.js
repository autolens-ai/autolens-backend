/**
 * AutoLens AI — Monetized Backend
 * Stripe payments + credit tracking + Anthropic API proxy
 *
 * Endpoints:
 *   POST /api/checkout       Create Stripe checkout session
 *   POST /api/webhook        Stripe webhook (adds credits after payment)
 *   POST /api/credits        Check license key balance
 *   POST /api/scan           Car identification (costs 1 credit)
 *   POST /api/build          Build Lab spec (costs 1 credit)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

/* ── CONFIG ─────────────────────────────── */
const PORT         = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SEC  = process.env.STRIPE_WEBHOOK_SECRET;
const MODEL        = 'claude-sonnet-4-20250514';

/* ── PACKAGES ───────────────────────────── */
const PACKAGES = {
  starter: { name: 'Starter Pack',   credits: 150,  price_usd: 499,  emoji: '🚗' },
  pro:     { name: 'Pro Pack',        credits: 400,  price_usd: 999,  emoji: '🏎️' },
  elite:   { name: 'Elite Pack',      credits: 1000, price_usd: 1999, emoji: '🏁' },
};

/* ── DATABASE ───────────────────────────── */
const db = new Database('autolens.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    key        TEXT PRIMARY KEY,
    credits    INTEGER NOT NULL DEFAULT 0,
    scans_used INTEGER NOT NULL DEFAULT 0,
    package    TEXT,
    email      TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    stripe_session TEXT
  );
`);

const addCredits = db.prepare(
  `INSERT INTO licenses (key, credits, scans_used, package, email, stripe_session)
   VALUES (?, ?, 0, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET credits = credits + excluded.credits`
);
const getByKey      = db.prepare(`SELECT * FROM licenses WHERE key = ?`);
const deductCredit  = db.prepare(`UPDATE licenses SET credits = credits - 1, scans_used = scans_used + 1 WHERE key = ? AND credits > 0`);
const getBySession  = db.prepare(`SELECT key FROM licenses WHERE stripe_session = ?`);

/* ── EXPRESS ────────────────────────────── */
const app = express();

// CORS — only allow your frontend
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:8080', 'http://127.0.0.1:8080'],
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// Raw body needed for Stripe webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' })); // large for base64 images

/* ── HELPERS ────────────────────────────── */
function genKey() {
  // Format: AL-XXXX-XXXX-XXXX (easy to type/share)
  const seg = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `AL-${seg()}-${seg()}-${seg()}`;
}

async function callClaude(messages, system = '') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, system, messages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic error ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

function requireKey(req, res, next) {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' });
  const row = getByKey.get(licenseKey);
  if (!row) return res.status(401).json({ error: 'Invalid license key' });
  if (row.credits <= 0) return res.status(402).json({ error: 'No credits remaining. Purchase more at autolensai.netlify.app' });
  req.license = row;
  next();
}

/* ── ROUTES ─────────────────────────────── */

/** Health check */
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/**
 * POST /api/checkout
 * Body: { package: 'starter' | 'pro' | 'elite', email?: string }
 * Returns: { url } — Stripe checkout URL
 */
app.post('/api/checkout', async (req, res) => {
  const { package: pkg, email } = req.body;
  if (!PACKAGES[pkg]) return res.status(400).json({ error: 'Invalid package' });

  const pack = PACKAGES[pkg];
  // Pre-generate the license key so we can embed it in metadata
  const licenseKey = genKey();

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `AutoLens AI — ${pack.name}`,
            description: `${pack.credits} car scans. Your license key: ${licenseKey}`,
            images: [], // add your logo URL here if you have one
          },
          unit_amount: pack.price_usd, // in cents
        },
        quantity: 1,
      }],
      metadata: {
        licenseKey,
        package: pkg,
        credits: String(pack.credits),
      },
      success_url: `${FRONTEND_URL}/success.html?key=${licenseKey}&pkg=${pkg}`,
      cancel_url:  `${FRONTEND_URL}?cancelled=1`,
    });

    // Reserve the key in DB (0 credits until webhook confirms payment)
    addCredits.run(licenseKey, 0, pkg, email || null, session.id);

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhook
 * Stripe sends payment confirmation here → add credits
 */
app.post('/api/webhook', (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SEC);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { licenseKey, credits } = session.metadata;
    if (licenseKey && credits) {
      addCredits.run(licenseKey, parseInt(credits), session.metadata.package, session.customer_email || null, session.id);
      console.log(`✅ Payment confirmed — key ${licenseKey} +${credits} credits`);
    }
  }

  res.json({ received: true });
});

/**
 * POST /api/credits
 * Body: { licenseKey }
 * Returns: { credits, scans_used, package }
 */
app.post('/api/credits', (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: 'licenseKey required' });
  const row = getByKey.get(licenseKey);
  if (!row) return res.status(404).json({ error: 'Key not found' });
  res.json({ credits: row.credits, scans_used: row.scans_used, package: row.package });
});

/**
 * POST /api/scan
 * Body: { licenseKey, imageBase64, mimeType }
 * Returns: car analysis JSON
 * Costs: 1 credit
 */
app.post('/api/scan', requireKey, async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'imageBase64 and mimeType required' });

  try {
    const txt = await callClaude([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: `Analyze this car image. Return ONLY valid JSON, no markdown:
{"isCar":true,"brand":"BMW","model":"M3","trim":"Competition xDrive","yearRange":"2021-2024","confidence":94,
"specs":{"power":"503 hp","torque":"479 lb-ft","acceleration":"3.5s 0-60","topSpeed":"180 mph","drivetrain":"AWD","weight":"3,828 lbs"},
"funFacts":["fact1","fact2","fact3"],
"heritage":"One sentence about this car line's history.",
"marketAnalysis":"2025 used market: pricing range, demand, investment outlook in 2 sentences.",
"upgradePaths":[
{"stage":"Stage 1 — ECU & Air","description":"Software and intake, reversible.","expectedGain":"+45 hp","estimatedCost":"$1,200","keyParts":["ECU Tune","Cold Air Intake","Charge Pipe"]},
{"stage":"Stage 2 — Fueling & Cooling","description":"Intercooler and fueling to support Stage 1.","expectedGain":"+100 hp","estimatedCost":"$5,000","keyParts":["FMIC","Injectors","Downpipe"]},
{"stage":"Stage 3 — Full Build","description":"Turbo and internals for max power.","expectedGain":"+250 hp","estimatedCost":"$18,000","keyParts":["Turbo Kit","Forged Internals","Full Fuel"]}
]}
If not a car: {"isCar":false}` }
      ]
    }], 'You are an automotive expert. Return ONLY valid compact JSON.');

    const data = JSON.parse(txt.replace(/```json|```/g, '').trim());

    // Only deduct if we got a valid response
    deductCredit.run(req.license.key);
    const updated = getByKey.get(req.license.key);

    res.json({ ...data, creditsRemaining: updated.credits });
  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/build
 * Body: { licenseKey, carName, request }
 * Returns: { spec: string }
 * Costs: 1 credit
 */
app.post('/api/build', requireKey, async (req, res) => {
  const { carName, request: buildRequest } = req.body;
  if (!buildRequest) return res.status(400).json({ error: 'request required' });

  try {
    const spec = await callClaude([{
      role: 'user',
      content: `Car: ${carName || 'unspecified'}\nClient request: "${buildRequest}"\n\nWrite a detailed custom build spec: goals, specific parts with brand names, power targets, cost breakdown by category, build order, track vs street notes, pitfalls to avoid. ~400 words.`
    }], 'You are a world-class tuner. Be technical, specific, and direct.');

    deductCredit.run(req.license.key);
    const updated = getByKey.get(req.license.key);

    res.json({ spec, creditsRemaining: updated.credits });
  } catch (err) {
    console.error('Build error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── START ──────────────────────────────── */
app.listen(PORT, () => {
  console.log(`
  ██████╗ ██╗   ██╗████████╗ ██████╗ ██╗     ███████╗███╗   ██╗███████╗
  ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗██║     ██╔════╝████╗  ██║██╔════╝
  ███████║██║   ██║   ██║   ██║   ██║██║     █████╗  ██╔██╗ ██║███████╗
  ██╔══██║██║   ██║   ██║   ██║   ██║██║     ██╔══╝  ██║╚██╗██║╚════██║
  ██║  ██║╚██████╔╝   ██║   ╚██████╔╝███████╗███████╗██║ ╚████║███████║
  ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═══╝╚══════╝

  🚀 Server running on port ${PORT}
  🌐 Allowing requests from: ${FRONTEND_URL}
  `);
});
