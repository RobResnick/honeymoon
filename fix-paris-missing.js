#!/usr/bin/env node
// fix-paris-missing.js — geocode specific Paris places with missing locations
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PARIS_CENTER = [48.85889, 2.32004];
const THRESHOLD = 0.002;

function atCityCenter(lat, lng) {
  return Math.abs(lat - PARIS_CENTER[0]) < THRESHOLD && Math.abs(lng - PARIS_CENTER[1]) < THRESHOLD;
}

function normalizeName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

const TARGETS = [
  'le griffonnier',
  'valois vintage',
  'valois',
  "a l'elegance d'autrefois",
  "elegance d autrefois",
  "l elegance",
];

async function nominatimSearch(name, city) {
  const queries = [
    `${name}, ${city}, France`,
    `${name} Paris`,
  ];
  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=fr`;
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

async function claudeCoords(name, address) {
  const addrHint = address ? ` at ${address}` : '';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 150,
      messages: [{ role: 'user', content:
        `GPS coordinates for "${name}"${addrHint} in Paris, France. ` +
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

async function main() {
  const { rows: all } = await pool.query(
    `SELECT id, name, address, city, latitude, longitude FROM recommendations WHERE city='Paris' ORDER BY name`
  );

  // Find the target places — fuzzy match on normalized name
  const targets = all.filter(r => {
    const norm = normalizeName(r.name);
    return TARGETS.some(t => norm.includes(normalizeName(t)) || normalizeName(t).includes(norm));
  });

  if (targets.length === 0) {
    console.log('No matching places found. Listing all Paris places with bad coords:\n');
    const bad = all.filter(r => !r.latitude || !r.longitude || atCityCenter(parseFloat(r.latitude), parseFloat(r.longitude)));
    bad.forEach(r => console.log(`  id:${r.id} "${r.name}" lat:${r.latitude} lng:${r.longitude}`));
    await pool.end();
    return;
  }

  console.log(`Found ${targets.length} matching place(s):\n`);
  targets.forEach(r => console.log(`  id:${r.id} "${r.name}" lat:${r.latitude} lng:${r.longitude}`));
  console.log('');

  let fixed = 0, skipped = 0, failed = 0;

  for (const rec of targets) {
    const lat = parseFloat(rec.latitude), lng = parseFloat(rec.longitude);
    if (rec.latitude && rec.longitude && !atCityCenter(lat, lng)) {
      console.log(`⏭  "${rec.name}" already has precise coords (${lat.toFixed(5)}, ${lng.toFixed(5)}) — skipping`);
      skipped++;
      continue;
    }

    process.stdout.write(`"${rec.name}" (id:${rec.id}) … `);

    const nom = await nominatimSearch(rec.name, rec.city);
    if (nom) {
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
        [nom.lat, nom.lng, rec.id]
      );
      console.log(`✅ ${nom.lat.toFixed(5)}, ${nom.lng.toFixed(5)} [${nom.source}]`);
      fixed++; continue;
    }

    const cl = await claudeCoords(rec.name, rec.address);
    if (cl) {
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
        [cl.lat, cl.lng, rec.id]
      );
      console.log(`✅ ${cl.lat.toFixed(5)}, ${cl.lng.toFixed(5)} [${cl.source}]`);
      fixed++; continue;
    }

    await pool.query(`UPDATE recommendations SET geocode_attempted=TRUE WHERE id=$1`, [rec.id]);
    console.log(`❌ not found`);
    failed++;
  }

  console.log(`\nFixed: ${fixed}, skipped (already ok): ${skipped}, failed: ${failed}`);
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
