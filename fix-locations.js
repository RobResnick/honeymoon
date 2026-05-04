#!/usr/bin/env node
// fix-locations.js — restore damaged coords + fix remaining city-center ones
require('dotenv').config();
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOM_UA = 'HoneymoonApp/1.0 rob@robresnick.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Original coordinates captured from first DB query — restore anything my first script damaged
// Format: id → [lat, lng]
const ORIGINALS = {
  // Florence — places that had unique coords before script 1 corrupted them
  1:  [43.76810820, 11.25002340], // Da Camilo
  25: [43.77748490, 11.25113820], // Humana People
  63: [43.77189340, 11.25074170], // Humana Vintage Firenze
  64: [43.77125870, 11.24796620], // Epoca Vintage
  60: [43.77544560, 11.25949200], // Street Doing Vintage Couture
  61: [43.77154540, 11.24926200], // Tartan Vintage
  26: [43.77772890, 11.25658100], // Rewind Vintage
  2:  [43.76848110, 11.25391780], // Tre panche

  // London — Archive by Natalie had its own coord (same as city center, genuinely unknown)
  // Nothing to restore here

  // Los Angeles — places with unique coords before damage
  39: [34.07206810, -118.34382990], // American rag cie
  31: [34.02580000, -118.34470000], // Carny couture
  35: [34.07145610, -118.36282370], // Denim revival
  32: [34.05040000, -118.23910000], // Gator's vintage
  38: [34.08611170, -118.34446350], // Jet rag
  40: [34.05610000, -118.42970000], // Klaktus vintage
  29: [34.07035440, -118.40209950], // Nate and Al's
  30: [34.19335000, -118.51840000], // Salsa and Beer #1
  37: [34.08955000, -118.60400500], // The well refill
  36: [34.10768840, -118.59161600], // Topanga creek outpost

  // Milan — all had unique coords
  66: [45.46850000, 9.18740000],  // Cavalli e Nastri Vintage
  79: [45.46130000, 9.18470000],  // Foto Veneta Ottica
  67: [45.47320000, 9.19560000],  // Franco Jacassi Vintage Delirium
  69: [45.45880000, 9.18010000],  // Groupies
  71: [45.47580000, 9.18360000],  // Lipstick Vintage
  65: [45.46880000, 9.18240000],  // Madame Pauline Vintage
  77: [45.45010000, 9.17540000],  // Pourquoi Moi Vintage
  76: [45.44580000, 9.17630000],  // Sous Vintage Shop
  78: [45.46220000, 9.18540000],  // The Cloister
  68: [45.47520000, 9.20670000],  // Vincent Vintage Bijoux

  // Paris — places that had unique coords before damage
  16: [48.86340000, 2.37270000],  // Acid violette
  56: [48.86540000, 2.36190000],  // Chez Snowbunny
  10: [48.86951030, 2.30636600],  // Entrecot
  53: [48.88070000, 2.33880000],  // Iregular
  6:  [48.86703580, 2.35818340],  // L'ami Loui
  7:  [48.87764220, 2.33721060],  // Le bon George
  47: [48.85530000, 2.35590000],  // Palace Callas
  9:  [48.86610240, 2.31648520],  // Pavillon by Yannick Aleno
  51: [48.86300000, 2.36480000],  // Predilection
  48: [48.86200000, 2.36580000],  // Revoir Vintage
  45: [48.85360000, 2.36180000],  // Skat Vintage
  46: [48.86310000, 2.36840000],  // Takk Paris
  44: [48.86930000, 2.36040000],  // Thanx God I'm a V.I.P.
};

// Truly unknown places (were already at city-center in original DB) — need real geocoding
const NEEDS_GEOCODING = [
  // Florence
  { id: 83, name: "C'est chique",          city: 'Florence', country: 'Italy' },
  { id: 85, name: 'Vintage 55',            city: 'Florence', country: 'Italy' },
  // London
  { id: 21, name: 'Archive by Natalie',    city: 'London',   country: 'United Kingdom' },
  // LA
  { id: 86, name: 'El Tijuanese',          city: 'Los Angeles', country: 'United States' },
  // Paris
  { id: 88, name: 'Kis Paris',             city: 'Paris',    country: 'France' },
  { id: 92, name: 'Safe Concept',          city: 'Paris',    country: 'France' },
  { id: 87, name: 'The Archivist Store',   city: 'Paris',    country: 'France' },
  { id: 89, name: 'The Broke Arm',         city: 'Paris',    country: 'France' },
  { id: 54, name: 'The Parisian Vintage',  city: 'Paris',    country: 'France' },
  { id: 58, name: 'The Statement',         city: 'Paris',    country: 'France' },
  { id: 57, name: 'Depot Sauvage',         city: 'Paris',    country: 'France' },
  { id: 91, name: 'Dover Street Market Paris', city: 'Paris', country: 'France' },
  { id: 90, name: 'Words sounds colors and shapes', city: 'Paris', country: 'France' },
  { id: 50, name: 'La Frange à l\'envers', city: 'Paris',   country: 'France' },
  { id: 4,  name: 'La Renommee',           city: 'Paris',    country: 'France' },
  { id: 49, name: 'Open Dressing',         city: 'Paris',    country: 'France' },
  { id: 75, name: 'Safe Concept',          city: 'Paris',    country: 'France' },
  { id: 59, name: 'Amarsi',                city: 'Paris',    country: 'France' },
  { id: 52, name: 'Bobby',                 city: 'Paris',    country: 'France' },
];

// Ask Claude Opus for coords directly with permission to guess
async function claudeCoords(name, city, country) {
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
        content: `I need GPS coordinates for "${name}" in ${city}, ${country}. ` +
          `Give your best estimate based on any knowledge you have — even approximate is fine. ` +
          `Return ONLY JSON: {"lat":NUMBER,"lng":NUMBER,"confidence":"high|medium|low"} ` +
          `or {"lat":null,"lng":null} only if you have absolutely no idea where this is.`
      }]
    })
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (j.lat && j.lng) return { lat: j.lat, lng: j.lng, confidence: j.confidence };
  } catch (_) {}
  return null;
}

async function nominatimSearch(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
  const res = await fetch(url, { headers: { 'User-Agent': NOM_UA } });
  const data = await res.json();
  await sleep(1100);
  if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  return null;
}

async function main() {
  console.log('\n=== STEP 1: Restore original coordinates ===\n');
  let restored = 0;
  for (const [id, [lat, lng]] of Object.entries(ORIGINALS)) {
    await pool.query(
      `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
      [lat, lng, id]
    );
    const { rows } = await pool.query(`SELECT name FROM recommendations WHERE id=$1`, [id]);
    console.log(`✅ Restored ${rows[0]?.name}: ${lat}, ${lng}`);
    restored++;
  }
  console.log(`\nRestored ${restored} places\n`);

  console.log('\n=== STEP 2: Geocode truly unknown places ===\n');

  // Deduplicate by id
  const seen = new Set();
  const toFix = NEEDS_GEOCODING.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });

  let fixed = 0, failed = 0;
  for (const rec of toFix) {
    process.stdout.write(`${rec.name} (${rec.city}) … `);

    // Try Claude first
    const coords = await claudeCoords(rec.name, rec.city, rec.country);
    if (coords && coords.lat) {
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
        [coords.lat, coords.lng, rec.id]
      );
      console.log(`✅ ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)} [claude, ${coords.confidence}]`);
      fixed++;
      continue;
    }

    // Try Nominatim freetext
    const nom = await nominatimSearch(`${rec.name}, ${rec.city}, ${rec.country}`);
    if (nom) {
      await pool.query(
        `UPDATE recommendations SET latitude=$1, longitude=$2, geocode_attempted=TRUE, updated_at=NOW() WHERE id=$3`,
        [nom.lat, nom.lng, rec.id]
      );
      console.log(`✅ ${nom.lat.toFixed(5)}, ${nom.lng.toFixed(5)} [nominatim]`);
      fixed++;
      continue;
    }

    await pool.query(`UPDATE recommendations SET geocode_attempted=TRUE WHERE id=$1`, [rec.id]);
    console.log(`❌ not found`);
    failed++;
  }

  console.log(`\nGeocoded: ${fixed}, still unknown: ${failed}`);

  // Final check
  const CITY_CENTERS = {
    paris:           [48.85889, 2.32004],
    florence:        [43.76980, 11.25564],
    milan:           [45.46419, 9.18963],
    london:          [51.50745, -0.12777],
    'los angeles':   [34.05369, -118.24277],
    maui:            [20.79840, -156.33190],
    'san francisco': [37.78794, -122.40752],
    como:            [45.81156, 9.08304],
  };
  function atCenter(lat, lng, city) {
    const cc = CITY_CENTERS[(city||'').toLowerCase()];
    if (!cc) return false;
    return Math.abs(lat - cc[0]) < 0.002 && Math.abs(lng - cc[1]) < 0.002;
  }

  const { rows: all } = await pool.query(`SELECT id, name, city, latitude, longitude FROM recommendations ORDER BY city, name`);
  const stillBad = all.filter(r => r.latitude && r.longitude && atCenter(parseFloat(r.latitude), parseFloat(r.longitude), r.city));

  console.log('\n=== FINAL VERIFICATION ===');
  if (stillBad.length === 0) {
    console.log('✅ All places now have unique precise coordinates!');
  } else {
    console.log(`⚠️  Still at city-center (${stillBad.length}):`);
    stillBad.forEach(r => console.log(`  id:${r.id} ${r.name} (${r.city}) ${r.latitude}, ${r.longitude}`));
  }

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
