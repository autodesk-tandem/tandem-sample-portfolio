# Architecture Spec

> **Status:** Proposed — awaiting review  
> **Last updated:** 2026-10-02  
> **Role:** Architect

---

## Tech Stack

Matches the pattern established in `tandem-sample-stats` and `tandem-sample-emb-viewer`.

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Runtime | Browser, vanilla JS, ES modules | Consistent with sample apps; no build step needed |
| Styling | Tailwind CSS via CDN | Already used in both reference apps; same dark theme |
| Auth | OAuth 3-legged PKCE via `js/auth.js` | Inherited; proven |
| API | Tandem REST API via `js/api.js` | Inherited; proven |
| Map | **Leaflet.js** via CDN | Open source, no API key, widely used, good enough for prototype |
| Charts | **Chart.js** via CDN | Lightweight, CDN-available, sufficient for bar/line/radar comparisons |
| 3D Viewer | **None** | Portfolio view is data-centric; punch-out to Tandem for 3D detail |
| Bundler | None | CDN imports only; consistent with reference apps |

### Colors (from reference apps)
```
tandem-blue:   #0696D7
tandem-dark:   #0D2C54
dark-bg:       #1a1a1a
dark-card:     #2a2a2a
dark-border:   #404040
dark-text:     #e0e0e0
dark-text-secondary: #a0a0a0
```

---

## Application Structure

Single-page app with three primary views accessible via a top navigation tab bar:

```
index.html
js/
  app.js            # Bootstrap, auth, account/facility loading
  config.js         # APS client ID, environment URLs
  auth.js           # OAuth PKCE (inherited)
  api.js            # Tandem REST wrappers (inherited)
  state/
    facilityCache.js   # In-memory cache of facility summaries per session
    locationStore.js   # Facility lat/lng — persisted in localStorage
  views/
    portfolioView.js   # View 1: Facility list/cards
    mapView.js         # View 2: Interactive map
    comparisonView.js  # View 3: Cross-facility metric comparison
  utils/
    hotspot.js         # Threshold logic: green / yellow / red classification
tandem/
  constants.js      # (inherited)
  keys.js           # (inherited)
```

---

## Key Architectural Decision: Facility Location Data

**Problem:** Tandem does not natively store lat/lng coordinates for facilities.

**Decision:** Use a two-tier approach:
1. **Check facility settings** — if a facility has a `location` property in its settings object (some facilities may have this set in the Tandem UI), use it
2. **Fall back to localStorage** — allow users to pin a location per facility directly in the app. Stored as `portfolio:location:{facilityURN}` in localStorage

This means the app works immediately (just without map pins for unlocated facilities) and improves as users add locations.

**Future:** If Tandem adds a native location field, the `locationStore.js` abstraction makes it easy to switch.

---

## Data Loading Strategy

Facilities can number in the hundreds for large customers. Loading must be efficient.

1. **Lazy load per facility** — fetch list first, then load summary data per facility on demand (not all at once)
2. **In-memory cache** — `facilityCache.js` holds loaded summaries for the session; switching back to a facility doesn't re-fetch
3. **Priority loading** — load the currently visible facilities first (visible in list/map viewport)
4. **No pre-fetching streams** — stream data is expensive; only load when a facility is selected for comparison

### What counts as a "facility summary"
- Facility name, URN, model count
- Stream count and last-seen values (aggregated)
- Asset count
- Active alerts / out-of-range streams (hot spots)

---

## Tandem API Usage Patterns

- Always use constants from `tandem/constants.js` — no hardcoded column names
- Always check override columns first: `QC.OName` before `QC.Name`, etc.
- Convert long keys → short keys before querying elements (`toShortKey()`)
- Filter `/scan` responses for the version string: first element is `'v1'`

### Punch-out to Tandem
When a user clicks "Open in Tandem" for a facility:
```javascript
const tandemURL = `https://tandem.autodesk.com/pages/facilities/${encodeURIComponent(facilityURN)}`;
window.open(tandemURL, '_blank');
```

---

## Constraints (Non-negotiable)

- No hardcoded column names or magic numbers — always use `tandem/constants.js`
- No credentials or tokens in localStorage beyond what `auth.js` already manages
- No direct imports from `dt-client`, `viewer`, or `dt-server` — these are proprietary
- All external API calls use HTTPS only
- Do not load more Tandem data than necessary — this app serves potentially large portfolios

---

## Open Questions

- [ ] **Facility count scale** — what is the realistic max number of facilities a user might have? (10? 100? 1000?) This affects pagination and loading strategy.
- [ ] **Stream aggregation** — for the portfolio summary, do we show the count of active streams, the average value of a chosen stream type, or something else?
- [ ] **Hot spot thresholds** — are thresholds absolute (e.g. temperature > 80°F) or relative (top 10% outliers across the portfolio)?
- [ ] **Comparison metrics** — which stream types / properties are candidates for cross-facility comparison? Are these user-selectable or pre-defined?
