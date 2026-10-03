/**
 * Access View — force-directed user-facility access graph.
 *
 * Node types:
 *  - Facility (blue rect)  : one per facility
 *  - User    (circle)      : initials with per-user identity color; access level shown on edges/border
 *  - App     (purple rect) : APS service accounts / integrations (no email → detected as app)
 *
 * Edge color = access level on that specific facility:
 *   Gold  #F59E0B = Owner
 *   Blue  #0696D7 = Editor
 *   Gray  #6B7280 = Viewer
 *
 * Requires D3 v7 loaded globally (via CDN in index.html).
 */

import { getFacilityUsers } from '../api.js';
import { getEnv } from '../config.js';

// ── Constants ──────────────────────────────────────────────────────────────────

// Tandem API returns string access levels — map to display tiers
const ACCESS_LEVEL_MAP = { 'Owner': 4, 'Manage': 3, 'ReadWrite': 2, 'Read': 1, 'None': 0 };
const ACCESS_LABELS    = { 4: 'Owner', 3: 'Manage', 2: 'ReadWrite', 1: 'Read', 0: 'None' };
const ACCESS_COLORS    = { 4: '#F59E0B', 3: '#10B981', 2: '#0696D7', 1: '#6B7280', 0: '#374151' };
const APP_STROKE      = '#8B5CF6'; // purple for APS app nodes
const APP_FILL        = '#1a1020';
const FACILITY_FILL   = '#0D2C54';
const FACILITY_STROKE = '#0696D7';

const FR = 22;   // facility rect half-width
const UR = 18;   // user/app circle radius
const CONCURRENCY  = 5;
const MAX_FACILITIES = 300;

// ── Module state ───────────────────────────────────────────────────────────────

let _facilities  = [];
let _regionMap   = null;
let _loaded      = false;
let _loading     = false;
let _abortFlag   = false;
let _simulation  = null;
let _nodes       = [];
let _links       = [];
let _userMap     = new Map();      // userId → node (dedup)
let _facAccessMap = new Map();     // facilityURN → [{ userId, name, email, accessLevel }]

// ── Public API ─────────────────────────────────────────────────────────────────

export function render(facilities, regionMap) {
    _facilities  = facilities.slice(0, MAX_FACILITIES);
    _regionMap   = regionMap;
    _loaded      = false;
    _loading     = false;
    _abortFlag   = true;
    _simulation?.stop();
    _nodes       = [];
    _links       = [];
    _userMap.clear();
    _facAccessMap.clear();

    const wrap = document.getElementById('accessContent');
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

    const wrap = document.getElementById('accessContent');
    if (!wrap) return;

    const capped = _facilities.length === MAX_FACILITIES;
    showProgress(wrap, 0, _facilities.length, capped);

    let done = 0, cursor = 0;

    async function worker() {
        while (cursor < _facilities.length) {
            if (_abortFlag) return;
            const f      = _facilities[cursor++];
            const region = _regionMap?.get(f.urn) ?? f.region ?? 'us';
            try {
                const users = await getFacilityUsers(f.urn, region);
                if (!_abortFlag) collectUsers(f, users ?? {});
            } catch (_) { /* skip — facility just won't appear */ }
            done++;
            if (!_abortFlag) updateProgress(done, _facilities.length);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    if (_abortFlag) return;

    _loading = false;
    _loaded  = true;
    renderGraph(wrap);
}

function collectUsers(facility, usersObj) {
    const entries = Object.entries(usersObj);
    if (!entries.length) return;

    _facAccessMap.set(facility.urn, []);

    for (const [userId, info] of entries) {
        const lvl = ACCESS_LEVEL_MAP[info.accessLevel] ?? 1;

        // Detect APS service accounts / apps: they have no email address.
        // Real Autodesk users always have an email. Apps (e.g. "Tandem Connect")
        // are granted access by their client ID and have name but no email.
        const isApp = !info.email || !String(info.email).includes('@');

        _facAccessMap.get(facility.urn).push({ userId, ...info, accessLevel: lvl });

        if (!_userMap.has(userId)) {
            const node = {
                id:             userId,
                type:           'user',
                name:           info.name  || info.email || 'Unknown',
                email:          info.email || '',
                maxAccessLevel: lvl,
                isApp,
                facilityAccess: [],
            };
            _userMap.set(userId, node);
            _nodes.push(node);
        } else {
            const n = _userMap.get(userId);
            n.maxAccessLevel = Math.max(n.maxAccessLevel, lvl);
        }

        _userMap.get(userId).facilityAccess.push({
            urn: facility.urn, name: facility.name, accessLevel: lvl,
        });
    }
}

// ── Progress UI ────────────────────────────────────────────────────────────────

function showPlaceholder(wrap, count) {
    wrap.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 text-dark-text-secondary">
            <svg class="w-12 h-12 mb-4 text-dark-border" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857
                         M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857
                         m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            <p class="text-sm font-medium text-dark-text mb-1">User Access Graph</p>
            <p class="text-xs text-center max-w-xs">
                Switch to this tab to map access across
                ${count} facilit${count !== 1 ? 'ies' : 'y'}.
            </p>
        </div>`;
}

function showProgress(wrap, done, total, capped) {
    wrap.innerHTML = `
        <div class="flex flex-col items-center justify-center py-24 gap-4">
            <p class="text-sm font-medium text-dark-text">Building access map…</p>
            <div class="w-72">
                <div class="flex justify-between text-xs text-dark-text-secondary mb-1.5">
                    <span id="ap-label">Starting…</span>
                    <span id="ap-pct">0%</span>
                </div>
                <div class="w-full bg-dark-bg rounded-full h-1.5 overflow-hidden border border-dark-border">
                    <div id="ap-bar" class="h-full rounded-full transition-all duration-200"
                         style="width:0%;background:#0696D7"></div>
                </div>
            </div>
            ${capped ? `<p class="text-xs text-amber-400">Large account — showing first ${MAX_FACILITIES} facilities</p>` : ''}
        </div>`;
}

function updateProgress(done, total) {
    const pct = Math.round((done / total) * 100);
    const bar   = document.getElementById('ap-bar');
    const pctEl = document.getElementById('ap-pct');
    const label = document.getElementById('ap-label');
    if (bar)   bar.style.width   = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (label) label.textContent = `${done} / ${total} facilities`;
}

// ── D3 graph rendering ─────────────────────────────────────────────────────────

function renderGraph(wrap) {
    const d3 = window.d3;
    if (!d3) {
        wrap.innerHTML = `<p class="text-red-400 text-sm text-center py-16">D3.js not loaded.</p>`;
        return;
    }

    const facilitiesWithUsers = _facilities.filter(f => _facAccessMap.has(f.urn));
    if (facilitiesWithUsers.length === 0) {
        wrap.innerHTML = `
            <div class="text-center py-24 text-dark-text-secondary">
                <p class="text-sm font-medium text-dark-text mb-1">No user access data found</p>
                <p class="text-xs">You may not have permission to read facility user lists.</p>
            </div>`;
        return;
    }

    const facilityNodes = facilitiesWithUsers.map(f => ({
        id:        f.urn,
        type:      'facility',
        name:      f.name,
        region:    f.region,
        userCount: (_facAccessMap.get(f.urn) ?? []).length,
    }));
    _nodes = [...facilityNodes, ..._nodes];

    _links = [];
    for (const [urn, users] of _facAccessMap.entries()) {
        for (const u of users) {
            _links.push({ source: u.userId, target: urn, accessLevel: u.accessLevel });
        }
    }

    const nFacilities = facilitiesWithUsers.length;
    const nUsers      = [..._userMap.values()].filter(n => !n.isApp).length;
    const nApps       = [..._userMap.values()].filter(n =>  n.isApp).length;
    const nLinks      = _links.length;

    wrap.innerHTML = `
        <div class="flex gap-3" style="height:calc(100vh - 190px);min-height:500px">

            <!-- Graph canvas -->
            <div class="relative flex-1 border border-dark-border rounded-lg overflow-hidden" style="background:#0e0e0e">

                <!-- Stats overlay -->
                <div class="absolute top-2 left-2 z-10 flex items-center gap-3 text-xs text-dark-text-secondary
                            bg-dark-card bg-opacity-90 border border-dark-border rounded px-2.5 py-1.5">
                    <span>🏢 <b class="text-dark-text">${nFacilities}</b></span>
                    <span>👤 <b class="text-dark-text">${nUsers}</b> users</span>
                    ${nApps ? `<span>⚙ <b class="text-dark-text">${nApps}</b> apps</span>` : ''}
                    <span>🔗 <b class="text-dark-text">${nLinks}</b></span>
                </div>

                <!-- Legend -->
                <div class="absolute bottom-2 left-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dark-text-secondary
                            bg-dark-card bg-opacity-90 border border-dark-border rounded px-2.5 py-1.5">
                    <!-- Edge / border colors = access level -->
                    <span class="text-dark-text-secondary opacity-60 mr-0.5">Access:</span>
                    <span class="flex items-center gap-1.5">
                        <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="${ACCESS_COLORS[4]}" stroke-width="2.5" stroke-linecap="round"/></svg>Owner
                    </span>
                    <span class="flex items-center gap-1.5">
                        <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="${ACCESS_COLORS[3]}" stroke-width="2.5" stroke-linecap="round"/></svg>Manage
                    </span>
                    <span class="flex items-center gap-1.5">
                        <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="${ACCESS_COLORS[2]}" stroke-width="2.5" stroke-linecap="round"/></svg>ReadWrite
                    </span>
                    <span class="flex items-center gap-1.5">
                        <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="${ACCESS_COLORS[1]}" stroke-width="2.5" stroke-linecap="round"/></svg>Read
                    </span>
                    <!-- Node shapes -->
                    <span class="opacity-60 mx-0.5">|</span>
                    <span class="flex items-center gap-1.5">
                        <svg width="14" height="10"><rect width="14" height="10" rx="2"
                            fill="${FACILITY_FILL}" stroke="${FACILITY_STROKE}" stroke-width="1.5"/></svg>Facility
                    </span>
                    <span class="flex items-center gap-1.5">
                        <svg width="10" height="10"><rect width="10" height="10" rx="2"
                            fill="${APP_FILL}" stroke="${APP_STROKE}" stroke-width="1.5"/></svg>App
                    </span>
                    <span class="flex items-center gap-1.5">
                        <svg width="10" height="10"><circle cx="5" cy="5" r="5" fill="#2a2a2a" stroke="#808080" stroke-width="1.5"/></svg>User
                    </span>
                </div>

                <!-- Hint -->
                <div class="absolute top-2 right-2 z-10 text-xs text-dark-text-secondary opacity-40">
                    scroll to zoom · drag to pan · click nodes
                </div>

                <svg id="access-svg" style="width:100%;height:100%"></svg>
            </div>

            <!-- Info panel -->
            <div class="w-64 shrink-0 border border-dark-border rounded-lg bg-dark-card overflow-y-auto">
                <div id="access-panel" class="p-4">
                    <p class="text-xs text-dark-text-secondary text-center py-8">
                        Click any node to see details
                    </p>
                </div>
            </div>

        </div>`;

    requestAnimationFrame(() => initSimulation(d3));
}

// ── Edge endpoint clipping ─────────────────────────────────────────────────────
// Returns the distance from node center to its visual boundary along direction (ux, uy).
// Circles → radius; Facility rects → rect-edge intersection + small gap.
function edgeClip(node, ux, uy) {
    if (node.type !== 'facility') return UR + 3;          // circles + small gap
    const hw = FR, hh = FR * 0.65;                        // half-width / half-height of facility rect
    const tx = Math.abs(ux) > 0.001 ? hw / Math.abs(ux) : Infinity;
    const ty = Math.abs(uy) > 0.001 ? hh / Math.abs(uy) : Infinity;
    return Math.min(tx, ty) + 3;                           // rect boundary + gap
}

// ── D3 force simulation ────────────────────────────────────────────────────────

function initSimulation(d3) {
    const svgEl = document.getElementById('access-svg');
    if (!svgEl) return;

    const { width: W, height: H } = svgEl.getBoundingClientRect();
    if (!W || !H) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    // Root group — zoom/pan target
    const g = svg.append('g');
    svg.call(
        d3.zoom()
          .scaleExtent([0.05, 6])
          .on('zoom', e => g.attr('transform', e.transform))
    );

    // ── Force simulation ───────────────────────────────────────────────────────
    _simulation = d3.forceSimulation(_nodes)
        .force('link',
            d3.forceLink(_links)
              .id(d => d.id)
              .distance(110)
              .strength(0.35))
        .force('charge',
            d3.forceManyBody()
              .strength(d => d.type === 'facility' ? -700 : -180))
        .force('center', d3.forceCenter(W / 2, H / 2))
        .force('collide',
            d3.forceCollide(d => (d.type === 'facility' ? FR + 8 : UR + 6))
              .strength(0.85));

    // ── Links ──────────────────────────────────────────────────────────────────
    const linkSel = g.append('g').attr('class', 'links')
        .selectAll('line')
        .data(_links)
        .join('line')
        .attr('stroke',         d => ACCESS_COLORS[d.accessLevel] ?? ACCESS_COLORS[1])
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width',   2);

    // ── Node groups ────────────────────────────────────────────────────────────
    const drag = d3.drag()
        .on('start', (e, d) => { if (!e.active) _simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on('end',   (e, d) => { if (!e.active) _simulation.alphaTarget(0); d.fx = null; d.fy = null; });

    const nodeSel = g.append('g').attr('class', 'nodes')
        .selectAll('g')
        .data(_nodes)
        .join('g')
        .style('cursor', 'pointer')
        .call(drag)
        .on('click', (e, d) => { e.stopPropagation(); highlightNode(d, linkSel, nodeSel); });

    svg.on('click', () => clearHighlight(linkSel, nodeSel));

    // ── Facility nodes ─────────────────────────────────────────────────────────
    const facSel = nodeSel.filter(d => d.type === 'facility');

    facSel.append('rect')
        .attr('x', -FR).attr('y', -FR * 0.65)
        .attr('width', FR * 2).attr('height', FR * 1.3)
        .attr('rx', 4)
        .attr('fill',         FACILITY_FILL)
        .attr('stroke',       FACILITY_STROKE)
        .attr('stroke-width', 1.5);

    facSel.append('text')
        .attr('text-anchor', 'middle').attr('dy', '0.35em')
        .attr('font-size', 14)           // no fill — let emoji render in native color
        .text('🏢');

    facSel.append('text')
        .attr('text-anchor', 'middle').attr('dy', FR + 12)
        .attr('font-size', 8).attr('fill', '#707070')
        .text(d => truncate(d.name, 22));

    // ── App nodes (APS service accounts) ──────────────────────────────────────
    const appSel = nodeSel.filter(d => d.type === 'user' && d.isApp);

    appSel.append('rect')
        .attr('x', -UR).attr('y', -UR)
        .attr('width', UR * 2).attr('height', UR * 2)
        .attr('rx', 6)
        .attr('fill',         APP_FILL)
        .attr('stroke',       APP_STROKE)
        .attr('stroke-width', 1.5);

    appSel.append('text')
        .attr('text-anchor', 'middle').attr('dy', '0.38em')
        .attr('font-size', 16)
        .text('⚙');

    // App name label below
    appSel.append('text')
        .attr('text-anchor', 'middle').attr('dy', UR + 12)
        .attr('font-size', 8).attr('fill', APP_STROKE)
        .text(d => truncate(d.name, 18));

    // ── User nodes (real people) ───────────────────────────────────────────────
    // Each user gets a consistent identity color derived from their ID (not access level).
    // Access level is shown on edge colors and the node border stroke.
    const userSel    = nodeSel.filter(d => d.type === 'user' && !d.isApp);
    const identColor = d => userIdentityColor(d.id);          // per-user palette color
    const accessColor = d => ACCESS_COLORS[d.maxAccessLevel ?? 1]; // border = highest level

    // 1. Background circle — identity color fill, access-level border ring
    userSel.append('circle')
        .attr('r',             UR)
        .attr('fill',          identColor)
        .attr('fill-opacity',  0.22)       // use fill-opacity for reliable SVG transparency
        .attr('stroke',        accessColor)
        .attr('stroke-width',  2);

    // 2. Initials text
    userSel.append('text')
        .attr('class',         'initials-text')
        .attr('text-anchor',   'middle')
        .attr('dy',            '0.35em')
        .attr('font-size',     11)
        .attr('font-weight',   '700')
        .attr('fill',          identColor)
        .text(d => initials(d.name || d.email));

    // 3. Name label below the circle
    userSel.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy',          UR + 12)
        .attr('font-size',   8)
        .attr('fill',        '#909090')
        .text(d => truncate((d.name || d.email).split(' ')[0], 14));

    // ── Simulation tick ────────────────────────────────────────────────────────
    _simulation.on('tick', () => {
        linkSel.each(function(d) {
            const sx = d.source.x ?? 0, sy = d.source.y ?? 0;
            const tx = d.target.x ?? 0, ty = d.target.y ?? 0;
            const dx = tx - sx, dy = ty - sy;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const ux = dx / dist, uy = dy / dist;
            // Clip each endpoint to the node's visual boundary
            const srcOff = edgeClip(d.source, ux, uy);
            const tgtOff = edgeClip(d.target, ux, uy);
            d3.select(this)
                .attr('x1', sx + ux * srcOff).attr('y1', sy + uy * srcOff)
                .attr('x2', tx - ux * tgtOff).attr('y2', ty - uy * tgtOff);
        });
        nodeSel.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
}

// ── Highlight / selection ──────────────────────────────────────────────────────

function highlightNode(node, linkSel, nodeSel) {
    const connected = new Set([node.id]);
    const activeLinks = new Set();

    _links.forEach((lk, i) => {
        const src = typeof lk.source === 'object' ? lk.source.id : lk.source;
        const tgt = typeof lk.target === 'object' ? lk.target.id : lk.target;
        if (src === node.id || tgt === node.id) {
            connected.add(src);
            connected.add(tgt);
            activeLinks.add(i);
        }
    });

    linkSel
        .attr('stroke-opacity', (_, i) => activeLinks.has(i) ? 0.95 : 0.1)
        .attr('stroke-width',   (_, i) => activeLinks.has(i) ? 3    : 1.5);

    nodeSel.style('opacity', d => connected.has(d.id) ? 1 : 0.2);

    renderPanel(node);
}

function clearHighlight(linkSel, nodeSel) {
    linkSel.attr('stroke-opacity', 0.6).attr('stroke-width', 2);
    nodeSel.style('opacity', 1);
    const panel = document.getElementById('access-panel');
    if (panel) panel.innerHTML = `<p class="text-xs text-dark-text-secondary text-center py-8">Click any node to see details</p>`;
}

// ── Info panel ─────────────────────────────────────────────────────────────────

function renderPanel(node) {
    const panel = document.getElementById('access-panel');
    if (!panel) return;

    if (node.type === 'facility') {
        const users  = (_facAccessMap.get(node.id) ?? [])
            .slice().sort((a, b) => (b.accessLevel ?? 1) - (a.accessLevel ?? 1));
        const env    = getEnv();
        const base   = env.tandemAppBaseURL.replace('/app', '');
        const url    = `${base}/pages/facilities/${node.id}`;

        const rows = users.map(u => {
            const isApp = !u.email || !String(u.email).includes('@');
            const color = ACCESS_COLORS[u.accessLevel ?? 1];
            const idColor = isApp ? APP_STROKE : userIdentityColor(u.userId);
            // Panel avatars: initials with identity color
            const avatar = isApp
                ? `<div class="w-7 h-7 rounded shrink-0 flex items-center justify-center font-bold text-xs"
                       style="background:${APP_FILL};border:1px solid ${APP_STROKE};color:${APP_STROKE}">⚙</div>`
                : `<div class="w-7 h-7 rounded-full shrink-0 flex items-center justify-center font-bold text-xs"
                       style="background:${hexWithAlpha(idColor,0.22)};border:1.5px solid ${color};color:${idColor}">
                       ${initials(u.name || u.email)}
                   </div>`;

            return `
                <div class="flex items-center gap-2 py-1.5 border-b border-dark-border last:border-0 text-xs">
                    ${avatar}
                    <span class="truncate text-dark-text flex-1 min-w-0">${esc(u.name || u.email || 'Unknown')}</span>
                    <span class="shrink-0" style="color:${color}">${ACCESS_LABELS[u.accessLevel ?? 1] ?? 'Read'}</span>
                </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-start gap-2 pb-3 border-b border-dark-border">
                    <div class="w-9 h-9 rounded shrink-0 flex items-center justify-center text-base"
                         style="background:${FACILITY_FILL};border:1.5px solid ${FACILITY_STROKE}">🏢</div>
                    <div class="min-w-0">
                        <div class="text-sm font-semibold text-dark-text leading-tight">${esc(node.name)}</div>
                        <div class="text-xs text-dark-text-secondary mt-0.5">${(node.region ?? 'us').toUpperCase()}</div>
                    </div>
                </div>
                <p class="text-xs text-dark-text-secondary">
                    ${users.length} member${users.length !== 1 ? 's' : ''} with access
                </p>
                <div class="space-y-0">${rows}</div>
                <a href="${url}" target="_blank" rel="noopener"
                   class="inline-flex items-center gap-1 text-xs text-tandem-blue hover:underline mt-2">
                    Open in Tandem ↗
                </a>
            </div>`;

    } else if (node.isApp) {
        // APS app / service account
        const facilities = node.facilityAccess
            .slice().sort((a, b) => (b.accessLevel ?? 1) - (a.accessLevel ?? 1));
        const rows = facilities.map(f => {
            const c = ACCESS_COLORS[f.accessLevel ?? 1];
            return `
                <div class="flex items-center justify-between py-1.5 border-b border-dark-border last:border-0 text-xs gap-2">
                    <span class="truncate text-dark-text min-w-0">${esc(f.name)}</span>
                    <span class="shrink-0" style="color:${c}">${ACCESS_LABELS[f.accessLevel ?? 1] ?? 'Read'}</span>
                </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-3 pb-3 border-b border-dark-border">
                    <div class="w-10 h-10 rounded shrink-0 flex items-center justify-center text-xl"
                         style="background:${APP_FILL};border:1.5px solid ${APP_STROKE}">⚙</div>
                    <div class="min-w-0">
                        <div class="text-sm font-semibold text-dark-text leading-tight truncate">${esc(node.name)}</div>
                        <div class="text-xs mt-1 px-1.5 py-0.5 rounded-full inline-block"
                             style="background:${hexWithAlpha(APP_STROKE,0.15)};color:${APP_STROKE};border:1px solid ${hexWithAlpha(APP_STROKE,0.4)}">
                            APS Application
                        </div>
                    </div>
                </div>
                <p class="text-xs text-dark-text-secondary">
                    Access to ${facilities.length} facilit${facilities.length !== 1 ? 'ies' : 'y'}
                </p>
                <div class="space-y-0">${rows}</div>
            </div>`;

    } else {
        // Real user
        const color      = ACCESS_COLORS[node.maxAccessLevel ?? 1];
        const facilities = node.facilityAccess
            .slice().sort((a, b) => (b.accessLevel ?? 1) - (a.accessLevel ?? 1));
        const rows = facilities.map(f => {
            const c = ACCESS_COLORS[f.accessLevel ?? 1];
            return `
                <div class="flex items-center justify-between py-1.5 border-b border-dark-border last:border-0 text-xs gap-2">
                    <span class="truncate text-dark-text min-w-0">${esc(f.name)}</span>
                    <span class="shrink-0" style="color:${c}">${ACCESS_LABELS[f.accessLevel ?? 1] ?? 'Read'}</span>
                </div>`;
        }).join('');

        const idColor = userIdentityColor(node.id);
        panel.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-3 pb-3 border-b border-dark-border">
                    <!-- Avatar: initials with identity color (reliable, no auth needed) -->
                    <div class="w-12 h-12 rounded-full shrink-0 flex items-center justify-center font-bold text-base"
                         id="panel-avatar-${safeId(node.id)}"
                         style="background:${hexWithAlpha(idColor,0.22)};border:2px solid ${color};color:${idColor}">
                        ${initials(node.name || node.email)}
                    </div>
                    <div class="min-w-0">
                        <div class="text-sm font-semibold text-dark-text leading-tight truncate">${esc(node.name || 'Unknown')}</div>
                        <div class="text-xs text-dark-text-secondary mt-0.5 truncate">${esc(node.email)}</div>
                        <div class="text-xs mt-1" style="color:${color}">
                            ${ACCESS_LABELS[node.maxAccessLevel ?? 1] ?? 'Read'} (highest)
                        </div>
                    </div>
                </div>
                <p class="text-xs text-dark-text-secondary">
                    Access to ${facilities.length} facilit${facilities.length !== 1 ? 'ies' : 'y'}
                </p>
                <div class="space-y-0">${rows}</div>
            </div>`;

    }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Returns a consistent accent color for a user based on their ID.
 * Independent of access level — makes each person visually distinct.
 */
function userIdentityColor(id) {
    const PALETTE = [
        '#0696D7', // tandem blue
        '#10B981', // emerald
        '#F59E0B', // amber
        '#8B5CF6', // violet
        '#EC4899', // pink
        '#06B6D4', // cyan
        '#84CC16', // lime
        '#F97316', // orange
        '#EF4444', // red
    ];
    let h = 0;
    for (const c of String(id)) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
}

function initials(name = '') {
    const parts = String(name).trim().split(/\s+/);
    return parts.slice(0, 2).map(p => (p[0] ?? '').toUpperCase()).join('') || '?';
}

function truncate(str, max) {
    const s = String(str);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Safe CSS/SVG id from an arbitrary userId string. */
function safeId(id) {
    return 'u' + String(id).replace(/[^a-zA-Z0-9]/g, '_');
}

/** Appends an alpha byte to a 6-digit hex color. e.g. ('#0696D7', 0.15) → '#0696D726' */
function hexWithAlpha(hex, alpha) {
    return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
