/**
 * Details View — per-facility deep dive.
 *
 * Sections:
 *  - Streams        : all IoT data streams in the facility's default model
 *  - Tagged Assets  : all elements with user-defined properties, grouped by model
 *
 * Called by app.js:
 *  - render(facility, region)  when user clicks "View Details →" on a card
 *  - renderEmpty()             when account switches (clears stale data)
 */

import { getStreams, getTaggedAssetsDetails } from '../api.js';
import { QC, ColumnFamilies } from '../../tandem/constants.js';
import { getEnv } from '../config.js';

let _facility = null;
let _region   = null;
let _section  = 'streams'; // 'streams' | 'assets'

const wrap = document.getElementById('detailsContent');

// ── Public API ─────────────────────────────────────────────────────────────────

/** Show a placeholder — call when no facility is selected or on account switch. */
export function renderEmpty() {
    _facility = null;
    if (!wrap) return;
    wrap.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 text-dark-text-secondary">
            <svg class="w-12 h-12 mb-4 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                <polyline stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                          points="9 22 9 12 15 12 15 22"/>
            </svg>
            <p class="text-sm font-medium text-dark-text mb-1">No facility selected</p>
            <p class="text-xs text-center max-w-xs">
                Click <strong>View Details →</strong> on any facility card in the Portfolio tab to explore it here.
            </p>
        </div>`;
}

/**
 * Show details for a specific facility.
 * @param {{ urn: string, name: string, region: string, labels?: string[] }} facility
 * @param {string} region - Region identifier (prefer facilityRegionMap over facility.region)
 */
export function render(facility, region) {
    _facility = facility;
    _region   = region;
    _section  = 'streams';
    if (!wrap) return;
    wrap.innerHTML = buildShell();
    wireSectionTabs();
    loadSection('streams');
}

// ── Layout shell ───────────────────────────────────────────────────────────────

function buildShell() {
    const { name, urn, region, labels = [] } = _facility;
    const env         = getEnv();
    const base        = env.tandemAppBaseURL.replace('/app', '');
    const facilityURL = `${base}/pages/facilities/${urn}`;
    const regionLabel = (region ?? 'us').toUpperCase();

    const tagPills = labels.length
        ? labels.map(t =>
            `<span class="inline-block bg-dark-bg border border-dark-border rounded-full px-2 py-px text-xs text-dark-text-secondary">${escapeHtml(String(t))}</span>`
          ).join('')
        : '';

    return `
        <div class="space-y-4">

            <!-- Facility header -->
            <div class="flex items-start justify-between gap-4 pb-4 border-b border-dark-border">
                <div class="space-y-1 min-w-0">
                    <h2 class="text-base font-semibold text-dark-text truncate">${escapeHtml(name)}</h2>
                    <div class="flex flex-wrap items-center gap-1.5">
                        <span class="inline-block bg-dark-bg border border-dark-border rounded-full px-2 py-px text-xs text-dark-text-secondary">
                            ${escapeHtml(regionLabel)}
                        </span>
                        ${tagPills}
                    </div>
                </div>
                <a href="${facilityURL}" target="_blank" rel="noopener"
                   class="shrink-0 inline-flex items-center gap-1 text-xs text-tandem-blue hover:underline transition">
                    Open in Tandem
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>
                </a>
            </div>

            <!-- Section tabs -->
            <div class="border-b border-dark-border flex gap-0">
                <button data-section="streams"
                        class="detail-tab active-detail-tab px-4 py-2 text-sm font-medium border-b-2 transition
                               text-tandem-blue border-tandem-blue">
                    Streams
                    <span id="detail-streams-badge" class="ml-1 text-xs font-normal text-dark-text-secondary"></span>
                </button>
                <button data-section="assets"
                        class="detail-tab px-4 py-2 text-sm font-medium border-b-2 transition
                               text-dark-text-secondary border-transparent hover:text-dark-text">
                    Tagged Assets
                    <span id="detail-assets-badge" class="ml-1 text-xs font-normal text-dark-text-secondary"></span>
                </button>
            </div>

            <!-- Section content -->
            <div id="detail-section-content">
                <!-- Loaded dynamically -->
            </div>

        </div>`;
}

function wireSectionTabs() {
    wrap.querySelectorAll('.detail-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.section === _section) return;
            _section = btn.dataset.section;

            wrap.querySelectorAll('.detail-tab').forEach(t => {
                const isActive = t.dataset.section === _section;
                t.classList.toggle('text-tandem-blue',        isActive);
                t.classList.toggle('border-tandem-blue',      isActive);
                t.classList.toggle('text-dark-text-secondary', !isActive);
                t.classList.toggle('border-transparent',      !isActive);
            });

            loadSection(_section);
        });
    });
}

// ── Section loading ────────────────────────────────────────────────────────────

function loadSection(section) {
    const content = document.getElementById('detail-section-content');
    if (!content) return;
    content.innerHTML = skeletonRows();
    if (section === 'streams') loadStreams();
    else                       loadAssets();
}

function skeletonRows(count = 7) {
    const rows = Array.from({ length: count }, () => `
        <tr>
            <td class="py-2.5 px-3"><div class="skeleton h-3 w-36 rounded"></div></td>
            <td class="py-2.5 px-3"><div class="skeleton h-3 w-20 rounded"></div></td>
            <td class="py-2.5 px-3"><div class="skeleton h-3 w-10 rounded ml-auto"></div></td>
        </tr>`).join('');
    return `
        <div class="overflow-x-auto rounded border border-dark-border">
            <table class="w-full text-xs"><tbody class="divide-y divide-dark-border">${rows}</tbody></table>
        </div>`;
}

// ── Streams section ────────────────────────────────────────────────────────────

async function loadStreams() {
    const content = document.getElementById('detail-section-content');
    if (!content || !_facility) return;

    try {
        const streams = await getStreams(_facility.urn, _region);

        // Update badge count
        const badge = document.getElementById('detail-streams-badge');
        if (badge) badge.textContent = `(${streams.length})`;

        if (!content.isConnected) return; // user switched section while loading

        if (streams.length === 0) {
            content.innerHTML = emptyState(
                'No streams found.',
                'Streams are IoT sensors linked to elements in the default model.'
            );
            return;
        }

        const rows = streams.map(s => {
            const name      = s[QC.OName]?.[0] ?? s[QC.Name]?.[0] ?? 'Unnamed Stream';
            const hasHost   = !!(s[QC.XParent]?.[0]);
            const paramCount = Object.keys(s).filter(k => k.startsWith(`${ColumnFamilies.DtProperties}:`)).length;

            return `
                <tr class="hover:bg-dark-bg transition">
                    <td class="py-2 px-3 font-medium text-dark-text">${escapeHtml(name)}</td>
                    <td class="py-2 px-3 text-dark-text-secondary">
                        ${hasHost
                            ? '<span class="text-green-400 mr-1">●</span>Connected'
                            : '<span class="text-dark-border mr-1">●</span>Unhosted'}
                    </td>
                    <td class="py-2 px-3 text-right text-dark-text-secondary">${paramCount}</td>
                </tr>`;
        }).join('');

        content.innerHTML = `
            <div class="overflow-x-auto rounded border border-dark-border">
                <table class="w-full text-xs">
                    <thead class="bg-dark-bg text-dark-text-secondary border-b border-dark-border">
                        <tr>
                            <th class="py-2 px-3 text-left font-medium">Stream Name</th>
                            <th class="py-2 px-3 text-left font-medium">Host</th>
                            <th class="py-2 px-3 text-right font-medium">Parameters</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-dark-border">${rows}</tbody>
                </table>
            </div>
            <p class="text-xs text-dark-text-secondary mt-2">
                ${streams.length} stream${streams.length !== 1 ? 's' : ''} in the default model
            </p>`;

    } catch (err) {
        console.error('Error loading streams for details view:', err);
        const c = document.getElementById('detail-section-content');
        if (c) c.innerHTML = errorState('Could not load streams. Check console for details.');
    }
}

// ── Tagged Assets section ──────────────────────────────────────────────────────

async function loadAssets() {
    const content = document.getElementById('detail-section-content');
    if (!content || !_facility) return;

    try {
        // includeKeys: true → gives us per-model asset counts via elementsByModel[].keys.length
        const details = await getTaggedAssetsDetails(_facility.urn, _region, true);

        // Update badge count
        const badge = document.getElementById('detail-assets-badge');
        if (badge) badge.textContent = `(${details.totalCount})`;

        if (!content.isConnected) return;

        if (details.totalCount === 0) {
            content.innerHTML = emptyState(
                'No tagged assets found.',
                'Tagged assets are elements with user-defined properties applied via a Tandem template.'
            );
            return;
        }

        const byModel = details.elementsByModel ?? [];
        const modelRows = byModel.map(model => `
            <tr class="hover:bg-dark-bg transition">
                <td class="py-2 px-3 font-medium text-dark-text">${escapeHtml(model.modelName ?? 'Unnamed Model')}</td>
                <td class="py-2 px-3 text-right text-dark-text font-medium">${model.keys.length}</td>
            </tr>`).join('');

        content.innerHTML = `
            <!-- Summary banner -->
            <div class="mb-4 flex items-baseline gap-2 p-3 bg-dark-bg rounded border border-dark-border text-xs text-dark-text-secondary">
                <span class="text-dark-text font-semibold text-lg">${details.totalCount}</span>
                tagged asset${details.totalCount !== 1 ? 's' : ''} across
                <span class="text-dark-text font-medium">${byModel.length}</span>
                model${byModel.length !== 1 ? 's' : ''}
            </div>

            <!-- Per-model breakdown -->
            <div class="overflow-x-auto rounded border border-dark-border">
                <table class="w-full text-xs">
                    <thead class="bg-dark-bg text-dark-text-secondary border-b border-dark-border">
                        <tr>
                            <th class="py-2 px-3 text-left font-medium">Model</th>
                            <th class="py-2 px-3 text-right font-medium">Tagged Assets</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-dark-border">${modelRows}</tbody>
                </table>
            </div>`;

    } catch (err) {
        console.error('Error loading tagged assets for details view:', err);
        const c = document.getElementById('detail-section-content');
        if (c) c.innerHTML = errorState('Could not load tagged assets. Check console for details.');
    }
}

// ── Shared UI helpers ──────────────────────────────────────────────────────────

function emptyState(title, subtitle = '') {
    return `
        <div class="text-center py-16 text-dark-text-secondary">
            <p class="text-sm font-medium text-dark-text mb-1">${escapeHtml(title)}</p>
            ${subtitle ? `<p class="text-xs">${escapeHtml(subtitle)}</p>` : ''}
        </div>`;
}

function errorState(msg) {
    return `<div class="text-center py-16"><p class="text-xs text-red-400">${escapeHtml(msg)}</p></div>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
