/**
 * Activity View — cross-facility recent-activity feed.
 *
 * Summary: One row per facility sorted by most-recently-active.
 *   Each row shows:
 *     • Status dot  (🟢 active < 7d, 🟡 quiet 7–30d, ⚫ idle > 30d)
 *     • Last-activity timestamp + operation type
 *     • Stream health chip (online / warning / offline counts)
 *     • [Details →] button that opens a right-side drill-down panel
 *
 * Drill-down panel:
 *     • Twin history (already loaded in summary pass)
 *     • Stream health list (already loaded in summary pass)
 *     • Model history (loaded on demand — one call per model)
 *
 * Requires: api.js exports getTwinHistory, getStreams,
 *           getLastSeenStreamValues, getModels, getHistory
 */

const ICON_STREAMS = `<svg class="w-3 h-3 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12h2l3-7 4 14 3-8 2 1h4"/></svg>`;

import {
    getTwinHistory,
    getStreams,
    getLastSeenStreamValues,
    getModels,
    getHistory,
} from '../api.js';
import { HC, QC } from '../../tandem/constants.js';
import { toShortKey } from '../../tandem/keys.js';

// ── Stream health thresholds ────────────────────────────────────────────────────
const ONLINE_MS  = 24 * 60 * 60 * 1000;        // < 24 h  → online
const WARNING_MS = 7  * 24 * 60 * 60 * 1000;   // < 7 d   → warning
// > 7 d → offline

// ── Activity status thresholds ─────────────────────────────────────────────────
const ACTIVE_MS =  7 * 24 * 60 * 60 * 1000;    // < 7 d   → active
const QUIET_MS  = 30 * 24 * 60 * 60 * 1000;    // < 30 d  → quiet
// > 30 d → idle

const HISTORY_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000; // load last 90 days of twin history
const CONCURRENCY = 5;
const MAX_FACILITIES = 300;

// ── Module state ───────────────────────────────────────────────────────────────
let _facilities    = [];
let _regionMap     = null;
let _loaded        = false;
let _loading       = false;
let _abortFlag     = false;
let _results       = [];           // FacilitySummary[] — one per facility
let _sortKey       = 'activity';   // 'activity' | 'offline'
let _openFacility  = null;         // URN of the currently-open drill-down panel

// ── Public API ─────────────────────────────────────────────────────────────────

export function render(facilities, regionMap) {
    _facilities   = facilities.slice(0, MAX_FACILITIES);
    _regionMap    = regionMap;
    _loaded       = false;
    _loading      = false;
    _abortFlag    = true;
    _results      = [];
    _openFacility = null;

    const wrap = document.getElementById('activityContent');
    if (wrap) showPlaceholder(wrap, facilities.length);
}

export function activate() {
    if (_loaded || _loading) return;
    startLoading();
}

// ── Data loading ───────────────────────────────────────────────────────────────

async function startLoading() {
    _loading   = true;
    _abortFlag = false;

    const wrap = document.getElementById('activityContent');
    if (!wrap) return;

    showProgress(wrap, 0, _facilities.length);

    let done = 0, cursor = 0;

    async function worker() {
        while (cursor < _facilities.length) {
            if (_abortFlag) return;
            const f      = _facilities[cursor++];
            const region = _regionMap?.get(f.urn) ?? f.region ?? 'us';
            const summary = await loadFacilitySummary(f, region);
            if (!_abortFlag) {
                _results.push(summary);
                done++;
                updateProgress(done, _facilities.length);
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    if (_abortFlag) return;

    _loading = false;
    _loaded  = true;
    renderSummary(wrap);
}

/**
 * Load the summary data for a single facility.
 * Runs twin-history and stream checks in parallel.
 */
async function loadFacilitySummary(facility, region) {
    const minTs = Date.now() - HISTORY_LOOKBACK_MS;

    // System-generated events that have no meaningful user impact
    const IGNORED_OPS = new Set(['metrics_update']);

    const [rawHistoryEntries, streams] = await Promise.all([
        getTwinHistory(facility.urn, region, { min: minTs, max: Date.now(), includeChanges: true }).catch(() => []),
        getStreams(facility.urn, region).catch(() => []),
    ]);

    const historyEntries = rawHistoryEntries.filter(e => !IGNORED_OPS.has(e[HC.Operation]));

    // ── Twin history summary ──────────────────────────────────────────────────
    const sortedHistory = [...historyEntries].sort(
        (a, b) => (b[HC.Timestamp] || 0) - (a[HC.Timestamp] || 0)
    );
    const latestEntry   = sortedHistory[0] ?? null;
    const lastActivityTs = latestEntry?.[HC.Timestamp] ?? null;
    const lastActivityOp = latestEntry?.[HC.Operation]  ?? null;
    const lastActivityActor = latestEntry?.[HC.Username] ?? latestEntry?.clientId ?? null;

    // ── Stream health ──────────────────────────────────────────────────────────
    let streamHealth = { total: 0, online: 0, warning: 0, offline: 0, details: [] };

    if (streams.length > 0) {
        const streamKeys = streams.map(s => s[QC.Key]).filter(Boolean);
        const lastSeen   = streamKeys.length
            ? await getLastSeenStreamValues(facility.urn, region, streamKeys, false).catch(() => ({}))
            : {};

        // API returns long keys → convert to short for matching
        const shortKeyMap = {};
        for (const [longKey, val] of Object.entries(lastSeen)) {
            shortKeyMap[toShortKey(longKey)] = val;
        }

        const now = Date.now();
        streamHealth.total = streams.length;

        for (const stream of streams) {
            const key    = stream[QC.Key];
            const name   = stream[QC.OName]?.[0] ?? stream[QC.Name]?.[0] ?? 'Unnamed Stream';
            const entry  = shortKeyMap[key];
            const lastTs = entry?.t ?? null;        // timestamp in ms
            const age    = lastTs ? now - lastTs : Infinity;

            let status;
            if (age < ONLINE_MS)       status = 'online';
            else if (age < WARNING_MS) status = 'warning';
            else                       status = 'offline';

            streamHealth[status]++;
            streamHealth.details.push({ key, name, lastTs, status });
        }
    }

    return {
        urn:    facility.urn,
        name:   facility.name,
        region,
        lastActivityTs,
        lastActivityOp,
        lastActivityActor,
        historyEntries: sortedHistory,
        streamHealth,
    };
}

// ── Progress UI ─────────────────────────────────────────────────────────────────

function showPlaceholder(wrap, count) {
    wrap.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 text-dark-text-secondary">
            <svg class="w-12 h-12 mb-4 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <p class="text-sm font-medium text-dark-text mb-1">Recent Activity</p>
            <p class="text-xs text-center max-w-xs">
                Switch to this tab to scan recent activity across
                ${count} facilit${count !== 1 ? 'ies' : 'y'}.
            </p>
        </div>`;
}

function showProgress(wrap, done, total) {
    wrap.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 gap-4">
            <p class="text-sm font-medium text-dark-text">Scanning activity…</p>
            <div class="w-72">
                <div class="flex justify-between text-xs text-dark-text-secondary mb-1.5">
                    <span id="act-label">Starting…</span>
                    <span id="act-pct">0%</span>
                </div>
                <div class="w-full bg-dark-bg rounded-full h-1.5 overflow-hidden border border-dark-border">
                    <div id="act-bar" class="h-full rounded-full transition-all duration-200"
                         style="width:0%;background:#0696D7"></div>
                </div>
            </div>
        </div>`;
}

function updateProgress(done, total) {
    const pct   = Math.round((done / total) * 100);
    const bar   = document.getElementById('act-bar');
    const pctEl = document.getElementById('act-pct');
    const label = document.getElementById('act-label');
    if (bar)   bar.style.width    = `${pct}%`;
    if (pctEl) pctEl.textContent  = `${pct}%`;
    if (label) label.textContent  = `${done} / ${total} facilities`;
}

// ── Summary rendering ──────────────────────────────────────────────────────────

function renderSummary(wrap) {
    const sorted = sortResults(_results, _sortKey);

    const now = Date.now();
    const activeCount  = sorted.filter(r => r.lastActivityTs && now - r.lastActivityTs < ACTIVE_MS).length;
    const quietCount   = sorted.filter(r => r.lastActivityTs && now - r.lastActivityTs >= ACTIVE_MS && now - r.lastActivityTs < QUIET_MS).length;
    const idleCount    = sorted.filter(r => !r.lastActivityTs || now - r.lastActivityTs >= QUIET_MS).length;
    const offlineTotal = sorted.reduce((s, r) => s + r.streamHealth.offline, 0);
    const warningTotal = sorted.reduce((s, r) => s + r.streamHealth.warning, 0);

    wrap.innerHTML = `
        <div class="flex gap-0" style="height:calc(100vh - 190px);min-height:500px">

            <!-- ── Left: list ── -->
            <div class="flex flex-col flex-1 min-w-0">

                <!-- Banner -->
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 border-b border-dark-border text-xs text-dark-text-secondary bg-dark-card shrink-0">
                    <span>🟢 <b class="text-dark-text">${activeCount}</b> active this week</span>
                    <span>🟡 <b class="text-dark-text">${quietCount}</b> quiet</span>
                    <span>⚫ <b class="text-dark-text">${idleCount}</b> idle</span>
                    ${offlineTotal ? `<span class="text-red-400">⚠ <b>${offlineTotal}</b> stream${offlineTotal !== 1 ? 's' : ''} offline</span>` : ''}
                    ${warningTotal ? `<span class="text-amber-400">⚠ <b>${warningTotal}</b> stream${warningTotal !== 1 ? 's' : ''} silent 1–7 days</span>` : ''}

                    <!-- Sort controls (right-aligned) -->
                    <div class="ml-auto flex items-center gap-1">
                        <span class="opacity-60">Sort:</span>
                        <button class="sort-btn px-2 py-0.5 rounded text-xs border ${_sortKey === 'activity' ? 'border-tandem-blue text-tandem-blue' : 'border-dark-border text-dark-text-secondary hover:border-dark-text'}"
                                data-sort="activity">Most Recent</button>
                        <button class="sort-btn px-2 py-0.5 rounded text-xs border ${_sortKey === 'offline' ? 'border-red-400 text-red-400' : 'border-dark-border text-dark-text-secondary hover:border-dark-text'}"
                                data-sort="offline">Most Offline</button>
                    </div>
                </div>

                <!-- Facility list -->
                <div id="activity-list" class="flex-1 overflow-y-auto divide-y divide-dark-border">
                    ${sorted.map(r => facilityRow(r)).join('')}
                </div>
            </div>

            <!-- ── Right: drill-down panel ── -->
            <div id="activity-panel" class="w-80 shrink-0 border-l border-dark-border bg-dark-card overflow-y-auto">
                <div class="p-5 flex flex-col items-center justify-center h-full text-center text-dark-text-secondary">
                    <svg class="w-8 h-8 mb-3 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                    </svg>
                    <p class="text-xs">Click a facility to see its history and stream health</p>
                </div>
            </div>

        </div>`;

    // ── Events ─────────────────────────────────────────────────────────────────
    wrap.querySelectorAll('.sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _sortKey = btn.dataset.sort;
            renderSummary(wrap);
        });
    });

    wrap.querySelectorAll('[data-details-urn]').forEach(btn => {
        btn.addEventListener('click', () => {
            const urn = btn.dataset.detailsUrn;
            const result = _results.find(r => r.urn === urn);
            if (result) openDrillDown(result);
        });
    });

    // Re-open drill-down if one was open before re-render
    if (_openFacility) {
        const result = _results.find(r => r.urn === _openFacility);
        if (result) openDrillDown(result);
    }
}

function sortResults(results, key) {
    if (key === 'offline') {
        return [...results].sort((a, b) =>
            (b.streamHealth.offline + b.streamHealth.warning) -
            (a.streamHealth.offline + a.streamHealth.warning) ||
            (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0)
        );
    }
    // Default: most recently active first; null timestamps go to bottom
    return [...results].sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));
}

function facilityRow(r) {
    const now = Date.now();
    const age = r.lastActivityTs ? now - r.lastActivityTs : null;

    // Status dot
    let dotColor, dotTitle;
    if (!age || age >= QUIET_MS)      { dotColor = '#6B7280'; dotTitle = 'Idle'; }
    else if (age >= ACTIVE_MS)        { dotColor = '#F59E0B'; dotTitle = 'Quiet'; }
    else                              { dotColor = '#10B981'; dotTitle = 'Active'; }

    // Last activity label
    const actLabel = r.lastActivityTs
        ? `${timeAgo(r.lastActivityTs)}${r.lastActivityOp ? ' · ' + formatOp(r.lastActivityOp) : ''}`
        : 'No recent history';

    // Stream health chips
    const sh = r.streamHealth;
    const streamChip = sh.total === 0
        ? `<span class="text-dark-text-secondary opacity-50 text-xs">No streams</span>`
        : buildStreamChip(sh);

    return `
        <div class="flex items-center gap-3 px-4 py-3 hover:bg-dark-bg transition cursor-pointer group"
             data-details-urn="${esc(r.urn)}">
            <!-- Status dot -->
            <div class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${dotColor}" title="${dotTitle}"></div>

            <!-- Name + last activity -->
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-dark-text truncate">${esc(r.name)}</p>
                <p class="text-xs text-dark-text-secondary mt-0.5">${actLabel}</p>
            </div>

            <!-- Stream health -->
            <div class="flex items-center gap-1.5 shrink-0 text-xs">
                ${streamChip}
            </div>

            <!-- Details chevron -->
            <svg class="w-4 h-4 shrink-0 text-dark-text-secondary opacity-0 group-hover:opacity-100 transition"
                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
        </div>`;
}

function buildStreamChip(sh) {
    const parts = [];
    const total = sh.total;

    if (sh.offline > 0) {
        parts.push(`<span class="px-1.5 py-0.5 rounded text-xs font-medium" style="background:#7f1d1d22;color:#f87171;border:1px solid #7f1d1d66">
            ${ICON_STREAMS} ${sh.offline} offline
        </span>`);
    }
    if (sh.warning > 0) {
        parts.push(`<span class="px-1.5 py-0.5 rounded text-xs font-medium" style="background:#78350f22;color:#fbbf24;border:1px solid #78350f66">
            ${sh.warning} silent
        </span>`);
    }
    if (sh.offline === 0 && sh.warning === 0 && sh.total > 0) {
        parts.push(`<span class="px-1.5 py-0.5 rounded text-xs" style="background:#06432022;color:#34d399;border:1px solid #06432066">
            ${ICON_STREAMS} ${sh.online}/${total} active
        </span>`);
    } else if (sh.online > 0) {
        parts.push(`<span class="text-xs text-dark-text-secondary opacity-60">${ICON_STREAMS} ${sh.online} ok</span>`);
    }

    return parts.join('');
}

// ── Drill-down panel ───────────────────────────────────────────────────────────

function openDrillDown(result) {
    _openFacility = result.urn;
    const panel = document.getElementById('activity-panel');
    if (!panel) return;

    // Highlight selected row
    document.querySelectorAll('[data-details-urn]').forEach(el => {
        el.classList.toggle('bg-dark-bg', el.dataset.detailsUrn === result.urn);
    });

    panel.innerHTML = `
        <div class="p-4 space-y-4">
            <!-- Header -->
            <div class="border-b border-dark-border pb-3">
                <p class="text-sm font-semibold text-dark-text">${esc(result.name)}</p>
                <p class="text-xs text-dark-text-secondary">${result.region.toUpperCase()}</p>
            </div>

            <!-- Twin history section -->
            <div>
                <p class="text-xs font-semibold text-dark-text uppercase tracking-wide mb-2">Facility History</p>
                ${buildHistoryList(result.historyEntries)}
            </div>

            <!-- Stream health section -->
            ${result.streamHealth.total > 0 ? `
            <div>
                <p class="text-xs font-semibold text-dark-text uppercase tracking-wide mb-2">
                    Stream Health
                    <span class="ml-1 font-normal text-dark-text-secondary normal-case tracking-normal">(${result.streamHealth.total} total)</span>
                </p>
                ${buildStreamList(result.streamHealth.details)}
            </div>` : ''}

            <!-- Model history section (load on demand) -->
            <div>
                <p class="text-xs font-semibold text-dark-text uppercase tracking-wide mb-2">Model History</p>
                <div id="model-history-content">
                    <button id="load-model-history-btn"
                            class="text-xs text-tandem-blue hover:underline"
                            data-urn="${esc(result.urn)}" data-region="${esc(result.region)}">
                        Load model history…
                    </button>
                </div>
            </div>
        </div>`;

    // Wire load-model-history button
    document.getElementById('load-model-history-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.textContent = 'Loading…';
        btn.disabled    = true;
        await loadAndRenderModelHistory(result.urn, result.region);
    });
}

function buildHistoryList(entries) {
    if (!entries.length) {
        return `<p class="text-xs text-dark-text-secondary italic">No history in the last 90 days</p>`;
    }
    const items = entries.slice(0, 20).map(e => {
        const ts    = e[HC.Timestamp];
        const op    = e[HC.Operation]  ?? '—';
        const actor = e[HC.Username]   ?? 'unknown';
        return `
            <div class="flex items-start gap-2 py-1.5 border-b border-dark-border last:border-0">
                <span class="text-xs font-mono rounded px-1 shrink-0 mt-0.5"
                      style="${opBadgeStyle(op)}">${formatOp(op)}</span>
                <div class="min-w-0 flex-1">
                    <p class="text-xs text-dark-text truncate">${esc(actor)}</p>
                    <p class="text-xs text-dark-text-secondary">${ts ? timeAgo(ts) : '—'}</p>
                </div>
            </div>`;
    }).join('');

    const more = entries.length > 20
        ? `<p class="text-xs text-dark-text-secondary opacity-60 pt-1">+ ${entries.length - 20} older entries</p>` : '';

    return `<div class="space-y-0">${items}${more}</div>`;
}

function buildStreamList(streams) {
    if (!streams.length) return '';
    const sorted = [...streams].sort((a, b) => {
        const order = { offline: 0, warning: 1, online: 2 };
        return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

    return `<div class="space-y-0 max-h-60 overflow-y-auto">
        ${sorted.map(s => {
            const color  = s.status === 'offline' ? '#f87171'
                         : s.status === 'warning'  ? '#fbbf24' : '#34d399';
            const label  = s.status === 'online'
                ? `Last: ${s.lastTs ? timeAgo(s.lastTs) : 'unknown'}`
                : s.status === 'warning' ? `Silent ${s.lastTs ? timeAgo(s.lastTs) : ''}` : `Offline${s.lastTs ? ' · last ' + timeAgo(s.lastTs) : ''}`;
            return `
                <div class="flex items-center gap-2 py-1.5 border-b border-dark-border last:border-0">
                    <div class="w-2 h-2 rounded-full shrink-0" style="background:${color}"></div>
                    <span class="text-xs text-dark-text flex-1 truncate">${esc(s.name)}</span>
                    <span class="text-xs shrink-0" style="color:${color}">${label}</span>
                </div>`;
        }).join('')}
    </div>`;
}

async function loadAndRenderModelHistory(facilityURN, region) {
    const container = document.getElementById('model-history-content');
    if (!container) return;

    try {
        const models = await getModels(facilityURN, region);
        if (!models?.length) {
            container.innerHTML = `<p class="text-xs text-dark-text-secondary italic">No models found</p>`;
            return;
        }

        const minTs = Date.now() - HISTORY_LOOKBACK_MS;
        const IGNORED_OPS = new Set(['metrics_update']);
        const modelHistories = await Promise.all(
            models.map(async m => {
                const h = await getHistory(m.modelId, region, { min: minTs, max: Date.now(), includeChanges: true, limit: 30 }).catch(() => []);
                const filtered = h.filter(e => !IGNORED_OPS.has(e[HC.Operation]));
                return { name: m.label || 'Untitled', entries: filtered };
            })
        );

        const withHistory = modelHistories.filter(m => m.entries.length > 0);
        if (!withHistory.length) {
            container.innerHTML = `<p class="text-xs text-dark-text-secondary italic">No model changes in the last 90 days</p>`;
            return;
        }

        container.innerHTML = withHistory.map(m => `
            <details class="mb-2">
                <summary class="text-xs font-medium text-dark-text cursor-pointer hover:text-tandem-blue">
                    ${esc(m.name)} <span class="font-normal text-dark-text-secondary">(${m.entries.length} changes)</span>
                </summary>
                <div class="ml-2 mt-1">${buildHistoryList(m.entries)}</div>
            </details>`
        ).join('');
    } catch (err) {
        container.innerHTML = `<p class="text-xs text-red-400">Error loading model history</p>`;
        console.error('Error loading model history:', err);
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function timeAgo(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1)   return 'just now';
    if (m < 60)  return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30)  return `${d}d ago`;
    const mo = Math.floor(d / 30);
    return `${mo}mo ago`;
}

function formatOp(op) {
    const map = {
        'create':          'Created',
        'delete':          'Deleted',
        'add_user':        'User added',
        'remove_user':     'User removed',
        'update_user':     'Access changed',
        'import':          'Model imported',
        'mutate':          'Properties changed',
        'update_settings': 'Settings updated',
        'update_template': 'Template updated',
    };
    return map[op] ?? op;
}

function opBadgeStyle(op) {
    if (op.includes('user'))   return 'background:#0696D722;color:#60a5fa;border:1px solid #0696D744';
    if (op === 'mutate')       return 'background:#10B98122;color:#34d399;border:1px solid #10B98144';
    if (op === 'import')       return 'background:#8B5CF622;color:#c084fc;border:1px solid #8B5CF644';
    if (op === 'delete')       return 'background:#ef444422;color:#f87171;border:1px solid #ef444444';
    return 'background:#37415122;color:#9ca3af;border:1px solid #37415144';
}

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
