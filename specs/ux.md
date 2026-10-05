# UX Spec

> **Status:** Implemented — reflects built state as of 2026-10-05  
> **Last updated:** 2026-10-05  
> **Role:** UX

---

## Design Principles

- **Data-first** — real numbers prominently; don't hide data behind interactions
- **Scannable at a glance** — a manager with 50 facilities needs to spot problems in seconds
- **Progressive detail** — portfolio → facility summary → punch-out for deep detail
- **Consistent with Tandem** — dark theme, Tandem blue accent, SVG icons (no emoji)

---

## Navigation

Top tab bar, always visible. Account selector in the top bar.

```
┌───────────────────────────────────────────────────────────────────┐
│  [Tandem Logo]  Tandem Portfolio    Account: [▼]      [Sign Out]  │
├─────────┬───────┬────────┬─────────┬──────────┬────────────────── │
│Portfolio│  Map  │ Access │ Compare │ Activity │ Accounts          │
└─────────┴───────┴────────┴─────────┴──────────┴───────────────────┘
```

---

## Portfolio Tab (default)

### Account metrics banner
Shown below the filter bar, above the facility grid. Loads asynchronously on account switch.
```
Account totals:  • Facilities 4  • Models 38  • Streams 2,343  • Assets 1,465
                 • Connections 9,675  • Elements 201,068  • Storage 752.2 MB
                                                               as of Oct 5, 2026
```
- Color-coded dots per metric
- "as of [date]" from `metrics.updatedOn` — explains why totals may lag real-time counts
- 403-forbidden accounts show amber warning instead of zeros

### Grid view (default)
50 cards per page, "Load more" button at bottom. Each card:
```
┌──────────────────────────────┐
│  [thumbnail or placeholder]  │
│──────────────────────────────│
│  Facility Name               │
│  Region                      │
│  ∿ 24 streams   ▣ 142 assets │
│──────────────────────────────│
│  Open in Stats ↗  Open in Tandem ↗ │
└──────────────────────────────┘
```
- Skeleton cards shown while data loads
- Stats (streams, assets) load asynchronously and fill in

### Leaderboard view (toggle)
Grid/leaderboard toggle buttons in the filter bar (right side).

**Sort by: Streams | Tagged Assets | Template**

- **Streams / Assets sort**: rows ranked descending; both Streams bar and Assets bar shown per row; active sort metric highlighted
- **Template sort**: facilities grouped under blue section headers by template name; no numeric bars; "No template applied" group last

### Filter bar
- Text search (facility name)
- Tags filter (region, etc.)
- Grid/leaderboard toggle

---

## Map Tab

Leaflet map with facility pins.

- **Blue pin**: facility has a saved location
- **Gray**: facility not yet located
- Click pin → popup with facility name, region, stream/asset counts, "Open in Stats" link

### Unlocated panel (below map)
Collapsible list of facilities without coordinates:
```
▼ Unlocated facilities (3)
  Boston Tech Center    [Set location]
  SF Gallery            [Set location]
```

### Location form (inline)
Clicking "Set location" inserts a form **directly below that facility's row** (not at page bottom):
- Address field pre-populated from Tandem metadata if available
- "Geocode" button uses Nominatim (OpenStreetMap — no API key)
- OR click on the map to drop a pin
- Cancel re-renders the unlocated panel (does not leave a dead form)
- Form scrolls into view automatically

---

## Access Tab

D3 force-directed bipartite graph: users/apps on one side, facilities on the other.
- Click a node to inspect its connections
- Lazy-loads on first tab visit

---

## Compare Tab

### Facility selector
Pill-based multi-select (up to 6 facilities). Searchable dropdown for adding.
Each pill colored distinctly; click ✕ to remove. Default: first 4 facilities pre-selected.

### Side-by-side table
Columns = selected facilities. Rows:
| Metric | Notes |
|--------|-------|
| Models | From facility info cache |
| Streams | Loading spinner until stats arrive |
| Tagged Assets | Loading spinner until stats arrive |
| Template | From template cache |
| Region | From region map |

Outlier cells highlighted:
- 🔴 **▲** red — significantly above account average (≥1.5σ)
- 🟡 **▼** amber — significantly below account average (≥1.5σ)

### Portfolio outlier panel (below table)
Scans ALL facilities in the account (not just selected). Shows alert cards for any facility
≥1.5σ from the mean on Streams, Tagged Assets, or Models. Updates progressively as stats load.
Requires at least 3 loaded facilities for meaningful statistics.

---

## Activity Tab

Cross-facility recent-activity feed. Lazy-loads on first tab visit.

- One row per facility, sorted by most-recently-active
- Each row: status dot (🟢 <7d, 🟡 7–30d, ⚫ >30d) + last-activity timestamp + stream health chip
- Stream health chip uses waveform SVG icon (not emoji)
- Click a row → drill-down panel with twin history + model history + stream health detail
- Filters out `metrics_update` system events (not user-triggered)

---

## Accounts Tab

Cross-account leaderboard. Lazy-loads on first tab visit.

- Fetches `GET /groups/{urn}/metrics` for all accounts (concurrency-5 pool)
- Sort by: **Facilities · Models · Streams · Assets · Connections · Elements · Storage**
- Each row: rank, account name, all 7 metric values as columns, bar for active sort metric
- 403-forbidden accounts: dimmed, "No access" warning, sorted to bottom, rank shown as "—"
- Skips "Shared Directly" pseudo-account (no real group URN)

---

## Icon System

SVG icons throughout — no emoji.

| Concept | Icon |
|---------|------|
| Models | Wireframe 3D box (cube with hidden lines) |
| Streams | Waveform / signal line |
| Assets | Document with lines (tagged list) |
| Template | Document with star |
| Facilities | House/building outline |
| Elements | Horizontal lines |
| Connections | Node graph |
| Storage | Cylinder (database) |

---

## Interaction Patterns

| Situation | Behavior |
|-----------|----------|
| Auth not complete | Login screen with "Sign In with Autodesk" button |
| Loading facility list | Skeleton cards with animated pulse |
| Loading individual card | Spinner inside card until ready |
| Facility API error | Card shows error message (not full-page error) |
| Switching accounts | Clear all cached data; reload for new account; abort in-flight requests |
| Tab switch (lazy tab) | Show skeleton/loading state on first visit; cached on subsequent visits |

---

## Responsive / Accessibility

- Desktop-first (primary users are on desktop)
- Card grid adapts: 3 columns → 2 → 1 as viewport narrows
- Color is never the only indicator (outlier arrows have directional text, status dots have labels)
- Dark mode only (matches reference apps)
