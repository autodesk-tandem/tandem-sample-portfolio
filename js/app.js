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
    cleanupThumbnailURLs,
} from './api.js';
import { RegionLabelMap } from '../tandem/constants.js';
import { clearFacilityCache } from './state/facilityCache.js';
import { render as renderPortfolio, applyFilter, initLoadMore } from './views/portfolioView.js';
import { render as renderMap } from './views/mapView.js';
import { render as renderComparison } from './views/comparisonView.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const loginBtn        = document.getElementById('loginBtn');
const logoutBtn       = document.getElementById('logoutBtn');
const userProfileLink = document.getElementById('userProfileLink');
const userProfileImg  = document.getElementById('userProfileImg');
const accountSelect   = document.getElementById('accountSelect');
const facilityFilter  = document.getElementById('facilityFilter');
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
}

// ── Tab switching ─────────────────────────────────────────────────────────────

const TABS = ['portfolio', 'map', 'compare'];

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

    // Event: facility filter
    facilityFilter?.addEventListener('input', e => applyFilter(e.target.value));

    // Event: tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Event: load more button
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
