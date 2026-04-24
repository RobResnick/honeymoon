# Honeymoon App — Project Memory

## What this is
Rob's Italy honeymoon trip recommendations app. Live at **honeymoon.robresnick.com** (Vercel).

## Stack
- **Frontend:** Single `index.html` — vanilla JS, Leaflet maps, no framework
- **Backend:** `server.js` — Node.js + Express + pg (Neon Postgres via DATABASE_URL in `.env`)
- **Deployed:** Vercel (GitHub repo: RobResnick/honeymoon, **branch: master** — NOT main)
- **Push:** `git push origin master` (Vercel auto-deploys)
- **Run locally:** `node server.js` → http://localhost:3001

## Database (loaded from honeymoon app's own .env)
- `recommendations` table: id, user_id, name, type, city, neighborhood, address, country, latitude, longitude, recommended_by, notes, source_url, raw_input, phone, created_at, updated_at
- `users` table: id, email, password_hash, name, created_at
- `deleted_recommendations` table: same fields + deleted_at (soft-delete log)

### Place types
restaurant, bar, cafe, museum, attraction, hotel, shop, market, beach, church, neighborhood, other

## Key files
- `index.html` — entire frontend + mobile PWA (Leaflet map, Google Maps-style mobile nav)
- `server.js` — Express API: auth, AI parse via Claude API, recommendations CRUD, geocoding
- `manifest.json` — PWA manifest
- `icon.svg` — custom app icon
- `.env` — DATABASE_URL, SESSION_SECRET, ANTHROPIC_API_KEY (not committed)

## Architecture highlights
- Mobile: Google Maps-style layout — floating search bar, bottom sheet list, bottom nav (Map/List/Add)
- Desktop: left panel with search/filter + map
- Map: Leaflet + CartoDB Voyager tiles
- Auth: JWT tokens via `x-session-token` header
- AI parse: calls Anthropic API (claude-haiku) to extract places from freeform text
- Geocoding: Nominatim (OpenStreetMap), 1 req/sec rate limit

## Deployment
Branch: **master** (not main)
Push: `git push origin master`
After edits: `git add index.html server.js && git commit -m "..." && git push origin master`

## Rob's preferences
- Plain, clean UI — Google/Apple aesthetic
- Mobile-first (Rob uses it on iPhone during the trip)
- Keep changes minimal and consistent with existing style
