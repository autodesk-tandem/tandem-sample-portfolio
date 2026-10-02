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
│  🏢 [Facility Name]          [●]   │  ← status dot (green/yellow/red)
│  ─────────────────────────────     │
│  Models:   3      Streams:  24     │
│  Assets:   142    Alerts:   2  ⚠  │
│                                    │
│  Last activity: 2 hours ago        │
│                         [Open ↗]   │
└────────────────────────────────────┘
```

- **Status dot**: green = all streams nominal, yellow = some out of range, red = critical alerts
- **Open ↗**: Punch-out link to Tandem UI for that facility (opens new tab)
- Cards are sorted: red → yellow → green, then alphabetically within each group

### Loading states
- Skeleton cards shown while facility list loads
- Each card loads its own data independently (lazy); shows spinner inside card until ready
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
Dropdown of available stream types found across the selected facilities.
Example metrics: Temperature, Humidity, Energy Usage, CO₂ Level

### Step 3: Results
- **Bar chart**: One bar per facility showing the current / last-seen value for the chosen metric
- **Table below chart**: Facility name | Current value | Min | Max | Avg | Status
- Hot spots highlighted in red/yellow in the table rows

### Hot spot logic
- **Red**: Value is > 2 standard deviations from the portfolio mean
- **Yellow**: Value is > 1 standard deviation from the portfolio mean
- **Green**: Within normal range

*Note: thresholds are relative (statistical) for the prototype. Absolute thresholds can be added later.*

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

- [ ] **Facility card thumbnail** — do facilities have thumbnail images accessible via the API? If yes, show them; if not, use a generic building icon.
- [ ] **Max facilities per account** — if a user has 500 facilities, do we paginate or infinite-scroll the card grid?
- [ ] **Comparison: absolute vs. relative thresholds** — should users be able to configure thresholds per metric, or is the statistical approach (std dev) sufficient for the prototype?
- [ ] **Map provider** — Leaflet with OpenStreetMap tiles is the default proposal. Any objection to OpenStreetMap attribution?
- [ ] **"Set location" UX** — should setting a facility location require clicking on the map, or typing coordinates, or both?
- [ ] **Compare: stream type selection** — if Facility A has "Temperature" and Facility B calls it "Temp (°F)", how do we match them? By stream name string match, or should the user manually align them?
