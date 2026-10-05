/**
 * Accounts View — cross-account usage leaderboard.
 *
 * Shows all groups the user belongs to, ranked by a chosen metric.
 * Data is fetched once per session (lazy on first tab visit) and cached.
 *
 * Exports:
 *   render(accounts)   — called by app.js after accounts list is known
 *   activate()         — called when the Accounts tab becomes visible
 */

import { getGroupMetrics } from '../api.js';

// ── Icons (reuse same style as portfolioView) ─────────────────────────────────
const ICON_FACILITIES = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
    <polyline stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="9 22 9 12 15 12 15 22"/>
</svg>`;

const ICON_MODELS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
    <polyline stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="3.27 6.96 12 12.01 20.73 6.96"/>
    <line stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="12" y1="22.08" x2="12" y2="12"/>
</svg>`;

const ICON_ELEMENTS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
</svg>`;

const ICON_ASSETS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M7 7h10M7 12h6m-6 5h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/>
</svg>`;

const ICON_STREAMS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12h2l3-7 4 14 3-8 2 1h4"/>
</svg>`;

const ICON_CONNECTIONS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <circle cx="6" cy="6" r="2" stroke-width="2"/>
    <circle cx="18" cy="18" r="2" stroke-width="2"/>
    <circle cx="18" cy="6" r="2" stroke-width="2"/>
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 6h8M6 8v8M18 8v8M8 18h8"/>
</svg>`;

const ICON_STORAGE = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <ellipse cx="12" cy="5" rx="9" ry="3" stroke-width="2"/>
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/>
</svg>`;

// ── State ─────────────────────────────────────────────────────────────────────
let _accounts       = [];   // Array<{ id, name, facilityCount }>
let _metricsCache   = new Map(); // groupId → metrics object
let _loaded         = false;
let _loading        = false;
let _metric         = 'activeFacilityCount'; // current sort metric

const METRICS = [
    { key: 'activeFacilityCount',      label: 'Facilities',   icon: ICON_FACILITIES,   color: '#0696D7', fmt: 'number' },
    { key: 'totalNbOfModel',           label: 'Models',       icon: ICON_MODELS,       color: '#10B981', fmt: 'number' },
    { key: 'numStreams',               label: 'Streams',      icon: ICON_STREAMS,      color: '#EC4899', fmt: 'number' },
    { key: 'totalNbOfAssets',          label: 'Assets',       icon: ICON_ASSETS,       color: '#F59E0B', fmt: 'number' },
    { key: 'numDataConn',              label: 'Connections',  icon: ICON_CONNECTIONS,  color: '#14B8A6', fmt: 'number' },
    { key: 'totalNbOfElement',         label: 'Elements',     icon: ICON_ELEMENTS,     color: '#8B5CF6', fmt: 'number' },
    { key: 'totalBytesUsed',           label: 'Storage',      icon: ICON_STORAGE,      color: '#F97316', fmt: 'bytes'  },
];

const wrap = document.getElementById('accountsContent');

// ── Public API ────────────────────────────────────────────────────────────────

/** Called by app.js whenever the accounts list is refreshed (on login / account load). */
export function render(accounts) {
    _accounts    = accounts.filter(a => a.id !== '@me'); // skip "Shared Directly" — no group URN
    _metricsCache.clear();
    _loaded  = false;
    _loading = false;
    if (wrap) wrap.innerHTML = '';
}

/** Called when the Accounts tab becomes visible. Loads metrics on first visit. */
export async function activate() {
    if (!wrap) return;
    if (_loaded || _loading) {
        renderLeaderboard();
        return;
    }
    _loading = true;
    renderSkeleton();
    await loadAllMetrics();
    _loaded  = true;
    _loading = false;
    renderLeaderboard();
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAllMetrics() {
    const CONCURRENCY = 5;
    let cursor = 0;

    async function worker() {
        while (cursor < _accounts.length) {
            const account = _accounts[cursor++];
            if (_metricsCache.has(account.id)) continue;
            const m = await getGroupMetrics(account.id).catch(() => null);
            _metricsCache.set(account.id, m);  // may be null (error), { _forbidden } or a real metrics obj
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderSkeleton() {
    if (!wrap) return;
    wrap.innerHTML = `
        <div class="space-y-2 animate-pulse">
            ${Array.from({ length: Math.min(_accounts.length || 4, 6) }).map(() => `
            <div class="h-14 rounded bg-dark-card border border-dark-border"></div>`).join('')}
        </div>`;
}

function renderLeaderboard() {
    if (!wrap) return;

    const activeMeta = METRICS.find(m => m.key === _metric) ?? METRICS[0];

    // Build rows
    const rows = _accounts.map(account => {
        const m = _metricsCache.get(account.id) ?? null;
        return { account, metrics: m };
    });

    // Sort: real data desc → forbidden → error/unknown last
    rows.sort((a, b) => {
        const aForbidden = a.metrics?._forbidden;
        const bForbidden = b.metrics?._forbidden;
        if (aForbidden && bForbidden) return 0;
        if (aForbidden) return 1;
        if (bForbidden) return -1;
        const av = a.metrics?.[_metric] ?? -1;
        const bv = b.metrics?.[_metric] ?? -1;
        return bv - av;
    });

    const maxVal = Math.max(1, ...rows.map(r => r.metrics?._forbidden ? 0 : (r.metrics?.[_metric] ?? 0)));

    const btnClass = (key) =>
        `inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded transition ${_metric === key
            ? 'bg-tandem-blue text-white'
            : 'border border-dark-border text-dark-text-secondary hover:text-dark-text bg-dark-bg'}`;

    const extIcon = `<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
    </svg>`;

    wrap.innerHTML = `
        <!-- Sort picker -->
        <div class="flex flex-wrap items-center gap-2 mb-5">
            <span class="text-xs text-dark-text-secondary font-medium">Sort by:</span>
            ${METRICS.map(m => `
            <button data-metric="${m.key}" class="${btnClass(m.key)}">${m.icon} ${m.label}</button>`).join('')}
            <span class="text-xs text-dark-text-secondary ml-2">${rows.length} account${rows.length === 1 ? '' : 's'}</span>
        </div>

        <!-- Metric columns header -->
        <div class="flex items-center gap-3 px-3 pb-1.5 mb-1">
            <span class="w-6 shrink-0"></span>
            <span class="w-52 shrink-0 text-xs text-dark-text-secondary font-medium">Account</span>
            ${METRICS.map(m => `
            <span class="flex-1 text-center text-xs text-dark-text-secondary font-medium
                         ${m.key === _metric ? 'text-dark-text' : ''}">${m.icon} ${m.label}</span>`).join('')}
        </div>

        <!-- Rows -->
        <div class="space-y-1.5">
            ${rows.map((row, i) => {
                const m    = row.metrics;
                const rank = i + 1;
                const pct  = m ? Math.round(((m[_metric] ?? 0) / maxVal) * 100) : 0;

                const isForbidden = !!m?._forbidden;

            return `
                <div class="flex items-center gap-3 px-3 py-3 rounded bg-dark-card border border-dark-border
                            hover:border-tandem-blue transition group ${isForbidden ? 'opacity-60' : ''}">
                    <!-- Rank -->
                    <span class="text-xs font-mono text-dark-text-secondary w-6 text-right shrink-0">
                        ${isForbidden ? '—' : rank}
                    </span>

                    <!-- Account name -->
                    <div class="w-52 shrink-0 min-w-0">
                        <p class="text-xs font-medium text-dark-text truncate"
                           title="${esc(row.account.name)}">${esc(row.account.name)}</p>
                        ${isForbidden ? `<span class="text-xs text-amber-500 flex items-center gap-1 mt-0.5">
                            <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                      d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                            </svg>No access</span>` : ''}
                    </div>

                    <!-- One column per metric -->
                    ${METRICS.map(meta => {
                        const isActive = meta.key === _metric;
                        if (isForbidden) {
                            return `
                            <div class="flex-1 flex flex-col items-center gap-1 min-w-0">
                                <span class="text-xs text-dark-text-secondary italic">—</span>
                                <div class="w-full h-1.5 rounded-full bg-dark-bg overflow-hidden"></div>
                            </div>`;
                        }
                        const val    = m ? (m[meta.key] ?? 0) : null;
                        const valStr = fmtVal(meta, val);
                        const colPct = m && isActive ? pct : 0;
                        return `
                        <div class="flex-1 flex flex-col items-center gap-1 min-w-0">
                            <span class="text-xs font-medium"
                                  style="color:${isActive ? '#e0e0e0' : '#6b7280'}">${valStr}</span>
                            <div class="w-full h-1.5 rounded-full bg-dark-bg overflow-hidden">
                                <div class="h-full rounded-full transition-all duration-500"
                                     style="width:${colPct}%; background:${isActive ? meta.color : 'transparent'}"></div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>`;
            }).join('')}
        </div>`;

    // Wire sort buttons
    wrap.querySelectorAll('[data-metric]').forEach(btn => {
        btn.addEventListener('click', () => {
            _metric = btn.dataset.metric;
            renderLeaderboard();
        });
    });
}

function fmtVal(meta, val) {
    if (val === null || val === undefined) return '…';
    if (meta.fmt === 'bytes') {
        if (val >= 1_073_741_824) return (val / 1_073_741_824).toFixed(1) + ' GB';
        if (val >= 1_048_576)     return (val / 1_048_576).toFixed(1) + ' MB';
        if (val >= 1_024)         return (val / 1_024).toFixed(0) + ' KB';
        return val + ' B';
    }
    return val.toLocaleString();
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
