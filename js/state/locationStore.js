/**
 * Persists facility lat/lng coordinates to localStorage.
 * Used by the Map view since Tandem has no native location field.
 *
 * Storage key: 'tandem-portfolio-locations'
 * Value: JSON object mapping facilityURN → { lat, lng }
 */

const STORAGE_KEY = 'tandem-portfolio-locations';

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function save(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn('locationStore: could not save to localStorage', e);
    }
}

/**
 * @returns {{ lat: number, lng: number } | null}
 */
export function getLocation(facilityURN) {
    return load()[facilityURN] ?? null;
}

/**
 * @param {string} facilityURN
 * @param {number} lat
 * @param {number} lng
 * @param {string} [label] - Human-readable address label (from geocoder or user input)
 */
export function setLocation(facilityURN, lat, lng, label) {
    const data = load();
    data[facilityURN] = { lat, lng, ...(label ? { label } : {}) };
    save(data);
}

export function removeLocation(facilityURN) {
    const data = load();
    delete data[facilityURN];
    save(data);
}

/** Returns all stored locations as { [urn]: { lat, lng } } */
export function getAllLocations() {
    return load();
}
