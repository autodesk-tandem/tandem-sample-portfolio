# tandem-sample-portfolio

> **⚠️ Sample / Experimental Code — Not an Official Autodesk Product**
>
> This repository is a prototype and experiment in AI-assisted development. It is provided
> **as-is, with no warranty, support, or guarantee of any kind.** It is not an official
> Autodesk product and should not be treated as one. Use at your own risk.

A browser-based portfolio dashboard for [Autodesk Tandem](https://tandem.autodesk.com) that lets
facility managers see all their buildings in one place, compare them, and spot outliers — without
having to open each facility individually in Tandem.

Built as a companion to [`tandem-sample-stats`](https://github.com/autodesk-tandem/tandem-sample-stats)
using the same Tandem REST API, OAuth PKCE pattern, and visual design language.

---

## What it does

| Tab | Description |
|-----|-------------|
| **Portfolio** | Card grid of all facilities in the selected account. Shows stream counts, tagged asset counts, and facility thumbnails. Toggle to a **leaderboard view** to rank by Streams, Tagged Assets, or Template. Account-level usage totals shown in a metrics banner. |
| **Map** | Interactive Leaflet map with facility pins. Set locations for unlocated facilities by address (geocoded via OpenStreetMap) or by clicking the map. |
| **Access** | D3 force-directed graph showing which users and applications have access to which facilities. |
| **Compare** | Select up to 6 facilities for a side-by-side metrics table. Outlier cells are automatically highlighted (±1.5σ from the account average). A portfolio-wide outlier panel surfaces any facility that stands out significantly. |
| **Activity** | Cross-facility activity feed. Each facility row shows stream health and open ticket count. Click a row for a 30-day summary (facility changes, contributors, stream health, model changes) with an "Open in Stats" punch-out. |
| **Tickets** | Portfolio-wide work order summary. Ranks facilities by open ticket count. Click to drill down into per-ticket details with priority filters and sort controls. |
| **Accounts** | Cross-account leaderboard ranked by 7 metrics: Facilities, Models, Streams, Assets, Connections, Elements, and Storage. |

**"Open in Stats" punch-out:** clicking this on any facility card opens
[`tandem-sample-stats`](https://github.com/autodesk-tandem/tandem-sample-stats) pre-selected
to that exact account and facility — works both on `localhost` and on the deployed GitHub Pages
versions.

---

## Running locally

### Prerequisites

- A Tandem account with at least one facility
- An [APS application](https://aps.autodesk.com) with a Client ID (PKCE — no secret required)
- A static HTTP server (e.g. `npx serve`, `python -m http.server`, VS Code Live Server)

### Setup

1. Clone this repository:
   ```bash
   git clone https://github.com/autodesk-tandem/tandem-sample-portfolio.git
   cd tandem-sample-portfolio
   ```

2. Open `js/config.js` and set your APS Client ID:
   ```javascript
   apsKey: "YOUR_APS_CLIENT_ID",
   ```

3. In your APS application settings, add `http://localhost:8001` as a **Callback URL**.

4. Serve the app on port 8001:
   ```bash
   npx serve -l 8001 .
   # or
   python -m http.server 8001
   ```

5. Open [http://localhost:8001](http://localhost:8001) and sign in with your Autodesk account.

> **Tip:** If you also run [`tandem-sample-stats`](https://github.com/autodesk-tandem/tandem-sample-stats)
> on `localhost:8000`, the "Open in Stats" punch-out will reuse your session automatically
> (no second login required).

---

## Project structure

```
tandem-sample-portfolio/
├── index.html              # Single-page app shell
├── js/
│   ├── app.js              # Bootstrap, auth, account/facility loading, tab switching
│   ├── config.js           # APS client ID and environment URLs
│   ├── auth.js             # OAuth 3-legged PKCE flow
│   ├── api.js              # Tandem REST API wrappers
│   ├── state/
│   │   ├── facilityCache.js   # In-memory facility summary cache
│   │   └── locationStore.js   # Facility lat/lng (localStorage)
│   └── views/
│       ├── portfolioView.js   # Card grid + leaderboard
│       ├── mapView.js         # Leaflet map + location form
│       ├── accessView.js      # D3 bipartite graph
│       ├── compareView.js     # Side-by-side comparison + outliers
│       ├── activityView.js    # Cross-facility activity feed + 30-day summary drill-down
│       ├── ticketsView.js     # Portfolio-wide work order / ticket summary
│       └── accountsView.js    # Cross-account leaderboard
├── tandem/
│   ├── constants.js        # Tandem column families, names, element flags
│   └── keys.js             # Key/xref conversion utilities
└── specs/                  # Living specification documents
```

---

## Relationship to other sample projects

This app is designed to work alongside the other Autodesk Tandem sample projects:

- **[tandem-sample-stats](https://github.com/autodesk-tandem/tandem-sample-stats)** — the primary
  companion app. Portfolio's "Open in Stats" punch-out opens Stats pre-selected to the clicked
  facility. The `tandem/` utilities and `auth.js`/`api.js` patterns are inherited from this project.

- **[tandem-sample-emb-viewer](https://github.com/autodesk-tandem/tandem-sample-emb-viewer)** —
  demonstrates the Tandem JavaScript SDK with an embedded 3D viewer. Not directly integrated, but
  useful reference for viewer-based features.

---

## AI-assisted development

This project was built as an experiment in AI-assisted ("vibe coding") development using
[Cursor](https://cursor.sh). The code was iteratively developed through natural-language
conversation with an AI coding assistant. The `specs/` directory contains the living specifications
that guided the build.

This is explicitly **not** a production-hardened application. It is a prototype intended to
demonstrate what's possible with the Tandem REST API and to explore AI-assisted development
workflows.

---

## Disclaimer

This software is provided **"as is"** without warranty of any kind, express or implied, including
but not limited to the warranties of merchantability, fitness for a particular purpose, and
non-infringement. In no event shall the authors or Autodesk be liable for any claim, damages, or
other liability arising from the use of this software.

This is **sample code only** and is **not an official Autodesk product**. It is not supported,
maintained, or endorsed by Autodesk. The Tandem REST API it calls is subject to change without
notice.

---

## License

[MIT](LICENSE) — see LICENSE file for details.
