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

Accounts range from a handful of facilities to ~1000 (e.g. a retail chain). Loading must scale.

1. **Paginate the facility list** — load 50 at a time; show a "Load more" button or trigger on scroll
2. **Lazy load per card** — after the facility list arrives, each card fetches its own summary independently
3. **In-memory cache** — `facilityCache.js` holds loaded summaries for the session; scrolling back doesn't re-fetch
4. **Priority loading** — cards visible in the viewport load first
5. **No pre-fetching streams** — stream data is expensive; only load when a facility is selected for comparison
6. **Thumbnail lazy load** — fetch thumbnails only for cards in or near the viewport; use `getFacilityThumbnail(urn, region)` from `api.js`; call `cleanupThumbnailURLs()` on account switch

### What counts as a "facility summary"
- Facility name, URN, model count
- Thumbnail (via `GET /twins/{urn}/thumbnail` → blob URL)
- Stream count
- Asset count
- Hot spot badge data (reserved slot — thresholds TBD)

### Stream matching for comparison (cross-facility)

Facilities may have streams with similar but not identical names (e.g. "Temperature", "Temp (°F)", "Air Temp").

**Strategy — two-phase matching:**
1. **Semantic grouping**: Normalize stream names (lowercase, strip units, common aliases) and group streams across facilities that likely measure the same thing. Confidence score determines auto-match vs. prompt-for-disambiguation.
2. **User disambiguation**: When confidence is below threshold, show a grouping UI: "We think these measure the same thing — confirm or reassign." User choices are saved to localStorage per facility pair.

**Normalization rules (initial set — expand as needed):**
- Strip units in parentheses: `"Temp (°F)"` → `"temp"`
- Common aliases: temperature/temp, humidity/rh/relative humidity, co2/carbon dioxide, energy/kwh/power
- Case-insensitive, punctuation-stripped comparison

Implementation lives in `utils/streamMatcher.js`.

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

- [ ] **Stream aggregation** — for the portfolio summary card, do we show stream count only, or also an aggregate value (e.g. average temp across all temp streams in that facility)?
- [ ] **Hot spot thresholds** — badge is reserved (see UX spec); exact threshold logic TBD once we see real data
- [ ] **Comparison metrics** — user-selectable from available stream types; auto-matched via `streamMatcher.js` with user disambiguation available
