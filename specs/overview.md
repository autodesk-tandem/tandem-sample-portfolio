# Project Overview

> **Status:** Active prototype — iteratively developed with AI assistance  
> **Last updated:** 2026-10-05

## Purpose

Autodesk Tandem allows users to work with individual facilities (buildings, campuses, etc.), but
provides no built-in "portfolio" view across all facilities in an account. This app fills that gap.

A typical use case is a university campus manager, airport operator, or retail chain (think Walmart
or Starbucks) that manages dozens or hundreds of buildings in Tandem and needs a single dashboard to:

- See all their facilities at once
- Locate them on a map
- Compare usage, cost drivers, and data health across facilities
- Spot outliers and "hot spots" that warrant a closer look
- Understand who has access to what, and what changed recently

## Target Audience

Facility Managers and Property Managers who handle a company's portfolio of physical buildings.
Initially an internal Autodesk prototype; quality is held to production standards from the start.

## Tabs (implemented)

| Tab | Status | Description |
|-----|--------|-------------|
| Portfolio | ✅ Live | Card grid + leaderboard view; streams, tagged assets, template grouping; account metrics banner; "Open in Stats" punch-out |
| Map | ✅ Live | Leaflet map with facility pins; inline location form; unlocated panel |
| Access | ✅ Live | D3 force-directed bipartite graph — users/apps ↔ facilities |
| Compare | ✅ Live | Side-by-side facility comparison table (up to 6); portfolio-wide outlier detection (±1.5σ) |
| Activity | ✅ Live | Cross-facility recent-activity feed; twin + model history; stream health status |
| Accounts | ✅ Live | Cross-account leaderboard ranked by 7 metrics; 403-forbidden accounts handled gracefully |

## Key Features

### Portfolio tab
- **Card grid**: facility thumbnail, model count, stream count, tagged asset count
- **Leaderboard view**: toggle between grid and ranked list; sort by Streams, Tagged Assets, or Template
- **Template clustering**: template sort groups facilities under section headers with no numeric bars
- **Account metrics banner**: Facilities · Models · Streams · Assets · Connections · Elements · Storage; "as of [date]" from API
- **"Open in Stats" punch-out**: opens `tandem-sample-stats` pre-selected to the right account and facility

### Map tab
- Facilities plotted as colored pins (blue = located, gray = not yet placed)
- Click a pin → popup with facility summary
- Click "Set location" on unlocated facility → inline location form appears directly below that row
- Geocode by address (Nominatim/OpenStreetMap, no API key required) or click map to drop pin

### Compare tab
- Searchable pill selector — add up to 6 facilities
- Side-by-side table: Models, Streams, Tagged Assets (with loading spinners), Template, Region
- Outlier cells highlighted: 🔴▲ above average, 🟡▼ below average (±1.5σ threshold)
- Portfolio outlier panel: scans ALL account facilities and surfaces statistical anomalies as alert cards

### Activity tab
- Loads last 30 days of twin history + stream health per facility
- Filters out system-generated `metrics_update` events
- Stream health chips use SVG waveform icon (no emoji)

### Accounts tab
- Fetches `GET /groups/{urn}/metrics` for all accounts in parallel (concurrency-5 pool)
- 7 sort metrics: Facilities, Models, Streams, Assets, Connections, Elements, Storage
- Bars scale to account-wide max per metric
- 403-forbidden accounts shown with "No access" warning, sorted to bottom, dimmed

## Punch-out to tandem-sample-stats

Portfolio can open the companion `tandem-sample-stats` app pre-selected to the clicked facility.

**Mechanism (two complementary approaches):**
1. **Hash params** (cross-origin safe): `https://…/tandem-sample-stats/#account=NAME&facility=URN`
   — Stats saves these to `sessionStorage` before OAuth redirect so they survive the auth round-trip
2. **Cookies** (localhost bonus): one-shot cookies share the session token so no re-authentication
   is required when both apps run on `localhost`

On GitHub Pages, only the hash approach is used (cookies can't cross origins). The user sees a
brief OAuth redirect on first open, then lands directly on the selected facility.

## Out of Scope

This app supplements Tandem — it does not replace it. When users need deep facility detail, they
punch out to Tandem (or to `tandem-sample-stats`) rather than duplicating that functionality here.

## Reference Codebases

1. [`tandem-sample-stats`](https://github.com/autodesk-tandem/tandem-sample-stats) — companion app; demonstrates REST API patterns
2. [`tandem-sample-emb-viewer`](https://github.com/autodesk-tandem/tandem-sample-emb-viewer) — JavaScript SDK + embedded viewer
3. `dt-server` — Tandem backend (proprietary; do not leak implementation details)
4. `dt-client` — Tandem web client (proprietary; do not leak implementation details)
5. `viewer` — Tandem JavaScript SDK (proprietary; do not leak implementation details)
