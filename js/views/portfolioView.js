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

import { getFacilityThumbnail, getFacilityInfo, getInlineTemplate, cleanupThumbnailURLs } from '../api.js';
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

// ── Metric icons (SVG, inline-friendly) ──────────────────────────────────────
// Models: wireframe 3-D box  |  Streams: waveform / signal line  |  Assets: tag
const ICON_MODELS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
    <polyline stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              points="3.27 6.96 12 12.01 20.73 6.96"/>
    <line stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          x1="12" y1="22.08" x2="12" y2="12"/>
</svg>`;
const ICON_STREAMS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M3 12h2l3-7 4 14 3-8 2 1h4"/>
</svg>`;
const ICON_ASSETS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M7 7h10M7 12h6m-6 5h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/>
</svg>`;
// Template: document with a small star/badge — "schema / spec" feel
const ICON_TEMPLATE = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
</svg>`;

// ── View mode ─────────────────────────────────────────────────────────────────
let viewMode         = 'grid';       // 'grid' | 'leaderboard'
let leaderboardMetric = 'streams';   // 'streams' | 'assets'

// Accumulates stats as updateCardStats() is called (needed for leaderboard sorting)
const statsStore = new Map(); // urn → { streamCount, taggedAssetCount }

// Callback registered by app.js — called when user clicks "View Details →" on a card
let _onViewDetails = null;
export function setViewDetailsCallback(fn) { _onViewDetails = fn; }

const grid        = document.getElementById('facilityGrid');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const loadMoreCtr = document.getElementById('loadMoreContainer');
const statusEl    = document.getElementById('portfolioStatus');
const countEl     = document.getElementById('portfolioCount');
const bannerEl    = document.getElementById('accountMetricsBanner');

/**
 * Initialise the view with a new account's facilities.
 * Called by app.js whenever the account changes.
 *
 * @param {Array<{urn: string, name: string, region: string}>} facilities
 * @param {Map<string, string>} regionMap - facilityURN → region string
 */
/**
 * Show account-level metrics in the banner above the facility grid.
 * Called by app.js after getGroupMetrics resolves.
 * @param {{activeFacilityCount, totalNbOfModel, totalNbOfElement, totalNbOfAssets}|null} metrics
 * @param {string} accountName
 */
export function renderAccountBanner(metrics, accountName) {
    if (!bannerEl) return;
    if (!metrics) { bannerEl.innerHTML = ''; return; }

    if (metrics._forbidden) {
        bannerEl.innerHTML = `
            <div class="flex items-center gap-2 px-3 py-2 rounded bg-dark-card border border-dark-border text-xs text-amber-500">
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                </svg>
                Account metrics not available — you may not be an owner of this account.
            </div>`;
        return;
    }

    const fmtBytes = (b) => {
        if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB';
        if (b >= 1_048_576)     return (b / 1_048_576).toFixed(1) + ' MB';
        if (b >= 1_024)         return (b / 1_024).toFixed(0) + ' KB';
        return b + ' B';
    };

    // updatedOn comes back as "YYYYMMDD" (e.g. "20261005")
    const fmtUpdatedOn = (raw) => {
        if (!raw || raw.length < 8) return null;
        const y = raw.slice(0, 4), m = raw.slice(4, 6), d = raw.slice(6, 8);
        const date = new Date(`${y}-${m}-${d}T00:00:00`);
        if (isNaN(date)) return null;
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };
    const updatedLabel = fmtUpdatedOn(metrics.updatedOn);

    const stats = [
        { label: 'Facilities',   value: (metrics.activeFacilityCount ?? 0).toLocaleString(), color: '#0696D7' },
        { label: 'Models',       value: (metrics.totalNbOfModel       ?? 0).toLocaleString(), color: '#10B981' },
        { label: 'Streams',      value: (metrics.numStreams            ?? 0).toLocaleString(), color: '#EC4899' },
        { label: 'Assets',       value: (metrics.totalNbOfAssets       ?? 0).toLocaleString(), color: '#F59E0B' },
        { label: 'Connections',  value: (metrics.numDataConn           ?? 0).toLocaleString(), color: '#14B8A6' },
        { label: 'Elements',     value: (metrics.totalNbOfElement      ?? 0).toLocaleString(), color: '#8B5CF6' },
        { label: 'Storage',      value: fmtBytes(metrics.totalBytesUsed ?? 0),                color: '#F97316' },
    ];

    bannerEl.innerHTML = `
        <div class="flex flex-wrap items-center gap-4 px-3 py-2 rounded bg-dark-card border border-dark-border text-xs">
            <span class="text-dark-text-secondary font-medium shrink-0">Account totals:</span>
            ${stats.map(s => `
            <span class="flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full shrink-0" style="background:${s.color}"></span>
                <span class="text-dark-text-secondary">${s.label}</span>
                <span class="font-semibold text-dark-text">${s.value}</span>
            </span>`).join('')}
            ${updatedLabel ? `
            <span class="ml-auto text-dark-text-secondary italic shrink-0"
                  title="These totals are pre-computed by Tandem and may lag real-time counts by up to one day.">
                as of ${updatedLabel}
            </span>` : ''}
        </div>`;
}

export function render(facilities, regionMap) {
    allFacilities     = facilities;
    facilityRegionMap = regionMap;
    renderedCount     = 0;
    filterState       = { search: '', regions: new Set(), tags: new Set() };
    statsStore.clear();

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
    applyViewMode();
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

            <!-- Spacer -->
            <div class="flex-1"></div>

            <!-- View toggle: Grid / Leaderboard -->
            <div class="flex items-center gap-0.5 border border-dark-border rounded overflow-hidden">
                <button id="viewToggleGrid" title="Card grid"
                        class="p-1.5 transition ${viewMode === 'grid' ? 'bg-tandem-blue text-white' : 'text-dark-text-secondary hover:text-dark-text bg-dark-bg'}">
                    <!-- grid icon -->
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>
                    </svg>
                </button>
                <button id="viewToggleLeaderboard" title="Leaderboard"
                        class="p-1.5 transition ${viewMode === 'leaderboard' ? 'bg-tandem-blue text-white' : 'text-dark-text-secondary hover:text-dark-text bg-dark-bg'}">
                    <!-- bars icon -->
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                    </svg>
                </button>
            </div>
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

    // View mode toggle
    document.getElementById('viewToggleGrid')?.addEventListener('click', () => {
        if (viewMode === 'grid') return;
        viewMode = 'grid';
        applyViewMode();
        renderFilterBar();
    });
    document.getElementById('viewToggleLeaderboard')?.addEventListener('click', () => {
        if (viewMode === 'leaderboard') return;
        viewMode = 'leaderboard';
        applyViewMode();
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

// ── View mode switcher ───────────────────────────────────────────────────────

const leaderboardContainer = document.getElementById('leaderboardContainer');

function applyViewMode() {
    if (viewMode === 'grid') {
        grid.classList.remove('hidden');
        loadMoreCtr.classList.toggle('hidden', renderedCount >= filteredFacilities.length);
        leaderboardContainer.classList.add('hidden');
        if (renderedCount === 0) renderNextPage();
    } else {
        grid.classList.add('hidden');
        loadMoreCtr.classList.add('hidden');
        leaderboardContainer.classList.remove('hidden');
        renderLeaderboard();
    }
}

function renderLeaderboard() {
    if (!leaderboardContainer) return;

    // Build rows from filteredFacilities, merging in known stats
    const rows = filteredFacilities.map(f => {
        const s    = statsStore.get(f.urn);
        const cached = getCachedSummary(f.urn);
        return {
            urn:          f.urn,
            name:         f.name,
            region:       f.region ?? 'us',
            streams:      s ? (s.streamCount      ?? 0) : null,  // null = still loading
            assets:       s ? (s.taggedAssetCount ?? 0) : null,
            templateName: s?.templateName ?? cached?.templateName ?? null,
            loaded:       !!s,
        };
    });

    // Sort logic:
    //   streams/assets → desc numeric, unloaded last
    //   template       → alphabetical (groups same template), no-template last
    if (leaderboardMetric === 'template') {
        rows.sort((a, b) => {
            const ta = a.templateName ?? '';
            const tb = b.templateName ?? '';
            if (!ta && !tb) return 0;
            if (!ta) return 1;
            if (!tb) return -1;
            return ta.localeCompare(tb, undefined, { sensitivity: 'base' });
        });
    } else {
        const sortKey = leaderboardMetric === 'streams' ? 'streams' : 'assets';
        rows.sort((a, b) => {
            if (a.loaded && b.loaded) return (b[sortKey] ?? 0) - (a[sortKey] ?? 0);
            if (a.loaded)  return -1;
            if (b.loaded)  return  1;
            return 0;
        });
    }

    // Scale each metric independently to its own max
    const maxStreams = Math.max(1, ...rows.filter(r => r.loaded).map(r => r.streams ?? 0));
    const maxAssets  = Math.max(1, ...rows.filter(r => r.loaded).map(r => r.assets  ?? 0));

    const btnClass = (m) =>
        `inline-flex items-center gap-1 px-3 py-1 text-xs rounded transition ${leaderboardMetric === m
            ? 'bg-tandem-blue text-white'
            : 'border border-dark-border text-dark-text-secondary hover:text-dark-text bg-dark-bg'}`;

    const extIcon = `<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
    </svg>`;

    leaderboardContainer.innerHTML = `
        <!-- Sort picker -->
        <div class="flex items-center gap-2 mb-4">
            <span class="text-xs text-dark-text-secondary font-medium">Sort by:</span>
            <button id="lbMetricStreams"   class="${btnClass('streams')}">${ICON_STREAMS} Streams</button>
            <button id="lbMetricAssets"   class="${btnClass('assets')}">${ICON_ASSETS} Tagged Assets</button>
            <button id="lbMetricTemplate" class="${btnClass('template')}">${ICON_TEMPLATE} Template</button>
            <span class="text-xs text-dark-text-secondary ml-2">${rows.length} facilit${rows.length === 1 ? 'y' : 'ies'}</span>
        </div>

        <!-- Ranked rows -->
        <div class="space-y-1.5">
            ${(() => {
                let html = '';
                let lastTemplate = undefined;
                rows.forEach((row, i) => {
                    const rank   = i + 1;
                    const region = REGION_LABELS[row.region] ?? row.region.toUpperCase();

                    const streamsPct = row.loaded ? Math.round((row.streams / maxStreams) * 100) : 0;
                    const assetsPct  = row.loaded ? Math.round((row.assets  / maxAssets)  * 100) : 0;

                    const streamsColor = leaderboardMetric === 'streams' ? '#0696D7' : '#374151';
                    const assetsColor  = leaderboardMetric === 'assets'  ? '#10B981' : '#374151';
                    const streamsVal   = row.loaded ? String(row.streams) : '…';
                    const assetsVal    = row.loaded ? String(row.assets)  : '…';

                    if (leaderboardMetric === 'template') {
                        // ── Template grouping view: clean list, no bars ──────────────
                        if (row.templateName !== lastTemplate) {
                            lastTemplate = row.templateName;
                            const label = row.templateName ?? 'No template applied';
                            html += `<div class="flex items-center gap-2 px-1 py-1.5 ${i > 0 ? 'mt-3' : ''}">
                                <span class="text-xs font-semibold text-tandem-blue">${escapeHtml(label)}</span>
                                <div class="flex-1 h-px bg-dark-border"></div>
                            </div>`;
                        }
                        html += `
                        <div class="flex items-center gap-3 px-3 py-2.5 rounded bg-dark-card border border-dark-border
                                    hover:border-tandem-blue transition group">
                            <div class="flex-1 min-w-0">
                                <p class="text-xs font-medium text-dark-text truncate" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</p>
                                <p class="text-xs text-dark-text-secondary">${region}</p>
                            </div>
                            <div class="flex items-center gap-3 shrink-0 opacity-0 group-hover:opacity-100 transition">
                                <button data-view-details="${escapeHtml(row.urn)}"
                                        class="inline-flex items-center gap-1 text-xs text-dark-text-secondary hover:text-tandem-blue transition">
                                    Stats ${extIcon}
                                </button>
                                <a href="${tandemFacilityURL(row.urn)}" target="_blank" rel="noopener"
                                   class="inline-flex items-center gap-1 text-xs text-dark-text-secondary hover:text-tandem-blue transition">
                                    Tandem ${extIcon}
                                </a>
                            </div>
                        </div>`;
                    } else {
                        // ── Numeric sort view: both metric bars ──────────────────────
                        html += `
                        <div class="flex items-center gap-3 px-3 py-3 rounded bg-dark-card border border-dark-border
                                    hover:border-tandem-blue transition group">
                            <span class="text-xs font-mono text-dark-text-secondary w-6 text-right shrink-0">${rank}</span>
                            <div class="w-44 shrink-0 min-w-0">
                                <p class="text-xs font-medium text-dark-text truncate" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</p>
                                <p class="text-xs text-dark-text-secondary">${region}</p>
                            </div>
                            <div class="flex-1 flex flex-col gap-1.5 min-w-0">
                                <div class="flex items-center gap-2">
                                    <span class="flex items-center gap-1 text-xs text-dark-text-secondary w-24 shrink-0">${ICON_STREAMS} Streams</span>
                                    <div class="flex-1 h-2 rounded-full bg-dark-bg overflow-hidden">
                                        <div class="h-full rounded-full transition-all duration-500"
                                             style="width:${streamsPct}%; background:${streamsColor}"></div>
                                    </div>
                                    <span class="text-xs font-medium w-8 text-right shrink-0"
                                          style="color:${leaderboardMetric === 'streams' ? '#e0e0e0' : '#6b7280'}">${streamsVal}</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="flex items-center gap-1 text-xs text-dark-text-secondary w-24 shrink-0">${ICON_ASSETS} Assets</span>
                                    <div class="flex-1 h-2 rounded-full bg-dark-bg overflow-hidden">
                                        <div class="h-full rounded-full transition-all duration-500"
                                             style="width:${assetsPct}%; background:${assetsColor}"></div>
                                    </div>
                                    <span class="text-xs font-medium w-8 text-right shrink-0"
                                          style="color:${leaderboardMetric === 'assets' ? '#e0e0e0' : '#6b7280'}">${assetsVal}</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-3 shrink-0 opacity-0 group-hover:opacity-100 transition pl-2">
                                <button data-view-details="${escapeHtml(row.urn)}"
                                        class="inline-flex items-center gap-1 text-xs text-dark-text-secondary hover:text-tandem-blue transition">
                                    Stats ${extIcon}
                                </button>
                                <a href="${tandemFacilityURL(row.urn)}" target="_blank" rel="noopener"
                                   class="inline-flex items-center gap-1 text-xs text-dark-text-secondary hover:text-tandem-blue transition">
                                    Tandem ${extIcon}
                                </a>
                            </div>
                        </div>`;
                    }
                });
                return html;
            })()}
        </div>`;

    // Wire sort buttons
    document.getElementById('lbMetricStreams')?.addEventListener('click', () => {
        leaderboardMetric = 'streams';
        renderLeaderboard();
    });
    document.getElementById('lbMetricAssets')?.addEventListener('click', () => {
        leaderboardMetric = 'assets';
        renderLeaderboard();
    });
    document.getElementById('lbMetricTemplate')?.addEventListener('click', () => {
        leaderboardMetric = 'template';
        renderLeaderboard();
    });

    // Wire "Stats" punch-out buttons
    leaderboardContainer.querySelectorAll('[data-view-details]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (_onViewDetails) _onViewDetails(btn.dataset.viewDetails);
        });
    });
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

            <!-- Footer: Open in Stats + Open in Tandem -->
            <div class="pt-2 border-t border-dark-border flex items-center justify-between">
                <button data-view-details="${escapeHtml(facility.urn)}"
                        class="inline-flex items-center gap-1 text-xs text-dark-text-secondary hover:text-tandem-blue transition">
                    Open in Stats
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>
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
        // Fetch thumbnail, facility info, and inline template in parallel.
        // Template name requires /inlinetemplate?flatten — it's not in the /twins skeleton.
        const [thumbnailURL, info, inlineTemplate] = await Promise.all([
            getFacilityThumbnail(facility.urn, region),
            getFacilityInfo(facility.urn, region).catch(() => null),
            getInlineTemplate(facility.urn, region).catch(() => null),
        ]);

        const models       = info?.links ?? [];
        const address      = info?.props?.['Identity Data']?.['Address'] ?? null;
        const templateName = inlineTemplate?.name ?? null;

        const summary = {
            urn:          facility.urn,
            name:         facility.name,
            region,
            thumbnailURL: thumbnailURL ?? null,
            modelCount:   Array.isArray(models) ? models.length : 0,
            address,
            templateName,
            loaded:       true,
            error:        false,
        };

        setCachedSummary(facility.urn, summary);
        populateCard(card, summary);

        // Back-patch statsStore if getFacilityStats() already ran before we had the template name.
        // Without this, the leaderboard shows "No template applied" for all facilities because
        // stats often resolve before facility data (template) during account switches.
        const existingStats = statsStore.get(facility.urn);
        if (existingStats && templateName && existingStats.templateName !== templateName) {
            statsStore.set(facility.urn, { ...existingStats, templateName });
            if (viewMode === 'leaderboard') renderLeaderboard();
        }
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
            <span>${ICON_MODELS} <span class="text-dark-text font-medium">${summary.modelCount}</span> models</span>
            <span class="stat-streams">${ICON_STREAMS} <span class="text-dark-text font-medium">–</span></span>
            <span class="stat-assets">${ICON_ASSETS} <span class="text-dark-text font-medium">–</span></span>
`;
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
    // Always store in the stats store (leaderboard reads from here).
    // templateName comes from loadFacilityData (async, may not have run yet).
    // If it's already in the cache, great. If not, loadFacilityData will back-patch
    // statsStore once it completes (see the setCachedSummary block in loadFacilityData).
    if (!stats.error) {
        const cached = getCachedSummary(urn);
        statsStore.set(urn, {
            streamCount:      stats.streamCount      ?? 0,
            taggedAssetCount: stats.taggedAssetCount ?? 0,
            templateName:     cached?.templateName   ?? null,
        });
    }

    // Update the card if it's in the DOM
    const card = grid.querySelector(`[data-urn="${CSS.escape(urn)}"]`);
    if (card && !stats.error) {
        const streamsEl = card.querySelector('.stat-streams');
        if (streamsEl) {
            streamsEl.innerHTML = `${ICON_STREAMS} <span class="text-dark-text font-medium">${stats.streamCount}</span> streams`;
        }
        const assetsEl = card.querySelector('.stat-assets');
        if (assetsEl) {
            assetsEl.innerHTML = `${ICON_ASSETS} <span class="text-dark-text font-medium">${stats.taggedAssetCount}</span> assets`;
        }
    }

    // Re-render leaderboard live as stats arrive
    if (viewMode === 'leaderboard') {
        renderLeaderboard();
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
