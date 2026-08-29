#!/usr/bin/env node
// fix-florence.js — find and fix Florence places with missing/city-center coordinates
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FLORENCE_CENTER = [43.76980, 11.25564];
const THRESHOLD = 0.002; // ~200m — within this = "city center" stub

function atCityCenter(lat, lng) {
  return (
    Math.abs(lat - FLORENCE_CENTER[0]) < THRESHOLD &&
    Math.abs(lng - FLORENCE_CENTER[1]) < THRESHOLD
  );
}

async function nominatimSearch(name, address, city) {
  const queries = [
    address ? `${name}, ${address}, ${city}, Italy` : null,
    `${name}, ${city}, Italy`,
    `${name} Florence Italy`,
  ].filter(Boolean);

  for (const q of queries) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=it`;
    const res = await fetch(url, { headers: { 'User-Agent': NOM_UA } });
    const data = await res.json();
    await sleep(1100);
    if (data && data[0]) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (!atCityCenter(lat, lng)) {
        return { lat, lng, source: 'nominatim' };
      }
    }
  }
  return null;
}

async function claudeCoords(name, address, city) {
  const addrHint = address ? ` at ${address}` : '';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content:
          `I need GPS coordinates for "${name}"${addrHint} in ${city}, Italy. ` +
          `Give your best estimate — even approximate is fine. ` +
          `Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"confidence":"high|medium|low"} ` +
          `or {"lat":null,"lng":null} if you have absolutely no idea.`,
      }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng && !atCityCenter(j.lat, j.lng)) {
      return { lat: j.lat, lng: j.lng, source: `claude:${j.confidence}` };
    }
  } catch (_) {}
  return null;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, address, neighborhood, notes, latitude, longitude
    FROM recommendations
    WHERE city = 'Florence'
    ORDER BY name
  `);

  const bad = rows.filter(r => {
    if (!r.latitude || !r.longitude) return true;
    return atCityCenter(parseFloat(r.latitude), parseFloat(r.longitude));
  });

  if (bad.length === 0) {
    console.log('✅ All Florence places already have precise coordinates.');
    await pool.end();
    return;
  }

  console.log(`Found ${bad.length} Florence place(s) with missing/city-center coordinates:\n`);
  bad.forEach(r => console.log(`  id:${r.id} ${r.name} (lat:${r.latitude}, lng:${r.longitude})`));
  console.log('');

  let fixed = 0, failed = 0;

  for (const rec of bad) {
    process.stdout.write(`${rec.name} (id:${rec.id}) … `);

    // Try Nominatim first
    const nom = await nominatimSearch(rec.name, rec.address, 'Florence');
    if (nom) {
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
        [nom.lat, nom.lng, rec.id]
      );
      console.log(`✅ ${nom.lat.toFixed(5)}, ${nom.lng.toFixed(5)} [${nom.source}]`);
      fixed++;
      continue;
    }

    // Fall back to Claude
    const cl = await claudeCoords(rec.name, rec.address, 'Florence');
    if (cl) {
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
        [cl.lat, cl.lng, rec.id]
      );
      console.log(`✅ ${cl.lat.toFixed(5)}, ${cl.lng.toFixed(5)} [${cl.source}]`);
      fixed++;
      continue;
    }

    await pool.query(`UPDATE recommendations SET geocode_attempted=TRUE WHERE id=$1`, [rec.id]);
    console.log(`❌ not found`);
    failed++;
  }

  console.log(`\nFixed: ${fixed}, still unknown: ${failed}`);

  // Verify
  const { rows: check } = await pool.query(`
    SELECT id, name, latitude, longitude FROM recommendations WHERE city='Florence' ORDER BY name
  `);
  const stillBad = check.filter(r => {
    if (!r.latitude || !r.longitude) return true;
    return atCityCenter(parseFloat(r.latitude), parseFloat(r.longitude));
  });
  if (stillBad.length === 0) {
    console.log('✅ All Florence places now have precise coordinates — no more yellow ! marks.');
  } else {
    console.log(`\n⚠️  Still at city-center (${stillBad.length}):`);
    stillBad.forEach(r => console.log(`  id:${r.id} ${r.name} ${r.latitude}, ${r.longitude}`));
  }

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
