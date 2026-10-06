/**
 * Chat View — AI assistant with Tandem tool calling.
 *
 * Natural-language queries against the current account's facilities.
 * Supports OpenAI and Anthropic APIs directly from the browser.
 * The user supplies their own API key (stored in localStorage only).
 *
 * Tools (read-only):
 *   list_facilities      — names, URNs, cached stats
 *   get_stream_health    — per-stream online/silent/offline status
 *   get_tickets          — work orders with priority + status
 *   get_recent_activity  — change history summary
 *   get_models           — list 3D models in a facility
 */

import { getStreams, getLastSeenStreamValues, getTickets, getTwinHistory, getModels } from '../api.js';
import { getStatsStore } from './portfolioView.js';
import { QC } from '../../tandem/constants.js';
import { toShortKey } from '../../tandem/keys.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'tandem-chat-settings';
const ONLINE_MS    = 24 * 60 * 60 * 1000;      // < 24h  → online
const WARNING_MS   = 7  * 24 * 60 * 60 * 1000; // < 7d   → silent
const MAX_LOOP     = 10; // prevent runaway agentic loops

const PROVIDERS = {
    openai: {
        label:        'OpenAI',
        models:       ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o3', 'o4-mini'],
        defaultModel: 'gpt-4o',
        docsURL:      'https://platform.openai.com/docs/models',
    },
    anthropic: {
        label:        'Anthropic',
        // Short-form IDs (no date suffix) resolve to the latest version of each model.
        // If the API returns a 404, look up the exact ID at:
        //   https://docs.anthropic.com/en/docs/about-claude/models
        models:       [
            'claude-sonnet-5-5',
            'claude-opus-5-5',
            'claude-haiku-4-5',
            'claude-opus-4-5',
            'claude-sonnet-4-5',
        ],
        defaultModel: 'claude-sonnet-5-5',
        docsURL:      'https://docs.anthropic.com/en/docs/about-claude/models',
    },
};

const PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Trivial: 4 };

// ── Module state ───────────────────────────────────────────────────────────────
let _facilities  = [];
let _regionMap   = null;
let _accountName = '';
let _history     = [];       // conversation history in OpenAI message format
let _isThinking  = false;
let _loaded      = false;
let _settings    = loadSettings();

// ── Settings helpers ───────────────────────────────────────────────────────────
function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
        return {
            provider:    s.provider    || 'openai',
            apiKey:      s.apiKey      || '',
            model:       s.model       || 'gpt-4o',
            mcpURL:      s.mcpURL      || '',
            mcpToken:    s.mcpToken    || '',
            mcpClientId: s.mcpClientId || '',  // APS CLIENT_ID that has mcp:read mcp:write registered
        };
    } catch { return { provider: 'openai', apiKey: '', model: 'gpt-4o', mcpURL: '' }; }
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
}

// ── Tool definitions (OpenAI function-calling format) ──────────────────────────
const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'list_facilities',
            description:
                'List all facilities in the current account. Returns name, URN, and cached stats ' +
                '(stream count, tagged asset count, open ticket count, closed ticket count) for each.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_stream_health',
            description:
                'Get detailed IoT stream health for a specific facility. Returns each stream name ' +
                'and its status: online (data within 24 h), silent (1–7 days), or offline (>7 days).',
            parameters: {
                type: 'object',
                properties: {
                    facility_urn: { type: 'string', description: 'Facility URN (urn:adsk.dtt:…)' },
                },
                required: ['facility_urn'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_tickets',
            description:
                'Get work order tickets for a facility. Returns ticket names, priority ' +
                '(Critical/High/Medium/Low/Trivial), status (open/closed), and dates.',
            parameters: {
                type: 'object',
                properties: {
                    facility_urn: { type: 'string', description: 'Facility URN' },
                    status: {
                        type: 'string',
                        enum: ['all', 'open', 'closed'],
                        description: 'Filter by status (default: all)',
                    },
                },
                required: ['facility_urn'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_recent_activity',
            description:
                'Get recent change history for a facility. Shows total changes, unique contributors, ' +
                'change types breakdown, and the most recent events.',
            parameters: {
                type: 'object',
                properties: {
                    facility_urn: { type: 'string', description: 'Facility URN' },
                    days: { type: 'integer', description: 'Days of history to retrieve (default 30, max 90)' },
                },
                required: ['facility_urn'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_models',
            description: 'List the 3D models (e.g. Revit BIM imports) in a facility.',
            parameters: {
                type: 'object',
                properties: {
                    facility_urn: { type: 'string', description: 'Facility URN' },
                },
                required: ['facility_urn'],
            },
        },
    },
];

// ── Tool executor ──────────────────────────────────────────────────────────────
async function executeTool(name, args) {
    const f      = _facilities.find(fac => fac.urn === args.facility_urn);
    const region = f ? (_regionMap?.get(f.urn) ?? f.region ?? 'us') : 'us';

    switch (name) {

        case 'list_facilities': {
            const store = getStatsStore();
            return _facilities.map(fac => {
                const s = store.get(fac.urn) ?? {};
                return {
                    name:             fac.name,
                    urn:              fac.urn,
                    streamCount:      s.streamCount      ?? null,
                    taggedAssetCount: s.taggedAssetCount ?? null,
                    openTicketCount:  s.openTicketCount  ?? null,
                    closedTicketCount: s.closedTicketCount ?? null,
                };
            });
        }

        case 'get_stream_health': {
            if (!f) return { error: `Facility not found: ${args.facility_urn}` };

            const streams = await getStreams(f.urn, region);
            if (!streams?.length) return { facilityName: f.name, summary: { online: 0, silent: 0, offline: 0 }, streams: [] };

            const shortKeys = streams.map(s => s[QC.Key]).filter(Boolean);
            const lastSeen  = await getLastSeenStreamValues(f.urn, region, shortKeys);
            const now       = Date.now();

            const result = streams.map(stream => {
                const key  = stream[QC.Key];
                const name = stream[QC.OName]?.[0] ?? stream[QC.Name]?.[0] ?? 'Unnamed';

                // Find max timestamp for this stream across all properties
                let lastTs = 0;
                for (const [longKey, propMap] of Object.entries(lastSeen ?? {})) {
                    let shortK;
                    try { shortK = toShortKey(longKey); } catch { continue; }
                    if (shortK !== key) continue;
                    for (const inner of Object.values(propMap ?? {})) {
                        for (const tsStr of Object.keys(inner ?? {})) {
                            const ts = Number(tsStr);
                            if (ts > lastTs) lastTs = ts;
                        }
                    }
                }

                const age    = lastTs ? now - lastTs : Infinity;
                const status = age < ONLINE_MS ? 'online' : age < WARNING_MS ? 'silent' : 'offline';
                return { name, status, lastSeen: lastTs ? new Date(lastTs).toLocaleString() : 'never' };
            });

            const summary = {
                online:  result.filter(s => s.status === 'online').length,
                silent:  result.filter(s => s.status === 'silent').length,
                offline: result.filter(s => s.status === 'offline').length,
            };

            return { facilityName: f.name, summary, streams: result };
        }

        case 'get_tickets': {
            if (!f) return { error: `Facility not found: ${args.facility_urn}` };

            const tickets     = await getTickets(f.urn, region);
            const statusFilter = args.status ?? 'all';

            const mapped = tickets.map(t => ({
                name:      t[QC.OName]?.[0]  ?? t[QC.Name]?.[0] ?? 'Unnamed',
                priority:  t[QC.Priority]?.[0] ?? 'Unknown',
                status:    t[QC.CloseDate]?.[0] ? 'closed' : 'open',
                openDate:  t[QC.OpenDate]?.[0]  ?? null,
                closeDate: t[QC.CloseDate]?.[0] ?? null,
            }));

            const filtered = statusFilter === 'all' ? mapped : mapped.filter(t => t.status === statusFilter);
            filtered.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99));

            return {
                facilityName: f.name,
                summary: {
                    open:   mapped.filter(t => t.status === 'open').length,
                    closed: mapped.filter(t => t.status === 'closed').length,
                },
                tickets: filtered,
            };
        }

        case 'get_recent_activity': {
            if (!f) return { error: `Facility not found: ${args.facility_urn}` };

            const days  = Math.min(args.days ?? 30, 90);
            const minTs = Date.now() - days * 24 * 60 * 60 * 1000;

            const history = await getTwinHistory(f.urn, region, { min: minTs, includeChanges: true });
            const events  = (history ?? []).filter(e => e.o !== 'metrics_update');

            const actors  = new Set(events.map(e => e.u).filter(Boolean));
            const byType  = {};
            events.forEach(e => { byType[e.o] = (byType[e.o] ?? 0) + 1; });

            return {
                facilityName:       f.name,
                daysRequested:      days,
                totalChanges:       events.length,
                uniqueContributors: actors.size,
                changesByType:      byType,
                recentChanges:      events.slice(0, 20).map(e => ({
                    timestamp: new Date(e.t).toLocaleString(),
                    operation: e.o,
                    user:      e.u ?? 'unknown',
                })),
            };
        }

        case 'get_models': {
            if (!f) return { error: `Facility not found: ${args.facility_urn}` };

            const models = await getModels(f.urn, region);
            return {
                facilityName: f.name,
                models: (models ?? []).map(m => ({
                    name:      m.label ?? m.name ?? 'Unnamed',
                    urn:       m.urn   ?? m.modelId ?? '',
                    isDefault: m.isDefault ?? false,
                })),
            };
        }

        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// ── LLM streaming — OpenAI ─────────────────────────────────────────────────────
async function* streamOpenAI(messages) {
    const sysMsg = { role: 'system', content: buildSystemPrompt() };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${_settings.apiKey}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            model:       _settings.model || 'gpt-4o',
            messages:    [sysMsg, ...messages],
            tools:       TOOL_DEFS,
            tool_choice: 'auto',
            stream:      true,
        }),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const msg  = body?.error?.message ?? response.statusText;
        if (response.status === 401) throw new Error('Invalid OpenAI API key — check Settings.');
        if (response.status === 404) throw new Error(`Model "${_settings.model}" not found. See ${PROVIDERS.openai.docsURL} for valid model IDs.`);
        if (response.status === 429) throw new Error('OpenAI rate limit hit — wait a moment and try again.');
        throw new Error(`OpenAI ${response.status}: ${msg}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    const tcMap   = {};  // index → { id, name, args }

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') { yield { type: 'done' }; return; }

            let chunk;
            try { chunk = JSON.parse(raw); } catch { continue; }

            const delta        = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;

            if (delta?.content) {
                yield { type: 'text', delta: delta.content };
            }

            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!tcMap[idx]) tcMap[idx] = { id: '', name: '', args: '' };
                    if (tc.id)                    tcMap[idx].id   = tc.id;
                    if (tc.function?.name)         tcMap[idx].name = tc.function.name;
                    if (tc.function?.arguments)    tcMap[idx].args += tc.function.arguments;
                }
            }

            if (finishReason === 'tool_calls') {
                for (const tc of Object.values(tcMap)) {
                    yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args };
                }
                yield { type: 'done' };
                return;
            }
        }
    }
    yield { type: 'done' };
}

// ── LLM streaming — Anthropic ─────────────────────────────────────────────────
function toAnthropicMessages(messages) {
    const result = [];
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role === 'user') {
            result.push({ role: 'user', content: msg.content });
            i++;
        } else if (msg.role === 'assistant') {
            const content = [];
            if (msg.content) content.push({ type: 'text', text: msg.content });
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    let input = {};
                    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ok */ }
                    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
                }
            }
            result.push({ role: 'assistant', content });
            i++;

            // Collect tool results that immediately follow
            const toolResults = [];
            while (i < messages.length && messages[i].role === 'tool') {
                toolResults.push({
                    type:        'tool_result',
                    tool_use_id: messages[i].tool_call_id,
                    content:     messages[i].content,
                });
                i++;
            }
            if (toolResults.length > 0) {
                result.push({ role: 'user', content: toolResults });
            }
        } else {
            i++;
        }
    }
    return result;
}

async function* streamAnthropic(messages) {
    // Always log settings state so we can diagnose MCP issues
    console.log('[Chat] streamAnthropic settings:', {
        provider: _settings.provider,
        model:    _settings.model,
        hasKey:   !!_settings.apiKey,
        mcpURL:   _settings.mcpURL   || '(empty — MCP disabled)',
        hasMcpToken: !!_settings.mcpToken,
    });

    const body = {
        model:      _settings.model || 'claude-sonnet-5-5',
        system:     buildSystemPrompt(),
        messages:   toAnthropicMessages(messages),
        tools:      TOOL_DEFS.map(t => ({
            name:         t.function.name,
            description:  t.function.description,
            input_schema: t.function.parameters,
        })),
        max_tokens: 4096,
        stream:     true,
    };

    // Attach Tandem MCP server when a URL is configured.
    // Anthropic calls the MCP server server-side and exposes its tools to Claude
    // alongside the built-in portfolio tools above.
    // Uses a separate MCP token (mcp:read mcp:write scopes) if provided; the main
    // Tandem session token won't have those scopes.
    if (_settings.mcpURL) {
        // Strip "Bearer " prefix if user pasted the full header value
        const rawToken  = (_settings.mcpToken || window.sessionStorage.token || '').trim();
        const mcpBearer = rawToken.replace(/^Bearer\s+/i, '');
        body.mcp_servers = [{
            type:                'url',
            url:                 _settings.mcpURL,
            name:                'tandem',
            authorization_token: `Bearer ${mcpBearer}`,
        }];
    }

    const headers = {
        'x-api-key':                                 _settings.apiKey,
        'anthropic-version':                         '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type':                              'application/json',
    };
    // MCP beta header — try current known values; if tools still don't appear, it may be GA (no header needed).
    // Anthropic silently ignores mcp_servers if the header is unrecognized, which is why no error appears.
    if (_settings.mcpURL) {
        // Try the latest known beta slug; update this if Anthropic changes it.
        headers['anthropic-beta'] = 'mcp-client-2025-04-04';
    }

    // Debug: always log the full outbound body structure when MCP is configured
    if (_settings.mcpURL) {
        console.group('[Chat] Anthropic request body (MCP mode)');
        console.log('model:', body.model);
        console.log('mcp_servers field present:', !!body.mcp_servers);
        console.log('mcp_servers:', JSON.stringify(body.mcp_servers?.map(s => ({ ...s, authorization_token: s.authorization_token ? '***' : '(empty!)' }))));
        console.log('beta header sent:', headers['anthropic-beta'] ?? '(none)');
        console.log('Tip — if Claude still reports no MCP tools, check Network tab →');
        console.log('  Request payload: confirm mcp_servers is present');
        console.log('  Response headers: look for anthropic-* warning headers');
        console.groupEnd();
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const msg  = body?.error?.message ?? response.statusText;
        if (response.status === 401) throw new Error('Invalid Anthropic API key — check Settings.');
        if (response.status === 404) throw new Error(`Model "${_settings.model}" not found. Find valid IDs at ${PROVIDERS.anthropic.docsURL}`);
        if (response.status === 529) throw new Error('Anthropic is overloaded — wait a moment and try again.');
        throw new Error(`Anthropic ${response.status}: ${msg}`);
    }

    const reader       = response.body.getReader();
    const decoder      = new TextDecoder();
    let buffer         = '';
    let eventType      = '';
    const blocksByIdx  = {};   // contentBlock index → block object

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (line.startsWith('event: ')) { eventType = line.slice(7).trim(); continue; }
            if (!line.startsWith('data: '))  continue;

            let data;
            try { data = JSON.parse(line.slice(6).trim()); } catch { continue; }

            // Debug: log every event when MCP is configured so we can see if
            // Anthropic is connecting to the MCP server or silently ignoring it.
            if (_settings.mcpURL && eventType && eventType !== 'ping') {
                if (eventType === 'message_start') {
                    console.group('[Chat] message_start — shows model + usage');
                    console.log(JSON.stringify(data, null, 2));
                    console.groupEnd();
                } else if (eventType.includes('mcp') || eventType.includes('tool') || eventType.includes('server')) {
                    console.group(`[Chat] *** MCP/tool event: ${eventType} ***`);
                    console.log(JSON.stringify(data, null, 2));
                    console.groupEnd();
                } else if (eventType === 'content_block_start') {
                    console.log(`[Chat] content_block_start type=${data?.content_block?.type}`);
                } else {
                    console.log(`[Chat] ${eventType}`);
                }
            }

            if (eventType === 'content_block_start') {
                blocksByIdx[data.index] = { ...data.content_block, inputStr: '' };
            }

            if (eventType === 'content_block_delta') {
                const block = blocksByIdx[data.index];
                if (!block) continue;
                if (data.delta?.type === 'text_delta') {
                    yield { type: 'text', delta: data.delta.text };
                } else if (data.delta?.type === 'input_json_delta') {
                    block.inputStr += data.delta.partial_json;
                }
            }

            if (eventType === 'message_delta' && data.delta?.stop_reason === 'tool_use') {
                for (const block of Object.values(blocksByIdx)) {
                    if (block.type === 'tool_use') {
                        yield { type: 'tool_call', id: block.id, name: block.name, args: block.inputStr || '{}' };
                    }
                }
                yield { type: 'done' };
                return;
            }

            if (eventType === 'message_stop') {
                yield { type: 'done' };
                return;
            }
        }
    }
    yield { type: 'done' };
}

// ── System prompt ──────────────────────────────────────────────────────────────
function buildSystemPrompt() {
    const facilityList = _facilities.length <= 20
        ? _facilities.map(f => `  - ${f.name}`).join('\n')
        : `  (${_facilities.length} facilities — use list_facilities to enumerate them)`;

    const mcpNote = _settings.mcpURL
        ? `\nYou also have access to the Tandem MCP server (tool prefix: "tandem__"). ` +
          `Use those tools to answer general questions about how Tandem works, its data model, ` +
          `API capabilities, and concepts — things not covered by the portfolio tools above.`
        : '';

    return `You are an AI assistant embedded in the Tandem Portfolio Manager — a dashboard that helps facility managers monitor and analyze their portfolio of digital twin buildings on Autodesk Tandem.

You have two sets of tools:

1. **Portfolio tools** (built-in): query live data for the current account's facilities.
   - list_facilities, get_stream_health, get_tickets, get_recent_activity, get_models
   - Always use these for questions about specific facilities, streams, tickets, or activity.

2. **Tandem MCP tools** (tandem__* prefix, when available): access Tandem platform knowledge.
   - Use these for questions about how Tandem works, its concepts, API, or general best practices.${mcpNote}

Rules:
- Always use tools for accurate data; never guess facility names, stream counts, or ticket details.
- Lead with the most important finding (problems, anomalies, outliers).
- Highlight issues: offline streams, open high-priority tickets, no recent activity.
- Use specific numbers. Format comparisons as lists or tables.
- Keep responses concise — do not echo raw JSON back to the user.
- Suggest actionable next steps when appropriate.

Current account: ${_accountName || '(unknown)'}
Number of facilities: ${_facilities.length}
Facility list:
${facilityList || '  (none loaded yet)'}`;
}

// ── Agentic loop ───────────────────────────────────────────────────────────────
/**
 * Run the full agent loop: stream response, execute any tool calls, repeat until
 * the LLM produces a final text answer.
 *
 * @param {string} userText
 * @param {function} onTextDelta - called with each streaming text chunk
 * @param {function} onToolStatus - called with status string (or null to clear)
 */
async function runAgentLoop(userText, onTextDelta, onToolStatus) {
    _history.push({ role: 'user', content: userText });

    for (let iter = 0; iter < MAX_LOOP; iter++) {
        const stream = _settings.provider === 'anthropic'
            ? streamAnthropic(_history)
            : streamOpenAI(_history);

        let assistantText = '';
        const toolCalls   = [];

        for await (const event of stream) {
            if (event.type === 'text') {
                assistantText += event.delta;
                onTextDelta(event.delta);
            } else if (event.type === 'tool_call') {
                toolCalls.push(event);
            }
            // 'done' — just fall through
        }

        if (toolCalls.length === 0) {
            // Final response — record and finish
            _history.push({ role: 'assistant', content: assistantText });
            return;
        }

        // Record assistant message with tool calls
        _history.push({
            role:       'assistant',
            content:    assistantText || null,
            tool_calls: toolCalls.map(tc => ({
                id:       tc.id,
                type:     'function',
                function: { name: tc.name, arguments: tc.args },
            })),
        });

        // Execute all tool calls in parallel
        const label = toolCalls.map(tc => tc.name.replace(/_/g, ' ')).join(', ');
        onToolStatus(`Fetching: ${label}…`);

        const results = await Promise.all(toolCalls.map(async tc => {
            let parsed = {};
            try { parsed = JSON.parse(tc.args || '{}'); } catch { /* ok */ }
            try {
                const result = await executeTool(tc.name, parsed);
                return { id: tc.id, result };
            } catch (err) {
                return { id: tc.id, result: { error: err.message } };
            }
        }));

        for (const r of results) {
            _history.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) });
        }

        onToolStatus(null);
    }
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
let _container    = null;
let _messagesEl   = null;
let _inputEl      = null;
let _sendBtn      = null;
let _statusEl     = null;
let _settingsPane = null;

function getEl(id) { return document.getElementById(id); }

function scrollToBottom() {
    if (_messagesEl) _messagesEl.scrollTop = _messagesEl.scrollHeight;
}

function appendUserBubble(text) {
    const div = document.createElement('div');
    div.className = 'flex justify-end';
    div.innerHTML = `
        <div class="max-w-[75%] bg-tandem-blue text-white text-sm rounded-xl px-4 py-2.5 whitespace-pre-wrap break-words">
            ${escHtml(text)}
        </div>`;
    _messagesEl.appendChild(div);
    scrollToBottom();
}

function appendAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start';

    const bubble = document.createElement('div');
    bubble.className = 'max-w-[85%] bg-dark-card border border-dark-border text-dark-text text-sm rounded-xl px-4 py-2.5';

    const toolLine = document.createElement('div');
    toolLine.className = 'hidden text-xs text-dark-text-secondary mb-1 italic';
    toolLine.setAttribute('data-tool-status', '1');
    bubble.appendChild(toolLine);

    const textEl = document.createElement('div');
    textEl.className = 'whitespace-pre-wrap break-words';
    textEl.setAttribute('data-text', '1');
    bubble.appendChild(textEl);

    wrap.appendChild(bubble);
    _messagesEl.appendChild(wrap);
    scrollToBottom();

    return {
        appendText: (delta) => {
            textEl.textContent += delta;
            scrollToBottom();
        },
        setToolStatus: (msg) => {
            if (msg) {
                toolLine.textContent = msg;
                toolLine.classList.remove('hidden');
            } else {
                toolLine.classList.add('hidden');
            }
        },
        getText: () => textEl.textContent,
    };
}

function appendErrorBubble(msg) {
    const div = document.createElement('div');
    div.className = 'flex justify-start';
    div.innerHTML = `
        <div class="max-w-[85%] border border-red-800 bg-red-950 text-red-300 text-sm rounded-xl px-4 py-2.5">
            ⚠️ ${escHtml(msg)}
        </div>`;
    _messagesEl.appendChild(div);
    scrollToBottom();
}

function appendWelcome() {
    const div = document.createElement('div');
    div.className = 'flex justify-start';
    div.setAttribute('data-welcome', '1');
    div.innerHTML = `
        <div class="max-w-[85%] bg-dark-card border border-dark-border text-dark-text text-sm rounded-xl px-4 py-3 space-y-2">
            <p class="font-medium text-tandem-blue">👋 Tandem AI Assistant</p>
            <p class="text-dark-text-secondary text-xs">Ask me anything about your facilities. Examples:</p>
            <ul class="text-xs text-dark-text-secondary space-y-1 list-none">
                ${[
                    'Which facility has the most offline streams?',
                    'Summarize open tickets across all facilities.',
                    'Which facilities had no activity in the last 30 days?',
                    'Compare stream health for my top 3 facilities.',
                    'What is a Tandem digital twin and how does it work?',
                ].map(q => `<li class="cursor-pointer hover:text-tandem-blue transition" data-suggestion="${escAttr(q)}">→ ${escHtml(q)}</li>`).join('')}
            </ul>
        </div>`;

    // Wire suggestion clicks
    div.querySelectorAll('[data-suggestion]').forEach(el => {
        el.addEventListener('click', () => submitMessage(el.dataset.suggestion));
    });

    _messagesEl.appendChild(div);
}

function removeWelcome() {
    _messagesEl.querySelectorAll('[data-welcome]').forEach(el => el.remove());
}

function setThinking(on) {
    _isThinking = on;
    _sendBtn.disabled   = on;
    _inputEl.disabled   = on;
    _sendBtn.textContent = on ? '…' : 'Send';
}

function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escAttr(s) { return escHtml(s); }

// ── MCP OAuth (PKCE) ──────────────────────────────────────────────────────────
function generateCodeVerifier() {
    const arr = new Uint8Array(48);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
    const data    = new TextEncoder().encode(verifier);
    const digest  = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function exchangeMcpCode(clientId, redirectUri, code, verifier) {
    const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'authorization_code',
            client_id:     clientId,
            redirect_uri:  redirectUri,
            code,
            code_verifier: verifier,
        }),
    });
    if (!resp.ok) throw new Error(`Token exchange failed: ${await resp.text()}`);
    const data = await resp.json();
    return data.access_token;
}

/**
 * Open a popup OAuth window using the MCP CLIENT_ID and PKCE.
 * Resolves with the access token or rejects on cancel/error.
 */
async function authorizeMcp() {
    const clientId = _settings.mcpClientId;
    if (!clientId) throw new Error('Enter the MCP Client ID in Settings first.');

    const redirectUri = `${location.origin}${location.pathname.replace(/\/$/, '')}`;
    const verifier    = generateCodeVerifier();
    const challenge   = await generateCodeChallenge(verifier);

    // Store verifier so the callback (same-page popup) can reach it
    sessionStorage.setItem('mcp-pkce-verifier', verifier);
    sessionStorage.setItem('mcp-pkce-clientId', clientId);
    sessionStorage.setItem('mcp-pkce-redirectUri', redirectUri);

    const authURL = new URL('https://developer.api.autodesk.com/authentication/v2/authorize');
    authURL.searchParams.set('response_type',         'code');
    authURL.searchParams.set('client_id',             clientId);
    authURL.searchParams.set('redirect_uri',          redirectUri);
    authURL.searchParams.set('scope',                 'mcp:read mcp:write offline_access');
    authURL.searchParams.set('code_challenge',        challenge);
    authURL.searchParams.set('code_challenge_method', 'S256');

    const popup = window.open(authURL.toString(), 'mcp-oauth', 'width=520,height=700,left=200,top=100');
    if (!popup) throw new Error('Popup blocked — allow popups for this page and try again.');

    return new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
            try {
                if (popup.closed) {
                    clearInterval(timer);
                    reject(new Error('OAuth popup was closed.'));
                    return;
                }
                const url = popup.location.href;
                if (url.includes('code=')) {
                    clearInterval(timer);
                    popup.close();
                    const code = new URL(url).searchParams.get('code');
                    const v    = sessionStorage.getItem('mcp-pkce-verifier');
                    const cId  = sessionStorage.getItem('mcp-pkce-clientId');
                    const rUri = sessionStorage.getItem('mcp-pkce-redirectUri');
                    const token = await exchangeMcpCode(cId, rUri, code, v);
                    resolve(token);
                }
            } catch (e) {
                // Still on cross-origin auth page — keep polling
            }
        }, 400);
    });
}

// ── Settings panel ─────────────────────────────────────────────────────────────
function renderSettingsPane() {
    const prov = PROVIDERS[_settings.provider] ?? PROVIDERS.openai;

    _settingsPane.innerHTML = `
        <div class="bg-dark-card border border-dark-border rounded-xl p-5 w-80 shadow-xl">
            <h3 class="text-sm font-semibold text-dark-text mb-4">⚙ Chat Settings</h3>

            <label class="block text-xs text-dark-text-secondary mb-1">Provider</label>
            <select id="chat-prov" class="w-full mb-3 rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue">
                <option value="openai"    ${_settings.provider === 'openai'    ? 'selected' : ''}>OpenAI</option>
                <option value="anthropic" ${_settings.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
            </select>

            <label class="block text-xs text-dark-text-secondary mb-1">Model ID</label>
            <datalist id="chat-model-list">
                ${prov.models.map(m => `<option value="${m}">`).join('')}
            </datalist>
            <input id="chat-model"
                   type="text"
                   list="chat-model-list"
                   value="${escAttr(_settings.model || prov.defaultModel)}"
                   placeholder="e.g. ${escAttr(prov.defaultModel)}"
                   class="w-full mb-1 rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue font-mono"/>
            <p class="text-xs text-dark-text-secondary mb-3" id="chat-model-hint">
                Type any valid API model ID or pick from the suggestions.
                <a id="chat-model-docs" href="${escAttr(prov.docsURL)}" target="_blank" rel="noopener"
                   class="text-tandem-blue hover:underline ml-1">Model reference ↗</a>
            </p>

            <label class="block text-xs text-dark-text-secondary mb-1">API Key</label>
            <input id="chat-key" type="password" placeholder="Paste your API key…"
                   value="${escAttr(_settings.apiKey)}"
                   class="w-full mb-1 rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue font-mono"/>
            <p class="text-xs text-dark-text-secondary mb-4" id="chat-key-note">
                Stored in your browser only. Sent directly to ${prov.label}.
                ${_settings.provider === 'anthropic' ? '<br><span class="text-amber-400">Anthropic:</span> <code class="text-tandem-blue">anthropic-dangerous-direct-browser-access</code> header is set automatically to allow browser calls.' : ''}
            </p>

            <div class="border-t border-dark-border pt-3 mb-3">
                <label class="block text-xs font-medium text-dark-text mb-1">
                    Tandem MCP Server
                    <span class="ml-1 font-normal text-dark-text-secondary">(optional)</span>
                </label>
                <input id="chat-mcp-url" type="text"
                       placeholder="Paste MCP server URL here…"
                       value="${escAttr(_settings.mcpURL)}"
                       class="w-full mb-2 rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue font-mono"/>

                <label class="block text-xs text-dark-text-secondary mb-1">
                    MCP Bearer Token
                    <span class="ml-1 font-normal text-dark-text-secondary">(requires mcp:read mcp:write scopes)</span>
                </label>
                <label class="block text-xs text-dark-text-secondary mb-1 mt-2">MCP Client ID <span class="font-normal">(from your mcp.json auth.CLIENT_ID)</span></label>
                <input id="chat-mcp-client-id" type="text"
                       placeholder="e.g. uhHVfgeCmdH5Vs…"
                       value="${escAttr(_settings.mcpClientId)}"
                       class="w-full mb-2 rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue font-mono"/>

                <button id="chat-mcp-authorize"
                        class="w-full mb-2 px-3 py-1.5 text-xs font-medium rounded border border-tandem-blue text-tandem-blue hover:bg-tandem-blue hover:text-white transition">
                    🔑 Authorize MCP (opens popup)
                </button>

                <label class="block text-xs text-dark-text-secondary mb-1">MCP Bearer Token <span class="font-normal">(auto-filled by Authorize, or paste manually)</span></label>
                <input id="chat-mcp-token" type="password"
                       placeholder="Auto-filled after Authorize, or paste manually…"
                       value="${escAttr(_settings.mcpToken)}"
                       class="w-full rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue font-mono"/>
                <p id="chat-mcp-status" class="text-xs text-dark-text-secondary mt-1">
                    Needs <code class="text-tandem-blue">mcp:read mcp:write</code> scopes — different from main Tandem login.
                    Click <strong>Authorize MCP</strong> to get a token via OAuth, or paste one manually.<br>
                    <span class="text-amber-400">Anthropic only</span> — OpenAI MCP requires a different API endpoint.
                </p>
            </div>

            <div class="flex gap-2">
                <button id="chat-settings-save"
                        class="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-tandem-blue text-white hover:bg-blue-600 transition">
                    Save
                </button>
                <button id="chat-settings-cancel"
                        class="flex-1 px-3 py-1.5 text-xs font-medium rounded border border-dark-border text-dark-text-secondary hover:bg-dark-border transition">
                    Cancel
                </button>
            </div>
        </div>`;

    // Provider change → update datalist suggestions and defaults
    getEl('chat-prov').addEventListener('change', e => {
        const p = PROVIDERS[e.target.value] ?? PROVIDERS.openai;
        const dl  = getEl('chat-model-list');
        dl.innerHTML = p.models.map(m => `<option value="${m}">`).join('');
        const modelInput = getEl('chat-model');
        modelInput.value = p.defaultModel;
        modelInput.placeholder = `e.g. ${p.defaultModel}`;
        getEl('chat-key-note').innerHTML =
            `Stored in your browser only. Sent directly to ${p.label}.` +
            (e.target.value === 'anthropic'
                ? ' <br><span class="text-amber-400">Anthropic:</span> <code class="text-tandem-blue">anthropic-dangerous-direct-browser-access</code> header is set automatically to allow browser calls.'
                : '');
        const docsLink = getEl('chat-model-docs');
        if (docsLink) { docsLink.href = p.docsURL; }
    });

    // Authorize MCP button → PKCE OAuth popup
    getEl('chat-mcp-authorize').addEventListener('click', async () => {
        // Save the CLIENT_ID first so authorizeMcp() can read it
        _settings.mcpClientId = getEl('chat-mcp-client-id')?.value.trim() ?? '';
        const statusEl = getEl('chat-mcp-status');
        const btn      = getEl('chat-mcp-authorize');
        btn.disabled   = true;
        btn.textContent = '⏳ Waiting for popup…';
        if (statusEl) statusEl.innerHTML = '<span class="text-amber-400">OAuth popup opened — sign in and approve scopes…</span>';
        try {
            const token = await authorizeMcp();
            getEl('chat-mcp-token').value = token;
            if (statusEl) statusEl.innerHTML = '<span class="text-green-400">✓ Token obtained successfully! Click Save.</span>';
        } catch (err) {
            if (statusEl) statusEl.innerHTML = `<span class="text-red-400">⚠ ${escHtml(err.message)}</span>`;
        } finally {
            btn.disabled    = false;
            btn.textContent = '🔑 Authorize MCP (opens popup)';
        }
    });

    getEl('chat-settings-save').addEventListener('click', () => {
        _settings.provider = getEl('chat-prov')?.value ?? _settings.provider;
        _settings.model    = getEl('chat-model')?.value.trim() ?? _settings.model;
        _settings.apiKey   = getEl('chat-key')?.value.trim() ?? _settings.apiKey;
        _settings.mcpURL      = getEl('chat-mcp-url')?.value.trim()       ?? '';
        _settings.mcpClientId = getEl('chat-mcp-client-id')?.value.trim() ?? '';
        _settings.mcpToken    = getEl('chat-mcp-token')?.value.trim()     ?? '';
        // Debug: confirm what's being saved
        console.log('[Chat] Saving settings:', {
            provider: _settings.provider,
            model:    _settings.model,
            hasKey:   !!_settings.apiKey,
            mcpURL:   _settings.mcpURL   || '(empty)',
            hasMcpToken: !!_settings.mcpToken,
        });
        saveSettings();
        toggleSettings(false);
        // Clear no-key banner if key was just added
        if (_settings.apiKey) getEl('chat-no-key')?.remove();
    });

    getEl('chat-settings-cancel').addEventListener('click', () => toggleSettings(false));
}

function toggleSettings(force) {
    const open = typeof force === 'boolean' ? force : _settingsPane.classList.contains('hidden');
    if (open) {
        renderSettingsPane();
        _settingsPane.classList.remove('hidden');
    } else {
        _settingsPane.classList.add('hidden');
    }
}

// ── Message submission ─────────────────────────────────────────────────────────
async function submitMessage(text) {
    text = text?.trim();
    if (!text || _isThinking) return;

    if (!_settings.apiKey) {
        toggleSettings(true);
        return;
    }

    removeWelcome();
    appendUserBubble(text);
    _inputEl.value = '';

    setThinking(true);
    const bubble = appendAssistantBubble();

    try {
        await runAgentLoop(
            text,
            delta => bubble.appendText(delta),
            msg   => bubble.setToolStatus(msg),
        );
    } catch (err) {
        console.error('Chat error:', err);
        appendErrorBubble(err.message || 'An error occurred. Check your API key in Settings.');
        // Roll back the last user message so history stays consistent
        if (_history.at(-1)?.role === 'user') _history.pop();
    } finally {
        setThinking(false);
    }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Reset state and render placeholder. Called when account changes.
 */
export function render(facilities, regionMap, accountName) {
    _facilities  = facilities ?? [];
    _regionMap   = regionMap  ?? null;
    _accountName = accountName ?? '';
    _history     = [];
    _loaded      = false;
    _settings = loadSettings();   // reload from localStorage on every account switch

    const el = getEl('chatContent');
    if (!el) return;

    el.innerHTML = `
        <div class="flex flex-col" style="height: calc(100vh - 148px);">

            <!-- Header -->
            <div class="flex items-center justify-between mb-3">
                <div>
                    <h2 class="text-sm font-semibold text-dark-text">Tandem AI Assistant</h2>
                    <p class="text-xs text-dark-text-secondary">Ask questions about your ${_facilities.length} facilities</p>
                </div>
                <div class="flex items-center gap-2">
                    <button id="chat-clear-btn"
                            class="text-xs text-dark-text-secondary border border-dark-border rounded px-2 py-1 hover:bg-dark-card transition"
                            title="Clear conversation">
                        Clear
                    </button>
                    <button id="chat-settings-btn"
                            class="text-xs text-dark-text-secondary border border-dark-border rounded px-2 py-1 hover:bg-dark-card transition"
                            title="Settings">
                        ⚙ Settings
                    </button>
                </div>
            </div>

            <!-- Settings pane (hidden by default) -->
            <div id="chat-settings-pane" class="hidden mb-3"></div>

            <!-- No-key banner -->
            ${!_settings.apiKey ? `
            <div id="chat-no-key" class="mb-3 bg-amber-950 border border-amber-700 text-amber-300 text-xs rounded-lg px-3 py-2">
                ⚠ No API key configured.
                <button class="underline ml-1" onclick="document.getElementById('chat-settings-btn').click()">Open Settings</button>
                to add your OpenAI or Anthropic key.
            </div>` : ''}

            <!-- Messages thread -->
            <div id="chat-messages"
                 class="flex-1 overflow-y-auto space-y-3 pr-1 pb-2">
            </div>

            <!-- Input bar -->
            <div class="mt-3 flex gap-2 items-end">
                <textarea id="chat-input"
                          rows="2"
                          placeholder="Ask about your facilities…"
                          class="flex-1 resize-none rounded-lg border border-dark-border bg-dark-card text-dark-text text-sm px-3 py-2 focus:outline-none focus:border-tandem-blue placeholder-dark-text-secondary"></textarea>
                <button id="chat-send-btn"
                        class="px-4 py-2 text-sm font-medium rounded-lg bg-tandem-blue text-white hover:bg-blue-600 transition disabled:opacity-40 shrink-0">
                    Send
                </button>
            </div>
        </div>`;

    _messagesEl   = getEl('chat-messages');
    _inputEl      = getEl('chat-input');
    _sendBtn      = getEl('chat-send-btn');
    _settingsPane = getEl('chat-settings-pane');

    // Wire buttons
    getEl('chat-settings-btn').addEventListener('click', () => toggleSettings());
    getEl('chat-clear-btn').addEventListener('click', () => {
        _history = [];
        _messagesEl.innerHTML = '';
        appendWelcome();
    });

    // Send on button click
    _sendBtn.addEventListener('click', () => submitMessage(_inputEl.value));

    // Send on Ctrl+Enter / Cmd+Enter
    _inputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitMessage(_inputEl.value);
        }
    });

    appendWelcome();
}

/**
 * Activate on tab switch — nothing special needed; render() already set up the view.
 */
export function activate() {
    // Auto-open settings if no API key yet
    if (!_settings.apiKey && _settingsPane && _settingsPane.classList.contains('hidden')) {
        toggleSettings(true);
    }
}
