/**
 * Chat tools — read-only functions the LLM can call to answer questions about
 * the user's Tandem portfolio. Each tool mirrors something the app already knows
 * (a tab or an api.js helper) and returns a compact, summarized object.
 *
 * Adding a tool: call defineTool(name, description, properties, required, run).
 * run(args, ui) may call ui.chart(spec) to show a chart to the user (rendered by chartRenderer.js).
 * The definition (sent to the model) and the implementation live together.
 *
 * Exports:
 *   setToolContext({ facilities, regionMap, accounts, accountName })
 *   TOOL_DEFS      — OpenAI function-calling definitions (converted for Anthropic by chatView)
 *   executeTool()  — runs a tool and reports failed Tandem requests to the model
 */

import {
    tandemBaseURL,
    getDefaultModelURN,
    getGroupMetrics,
    getFacilityInfo,
    getInlineTemplate,
    getModels,
    getElementCount,
    getFacilityParameters,
    getDocuments,
    getFacilityViews,
    getLevels,
    getRooms,
    getSystems,
    getTaggedAssetsDetails,
    getSchema,
    getStreams,
    getLastSeenStreamValues,
    getStreamValues,
    getTickets,
    getTwinHistory,
    getHistory,
    getFacilityUsers,
} from '../api.js';
import { getStatsStore } from '../views/portfolioView.js';
import { getCachedSummary } from '../state/facilityCache.js';
import { getLocation } from '../state/locationStore.js';
import { isDefaultModel } from '../utils.js';
import { HC, QC } from '../../tandem/constants.js';
import { toShortKey } from '../../tandem/keys.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const DAY_MS        = 24 * 60 * 60 * 1000;
const ONLINE_MS     = DAY_MS;          // stream data < 24h  → online
const SILENT_MS     = 7 * DAY_MS;      // stream data < 7d   → silent, else offline
const ACTIVE_MS     = 7 * DAY_MS;      // facility activity < 7d  → active
const QUIET_MS      = 30 * DAY_MS;     // facility activity < 30d → quiet, else idle
const HISTORY_LOOKBACK_MS = 90 * DAY_MS;
const OUTLIER_SIGMA = 1.5;             // same threshold as the Compare tab
const CONCURRENCY   = 5;
const MAX_PORTFOLIO_SCAN = 100;        // facilities scanned by portfolio-wide tools
const IGNORED_OPS   = new Set(['metrics_update']);
const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Trivial: 4 };
const ACCESS_RANK   = { Owner: 4, Manage: 3, ReadWrite: 2, Read: 1, None: 0 };

// ── Context (set by chatView whenever the account changes) ─────────────────────
const ctx = { facilities: [], regionMap: null, accounts: [], accountName: '' };

export function setToolContext(next) {
    Object.assign(ctx, next);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const regionFor    = f => ctx.regionMap?.get(f.urn) ?? f.region ?? 'us';
const findFacility = urn => ctx.facilities.find(f => f.urn === urn) ?? null;
const iso          = ts => (ts ? new Date(ts).toISOString() : null);
const round        = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Resolves args.facility_urn → { f, region } or null when unknown. */
function resolveFacility(args) {
    const f = findFacility(args?.facility_urn);
    return f ? { f, region: regionFor(f) } : null;
}

const facilityNotFound = args => ({
    error: `Facility not found: ${args?.facility_urn ?? '(missing facility_urn)'}. Use list_facilities to get valid URNs.`,
});

/** Runs fn over items with bounded concurrency; a failed item yields null. */
async function mapPool(items, limit, fn) {
    const out = new Array(items.length).fill(null);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            try { out[i] = await fn(items[i], i); } catch (err) { console.warn('[Chat] tool item failed:', err); }
        }
    });
    await Promise.all(workers);
    return out;
}

const entryName = row => row[QC.OName]?.[0] ?? row[QC.Name]?.[0] ?? 'Unnamed';

function mapTicket(t) {
    return {
        name:      entryName(t),
        priority:  t[QC.Priority]?.[0] ?? 'Unknown',
        status:    t[QC.CloseDate]?.[0] ? 'closed' : 'open',
        openDate:  t[QC.OpenDate]?.[0]  ?? null,
        closeDate: t[QC.CloseDate]?.[0] ?? null,
    };
}

const byPriority = (a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);

function countBy(items, keyFn) {
    const out = {};
    for (const item of items) {
        const k = keyFn(item);
        out[k] = (out[k] ?? 0) + 1;
    }
    return out;
}

function formatMetrics(m) {
    if (!m) return { error: 'Account metrics could not be loaded' };
    if (m._forbidden) return { forbidden: true, note: 'No permission to read metrics (not an account owner)' };
    return {
        facilities:      m.activeFacilityCount ?? 0,
        models:          m.totalNbOfModel      ?? 0,
        streams:         m.numStreams          ?? 0,
        taggedAssets:    m.totalNbOfAssets     ?? 0,
        dataConnections: m.numDataConn         ?? 0,
        elements:        m.totalNbOfElement    ?? 0,
        storageGB:       round((m.totalBytesUsed ?? 0) / 1_073_741_824, 2),
        asOf:            m.updatedOn ?? null,   // pre-computed by Tandem; may lag by up to a day
    };
}

/** Latest timestamp found in a last-seen / time-series value map ({ prop: { tsMs: value } }). */
function latestTimestamp(propMap) {
    let max = 0;
    for (const inner of Object.values(propMap ?? {})) {
        if (!inner || typeof inner !== 'object') continue;
        for (const tsStr of Object.keys(inner)) {
            const ts = Number(tsStr);
            if (ts > max) max = ts;
        }
    }
    return max;
}

/** Stream health for one facility: per-stream status from last-seen timestamps. */
async function loadStreamHealth(f, region) {
    const empty = { total: 0, summary: { online: 0, silent: 0, offline: 0 }, streams: [], latestTs: null };
    const streams = await getStreams(f.urn, region);
    if (!streams?.length) return empty;

    const keys     = streams.map(s => s[QC.Key]).filter(Boolean);
    const lastSeen = await getLastSeenStreamValues(f.urn, region, keys);

    // API returns long keys; streams carry short keys
    const lastTsByKey = new Map();
    for (const [longKey, propMap] of Object.entries(lastSeen ?? {})) {
        let shortKey;
        try { shortKey = toShortKey(longKey); } catch { continue; }
        lastTsByKey.set(shortKey, latestTimestamp(propMap));
    }

    const now = Date.now();
    let latestTs = 0;
    const rows = streams.map(stream => {
        const key    = stream[QC.Key];
        const lastTs = lastTsByKey.get(key) || 0;
        const age    = lastTs ? now - lastTs : Infinity;
        if (lastTs > latestTs) latestTs = lastTs;
        return {
            key,
            name:     entryName(stream),
            status:   age < ONLINE_MS ? 'online' : age < SILENT_MS ? 'silent' : 'offline',
            lastSeen: iso(lastTs) ?? 'never',
        };
    });

    return {
        total: rows.length,
        summary: {
            online:  rows.filter(r => r.status === 'online').length,
            silent:  rows.filter(r => r.status === 'silent').length,
            offline: rows.filter(r => r.status === 'offline').length,
        },
        streams: rows,
        latestTs: latestTs || null,
    };
}

/** Qualified property id → "Category.Name" for a model schema. */
async function loadPropertyNames(modelURN, region) {
    const schema = await getSchema(modelURN, region);
    const names = new Map();
    for (const attr of schema?.attributes ?? []) {
        names.set(attr.id, { label: [attr.category, attr.name].filter(Boolean).join('.') || attr.id, unit: attr.forgeUnit || '' });
    }
    return names;
}

function cachedStats(urn) {
    const s = getStatsStore().get(urn);
    const c = getCachedSummary(urn);
    return {
        loaded:       !!s,
        streams:      s?.streamCount        ?? null,
        taggedAssets: s?.taggedAssetCount   ?? null,
        openTickets:  s?.openTicketCount    ?? null,
        closedTickets: s?.closedTicketCount ?? null,
        template:     s?.templateName ?? c?.templateName ?? null,
        models:       c?.modelCount ?? null,
        address:      c?.address    ?? null,
    };
}

// ── Tool registry ──────────────────────────────────────────────────────────────
const TOOLS = new Map();

function defineTool(name, description, properties, required, run) {
    TOOLS.set(name, {
        run,
        def: {
            type: 'function',
            function: {
                name,
                description,
                parameters: { type: 'object', properties, required },
            },
        },
    });
}

const FACILITY_PROP = {
    facility_urn: { type: 'string', description: 'Facility URN (urn:adsk.dtt:…) — get it from list_facilities' },
};

// ═══ Account level ═════════════════════════════════════════════════════════════

defineTool('list_accounts',
    'List every account (team) the user belongs to, with its facility count and — by default — ' +
    'account-level totals (facilities, models, streams, tagged assets, data connections, elements, storage). ' +
    'Use for questions that compare or rank accounts.',
    { include_metrics: { type: 'boolean', description: 'Fetch account totals (default true)' } },
    [],
    async (args) => {
        const accounts = ctx.accounts ?? [];
        const withMetrics = args.include_metrics !== false;
        const metrics = withMetrics
            ? await mapPool(accounts, CONCURRENCY, a => (a.id === '@me' ? null : getGroupMetrics(a.id)))
            : [];
        return {
            currentAccount: ctx.accountName,
            accounts: accounts.map((a, i) => ({
                name:          a.name,
                isCurrent:     a.name === ctx.accountName,
                facilityCount: a.facilityCount ?? a.facilities?.length ?? null,
                ...(withMetrics
                    ? { metrics: a.id === '@me' ? { note: 'Facilities shared directly — no account totals' } : formatMetrics(metrics[i]) }
                    : {}),
            })),
        };
    });

defineTool('get_account_metrics',
    'Get account-level totals (facilities, models, streams, tagged assets, data connections, elements, storage) ' +
    'for one account. Defaults to the currently selected account.',
    { account: { type: 'string', description: 'Account name (default: the current account)' } },
    [],
    async (args) => {
        const wanted = (args.account ?? ctx.accountName ?? '').toLowerCase();
        const accounts = ctx.accounts ?? [];
        const account = accounts.find(a => a.name.toLowerCase() === wanted)
            ?? accounts.find(a => a.name.toLowerCase().includes(wanted));
        if (!account) return { error: `Account not found: ${args.account}. Use list_accounts.` };
        if (account.id === '@me') return { account: account.name, note: 'Facilities shared directly — no account totals' };
        return { account: account.name, metrics: formatMetrics(await getGroupMetrics(account.id)) };
    });

// ═══ Portfolio overview (cached data, no API calls) ════════════════════════════

defineTool('list_facilities',
    'List the facilities in the current account with name, URN, region, tags, template, model count, address, ' +
    'map location (if set) and cached stats (streams, tagged assets, open/closed tickets). ' +
    'Stats may be null while still loading in the background.',
    {
        sort_by: {
            type: 'string',
            enum: ['name', 'streams', 'tagged_assets', 'open_tickets', 'models'],
            description: 'Sort order (default: name). Numeric sorts are descending.',
        },
        limit: { type: 'integer', description: 'Max facilities to return (default 100, max 300)' },
    },
    [],
    async (args) => {
        const sortKey = {
            streams: 'streams', tagged_assets: 'taggedAssets', open_tickets: 'openTickets', models: 'models',
        }[args.sort_by];
        const limit = clamp(args.limit, 1, 300, 100);

        const rows = ctx.facilities.map(f => {
            const s   = cachedStats(f.urn);
            const loc = getLocation(f.urn);
            return {
                name:          f.name,
                urn:           f.urn,
                region:        regionFor(f),
                tags:          (f.labels ?? []).map(String),
                template:      s.template,
                modelCount:    s.models,
                address:       s.address,
                location:      loc ? { lat: loc.lat, lng: loc.lng, label: loc.label ?? null } : null,
                streamCount:   s.streams,
                taggedAssetCount: s.taggedAssets,
                openTicketCount:  s.openTickets,
                closedTicketCount: s.closedTickets,
                statsLoaded:   s.loaded,
                _sort:         sortKey ? (s[sortKey] ?? -1) : 0,
            };
        });

        if (sortKey) rows.sort((a, b) => b._sort - a._sort);
        else rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        const returned = rows.slice(0, limit).map(({ _sort, ...r }) => r);
        return {
            account: ctx.accountName,
            totalFacilities: rows.length,
            statsStillLoading: rows.filter(r => !r.statsLoaded).length,
            returned: returned.length,
            facilities: returned,
        };
    });

defineTool('find_outliers',
    'Find facilities whose streams, tagged assets, models or open tickets are statistically unusual ' +
    `(beyond ${OUTLIER_SIGMA} standard deviations from the account average) — the same analysis as the Compare tab.`,
    {},
    [],
    async () => {
        const rows = ctx.facilities.map(f => ({ f, s: cachedStats(f.urn) })).filter(r => r.s.loaded);
        if (rows.length < 3) {
            return { note: 'Need stats for at least 3 facilities; they may still be loading.', facilitiesWithStats: rows.length };
        }

        const metrics = [
            { key: 'streams',      label: 'Streams' },
            { key: 'taggedAssets', label: 'Tagged assets' },
            { key: 'models',       label: 'Models' },
            { key: 'openTickets',  label: 'Open tickets' },
        ];
        const outliers = [];
        for (const m of metrics) {
            const pts = rows.filter(r => r.s[m.key] != null);
            if (pts.length < 3) continue;
            const values = pts.map(r => r.s[m.key]);
            const mean   = values.reduce((a, b) => a + b, 0) / values.length;
            const sd     = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
            if (sd < 0.5) continue;
            for (const r of pts) {
                const z = (r.s[m.key] - mean) / sd;
                if (Math.abs(z) >= OUTLIER_SIGMA) {
                    outliers.push({
                        facility: r.f.name, metric: m.label, value: r.s[m.key],
                        accountAverage: round(mean, 1), direction: z > 0 ? 'above' : 'below', sigma: round(Math.abs(z), 1),
                    });
                }
            }
        }
        outliers.sort((a, b) => b.sigma - a.sigma);
        return {
            facilitiesWithStats: rows.length,
            facilitiesTotal: ctx.facilities.length,
            outliers: outliers.slice(0, 25),
        };
    });

// ═══ Facility details ══════════════════════════════════════════════════════════

defineTool('get_facility_details',
    'Get the profile of one facility: building name, address, owner, project name, time zone, template, ' +
    'schema version, number of models and documents, tags, map location, and cached stats.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const { f, region } = ff;

        const [info, template] = await Promise.all([
            getFacilityInfo(f.urn, region),
            getInlineTemplate(f.urn, region),
        ]);
        const identity = info?.props?.['Identity Data'] ?? {};
        const loc = getLocation(f.urn);
        const s = cachedStats(f.urn);

        return {
            name:          f.name,
            urn:           f.urn,
            region,
            buildingName:  identity['Building Name'] ?? null,
            address:       identity['Address']       ?? null,
            owner:         identity['Owner']         ?? null,
            projectName:   identity['Project Name']  ?? null,
            timeZone:      identity['timeZone']      ?? null,
            template:      info?.template?.name ?? template?.name ?? null,
            schemaVersion: info?.schemaVersion ?? null,
            modelCount:    Array.isArray(info?.links) ? info.links.length : null,
            documentCount: Array.isArray(info?.docs)  ? info.docs.length  : null,
            tags:          (f.labels ?? []).map(String),
            location:      loc ? { lat: loc.lat, lng: loc.lng, label: loc.label ?? null } : null,
            stats: {
                streams: s.streams, taggedAssets: s.taggedAssets,
                openTickets: s.openTickets, closedTickets: s.closedTickets,
            },
        };
    });

defineTool('get_models',
    'List the models in a facility (e.g. Revit BIM imports, plus the default model). ' +
    'Optionally include each model\'s element count (slower — one scan per model).',
    {
        ...FACILITY_PROP,
        include_element_counts: { type: 'boolean', description: 'Also count elements in each model (default false)' },
    },
    ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const { f, region } = ff;

        const models = (await getModels(f.urn, region)) ?? [];
        const MAX_COUNTED = 25;
        const counts = args.include_element_counts
            ? await mapPool(models.slice(0, MAX_COUNTED), CONCURRENCY, m => getElementCount(m.modelId, region))
            : [];

        return {
            facilityName: f.name,
            modelCount: models.length,
            models: models.map((m, i) => ({
                name:      m.label ?? m.name ?? 'Unnamed',
                urn:       m.modelId ?? m.urn ?? '',
                isDefault: isDefaultModel(f.urn, m.modelId),
                ...(args.include_element_counts && i < MAX_COUNTED ? { elementCount: counts[i] } : {}),
            })),
        };
    });

defineTool('get_facility_parameters',
    'Get the facility-level parameters (custom properties on the facility root, e.g. Identity Data, ' +
    'Operations and Maintenance settings) with their values and units.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const params = (await getFacilityParameters(ff.f.urn, ff.region)) ?? [];
        return {
            facilityName: ff.f.name,
            parameterCount: params.length,
            parameters: params.slice(0, 100).map(p => ({
                category: p.category, name: p.name, value: p.value ?? null, unit: p.forgeUnit || undefined,
            })),
        };
    });

defineTool('get_documents',
    'List the documents attached to a facility (name, type, size, last updated). Links are not returned.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const docs = (await getDocuments(ff.f.urn, ff.region)) ?? [];
        return {
            facilityName: ff.f.name,
            documentCount: docs.length,
            documents: docs.slice(0, 100).map(d => ({
                name:        d.name ?? 'Untitled',
                label:       d.label ?? null,
                contentType: d.contentType ?? null,
                sizeMB:      d.size ? round(d.size / 1_048_576, 2) : null,
                lastUpdated: iso(d.lastUpdated),
            })),
        };
    });

defineTool('get_saved_views',
    'List the saved views in a facility (name, author, created date, label, level filters).',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const views = (await getFacilityViews(ff.f.urn, ff.region)) ?? [];
        return {
            facilityName: ff.f.name,
            viewCount: views.length,
            views: views.slice(0, 100).map(v => ({
                name:    v.viewName || 'Unnamed',
                author:  v.author?.name ?? null,
                created: iso(v.createTime ? Date.parse(v.createTime) : null),
                label:   v.label || null,
                levels:  v.facets?.filters?.levels ?? [],
            })),
        };
    });

defineTool('get_levels',
    'List the levels (floors) of a facility across all its models, ordered by elevation.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const levels = (await getLevels(ff.f.urn, ff.region)) ?? [];
        levels.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
        return {
            facilityName: ff.f.name,
            levelCount: levels.length,
            levels: levels.slice(0, 100).map(l => ({ name: l.name, elevation: l.elevation ?? null, model: l.modelName })),
        };
    });

defineTool('get_rooms',
    'Get the rooms and spaces of a facility: counts, total area, and the largest ones. ' +
    'Supports filtering by name.',
    {
        ...FACILITY_PROP,
        search: { type: 'string', description: 'Only rooms/spaces whose name contains this text' },
        limit:  { type: 'integer', description: 'Max rooms to list, largest first (default 25, max 100)' },
    },
    ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const { f, region } = ff;

        // Resolve each model's schema with the facility's region (getRooms would otherwise omit it)
        const models = (await getModels(f.urn, region)) ?? [];
        const schemaCache = {};
        await mapPool(models, CONCURRENCY, async m => { schemaCache[m.modelId] = await getSchema(m.modelId, region); });

        let rooms = (await getRooms(f.urn, region, schemaCache)) ?? [];
        const q = String(args.search ?? '').trim().toLowerCase();
        if (q) rooms = rooms.filter(r => r.name.toLowerCase().includes(q));

        const areaUnit  = rooms.find(r => r.areaUnit)?.areaUnit ?? null;
        const totalArea = rooms.reduce((sum, r) => sum + (Number(r.area) || 0), 0);
        const sorted    = [...rooms].sort((a, b) => (Number(b.area) || 0) - (Number(a.area) || 0));

        return {
            facilityName: f.name,
            counts: countBy(rooms, r => r.type),
            total: rooms.length,
            totalArea: round(totalArea, 1),
            areaUnit,
            rooms: sorted.slice(0, clamp(args.limit, 1, 100, 25)).map(r => ({
                name: r.name, type: r.type, area: round(Number(r.area), 1), volume: round(Number(r.volume), 1), model: r.modelName,
            })),
        };
    });

defineTool('get_systems',
    'List the MEP systems of a facility (e.g. HVAC, electrical) with element counts and subsystem names.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const { f, region } = ff;

        const models  = (await getModels(f.urn, region)) ?? [];
        const systems = (await getSystems(f.urn, region, models)) ?? [];
        systems.sort((a, b) => (b.elementCount ?? 0) - (a.elementCount ?? 0));
        return {
            facilityName: f.name,
            systemCount: systems.length,
            systems: systems.slice(0, 60).map(s => ({
                name: s.name,
                elementCount: s.elementCount ?? 0,
                subsystems: (s.subsystems ?? []).slice(0, 10).map(x => x.name),
                subsystemCount: (s.subsystems ?? []).length,
            })),
        };
    });

defineTool('get_tagged_assets',
    'Get the tagged-asset count of a facility and which custom properties (e.g. Manufacturer, Model, Serial) ' +
    'are most used on those assets.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const { f, region } = ff;

        const details = await getTaggedAssetsDetails(f.urn, region);
        const usage   = details?.propertyUsageByModel ?? {};

        const totals = new Map();
        await mapPool(Object.entries(usage), CONCURRENCY, async ([modelId, { props }]) => {
            const names = await loadPropertyNames(modelId, region);
            for (const [propId, count] of Object.entries(props)) {
                const label = names.get(propId)?.label ?? propId;
                totals.set(label, (totals.get(label) ?? 0) + count);
            }
        });

        return {
            facilityName: f.name,
            taggedAssetCount: details?.totalCount ?? 0,
            topProperties: [...totals.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 25)
                .map(([property, assetsWithValue]) => ({ property, assetsWithValue })),
        };
    });

// ═══ Streams ═══════════════════════════════════════════════════════════════════

defineTool('get_stream_health',
    'Get IoT stream health for one facility: each stream with status online (data within 24 h), ' +
    'silent (1–7 days) or offline (>7 days), and when it was last seen. Offline streams are listed first.',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);

        const health = await loadStreamHealth(ff.f, ff.region);
        const order = { offline: 0, silent: 1, online: 2 };
        const sorted = [...health.streams].sort((a, b) => order[a.status] - order[b.status]);
        const MAX = 100;
        return {
            facilityName: ff.f.name,
            summary: health.summary,
            totalStreams: health.total,
            streams: sorted.slice(0, MAX),
            ...(sorted.length > MAX ? { truncated: sorted.length - MAX } : {}),
        };
    });

/**
 * Resolve a stream by name/key and read its readings for the last `days` days.
 * The time-series endpoint can return more history than requested, so the window
 * is also applied here. Returns { failure } (a tool result) when it can't proceed.
 */
async function readStream(args) {
    const ff = resolveFacility(args);
    if (!ff) return { failure: facilityNotFound(args) };
    const { f, region } = ff;

    const wanted = String(args.stream ?? '').trim().toLowerCase();
    if (!wanted) return { failure: { error: 'Missing stream name or key' } };

    const streams = (await getStreams(f.urn, region)) ?? [];
    const named   = streams.map(s => ({ key: s[QC.Key], name: entryName(s) }));
    let matches = named.filter(s => s.key === args.stream);
    if (!matches.length) matches = named.filter(s => s.name.toLowerCase() === wanted);
    if (!matches.length) matches = named.filter(s => s.name.toLowerCase().includes(wanted));
    if (!matches.length) {
        return { failure: { error: `No stream matches "${args.stream}"`, availableStreams: named.slice(0, 25).map(s => s.name) } };
    }
    if (matches.length > 1) {
        return { failure: { error: `"${args.stream}" matches ${matches.length} streams — be more specific`, matches: matches.slice(0, 10) } };
    }

    const stream = matches[0];
    const days   = clamp(args.days, 1, 30, 7);
    const cutoff = Date.now() - days * DAY_MS;
    const [data, names] = await Promise.all([
        getStreamValues(f.urn, region, stream.key, days),
        loadPropertyNames(getDefaultModelURN(f.urn), region),
    ]);

    const series = [];
    let latestEver = 0;
    for (const [propId, raw] of Object.entries(data ?? {})) {
        if (propId === 'k' || !raw || typeof raw !== 'object') continue;
        const all = Object.entries(raw)
            .map(([ts, value]) => ({ ts: Number(ts), value }))
            .filter(p => Number.isFinite(p.ts));
        for (const p of all) if (p.ts > latestEver) latestEver = p.ts;

        const points = all.filter(p => p.ts >= cutoff).sort((a, b) => a.ts - b.ts);
        if (!points.length) continue;
        const meta = names.get(propId);
        series.push({
            property: meta?.label ?? propId,
            unit: meta?.unit || undefined,
            points,
            numeric: points.every(p => p.value !== null && p.value !== '' && Number.isFinite(Number(p.value))),
        });
    }

    return { f, stream, days, series, latestEver };
}

function describeSeries(s, { withSample }) {
    const { points } = s;
    const base = {
        property: s.property,
        unit:     s.unit,
        points:   points.length,
        first:    { time: iso(points[0].ts),    value: points[0].value },
        latest:   { time: iso(points.at(-1).ts), value: points.at(-1).value },
    };
    if (!s.numeric) {
        return { ...base, distinctValues: [...new Set(points.map(p => String(p.value)))].slice(0, 10) };
    }
    const vals = points.map(p => Number(p.value));
    const step = Math.max(1, Math.floor(points.length / 12));
    return {
        ...base,
        min: round(Math.min(...vals), 3),
        max: round(Math.max(...vals), 3),
        average: round(vals.reduce((a, b) => a + b, 0) / vals.length, 3),
        ...(withSample ? { sample: points.filter((_, i) => i % step === 0).slice(0, 12).map(p => [iso(p.ts), round(Number(p.value), 3)]) } : {}),
    };
}

const noDataResult = r => ({
    facilityName: r.f.name,
    stream: r.stream.name,
    requestedDays: r.days,
    note: r.latestEver
        ? `No readings in the last ${r.days} days. The most recent reading was ${iso(r.latestEver)}.`
        : 'This stream has no readings.',
});

const STREAM_ARGS = {
    ...FACILITY_PROP,
    stream: { type: 'string', description: 'Stream name (or part of it) or stream key — see get_stream_health' },
    days:   { type: 'integer', description: 'Days of data (default 7, max 30)' },
};

defineTool('get_stream_values',
    'Get recent time-series readings for ONE stream (e.g. a temperature sensor) as numbers: per property the ' +
    'count, min, max, average, first/latest value and a sample of points. Use this to ANALYZE readings. ' +
    'To show the user a chart of them, use chart_stream_values instead.',
    STREAM_ARGS, ['facility_urn', 'stream'],
    async (args) => {
        const r = await readStream(args);
        if (r.failure) return r.failure;
        if (!r.series.length) return noDataResult(r);
        return {
            facilityName: r.f.name,
            stream: r.stream.name,
            requestedDays: r.days,
            properties: r.series.map(s => describeSeries(s, { withSample: true })),
        };
    });

defineTool('chart_stream_values',
    'Draw an interactive line chart of ONE stream\'s readings directly in the chat (full resolution, all numeric ' +
    'properties, last N days). The user sees the chart; you receive only summary statistics. Prefer this over ' +
    'writing HTML or code when the user asks to see, plot, graph or chart sensor data.',
    STREAM_ARGS, ['facility_urn', 'stream'],
    async (args, ui) => {
        const r = await readStream(args);
        if (r.failure) return r.failure;
        const plottable = r.series.filter(s => s.numeric);
        if (!plottable.length) {
            return r.series.length
                ? { ...noDataResult(r), note: 'The readings are not numeric, so they cannot be charted.' }
                : noDataResult(r);
        }

        ui.chart({
            kind: 'line',
            title: `${r.stream.name} — ${r.f.name}`,
            subtitle: `Last ${r.days} day${r.days === 1 ? '' : 's'}`,
            xType: 'time',
            datasets: plottable.map(s => ({
                label: s.unit ? `${s.property} (${s.unit})` : s.property,
                data: s.points.map(p => ({ x: p.ts, y: Number(p.value) })),
            })),
        });

        return {
            displayed: 'A chart is now shown to the user in the chat — do not repeat the data or write chart code.',
            facilityName: r.f.name,
            stream: r.stream.name,
            requestedDays: r.days,
            properties: plottable.map(s => describeSeries(s, { withSample: false })),
        };
    });

defineTool('show_chart',
    'Draw a chart (bar, line, pie or doughnut) directly in the chat from numbers you already have — e.g. streams ' +
    'per facility, tickets by priority, rooms by area. Use after gathering data with other tools, when the user ' +
    'asks for a chart/graph/plot. The user sees the chart; do not also write chart code or HTML. For sensor ' +
    'time series use chart_stream_values instead.',
    {
        type:   { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'], description: 'Chart type' },
        title:  { type: 'string', description: 'Chart title' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Category labels (x axis, or slices for pie/doughnut)' },
        datasets: {
            type: 'array',
            description: 'One or more series; each data array must have the same length as labels',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'Series name' },
                    data:  { type: 'array', items: { type: 'number' }, description: 'Numbers, one per label' },
                },
                required: ['label', 'data'],
            },
        },
        y_label:    { type: 'string', description: 'Y-axis label, including units (optional)' },
        horizontal: { type: 'boolean', description: 'Horizontal bars — good for long facility names (bar only)' },
        stacked:    { type: 'boolean', description: 'Stack the series (bar only)' },
    },
    ['type', 'labels', 'datasets'],
    async (args, ui) => {
        const labels   = Array.isArray(args.labels) ? args.labels.map(String) : [];
        const datasets = (Array.isArray(args.datasets) ? args.datasets : [])
            .map(d => ({ label: String(d?.label ?? ''), data: Array.isArray(d?.data) ? d.data.map(Number) : [] }))
            .filter(d => d.data.length);
        if (!labels.length || !datasets.length) return { error: 'show_chart needs non-empty labels and datasets' };
        if (datasets.some(d => d.data.length !== labels.length)) {
            return { error: 'Each dataset must have exactly one number per label' };
        }

        ui.chart({
            kind: args.type,
            title: args.title,
            xType: 'category',
            labels,
            datasets,
            yLabel: args.y_label,
            horizontal: !!args.horizontal,
            stacked: !!args.stacked,
        });
        return { displayed: 'The chart is now shown to the user in the chat — do not repeat the data or write chart code.' };
    });

// ═══ Tickets ═══════════════════════════════════════════════════════════════════

defineTool('get_tickets',
    'Get work-order tickets for one facility: name, priority (Critical/High/Medium/Low/Trivial), status ' +
    '(open/closed) and dates, sorted by priority. Includes open/closed totals and a priority breakdown of open tickets.',
    {
        ...FACILITY_PROP,
        status: { type: 'string', enum: ['all', 'open', 'closed'], description: 'Filter by status (default all)' },
        limit:  { type: 'integer', description: 'Max tickets to list (default 50, max 200)' },
    },
    ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);

        const mapped = ((await getTickets(ff.f.urn, ff.region)) ?? []).map(mapTicket);
        const status = args.status ?? 'all';
        const filtered = (status === 'all' ? mapped : mapped.filter(t => t.status === status)).sort(byPriority);
        const limit = clamp(args.limit, 1, 200, 50);

        return {
            facilityName: ff.f.name,
            summary: {
                open:   mapped.filter(t => t.status === 'open').length,
                closed: mapped.filter(t => t.status === 'closed').length,
                openByPriority: countBy(mapped.filter(t => t.status === 'open'), t => t.priority),
            },
            matching: filtered.length,
            tickets: filtered.slice(0, limit),
        };
    });

defineTool('get_portfolio_tickets',
    'List tickets across ALL facilities in the account, sorted by priority — e.g. "all open critical tickets". ' +
    'Returns overall counts, a priority breakdown, and the top tickets with their facility.',
    {
        status:   { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by status (default open)' },
        priority: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Trivial'], description: 'Only this priority' },
        limit:    { type: 'integer', description: 'Max tickets to list (default 40, max 200)' },
    },
    [],
    async (args) => {
        const status = args.status ?? 'open';
        const store  = getStatsStore();

        // Skip facilities already known to have no matching tickets (saves a scan each)
        const targets = ctx.facilities.slice(0, MAX_PORTFOLIO_SCAN).filter(f => {
            const s = store.get(f.urn);
            if (!s || s.ticketsError) return true;   // unknown or failed count — scan to be sure
            const open = s.openTicketCount ?? 0, closed = s.closedTicketCount ?? 0;
            return status === 'open' ? open > 0 : status === 'closed' ? closed > 0 : open + closed > 0;
        });

        const perFacility = await mapPool(targets, CONCURRENCY, async f => {
            const tickets = (await getTickets(f.urn, regionFor(f))) ?? [];
            return tickets.map(mapTicket).map(t => ({ facility: f.name, ...t }));
        });

        let all = perFacility.flat().filter(Boolean);
        if (status !== 'all') all = all.filter(t => t.status === status);
        if (args.priority)    all = all.filter(t => t.priority === args.priority);
        all.sort(byPriority);

        return {
            account: ctx.accountName,
            facilitiesScanned: targets.length,
            facilitiesFailed: perFacility.filter(r => r === null).length,
            matching: all.length,
            byPriority: countBy(all, t => t.priority),
            byFacility: countBy(all, t => t.facility),
            tickets: all.slice(0, clamp(args.limit, 1, 200, 40)),
        };
    });

// ═══ Activity ══════════════════════════════════════════════════════════════════

defineTool('get_recent_activity',
    'Get recent change history for ONE facility: facility-level changes (settings, access, imports…) and ' +
    'model-level changes (property edits etc.) — totals, unique contributors, breakdown by type, and the latest events.',
    {
        ...FACILITY_PROP,
        days: { type: 'integer', description: 'Days of history (default 30, max 90)' },
    },
    ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);
        const { f, region } = ff;

        const days = clamp(args.days, 1, 90, 30);
        const max  = Date.now();
        const min  = max - days * DAY_MS;
        const MODEL_HISTORY_LIMIT = 200;

        const [twinHistory, models] = await Promise.all([
            getTwinHistory(f.urn, region, { min, max, includeChanges: true }),
            getModels(f.urn, region),
        ]);
        const facilityEvents = (twinHistory ?? []).filter(e => !IGNORED_OPS.has(e[HC.Operation]));

        const modelResults = await mapPool(models ?? [], CONCURRENCY, async m => {
            const h = (await getHistory(m.modelId, region, { min, max, includeChanges: true, limit: MODEL_HISTORY_LIMIT })) ?? [];
            return { name: m.label ?? 'Unnamed', events: h.filter(e => !IGNORED_OPS.has(e[HC.Operation])) };
        });
        const modelRows = modelResults.filter(Boolean);

        const allEvents = [...facilityEvents, ...modelRows.flatMap(r => r.events)];
        const contributors = new Set(allEvents.map(e => e[HC.Username]).filter(Boolean));
        const latest = [...facilityEvents].sort((a, b) => (b[HC.Timestamp] ?? 0) - (a[HC.Timestamp] ?? 0)).slice(0, 15);

        return {
            facilityName: f.name,
            days,
            facilityChanges: facilityEvents.length,
            facilityChangesByType: countBy(facilityEvents, e => e[HC.Operation]),
            modelChanges: {
                total: modelRows.reduce((s, r) => s + r.events.length, 0),
                modelsChanged: modelRows.filter(r => r.events.length > 0).length,
                modelsTotal: (models ?? []).length,
                perModel: modelRows.filter(r => r.events.length > 0).map(r => ({
                    model: r.name, changes: r.events.length,
                    ...(r.events.length >= MODEL_HISTORY_LIMIT ? { cappedAt: MODEL_HISTORY_LIMIT } : {}),
                })),
            },
            uniqueContributors: contributors.size,
            contributors: [...contributors].slice(0, 15),
            latestFacilityEvents: latest.map(e => ({
                time: iso(e[HC.Timestamp]), operation: e[HC.Operation], user: e[HC.Username] ?? 'unknown',
            })),
        };
    });

defineTool('get_portfolio_activity',
    'Compare activity across ALL facilities (same data as the Activity tab): when each facility last had a change ' +
    'or received stream data, an active/quiet/idle status (active <7 days, quiet <30, idle otherwise), changes and ' +
    'contributors in a window, and stream health. Stalest facilities come first. Use for "which facilities have ' +
    'had no activity" questions.',
    {
        days: { type: 'integer', description: 'Window for change/contributor counts (default 30, max 90)' },
        include_streams: { type: 'boolean', description: 'Count stream data as activity and report stream health (default true; slower)' },
    },
    [],
    async (args) => {
        const days = clamp(args.days, 1, 90, 30);
        const includeStreams = args.include_streams !== false;
        const now = Date.now();
        const targets = ctx.facilities.slice(0, MAX_PORTFOLIO_SCAN);

        const rows = await mapPool(targets, CONCURRENCY, async f => {
            const region = regionFor(f);
            const [history, health] = await Promise.all([
                getTwinHistory(f.urn, region, { min: now - HISTORY_LOOKBACK_MS, max: now, includeChanges: true }),
                includeStreams ? loadStreamHealth(f, region) : Promise.resolve(null),
            ]);

            const events = (history ?? []).filter(e => !IGNORED_OPS.has(e[HC.Operation]));
            let lastTs = 0, lastSource = null;
            for (const e of events) {
                const t = e[HC.Timestamp] ?? 0;
                if (t > lastTs) { lastTs = t; lastSource = e[HC.Operation]; }
            }
            if (health?.latestTs && health.latestTs > lastTs) { lastTs = health.latestTs; lastSource = 'stream_data'; }

            const recent = events.filter(e => (e[HC.Timestamp] ?? 0) >= now - days * DAY_MS);
            const age = lastTs ? now - lastTs : Infinity;
            return {
                facility: f.name,
                status: age < ACTIVE_MS ? 'active' : age < QUIET_MS ? 'quiet' : 'idle',
                lastActivity: iso(lastTs),
                lastActivityType: lastSource,
                daysSinceActivity: lastTs ? Math.floor(age / DAY_MS) : null,
                changesInWindow: recent.length,
                contributorsInWindow: new Set(recent.map(e => e[HC.Username]).filter(Boolean)).size,
                ...(health ? { streams: { total: health.total, ...health.summary } } : {}),
                _ts: lastTs,
            };
        });

        const ok = rows.filter(Boolean).sort((a, b) => a._ts - b._ts).map(({ _ts, ...r }) => r);
        return {
            windowDays: days,
            note: `Activity history looks back ${HISTORY_LOOKBACK_MS / DAY_MS} days; "idle" with no lastActivity means nothing in that period.`,
            facilitiesScanned: ok.length,
            facilitiesFailed: rows.length - ok.length,
            ...(ctx.facilities.length > MAX_PORTFOLIO_SCAN ? { truncatedTo: MAX_PORTFOLIO_SCAN } : {}),
            summary: countBy(ok, r => r.status),
            facilities: ok,
        };
    });

// ═══ Access ════════════════════════════════════════════════════════════════════

const isApp = u => !u.email || !String(u.email).includes('@');

defineTool('get_facility_access',
    'List who has access to ONE facility: users and apps (service accounts) with their access level ' +
    '(Owner, Manage, ReadWrite, Read).',
    FACILITY_PROP, ['facility_urn'],
    async (args) => {
        const ff = resolveFacility(args);
        if (!ff) return facilityNotFound(args);

        const users = Object.values((await getFacilityUsers(ff.f.urn, ff.region)) ?? {});
        users.sort((a, b) => (ACCESS_RANK[b.accessLevel] ?? 1) - (ACCESS_RANK[a.accessLevel] ?? 1));
        return {
            facilityName: ff.f.name,
            total: users.length,
            byAccessLevel: countBy(users, u => u.accessLevel ?? 'Unknown'),
            principals: users.slice(0, 100).map(u => ({
                name: u.name || u.email || 'Unknown',
                email: u.email || null,
                type: isApp(u) ? 'app' : 'user',
                accessLevel: u.accessLevel ?? 'Unknown',
            })),
        };
    });

defineTool('get_portfolio_access',
    'Summarize access across ALL facilities (same data as the Access tab): every user and app, their highest ' +
    'access level and how many facilities they can reach, plus facilities that have no Owner. Use "query" ' +
    'to find where a specific person or app has access.',
    {
        query: { type: 'string', description: 'Only users/apps whose name or email contains this text' },
        limit: { type: 'integer', description: 'Max users/apps to list (default 40, max 150)' },
    },
    [],
    async (args) => {
        const targets = ctx.facilities.slice(0, MAX_PORTFOLIO_SCAN);
        const perFacility = await mapPool(targets, CONCURRENCY, async f => ({
            facility: f.name,
            users: Object.entries((await getFacilityUsers(f.urn, regionFor(f))) ?? {}),
        }));

        // Dedupe by user id internally; ids are never returned (PII)
        const principals = new Map();
        const noOwner = [];
        for (const row of perFacility.filter(Boolean)) {
            if (!row.users.some(([, u]) => u.accessLevel === 'Owner')) noOwner.push(row.facility);
            for (const [id, u] of row.users) {
                const entry = principals.get(id) ?? {
                    name: u.name || u.email || 'Unknown', email: u.email || null, type: isApp(u) ? 'app' : 'user',
                    highest: 'None', facilities: [],
                };
                if ((ACCESS_RANK[u.accessLevel] ?? 1) > (ACCESS_RANK[entry.highest] ?? 0)) entry.highest = u.accessLevel ?? 'Read';
                entry.facilities.push({ facility: row.facility, access: u.accessLevel ?? 'Unknown' });
                principals.set(id, entry);
            }
        }

        let list = [...principals.values()];
        const q = String(args.query ?? '').trim().toLowerCase();
        if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q));
        list.sort((a, b) => b.facilities.length - a.facilities.length);
        const facilityCap = q ? 30 : 8;

        return {
            facilitiesScanned: perFacility.filter(Boolean).length,
            facilitiesFailed: perFacility.filter(r => r === null).length,
            ...(ctx.facilities.length > MAX_PORTFOLIO_SCAN ? { truncatedTo: MAX_PORTFOLIO_SCAN } : {}),
            totals: {
                users: [...principals.values()].filter(p => p.type === 'user').length,
                apps:  [...principals.values()].filter(p => p.type === 'app').length,
            },
            facilitiesWithoutOwner: noOwner.slice(0, 25),
            matching: list.length,
            principals: list.slice(0, clamp(args.limit, 1, 150, 40)).map(p => ({
                name: p.name, email: p.email, type: p.type, highestAccess: p.highest,
                facilityCount: p.facilities.length,
                facilities: p.facilities.slice(0, facilityCap),
                ...(p.facilities.length > facilityCap ? { moreFacilities: p.facilities.length - facilityCap } : {}),
            })),
        };
    });

// ── Public tool definitions ────────────────────────────────────────────────────
export const TOOL_DEFS = [...TOOLS.values()].map(t => t.def);

// ── Failed-request tracking ────────────────────────────────────────────────────
// Most api.js helpers catch errors and return [] / null, so a failed request looks
// identical to "no data". While a tool runs we observe Tandem API responses and
// report failures to the model, so it can say "couldn't load" rather than "none".
const _failureCollectors = new Set();
let _fetchObserved = false;

/**
 * Responses that api.js (and Tandem) use to mean "nothing there", not a fault:
 *  - 404 anywhere
 *  - 403 on a facility's default model (not created yet) or on account metrics (not an owner)
 */
function isBenignFailure(url, status) {
    if (status === 404) return true;
    if (status !== 403) return false;
    if (/\/groups\/[^/]+\/metrics/.test(url)) return true;
    // A default model shares its id with its facility (urn:adsk.dtm:X ↔ urn:adsk.dtt:X)
    const modelId = url.match(/urn:adsk\.dtm:([\w.-]+)/)?.[1];
    return !!modelId && ctx.facilities.some(f => f.urn.endsWith(`:${modelId}`));
}

function recordFailure(url, detail) {
    const matching = [..._failureCollectors].filter(c => c.facilityId && url.includes(c.facilityId));
    // Reference-model URNs don't embed the facility id — attribute to all running tools
    const targets = matching.length ? matching : [..._failureCollectors];
    const endpoint = url.replace(tandemBaseURL, '').replace(/urn:adsk\.[a-z]+:[\w.-]+/g, '{urn}').split('?')[0];
    targets.forEach(c => c.failures.add(`${endpoint} → ${detail}`));
}

function observeTandemFetches() {
    if (_fetchObserved) return;
    _fetchObserved = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input?.url ?? String(input));
        const tracked = _failureCollectors.size > 0 && !!tandemBaseURL && url.startsWith(tandemBaseURL);
        try {
            const response = await originalFetch(input, init);
            if (tracked && !response.ok && !isBenignFailure(url, response.status)) {
                recordFailure(url, `${response.status} ${response.statusText}`.trim());
            }
            return response;
        } catch (err) {
            if (tracked) recordFailure(url, 'network error');
            throw err;
        }
    };
}

/**
 * @param {string} name
 * @param {object} args
 * @param {{ onChart?: (spec: object) => void }} [handlers] UI side-channel: charts go
 *        straight to the chat window, never through the model.
 */
export async function executeTool(name, args, handlers = {}) {
    const tool = TOOLS.get(name);
    if (!tool) return { error: `Unknown tool: ${name}` };

    observeTandemFetches();
    const collector = {
        facilityId: args?.facility_urn ? String(args.facility_urn).split(':').pop() : null,
        failures: new Set(),
    };
    _failureCollectors.add(collector);

    let result;
    try {
        result = await tool.run(args ?? {}, { chart: spec => handlers.onChart?.(spec) });
    } finally {
        _failureCollectors.delete(collector);
    }

    if (collector.failures.size === 0) return result;

    const warning = 'Some Tandem API requests failed while gathering this data, so the results may be ' +
        'incomplete or empty. Do NOT present empty or zero values as real; tell the user the data ' +
        'could not be loaded and which part failed.';
    const failedRequests = [...collector.failures].slice(0, 5);
    console.warn(`[Chat] ${name}: ${collector.failures.size} failed request(s)`, failedRequests);
    return Array.isArray(result)
        ? { results: result, warning, failedRequests }
        : { ...result, warning, failedRequests };
}
