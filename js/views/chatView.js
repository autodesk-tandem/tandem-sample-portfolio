/**
 * Chat View — AI assistant with Tandem tool calling.
 *
 * Natural-language queries against the current account's facilities.
 * Supports OpenAI and Anthropic APIs directly from the browser.
 * The user supplies their own API key (stored in localStorage only).
 *
 * The read-only tools the model can call live in ../chat/tools.js.
 */

import { TOOL_DEFS, executeTool, setToolContext } from '../chat/tools.js';
import { renderChart } from '../chat/chartRenderer.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'tandem-chat-settings';
const MCP_BETA     = 'mcp-client-2025-11-20';   // current MCP connector version (2025-04-04 is deprecated)
const MCP_NAME     = 'tandem';
const MCP_URL      = 'https://developer.api.autodesk.com/tandem-mcp-server/v1/mcp';
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

// ── Module state ───────────────────────────────────────────────────────────────
let _facilities  = [];
let _regionMap   = null;
let _accountName = '';
let _accounts    = [];
let _charts      = [];   // live chart instances, destroyed when the chat is reset
let _history     = [];       // conversation history in OpenAI message format
let _isThinking  = false;
let _mcpFailed   = false;   // set when Anthropic rejects the MCP server; reset on settings save
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
            mcpClientId: s.mcpClientId || '',   // APS app Client ID with the MCP callbacks registered
            mcpToken:    s.mcpToken    || '',   // set by "Authorize"; never typed by hand
        };
    } catch { return { provider: 'openai', apiKey: '', model: 'gpt-4o', mcpClientId: '', mcpToken: '' }; }
}

// MCP runs through Anthropic's connector, so it needs an Anthropic provider and a token.
function mcpEnabled() {
    return _settings.provider === 'anthropic' && !!_settings.mcpToken && !_mcpFailed;
}

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
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

    // Anthropic's connector calls the Tandem MCP server on its side and exposes its tools
    // alongside the portfolio tools. A bad/expired token makes Anthropic reject the whole
    // request, so we retry once without MCP (see below).
    const useMcp = mcpEnabled();
    if (useMcp) {
        body.mcp_servers = [{
            type:                'url',
            url:                 MCP_URL,
            name:                MCP_NAME,
            authorization_token: _settings.mcpToken,   // raw token; the connector adds "Bearer"
        }];
        // Without a toolset the connector exposes none of the server's tools to the model
        body.tools.push({ type: 'mcp_toolset', mcp_server_name: MCP_NAME });
    }

    const headers = {
        'x-api-key':                                 _settings.apiKey,
        'anthropic-version':                         '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type':                              'application/json',
    };
    if (useMcp) headers['anthropic-beta'] = MCP_BETA;

    const send = () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    let response = await send();

    // An MCP failure (bad/expired token, unapproved client) makes Anthropic reject the
    // entire request. Fall back to the built-in portfolio tools instead of blocking chat.
    if (!response.ok && useMcp && response.status === 400) {
        const errBody = await response.clone().json().catch(() => null);
        if (/mcp/i.test(errBody?.error?.message ?? '')) {
            console.warn('[Chat] MCP server rejected — continuing without it:', errBody.error.message);
            _mcpFailed = true;
            delete body.mcp_servers;
            body.tools = body.tools.filter(t => t.type !== 'mcp_toolset');
            delete headers['anthropic-beta'];
            body.system = buildSystemPrompt();   // no longer advertise MCP tools to the model
            yield {
                type: 'notice',
                text: 'Tandem MCP authorization failed, so this answer uses the built-in portfolio tools only. Re-authorize in Settings to restore MCP.',
            };
            response = await send();
        }
    }

    if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        const msg  = errJson?.error?.message ?? response.statusText;
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

            if (eventType === 'content_block_start') {
                blocksByIdx[data.index] = { ...data.content_block, inputStr: '' };

                // MCP tools run on Anthropic's side; show what is happening and surface failures
                const cb = data.content_block;
                if (cb?.type === 'mcp_tool_use') {
                    yield { type: 'status', text: `Asking Tandem MCP: ${cb.name}…` };
                } else if (cb?.type === 'mcp_tool_result' && cb.is_error) {
                    console.warn('[Chat] MCP tool returned an error:', JSON.stringify(cb.content));
                    yield { type: 'notice', text: 'A Tandem MCP tool call returned an error — see the browser console for details.' };
                }
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

    const mcpNote = mcpEnabled()
        ? `\nThe Tandem MCP server is connected: its tools are available to you alongside the portfolio tools. ` +
          `For questions about how Tandem works, its data model, API, concepts or best practices, call the MCP tools ` +
          `rather than answering from memory. If asked what tools you have, list both the portfolio tools and the MCP tools.`
        : '';

    return `You are an AI assistant embedded in the Tandem Portfolio Manager — a dashboard that helps facility managers monitor and analyze their portfolio of digital twin buildings on Autodesk Tandem.

You have two sets of tools:

1. **Portfolio tools** (built-in, read-only): query live data for the user's Tandem accounts and facilities.
   - Overview (cached, instant): list_facilities, find_outliers
   - Accounts: list_accounts, get_account_metrics
   - One facility: get_facility_details, get_models, get_facility_parameters, get_documents, get_saved_views, get_levels, get_rooms, get_systems, get_tagged_assets, get_stream_health, get_stream_values, chart_stream_values, get_tickets, get_recent_activity, get_facility_access
   - Whole portfolio (scans every facility, slower): get_portfolio_activity, get_portfolio_tickets, get_portfolio_access
   - Always use these for questions about specific facilities, streams, tickets, activity, access, rooms, levels or systems. Prefer the cheap overview tools first; call per-facility tools only for the facilities that matter, and avoid calling a per-facility tool for every facility when a portfolio-wide tool exists.
   - Charts: show_chart (bar/line/pie/doughnut from numbers you already have), chart_stream_values (sensor time series).
   - Tool results are summaries; if a result says it is truncated or capped, tell the user.

2. **Tandem MCP tools** (from the connected Tandem MCP server, when available): access Tandem platform knowledge.
   - Use these for questions about how Tandem works, its concepts, API, or general best practices.${mcpNote}

Rules:
- Always use tools for accurate data; never guess facility names, stream counts, or ticket details.
- Lead with the most important finding (problems, anomalies, outliers).
- Highlight issues: offline streams, open high-priority tickets, no recent activity.
- Use specific numbers. Format responses as GitHub-flavored markdown: use tables for comparisons across facilities, bullet lists for findings, **bold** for key values, and short headings for reports. Do not use images or raw HTML.
- If a tool result contains a "warning" / "failedRequests", some data could not be loaded: say so plainly and never report those values as zero or "no activity".
- When the user asks to see, plot, graph or chart something, call chart_stream_values (one stream's readings over time) or show_chart (bar/line/pie from numbers you already gathered). The chart appears directly in the chat — never write HTML, JavaScript or other chart code, and do not repeat the plotted numbers; add a short interpretation instead.
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
 * @param {function} onNotice - called with a non-fatal notice string (e.g. MCP fallback)
 * @param {function} onChart - called with a chart spec a tool wants shown to the user
 */
async function runAgentLoop(userText, onTextDelta, onToolStatus, onNotice, onChart) {
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
            } else if (event.type === 'notice') {
                onNotice?.(event.text);
            } else if (event.type === 'status') {
                onToolStatus(event.text);
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
                const result = await executeTool(tc.name, parsed, { onChart });
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

    // Build via textContent: whitespace-pre-wrap would otherwise preserve
    // template-literal indentation as extra padding inside the bubble.
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[75%] bg-tandem-blue text-white text-sm rounded-xl px-4 py-2.5 whitespace-pre-wrap break-words';
    bubble.textContent = text;

    div.appendChild(bubble);
    _messagesEl.appendChild(div);
    scrollToBottom();
}

const SVG_ATTRS = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const ICON_COPY  = `<svg ${SVG_ATTRS}><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>`;
const ICON_CHECK = `<svg ${SVG_ATTRS}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

// ── Markdown rendering ─────────────────────────────────────────────────────────
// Model output includes text from tickets/element names/MCP results, so HTML is
// always sanitized with DOMPurify before insertion. Falls back to escaped plain
// text if the libraries failed to load.
let _purifyConfigured = false;

function renderMarkdown(text) {
    const { marked, DOMPurify } = window;
    if (!marked || !DOMPurify) {
        const d = document.createElement('div');
        d.style.whiteSpace = 'pre-wrap';
        d.textContent = text;
        return d.outerHTML;
    }
    if (!_purifyConfigured) {
        DOMPurify.addHook('afterSanitizeAttributes', node => {
            if (node.tagName === 'A') {
                node.setAttribute('target', '_blank');
                node.setAttribute('rel', 'noopener noreferrer');
            }
        });
        _purifyConfigured = true;
    }
    const html = marked.parse(text, { gfm: true, breaks: false, async: false });
    const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'img'] });
    return clean
        .replace(/<table/g, '<div class="table-wrap"><table')
        .replace(/<\/table>/g, '</table></div>');
}

function appendAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start';

    const bubble = document.createElement('div');
    bubble.className = 'max-w-[85%] bg-dark-card border border-dark-border text-dark-text text-sm rounded-xl px-4 py-2.5';

    const toolLine = document.createElement('div');
    toolLine.className = 'text-xs text-dark-text-secondary italic';
    toolLine.setAttribute('data-tool-status', '1');
    toolLine.textContent = 'Thinking…';
    bubble.appendChild(toolLine);

    // Charts drawn by tools sit between the status line and the written answer
    const chartsEl = document.createElement('div');
    bubble.appendChild(chartsEl);

    const textEl = document.createElement('div');
    textEl.className = 'chat-md break-words';
    textEl.setAttribute('data-text', '1');
    bubble.appendChild(textEl);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'hidden mt-2 p-1 -ml-1 rounded text-dark-text-secondary hover:text-white hover:bg-dark-border transition';
    copyBtn.title = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy response');
    copyBtn.innerHTML = ICON_COPY;   // static constant, no user content
    copyBtn.addEventListener('click', async () => {
        let ok = true;
        try {
            await navigator.clipboard.writeText(raw);
        } catch {
            ok = false;
        }
        copyBtn.innerHTML = ok ? ICON_CHECK : ICON_COPY;
        copyBtn.title = ok ? 'Copied' : 'Copy failed';
        setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.title = 'Copy'; }, 1500);
    });
    bubble.appendChild(copyBtn);

    wrap.appendChild(bubble);
    _messagesEl.appendChild(wrap);
    scrollToBottom();

    let raw = '';
    let renderQueued = false;
    const renderNow = () => {
        renderQueued = false;
        textEl.innerHTML = renderMarkdown(raw);
        scrollToBottom();
    };

    // The status line sits above the text with a gap only while both are visible.
    const showStatus = (msg) => {
        toolLine.textContent = msg;
        toolLine.classList.remove('hidden');
        toolLine.classList.toggle('mb-1', !!raw);
    };

    return {
        appendText: (delta) => {
            if (!raw) toolLine.classList.add('hidden');
            raw += delta;
            if (!renderQueued) {
                renderQueued = true;
                requestAnimationFrame(renderNow);
            }
        },
        setToolStatus: (msg) => {
            if (msg) {
                showStatus(msg);
            } else if (raw) {
                toolLine.classList.add('hidden');
            } else {
                showStatus('Thinking…');
            }
        },
        appendChart: (spec) => {
            const chart = renderChart(chartsEl, spec);
            if (!chart) return;
            _charts.push(chart);
            bubble.style.width = '85%';   // charts need a real width, not shrink-to-fit
            toolLine.classList.toggle('mb-1', true);
            scrollToBottom();
        },
        hasText: () => !!raw || chartsEl.childElementCount > 0,
        finish: () => {
            renderNow();
            if (raw) copyBtn.classList.remove('hidden');
        },
        remove: () => wrap.remove(),
        insertNoticeBefore: (msg) => {
            const note = document.createElement('div');
            note.className = 'flex justify-start';
            const inner = document.createElement('div');
            inner.className = 'max-w-[85%] text-xs text-amber-400 border border-amber-800 bg-amber-950 rounded-lg px-3 py-1.5 break-words';
            inner.textContent = `ℹ ${msg}`;
            note.appendChild(inner);
            wrap.before(note);
            scrollToBottom();
        },
    };
}

function appendErrorBubble(msg) {
    const div = document.createElement('div');
    div.className = 'flex justify-start';

    const bubble = document.createElement('div');
    bubble.className = 'max-w-[85%] border border-red-800 bg-red-950 text-red-300 text-sm rounded-xl px-4 py-2.5 break-words';
    bubble.textContent = `⚠️ ${msg}`;

    div.appendChild(bubble);
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
                    'Show all open Critical and High priority tickets.',
                    'Who has Owner access, and which facilities have no owner?',
                    'Which facilities are outliers compared with the rest?',
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

// The Tandem MCP server uses its own authorization server, not the standard APS
// /authentication/v2 endpoints. Discovered via:
//   https://developer.api.autodesk.com/.well-known/oauth-protected-resource/tandem-mcp-server/v1/mcp
//   https://developer.api.autodesk.com/.well-known/oauth-authorization-server/mcpauth
const MCP_AUTHORIZE_URL = 'https://developer.api.autodesk.com/mcpauth/v1/authorize';
const MCP_TOKEN_URL     = 'https://developer.api.autodesk.com/mcpauth/v1/token';

function getMcpResource() {
    return MCP_URL;
}

async function exchangeMcpCode(clientId, redirectUri, code, verifier) {
    const resp = await fetch(MCP_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'authorization_code',
            client_id:     clientId,
            redirect_uri:  redirectUri,
            code,
            code_verifier: verifier,
            resource:      getMcpResource(),
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
    if (!clientId) throw new Error('Enter the MCP Client ID first.');

    // Static callback page; its URL must be registered as a callback on the APS app.
    const basePath    = location.pathname.replace(/[^/]*$/, '');
    const redirectUri = `${location.origin}${basePath}mcp-callback.html`;
    const verifier    = generateCodeVerifier();
    const challenge   = await generateCodeChallenge(verifier);

    // Store verifier so the callback (same-page popup) can reach it
    sessionStorage.setItem('mcp-pkce-verifier', verifier);
    sessionStorage.setItem('mcp-pkce-clientId', clientId);
    sessionStorage.setItem('mcp-pkce-redirectUri', redirectUri);

    const authURL = new URL(MCP_AUTHORIZE_URL);
    authURL.searchParams.set('response_type',         'code');
    authURL.searchParams.set('client_id',             clientId);
    authURL.searchParams.set('redirect_uri',          redirectUri);
    authURL.searchParams.set('scope',                 'mcp:read mcp:write offline_access');
    authURL.searchParams.set('resource',              getMcpResource());
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
const INPUT_CLS = 'w-full rounded border border-dark-border bg-dark-bg text-dark-text text-xs py-1.5 px-2 focus:outline-none focus:border-tandem-blue font-mono';

function mcpStatusHtml(token) {
    return token
        ? '<span class="text-green-400">✓ Connected</span>'
        : '<span class="text-dark-text-secondary">Not connected</span>';
}

function renderSettingsPane() {
    const prov = PROVIDERS[_settings.provider] ?? PROVIDERS.openai;
    let mcpToken = _settings.mcpToken;   // working copy until Save

    _settingsPane.innerHTML = `
        <div class="bg-dark-card border border-dark-border rounded-xl p-5 w-96 max-w-full shadow-xl">
            <h3 class="text-sm font-semibold text-dark-text mb-4">⚙ Chat Settings</h3>

            <label class="block text-xs text-dark-text-secondary mb-1">Provider</label>
            <select id="chat-prov" class="${INPUT_CLS} mb-3 font-sans">
                <option value="openai"    ${_settings.provider === 'openai'    ? 'selected' : ''}>OpenAI</option>
                <option value="anthropic" ${_settings.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
            </select>

            <label class="block text-xs text-dark-text-secondary mb-1">Model</label>
            <datalist id="chat-model-list">
                ${prov.models.map(m => `<option value="${m}">`).join('')}
            </datalist>
            <input id="chat-model" type="text" list="chat-model-list"
                   value="${escAttr(_settings.model || prov.defaultModel)}"
                   placeholder="e.g. ${escAttr(prov.defaultModel)}"
                   class="${INPUT_CLS} mb-1"/>
            <p class="text-xs text-dark-text-secondary mb-3">
                Pick a suggestion or type any model ID.
                <a id="chat-model-docs" href="${escAttr(prov.docsURL)}" target="_blank" rel="noopener"
                   class="text-tandem-blue hover:underline">Model list ↗</a>
            </p>

            <label class="block text-xs text-dark-text-secondary mb-1">API Key</label>
            <input id="chat-key" type="password" placeholder="Paste your API key…"
                   value="${escAttr(_settings.apiKey)}" class="${INPUT_CLS} mb-1"/>
            <p class="text-xs text-dark-text-secondary mb-4">
                Stored in this browser only and sent directly to <span id="chat-prov-label">${prov.label}</span>.
            </p>

            <div id="chat-mcp-section" class="border-t border-dark-border pt-3 mb-4 ${_settings.provider === 'anthropic' ? '' : 'hidden'}">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-medium text-dark-text">Tandem MCP <span class="font-normal text-dark-text-secondary">(optional)</span></span>
                    <span id="chat-mcp-status" class="text-xs">${mcpStatusHtml(mcpToken)}</span>
                </div>
                <p class="text-xs text-dark-text-secondary mb-2">
                    Lets the assistant answer general Tandem questions. Needs the Client ID of an APS app with this page's
                    <code class="text-tandem-blue">mcp-callback.html</code> registered as a callback.
                </p>
                <input id="chat-mcp-client-id" type="password" autocomplete="off" placeholder="MCP Client ID"
                       value="${escAttr(_settings.mcpClientId)}" class="${INPUT_CLS} mb-2"/>
                <div class="flex gap-2">
                    <button id="chat-mcp-authorize"
                            class="flex-1 px-3 py-1.5 text-xs font-medium rounded border border-tandem-blue text-tandem-blue hover:bg-tandem-blue hover:text-white transition">
                        Authorize
                    </button>
                    <button id="chat-mcp-disconnect"
                            class="px-3 py-1.5 text-xs font-medium rounded border border-dark-border text-dark-text-secondary hover:bg-dark-border transition ${mcpToken ? '' : 'hidden'}">
                        Disconnect
                    </button>
                </div>
                <p id="chat-mcp-msg" class="text-xs mt-1"></p>
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

    const setMcpToken = token => {
        mcpToken = token;
        getEl('chat-mcp-status').innerHTML = mcpStatusHtml(token);
        getEl('chat-mcp-disconnect').classList.toggle('hidden', !token);
    };

    // Provider change → update model suggestions; MCP is Anthropic-only
    getEl('chat-prov').addEventListener('change', e => {
        const p = PROVIDERS[e.target.value] ?? PROVIDERS.openai;
        getEl('chat-model-list').innerHTML = p.models.map(m => `<option value="${m}">`).join('');
        const modelInput = getEl('chat-model');
        modelInput.value       = p.defaultModel;
        modelInput.placeholder = `e.g. ${p.defaultModel}`;
        getEl('chat-prov-label').textContent = p.label;
        getEl('chat-model-docs').href        = p.docsURL;
        getEl('chat-mcp-section').classList.toggle('hidden', e.target.value !== 'anthropic');
    });

    getEl('chat-mcp-authorize').addEventListener('click', async () => {
        _settings.mcpClientId = getEl('chat-mcp-client-id').value.trim();
        const msgEl = getEl('chat-mcp-msg');
        const btn   = getEl('chat-mcp-authorize');
        btn.disabled    = true;
        btn.textContent = 'Waiting for popup…';
        msgEl.innerHTML = '<span class="text-amber-400">Sign in and approve access in the popup…</span>';
        try {
            setMcpToken(await authorizeMcp());
            msgEl.innerHTML = '<span class="text-green-400">Token obtained — click Save.</span>';
        } catch (err) {
            msgEl.innerHTML = `<span class="text-red-400">${escHtml(err.message)}</span>`;
        } finally {
            btn.disabled    = false;
            btn.textContent = 'Authorize';
        }
    });

    getEl('chat-mcp-disconnect').addEventListener('click', () => {
        setMcpToken('');
        getEl('chat-mcp-msg').innerHTML = '<span class="text-dark-text-secondary">Click Save to apply.</span>';
    });

    getEl('chat-settings-save').addEventListener('click', () => {
        _settings.provider    = getEl('chat-prov').value;
        _settings.model       = getEl('chat-model').value.trim() || PROVIDERS[_settings.provider].defaultModel;
        _settings.apiKey      = getEl('chat-key').value.trim();
        _settings.mcpClientId = getEl('chat-mcp-client-id').value.trim();
        _settings.mcpToken    = mcpToken;
        saveSettings();
        _mcpFailed = false;   // settings changed — give MCP another chance
        toggleSettings(false);
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
            note  => bubble.insertNoticeBefore(note),
            spec  => bubble.appendChart(spec),
        );
    } catch (err) {
        console.error('Chat error:', err);
        // Drop the empty "Thinking…" bubble; keep it only if a partial answer streamed in
        if (!bubble.hasText()) bubble.remove();
        appendErrorBubble(err.message || 'An error occurred. Check your API key in Settings.');
        // Roll back the last user message so history stays consistent
        if (_history.at(-1)?.role === 'user') _history.pop();
    } finally {
        bubble.finish();
        setThinking(false);
    }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Reset state and render placeholder. Called when account changes.
 */
export function render(facilities, regionMap, accountName, accounts) {
    _facilities  = facilities ?? [];
    _regionMap   = regionMap  ?? null;
    _accountName = accountName ?? '';
    _accounts    = accounts   ?? [];
    setToolContext({ facilities: _facilities, regionMap: _regionMap, accounts: _accounts, accountName: _accountName });
    _history     = [];
    _charts.forEach(c => c.destroy());
    _charts      = [];
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
