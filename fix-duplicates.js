#!/usr/bin/env node
// fix-duplicates.js — find and remove duplicate recommendations
// Keeps the "best" record per (name, city) group; merges recommended_by; soft-deletes the rest
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// City hierarchy: sub-city → parent city (same as server.js CITY_PARENT)
const CITY_PARENT = {
  'wailea':'maui','kihei':'maui','lahaina':'maui','kapalua':'maui',
  'paia':'maui','hana':'maui','makawao':'maui','kaanapali':'maui',
  'beverly hills':'los angeles','west hollywood':'los angeles',
  'santa monica':'los angeles','venice':'los angeles',
  'silver lake':'los angeles','echo park':'los angeles',
  'los feliz':'los angeles','culver city':'los angeles',
  'brentwood':'los angeles','malibu':'los angeles',
  'pasadena':'los angeles','burbank':'los angeles',
  'topanga':'los angeles',
  'oltrarno':'florence','santa croce':'florence',
};

const CITY_CENTERS = {
  paris:         [48.85889, 2.32004],
  florence:      [43.76980, 11.25564],
  milan:         [45.46419, 9.18963],
  london:        [51.50745, -0.12777],
  'los angeles': [34.05369, -118.24277],
  maui:          [20.79840, -156.33190],
  'san francisco': [37.78794, -122.40752],
  como:          [45.81156, 9.08304],
};

function canonicalCity(city) {
  const c = (city || '').toLowerCase().trim();
  return CITY_PARENT[c] || c;
}

function normalizeName(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function atCityCenter(lat, lng, city) {
  const cc = CITY_CENTERS[canonicalCity(city)];
  if (!cc) return false;
  return Math.abs(lat - cc[0]) < 0.003 && Math.abs(lng - cc[1]) < 0.003;
}

function scorePrecision(r) {
  const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
  if (!lat || !lng) return 0;
  if (atCityCenter(lat, lng, r.city)) return 1;
  return 2; // has real coords
}

function scoreCompleteness(r) {
  let s = 0;
  if (r.address)        s++;
  if (r.neighborhood)   s++;
  if (r.notes)          s++;
  if (r.phone)          s++;
  if (r.source_url)     s++;
  if (r.recommended_by) s++;
  return s;
}

// Pick the best record from a group of duplicates
function pickBest(group) {
  return group.slice().sort((a, b) => {
    const precA = scorePrecision(a), precB = scorePrecision(b);
    if (precB !== precA) return precB - precA;         // higher precision wins
    const compA = scoreCompleteness(a), compB = scoreCompleteness(b);
    if (compB !== compA) return compB - compA;         // more complete wins
    return new Date(b.updated_at) - new Date(a.updated_at); // most recent wins
  })[0];
}

function mergeRecommendedBy(group) {
  const names = new Set();
  for (const r of group) {
    for (const n of (r.recommended_by || '').split(',').map(s => s.trim()).filter(Boolean)) {
      names.add(n);
    }
  }
  return [...names].join(', ');
}

async function main() {
  const { rows } = await pool.query(
    `SELECT * FROM recommendations ORDER BY id`
  );

  // Group by (canonicalCity, normalizedName)
  const groups = new Map();
  for (const r of rows) {
    const key = `${canonicalCity(r.city)}|${normalizeName(r.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const dupes = [...groups.values()].filter(g => g.length > 1);

  if (dupes.length === 0) {
    console.log('✅ No duplicates found.');
    await pool.end();
    return;
  }

  console.log(`Found ${dupes.length} duplicate group(s):\n`);

  let removed = 0;
  for (const group of dupes) {
    const best = pickBest(group);
    const rest = group.filter(r => r.id !== best.id);
    const mergedBy = mergeRecommendedBy(group);

    console.log(`"${best.name}" (${best.city})`);
    console.log(`  Keep  → id:${best.id} (coords:${best.latitude ? '✓' : '✗'}, complete:${scoreCompleteness(best)})`);
    for (const r of rest) {
      console.log(`  Delete→ id:${r.id} (coords:${r.latitude ? '✓' : '✗'}, complete:${scoreCompleteness(r)})`);
    }

    // Update the keeper: merge recommended_by, mark geocode if better record had coords
    const updatedCoords = scorePrecision(best) === 2
      ? '' : '';
    await pool.query(
      `UPDATE recommendations SET recommended_by=$1, updated_at=NOW() WHERE id=$2`,
      [mergedBy || best.recommended_by, best.id]
    );

    // Soft-delete duplicates into deleted_recommendations
    for (const r of rest) {
      await pool.query(`
        INSERT INTO deleted_recommendations
          (id, user_id, name, type, city, neighborhood, address, country,
           latitude, longitude, recommended_by, notes, source_url, raw_input,
           phone, created_at, updated_at, deleted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
        ON CONFLICT (id) DO NOTHING
      `, [
        r.id, r.user_id, r.name, r.type, r.city, r.neighborhood, r.address,
        r.country, r.latitude, r.longitude, r.recommended_by, r.notes,
        r.source_url, r.raw_input, r.phone, r.created_at, r.updated_at
      ]);
      await pool.query(`DELETE FROM recommendations WHERE id=$1`, [r.id]);
      removed++;
    }
    console.log('');
  }

  console.log(`✅ Removed ${removed} duplicate(s). Done.`);
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
