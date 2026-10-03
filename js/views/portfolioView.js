/**
 * Portfolio View — renders the facility card grid.
 *
 * Responsibilities:
 *  - Renders skeleton cards immediately, then fills them as data arrives
 *  - Loads facility summaries lazily (thumbnail + model count per card)
 *  - Pagination: PAGE_SIZE cards at a time, Load More button for the rest
 *  - Applies text filter from the search input
 *  - Badge slot reserved on every card (empty for now, hot-spot logic TBD)
 */

import { getFacilityThumbnail, getFacilityInfo, cleanupThumbnailURLs } from '../api.js';
import { getCachedSummary, setCachedSummary } from '../state/facilityCache.js';
import { getEnv } from '../config.js';

const PAGE_SIZE = 50;

// Region display labels
const REGION_LABELS = { us: 'USA', emea: 'EMEA', aus: 'AUS' };

let allFacilities     = [];   // full list for the selected account
let filteredFacilities = [];  // after filters applied
let renderedCount     = 0;    // how many cards are currently in the DOM
let facilityRegionMap = null; // injected by app.js

// Active filter state
let filterState = { search: '', regions: new Set(), tags: new Set() };

// Callback registered by app.js — called when user clicks "View Details →" on a card
let _onViewDetails = null;
export function setViewDetailsCallback(fn) { _onViewDetails = fn; }

const grid        = document.getElementById('facilityGrid');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const loadMoreCtr = document.getElementById('loadMoreContainer');
const statusEl    = document.getElementById('portfolioStatus');
const countEl     = document.getElementById('portfolioCount');

/**
 * Initialise the view with a new account's facilities.
 * Called by app.js whenever the account changes.
 *
 * @param {Array<{urn: string, name: string, region: string}>} facilities
 * @param {Map<string, string>} regionMap - facilityURN → region string
 */
export function render(facilities, regionMap) {
    allFacilities     = facilities;
    facilityRegionMap = regionMap;
    renderedCount     = 0;
    filterState       = { search: '', regions: new Set(), tags: new Set() };

    cleanupThumbnailURLs();
    grid.innerHTML = '';

    renderFilterBar();
    applyFilters();
}

/** Re-run all active filters and refresh the card grid. */
function applyFilters() {
    const q = filterState.search.trim().toLowerCase();

    filteredFacilities = allFacilities.filter(f => {
        // Text search
        if (q && !f.name.toLowerCase().includes(q)) return false;
        // Region filter
        if (filterState.regions.size > 0 && !filterState.regions.has(f.region)) return false;
        // Tag filter — facility must have ALL selected tags
        if (filterState.tags.size > 0) {
            const facilityLabels = new Set((f.labels ?? []).map(l => String(l)));
            for (const tag of filterState.tags) {
                if (!facilityLabels.has(tag)) return false;
            }
        }
        return true;
    });

    renderedCount = 0;
    grid.innerHTML = '';
    updateStatusBar();
    renderNextPage();
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function renderFilterBar() {
    const bar = document.getElementById('filterBar');
    if (!bar) return;

    // Collect all unique regions and tags across facilities
    const allRegions = [...new Set(allFacilities.map(f => f.region).filter(Boolean))].sort();
    const allTags    = [...new Set(allFacilities.flatMap(f => f.labels ?? []).map(String))].sort();

    bar.innerHTML = `
        <div class="flex flex-wrap items-center gap-2 py-3">
            <!-- Search -->
            <div class="relative">
                <svg class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-text-secondary pointer-events-none"
                     fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
                </svg>
                <input id="filterSearch" type="search" placeholder="Search facilities…"
                       value="${escapeHtml(filterState.search)}"
                       class="pl-7 pr-3 py-1.5 w-52 text-xs rounded border border-dark-border bg-dark-bg
                              text-dark-text placeholder-dark-text-secondary focus:border-tandem-blue focus:outline-none"/>
            </div>

            <!-- Region filter -->
            ${allRegions.length > 1 ? `
            <div class="relative" id="regionDropdownWrap">
                <button id="regionBtn"
                        class="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border
                               ${filterState.regions.size ? 'border-tandem-blue text-tandem-blue' : 'border-dark-border text-dark-text-secondary hover:border-tandem-blue hover:text-dark-text'}
                               bg-dark-bg transition">
                    Primary Storage Region
                    ${filterState.regions.size ? `<span class="bg-tandem-blue text-white rounded-full px-1.5">${filterState.regions.size}</span>` : ''}
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                </button>
                <div id="regionDropdown" class="hidden absolute top-full left-0 mt-1 z-30 bg-dark-card border border-dark-border rounded-lg shadow-lg min-w-36 py-1">
                    ${allRegions.map(r => `
                        <label class="flex items-center gap-2 px-3 py-1.5 text-xs text-dark-text hover:bg-dark-bg cursor-pointer">
                            <input type="checkbox" data-region="${r}"
                                   ${filterState.regions.has(r) ? 'checked' : ''}
                                   class="accent-tandem-blue"/>
                            ${REGION_LABELS[r] ?? r.toUpperCase()}
                        </label>`).join('')}
                </div>
            </div>` : ''}

            <!-- Tags filter -->
            ${allTags.length > 0 ? `
            <div class="relative" id="tagDropdownWrap">
                <button id="tagBtn"
                        class="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border
                               ${filterState.tags.size ? 'border-tandem-blue text-tandem-blue' : 'border-dark-border text-dark-text-secondary hover:border-tandem-blue hover:text-dark-text'}
                               bg-dark-bg transition">
                    Tags
                    ${filterState.tags.size ? `<span class="bg-tandem-blue text-white rounded-full px-1.5">${filterState.tags.size}</span>` : ''}
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                </button>
                <div id="tagDropdown" class="hidden absolute top-full left-0 mt-1 z-30 bg-dark-card border border-dark-border rounded-lg shadow-lg min-w-36 py-1">
                    ${allTags.map(t => `
                        <label class="flex items-center gap-2 px-3 py-1.5 text-xs text-dark-text hover:bg-dark-bg cursor-pointer">
                            <input type="checkbox" data-tag="${escapeHtml(t)}"
                                   ${filterState.tags.has(t) ? 'checked' : ''}
                                   class="accent-tandem-blue"/>
                            ${escapeHtml(t)}
                        </label>`).join('')}
                </div>
            </div>` : ''}

            <!-- Active filter pills -->
            ${[...filterState.regions].map(r => `
                <span class="inline-flex items-center gap-1 text-xs bg-tandem-blue bg-opacity-20 text-tandem-blue
                             border border-tandem-blue border-opacity-40 rounded-full px-2.5 py-0.5">
                    ${REGION_LABELS[r] ?? r.toUpperCase()}
                    <button data-clear-region="${r}" class="hover:text-white transition leading-none">×</button>
                </span>`).join('')}
            ${[...filterState.tags].map(t => `
                <span class="inline-flex items-center gap-1 text-xs bg-tandem-blue bg-opacity-20 text-tandem-blue
                             border border-tandem-blue border-opacity-40 rounded-full px-2.5 py-0.5">
                    ${escapeHtml(t)}
                    <button data-clear-tag="${escapeHtml(t)}" class="hover:text-white transition leading-none">×</button>
                </span>`).join('')}

            <!-- Clear all -->
            ${(filterState.regions.size || filterState.tags.size || filterState.search) ? `
                <button id="clearAllFilters"
                        class="text-xs text-dark-text-secondary hover:text-dark-text underline transition ml-1">
                    Clear all
                </button>` : ''}
        </div>`;

    wireFilterBar();
}

function wireFilterBar() {
    // Search
    document.getElementById('filterSearch')?.addEventListener('input', e => {
        filterState.search = e.target.value;
        applyFilters();
    });

    // Region dropdown toggle
    const regionBtn = document.getElementById('regionBtn');
    const regionDd  = document.getElementById('regionDropdown');
    regionBtn?.addEventListener('click', e => { e.stopPropagation(); regionDd?.classList.toggle('hidden'); });

    // Tag dropdown toggle
    const tagBtn = document.getElementById('tagBtn');
    const tagDd  = document.getElementById('tagDropdown');
    tagBtn?.addEventListener('click', e => { e.stopPropagation(); tagDd?.classList.toggle('hidden'); });

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        regionDd?.classList.add('hidden');
        tagDd?.classList.add('hidden');
    }, { once: true });

    // Region checkboxes
    document.querySelectorAll('[data-region]').forEach(cb => {
        cb.addEventListener('change', () => {
            cb.checked ? filterState.regions.add(cb.dataset.region) : filterState.regions.delete(cb.dataset.region);
            applyFilters();
            renderFilterBar();
        });
    });

    // Tag checkboxes
    document.querySelectorAll('[data-tag]').forEach(cb => {
        cb.addEventListener('change', () => {
            cb.checked ? filterState.tags.add(cb.dataset.tag) : filterState.tags.delete(cb.dataset.tag);
            applyFilters();
            renderFilterBar();
        });
    });

    // Clear region pills
    document.querySelectorAll('[data-clear-region]').forEach(btn => {
        btn.addEventListener('click', () => {
            filterState.regions.delete(btn.dataset.clearRegion);
            applyFilters();
            renderFilterBar();
        });
    });

    // Clear tag pills
    document.querySelectorAll('[data-clear-tag]').forEach(btn => {
        btn.addEventListener('click', () => {
            filterState.tags.delete(btn.dataset.clearTag);
            applyFilters();
            renderFilterBar();
        });
    });

    // Clear all
    document.getElementById('clearAllFilters')?.addEventListener('click', () => {
        filterState = { search: '', regions: new Set(), tags: new Set() };
        applyFilters();
        renderFilterBar();
    });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function updateStatusBar() {
    const total = allFacilities.length;
    const shown = filteredFacilities.length;
    statusEl.textContent = total === 0
        ? 'No facilities found for this account.'
        : '';
    countEl.textContent = total > 0
        ? (shown < total ? `Showing ${shown} of ${total} facilities` : `${total} facilit${total === 1 ? 'y' : 'ies'}`)
        : '';
}

function renderNextPage() {
    const slice = filteredFacilities.slice(renderedCount, renderedCount + PAGE_SIZE);

    if (slice.length === 0 && renderedCount === 0) {
        grid.innerHTML = `
            <div class="col-span-full text-center py-16 text-dark-text-secondary text-sm">
                No facilities match your filter.
            </div>`;
        loadMoreCtr.classList.add('hidden');
        return;
    }

    slice.forEach(facility => {
        const card = createSkeletonCard(facility);
        grid.appendChild(card);
        loadFacilityData(facility, card);
    });

    renderedCount += slice.length;

    // Show / hide the Load More button
    if (renderedCount < filteredFacilities.length) {
        loadMoreCtr.classList.remove('hidden');
    } else {
        loadMoreCtr.classList.add('hidden');
    }
}

/** Creates and returns a skeleton card element. */
function createSkeletonCard(facility) {
    const card = document.createElement('div');
    card.dataset.urn = facility.urn;
    card.className = 'bg-dark-card border border-dark-border rounded-lg overflow-hidden flex flex-col';
    card.innerHTML = `
        <!-- Thumbnail area -->
        <div class="skeleton h-28 w-full"></div>

        <!-- Card body -->
        <div class="p-3 flex flex-col flex-1 space-y-1.5">
            <!-- Name + badge slot -->
            <div class="flex items-start justify-between gap-2">
                <p class="text-sm font-medium text-dark-text leading-tight">${escapeHtml(facility.name)}</p>
                <span class="facility-badge shrink-0"></span>
            </div>

            <!-- Stats row: skeletons replaced by real data in populateCard / updateCardStats -->
            <div class="stats-row flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-dark-text-secondary">
                <span class="skeleton h-2.5 w-16 rounded inline-block"></span>
                <span class="skeleton h-2.5 w-16 rounded inline-block"></span>
                <span class="skeleton h-2.5 w-16 rounded inline-block"></span>
            </div>

            <!-- Spacer -->
            <div class="flex-1"></div>

            <!-- Footer: View Details + Open in Tandem -->
            <div class="pt-2 border-t border-dark-border flex items-center justify-between">
                <button data-view-details="${escapeHtml(facility.urn)}"
                        class="text-xs text-tandem-blue hover:underline transition">
                    View Details →
                </button>
                <a href="${tandemFacilityURL(facility.urn)}"
                   target="_blank" rel="noopener"
                   class="inline-flex items-center gap-1 text-xs text-dark-text-secondary hover:text-tandem-blue transition">
                    Open in Tandem
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>
                </a>
            </div>
        </div>`;
    return card;
}

/**
 * Asynchronously loads the real data for a card and replaces its skeleton content.
 */
async function loadFacilityData(facility, card) {
    // Check cache first
    const cached = getCachedSummary(facility.urn);
    if (cached) {
        populateCard(card, cached);
        return;
    }

    const region = facilityRegionMap?.get(facility.urn) ?? 'us';

    try {
        // Fetch facility info (gives us models + address) and thumbnail in parallel
        const [thumbnailURL, info] = await Promise.all([
            getFacilityThumbnail(facility.urn, region),
            getFacilityInfo(facility.urn, region).catch(() => null),
        ]);

        const models = info?.links ?? [];
        const address = info?.props?.['Identity Data']?.['Address'] ?? null;

        const summary = {
            urn:          facility.urn,
            name:         facility.name,
            region,
            thumbnailURL: thumbnailURL ?? null,
            modelCount:   Array.isArray(models) ? models.length : 0,
            address,
            loaded:       true,
            error:        false,
        };

        setCachedSummary(facility.urn, summary);
        populateCard(card, summary);
    } catch (err) {
        console.warn(`Failed to load summary for ${facility.name}:`, err);
        setCachedSummary(facility.urn, {
            urn: facility.urn, name: facility.name, region,
            thumbnailURL: null, modelCount: 0, loaded: true, error: true,
        });
        showCardError(card);
    }
}

/** Replaces skeleton content with real data. */
function populateCard(card, summary) {
    // Thumbnail — replace the FIRST skeleton (the hero image placeholder)
    const thumbEl = card.querySelector('.skeleton');
    if (thumbEl) {
        if (summary.thumbnailURL) {
            const img = document.createElement('img');
            img.src = summary.thumbnailURL;
            img.alt = summary.name;
            img.className = 'facility-thumbnail bg-dark-bg';
            img.onerror = () => { img.replaceWith(buildThumbPlaceholder()); };
            thumbEl.replaceWith(img);
        } else {
            thumbEl.replaceWith(buildThumbPlaceholder());
        }
    }

    // Stats row — replace skeleton spans with model count + stat placeholders
    const statsRow = card.querySelector('.stats-row');
    if (statsRow) {
        statsRow.innerHTML = `
            <span>📦 <span class="text-dark-text font-medium">${summary.modelCount}</span> models</span>
            <span class="stat-streams">📡 <span class="text-dark-text font-medium">–</span></span>
            <span class="stat-assets">🏷 <span class="text-dark-text font-medium">–</span></span>`;
    }

    if (summary.error) showCardError(card);
}

function showCardError(card) {
    const statsRow = card.querySelector('.stats-row');
    if (statsRow) {
        statsRow.innerHTML = `<span class="text-xs text-red-400">Could not load details</span>`;
    }
}

/**
 * Update the stream and asset count badges on a rendered card.
 * Called by app.js after background stat loading completes for a facility.
 * @param {string} urn - Facility URN
 * @param {{streamCount?: number, taggedAssetCount?: number, error?: boolean}} stats
 */
export function updateCardStats(urn, stats) {
    const card = grid.querySelector(`[data-urn="${CSS.escape(urn)}"]`);
    if (!card) return; // card not rendered (filtered out or not yet loaded)

    if (stats.error) {
        // Leave placeholders as-is — don't show an error since thumbnail/models loaded fine
        return;
    }

    const streamsEl = card.querySelector('.stat-streams');
    if (streamsEl) {
        streamsEl.innerHTML = `📡 <span class="text-dark-text font-medium">${stats.streamCount}</span> streams`;
    }
    const assetsEl = card.querySelector('.stat-assets');
    if (assetsEl) {
        assetsEl.innerHTML = `🏷 <span class="text-dark-text font-medium">${stats.taggedAssetCount}</span> assets`;
    }
}

function buildThumbPlaceholder() {
    const div = document.createElement('div');
    div.className = 'h-28 w-full bg-dark-bg flex items-center justify-center';
    div.innerHTML = `
        <svg class="w-10 h-10 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
            <polyline stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      points="9 22 9 12 15 12 15 22"/>
        </svg>`;
    return div;
}

function tandemFacilityURL(urn) {
    // e.g. https://tandem.autodesk.com/pages/facilities/urn:adsk.dtt:xxxxx
    // URN is NOT encoded — Tandem expects the raw URN in the path
    const base = getEnv().tandemAppBaseURL.replace('/app', '');
    return `${base}/pages/facilities/${urn}`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wire up the Load More button and grid event delegation (called once during app init)
export function initLoadMore() {
    loadMoreBtn?.addEventListener('click', renderNextPage);

    // Delegate "View Details →" clicks from any card in the grid
    grid.addEventListener('click', e => {
        const btn = e.target.closest('[data-view-details]');
        if (btn && _onViewDetails) _onViewDetails(btn.dataset.viewDetails);
    });
}
