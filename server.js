require('dotenv').config({ override: true });
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const fetch = require('node-fetch');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.SESSION_SECRET || 'honeymoon-secret';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '90d' });
}

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Initialize DB schema
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name VARCHAR(500) NOT NULL,
      type VARCHAR(100),
      city VARCHAR(255),
      neighborhood VARCHAR(255),
      address VARCHAR(500),
      country VARCHAR(255) DEFAULT 'Italy',
      latitude DECIMAL(10, 8),
      longitude DECIMAL(11, 8),
      recommended_by VARCHAR(255),
      notes TEXT,
      source_url VARCHAR(1000),
      raw_input TEXT,
      phone VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Add phone to existing tables that predate this column
  await pool.query(`ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`);

  // Deleted items log (for future "deleted" section)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_recommendations (
      id INTEGER, user_id INTEGER,
      name VARCHAR(500), type VARCHAR(100), city VARCHAR(255),
      neighborhood VARCHAR(255), address VARCHAR(500), country VARCHAR(255),
      latitude DECIMAL(10,8), longitude DECIMAL(11,8),
      recommended_by VARCHAR(255), notes TEXT, source_url VARCHAR(1000),
      raw_input TEXT, phone VARCHAR(50),
      created_at TIMESTAMP, deleted_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name]
    );
    const token = generateToken(result.rows[0].id);
    res.json({ token, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(result.rows[0].id);
    res.json({ token, user: { id: result.rows[0].id, email: result.rows[0].email, name: result.rows[0].name } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.userId]);
  res.json(result.rows[0]);
});

// Parse raw input with Claude
// Extract Open Graph / Twitter meta tag values from HTML
function extractMetaTags(html) {
  const tags = {};
  const metaRe = /<meta[^>]+>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const prop = (tag.match(/(?:property|name)="([^"]+)"/i) || [])[1];
    const content = (tag.match(/content="([^"]*)"/i) || [])[1];
    if (prop && content) tags[prop.toLowerCase()] = content;
  }
  return tags;
}

// Fetch a URL and extract readable plain text from its HTML.
// For social media (Instagram, TikTok, Twitter) we rely on OG meta tags
// which are server-rendered even without login.
async function fetchPageText(url) {
  const resp = await fetch(url, {
    headers: {
      // Pretend to be a browser so sites return full HTML (including OG tags)
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    timeout: 12000,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  // Pull Open Graph / Twitter card meta tags — reliable on Instagram, TikTok, etc.
  const meta = extractMetaTags(html);
  const ogParts = [
    meta['og:title'],
    meta['og:description'],
    meta['twitter:title'],
    meta['twitter:description'],
    meta['description'],
  ].filter(Boolean).map(s =>
    s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
  );

  // Also extract body text for article-style pages
  let bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,' ')
    .replace(/\s{3,}/g, '\n\n')
    .trim();

  // For social media posts the OG description IS the caption — put it first and prominent
  const isSocial = /instagram\.com|tiktok\.com|twitter\.com|x\.com|facebook\.com/.test(url);
  let text;
  if (isSocial) {
    // OG tags are the content; body text is mostly JS junk
    text = ogParts.join('\n\n');
    if (!text) throw new Error('No readable content found (post may be private)');
  } else {
    // Article pages: prefer body text, prepend OG summary
    text = (ogParts.length ? ogParts.join('\n\n') + '\n\n' : '') + bodyText;
  }

  if (text.length > 12000) text = text.slice(0, 12000) + '…';
  return text;
}

app.post('/api/parse', requireAuth, async (req, res) => {
  let { input } = req.body;
  if (!input) return res.status(400).json({ error: 'Input required' });

  let sourceUrl = '';
  const urlMatch = input.trim().match(/^(https?:\/\/[^\s]+)$/i);
  if (urlMatch) {
    // Input is a URL — fetch the page and parse its content
    sourceUrl = urlMatch[1];
    try {
      input = await fetchPageText(sourceUrl);
    } catch (err) {
      console.error('URL fetch error:', err.message);
      return res.status(422).json({ error: `Could not fetch that URL: ${err.message}` });
    }
  }

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `You are helping parse travel recommendations. Extract all place recommendations from the following content and return them as a JSON array. Each recommendation should have these fields:
- name: the place name (required)
- type: one of "restaurant", "bar", "cafe", "museum", "attraction", "hotel", "shop", "market", "beach", "church", "neighborhood", "other"
- city: the city (e.g. Rome, Florence, Venice, Paris, etc.)
- neighborhood: neighborhood or area within the city (if mentioned)
- address: street address if mentioned
- recommended_by: who recommended it (if mentioned)
- notes: any additional details, descriptions, or context about the place
- source_url: ${sourceUrl ? `"${sourceUrl}"` : 'any URL associated with this place (if present), otherwise empty string'}
- phone: phone number if mentioned, otherwise empty string

Return ONLY a valid JSON array, no other text. Extract every distinct place mentioned. Example:
[{"name":"Trattoria da Mario","type":"restaurant","city":"Florence","neighborhood":"Santa Croce","address":"","recommended_by":"","notes":"Amazing pasta, cash only","source_url":"${sourceUrl}","phone":""}]

Content to parse:
${input}`
        }]
      })
    });
    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text?.trim();
    if (!text) return res.status(422).json({ error: 'No response from AI' });
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse input' });

    const parsed = JSON.parse(jsonMatch[0]);
    // If we fetched a URL, make sure source_url is set on all results
    if (sourceUrl) parsed.forEach(p => { if (!p.source_url) p.source_url = sourceUrl; });
    res.json({ recommendations: parsed });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse input' });
  }
});

// In-memory city coordinate cache (per process lifetime)
const cityCoordCache = {};

async function geocodeCity(city) {
  if (!city) return null;
  const key = city.toLowerCase().trim();
  if (cityCoordCache[key]) return cityCoordCache[key];
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'HoneymoonApp/1.0 rob@robresnick.com' } });
    const data = await resp.json();
    if (data && data[0]) {
      const coords = { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) };
      cityCoordCache[key] = coords;
      return coords;
    }
  } catch (e) { console.error('City geocode error:', e); }
  return null;
}

// Geocode using Nominatim — precise place-level lookup with city fallback
async function geocode(name, address, city, country = '') {
  try {
    const query = [name, address, city, country].filter(Boolean).join(', ');
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'HoneymoonApp/1.0 rob@robresnick.com' } });
    const data = await resp.json();
    if (data && data[0]) {
      return { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) };
    }
    // Fallback: city-level (cached)
    const city_coords = await geocodeCity(city);
    if (city_coords) return city_coords;
  } catch (e) {
    console.error('Geocode error:', e);
  }
  return { latitude: null, longitude: null };
}

// Recommendations CRUD
app.get('/api/recommendations', requireAuth, async (req, res) => {
  const { city, type, recommended_by, search } = req.query;
  // All authenticated users share the same recommendations (family app)
  let query = 'SELECT r.*, u.name as creator_name FROM recommendations r LEFT JOIN users u ON r.user_id = u.id WHERE 1=1';
  const params = [];
  let i = 1;
  if (city) { query += ` AND LOWER(r.city) = LOWER($${i++})`; params.push(city); }
  if (type) { query += ` AND r.type = $${i++}`; params.push(type); }
  if (recommended_by) { query += ` AND LOWER(r.recommended_by) = LOWER($${i++})`; params.push(recommended_by); }
  if (search) {
    query += ` AND (LOWER(r.name) LIKE LOWER($${i}) OR LOWER(r.notes) LIKE LOWER($${i}) OR LOWER(r.city) LIKE LOWER($${i}))`;
    params.push(`%${search}%`); i++;
  }
  query += ' ORDER BY r.created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/recommendations', requireAuth, async (req, res) => {
  const recs = Array.isArray(req.body) ? req.body : [req.body];
  const saved = [];

  // Pre-fetch city coords for all unique cities in one pass (cached, fast)
  const uniqueCities = [...new Set(recs.map(r => r.city).filter(Boolean))];
  await Promise.all(uniqueCities.map(c => geocodeCity(c)));

  for (const rec of recs) {
    const { name, type, city, neighborhood, address, recommended_by, notes, source_url, raw_input, latitude, longitude, phone } = rec;

    // Check for existing recommendation with same name + city
    const existing = await pool.query(
      `SELECT * FROM recommendations WHERE user_id=$1 AND LOWER(name)=LOWER($2) AND LOWER(COALESCE(city,''))=LOWER(COALESCE($3,''))`,
      [req.userId, name, city || '']
    );

    if (existing.rows[0] && recommended_by) {
      const current = existing.rows[0].recommended_by || '';
      const names = current.split(',').map(n => n.trim().toLowerCase());
      if (!names.includes(recommended_by.trim().toLowerCase())) {
        const merged = current ? `${current}, ${recommended_by.trim()}` : recommended_by.trim();
        const updated = await pool.query(
          `UPDATE recommendations SET recommended_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
          [merged, existing.rows[0].id]
        );
        saved.push(updated.rows[0]);
      } else {
        saved.push(existing.rows[0]);
      }
      continue;
    }

    // Use provided coords, or fall back to cached city-level coords
    let lat = latitude || null, lon = longitude || null;
    if (!lat || !lon) {
      const cityCoords = cityCoordCache[city?.toLowerCase().trim()];
      if (cityCoords) { lat = cityCoords.latitude; lon = cityCoords.longitude; }
    }

    const result = await pool.query(
      `INSERT INTO recommendations (user_id, name, type, city, neighborhood, address, recommended_by, notes, source_url, raw_input, latitude, longitude, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.userId, name, type, city, neighborhood, address, recommended_by, notes, source_url, raw_input, lat, lon, phone || null]
    );
    saved.push(result.rows[0]);
  }

  res.json(saved);
  // Precise place-level geocoding happens via /api/geocode-missing called by the client
});

// Return city-level coordinates for every distinct city in the DB.
// geocodeCity is cached in memory, so parallel calls are safe after warmup.
app.get('/api/city-coords', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT city FROM recommendations WHERE city IS NOT NULL AND city != ''`
  );
  const cities = rows.map(r => r.city);
  // Geocode all cities in parallel (city-level only, no rate-limit delay needed for ~15 cities)
  await Promise.all(cities.map(c => geocodeCity(c)));
  const result = {};
  for (const city of cities) {
    const key = city.toLowerCase().trim();
    if (cityCoordCache[key]) result[city.toLowerCase()] = cityCoordCache[key];
  }
  res.json(result);
});

app.put('/api/recommendations/:id', requireAuth, async (req, res) => {
  const { name, type, city, neighborhood, address, recommended_by, notes, source_url, phone } = req.body;

  let { latitude, longitude } = req.body;
  if (!latitude || !longitude) {
    const coords = await geocode(name, address, city);
    latitude = coords.latitude;
    longitude = coords.longitude;
  }

  const result = await pool.query(
    `UPDATE recommendations SET name=$1, type=$2, city=$3, neighborhood=$4, address=$5, recommended_by=$6, notes=$7, source_url=$8, latitude=$9, longitude=$10, phone=$11, updated_at=NOW()
     WHERE id=$12 AND user_id=$13 RETURNING *`,
    [name, type, city, neighborhood, address, recommended_by, notes, source_url, latitude, longitude, phone || null, req.params.id, req.userId]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
});

app.delete('/api/recommendations/:id', requireAuth, async (req, res) => {
  // Log before deleting
  const rec = await pool.query('SELECT * FROM recommendations WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  if (rec.rows[0]) {
    const r = rec.rows[0];
    await pool.query(
      `INSERT INTO deleted_recommendations (id,user_id,name,type,city,neighborhood,address,country,latitude,longitude,recommended_by,notes,source_url,raw_input,phone,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [r.id,r.user_id,r.name,r.type,r.city,r.neighborhood,r.address,r.country,r.latitude,r.longitude,r.recommended_by,r.notes,r.source_url,r.raw_input,r.phone,r.created_at]
    );
  }
  await pool.query('DELETE FROM recommendations WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// Canonical people list (recommended_by "users")
app.get('/api/people', requireAuth, async (req, res) => {
  // Get stored list
  const stored = await pool.query("SELECT value FROM app_config WHERE key='people_list'");
  let people = stored.rows[0] ? JSON.parse(stored.rows[0].value) : [];
  // Merge any names from recommendations not yet in the list
  const fromRecs = await pool.query('SELECT DISTINCT recommended_by FROM recommendations WHERE recommended_by IS NOT NULL');
  const recPeople = fromRecs.rows.flatMap(r => r.recommended_by.split(',').map(p => p.trim()).filter(Boolean));
  const merged = [...new Set([...people, ...recPeople])].sort((a, b) => a.localeCompare(b));
  if (merged.length !== people.length) {
    await pool.query("INSERT INTO app_config(key,value) VALUES('people_list',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify(merged)]);
  }
  res.json(merged);
});

app.post('/api/people', requireAuth, async (req, res) => {
  const { people } = req.body;
  if (!Array.isArray(people)) return res.status(400).json({ error: 'people must be an array' });
  const sorted = [...new Set(people.map(p => p.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  await pool.query("INSERT INTO app_config(key,value) VALUES('people_list',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify(sorted)]);
  res.json({ ok: true, people: sorted });
});

// Distinct filter values
app.get('/api/filters', requireAuth, async (req, res) => {
  const [cities, types, people] = await Promise.all([
    pool.query('SELECT DISTINCT city FROM recommendations WHERE city IS NOT NULL ORDER BY city'),
    pool.query('SELECT DISTINCT type FROM recommendations WHERE type IS NOT NULL ORDER BY type'),
    pool.query('SELECT DISTINCT recommended_by FROM recommendations WHERE recommended_by IS NOT NULL ORDER BY recommended_by'),
  ]);
  res.json({
    cities: cities.rows.map(r => r.city),
    types: types.rows.map(r => r.type),
    people: people.rows.map(r => r.recommended_by),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Honeymoon app running on http://localhost:${PORT}`));
});
