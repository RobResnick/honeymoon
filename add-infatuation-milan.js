#!/usr/bin/env node
// add-infatuation-milan.js — add Infatuation's Milan restaurant picks
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RECOMMENDED_BY = 'Infatuation';

const PLACES = [
  {
    name: 'Le Latteria',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Brera',
    address: 'Via San Marco 24, 20121 Milano',
    country: 'Italy',
    notes: 'Tiny, legendary Brera trattoria. Simple, perfect Italian food. Cash only, always packed.',
  },
  {
    name: 'Rovello 18',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Brera',
    address: 'Via Tivoli 2, 20121 Milano',
    country: 'Italy',
    notes: 'Relaxed neighbourhood spot near Brera. Great pasta and natural wines.',
  },
  {
    name: '28 Posti',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Navigli',
    address: 'Via Corsico 1, 20144 Milano',
    country: 'Italy',
    notes: 'Only 28 seats. Creative, market-driven Italian cooking in Navigli.',
  },
  {
    name: 'Dongio',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Porta Romana',
    address: 'Via Corio 3, 20135 Milano',
    country: 'Italy',
    notes: 'Best Calabrian food in Milan. Legendary nduja and fileja pasta. Book ahead.',
  },
];

const MILAN_CENTER = [45.46419, 9.18963];
function withinMilan(lat, lng) {
  return Math.abs(lat - MILAN_CENTER[0]) < 0.15 && Math.abs(lng - MILAN_CENTER[1]) < 0.15;
}
function normName(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
}

async function nominatim(address, name) {
  const queries = [address, `${name}, Milan, Italy`];
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=it`;
    const res = await fetch(url, { headers: { 'User-Agent': NOM_UA } });
    const data = await res.json();
    await sleep(1100);
    if (data?.[0]) {
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      if (withinMilan(lat, lng)) return { lat, lng, source: 'nominatim' };
    }
  }
  return null;
}

async function claudeCoords(name, address, neighborhood) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: 150,
      messages: [{ role: 'user', content:
        `GPS coordinates for "${name}" at ${address} in Milan, Italy.\n` +
        `Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"confidence":"high|medium|low"} or {"lat":null,"lng":null}.` }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng && withinMilan(j.lat, j.lng))
      return { lat: j.lat, lng: j.lng, source: `claude:${j.confidence}` };
  } catch (_) {}
  return null;
}

async function main() {
  // Ensure Infatuation is in people list
  const { rows: cfg } = await pool.query(`SELECT value FROM app_config WHERE key='people_list'`);
  let people = cfg.length ? JSON.parse(cfg[0].value) : [];
  if (!people.some(p => (p.name || p).toLowerCase() === RECOMMENDED_BY.toLowerCase())) {
    const sample = people[0];
    people.push(sample && typeof sample === 'object' && 'name' in sample
      ? { name: RECOMMENDED_BY, folder: 'internet' } : RECOMMENDED_BY);
    await pool.query(
      `INSERT INTO app_config(key,value) VALUES('people_list',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
      [JSON.stringify(people)]
    );
    console.log(`✅ Added "${RECOMMENDED_BY}" to people list`);
  } else {
    console.log(`ℹ️  "${RECOMMENDED_BY}" already in people list`);
  }

  const { rows: userRows } = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  const userId = userRows[0]?.id;

  const { rows: existing } = await pool.query(`SELECT name, city FROM recommendations`);
  const existingKeys = new Set(existing.map(r => `${normName(r.name)}|${(r.city||'').toLowerCase()}`));

  let added = 0, skipped = 0;
  for (const p of PLACES) {
    const key = `${normName(p.name)}|${p.city.toLowerCase()}`;
    if (existingKeys.has(key)) {
      console.log(`⏭  "${p.name}" already exists — skipping`);
      skipped++; continue;
    }

    process.stdout.write(`${p.name} … `);
    let lat = null, lng = null;

    const nom = await nominatim(p.address, p.name);
    if (nom) { lat = nom.lat; lng = nom.lng; process.stdout.write(`[${nom.source}] `); }
    else {
      const cl = await claudeCoords(p.name, p.address, p.neighborhood);
      if (cl) { lat = cl.lat; lng = cl.lng; process.stdout.write(`[${cl.source}] `); }
    }

    await pool.query(
      `INSERT INTO recommendations
         (user_id, name, type, city, neighborhood, address, country,
          recommended_by, notes, latitude, longitude, geocode_attempted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
      [userId, p.name, p.type, p.city, p.neighborhood, p.address,
       p.country, RECOMMENDED_BY, p.notes, lat, lng]
    );
    console.log(lat ? `✅ ${lat.toFixed(5)}, ${lng.toFixed(5)}` : `✅ inserted (no coords)`);
    added++;
  }

  console.log(`\nDone. Added: ${added}, skipped: ${skipped}`);
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
