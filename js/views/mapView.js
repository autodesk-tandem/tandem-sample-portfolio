/**
 * Map View — Leaflet map with facility pins.
 *
 * Spec: specs/ux.md (View 2: Map)
 *
 * "Set location" supports three modes:
 *   1. Click on the map to drop a pin
 *   2. Geocode by address (Nominatim/OSM) — result is PREVIEWED before confirming
 *   3. Type lat/lng manually
 *
 * Geocode preview: a temporary marker appears on the map with a
 * "Is this right? [Confirm] [Try again]" prompt — never silently saves a
 * geocoded result, because Tandem facility addresses may be fictitious or
 * incomplete.
 */

import { getLocation, setLocation, removeLocation } from '../state/locationStore.js';
import { getCachedSummary } from '../state/facilityCache.js';
import { getEnv } from '../config.js';

let map          = null;       // Leaflet map instance (created once)
let markers      = new Map();  // facilityURN → confirmed Leaflet marker
let previewMarker = null;      // temporary geocode-preview marker
let placingFor   = null;       // URN currently in "set location" mode
let allFacilities = [];
let facilityRegionMap = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function render(facilities, regionMap) {
    allFacilities    = facilities;
    facilityRegionMap = regionMap;
    cancelPlacing();

    initMap();
    refreshPins();
    renderUnlocatedPanel();
}

/** Call when the Map tab becomes visible so Leaflet recalculates its size. */
export function invalidateMapSize() {
    map?.invalidateSize();
}

// ── Map init ──────────────────────────────────────────────────────────────────

function initMap() {
    if (map) return;

    map = L.map('map-container', { zoomControl: true }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    // Map click → place confirmed pin (if in placing mode)
    map.on('click', e => {
        if (!placingFor) return;
        clearPreview();
        confirmLocation(placingFor, e.latlng.lat, e.latlng.lng);
    });
}

// ── Confirmed pins ────────────────────────────────────────────────────────────

function refreshPins() {
    markers.forEach(m => map.removeLayer(m));
    markers.clear();

    const located = allFacilities.filter(f => getLocation(f.urn));
    located.forEach(f => { const loc = getLocation(f.urn); addPin(f, loc.lat, loc.lng); });

    if (located.length > 0) fitAll(located);
}

function addPin(facility, lat, lng) {
    const marker = L.marker([lat, lng], { icon: tandemIcon('#0696D7') })
        .addTo(map)
        .bindPopup(() => buildPopup(facility), { maxWidth: 260 });
    markers.set(facility.urn, marker);
}

function fitAll(located) {
    const locs = located.map(f => getLocation(f.urn)).filter(Boolean);
    if (!locs.length) return;
    if (locs.length === 1) { map.setView([locs[0].lat, locs[0].lng], 14); return; }
    map.fitBounds(L.latLngBounds(locs.map(l => [l.lat, l.lng])), { padding: [40, 40] });
}

// ── Popup ─────────────────────────────────────────────────────────────────────

function buildPopup(facility) {
    const summary = getCachedSummary(facility.urn);
    const thumb   = summary?.thumbnailURL
        ? `<img src="${summary.thumbnailURL}" style="width:100%;height:100px;object-fit:cover;border-radius:4px;margin-bottom:8px;"/>`
        : '';
    const models  = summary
        ? `<p style="font-size:12px;color:#a0a0a0;margin:0 0 8px;">Models: ${summary.modelCount}</p>`
        : '';
    const url = tandemFacilityURL(facility.urn);
    const safeUrn = encodeURIComponent(facility.urn);

    const div = document.createElement('div');
    div.style.cssText = 'background:#2a2a2a;color:#e0e0e0;border-radius:6px;padding:10px;min-width:200px;';
    div.innerHTML = `
        ${thumb}
        <p style="font-size:13px;font-weight:600;margin:0 0 4px;">${escapeHtml(facility.name)}</p>
        ${models}
        <div style="display:flex;gap:8px;align-items:center;">
            <a href="${url}" target="_blank" rel="noopener"
               style="font-size:12px;color:#0696D7;text-decoration:none;">Open in Tandem ↗</a>
            <button onclick="window._mapView.removePin('${safeUrn}')"
                    style="font-size:11px;color:#a0a0a0;background:none;border:none;cursor:pointer;padding:0;margin-left:auto;">
                Remove pin
            </button>
        </div>`;
    return div;
}

// Global bridge for popup buttons (Leaflet popups are outside the JS module scope)
window._mapView = {
    removePin(encodedUrn) {
        const urn = decodeURIComponent(encodedUrn);
        removeLocation(urn);
        const m = markers.get(urn);
        if (m) { map.removeLayer(m); markers.delete(urn); }
        map.closePopup();
        renderUnlocatedPanel();
    }
};

// ── Unlocated panel ───────────────────────────────────────────────────────────

function renderUnlocatedPanel() {
    const panel = document.getElementById('unlocatedPanel');
    if (!panel) return;

    const unlocated = allFacilities.filter(f => !getLocation(f.urn));

    if (!unlocated.length) { panel.innerHTML = ''; return; }

    panel.innerHTML = `
        <details class="border border-dark-border rounded-lg overflow-hidden mt-4" open>
            <summary class="flex items-center justify-between px-4 py-2.5 bg-dark-card
                            cursor-pointer select-none text-sm font-medium text-dark-text-secondary hover:text-dark-text">
                <span>Unlocated facilities (${unlocated.length})</span>
                <span class="text-xs">▼</span>
            </summary>
            <div class="divide-y divide-dark-border bg-dark-bg">
                ${unlocated.map(renderUnlocatedRow).join('')}
            </div>
        </details>
        ${placingFor ? renderLocationForm() : ''}`;

    panel.querySelectorAll('[data-set-location]').forEach(btn =>
        btn.addEventListener('click', () => enterPlacingMode(btn.dataset.setLocation))
    );

    if (placingFor) wireLocationForm();
}

function renderUnlocatedRow(facility) {
    const isActive = placingFor === facility.urn;
    return `
        <div class="flex items-center justify-between px-4 py-2.5 ${isActive ? 'bg-tandem-blue bg-opacity-10' : ''}">
            <span class="text-sm text-dark-text">${escapeHtml(facility.name)}</span>
            <button data-set-location="${facility.urn}"
                    class="text-xs px-2.5 py-1 rounded border transition
                           ${isActive
                               ? 'border-tandem-blue text-tandem-blue'
                               : 'border-dark-border text-dark-text-secondary hover:border-tandem-blue hover:text-tandem-blue'}">
                ${isActive ? 'Click map to place…' : 'Set location'}
            </button>
        </div>`;
}

function renderLocationForm() {
    const facility = allFacilities.find(f => f.urn === placingFor);
    if (!facility) return '';
    const summary  = getCachedSummary(facility.urn);
    const address  = summary?.address ?? '';

    return `
        <div id="locationForm" class="mt-3 bg-dark-card border border-dark-border rounded-lg p-4 space-y-4">
            <p class="text-xs font-medium text-dark-text-secondary">
                Set location for <span class="text-dark-text font-semibold">${escapeHtml(facility.name)}</span>
            </p>

            <!-- Mode 1: Address geocoding -->
            <div class="space-y-2">
                <label class="text-xs text-dark-text-secondary">Street address</label>
                <div class="flex gap-2 flex-wrap">
                    <input id="addrInput" type="text" value="${escapeHtml(address)}"
                           placeholder="e.g. 111 McInnis Pkwy, San Rafael, CA"
                           class="flex-1 min-w-0 text-xs px-2 py-1.5 rounded border border-dark-border bg-dark-bg
                                  text-dark-text placeholder-dark-text-secondary focus:border-tandem-blue focus:outline-none"/>
                    <button id="geocodeBtn"
                            class="text-xs px-3 py-1.5 rounded bg-tandem-blue text-white hover:bg-blue-600 transition whitespace-nowrap">
                        Find on map
                    </button>
                </div>
                <p id="geocodeStatus" class="text-xs text-dark-text-secondary hidden"></p>
                <!-- Preview confirm/reject row — shown after geocoding -->
                <div id="previewActions" class="hidden flex gap-2 items-center">
                    <span class="text-xs text-dark-text-secondary">Is this the right location?</span>
                    <button id="confirmGeoBtn"
                            class="text-xs px-2.5 py-1 rounded bg-tandem-blue text-white hover:bg-blue-600 transition">
                        Yes, use this
                    </button>
                    <button id="rejectGeoBtn"
                            class="text-xs px-2.5 py-1 rounded border border-dark-border text-dark-text-secondary hover:bg-dark-bg transition">
                        No, try again
                    </button>
                </div>
            </div>

            <div class="flex items-center gap-2">
                <hr class="flex-1 border-dark-border"/>
                <span class="text-xs text-dark-text-secondary">or</span>
                <hr class="flex-1 border-dark-border"/>
            </div>

            <!-- Mode 2: Manual lat/lng -->
            <div class="space-y-2">
                <label class="text-xs text-dark-text-secondary">Coordinates (lat, lng)</label>
                <div class="flex gap-2 flex-wrap">
                    <input id="coordLat" type="number" step="any" placeholder="Latitude (e.g. 37.79)"
                           class="w-36 text-xs px-2 py-1.5 rounded border border-dark-border bg-dark-bg
                                  text-dark-text placeholder-dark-text-secondary focus:border-tandem-blue focus:outline-none"/>
                    <input id="coordLng" type="number" step="any" placeholder="Longitude (e.g. -122.39)"
                           class="w-40 text-xs px-2 py-1.5 rounded border border-dark-border bg-dark-bg
                                  text-dark-text placeholder-dark-text-secondary focus:border-tandem-blue focus:outline-none"/>
                    <button id="coordConfirmBtn"
                            class="text-xs px-3 py-1.5 rounded bg-tandem-blue text-white hover:bg-blue-600 transition">
                        Confirm
                    </button>
                </div>
            </div>

            <div class="pt-1">
                <button id="cancelPlacingBtn"
                        class="text-xs text-dark-text-secondary hover:text-dark-text transition">
                    Cancel
                </button>
            </div>
        </div>`;
}

function wireLocationForm() {
    const urn = placingFor;

    // Geocode
    document.getElementById('geocodeBtn')?.addEventListener('click', () => geocodeAddress(urn));
    document.getElementById('addrInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') geocodeAddress(urn);
    });

    // Preview confirm / reject
    document.getElementById('confirmGeoBtn')?.addEventListener('click', () => {
        if (!previewMarker) return;
        const { lat, lng } = previewMarker.getLatLng();
        clearPreview();
        confirmLocation(urn, lat, lng);
    });
    document.getElementById('rejectGeoBtn')?.addEventListener('click', () => {
        clearPreview();
        setGeocodeStatus('');
        document.getElementById('previewActions')?.classList.add('hidden');
    });

    // Manual coords
    document.getElementById('coordConfirmBtn')?.addEventListener('click', () => {
        const lat = parseFloat(document.getElementById('coordLat')?.value);
        const lng = parseFloat(document.getElementById('coordLng')?.value);
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            alert('Please enter valid coordinates.\nLatitude: −90 to 90, Longitude: −180 to 180');
            return;
        }
        clearPreview();
        confirmLocation(urn, lat, lng);
    });

    // Cancel
    document.getElementById('cancelPlacingBtn')?.addEventListener('click', cancelPlacing);
}

// ── Geocoding (Nominatim) ─────────────────────────────────────────────────────

async function geocodeAddress(urn) {
    const input = document.getElementById('addrInput');
    const query = input?.value?.trim();
    if (!query) return;

    clearPreview();
    setGeocodeStatus('Searching…');
    document.getElementById('previewActions')?.classList.add('hidden');
    document.getElementById('geocodeBtn').disabled = true;

    try {
        // Nominatim usage policy: max 1 req/sec, User-Agent required
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
        const resp = await fetch(url, {
            headers: { 'Accept-Language': 'en', 'User-Agent': 'tandem-sample-portfolio/1.0' }
        });
        const results = await resp.json();

        if (!results.length) {
            setGeocodeStatus('⚠ Address not found. Edit the address or click the map directly.', true);
            return;
        }

        const { lat, lon, display_name } = results[0];
        const numLat = parseFloat(lat);
        const numLng = parseFloat(lon);

        // Show PREVIEW marker (orange) — not yet saved
        previewMarker = L.marker([numLat, numLng], { icon: tandemIcon('#f59e0b') })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;color:#1a1a1a;max-width:220px;">${escapeHtml(display_name)}</div>`)
            .openPopup();

        map.setView([numLat, numLng], 15);
        setGeocodeStatus(`Found: ${display_name.split(',').slice(0, 3).join(',')}`, false);
        document.getElementById('previewActions')?.classList.remove('hidden');

    } catch (err) {
        console.error('Geocoding error:', err);
        setGeocodeStatus('⚠ Geocoding failed. Check your connection or try coordinates.', true);
    } finally {
        if (document.getElementById('geocodeBtn')) {
            document.getElementById('geocodeBtn').disabled = false;
        }
    }
}

function setGeocodeStatus(msg, isError = false) {
    const el = document.getElementById('geocodeStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = `text-xs mt-1 ${msg ? '' : 'hidden'} ${isError ? 'text-red-400' : 'text-dark-text-secondary'}`;
}

// ── Location confirm / cancel ─────────────────────────────────────────────────

function confirmLocation(urn, lat, lng) {
    setLocation(urn, lat, lng);
    cancelPlacing();

    const facility = allFacilities.find(f => f.urn === urn);
    if (facility) {
        const old = markers.get(urn);
        if (old) map.removeLayer(old);
        addPin(facility, lat, lng);
        map.setView([lat, lng], 14);
    }

    renderUnlocatedPanel();
}

function cancelPlacing() {
    clearPreview();
    placingFor = null;
}

function clearPreview() {
    if (previewMarker) { map.removeLayer(previewMarker); previewMarker = null; }
}

function enterPlacingMode(urn) {
    clearPreview();
    placingFor = placingFor === urn ? null : urn; // toggle
    renderUnlocatedPanel();
}

// ── Custom marker icons ───────────────────────────────────────────────────────

function tandemIcon(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
        <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z"
              fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>
        <circle cx="14" cy="14" r="5" fill="white"/>
    </svg>`;
    return L.divIcon({
        html: svg, className: '',
        iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -38],
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tandemFacilityURL(urn) {
    const base = getEnv().tandemAppBaseURL.replace('/app', '');
    return `${base}/pages/facilities/${encodeURIComponent(urn)}`;
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
