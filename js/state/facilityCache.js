/**
 * In-memory cache for facility summary data.
 * Populated lazily as cards are rendered; survives tab switches within the session.
 * Cleared when the user switches accounts.
 */

const cache = new Map(); // facilityURN → summary object

/**
 * @typedef {Object} FacilitySummary
 * @property {string}      urn
 * @property {string}      name
 * @property {string}      region
 * @property {string|null} thumbnailURL  - blob URL (or null if unavailable)
 * @property {number}      modelCount
 * @property {boolean}     loaded        - true once full summary has been fetched
 * @property {boolean}     error         - true if loading failed
 */

export function getCachedSummary(facilityURN) {
    return cache.get(facilityURN) ?? null;
}

export function setCachedSummary(facilityURN, summary) {
    cache.set(facilityURN, summary);
}

export function hasCachedSummary(facilityURN) {
    return cache.has(facilityURN);
}

/** Clear everything (call on account switch). */
export function clearFacilityCache() {
    cache.clear();
}
