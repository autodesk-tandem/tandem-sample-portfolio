/**
 * Tickets View — portfolio-wide work-order / ticket summary.
 *
 * Summary row per facility sorted by open ticket count (or priority).
 * Drill-down panel loads full ticket details (name, priority, date, asset)
 * on demand when a facility row is clicked.
 *
 * Ticket counts come from the stats cache populated by loadAllFacilityStats
 * (no extra API calls needed for the list view). Full ticket details are
 * fetched lazily via getTickets() only when a facility is expanded.
 */

import { getTickets } from '../api.js';
import { getStatsStore } from './portfolioView.js';
import { QC } from '../../tandem/constants.js';

// ── Priority config ────────────────────────────────────────────────────────────
const PRIORITY_ORDER  = ['Critical', 'High', 'Medium', 'Low', 'Trivial', 'Unknown'];
const PRIORITY_COLOR  = {
    Critical: { bg: '#7f1d1d22', fg: '#f87171', border: '#7f1d1d66' },
    High:     { bg: '#78350f22', fg: '#fb923c', border: '#78350f66' },
    Medium:   { bg: '#78350f22', fg: '#fbbf24', border: '#78350f66' },
    Low:      { bg: '#1e3a5f22', fg: '#60a5fa', border: '#1e3a5f66' },
    Trivial:  { bg: '#37415122', fg: '#9ca3af', border: '#37415166' },
    Unknown:  { bg: '#37415122', fg: '#9ca3af', border: '#37415166' },
};

const ICON_TICKET = `<svg class="w-3 h-3 inline-block shrink-0 align-middle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/>
</svg>`;

// ── Module state ───────────────────────────────────────────────────────────────
let _facilities    = [];
let _regionMap     = null;
let _loaded        = false;
let _sortKey       = 'open';     // 'open' | 'critical' | 'total'
let _openFacility  = null;

// ── Public API ─────────────────────────────────────────────────────────────────

export function render(facilities, regionMap) {
    _facilities   = facilities;
    _regionMap    = regionMap;
    _loaded       = false;
    _openFacility = null;

    const wrap = document.getElementById('ticketsContent');
    if (wrap) showPlaceholder(wrap, facilities.length);
}

export function activate() {
    if (_loaded) return;
    _loaded = true;
    renderSummary();
}

/** Called by app.js after updateCardStats so the list stays live. */
export function updateStats() {
    if (!_loaded) return;
    renderSummary();
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function showPlaceholder(wrap, count) {
    wrap.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 text-dark-text-secondary">
            <svg class="w-12 h-12 mb-4 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/>
            </svg>
            <p class="text-sm font-medium text-dark-text mb-1">Work Orders &amp; Tickets</p>
            <p class="text-xs text-center max-w-xs">
                Switch to this tab to scan tickets across
                ${count} facilit${count !== 1 ? 'ies' : 'y'}.
            </p>
        </div>`;
}

function renderSummary() {
    const wrap = document.getElementById('ticketsContent');
    if (!wrap) return;

    const store = getStatsStore();
    // Build rows — only include facilities that have stats loaded
    const rows = _facilities.map(f => {
        const s = store.get(f.urn);
        return {
            urn:    f.urn,
            name:   f.name,
            region: _regionMap?.get(f.urn) ?? f.region ?? 'us',
            open:   s?.openTicketCount   ?? null,
            closed: s?.closedTicketCount ?? null,
        };
    });

    // Sort
    const sorted = sortRows(rows, _sortKey);

    // Banner totals
    const loaded    = rows.filter(r => r.open !== null);
    const totalOpen = loaded.reduce((s, r) => s + r.open, 0);
    const withOpen  = loaded.filter(r => r.open > 0).length;
    const noTickets = loaded.filter(r => r.open === 0 && r.closed === 0).length;
    const pending   = rows.length - loaded.length;

    wrap.innerHTML = `
        <div class="flex gap-0" style="height:calc(100vh - 190px);min-height:500px">

            <!-- ── Left: list ── -->
            <div class="flex flex-col flex-1 min-w-0">

                <!-- Banner -->
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 border-b border-dark-border text-xs text-dark-text-secondary bg-dark-card shrink-0">
                    <span>${ICON_TICKET} <b class="text-dark-text">${totalOpen}</b> open tickets across <b class="text-dark-text">${withOpen}</b> facilit${withOpen !== 1 ? 'ies' : 'y'}</span>
                    ${noTickets ? `<span class="opacity-60">${noTickets} with no tickets</span>` : ''}
                    ${pending   ? `<span class="opacity-60">${pending} still loading…</span>` : ''}

                    <!-- Sort controls -->
                    <div class="ml-auto flex items-center gap-2">
                        <span class="opacity-60">Sort:</span>
                        ${sortBtn('open',     'Most Open',     _sortKey)}
                        ${sortBtn('critical', 'Most Critical', _sortKey)}
                        ${sortBtn('total',    'Most Total',    _sortKey)}
                        <button id="tickets-refresh-btn"
                                class="ml-1 px-2 py-0.5 rounded text-xs border border-dark-border text-dark-text-secondary hover:border-tandem-blue hover:text-tandem-blue transition flex items-center gap-1"
                                title="Re-render with latest cached data">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                            </svg>
                            Refresh
                        </button>
                    </div>
                </div>

                <!-- Facility list -->
                <div id="tickets-list" class="flex-1 overflow-y-auto divide-y divide-dark-border">
                    ${sorted.map(r => facilityRow(r)).join('')}
                </div>
            </div>

            <!-- ── Right: drill-down panel ── -->
            <div id="tickets-panel" class="w-96 shrink-0 border-l border-dark-border bg-dark-card overflow-y-auto">
                <div class="p-5 flex flex-col items-center justify-center h-full text-center text-dark-text-secondary">
                    <svg class="w-8 h-8 mb-3 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                              d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/>
                    </svg>
                    <p class="text-xs">Click a facility to see its open tickets</p>
                </div>
            </div>
        </div>`;

    // Sort buttons
    wrap.querySelectorAll('.tickets-sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _sortKey = btn.dataset.sort;
            renderSummary();
        });
    });

    // Refresh button
    wrap.querySelector('#tickets-refresh-btn')?.addEventListener('click', () => renderSummary());

    // Row clicks
    wrap.querySelectorAll('[data-tickets-urn]').forEach(row => {
        row.addEventListener('click', () => {
            const urn    = row.dataset.ticketsUrn;
            const region = row.dataset.ticketsRegion;
            const name   = row.dataset.ticketsName;
            openDrillDown(urn, region, name);
        });
    });

    // Re-open drill-down if one was open
    if (_openFacility) {
        const row = sorted.find(r => r.urn === _openFacility);
        if (row) openDrillDown(row.urn, row.region, row.name);
    }
}

function sortBtn(key, label, current) {
    const active = current === key;
    const cls = active
        ? 'border-tandem-blue text-tandem-blue'
        : 'border-dark-border text-dark-text-secondary hover:border-dark-text';
    return `<button class="tickets-sort-btn px-2 py-0.5 rounded text-xs border ${cls}" data-sort="${key}">${label}</button>`;
}

function sortRows(rows, key) {
    return [...rows].sort((a, b) => {
        if (key === 'open')     return (b.open ?? -1) - (a.open ?? -1);
        if (key === 'total')    return ((b.open ?? 0) + (b.closed ?? 0)) - ((a.open ?? 0) + (a.closed ?? 0));
        // 'critical' — we don't have per-priority breakdown in the summary,
        // so fall back to open count (full priority sort happens in drill-down)
        return (b.open ?? -1) - (a.open ?? -1);
    });
}

function facilityRow(r) {
    const isLoading = r.open === null;
    const total     = (r.open ?? 0) + (r.closed ?? 0);
    const hasTickets = total > 0;

    const openChip = r.open > 0
        ? `<span class="px-1.5 py-0.5 rounded text-xs font-medium" style="background:#78350f22;color:#fb923c;border:1px solid #78350f66">${ICON_TICKET} ${r.open} open</span>`
        : r.open === 0
            ? `<span class="text-xs text-dark-text-secondary opacity-40">No open tickets</span>`
            : '';

    const closedChip = r.closed > 0
        ? `<span class="px-1.5 py-0.5 rounded text-xs" style="background:#37415122;color:#9ca3af;border:1px solid #37415166">${r.closed} closed</span>`
        : '';

    const loadingChip = isLoading
        ? `<span class="text-xs text-dark-text-secondary opacity-40 animate-pulse">Loading…</span>`
        : '';

    return `
        <div class="flex items-center gap-3 px-4 py-3 hover:bg-dark-bg transition cursor-pointer group ${_openFacility === r.urn ? 'bg-dark-bg' : ''}"
             data-tickets-urn="${esc(r.urn)}"
             data-tickets-region="${esc(r.region)}"
             data-tickets-name="${esc(r.name)}">
            <!-- Indicator dot -->
            <div class="w-2.5 h-2.5 rounded-full shrink-0"
                 style="background:${r.open > 0 ? '#fb923c' : r.open === 0 ? '#10B981' : '#6B7280'}"></div>

            <!-- Name -->
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-dark-text truncate">${esc(r.name)}</p>
                ${hasTickets ? `<p class="text-xs text-dark-text-secondary">${total} ticket${total !== 1 ? 's' : ''} total</p>` : ''}
            </div>

            <!-- Chips -->
            <div class="flex items-center gap-1.5 shrink-0">
                ${loadingChip}${openChip}${closedChip}
            </div>

            <!-- Chevron -->
            <svg class="w-4 h-4 shrink-0 text-dark-text-secondary opacity-0 group-hover:opacity-100 transition"
                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
            </svg>
        </div>`;
}

// ── Drill-down ─────────────────────────────────────────────────────────────────

async function openDrillDown(urn, region, name) {
    _openFacility = urn;

    // Highlight selected row
    document.querySelectorAll('[data-tickets-urn]').forEach(el => {
        el.classList.toggle('bg-dark-bg', el.dataset.ticketsUrn === urn);
    });

    const panel = document.getElementById('tickets-panel');
    if (!panel) return;

    panel.innerHTML = `
        <div class="p-4">
            <div class="border-b border-dark-border pb-3 mb-3">
                <p class="text-sm font-semibold text-dark-text">${esc(name)}</p>
                <p class="text-xs text-dark-text-secondary">${region.toUpperCase()}</p>
            </div>
            <p class="text-xs text-dark-text-secondary animate-pulse">Loading tickets…</p>
        </div>`;

    const tickets = await getTickets(urn, region).catch(() => []);
    renderDrillDown(panel, name, region, tickets);
}

function renderDrillDown(panel, name, region, tickets) {
    if (!tickets.length) {
        panel.innerHTML = `
            <div class="p-4">
                <div class="border-b border-dark-border pb-3 mb-3">
                    <p class="text-sm font-semibold text-dark-text">${esc(name)}</p>
                </div>
                <p class="text-xs text-dark-text-secondary italic">No tickets found for this facility.</p>
            </div>`;
        return;
    }

    const open   = tickets.filter(t => !t[QC.CloseDate]?.[0]);
    const closed = tickets.filter(t =>  t[QC.CloseDate]?.[0]);

    // Priority breakdown (across all tickets)
    const byPriority = {};
    PRIORITY_ORDER.forEach(p => { byPriority[p] = 0; });
    tickets.forEach(t => {
        const p = t[QC.Priority]?.[0] ?? 'Unknown';
        byPriority[p] = (byPriority[p] ?? 0) + 1;
    });

    const prioritySummary = PRIORITY_ORDER
        .filter(p => byPriority[p] > 0)
        .map(p => {
            const c = PRIORITY_COLOR[p];
            return `<span class="px-1.5 py-0.5 rounded text-xs font-medium"
                         style="background:${c.bg};color:${c.fg};border:1px solid ${c.border}">
                        ${p}: ${byPriority[p]}
                    </span>`;
        }).join('');

    // Fixed-width pill so all ticket names align on the same column
    const PILL_W = 'display:inline-block;width:56px;text-align:center;';

    function buildTicketRows(list, sortKey) {
        if (!list.length) return `<p class="text-xs text-dark-text-secondary italic py-2">No tickets match this filter.</p>`;

        const sorted = [...list].sort((a, b) => {
            if (sortKey === 'date') {
                return (b[QC.OpenDate]?.[0] ?? '').localeCompare(a[QC.OpenDate]?.[0] ?? '');
            }
            if (sortKey === 'name') {
                const na = a[QC.OName]?.[0] ?? a[QC.Name]?.[0] ?? '';
                const nb = b[QC.OName]?.[0] ?? b[QC.Name]?.[0] ?? '';
                return na.localeCompare(nb);
            }
            // 'priority' (default) — Critical first
            const pa = PRIORITY_ORDER.indexOf(a[QC.Priority]?.[0] ?? 'Unknown');
            const pb = PRIORITY_ORDER.indexOf(b[QC.Priority]?.[0] ?? 'Unknown');
            return pa - pb;
        });

        return sorted.map(t => {
            const isOpen    = !t[QC.CloseDate]?.[0];
            const priority  = t[QC.Priority]?.[0] ?? 'Unknown';
            const tName     = t[QC.OName]?.[0] ?? t[QC.Name]?.[0] ?? 'Unnamed Ticket';
            const openDate  = t[QC.OpenDate]?.[0];
            const closeDate = t[QC.CloseDate]?.[0];
            const age       = openDate ? daysOpen(openDate, closeDate) : null;
            const c         = PRIORITY_COLOR[priority] ?? PRIORITY_COLOR['Unknown'];
            return `
                <div class="py-2.5 border-b border-dark-border last:border-0">
                    <div class="flex items-start gap-2">
                        <span class="py-0.5 rounded text-xs shrink-0 mt-0.5"
                              style="${PILL_W}background:${c.bg};color:${c.fg};border:1px solid ${c.border}">${priority}</span>
                        <div class="min-w-0 flex-1">
                            <p class="text-xs font-medium text-dark-text truncate" title="${esc(tName)}">${esc(tName)}</p>
                            <div class="flex items-center gap-2 mt-0.5 text-xs text-dark-text-secondary">
                                <span class="${isOpen ? 'text-amber-400' : 'opacity-60'}">${isOpen ? 'Open' : 'Closed'}</span>
                                ${age !== null ? `<span>· ${age}d ${isOpen ? 'open' : ''}</span>` : ''}
                                ${openDate ? `<span>· ${fmtDate(openDate)}</span>` : ''}
                            </div>
                        </div>
                    </div>
                </div>`;
        }).join('');
    }

    function filterBtn(value, label, count, current) {
        const active = current === value;
        const cls = active
            ? 'bg-tandem-blue text-white border-tandem-blue'
            : 'border-dark-border text-dark-text-secondary hover:border-tandem-blue hover:text-tandem-blue';
        return `<button class="dd-filter-btn px-2.5 py-1 rounded text-xs border transition ${cls}" data-filter="${value}">
            ${label} <span class="opacity-70">(${count})</span>
        </button>`;
    }

    function sortBtn(value, label, current) {
        const active = current === value;
        const cls = active
            ? 'border-tandem-blue text-tandem-blue'
            : 'border-dark-border text-dark-text-secondary hover:border-dark-text';
        return `<button class="dd-sort-btn px-2 py-0.5 rounded text-xs border transition ${cls}" data-sort="${value}">${label}</button>`;
    }

    panel.innerHTML = `
        <div class="p-4 space-y-3">
            <div class="border-b border-dark-border pb-3">
                <p class="text-sm font-semibold text-dark-text">${esc(name)}</p>
                <p class="text-xs text-dark-text-secondary">${region.toUpperCase()}</p>
            </div>

            <!-- Priority breakdown -->
            ${prioritySummary ? `<div class="flex flex-wrap gap-1">${prioritySummary}</div>` : ''}

            <!-- Filter + Sort bar -->
            <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1" id="dd-filter-bar">
                    ${filterBtn('all',    'All',    tickets.length, 'all')}
                    ${filterBtn('open',   'Open',   open.length,    'all')}
                    ${filterBtn('closed', 'Closed', closed.length,  'all')}
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <svg class="w-3 h-3 text-dark-text-secondary opacity-60 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"/>
                    </svg>
                    ${sortBtn('priority', 'Priority', 'priority')}
                    ${sortBtn('date',     'Date',     'priority')}
                    ${sortBtn('name',     'Name',     'priority')}
                </div>
            </div>

            <!-- Ticket list -->
            <div id="dd-ticket-list">${buildTicketRows([...open, ...closed], 'priority')}</div>
        </div>`;

    // Wire filter + sort buttons
    let currentFilter = 'all';
    let currentSort   = 'priority';

    function getList() {
        return currentFilter === 'open'   ? open
             : currentFilter === 'closed' ? closed
             : [...open, ...closed];
    }

    function refreshList() {
        panel.querySelector('#dd-ticket-list').innerHTML = buildTicketRows(getList(), currentSort);
    }

    panel.querySelectorAll('.dd-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentFilter = btn.dataset.filter;
            panel.querySelectorAll('.dd-filter-btn').forEach(b => {
                const a = b.dataset.filter === currentFilter;
                b.className = `dd-filter-btn px-2.5 py-1 rounded text-xs border transition ${a ? 'bg-tandem-blue text-white border-tandem-blue' : 'border-dark-border text-dark-text-secondary hover:border-tandem-blue hover:text-tandem-blue'}`;
            });
            refreshList();
        });
    });

    panel.querySelectorAll('.dd-sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentSort = btn.dataset.sort;
            panel.querySelectorAll('.dd-sort-btn').forEach(b => {
                const a = b.dataset.sort === currentSort;
                b.className = `dd-sort-btn px-2 py-0.5 rounded text-xs border transition ${a ? 'border-tandem-blue text-tandem-blue' : 'border-dark-border text-dark-text-secondary hover:border-dark-text'}`;
            });
            refreshList();
        });
    });
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function daysOpen(openDate, closeDate) {
    const start = new Date(openDate);
    const end   = closeDate ? new Date(closeDate) : new Date();
    return Math.floor((end - start) / 86400000);
}

function fmtDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
