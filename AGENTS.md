# tandem-sample-portfolio — Agent Guide

This project uses **spec-driven development**. All agents must read the relevant spec
before doing any work. Specs live in `specs/` and are the single source of truth.

## How This Project Works

```
specs/          ← You (the human) own and evolve these
.cursor/rules/  ← Defines each agent role and how it reads the specs
js/             ← Application code
tandem/         ← Reusable Tandem utilities (do not modify)
```

## Role Map

| Role | Rule file | Spec file | Responsible for |
|------|-----------|-----------|-----------------|
| Architect | `.cursor/rules/architect.mdc` | `specs/architecture.md` | Tech stack, patterns, module structure |
| UX | `.cursor/rules/ux.mdc` | `specs/ux.md` | Layout, flows, components, interactions |
| Testing | `.cursor/rules/testing.mdc` | `specs/testing.md` | Tests, coverage, test data |
| Security | `.cursor/rules/security.mdc` | `specs/security.md` | Auth, threat model, data safety |
| Documentation | `.cursor/rules/documentation.mdc` | `specs/documentation.md` | README, inline docs, guides |

## Invoking a Role

Reference the role in your prompt:
> "Acting as the Architect, design the main data-loading module."
> "Acting as UX, implement the facility selection panel."
> "Acting as Security, review the auth flow."

Or attach the relevant spec file with @specs/architecture.md etc.

## Spec Evolution Protocol

1. Human updates the spec file
2. Commit the spec change
3. Ask the relevant agent: "The spec changed — what code needs to update?"
4. Agent proposes changes → human reviews → commit

**Never let the code get ahead of the specs.**

## Reusable Tandem Utilities

Copied from `tandem-sample-stats`. Do not modify these files directly.

| File | Purpose |
|------|---------|
| `tandem/constants.js` | Column families, names, element flags, QC qualified columns |
| `tandem/keys.js` | Key and xref conversion utilities |
| `js/auth.js` | OAuth 3-legged PKCE flow |
| `js/api.js` | Tandem REST API wrappers |
| `js/config.js` | Environment configuration |

## Current Spec Status

| Spec | Status |
|------|--------|
| `specs/overview.md` | EMPTY — fill this first |
| `specs/architecture.md` | Stub — defaults only |
| `specs/ux.md` | EMPTY |
| `specs/testing.md` | EMPTY |
| `specs/security.md` | Stub — defaults only |
| `specs/documentation.md` | Stub — defaults only |
