# Architecture Spec

> **Status:** Draft — not yet defined  
> **Last updated:** —

## Tech Stack

_Confirm or override the defaults below once the project takes shape._

- **Runtime:** Browser (vanilla JS, ES modules, no bundler — matching tandem-sample-stats pattern)
- **Auth:** OAuth 3-legged PKCE via `js/auth.js`
- **API:** Autodesk Tandem REST API via `js/api.js`
- **Styling:** _TBD — plain CSS? Tailwind? Bootstrap?_
- **Charting / visualization:** _TBD_
- **3D Viewer:** _TBD — embedded viewer (tandem-sample-emb-viewer pattern) or REST-only?_

## Patterns

_Document the architectural decisions made for this project._

<!-- e.g. module structure, state management, caching strategy -->

## Constraints

_Hard rules agents must not violate._

- Always use constants from `tandem/constants.js` — no hardcoded column names or magic numbers
- Always check override columns before standard columns (QC.OName before QC.Name, etc.)
- Never store credentials or tokens in localStorage beyond what auth.js already does

## Open Questions

- Embedded 3D viewer or REST-only?
- Single page or multi-page?
- Does this need a backend/server, or purely client-side?
- Offline / caching requirements?
