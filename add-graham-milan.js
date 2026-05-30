#!/usr/bin/env node
// add-graham-milan.js — add Graham's Milan recommendations and create Graham as a person
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PLACES = [
  {
    name: 'Antica Trattoria della Pesa',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Isola',
    country: 'Italy',
    notes: 'Classic Milanese trattoria in Isola. Traditional local cooking.',
    source_url: 'https://share.google/ai6VAvDWpVpIwHrZT',
  },
  {
    name: 'Osteria dal Verme',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Isola',
    country: 'Italy',
    notes: 'Local osteria in Isola neighborhood.',
    source_url: 'https://share.google/Gwl6Pgvwm7QFuZk6p',
  },
  {
    name: 'Trattoria Milanese dal 1933',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Duomo',
    country: 'Italy',
    notes: 'Historic Milanese trattoria since 1933, near Duomo.',
    source_url: 'https://share.google/v3EmK2C24ZUTvYeXZ',
  },
  {
    name: 'Piz',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Duomo',
    country: 'Italy',
    notes: 'Pizza near Duomo.',
    source_url: 'https://share.google/vpq95h98ZQo7i8O1X',
  },
  {
    name: 'Gino Sorbillo',
    type: 'restaurant',
    city: 'Milan',
    neighborhood: 'Duomo',
    country: 'Italy',
    notes: 'Legendary Neapolitan pizza, Milan location near Duomo.',
    source_url: 'https://share.google/WQiMKUk2AbNsVSk9Z',
  },
];

const RECOMMENDED_BY = 'Graham';

const MILAN_CENTER = [45.46419, 9.18963];
function atCityCenter(lat, lng) {
  return Math.abs(lat - MILAN_CENTER[0]) < 0.003 && Math.abs(lng - MILAN_CENTER[1]) < 0.003;
}

async function nominatim(name, neighborhood, city) {
  const queries = [
    `${name}, ${neighborhood}, ${city}, Italy`,
    `${name}, ${city}, Italy`,
  ];
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=it`;
    const res = await fetch(url, { headers: { 'User-Agent': NOM_UA } });
    const data = await res.json();
    await sleep(1100);
    if (data && data[0]) {
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      if (!atCityCenter(lat, lng)) return { lat, lng, source: 'nominatim' };
    }
  }
  return null;
}

async function claudeCoords(name, neighborhood) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: 150,
      messages: [{ role: 'user', content:
        `GPS coordinates for "${name}" in the ${neighborhood} area of Milan, Italy. ` +
        `Best estimate is fine. Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"confidence":"high|medium|low"} ` +
        `or {"lat":null,"lng":null} if truly unknown.` }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng && !atCityCenter(j.lat, j.lng)) return { lat: j.lat, lng: j.lng, source: `claude:${j.confidence}` };
  } catch (_) {}
  return null;
}

function normalizeName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

async function main() {
  // ── 1. Add Graham to the people list ──────────────────────────────────────
  const { rows: cfgRows } = await pool.query(`SELECT value FROM app_config WHERE key='people_list'`);
  let people = cfgRows.length ? JSON.parse(cfgRows[0].value) : [];
  if (!people.some(p => (p.name || p).toLowerCase() === RECOMMENDED_BY.toLowerCase())) {
    // people_list entries can be strings or {name, folder} objects — match existing shape
    const sample = people[0];
    if (sample && typeof sample === 'object' && 'name' in sample) {
      people.push({ name: RECOMMENDED_BY, folder: 'friends' });
    } else {
      people.push(RECOMMENDED_BY);
    }
    await pool.query(
      `INSERT INTO app_config(key,value) VALUES('people_list',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
      [JSON.stringify(people)]
    );
    console.log(`✅ Added "${RECOMMENDED_BY}" to people list\n`);
  } else {
    console.log(`ℹ️  "${RECOMMENDED_BY}" already in people list\n`);
  }

  // ── 2. Get the first user id to own these recs ───────────────────────────
  const { rows: userRows } = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  if (!userRows.length) { console.error('No users found'); await pool.end(); return; }
  const userId = userRows[0].id;

  // ── 3. Load existing recs to check for duplicates ────────────────────────
  const { rows: existing } = await pool.query(`SELECT name, city FROM recommendations`);
  const existingKeys = new Set(existing.map(r => `${normalizeName(r.name)}|${(r.city||'').toLowerCase()}`));

  // ── 4. Insert each place ──────────────────────────────────────────────────
  let added = 0, skipped = 0;
  for (const p of PLACES) {
    const key = `${normalizeName(p.name)}|${p.city.toLowerCase()}`;
    if (existingKeys.has(key)) {
      console.log(`⏭  "${p.name}" already exists — skipping`);
      skipped++;
      continue;
    }

    process.stdout.write(`${p.name} … geocoding … `);
    let lat = null, lng = null, geocodeAttempted = false;

    const nom = await nominatim(p.name, p.neighborhood, p.city);
    if (nom) { lat = nom.lat; lng = nom.lng; geocodeAttempted = true; process.stdout.write(`[${nom.source}] `); }
    else {
      const cl = await claudeCoords(p.name, p.neighborhood);
      if (cl) { lat = cl.lat; lng = cl.lng; geocodeAttempted = true; process.stdout.write(`[${cl.source}] `); }
      else { geocodeAttempted = true; process.stdout.write(`[not found] `); }
    }

    await pool.query(
      `INSERT INTO recommendations
         (user_id, name, type, city, neighborhood, country, recommended_by,
          notes, source_url, latitude, longitude, geocode_attempted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [userId, p.name, p.type, p.city, p.neighborhood, p.country,
       RECOMMENDED_BY, p.notes, p.source_url,
       lat, lng, geocodeAttempted]
    );
    console.log(`✅ added (${lat ? lat.toFixed(4) : 'no lat'}, ${lng ? lng.toFixed(4) : 'no lng'})`);
    added++;
  }

  console.log(`\nDone. Added: ${added}, skipped (already existed): ${skipped}`);
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
