/**
 * Comparison View — side-by-side facility comparison + portfolio outlier detection.
 *
 * Public API:
 *   render(facilities, regionMap)  — called by app.js on account switch
 *   updateStats(urn, stats)        — called by app.js as per-facility stats arrive
 */

import { getCachedSummary } from '../state/facilityCache.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_SELECTED     = 6;
const OUTLIER_SIGMA    = 1.5; // standard deviations to flag as outlier
const REGION_LABELS    = { us: 'USA', emea: 'EMEA', aus: 'AUS' };
const PILL_COLORS      = ['#0696D7', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#F97316'];

// ── Icons ─────────────────────────────────────────────────────────────────────
const ICON_MODELS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
    <polyline stroke-linecap="round" stroke-linejoin="round" stroke-width="2" points="3.27 6.96 12 12.01 20.73 6.96"/>
    <line stroke-linecap="round" stroke-linejoin="round" stroke-width="2" x1="12" y1="22.08" x2="12" y2="12"/>
</svg>`;
const ICON_STREAMS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12h2l3-7 4 14 3-8 2 1h4"/>
</svg>`;
const ICON_ASSETS = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M7 7h10M7 12h6m-6 5h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/>
</svg>`;

const ICON_TICKET = `<svg class="w-3.5 h-3.5 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/>
</svg>`;

// ── State ─────────────────────────────────────────────────────────────────────
let _facilities = [];           // full list for the account
let _regionMap  = new Map();    // urn → region string
let _statsMap   = new Map();    // urn → { streamCount, taggedAssetCount } | { error: true } | undefined (loading)
let _selected   = [];           // ordered array of selected URNs
let _chartMode  = 'radar';      // 'radar' | 'bars'
let _charts     = [];           // live Chart.js instances (destroyed on every redraw)
let _chartTimer = null;         // debounce: stats arrive one facility at a time

// ── DOM ───────────────────────────────────────────────────────────────────────
const wrap = document.getElementById('compareContent');

// ── Public API ────────────────────────────────────────────────────────────────

export function render(facilities, regionMap) {
    _facilities = [...facilities];
    _regionMap  = regionMap;
    _statsMap   = new Map();
    _selected   = _facilities.slice(0, Math.min(4, _facilities.length)).map(f => f.urn);
    clearTimeout(_chartTimer);
    destroyCharts();
    if (wrap) renderShell();
}

export function updateStats(urn, stats) {
    _statsMap.set(urn, stats);
    // Only re-paint if the compare tab has been rendered
    if (document.getElementById('cmp-table-wrap')) {
        refreshTable();
        refreshOutliers();
    }
}

// ── Shell (one-time structure) ─────────────────────────────────────────────────

function renderShell() {
    wrap.innerHTML = `
        <!-- Header -->
        <div class="mb-6">
            <h2 class="text-base font-semibold text-dark-text mb-1">Side-by-Side Comparison</h2>
            <p class="text-xs text-dark-text-secondary mb-4">
                Select up to ${MAX_SELECTED} facilities to compare their key metrics.
                Outliers are highlighted automatically.
            </p>

            <!-- Selected facility pills -->
            <div id="cmp-pills" class="flex flex-wrap gap-2 mb-3 min-h-[32px]"></div>

            <!-- Add-facility search -->
            <div class="relative" style="width:280px">
                <input id="cmp-search" type="text" autocomplete="off"
                    placeholder="Add facility…"
                    class="w-full px-3 py-1.5 text-xs rounded border border-dark-border bg-dark-bg
                           text-dark-text focus:outline-none focus:border-tandem-blue
                           placeholder-dark-text-secondary"/>
                <div id="cmp-dropdown"
                     class="hidden absolute z-30 mt-1 w-full rounded border border-dark-border
                            bg-dark-card shadow-xl max-h-56 overflow-y-auto"></div>
            </div>
        </div>

        <!-- Comparison table (scrollable horizontally) -->
        <div id="cmp-table-wrap" class="mb-10 overflow-x-auto"></div>

        <!-- Visual comparison (radar / bars) -->
        <div id="cmp-charts-wrap" class="mb-10"></div>

        <!-- Outlier detection panel -->
        <div id="cmp-outliers-wrap"></div>
    `;

    wireSelector();
    refreshPills();
    refreshTable();
    refreshOutliers();
}

// ── Selector ──────────────────────────────────────────────────────────────────

function wireSelector() {
    const input    = wrap.querySelector('#cmp-search');
    const dropdown = wrap.querySelector('#cmp-dropdown');
    if (!input || !dropdown) return;

    input.addEventListener('focus', () => renderDropdown(input.value));
    input.addEventListener('input', () => renderDropdown(input.value));

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#cmp-search') && !e.target.closest('#cmp-dropdown')) {
            dropdown.classList.add('hidden');
        }
    }, { capture: true });
}

function renderDropdown(search) {
    const dropdown = document.getElementById('cmp-dropdown');
    if (!dropdown) return;

    const term = search.toLowerCase().trim();
    const selSet = new Set(_selected);

    if (_selected.length >= MAX_SELECTED) {
        dropdown.innerHTML = `<div class="px-3 py-2 text-xs text-dark-text-secondary italic">Max ${MAX_SELECTED} facilities selected</div>`;
        dropdown.classList.remove('hidden');
        return;
    }

    const available = _facilities
        .filter(f => !selSet.has(f.urn) && f.name.toLowerCase().includes(term))
        .slice(0, 30);

    if (available.length === 0) {
        dropdown.innerHTML = `<div class="px-3 py-2 text-xs text-dark-text-secondary italic">No matching facilities</div>`;
        dropdown.classList.remove('hidden');
        return;
    }

    dropdown.innerHTML = available.map(f => `
        <button data-urn="${f.urn}"
            class="w-full text-left px-3 py-2 text-xs text-dark-text hover:bg-tandem-blue/20 truncate transition">
            ${esc(f.name)}
        </button>`).join('');
    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('[data-urn]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!_selected.includes(btn.dataset.urn)) {
                _selected.push(btn.dataset.urn);
            }
            document.getElementById('cmp-search').value = '';
            document.getElementById('cmp-dropdown').classList.add('hidden');
            refreshPills();
            refreshTable();
        });
    });
}

function refreshPills() {
    const pillsEl = document.getElementById('cmp-pills');
    if (!pillsEl) return;

    if (_selected.length === 0) {
        pillsEl.innerHTML = `<span class="text-xs text-dark-text-secondary italic">No facilities selected</span>`;
        return;
    }

    pillsEl.innerHTML = _selected.map((urn, i) => {
        const name  = getCachedSummary(urn)?.name ?? _facilities.find(f => f.urn === urn)?.name ?? urn;
        const color = PILL_COLORS[i % PILL_COLORS.length];
        return `
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
                  style="border-color:${color}50; background:${color}18; color:${color}">
                ${esc(name)}
                <button data-urn="${urn}" class="opacity-50 hover:opacity-100 transition" title="Remove">✕</button>
            </span>`;
    }).join('');

    pillsEl.querySelectorAll('[data-urn]').forEach(btn => {
        btn.addEventListener('click', () => {
            _selected = _selected.filter(u => u !== btn.dataset.urn);
            refreshPills();
            refreshTable();
        });
    });
}

// ── Comparison table ──────────────────────────────────────────────────────────

/** Numeric metrics shown as rows in the table (with outlier highlighting). */
const NUMERIC_METRICS = [
    { key: 'modelCount',   label: 'Models',        icon: ICON_MODELS,   color: '#10B981' },
    { key: 'streamCount',  label: 'Streams',        icon: ICON_STREAMS,  color: '#EC4899' },
    { key: 'taggedAssets', label: 'Tagged Assets',  icon: ICON_ASSETS,   color: '#F59E0B' },
    { key: 'openTickets',  label: 'Open Tickets',   icon: ICON_TICKET,   color: '#FB923C' },
];

/** Text / categorical metrics (no outlier logic). */
const TEXT_METRICS = [
    { key: 'template', label: 'Template' },
    { key: 'region',   label: 'Region'   },
];

function getRowData(urn) {
    const cache = getCachedSummary(urn);
    const stats = _statsMap.get(urn);      // undefined = still loading
    const f     = _facilities.find(x => x.urn === urn);
    return {
        urn,
        name:        cache?.name ?? f?.name ?? '—',
        region:      REGION_LABELS[_regionMap.get(urn)] ?? _regionMap.get(urn) ?? '—',
        template:    cache?.template?.name ?? '—',
        modelCount:  cache?.modelCount ?? null,
        streamCount: stats?.streamCount     ?? null,
        taggedAssets:stats?.taggedAssetCount ?? null,
        // A failed ticket fetch is unknown, not zero
        openTickets: stats?.ticketsError ? null : (stats?.openTicketCount ?? null),
        loading:     stats === undefined,
        error:       !!stats?.error,
    };
}

function refreshTable() {
    const tableWrap = document.getElementById('cmp-table-wrap');
    if (!tableWrap) return;

    scheduleCharts();

    if (_selected.length === 0) {
        tableWrap.innerHTML = `
            <div class="py-12 text-center text-xs text-dark-text-secondary italic">
                No facilities selected — use the search above to add some.
            </div>`;
        return;
    }

    const rows       = _selected.map(urn => getRowData(urn));
    const thresholds = computeThresholds();
    const COL_W      = Math.max(140, Math.floor(560 / rows.length));

    tableWrap.innerHTML = `
        <table class="text-xs border-collapse" style="min-width:${rows.length * COL_W + 160}px; width:100%">
            <thead>
                <tr>
                    <th class="text-left px-3 py-2.5 text-dark-text-secondary font-medium
                                w-36 border-b border-dark-border">Metric</th>
                    ${rows.map((r, i) => `
                    <th class="px-3 py-2.5 text-center border-b border-dark-border" style="width:${COL_W}px">
                        <span class="block font-semibold truncate max-w-full"
                              style="color:${PILL_COLORS[i % PILL_COLORS.length]}"
                              title="${esc(r.name)}">${esc(r.name)}</span>
                        <span class="block text-dark-text-secondary font-normal text-xs">${r.region}</span>
                    </th>`).join('')}
                </tr>
            </thead>
            <tbody>
                ${NUMERIC_METRICS.map(m => `
                <tr class="hover:bg-dark-card/40 transition">
                    <td class="px-3 py-2.5 border-b border-dark-border/50 text-dark-text-secondary
                                font-medium whitespace-nowrap">
                        ${m.icon} ${m.label}
                    </td>
                    ${rows.map(r => numericCell(r, m, thresholds[m.key])).join('')}
                </tr>`).join('')}

                ${TEXT_METRICS.map(m => `
                <tr class="hover:bg-dark-card/40 transition">
                    <td class="px-3 py-2.5 border-b border-dark-border/50 text-dark-text-secondary font-medium">${m.label}</td>
                    ${rows.map(r => `
                    <td class="px-3 py-2.5 text-center border-b border-dark-border/50 text-dark-text">
                        ${esc(r[m.key])}
                    </td>`).join('')}
                </tr>`).join('')}
            </tbody>
        </table>
        <p class="mt-2 text-xs text-dark-text-secondary">
            <span class="text-red-400 font-semibold">▲ high</span>
            &nbsp;/&nbsp;
            <span class="text-amber-400 font-semibold">▼ low</span>
            &nbsp;— significantly outside account average (±${OUTLIER_SIGMA}σ)
        </p>`;
}

function numericCell(r, m, threshold) {
    const val     = r[m.key];
    const loading = val === null && !r.error && r.loading;

    let content, style;

    if (r.error || (val === null && !loading)) {
        content = '—';
        style   = 'color:#6b7280';
    } else if (loading) {
        content = spinnerSVG();
        style   = '';
    } else {
        const outlier = threshold ? getOutlierDir(val, threshold) : null;
        if (outlier === 'high') {
            content = `${val.toLocaleString()} <span class="text-red-400 font-bold" title="Above average">▲</span>`;
            style   = 'color:#F87171; font-weight:600';
        } else if (outlier === 'low') {
            content = `${val.toLocaleString()} <span class="text-amber-400 font-bold" title="Below average">▼</span>`;
            style   = 'color:#FBBF24; font-weight:600';
        } else {
            content = val.toLocaleString();
            style   = 'color:#e0e0e0';
        }
    }

    return `<td class="px-3 py-2.5 text-center border-b border-dark-border/50"
                style="${style}">${content}</td>`;
}

// ── Visual comparison (charts) ────────────────────────────────────────────────

const CHART_TEXT = '#e0e0e0';
const CHART_MUTED = '#a0a0a0';
const CHART_GRID = '#404040';

function destroyCharts() {
    _charts.forEach(c => c.destroy());
    _charts = [];
}

function scheduleCharts() {
    clearTimeout(_chartTimer);
    _chartTimer = setTimeout(refreshCharts, 120);
}

/** Largest value of each metric across every facility whose stats have loaded. */
function accountMaxima() {
    const max = { modelCount: 1, streamCount: 1, taggedAssets: 1, openTickets: 1 };
    for (const f of _facilities) {
        const s = _statsMap.get(f.urn);
        if (!s || s.error) continue;
        max.modelCount  = Math.max(max.modelCount,  getCachedSummary(f.urn)?.modelCount ?? 0);
        max.streamCount = Math.max(max.streamCount, s.streamCount ?? 0);
        max.taggedAssets = Math.max(max.taggedAssets, s.taggedAssetCount ?? 0);
        if (!s.ticketsError) max.openTickets = Math.max(max.openTickets, s.openTicketCount ?? 0);
    }
    return max;
}

function shorten(name, n = 24) {
    return name.length > n ? name.slice(0, n - 1) + '…' : name;
}

function refreshCharts() {
    const el = document.getElementById('cmp-charts-wrap');
    if (!el) return;
    destroyCharts();

    if (typeof Chart === 'undefined') { el.innerHTML = ''; return; }

    const ready = _selected
        .map((urn, i) => ({ ...getRowData(urn), color: PILL_COLORS[i % PILL_COLORS.length] }))
        .filter(r => !r.loading && !r.error);

    const toggleBtn = (mode, label) => {
        const active = _chartMode === mode;
        return `<button data-chart-mode="${mode}"
                    class="px-2.5 py-1 text-xs rounded border transition ${active
                        ? 'border-tandem-blue text-tandem-blue'
                        : 'border-dark-border text-dark-text-secondary hover:border-dark-text'}">${label}</button>`;
    };

    const header = `
        <div class="flex items-center justify-between mb-3">
            <div>
                <h3 class="text-sm font-semibold text-dark-text">Visual Comparison</h3>
                <p class="text-xs text-dark-text-secondary">
                    ${_chartMode === 'radar'
                        ? 'Each axis is scaled to the largest facility in the account (100%). Hover for actual values.'
                        : 'Actual values per metric.'}
                </p>
            </div>
            <div class="flex gap-2">${toggleBtn('radar', 'Radar')}${toggleBtn('bars', 'Bars')}</div>
        </div>`;

    if (!ready.length) {
        el.innerHTML = header + `<p class="text-xs text-dark-text-secondary italic py-6 text-center">
            ${_selected.length ? 'Waiting for facility stats…' : 'Select facilities to compare.'}</p>`;
    } else if (_chartMode === 'radar') {
        el.innerHTML = header + `<div class="relative mx-auto" style="max-width:520px;height:380px"><canvas id="cmp-radar"></canvas></div>`;
        drawRadar(ready);
    } else {
        el.innerHTML = header + `<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
            ${NUMERIC_METRICS.map(m => `
                <div>
                    <p class="text-xs font-medium mb-1" style="color:${m.color}">${m.icon} ${m.label}</p>
                    <div class="relative" style="height:${60 + ready.length * 34}px"><canvas id="cmp-bar-${m.key}"></canvas></div>
                </div>`).join('')}
        </div>`;
        drawBars(ready);
    }

    el.querySelectorAll('[data-chart-mode]').forEach(btn => {
        btn.addEventListener('click', () => { _chartMode = btn.dataset.chartMode; refreshCharts(); });
    });
}

function drawRadar(rows) {
    const max = accountMaxima();
    const datasets = rows.map(r => {
        const raw = NUMERIC_METRICS.map(m => r[m.key] ?? 0);
        return {
            label: r.name,
            raw,
            data: NUMERIC_METRICS.map((m, i) => Math.round((raw[i] / max[m.key]) * 100)),
            borderColor: r.color,
            backgroundColor: r.color + '33',
            pointBackgroundColor: r.color,
            borderWidth: 2,
            pointRadius: 3,
        };
    });

    _charts.push(new Chart(document.getElementById('cmp-radar'), {
        type: 'radar',
        data: { labels: NUMERIC_METRICS.map(m => m.label), datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    min: 0, max: 100,
                    ticks: { stepSize: 25, color: CHART_MUTED, backdropColor: 'transparent', callback: v => v + '%' },
                    grid: { color: CHART_GRID },
                    angleLines: { color: CHART_GRID },
                    pointLabels: { color: CHART_TEXT, font: { size: 12 }, padding: 10 },
                },
            },
            plugins: {
                legend: { labels: { color: CHART_TEXT, boxWidth: 12 } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.dataset.raw[ctx.dataIndex].toLocaleString()} (${ctx.parsed.r}% of max)`,
                    },
                },
            },
        },
    }));
}

function drawBars(rows) {
    for (const m of NUMERIC_METRICS) {
        const canvas = document.getElementById(`cmp-bar-${m.key}`);
        if (!canvas) continue;
        _charts.push(new Chart(canvas, {
            type: 'bar',
            data: {
                labels: rows.map(r => shorten(r.name)),
                datasets: [{
                    data: rows.map(r => r[m.key] ?? 0),
                    backgroundColor: rows.map(r => r.color + 'cc'),
                    borderColor: rows.map(r => r.color),
                    borderWidth: 1,
                    borderRadius: 3,
                }],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { beginAtZero: true, ticks: { color: CHART_MUTED, precision: 0 }, grid: { color: CHART_GRID } },
                    y: { ticks: { color: CHART_TEXT, font: { size: 11 } }, grid: { display: false } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: items => rows[items[0].dataIndex].name,
                            label: ctx => `${m.label}: ${ctx.parsed.x.toLocaleString()}`,
                        },
                    },
                },
            },
        }));
    }
}

// ── Outlier panel ─────────────────────────────────────────────────────────────

function refreshOutliers() {
    const outWrap = document.getElementById('cmp-outliers-wrap');
    if (!outWrap) return;

    // Build a list of facilities with complete stats
    const loaded = _facilities.map(f => {
        const s = _statsMap.get(f.urn);
        if (!s || s.error) return null;
        const c = getCachedSummary(f.urn);
        return {
            urn:         f.urn,
            name:        c?.name ?? f.name,
            modelCount:  c?.modelCount ?? 0,
            streamCount: s.streamCount ?? 0,
            taggedAssets:s.taggedAssetCount ?? 0,
        };
    }).filter(Boolean);

    // Need at least 3 data points for meaningful stats
    if (loaded.length < 3) {
        outWrap.innerHTML = '';
        return;
    }

    const OUTLIER_METRICS = [
        { key: 'streamCount',  label: 'Streams',       icon: ICON_STREAMS, color: '#EC4899' },
        { key: 'taggedAssets', label: 'Tagged Assets', icon: ICON_ASSETS,  color: '#F59E0B' },
        { key: 'modelCount',   label: 'Models',         icon: ICON_MODELS,  color: '#10B981' },
    ];

    const outliers = [];
    for (const m of OUTLIER_METRICS) {
        const values = loaded.map(f => f[m.key]);
        const mean   = values.reduce((a, b) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(values.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / values.length);
        if (stdDev < 0.5) continue; // no meaningful spread

        for (const f of loaded) {
            const z = (f[m.key] - mean) / stdDev;
            if (Math.abs(z) >= OUTLIER_SIGMA) {
                outliers.push({
                    facility: f, metric: m,
                    value: f[m.key],
                    mean: Math.round(mean * 10) / 10,
                    direction: z > 0 ? 'high' : 'low',
                    z: Math.abs(z),
                });
            }
        }
    }

    // Deduplicate: one entry per facility+metric pair, keep highest z
    const dedupMap = new Map();
    for (const o of outliers) {
        const key = `${o.facility.urn}:${o.metric.key}`;
        if (!dedupMap.has(key) || o.z > dedupMap.get(key).z) dedupMap.set(key, o);
    }
    const sorted = [...dedupMap.values()].sort((a, b) => b.z - a.z);

    if (sorted.length === 0) {
        outWrap.innerHTML = `
            <h3 class="text-sm font-semibold text-dark-text mb-2">Portfolio Outliers</h3>
            <p class="text-xs text-dark-text-secondary">
                No significant outliers detected across ${loaded.length} facilities. Everything looks normal!
            </p>`;
        return;
    }

    outWrap.innerHTML = `
        <h3 class="text-sm font-semibold text-dark-text mb-1">Portfolio Outliers</h3>
        <p class="text-xs text-dark-text-secondary mb-4">
            Facilities with metrics significantly above or below the account average
            <span class="text-dark-text">(${loaded.length} of ${_facilities.length} loaded)</span>.
            These may warrant a closer look.
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${sorted.slice(0, 9).map(o => {
                const isHigh      = o.direction === 'high';
                const borderColor = isHigh ? '#F8717160' : '#FBBF2460';
                const bgColor     = isHigh ? '#F8717112' : '#FBBF2412';
                const arrow       = isHigh ? '▲' : '▼';
                const arrowColor  = isHigh ? '#F87171'   : '#FBBF24';
                const dirLabel    = isHigh ? 'above' : 'below';
                return `
                <div class="rounded-lg p-3 border" style="border-color:${borderColor}; background:${bgColor}">
                    <div class="flex items-start justify-between gap-2 mb-2">
                        <p class="text-xs font-semibold text-dark-text truncate leading-snug"
                           title="${esc(o.facility.name)}">${esc(o.facility.name)}</p>
                        <span class="text-sm font-bold shrink-0 leading-tight" style="color:${arrowColor}">${arrow}</span>
                    </div>
                    <p class="text-xs text-dark-text-secondary mb-1">
                        ${o.metric.icon} ${o.metric.label}:
                        <span class="font-semibold" style="color:${o.metric.color}"> ${o.value.toLocaleString()}</span>
                    </p>
                    <p class="text-xs text-dark-text-secondary">
                        Avg: <span class="text-dark-text">${o.mean.toLocaleString()}</span>
                        &nbsp;·&nbsp;
                        <span style="color:${arrowColor}">${o.z.toFixed(1)}σ ${dirLabel} avg</span>
                    </p>
                </div>`;
            }).join('')}
        </div>`;
}

// ── Statistical helpers ───────────────────────────────────────────────────────

/**
 * Compute mean + stdDev thresholds for each numeric metric across all
 * facilities that have stats loaded. Returns { modelCount, streamCount, taggedAssets }.
 */
function computeThresholds() {
    const loaded = _facilities.map(f => {
        const s = _statsMap.get(f.urn);
        if (!s || s.error) return null;
        const c = getCachedSummary(f.urn);
        return {
            modelCount:   c?.modelCount ?? 0,
            streamCount:  s.streamCount ?? 0,
            taggedAssets: s.taggedAssetCount ?? 0,
            openTickets:  s.ticketsError ? null : (s.openTicketCount ?? 0),
        };
    }).filter(Boolean);

    const result = {};
    for (const key of ['modelCount', 'streamCount', 'taggedAssets', 'openTickets']) {
        if (loaded.length < 2) { result[key] = null; continue; }
        const vals   = loaded.map(x => x[key]).filter(v => v !== null);
        if (vals.length < 2) { result[key] = null; continue; }
        const mean   = vals.reduce((a, b) => a + b, 0) / vals.length;
        const stdDev = Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
        result[key]  = stdDev >= 0.5 ? { mean, stdDev } : null;
    }
    return result;
}

function getOutlierDir(val, threshold) {
    if (!threshold) return null;
    const z = Math.abs(val - threshold.mean) / threshold.stdDev;
    if (z < OUTLIER_SIGMA) return null;
    return val > threshold.mean ? 'high' : 'low';
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function spinnerSVG() {
    return `<svg class="w-3.5 h-3.5 animate-spin inline-block text-dark-text-secondary"
                 fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg>`;
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
