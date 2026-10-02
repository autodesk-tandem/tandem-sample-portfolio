# UX Spec

> **Status:** Proposed — awaiting review  
> **Last updated:** 2026-10-02  
> **Role:** UX

---

## Design Principles

- **Data-first, not decorator-first** — show real numbers prominently; don't hide data behind interactions
- **Scannable at a glance** — a user managing 50 facilities needs to spot problems in seconds
- **Progressive detail** — portfolio → facility summary → punch-out to Tandem for deep detail
- **Consistent with Tandem** — dark theme, Tandem blue accent, same visual language as `tandem-sample-stats`

---

## Navigation Structure

Top tab bar with three primary views. No sidebar (keeps it simple for a prototype).

```
┌──────────────────────────────────────────────────────────────┐
│  [Tandem Logo]  tandem-sample-portfolio         [User] [Logout]│
├──────────────────────────────────────────────────────────────┤
│  Account: [dropdown]   Facility filter: [search box]          │
├────────────────┬──────────────┬──────────────────────────────┤
│  Portfolio     │  Map         │  Compare                      │
│  (list/cards)  │  (geo view)  │  (metrics across facilities)  │
└────────────────┴──────────────┴──────────────────────────────┘
```

**Header always visible** with:
- Account selector (same pattern as `tandem-sample-stats`)
- Facility text filter (filters what's shown in the active view)

---

## View 1: Portfolio (default view)

A card grid of all facilities in the selected account.

### Facility Card
Each card shows:
```
┌────────────────────────────────────┐
│ [thumbnail image or placeholder]   │
│────────────────────────────────────│
│  [Facility Name]         [badge?]  │  ← badge slot reserved for hot spots
│  ─────────────────────────────     │
│  Models:   3      Streams:  24     │
│  Assets:   142                     │
│                                    │
│                         [Open ↗]   │
└────────────────────────────────────┘
```

- **Thumbnail**: fetched from `GET /twins/{urn}/thumbnail`; falls back to a generic building placeholder if not available
- **Badge slot**: reserved for future hot spot indicators — exact design TBD as we see real data. Could be a colored dot, a count badge, an icon, or a highlighted border. The slot is always present in the layout; it starts empty.
- **Open ↗**: Punch-out link to Tandem UI (opens new tab)
- Cards are sorted alphabetically by default; sort order may evolve once hot spot logic is defined

### Pagination
- Show 50 cards at a time with a "Load more" button at the bottom
- Cards load their own summary data lazily after appearing

### Loading states
- Skeleton cards shown while facility list loads
- Each card loads its own data independently (lazy); shows spinner inside card until ready
- Thumbnail loads independently — show placeholder until it arrives, then swap in
- Error state per card (not a full-page error) if a facility fails to load

### Empty state
If the account has no facilities:
> "No facilities found in this account. Create facilities in Tandem to get started."

---

## View 2: Map

Interactive map showing all facilities as pins.

### Map behavior
- Pins are color-coded: green / yellow / red (same scheme as portfolio cards)
- Clicking a pin opens a popup with the facility card summary + "Open in Tandem" link
- Facilities without a location show in a "Unlocated" list below the map
- User can click "Set location" on any facility to drop a pin manually (saved to localStorage)

### Map controls
- Zoom to fit all located facilities on load
- Standard zoom/pan
- "Locate all" button resets to fit-all view

### Unlocated panel
Below the map, a collapsible panel:
```
▼ Unlocated facilities (3)
  [Facility A]  [Set location]
  [Facility B]  [Set location]
  [Facility C]  [Set location]
```

---

## View 3: Compare

Side-by-side metric comparison across selected facilities.

### Step 1: Select facilities
Checkbox list of all facilities (max 10 for prototype).

### Step 2: Select metric
Dropdown of **semantically matched** stream types found across the selected facilities (auto-grouped by `streamMatcher.js`). Example groups: Temperature, Humidity, Energy Usage, CO₂.

If the app is uncertain whether two stream names refer to the same thing, it shows a disambiguation prompt:
```
┌─────────────────────────────────────────────────────────┐
│  We think these streams measure the same thing:         │
│    • "Temp (°F)"  in  [Building A]                      │
│    • "Air Temperature"  in  [Building B]                │
│  [✓ Yes, group them]   [✗ Keep separate]                │
└─────────────────────────────────────────────────────────┘
```
User choices are remembered (localStorage) so the prompt doesn't repeat.

### Step 3: Results
- **Bar chart**: One bar per facility showing the current / last-seen value for the chosen metric
- **Table below chart**: Facility name | Current value | Min | Max | Avg | Status
- Hot spots highlighted in red/yellow in the table rows

### Hot spot logic
Hot spot thresholds are **TBD** — we will define them once we see real data. The UX reserves a visual slot (badge, color, or border highlight) on each row. Statistical defaults (std dev from portfolio mean) are the likely starting point but are not locked in yet.

---

## Interaction Patterns

| Situation | Behavior |
|-----------|----------|
| Auth not complete | Show login screen (same as reference apps) |
| Loading facility list | Skeleton cards in Portfolio view |
| Loading individual facility data | Spinner inside that facility's card |
| Facility API error | Card shows error message, retry button |
| No streams for a facility | Card shows "No stream data" badge |
| No facilities in account | Empty state message (see above) |
| Switching accounts | Clear all loaded data, reload for new account |

---

## Responsive / Accessibility

- **Desktop-first** for prototype (primary users are on desktop)
- Grid adapts: 3 columns → 2 → 1 as viewport narrows
- Keyboard navigation for dropdowns and facility selection
- Color is never the only indicator (status dots also have text/icons)
- Dark mode only for prototype (matches reference apps)

---

## Open Questions

- [x] **"Set location" UX** — three options: (1) click on the map to drop a pin, (2) type lat/lng coordinates manually, (3) geocode by address. The facility's address (from `Identity Data.Address` in Tandem metadata) is pre-populated in the address field automatically. Geocoding uses Nominatim (OpenStreetMap, free, no API key).
- [ ] **Compare: max facilities** — capped at 10 for prototype. Is that enough for a meaningful comparison, or should it be higher?
- [ ] **Hot spot badge design** — to be decided once we have real data to look at. Placeholder slot is in the layout.
