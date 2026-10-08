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
import { getEnv } from './config.js';
import {
    getUserResources,
    getFacilitiesForGroup,
    getFacilityStats,
    getGroupMetrics,
    getInlineTemplate,
    cleanupThumbnailURLs,
} from './api.js';
import { RegionLabelMap } from '../tandem/constants.js';
import { clearFacilityCache, getCachedSummary, setCachedSummary } from './state/facilityCache.js';
import {
    render as renderPortfolio,
    renderAccountBanner,
    initLoadMore,
    setViewDetailsCallback,
    setRetryStatsCallback,
    updateCardStats,
} from './views/portfolioView.js';
import { render as renderMap, invalidateMapSize } from './views/mapView.js';
import { render as renderComparison, updateStats as updateCompareStats } from './views/compareView.js';
import * as accessView    from './views/accessView.js';
import * as activityView  from './views/activityView.js';
import * as ticketsView   from './views/ticketsView.js';
import * as accountsView  from './views/accountsView.js';
import * as chatView     from './views/chatView.js';

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
    accessView.render(facilities, facilityRegionMap);
    activityView.render(facilities, facilityRegionMap);
    ticketsView.render(facilities, facilityRegionMap);
    chatView.render(facilities, facilityRegionMap, currentAccountName, accounts);
    accountsView.render(accounts);

    // Always land on Portfolio when switching accounts — ensures every lazy
    // tab starts fresh and won't show stale data from the previous account.
    switchTab('portfolio');

    // Load account-level metrics banner (fire-and-forget; clears banner on switch)
    renderAccountBanner(null, accountName); // clear stale banner immediately
    if (account.id !== '@me') {
        getGroupMetrics(account.id)
            .then(m => renderAccountBanner(m, accountName))
            .catch(() => renderAccountBanner(null, accountName));
    }

    // Kick off background stat loading (streams + tagged assets per card)
    // Non-blocking: cards show "–" placeholders until each facility resolves
    loadAllFacilityStats(facilities, accountName).catch(err =>
        console.warn('Background stat loading error:', err)
    );
}

/**
 * Open the tandem-sample-stats companion app in a new tab, pre-selecting
 * the current account and the clicked facility.
 *
 * Deeplink mechanism — two complementary approaches:
 *
 * 1. Hash params (works cross-origin, e.g. localhost → github.io):
 *    Stats reads the hash before OAuth fires and saves to sessionStorage,
 *    so account + facility survive the auth redirect.
 *      https://…/tandem-sample-stats/#account=NAME&facility=URN
 *
 * 2. Cookies (bonus, localhost only — same domain across ports):
 *    Also writes one-shot cookies so stats can reuse the session token and
 *    skip re-authentication entirely when both apps are on localhost.
 *
 * Wired to the "Open in Stats" button on portfolio cards.
 */
function openDetails(urn) {
    const statsBase = getEnv().statsAppURL ?? 'http://localhost:8000';

    // Build URL with hash-param deeplink (cross-origin safe)
    const hash = `#account=${encodeURIComponent(currentAccountName)}&facility=${encodeURIComponent(urn)}`;
    const statsURL = statsBase.replace(/#.*$/, '') + hash;

    // Also write cookies for localhost (same domain → no re-auth needed).
    // These are harmless no-ops on cross-origin deployments.
    const cookieOpts = 'path=/; max-age=60; SameSite=Lax';
    document.cookie = `tandem_shared_token=${encodeURIComponent(window.sessionStorage.token ?? '')};${cookieOpts}`;
    document.cookie = `tandem_deeplink_account=${encodeURIComponent(currentAccountName)};${cookieOpts}`;
    document.cookie = `tandem_deeplink_facility=${encodeURIComponent(urn)};${cookieOpts}`;

    window.open(statsURL, '_blank');
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
    const CONCURRENCY      = 5;
    const FACILITY_TIMEOUT = 30_000; // ms — give up on a single facility after 30 s
    let cursor = 0;

    async function worker() {
        while (cursor < facilities.length) {
            if (currentAccountName !== accountAtStart) return; // account switched — abort
            const f = facilities[cursor++];
            const region = facilityRegionMap.get(f.urn) ?? f.region ?? 'us';
            try {
                // Race the stats load against a timeout so a hung request
                // never permanently blocks this worker slot.
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), FACILITY_TIMEOUT)
                );

                // Fetch stats and template in parallel.
                // Template is fetched here (not just in loadFacilityData) so the leaderboard
                // has template names even when cards are never rendered (leaderboard-only mode).
                const cached = getCachedSummary(f.urn);
                const [stats, template] = await Promise.race([
                    Promise.all([
                        getFacilityStats(f.urn, region),
                        cached?.templateName !== undefined
                            ? Promise.resolve(null)   // already in cache — skip duplicate fetch
                            : getInlineTemplate(f.urn, region).catch(() => null),
                    ]),
                    timeoutPromise,
                ]);

                const templateName = template?.name ?? cached?.templateName ?? null;
                // Write template + stats into the cache before calling updateCardStats
                // so updateCardStats finds the correct templateName when it reads the cache.
                const fresh = getCachedSummary(f.urn);
                setCachedSummary(f.urn, {
                    ...(fresh ?? { urn: f.urn, name: f.name, region }),
                    ...stats,
                    templateName,
                    statsLoaded: true,
                });
                updateCardStats(f.urn, stats);
                updateCompareStats(f.urn, stats);
                ticketsView.updateStats();
            } catch (err) {
                const isTimeout = err?.message === 'timeout';
                console.warn(`Stats load ${isTimeout ? 'timed out' : 'failed'} for ${f.name}:`, err);
                updateCardStats(f.urn, { error: true, timedOut: isTimeout });
                updateCompareStats(f.urn, { error: true });
                ticketsView.updateStats();
            }
        }
    }

    // Launch CONCURRENCY workers simultaneously
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

// ── Tab switching ─────────────────────────────────────────────────────────────

const TABS = ['portfolio', 'map', 'access', 'compare', 'activity', 'tickets', 'accounts', 'chat'];

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
    if (tabId === 'activity') activityView.activate();
    if (tabId === 'tickets')  ticketsView.activate();
    if (tabId === 'chat')     chatView.activate();
    if (tabId === 'accounts') accountsView.activate();
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

    // Event: Activity drill-down "Open in Stats" punch-out
    activityView.setOpenStatsCallback(openDetails);

    // Event: "Retry" on cards that timed out or failed to load stats
    const retryStats = urn => {
        const facility = (accounts.find(a => a.name === currentAccountName)?.facilities ?? [])
            .find(f => f.urn === urn);
        if (!facility) return;
        loadAllFacilityStats([facility], currentAccountName).catch(() => {});
    };
    setRetryStatsCallback(retryStats);
    ticketsView.setRetryCallback(retryStats);

    // Event: load more button + grid click delegation
    initLoadMore();

    // Event: cleanup blob URLs on page unload
    window.addEventListener('beforeunload', cleanupThumbnailURLs);

    // Check auth
    toggleLoading(true);
    const { loggedIn, profileImg, currentUserId } = await checkLogin();
    // Share the logged-in user's identity with the access view so their photo renders on their node
    if (currentUserId && profileImg) accessView.setCurrentUser(currentUserId, profileImg);

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
