#!/usr/bin/env node
// add-claude-italy.js
// 1. Reads all Milan / Paris / Florence recs to understand the taste + quantity
// 2. Asks Claude to generate a matching list for Lake Como and Sardinia
// 3. Geocodes each place and inserts it attributed to "Claude"
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RECOMMENDED_BY = 'Claude';

// ── Geo helpers ──────────────────────────────────────────────────────────────
const CENTERS = {
  'Lake Como': [45.8080, 9.0852],
  'Sardinia':  [40.1209, 9.0129],
};
const BOUNDS = {
  'Lake Como': { latMin: 45.7, latMax: 46.2, lngMin: 8.9, lngMax: 9.4 },
  'Sardinia':  { latMin: 38.8, latMax: 41.3, lngMin: 8.1, lngMax: 9.9 },
};
function inBounds(lat, lng, city) {
  const b = BOUNDS[city];
  return b && lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax;
}
function coordKey(lat, lng) { return `${parseFloat(lat).toFixed(4)},${parseFloat(lng).toFixed(4)}`; }

const sleep1 = () => sleep(1100);

async function nominatim(name, address, neighborhood, city, country) {
  const region = city === 'Sardinia' ? 'Sardinia, Italy' : `${city}, Italy`;
  const queries = [
    address     ? `${address}, ${region}`               : null,
    neighborhood ? `${name}, ${neighborhood}, ${region}` : null,
    `${name}, ${region}`,
  ].filter(Boolean);
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=it`;
    const res = await fetch(url, { headers: { 'User-Agent': NOM_UA } });
    const data = await res.json();
    await sleep1();
    if (data?.[0]) {
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      if (inBounds(lat, lng, city)) return { lat, lng, source: 'nominatim' };
    }
  }
  return null;
}

async function claudeGeocode(name, address, neighborhood, city) {
  const hint = [address, neighborhood].filter(Boolean).join(', ');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: 200,
      messages: [{ role: 'user', content:
        `GPS coordinates for "${name}"${hint ? ` (${hint})` : ''} in ${city}, Italy.\n` +
        `Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"address":"street address if known","confidence":"high|medium|low"}\n` +
        `or {"lat":null,"lng":null} if completely unknown.` }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng && inBounds(j.lat, j.lng, city))
      return { lat: j.lat, lng: j.lng, address: j.address || null, source: `claude:${j.confidence}` };
  } catch (_) {}
  return null;
}

// ── Step 1: Read existing recs ───────────────────────────────────────────────
async function loadExisting() {
  const { rows } = await pool.query(`
    SELECT name, type, city, neighborhood, address, notes, recommended_by
    FROM recommendations
    WHERE city IN ('Milan','Paris','Florence')
    ORDER BY city, type, name
  `);
  return rows;
}

// ── Step 2: Ask Claude to generate recommendations ───────────────────────────
async function generateRecs(existing) {
  const byCityType = {};
  existing.forEach(r => {
    const k = `${r.city}|${r.type}`;
    byCityType[k] = (byCityType[k] || 0) + 1;
  });

  const cityTotals = {};
  existing.forEach(r => { cityTotals[r.city] = (cityTotals[r.city] || 0) + 1; });

  const targetPerCity = Math.round(
    (Object.values(cityTotals).reduce((a, b) => a + b, 0) / 3) * 0.4
  );
  const target = Math.max(8, Math.min(15, targetPerCity));

  const existingList = existing.map(r =>
    `- ${r.name} (${r.type}, ${r.city}${r.neighborhood ? ', ' + r.neighborhood : ''}${r.notes ? ': ' + r.notes.slice(0, 80) : ''})`
  ).join('\n');

  const prompt = `You are curating a travel recommendations app for someone with excellent taste — the same person who put together this list of favorites in Milan, Paris, and Florence:

${existingList}

Based on the quality, style, and vibe of these places — great local restaurants, historic trattorias, excellent vintage shops, neighbourhood gems — generate ${target} recommendations each for:
1. Lake Como, Italy (towns like Bellagio, Varenna, Como, Menaggio, Cernobbio)
2. Sardinia, Italy (towns like Porto Cervo, Cagliari, Alghero, Bosa, Olbia, San Teodoro)

Focus on: exceptional local restaurants, beautiful spots, noteworthy shops, and anything that matches the calibre of the existing list. Skip generic tourist traps. Prioritise places a well-travelled local would love.

Return a JSON array only, no other text:
[
  {
    "name": "Place Name",
    "type": "restaurant|bar|cafe|shop|hotel|beach|attraction|museum|neighborhood|other",
    "city": "Lake Como" or "Sardinia",
    "neighborhood": "specific town (e.g. Bellagio, Cagliari)",
    "address": "street address if known, else null",
    "notes": "1-2 sentence description of why it's worth going",
    "recommended_by": "Claude"
  }
]

Valid types: restaurant, bar, cafe, museum, attraction, hotel, shop, market, beach, church, neighborhood, other`;

  console.log(`\nAsking Claude to generate ~${target} recs per city based on ${existing.length} existing places…\n`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();

  // Extract JSON array
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) { console.error('No JSON array in Claude response:\n', text); return []; }
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    console.error('Failed to parse Claude response:', e.message);
    console.error(text);
    return [];
  }
}

// ── Step 3: Add "Claude" to people list ─────────────────────────────────────
async function ensurePerson() {
  const { rows } = await pool.query(`SELECT value FROM app_config WHERE key='people_list'`);
  let people = rows.length ? JSON.parse(rows[0].value) : [];
  if (!people.some(p => (p.name || p).toLowerCase() === RECOMMENDED_BY.toLowerCase())) {
    const sample = people[0];
    people.push(sample && typeof sample === 'object' && 'name' in sample
      ? { name: RECOMMENDED_BY, folder: 'friends' }
      : RECOMMENDED_BY);
    await pool.query(
      `INSERT INTO app_config(key,value) VALUES('people_list',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
      [JSON.stringify(people)]
    );
    console.log(`✅ Added "${RECOMMENDED_BY}" to people list`);
  } else {
    console.log(`ℹ️  "${RECOMMENDED_BY}" already in people list`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const existing = await loadExisting();
  console.log(`Loaded ${existing.length} existing places from Milan/Paris/Florence`);

  const generated = await generateRecs(existing);
  if (!generated.length) { await pool.end(); return; }

  console.log(`Generated ${generated.length} recommendations:\n`);
  generated.forEach(p => console.log(`  [${p.city}] ${p.name} (${p.type}, ${p.neighborhood || ''})`));
  console.log('');

  await ensurePerson();

  const { rows: userRows } = await pool.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  if (!userRows.length) { console.error('No users found'); await pool.end(); return; }
  const userId = userRows[0].id;

  // Load existing recs to check for dupes
  const { rows: allExisting } = await pool.query(`SELECT name, city FROM recommendations`);
  function normName(s) {
    return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
  }
  const existingKeys = new Set(allExisting.map(r => `${normName(r.name)}|${(r.city||'').toLowerCase()}`));

  // Track coords used this run to avoid pinning two new places at the same spot
  const usedCoords = new Set();

  let added = 0, skipped = 0, failed = 0;
  console.log('\n── Geocoding and inserting ──\n');

  for (const p of generated) {
    const dupKey = `${normName(p.name)}|${(p.city||'').toLowerCase()}`;
    if (existingKeys.has(dupKey)) {
      console.log(`⏭  "${p.name}" (${p.city}) already exists — skipping`);
      skipped++; continue;
    }

    process.stdout.write(`${p.name} (${p.city}) … `);
    let lat = null, lng = null, finalAddress = p.address || null;

    const nom = await nominatim(p.name, p.address, p.neighborhood, p.city, 'Italy');
    if (nom) {
      lat = nom.lat; lng = nom.lng;
      process.stdout.write(`[${nom.source}] `);
    } else {
      const cl = await claudeGeocode(p.name, p.address, p.neighborhood, p.city);
      if (cl) {
        lat = cl.lat; lng = cl.lng;
        if (cl.address && !finalAddress) finalAddress = cl.address;
        process.stdout.write(`[${cl.source}] `);
      }
    }

    // If this exact coord was already used this run, nudge slightly so pins don't overlap
    if (lat && lng) {
      const ck = coordKey(lat, lng);
      if (usedCoords.has(ck)) {
        lat += 0.0001 * (Math.random() - 0.5);
        lng += 0.0001 * (Math.random() - 0.5);
        process.stdout.write('[nudged] ');
      }
      usedCoords.add(coordKey(lat, lng));
    }

    await pool.query(
      `INSERT INTO recommendations
         (user_id, name, type, city, neighborhood, address, country,
          recommended_by, notes, latitude, longitude, geocode_attempted)
       VALUES ($1,$2,$3,$4,$5,$6,'Italy',$7,$8,$9,$10,$11)`,
      [userId, p.name, p.type, p.city, p.neighborhood || null,
       finalAddress, RECOMMENDED_BY, p.notes || null,
       lat, lng, true]
    );
    console.log(lat ? `✅ ${lat.toFixed(4)}, ${lng.toFixed(4)}` : `✅ inserted (no coords)`);
    added++;
  }

  console.log(`\n── Done ──`);
  console.log(`Added: ${added}, Skipped (dup): ${skipped}, Failed geocode: ${failed}`);

  // Summary by city
  const { rows: summary } = await pool.query(`
    SELECT city, COUNT(*) as n FROM recommendations
    WHERE city IN ('Lake Como','Sardinia') AND recommended_by='Claude'
    GROUP BY city ORDER BY city
  `);
  console.log('\nClaude recs in DB:');
  summary.forEach(r => console.log(`  ${r.city}: ${r.n} places`));

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
