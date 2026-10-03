/**
 * app.js — main application bootstrap for tandem-sample-portfolio.
 *
 * Responsibilities:
 *  - Auth (login / logout / checkLogin)
 *  - Load all user resources in one API call (getUserResources '@me')
 *  - Populate the account dropdown
 *  - On account selection: load all facilities and drive the three views
 *  - Tab switching (Portfolio / Map / Compare)
 *  - Facility text filter
 */

import { login, logout, checkLogin } from './auth.js';
import {
    getUserResources,
    getFacilitiesForGroup,
    getFacilityStats,
    cleanupThumbnailURLs,
} from './api.js';
import { RegionLabelMap } from '../tandem/constants.js';
import { clearFacilityCache, getCachedSummary, setCachedSummary } from './state/facilityCache.js';
import {
    render as renderPortfolio,
    initLoadMore,
    setViewDetailsCallback,
    updateCardStats,
} from './views/portfolioView.js';
import { render as renderMap, invalidateMapSize } from './views/mapView.js';
import { render as renderComparison } from './views/comparisonView.js';
import * as detailsView from './views/detailsView.js';
import * as accessView  from './views/accessView.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginBtn        = document.getElementById('loginBtn');
const logoutBtn       = document.getElementById('logoutBtn');
const userProfileLink = document.getElementById('userProfileLink');
const userProfileImg  = document.getElementById('userProfileImg');
const accountSelect   = document.getElementById('accountSelect');

const welcomeScreen   = document.getElementById('welcomeScreen');
const appContent      = document.getElementById('appContent');
const controlBar      = document.getElementById('controlBar');
const tabBar          = document.getElementById('tabBar');
const loadingOverlay  = document.getElementById('loadingOverlay');

// ── App state ─────────────────────────────────────────────────────────────────
let accounts           = [];          // Array<{ id, name, facilityCount, facilities }>
let userResourcesCache = null;        // raw response from getUserResources('@me')
let facilityRegionMap  = new Map();   // facilityURN → region string
let currentAccountName = null;        // name of the currently selected account
let currentTab         = 'portfolio'; // active tab id

// ── Auth UI ───────────────────────────────────────────────────────────────────
function setLoginState(loggedIn, profileImg) {
    if (loggedIn) {
        loginBtn.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
        welcomeScreen.classList.add('hidden');
        appContent.classList.remove('hidden');
        controlBar.classList.remove('hidden');
        tabBar.classList.remove('hidden');

        if (profileImg) {
            userProfileImg.src = profileImg;
            userProfileLink.classList.remove('hidden');
        }
    } else {
        loginBtn.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
        userProfileLink.classList.add('hidden');
        welcomeScreen.classList.remove('hidden');
        appContent.classList.add('hidden');
        controlBar.classList.add('hidden');
        tabBar.classList.add('hidden');
    }
}

// ── Loading overlay ───────────────────────────────────────────────────────────
function toggleLoading(show) {
    loadingOverlay.classList.toggle('hidden', !show);
}

// ── User resource loading ─────────────────────────────────────────────────────

/**
 * Single API call that retrieves all facilities + groups across all regions.
 * Populates userResourcesCache and facilityRegionMap.
 */
async function loadUserResourcesCache() {
    try {
        userResourcesCache = await getUserResources('@me');

        facilityRegionMap.clear();
        (userResourcesCache?.twins ?? []).forEach(twin => {
            facilityRegionMap.set(twin.urn, twin.region || 'us');
        });
    } catch (err) {
        console.error('Error loading user resources:', err);
        userResourcesCache = { twins: [], groups: [] };
    }
}

/**
 * Builds the accounts array from cached resources.
 * facilities: null means names are lazy-loaded on first dropdown selection.
 */
async function buildAccountsAndFacilities() {
    if (!userResourcesCache) await loadUserResourcesCache();

    const { twins = [], groups = [] } = userResourcesCache;
    const result = [];

    // Map group URN → facility URNs in that group
    const byGroup = new Map();
    const directUrns = [];
    twins.forEach(twin => {
        if (twin.grantedViaGroup) {
            const list = byGroup.get(twin.grantedViaGroup) ?? [];
            list.push(twin.urn);
            byGroup.set(twin.grantedViaGroup, list);
        } else {
            directUrns.push(twin.urn);
        }
    });

    for (const group of groups) {
        result.push({
            id:            group.urn,
            name:          group.name || 'Unnamed Account',
            facilityCount: (byGroup.get(group.urn) ?? []).length,
            facilities:    null, // lazy
        });
    }

    if (directUrns.length > 0) {
        result.push({
            id:            '@me',
            name:          '** SHARED DIRECTLY **',
            facilityCount: directUrns.length,
            facilities:    null,
        });
    }

    return result;
}

// ── Account dropdown ──────────────────────────────────────────────────────────

async function populateAccountsDropdown() {
    accountSelect.innerHTML = '<option value="">Select Account…</option>';

    const sorted = [...accounts].sort((a, b) => {
        if (a.name === '** SHARED DIRECTLY **') return 1;
        if (b.name === '** SHARED DIRECTLY **') return -1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    sorted.forEach(account => {
        const opt = document.createElement('option');
        opt.value = account.name;
        opt.textContent = account.name;
        accountSelect.appendChild(opt);
    });

    // Restore last selection or default to first
    const last = localStorage.getItem('tandem-portfolio-last-account');
    const preferred = (last && sorted.find(a => a.name === last)) ? last : sorted[0]?.name;

    if (preferred) {
        accountSelect.value = preferred;
        accountSelect.querySelector('option[value=""]')?.remove();
        await switchAccount(preferred);
    }

    // Background pre-fetch facility names for all other accounts (fire-and-forget)
    sorted.filter(a => a.name !== preferred).forEach(account => {
        getFacilitiesForGroup(account.id)
            .then(obj => { account.facilities = extractFacilities(obj); })
            .catch(() => { account.facilities = []; });
    });
}

/** Extract facility list from the getFacilitiesForGroup response object. */
function extractFacilities(obj) {
    if (!obj) return [];
    return Object.entries(obj).map(([urn, settings]) => ({
        urn,
        name:   settings?.props?.['Identity Data']?.['Building Name'] || 'Unnamed Facility',
        region: settings?.region || 'us',
        labels: settings?.props?.['Other']?.['tags'] ?? [],
    }));
}

// ── Account switching ─────────────────────────────────────────────────────────

async function switchAccount(accountName) {
    if (accountName === currentAccountName) return;
    currentAccountName = accountName;

    // Clear old data
    clearFacilityCache();
    cleanupThumbnailURLs();

    const account = accounts.find(a => a.name === accountName);
    if (!account) return;

    // Load facility names if not yet cached
    if (!account.facilities) {
        toggleLoading(true);
        try {
            const obj = await getFacilitiesForGroup(account.id);
            account.facilities = extractFacilities(obj);
        } catch (err) {
            console.error('Error loading facilities:', err);
            account.facilities = [];
        }
        toggleLoading(false);
    }

    // Sort alphabetically
    const facilities = [...account.facilities].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    // Drive all views with the new facility list
    renderPortfolio(facilities, facilityRegionMap);
    renderMap(facilities, facilityRegionMap);
    renderComparison(facilities, facilityRegionMap);
    detailsView.renderEmpty();
    accessView.render(facilities, facilityRegionMap);
    _activityPlaceholderShown = false; // reset so placeholder re-renders on next visit
    document.getElementById('activityContent').innerHTML = '';

    // If the user is already on the Access tab, start loading immediately
    if (currentTab === 'access') accessView.activate();

    // Kick off background stat loading (streams + tagged assets per card)
    // Non-blocking: cards show "–" placeholders until each facility resolves
    loadAllFacilityStats(facilities, accountName).catch(err =>
        console.warn('Background stat loading error:', err)
    );
}

/**
 * Open the Details tab for a specific facility URN.
 * Wired to the "View Details →" button on portfolio cards.
 */
function openDetails(urn) {
    const account  = accounts.find(a => a.name === currentAccountName);
    const facility = account?.facilities?.find(f => f.urn === urn);
    if (!facility) return;
    const region = facilityRegionMap.get(urn) ?? facility.region ?? 'us';
    detailsView.render(facility, region);
    switchTab('details');
}

/**
 * Activity tab — placeholder until the feature is implemented.
 * Only renders once per tab visit (idempotent after first paint).
 */
let _activityPlaceholderShown = false;
function showActivityPlaceholder() {
    const el = document.getElementById('activityContent');
    if (!el || _activityPlaceholderShown) return;
    _activityPlaceholderShown = true;

    el.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 text-dark-text-secondary gap-4 max-w-lg mx-auto text-center">
            <svg class="w-12 h-12 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <div>
                <p class="text-sm font-semibold text-dark-text mb-1">Recent Activity — Coming Soon</p>
                <p class="text-xs leading-relaxed">
                    This tab will surface a cross-facility activity feed: who changed what,
                    when, and in which facility — with a summary roll-up and a drill-down
                    into facility-level and model-level history.
                </p>
            </div>
            <div class="mt-2 grid grid-cols-2 gap-3 w-full text-left text-xs">
                <div class="bg-dark-card border border-dark-border rounded p-3">
                    <p class="font-semibold text-dark-text mb-1">📋 Planned: Summary feed</p>
                    <p class="text-dark-text-secondary">Recent ACL changes, model imports, and property edits rolled up across all facilities.</p>
                </div>
                <div class="bg-dark-card border border-dark-border rounded p-3">
                    <p class="font-semibold text-dark-text mb-1">🔍 Planned: Drill-down</p>
                    <p class="text-dark-text-secondary">Click any facility to see its twin history + per-model history, similar to the tandem-sample-stats view.</p>
                </div>
            </div>
        </div>`;
}

/**
 * Load stream count + tagged asset count for every facility in the list.
 * Uses a concurrency window (5 at a time) to avoid hammering the API.
 * Aborts silently if the account changes mid-load.
 *
 * @param {Array<{urn: string}>} facilities
 * @param {string} accountAtStart - snapshot of currentAccountName when loading began
 */
async function loadAllFacilityStats(facilities, accountAtStart) {
    const CONCURRENCY = 5;
    let cursor = 0;

    async function worker() {
        while (cursor < facilities.length) {
            if (currentAccountName !== accountAtStart) return; // account switched — abort
            const f = facilities[cursor++];
            const region = facilityRegionMap.get(f.urn) ?? f.region ?? 'us';
            try {
                const stats = await getFacilityStats(f.urn, region);
                // Merge stats into the summary cache
                const cached = getCachedSummary(f.urn);
                if (cached) setCachedSummary(f.urn, { ...cached, ...stats, statsLoaded: true });
                // Update the card DOM badge (no-op if card isn't rendered yet)
                updateCardStats(f.urn, stats);
            } catch (err) {
                console.warn(`Stats load failed for ${f.name}:`, err);
                updateCardStats(f.urn, { error: true });
            }
        }
    }

    // Launch CONCURRENCY workers simultaneously
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

// ── Tab switching ─────────────────────────────────────────────────────────────

const TABS = ['portfolio', 'map', 'details', 'access', 'compare', 'activity'];

function switchTab(tabId) {
    currentTab = tabId;

    // Update tab button styles
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    // Show/hide view panels
    TABS.forEach(id => {
        document.getElementById(`view-${id}`)?.classList.toggle('hidden', id !== tabId);
    });

    // Leaflet needs a size hint when its container becomes visible
    if (tabId === 'map')      invalidateMapSize();
    // Access graph loads lazily on first visit
    if (tabId === 'access')   accessView.activate();
    // Activity view: show placeholder until implemented
    if (tabId === 'activity') showActivityPlaceholder();
}

// ── Application init ──────────────────────────────────────────────────────────

async function initialize() {
    // Event: login / logout
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);

    // Event: account dropdown
    accountSelect.addEventListener('change', async e => {
        const name = e.target.value;
        if (!name) return;
        localStorage.setItem('tandem-portfolio-last-account', name);
        accountSelect.querySelector('option[value=""]')?.remove();
        await switchAccount(name);
    });

    // Filter events are wired inside portfolioView.js (filter bar is rendered there)

    // Event: tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Event: "View Details →" on portfolio cards
    setViewDetailsCallback(openDetails);

    // Event: load more button + grid click delegation
    initLoadMore();

    // Event: cleanup blob URLs on page unload
    window.addEventListener('beforeunload', cleanupThumbnailURLs);

    // Check auth
    toggleLoading(true);
    const { loggedIn, profileImg } = await checkLogin();

    if (loggedIn) {
        setLoginState(true, profileImg);
        await loadUserResourcesCache();
        accounts = await buildAccountsAndFacilities();

        if (accounts.length > 0) {
            await populateAccountsDropdown();
        } else {
            document.getElementById('portfolioStatus').textContent =
                'No accounts or facilities found. Ensure you have access to at least one Tandem facility.';
        }
    } else {
        setLoginState(false, null);
    }

    toggleLoading(false);
}

// Boot
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}
