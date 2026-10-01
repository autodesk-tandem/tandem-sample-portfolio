# Security Spec

> **Status:** Draft — not yet defined  
> **Last updated:** —

## Authentication & Authorization

_How does the app authenticate users? What can different users do?_

- **Auth method:** OAuth 3-legged PKCE (inherited from `js/auth.js`)
- **Authorization:** _TBD — does this app need any app-level roles beyond what Tandem provides?_

## Data Sensitivity

_What Tandem data does this app access? Is any of it sensitive?_

## Known Constraints

- Never expose access tokens in URLs or logs
- All API calls must use HTTPS
- No hardcoded credentials anywhere in the codebase

## Threat Model

_What are the realistic threats for this app and audience?_

<!-- e.g. unauthorized access to facility data, XSS, token leakage -->

## Open Questions

- Who is the intended user base? (internal only, external customers, public?)
- Does the app need to restrict access to specific facilities or groups?
- Are there data residency or compliance requirements?
