#!/usr/bin/env node
// add-elana-watches.js — add Elana's two Milan vintage watch shops
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PLACES = [
  {
    name: 'Vintage Watches Milano',
    type: 'shop',
    city: 'Milan',
    country: 'Italy',
    notes: 'Vintage watch shop in Milan.',
    source_url: 'https://maps.app.goo.gl/n7aPWHAGE2nb7Y327',
  },
  {
    name: 'Passatempo Orologi da Collezione',
    type: 'shop',
    city: 'Milan',
    country: 'Italy',
    notes: 'Collectible and vintage watch shop in Milan.',
    source_url: 'https://maps.app.goo.gl/LfNjs62F2TkwR7rS6',
  },
];

const RECOMMENDED_BY = 'Elana';
const MILAN_CENTER = [45.46419, 9.18963];

function withinMilan(lat, lng) {
  return Math.abs(lat - MILAN_CENTER[0]) < 0.15 && Math.abs(lng - MILAN_CENTER[1]) < 0.15;
}
function normName(s) {
  return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
}

async function nominatim(name) {
  const queries = [`${name}, Milan, Italy`, `${name} Milano`];
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

async function claudeCoords(name) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: 200,
      messages: [{ role: 'user', content:
        `GPS coordinates for "${name}" in Milan, Italy.\n` +
        `Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"address":"street address","confidence":"high|medium|low"} or {"lat":null,"lng":null}.` }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng && withinMilan(j.lat, j.lng))
      return { lat: j.lat, lng: j.lng, address: j.address || null, source: `claude:${j.confidence}` };
  } catch (_) {}
  return null;
}

async function main() {
  // Ensure Elana is in the people list
  const { rows: cfg } = await pool.query(`SELECT value FROM app_config WHERE key='people_list'`);
  let people = cfg.length ? JSON.parse(cfg[0].value) : [];
  if (!people.some(p => (p.name || p).toLowerCase() === RECOMMENDED_BY.toLowerCase())) {
    const sample = people[0];
    people.push(sample && typeof sample === 'object' && 'name' in sample
      ? { name: RECOMMENDED_BY, folder: 'friends' } : RECOMMENDED_BY);
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
    let lat = null, lng = null, address = null;

    const nom = await nominatim(p.name);
    if (nom) { lat = nom.lat; lng = nom.lng; process.stdout.write(`[${nom.source}] `); }
    else {
      const cl = await claudeCoords(p.name);
      if (cl) { lat = cl.lat; lng = cl.lng; address = cl.address; process.stdout.write(`[${cl.source}] `); }
    }

    await pool.query(
      `INSERT INTO recommendations
         (user_id, name, type, city, address, country, recommended_by, notes, source_url, latitude, longitude, geocode_attempted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
      [userId, p.name, p.type, p.city, address, p.country, RECOMMENDED_BY, p.notes, p.source_url, lat, lng]
    );
    console.log(lat ? `✅ ${lat.toFixed(5)}, ${lng.toFixed(5)}` : `✅ inserted (no coords)`);
    added++;
  }

  console.log(`\nDone. Added: ${added}, skipped: ${skipped}`);
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
