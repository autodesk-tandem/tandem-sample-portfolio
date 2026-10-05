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

/** Call when the Map tab becomes visible so Leaflet recalculates its size and re-fits pins. */
export function invalidateMapSize() {
    if (!map) return;
    map.invalidateSize();
    // Re-fit after size is known — the map was hidden when render() first ran
    const located = allFacilities.filter(f => getLocation(f.urn));
    if (located.length > 0) fitAll(located);
}

// ── Map init ──────────────────────────────────────────────────────────────────

function initMap() {
    if (map) return;

    map = L.map('map-container', {
        zoomControl: true,
        scrollWheelZoom: false,  // prevent hijacking page scroll
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    // Enable scroll zoom only while the user is interacting with the map
    map.on('click',    () => map.scrollWheelZoom.enable());
    map.on('mouseout', () => map.scrollWheelZoom.disable());

    // "Fit All" custom control (top-left, below zoom buttons)
    const FitAllControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const btn = L.DomUtil.create('button', 'leaflet-bar leaflet-control');
            btn.title = 'Zoom to fit all facility pins';
            btn.style.cssText = [
                'font-size:11px', 'font-weight:600', 'padding:0 8px',
                'height:30px', 'cursor:pointer', 'white-space:nowrap',
                'background:#2a2a2a', 'color:#e0e0e0', 'border:none', 'width:100%'
            ].join(';');
            btn.textContent = 'Fit All';
            L.DomEvent.on(btn, 'click', e => {
                L.DomEvent.stopPropagation(e);
                const located = allFacilities.filter(f => getLocation(f.urn));
                if (located.length) fitAll(located);
            });
            return btn;
        }
    });
    new FitAllControl().addTo(map);

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
    const summary  = getCachedSummary(facility.urn);
    const loc      = getLocation(facility.urn);
    const thumb    = summary?.thumbnailURL
        ? `<img src="${summary.thumbnailURL}" style="width:100%;height:100px;object-fit:cover;border-radius:4px;margin-bottom:8px;"/>`
        : '';
    const models   = summary
        ? `<p style="font-size:12px;color:#a0a0a0;margin:0 0 8px;">Models: ${summary.modelCount}</p>`
        : '';
    const tandemUrl = tandemFacilityURL(facility.urn);
    const safeUrn   = encodeURIComponent(facility.urn);

    // External map links
    const googleUrl = loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : null;
    const appleUrl  = loc ? `https://maps.apple.com/?ll=${loc.lat},${loc.lng}&q=${encodeURIComponent(facility.name)}` : null;

    const externalLinks = (googleUrl && appleUrl) ? `
        <div style="display:flex;gap:10px;margin:6px 0 2px;">
            <a href="${googleUrl}" target="_blank" rel="noopener"
               style="font-size:11px;color:#a0a0a0;text-decoration:none;">
                🗺 Google Maps ↗
            </a>
            <a href="${appleUrl}" target="_blank" rel="noopener"
               style="font-size:11px;color:#a0a0a0;text-decoration:none;">
                🍎 Apple Maps ↗
            </a>
        </div>` : '';

    const div = document.createElement('div');
    div.style.cssText = 'background:#2a2a2a;color:#e0e0e0;border-radius:6px;padding:10px;min-width:220px;';
    div.innerHTML = `
        ${thumb}
        <p style="font-size:13px;font-weight:600;margin:0 0 4px;">${escapeHtml(facility.name)}</p>
        ${models}
        ${externalLinks}
        <hr style="border:none;border-top:1px solid #404040;margin:8px 0;"/>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <a href="${tandemUrl}" target="_blank" rel="noopener"
               style="font-size:12px;color:#0696D7;text-decoration:none;">Open in Tandem ↗</a>
            <button onclick="window._mapView.changePin('${safeUrn}')"
                    style="font-size:11px;color:#a0a0a0;background:none;border:none;cursor:pointer;padding:0;">
                Change location
            </button>
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
    },
    changePin(encodedUrn) {
        const urn = decodeURIComponent(encodedUrn);
        map.closePopup();
        // Enter placing mode — old pin stays visible until new location is confirmed
        placingFor = urn;
        // Scroll the unlocated panel into view so the form is visible
        const panel = document.getElementById('unlocatedPanel');
        renderUnlocatedPanel();
        panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};

// ── Unlocated panel ───────────────────────────────────────────────────────────

function renderUnlocatedPanel() {
    const panel = document.getElementById('unlocatedPanel');
    if (!panel) return;

    const unlocated = allFacilities.filter(f => !getLocation(f.urn));

    // The location form should appear if placingFor is set, regardless of whether
    // the facility is already located (i.e. "Change location" from a popup)
    const placingFacility = placingFor ? allFacilities.find(f => f.urn === placingFor) : null;
    const isChanging = placingFacility && getLocation(placingFor); // relocating a pinned facility

    if (!unlocated.length && !placingFor) { panel.innerHTML = ''; return; }

    // Build the row list.  For the active facility the form is inserted INLINE
    // right below its row — so it's always visible regardless of list length.
    // If "Change location" is active for an already-pinned facility, show it
    // at the top of the list so it has a row to anchor the inline form to.
    const listFacilities = [...unlocated];
    if (isChanging && !listFacilities.find(f => f.urn === placingFor)) {
        listFacilities.unshift(placingFacility);
    }

    const rowsHtml = listFacilities.map(f => {
        const row = renderUnlocatedRow(f);
        if (placingFor === f.urn) {
            return row + renderLocationForm();   // form lives inside the list, after its row
        }
        return row;
    }).join('');

    const unlocatedSection = listFacilities.length ? `
        <details class="border border-dark-border rounded-lg overflow-hidden mt-4" open>
            <summary class="flex items-center justify-between px-4 py-2.5 bg-dark-card
                            cursor-pointer select-none text-sm font-medium text-dark-text-secondary hover:text-dark-text">
                <span>${isChanging ? `Changing location` : `Unlocated facilities (${unlocated.length})`}</span>
                <span class="text-xs">▼</span>
            </summary>
            <div class="divide-y divide-dark-border bg-dark-bg">
                ${rowsHtml}
            </div>
        </details>` : '';

    panel.innerHTML = unlocatedSection;

    panel.querySelectorAll('[data-set-location]').forEach(btn =>
        btn.addEventListener('click', () => enterPlacingMode(btn.dataset.setLocation))
    );

    if (placingFor) {
        wireLocationForm();
        // Scroll the inline form into view so it's always visible
        document.getElementById('locationForm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
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
        <div id="locationForm" class="bg-dark-bg border-t border-dark-border p-4 space-y-4">
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

/**
 * Strip suite/unit/floor designators that confuse Nominatim.
 * e.g. "23 Drydock Ave, Ste. 110E Boston MA" → "23 Drydock Ave Boston MA"
 */
function stripSubpremise(addr) {
    return addr
        .replace(/,?\s*(ste\.?|suite|apt\.?|apartment|unit|fl\.?|floor|room|rm\.?|#)\s*[\w-]*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

async function nominatimSearch(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const resp = await fetch(url, {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'tandem-sample-portfolio/1.0' }
    });
    return resp.json();
}

async function geocodeAddress(urn) {
    const input = document.getElementById('addrInput');
    const query = input?.value?.trim();
    if (!query) return;

    clearPreview();
    setGeocodeStatus('Searching…');
    document.getElementById('previewActions')?.classList.add('hidden');
    document.getElementById('geocodeBtn').disabled = true;

    try {
        // Attempt 1: full address as typed
        let results = await nominatimSearch(query);
        let usedQuery = query;

        // Attempt 2: strip suite/unit numbers (Nominatim can't resolve them)
        if (!results.length) {
            const simplified = stripSubpremise(query);
            if (simplified !== query) {
                setGeocodeStatus(`Trying without suite/unit: "${simplified}"…`);
                // Nominatim rate-limit: 1 req/sec
                await new Promise(r => setTimeout(r, 1100));
                results = await nominatimSearch(simplified);
                usedQuery = simplified;
            }
        }

        if (!results.length) {
            setGeocodeStatus(
                '⚠ Address not found. Try simplifying it (remove suite/floor numbers) or click the map directly.',
                true
            );
            return;
        }

        const { lat, lon, display_name } = results[0];
        const numLat = parseFloat(lat);
        const numLng  = parseFloat(lon);

        const note = usedQuery !== query ? ` (searched as: "${usedQuery}")` : '';

        // Show PREVIEW marker (orange) — not yet confirmed/saved
        previewMarker = L.marker([numLat, numLng], { icon: tandemIcon('#f59e0b') })
            .addTo(map)
            .bindPopup(`<div style="font-size:12px;color:#1a1a1a;max-width:240px;">${escapeHtml(display_name)}</div>`)
            .openPopup();

        map.setView([numLat, numLng], 15);
        setGeocodeStatus(`Found: ${display_name.split(',').slice(0, 3).join(',')}${note}`);
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
    renderUnlocatedPanel();
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
    // URN is NOT encoded — Tandem expects the raw URN in the path
    const base = getEnv().tandemAppBaseURL.replace('/app', '');
    return `${base}/pages/facilities/${urn}`;
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
