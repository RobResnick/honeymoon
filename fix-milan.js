#!/usr/bin/env node
// fix-milan.js — ensure every Milan place has a unique, correct location
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MILAN_CENTER = [45.46419, 9.18963];
const CENTER_THRESHOLD = 0.002;  // ~200m — city-center stub
const CITY_THRESHOLD   = 0.15;   // ~15km — must be within Milan proper

function atCityCenter(lat, lng) {
  return Math.abs(lat - MILAN_CENTER[0]) < CENTER_THRESHOLD
      && Math.abs(lng - MILAN_CENTER[1]) < CENTER_THRESHOLD;
}
function withinMilan(lat, lng) {
  return Math.abs(lat - MILAN_CENTER[0]) < CITY_THRESHOLD
      && Math.abs(lng - MILAN_CENTER[1]) < CITY_THRESHOLD;
}
function coordKey(lat, lng) {
  // Round to 4 dp (~11m) to detect places sharing the exact same pin
  return `${parseFloat(lat).toFixed(4)},${parseFloat(lng).toFixed(4)}`;
}

async function nominatim(name, address, neighborhood) {
  const queries = [
    address     ? `${address}, Milan, Italy`           : null,
    neighborhood ? `${name}, ${neighborhood}, Milan, Italy` : null,
    `${name}, Milan, Italy`,
    `${name} Milano`,
  ].filter(Boolean);

  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=it`;
    const res = await fetch(url, { headers: { 'User-Agent': NOM_UA } });
    const data = await res.json();
    await sleep(1100);
    if (data?.[0]) {
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      if (!atCityCenter(lat, lng) && withinMilan(lat, lng))
        return { lat, lng, source: 'nominatim' };
    }
  }
  return null;
}

async function claudeCoords(name, address, neighborhood) {
  const hints = [address, neighborhood ? `${neighborhood} neighborhood` : null].filter(Boolean).join(', ');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: 200,
      messages: [{ role: 'user', content:
        `Precise GPS coordinates for "${name}"${hints ? ` (${hints})` : ''} in Milan, Italy.\n` +
        `Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"address":"full street address if known","confidence":"high|medium|low"}\n` +
        `or {"lat":null,"lng":null} only if you have no idea at all.` }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng && !atCityCenter(j.lat, j.lng) && withinMilan(j.lat, j.lng))
      return { lat: j.lat, lng: j.lng, address: j.address || null, source: `claude:${j.confidence}` };
  } catch (_) {}
  return null;
}

async function geocode(rec) {
  const nom = await nominatim(rec.name, rec.address, rec.neighborhood);
  if (nom) return nom;
  const cl = await claudeCoords(rec.name, rec.address, rec.neighborhood);
  return cl;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, address, neighborhood, notes, latitude, longitude
    FROM recommendations WHERE city = 'Milan' ORDER BY name
  `);

  // ── Identify bad places ────────────────────────────────────────────────────
  // 1. Missing coords
  const missing = rows.filter(r => !r.latitude || !r.longitude);

  // 2. City-center stubs
  const stubs = rows.filter(r => r.latitude && r.longitude
    && atCityCenter(parseFloat(r.latitude), parseFloat(r.longitude)));

  // 3. Outside Milan entirely (geocoded to wrong city)
  const wrongCity = rows.filter(r => r.latitude && r.longitude
    && !atCityCenter(parseFloat(r.latitude), parseFloat(r.longitude))
    && !withinMilan(parseFloat(r.latitude), parseFloat(r.longitude)));

  // 4. Duplicate coordinates — two or more places sharing the exact same pin
  const coordGroups = new Map();
  rows.forEach(r => {
    if (!r.latitude || !r.longitude) return;
    const k = coordKey(r.latitude, r.longitude);
    if (!coordGroups.has(k)) coordGroups.set(k, []);
    coordGroups.get(k).push(r);
  });
  const dupeSets = [...coordGroups.values()].filter(g => g.length > 1);
  // Collect the non-stub dupes that need re-geocoding
  const dupes = dupeSets.flatMap(g =>
    atCityCenter(parseFloat(g[0].latitude), parseFloat(g[0].longitude)) ? [] : g
  );

  // Build the fix list (deduplicated by id)
  const seen = new Set();
  const toFix = [...missing, ...stubs, ...wrongCity, ...dupes].filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`\n=== Milan location audit ===`);
  console.log(`  Total places : ${rows.length}`);
  console.log(`  Missing      : ${missing.length}`);
  console.log(`  City-center  : ${stubs.length}`);
  console.log(`  Wrong city   : ${wrongCity.length}`);
  console.log(`  Dup coords   : ${dupes.length} (in ${dupeSets.filter(g => !atCityCenter(parseFloat(g[0].latitude), parseFloat(g[0].longitude))).length} group(s))`);
  console.log(`  → Need fix   : ${toFix.length}\n`);

  if (dupeSets.length) {
    console.log('Duplicate coordinate groups:');
    dupeSets.forEach(g => {
      console.log(`  [${parseFloat(g[0].latitude).toFixed(4)}, ${parseFloat(g[0].longitude).toFixed(4)}]`);
      g.forEach(r => console.log(`    id:${r.id} ${r.name}`));
    });
    console.log('');
  }
  if (wrongCity.length) {
    console.log('Outside-Milan coordinates:');
    wrongCity.forEach(r => console.log(`  id:${r.id} ${r.name} → ${parseFloat(r.latitude).toFixed(4)}, ${parseFloat(r.longitude).toFixed(4)}`));
    console.log('');
  }

  if (toFix.length === 0) {
    console.log('✅ All Milan places have unique, correct coordinates.');
    await pool.end(); return;
  }

  // ── Fix ────────────────────────────────────────────────────────────────────
  let fixed = 0, failed = 0;
  for (const rec of toFix) {
    process.stdout.write(`${rec.name} (id:${rec.id}) … `);
    const coords = await geocode(rec);
    if (coords) {
      const addrClause = coords.address && !rec.address
        ? `, address=$4` : '';
      const params = coords.address && !rec.address
        ? [coords.lat, coords.lng, rec.id, coords.address]
        : [coords.lat, coords.lng, rec.id];
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW()${addrClause} WHERE id=$3`,
        params
      );
      console.log(`✅ ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)} [${coords.source}]`);
      fixed++;
    } else {
      await pool.query(`UPDATE recommendations SET geocode_attempted=TRUE WHERE id=$1`, [rec.id]);
      console.log(`❌ not found`);
      failed++;
    }
  }

  // ── Final verification ─────────────────────────────────────────────────────
  const { rows: final } = await pool.query(`
    SELECT id, name, latitude, longitude FROM recommendations WHERE city='Milan' ORDER BY name
  `);

  const finalMissing = final.filter(r => !r.latitude || !r.longitude);
  const finalStubs   = final.filter(r => r.latitude && r.longitude
    && atCityCenter(parseFloat(r.latitude), parseFloat(r.longitude)));
  const finalCoordGroups = new Map();
  final.forEach(r => {
    if (!r.latitude || !r.longitude) return;
    const k = coordKey(r.latitude, r.longitude);
    if (!finalCoordGroups.has(k)) finalCoordGroups.set(k, []);
    finalCoordGroups.get(k).push(r);
  });
  const finalDupes = [...finalCoordGroups.values()].filter(g => g.length > 1);

  console.log(`\n=== Final state ===`);
  console.log(`  Fixed: ${fixed}, Failed: ${failed}`);
  if (!finalMissing.length && !finalStubs.length && !finalDupes.length) {
    console.log('✅ All Milan places have unique, precise coordinates. No ⚠️ badges.');
  } else {
    if (finalMissing.length) { console.log(`⚠️  Still missing (${finalMissing.length}):`); finalMissing.forEach(r => console.log(`  id:${r.id} ${r.name}`)); }
    if (finalStubs.length)   { console.log(`⚠️  Still at city-center (${finalStubs.length}):`);  finalStubs.forEach(r => console.log(`  id:${r.id} ${r.name}`)); }
    if (finalDupes.length)   {
      console.log(`⚠️  Still duplicated (${finalDupes.length} group(s)):`);
      finalDupes.forEach(g => {
        console.log(`  [${parseFloat(g[0].latitude).toFixed(4)}, ${parseFloat(g[0].longitude).toFixed(4)}]`);
        g.forEach(r => console.log(`    id:${r.id} ${r.name}`));
      });
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
