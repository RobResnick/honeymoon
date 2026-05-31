#!/usr/bin/env node
// milan-walking-route.js
// Computes an optimised walking route through all Milan places, starting from
// the Four Seasons Milan (Via Gesù 6/8). Uses nearest-neighbour TSP + 2-opt
// improvement. Prints a day-friendly itinerary with walk times.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const START = {
  name: 'Four Seasons Milan',
  address: 'Via Gesù 6/8, 20121 Milano',
  lat: 45.46688,
  lng: 9.19903,
};

const WALK_KMH = 4.8; // comfortable urban walking pace
const MILAN_CENTER = [45.46419, 9.18963];
const CENTER_THRESHOLD = 0.003;

function atCityCenter(lat, lng) {
  return Math.abs(lat - MILAN_CENTER[0]) < CENTER_THRESHOLD
      && Math.abs(lng - MILAN_CENTER[1]) < CENTER_THRESHOLD;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function walkMins(km) { return Math.round(km / WALK_KMH * 60); }
function fmtMins(m) { return m < 60 ? `${m} min walk` : `${Math.floor(m/60)}h ${m%60}min walk`; }

function typeEmoji(t) {
  const map = { restaurant:'🍽️', bar:'🍷', cafe:'☕', shop:'🛍️', museum:'🏛️',
    attraction:'📍', hotel:'🏨', market:'🏪', beach:'🏖️', church:'⛪', neighborhood:'🗺️' };
  return map[t] || '📍';
}

// ── Nearest-neighbour TSP ──────────────────────────────────────────────────
function nearestNeighbour(start, places) {
  const route = [];
  const remaining = [...places];
  let current = start;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineKm(current.lat, current.lng, p.lat, p.lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    route.push(remaining.splice(bestIdx, 1)[0]);
    current = route[route.length - 1];
  }
  return route;
}

// ── 2-opt improvement ──────────────────────────────────────────────────────
function routeDistance(start, route) {
  let d = haversineKm(start.lat, start.lng, route[0].lat, route[0].lng);
  for (let i = 0; i < route.length - 1; i++)
    d += haversineKm(route[i].lat, route[i].lng, route[i+1].lat, route[i+1].lng);
  return d;
}

function twoOpt(start, route) {
  let best = [...route];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const candidate = [...best.slice(0, i+1), ...best.slice(i+1, j+1).reverse(), ...best.slice(j+1)];
        if (routeDistance(start, candidate) < routeDistance(start, best)) {
          best = candidate; improved = true;
        }
      }
    }
  }
  return best;
}

// ── Split into half-day clusters if total walk is > 5 km ─────────────────
function splitDays(start, route) {
  const totalKm = routeDistance(start, route);
  if (totalKm <= 5.5 || route.length <= 6) return [route];

  // Split at the midpoint by distance
  let cum = 0;
  let splitAt = 1;
  const half = totalKm / 2;
  let prev = start;
  for (let i = 0; i < route.length; i++) {
    cum += haversineKm(prev.lat, prev.lng, route[i].lat, route[i].lng);
    prev = route[i];
    if (cum >= half) { splitAt = i + 1; break; }
  }
  return [route.slice(0, splitAt), route.slice(splitAt)];
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, type, neighborhood, address, notes, latitude, longitude, recommended_by
    FROM recommendations
    WHERE city = 'Milan'
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
    ORDER BY name
  `);

  const places = rows
    .map(r => ({ ...r, lat: parseFloat(r.latitude), lng: parseFloat(r.longitude) }))
    .filter(r => !atCityCenter(r.lat, r.lng));

  if (!places.length) {
    console.log('No Milan places with valid coordinates found.');
    await pool.end(); return;
  }

  // Optimise route
  const nn = nearestNeighbour(START, places);
  const optimised = twoOpt(START, nn);
  const totalKm = routeDistance(START, optimised);
  const totalMins = walkMins(totalKm);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🚶 MILAN WALKING ROUTE`);
  console.log(`  Starting: ${START.name}`);
  console.log(`  ${START.address}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ${places.length} stops  ·  ${totalKm.toFixed(1)} km total  ·  ~${fmtMins(totalMins)} walking\n`);

  const days = splitDays(START, optimised);
  const labels = days.length > 1 ? ['Morning / Day 1', 'Afternoon / Day 2'] : [null];

  let prev = START;
  let stopNum = 1;

  days.forEach((segment, dayIdx) => {
    if (labels[dayIdx]) {
      console.log(`── ${labels[dayIdx]} ${'─'.repeat(40 - labels[dayIdx].length)}`);
    }

    segment.forEach(p => {
      const dist = haversineKm(prev.lat, prev.lng, p.lat, p.lng);
      const mins = walkMins(dist);
      const by = p.recommended_by ? `  [${p.recommended_by}]` : '';
      const hood = p.neighborhood ? ` · ${p.neighborhood}` : '';
      const addr = p.address ? `\n     ${p.address}` : '';
      const note = p.notes ? `\n     ${p.notes.slice(0, 100)}${p.notes.length > 100 ? '…' : ''}` : '';

      console.log(`\n  ↓  ${fmtMins(mins)} (${dist.toFixed(2)} km)\n`);
      console.log(`  ${stopNum}. ${typeEmoji(p.type)} ${p.name}${by}`);
      console.log(`     ${p.type}${hood}${addr}${note}`);
      prev = p;
      stopNum++;
    });

    if (dayIdx < days.length - 1) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  → Return to Four Seasons, then continue tomorrow`);
      console.log(`${'─'.repeat(60)}`);
      prev = START; // reset for next day
    }
  });

  // Return distance
  const returnDist = haversineKm(prev.lat, prev.lng, START.lat, START.lng);
  console.log(`\n  ↓  ${fmtMins(walkMins(returnDist))} (${returnDist.toFixed(2)} km)\n`);
  console.log(`  🏨  ${START.name} — home base\n`);
  console.log(`${'═'.repeat(60)}\n`);

  // Type breakdown
  const byType = {};
  places.forEach(p => { byType[p.type] = (byType[p.type] || 0) + 1; });
  console.log('Stops by type:');
  Object.entries(byType).sort((a,b) => b[1]-a[1]).forEach(([t,n]) => console.log(`  ${typeEmoji(t)} ${t}: ${n}`));
  console.log('');

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
