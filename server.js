/**
 * AutoLens AI — Backend (Whish Manual Payments)
 *
 *   POST /api/claim-trial     Free 5-credit trial (1 per IP)
 *   POST /api/credits         Check key balance
 *   POST /api/scan            Car scan (1 credit)
 *   POST /api/build           Build spec (1 credit)
 *   POST /api/admin/generate  Generate key (admin)
 *   POST /api/admin/keys      List all keys (admin)
 *   POST /api/admin/topup     Add credits to key (admin)
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';

const PORT          = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASS    = process.env.ADMIN_PASSWORD || 'change-me';
const MODEL         = 'claude-sonnet-4-20250514';

/* ── DATABASE ── */
const db = new Database('autolens.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    key        TEXT PRIMARY KEY,
    credits    INTEGER NOT NULL DEFAULT 0,
    scans_used INTEGER NOT NULL DEFAULT 0,
    package    TEXT DEFAULT 'manual',
    note       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trials (
    ip TEXT PRIMARY KEY,
    claimed_at TEXT DEFAULT (datetime('now'))
  );
`);

const q = {
  insert:   db.prepare(`INSERT OR IGNORE INTO licenses (key,credits,package,note) VALUES (?,?,?,?)`),
  getKey:   db.prepare(`SELECT * FROM licenses WHERE key=?`),
  deduct:   db.prepare(`UPDATE licenses SET credits=credits-1,scans_used=scans_used+1 WHERE key=? AND credits>0`),
  topup:    db.prepare(`UPDATE licenses SET credits=credits+? WHERE key=?`),
  allKeys:  db.prepare(`SELECT key,credits,scans_used,package,note,created_at FROM licenses ORDER BY created_at DESC`),
  getTrial: db.prepare(`SELECT ip FROM trials WHERE ip=?`),
  addTrial: db.prepare(`INSERT OR IGNORE INTO trials (ip) VALUES (?)`),
};

/* ── HELPERS ── */
const genKey = () => {
  const s = () => Math.random().toString(36).substring(2,6).toUpperCase();
  return `AL-${s()}-${s()}-${s()}`;
};
const getIP = req =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

async function callClaude(messages, system='', maxTokens=1000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:MODEL, max_tokens:maxTokens, system, messages }),
  });
  if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(e.error?.message||`Anthropic ${r.status}`); }
  return (await r.json()).content?.[0]?.text || '';
}

const requireAdmin = (req,res,next) =>
  req.body.adminPassword===ADMIN_PASS ? next() : res.status(401).json({error:'Wrong admin password'});

const requireKey = (req,res,next) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({error:'licenseKey required'});
  const row = q.getKey.get(licenseKey);
  if (!row)          return res.status(401).json({error:'Invalid license key'});
  if (row.credits<=0) return res.status(402).json({error:'NO_CREDITS'});
  req.license = row;
  next();
};

/* ── APP ── */
const app = express();
app.use(cors({ origin:'*' }));
app.use(express.json({ limit:'12mb' }));

app.get('/health', (_,res) => res.json({status:'ok'}));

/* FREE TRIAL — 1 per IP */
app.post('/api/claim-trial', (req,res) => {
  const ip = getIP(req);
  if (q.getTrial.get(ip)) return res.status(409).json({error:'TRIAL_USED'});
  const key = genKey();
  q.insert.run(key, 5, 'trial', 'Free trial');
  q.addTrial.run(ip);
  res.json({ key, credits:5 });
});

/* CHECK CREDITS */
app.post('/api/credits', (req,res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({error:'licenseKey required'});
  const row = q.getKey.get(licenseKey);
  if (!row) return res.status(404).json({error:'Key not found'});
  res.json({ credits:row.credits, scans_used:row.scans_used, package:row.package });
});

/* SCAN */
app.post('/api/scan', requireKey, async (req,res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64||!mimeType) return res.status(400).json({error:'imageBase64 and mimeType required'});
  try {
    const txt = await callClaude([{ role:'user', content:[
      { type:'image', source:{ type:'base64', media_type:mimeType, data:imageBase64 } },
      { type:'text', text:`Analyze this car image. Return ONLY valid JSON, no markdown:
{"isCar":true,"brand":"BMW","model":"M3","trim":"Competition xDrive","yearRange":"2021-2024","confidence":94,
"specs":{"power":"503 hp","torque":"479 lb-ft","acceleration":"3.5s 0-60","topSpeed":"180 mph","drivetrain":"AWD","weight":"3,828 lbs"},
"funFacts":["surprising fact 1","surprising fact 2","surprising fact 3"],
"heritage":"One sentence about this model line history.",
"marketAnalysis":"2025 used market pricing and demand in 2 sentences.",
"upgradePaths":[
{"stage":"Stage 1 — ECU & Air","description":"Software and intake, reversible.","expectedGain":"+45 hp","estimatedCost":"$1,200","keyParts":["ECU Tune","Cold Air Intake","Charge Pipe"]},
{"stage":"Stage 2 — Fueling & Cooling","description":"Intercooler and fueling.","expectedGain":"+100 hp","estimatedCost":"$5,000","keyParts":["FMIC","Injectors","Downpipe"]},
{"stage":"Stage 3 — Full Build","description":"Turbo and internals for max power.","expectedGain":"+250 hp","estimatedCost":"$18,000","keyParts":["Turbo Kit","Forged Internals","Full Fuel"]}
]}
If not a car: {"isCar":false}` }
    ]}], 'You are an automotive expert. Return ONLY valid compact JSON.');
    const data = JSON.parse(txt.replace(/```json|```/g,'').trim());
    q.deduct.run(req.license.key);
    const updated = q.getKey.get(req.license.key);
    res.json({ ...data, creditsRemaining:updated.credits });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* BUILD LAB */
app.post('/api/build', requireKey, async (req,res) => {
  const { carName, request:buildReq } = req.body;
  if (!buildReq) return res.status(400).json({error:'request required'});
  try {
    const spec = await callClaude([{ role:'user', content:
      `Car: ${carName||'unspecified'}\nRequest: "${buildReq}"\n\nWrite a detailed custom build spec: goals, specific parts with brand names, power targets, cost breakdown by category, build order, track vs street notes, pitfalls to avoid. ~400 words.`
    }], 'You are a world-class tuner. Be technical, specific, and direct.', 1800);
    q.deduct.run(req.license.key);
    const updated = q.getKey.get(req.license.key);
    res.json({ spec, creditsRemaining:updated.credits });
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ── ADMIN ── */
app.post('/api/admin/generate', requireAdmin, (req,res) => {
  const { credits=150, package:pkg='manual', note='' } = req.body;
  const key = genKey();
  q.insert.run(key, parseInt(credits), pkg, note);
  res.json({ key, credits:parseInt(credits), package:pkg });
});

app.post('/api/admin/keys', requireAdmin, (req,res) => {
  res.json({ keys:q.allKeys.all() });
});

app.post('/api/admin/topup', requireAdmin, (req,res) => {
  const { licenseKey, credits } = req.body;
  const row = q.getKey.get(licenseKey);
  if (!row) return res.status(404).json({error:'Key not found'});
  q.topup.run(parseInt(credits), licenseKey);
  res.json({ key:licenseKey, credits:q.getKey.get(licenseKey).credits });
});

app.listen(PORT, () => console.log(`AutoLens backend running on port ${PORT}`));
