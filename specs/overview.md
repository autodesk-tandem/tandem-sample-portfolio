# Project Overview

> **Status:** Defined — ready for Architect and UX roles  
> **Last updated:** 2026-10-02

## Purpose

_What problem does this app solve? Who is it for?_

Tandem is a digital twin application that allows users to interact with ONE facility, but there is no app that allows users to have a "porfolio" view of all their facilities.  A common case might be a University campus with many buildings, an Airport, or maybe a reatil chain like WalMart or Starbucks.  A portfolio view will allow them to see what Facilities they have and where they are located, and then will try to do comparisons between them, or identify "hot spots" that should be looked into further by the user.

## Target Audience

Typically these are Facility Managers or Property Managers.  People that handle a company's corporate physical buildings and facilities.

## Core Use Cases

1. See a full list of all Facilities they are managing
2. Locate them on a map
3. Compare performance, cost, energy usage, or any other measurement that might be high-value to see across your portfolio of facilties.

## Out of Scope

This app will not be used to replace the features in Tandem.  When it comes time to "drill-down" into the details of a particular facility, it can simply "punch out" to Tandem itself using a URL to that Facility (and it can come up in another browser tab or completely new browser session)

## Open Questions

- What is the primary audience: internal Autodesk users, external customers, developers?
    Answer: this is initially a prototype for internal Autodesk users to help them brainstorm about what a final app would look like, but, it should be high quality from the beginning.
- Is this a demo/sample or a production app?
    Answer: It will start out as a prototype for what a production app COULD eventually look like.
- Are there branding or visual design requirements?
    Answer: for now, it should follow the same visual cues as the project 'tandem-sample-stats' and 'tandem-sample-emb-viewer'.  You may also want to look at the source for Tandem client app itself (in project 'dt-client'), but do not let any proprietary code leak out directly from that code base.
- What Tandem data is central to this experience (streams, assets, rooms, models, all of the above)?
    Answer: probably everything in at least summary form.  We want to be able to compare across facilties for trends, exceptions, "hot spots", etc.

## Reference code bases
1. 'dt-server' - implementation of Tandem's backend server and REST API (propietary, do not leak details). Code is either in the IDE or availabe here: https://git.autodesk.com/tandem/dt-server

2. 'viewer' - implementation of the Javascript SDK that the Tandem client app uses.  Includes the LMV viewer component. Proprietary, do not leak details.  Code is either in the IDE or available here: https://git.autodesk.com/tandem/viewer

3. 'dt-client' - implementation of the Tandem client application (end user tool that customers use). Proprietary, do not leak details. Code is either in the IDE or available here: https://git.autodesk.com/tandem/dt-client

4. 'tandem-sample-stats' - developer sample (code available publically).  Demonstrates how to call all the REST APIs from 'dt-server'. Code is either in the IDE or available here: https://github.com/autodesk-tandem/tandem-sample-stats

5. 'tandem-sample-emb-viewer' - demonstrates use of the Javascript SDK (from 'viewer' component) and shows how to embed a 3D viewer (if we decide we need one). Code is either in the IDE or available here: https://github.com/autodesk-tandem/tandem-sample-emb-viewer