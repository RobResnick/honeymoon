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
app.post('/api/parse', requireAuth, async (req, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: 'Input required' });

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
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `You are helping parse travel recommendations. Extract all recommendations from the following input and return them as a JSON array. Each recommendation should have these fields:
- name: the place name (required)
- type: one of "restaurant", "bar", "cafe", "museum", "attraction", "hotel", "shop", "market", "beach", "church", "neighborhood", "other"
- city: the city (e.g. Rome, Florence, Venice, Paris, etc.)
- neighborhood: neighborhood or area within the city (if mentioned)
- address: street address if mentioned
- recommended_by: who recommended it (if mentioned in the text)
- notes: any additional details, descriptions, or context about the place
- source_url: any URL associated with this place (if present)
- phone: the phone number of the place if you have reliable knowledge of it (e.g. for famous/well-known restaurants you may know it), otherwise empty string

Return ONLY a valid JSON array, no other text. If the input has multiple places, return multiple objects. If something is unclear, make your best guess. Example:
[{"name":"Trattoria da Mario","type":"restaurant","city":"Florence","neighborhood":"Santa Croce","address":"","recommended_by":"John","notes":"Amazing pasta, cash only","source_url":"","phone":""}]

Input to parse:
${input}`
        }]
      })
    });
    const aiData = await aiRes.json();
    const text = aiData.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse input' });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ recommendations: parsed });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse input' });
  }
});

// Geocode using Nominatim
async function geocode(name, address, city, country = '') {
  try {
    const query = [name, address, city, country].filter(Boolean).join(', ');
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'HoneymoonApp/1.0 rob@robresnick.com' } });
    const data = await resp.json();
    if (data && data[0]) {
      return { latitude: parseFloat(data[0].lat), longitude: parseFloat(data[0].lon) };
    }
    // Fallback: search just city
    if (city) {
      const cityUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
      const cityResp = await fetch(cityUrl, { headers: { 'User-Agent': 'HoneymoonApp/1.0 rob@robresnick.com' } });
      const cityData = await cityResp.json();
      if (cityData && cityData[0]) {
        return { latitude: parseFloat(cityData[0].lat), longitude: parseFloat(cityData[0].lon) };
      }
    }
  } catch (e) {
    console.error('Geocode error:', e);
  }
  return { latitude: null, longitude: null };
}

// Recommendations CRUD
app.get('/api/recommendations', requireAuth, async (req, res) => {
  const { city, type, recommended_by, search } = req.query;
  let query = 'SELECT * FROM recommendations WHERE user_id = $1';
  const params = [req.userId];
  let i = 2;
  if (city) { query += ` AND LOWER(city) = LOWER($${i++})`; params.push(city); }
  if (type) { query += ` AND type = $${i++}`; params.push(type); }
  if (recommended_by) { query += ` AND LOWER(recommended_by) = LOWER($${i++})`; params.push(recommended_by); }
  if (search) {
    query += ` AND (LOWER(name) LIKE LOWER($${i}) OR LOWER(notes) LIKE LOWER($${i}) OR LOWER(city) LIKE LOWER($${i}))`;
    params.push(`%${search}%`); i++;
  }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/recommendations', requireAuth, async (req, res) => {
  const recs = Array.isArray(req.body) ? req.body : [req.body];
  const saved = [];

  for (const rec of recs) {
    const { name, type, city, neighborhood, address, recommended_by, notes, source_url, raw_input, latitude, longitude, phone } = rec;

    // Check for existing recommendation with same name + city
    const existing = await pool.query(
      `SELECT * FROM recommendations WHERE user_id=$1 AND LOWER(name)=LOWER($2) AND LOWER(COALESCE(city,''))=LOWER(COALESCE($3,''))`,
      [req.userId, name, city || '']
    );

    if (existing.rows[0] && recommended_by) {
      // Merge: append new recommender if not already listed
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

    let lat = latitude, lon = longitude;
    if (!lat || !lon) {
      const coords = await geocode(name, address, city);
      lat = coords.latitude;
      lon = coords.longitude;
      await new Promise(r => setTimeout(r, 1100)); // Nominatim rate limit: 1 req/sec
    }

    const result = await pool.query(
      `INSERT INTO recommendations (user_id, name, type, city, neighborhood, address, recommended_by, notes, source_url, raw_input, latitude, longitude, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.userId, name, type, city, neighborhood, address, recommended_by, notes, source_url, raw_input, lat, lon, phone || null]
    );
    saved.push(result.rows[0]);
  }

  res.json(saved);
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

// Distinct filter values
app.get('/api/filters', requireAuth, async (req, res) => {
  const [cities, types, people] = await Promise.all([
    pool.query('SELECT DISTINCT city FROM recommendations WHERE user_id=$1 AND city IS NOT NULL ORDER BY city', [req.userId]),
    pool.query('SELECT DISTINCT type FROM recommendations WHERE user_id=$1 AND type IS NOT NULL ORDER BY type', [req.userId]),
    pool.query('SELECT DISTINCT recommended_by FROM recommendations WHERE user_id=$1 AND recommended_by IS NOT NULL ORDER BY recommended_by', [req.userId]),
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
