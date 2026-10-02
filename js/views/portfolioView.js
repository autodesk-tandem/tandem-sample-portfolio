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

let allFacilities = [];       // full list for the selected account
let filteredFacilities = [];  // after text filter applied
let renderedCount = 0;        // how many cards are currently in the DOM
let facilityRegionMap = null; // injected by app.js

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
    allFacilities = facilities;
    facilityRegionMap = regionMap;
    renderedCount = 0;

    cleanupThumbnailURLs();
    grid.innerHTML = '';

    applyFilter(document.getElementById('facilityFilter')?.value ?? '');
}

/**
 * Filter the visible cards by a text query.
 * Called by app.js on every keyup in the filter input.
 * @param {string} query
 */
export function applyFilter(query) {
    const q = query.trim().toLowerCase();
    filteredFacilities = q
        ? allFacilities.filter(f => f.name.toLowerCase().includes(q))
        : allFacilities;

    renderedCount = 0;
    grid.innerHTML = '';
    updateStatusBar();
    renderNextPage();
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
        <div class="p-3 flex flex-col flex-1 space-y-2">
            <!-- Name + badge slot -->
            <div class="flex items-start justify-between gap-2">
                <p class="text-sm font-medium text-dark-text leading-tight">${escapeHtml(facility.name)}</p>
                <span class="facility-badge shrink-0"></span>
            </div>

            <!-- Stats row (skeleton) -->
            <div class="flex gap-4 mt-1">
                <div class="skeleton h-3 w-16"></div>
                <div class="skeleton h-3 w-12"></div>
            </div>

            <!-- Spacer -->
            <div class="flex-1"></div>

            <!-- Open in Tandem -->
            <div class="pt-2 border-t border-dark-border flex justify-end">
                <a href="${tandemFacilityURL(facility.urn)}"
                   target="_blank" rel="noopener"
                   class="inline-flex items-center gap-1 text-xs text-tandem-blue hover:underline">
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
    // Thumbnail
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

    // Stats row — replace skeletons
    const statsRow = card.querySelector('.flex.gap-4');
    if (statsRow) {
        statsRow.innerHTML = `
            <span class="text-xs text-dark-text-secondary">
                Models: <span class="text-dark-text font-medium">${summary.modelCount}</span>
            </span>`;
    }

    if (summary.error) showCardError(card);
}

function showCardError(card) {
    const statsRow = card.querySelector('.flex.gap-4');
    if (statsRow) {
        statsRow.innerHTML = `<span class="text-xs text-red-400">Could not load details</span>`;
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
    const base = getEnv().tandemAppBaseURL.replace('/app', '');
    return `${base}/pages/facilities/${encodeURIComponent(urn)}`;
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wire up the Load More button (called once during app init)
export function initLoadMore() {
    loadMoreBtn?.addEventListener('click', renderNextPage);
}
