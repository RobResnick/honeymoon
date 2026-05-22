# Taste App — Project Memory

## What this is
"Taste" — your favorite people's favorite places. A recommendations app for saving and sharing places. Live at **honeymoon.robresnick.com** (Vercel, URL TBD).

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

## CSS layout — three breakpoints
All in `index.html` `<style>` block. Edit the right one:

| Target | Media query | Notes |
|---|---|---|
| **Phone** | `(hover:none) and (pointer:coarse) and (max-width:767px)` | ~line 761. Bottom nav, floating search bar, sheet |
| **iPad** | `(hover:none) and (min-width:768px)` | ~line 1354. Left panel 280px, touch targets, safe area |
| **Desktop** | `(hover:hover) and (pointer:fine), (hover:none) and (min-width:768px)` | ~line 1183. Left panel 380px, zoom controls, buddy panel |

`isDesktop()` JS function (~line 1964): returns true for mouse OR width ≥ 768px.

Key layout facts:
- Desktop/iPad left panel: `#left-panel` width 380px (desktop) / 280px (iPad override)
- Buddy panel: 240px wide (desktop), 180px (iPad override), slides from right
- Add button `.add-btn`: `position:absolute` in left panel; `body.searching` moves it over the map
- Zoom controls: `.leaflet-bottom.leaflet-right` bottom-right of map; `body.buddy-open` shifts them left

## Recurring AI task: fix "other" typed places
When new places get added with unknown type, run this to find and fix them:
```
cd /Users/rob/Claud/development/projects/honeymoon-app
node -r dotenv/config -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query(\"SELECT id,name,city,address,source_url FROM recommendations WHERE type='other' ORDER BY city,name\").then(r=>{console.log(JSON.stringify(r.rows,null,2));p.end()})" 2>/dev/null
```
Then update: `UPDATE recommendations SET type=$1 WHERE id=$2`
Valid types: restaurant, bar, cafe, museum, attraction, hotel, shop, market, beach, church, neighborhood, other

## Rob's preferences
- Plain, clean UI — Google/Apple aesthetic
- Mobile-first (Rob uses it on iPhone during the trip)
- Keep changes minimal and consistent with existing style
