# Architecture Spec

> **Status:** Implemented — reflects built state as of 2026-10-06  
> **Last updated:** 2026-10-06  
> **Role:** Architect

---

## Tech Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Runtime | Browser, vanilla JS, ES modules | No build step; consistent with reference sample apps |
| Styling | Tailwind CSS via CDN | Same dark theme as reference apps |
| Auth | OAuth 3-legged PKCE via `js/auth.js` | Inherited; proven |
| API | Tandem REST API via `js/api.js` | Inherited; proven |
| Map | Leaflet.js via CDN | Open source, no API key, well-suited for prototype |
| Charts | None (Chart.js CDN available if needed) | Compare tab uses CSS bars instead of canvas charts |
| 3D Viewer | None | Portfolio is data-centric; punch-out to Tandem for 3D |
| Bundler | None | CDN imports only |

### Color Tokens
```
tandem-blue:          #0696D7
dark-bg:              #1a1a1a
dark-card:            #2a2a2a
dark-border:          #404040
dark-text:            #e0e0e0
dark-text-secondary:  #a0a0a0
```

---

## File Structure (actual)

```
tandem-sample-portfolio/
├── index.html
├── js/
│   ├── app.js              # Bootstrap, auth, account/facility loading, tab switching
│   ├── config.js           # APS client ID, environment URLs, statsAppURL
│   ├── auth.js             # OAuth PKCE (inherited + hash deeplink support)
│   ├── api.js              # Tandem REST wrappers
│   ├── state/
│   │   ├── facilityCache.js   # In-memory facility summary cache (session-scoped)
│   │   └── locationStore.js   # Facility lat/lng — persisted in localStorage
│   └── views/
│       ├── portfolioView.js   # Card grid + leaderboard; account metrics banner
│       ├── mapView.js         # Leaflet map; inline location form
│       ├── accessView.js      # D3 force-directed bipartite graph
│       ├── compareView.js     # Side-by-side table + outlier detection
│       ├── activityView.js    # Cross-facility activity feed + 30-day summary drill-down
│       ├── ticketsView.js     # Portfolio-wide work order / ticket summary
│       └── accountsView.js    # Cross-account leaderboard
├── tandem/
│   ├── constants.js        # Column families, names, element flags, QC (inherited)
│   └── keys.js             # Key/xref conversion utilities (inherited)
└── specs/                  # Living specification documents
```

---

## Auth & Account/Facility Loading

### Login
`js/auth.js` handles full OAuth 3-legged PKCE. `checkLogin()` on page load; `login()` to initiate.

Hash-based deeplink params (`#account=...&facility=...`) are saved to `sessionStorage` at the
top of `checkLogin()` — before any OAuth redirect fires — so they survive the auth round-trip.

### Loading all facilities (efficient pattern)
One `getUserResources('@me')` call returns all facilities and groups across all regions.

```javascript
userResourcesCache = await getUserResources('@me');
userResourcesCache.twins.forEach(twin => facilityRegionMap.set(twin.id, twin.region));
```

This scales to large portfolios (1000+ facilities) without per-region round-trips.

### Account + facility dropdowns
- Alphabetical sort; "SHARED DIRECTLY" always last
- `localStorage` persists last-selected account and facility across sessions
- Schema version check (`SchemaVersion` constant) before loading facility data

---

## Data Loading Strategy

### Parallel pipelines per facility
Each facility triggers concurrent fetch pipelines in `loadAllFacilityStats()`:

```
getFacilityStats(urn)      → { streamCount, taggedAssetCount, openTicketCount, closedTicketCount }
                              (internally: getStreams + getTaggedAssetsCount + getTickets in parallel)
getInlineTemplate(urn)     → { name }   (GET /twins/{urn}/template)
```

Both are fetched together and written to `facilityCache` **before** `updateCardStats()` is called,
so the leaderboard always has template names regardless of view mode (grid vs leaderboard).

`loadFacilityData()` (card rendering) also writes to the cache. A cache-skip guard prevents
duplicate network calls when one pipeline finishes before the other.

### Concurrency
All background loading uses a 5-worker concurrency pool pattern:
```javascript
async function worker() {
    while (cursor < facilities.length) {
        await doWork(facilities[cursor++]);
    }
}
await Promise.all(Array.from({ length: 5 }, () => worker()));
```
Used in: `loadAllFacilityStats`, `accessView`, `activityView`, `accountsView`.

### Timeout protection
Each facility's stats load races against a 30-second timeout (`Promise.race`). If a hung fetch
never resolves, the worker slot is released and the card shows "Timed out" with a Retry button.

### Pagination
50 cards rendered initially; "Load more" button appends the next 50. Leaderboard renders all
filtered facilities (no pagination — rows are lighter than cards).

### Caching
- `facilityCache.js` — in-memory; cleared on account switch
- `locationStore.js` — `localStorage`; persists across sessions
- Template names, stats, and thumbnails are all cached in `facilityCache`

---

## Key API Endpoints

| Endpoint | Used for |
|----------|----------|
| `GET /users/@me/resources` | All facilities + groups in one call |
| `GET /twins/{urn}/thumbnail` | Facility card thumbnails |
| `GET /twins/{urn}` | Facility info (name, models, settings) |
| `GET /twins/{urn}/template` | Template name (lightweight) |
| `POST /modeldata/{urn}/scan` | Elements for stream/asset counts |
| `POST /twins/{urn}/history` | Recent activity (twin history) |
| `POST /modeldata/{urn}/history` | Model change history |
| `GET /groups/{urn}/metrics` | Account-level usage totals |
| `POST /timeseries/models/{urn}/streams` | Stream last-seen values (batch) |

---

## Punch-out to tandem-sample-stats

```
Portfolio (localhost:8001 or github.io)
  → openDetails(urn)
  → builds URL: statsBase + #account=NAME&facility=URN
  → window.open(statsURL, '_blank')

Stats app (localhost:8000 or github.io/tandem-sample-stats)
  → checkLogin() reads hash → saves to sessionStorage → strips hash
  → OAuth redirect (if needed)
  → app.js reads sessionStorage → selects account + facility → loadFacility()
```

Cookie-based token sharing (localhost only) is layered on top:
- Portfolio writes `tandem_shared_token` cookie (max-age=60s)
- Stats reads it in `checkLogin()` before any OAuth redirect
- No effect on cross-origin deployments

---

## Constraints (Non-negotiable)

- No hardcoded column names or magic numbers — always use `tandem/constants.js`
- No credentials or tokens in `localStorage` beyond what `auth.js` manages
- No direct imports from `dt-client`, `viewer`, or `dt-server` — proprietary
- All external API calls use HTTPS only
- Never commit or log access tokens

---

## Resolved Design Decisions

| Question | Decision |
|----------|----------|
| Stream matching for Compare | Replaced with statistical outlier detection (±1.5σ); no per-stream comparison needed for MVP |
| Hot spot badges | Implemented as outlier detection in Compare tab; card badges remain reserved |
| Template source | `GET /twins/{urn}/template` (lightweight endpoint, not the heavy `/inlinetemplate?flatten`) |
| Location storage | `localStorage` keyed by `portfolio:location:{facilityURN}` |
| Cross-origin punch-out | URL hash params + sessionStorage; cookies as localhost bonus |
