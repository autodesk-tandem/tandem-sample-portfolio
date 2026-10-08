/**
 * Renders chart specs produced by chat tools (see tools.js) inside the chat window.
 *
 * Uses the Chart.js global already loaded by index.html. Specs may originate from
 * model output, so everything is validated/clamped here and drawn on a canvas —
 * no HTML from the spec is ever inserted into the page.
 *
 * Spec: {
 *   kind: 'line' | 'bar' | 'pie' | 'doughnut',
 *   title?, subtitle?, yLabel?,
 *   xType: 'time' | 'category',
 *   labels?: string[],                              // category charts
 *   datasets: [{ label, data: number[] | {x,y}[] }],// {x: epochMs, y} for time charts
 *   horizontal?, stacked?                           // bar only
 * }
 */

const KINDS         = new Set(['line', 'bar', 'pie', 'doughnut']);
const MAX_DATASETS  = 8;
const MAX_CATEGORIES = 200;
const MAX_POINTS    = 1500;   // per series; longer series are thinned for rendering
const PALETTE = ['#0696D7', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6', '#F97316', '#EF4444'];

const TEXT_COLOR = '#e0e0e0';
const MUTED      = '#a0a0a0';
const GRID       = '#404040';
const BG         = '#1a1a1a';

const str = (v, max = 120) => String(v ?? '').slice(0, max);

function thin(points) {
    if (points.length <= MAX_POINTS) return points;
    const step = Math.ceil(points.length / MAX_POINTS);
    const out = points.filter((_, i) => i % step === 0);
    if (out.at(-1) !== points.at(-1)) out.push(points.at(-1));
    return out;
}

function normalize(raw) {
    if (!raw || !KINDS.has(raw.kind)) return null;
    const isTime = raw.xType === 'time' && raw.kind === 'line';

    const datasets = (Array.isArray(raw.datasets) ? raw.datasets : []).slice(0, MAX_DATASETS).map(d => {
        const data = Array.isArray(d?.data) ? d.data : [];
        if (isTime) {
            const pts = data
                .map(p => ({ x: Number(p?.x), y: Number(p?.y) }))
                .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
            return { label: str(d.label), data: thin(pts) };
        }
        return { label: str(d.label), data: data.slice(0, MAX_CATEGORIES).map(v => (Number.isFinite(Number(v)) ? Number(v) : null)) };
    }).filter(d => d.data.length);
    if (!datasets.length) return null;

    return {
        kind: raw.kind,
        isTime,
        title: str(raw.title),
        subtitle: str(raw.subtitle),
        yLabel: str(raw.yLabel),
        labels: isTime ? [] : (Array.isArray(raw.labels) ? raw.labels.slice(0, MAX_CATEGORIES).map(l => str(l, 60)) : []),
        datasets,
        horizontal: !!raw.horizontal && raw.kind === 'bar',
        stacked: !!raw.stacked && raw.kind === 'bar',
    };
}

function formatTick(ts, spanMs) {
    const d = new Date(ts);
    return spanMs <= 2 * 86_400_000
        ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildConfig(spec) {
    const circular = spec.kind === 'pie' || spec.kind === 'doughnut';
    const common = {
        responsive: true,
        maintainAspectRatio: false,
        animation: spec.isTime ? false : { duration: 300 },
        plugins: {
            legend: {
                display: circular || spec.datasets.length > 1,
                position: circular ? 'right' : 'bottom',
                labels: { color: TEXT_COLOR, boxWidth: 12, font: { size: 11 } },
            },
            tooltip: { mode: circular ? 'nearest' : 'index', intersect: false },
        },
    };

    if (circular) {
        const ds = spec.datasets[0];
        return {
            type: spec.kind,
            data: {
                labels: spec.labels,
                datasets: [{
                    label: ds.label,
                    data: ds.data,
                    backgroundColor: ds.data.map((_, i) => PALETTE[i % PALETTE.length]),
                    borderColor: BG,
                    borderWidth: 2,
                }],
            },
            options: common,
        };
    }

    if (spec.isTime) {
        const xs = spec.datasets.flatMap(d => [d.data[0].x, d.data.at(-1).x]);
        const span = Math.max(...xs) - Math.min(...xs);
        const multiAxis = spec.datasets.length > 1;

        const scales = {
            x: {
                type: 'linear',
                ticks: { color: MUTED, maxTicksLimit: 8, maxRotation: 0, callback: v => formatTick(v, span) },
                grid: { color: GRID },
            },
        };
        const datasets = spec.datasets.map((d, i) => {
            const axisId = multiAxis ? `y${i}` : 'y';
            scales[axisId] = {
                position: i % 2 === 0 ? 'left' : 'right',
                display: i < 2,   // further axes stay hidden to avoid clutter; scaling is per series
                ticks: { color: PALETTE[i % PALETTE.length] },
                grid: { color: GRID, drawOnChartArea: i === 0 },
                title: { display: !!spec.yLabel && i === 0, text: spec.yLabel, color: MUTED },
            };
            return {
                label: d.label,
                data: d.data,
                yAxisID: axisId,
                borderColor: PALETTE[i % PALETTE.length],
                backgroundColor: PALETTE[i % PALETTE.length],
                borderWidth: 1.5,
                pointRadius: d.data.length > 150 ? 0 : 2,
                pointHoverRadius: 4,
                tension: 0.15,
            };
        });

        return {
            type: 'line',
            data: { datasets },
            options: {
                ...common,
                parsing: false,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                plugins: {
                    ...common.plugins,
                    tooltip: {
                        mode: 'nearest', axis: 'x', intersect: false,
                        callbacks: { title: items => (items[0] ? new Date(items[0].parsed.x).toLocaleString() : '') },
                    },
                },
                scales,
            },
        };
    }

    // category bar / line
    const indexAxis = spec.horizontal ? 'y' : 'x';
    const valueAxis = spec.horizontal ? 'x' : 'y';
    return {
        type: spec.kind,
        data: {
            labels: spec.labels,
            datasets: spec.datasets.map((d, i) => ({
                label: d.label,
                data: d.data,
                backgroundColor: PALETTE[i % PALETTE.length],
                borderColor: PALETTE[i % PALETTE.length],
                borderWidth: spec.kind === 'line' ? 2 : 0,
                tension: 0.15,
            })),
        },
        options: {
            ...common,
            indexAxis,
            scales: {
                [indexAxis]: { stacked: spec.stacked, ticks: { color: MUTED }, grid: { color: GRID } },
                [valueAxis]: {
                    stacked: spec.stacked,
                    beginAtZero: true,
                    ticks: { color: MUTED },
                    grid: { color: GRID },
                    title: { display: !!spec.yLabel, text: spec.yLabel, color: MUTED },
                },
            },
        },
    };
}

// Paints the dark background so exported PNGs are not transparent
const backgroundPlugin = {
    id: 'chatChartBackground',
    beforeDraw(chart) {
        const { ctx, width, height } = chart;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
    },
};

/**
 * Draw a chart inside `container`.
 * @returns {{ destroy: () => void } | null} null when the spec is invalid
 */
export function renderChart(container, rawSpec) {
    const spec = normalize(rawSpec);
    if (!spec) return null;

    const card = document.createElement('div');
    card.className = 'my-2 rounded-lg border border-dark-border bg-dark-bg p-3';

    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-3 mb-2';
    const titles = document.createElement('div');
    if (spec.title) {
        const t = document.createElement('p');
        t.className = 'text-sm font-semibold text-white';
        t.textContent = spec.title;
        titles.appendChild(t);
    }
    if (spec.subtitle) {
        const t = document.createElement('p');
        t.className = 'text-xs text-dark-text-secondary';
        t.textContent = spec.subtitle;
        titles.appendChild(t);
    }
    head.appendChild(titles);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'shrink-0 text-xs text-dark-text-secondary hover:text-white border border-dark-border rounded px-2 py-0.5';
    saveBtn.textContent = 'Save PNG';
    head.appendChild(saveBtn);
    card.appendChild(head);

    const box = document.createElement('div');
    box.style.position = 'relative';
    box.style.height = spec.kind === 'bar' && spec.horizontal
        ? `${Math.min(700, Math.max(240, spec.labels.length * 28 + 70))}px`
        : '300px';
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    card.appendChild(box);
    container.appendChild(card);

    const ChartJS = window.Chart;
    if (!ChartJS) {
        box.remove();
        const msg = document.createElement('p');
        msg.className = 'text-xs text-red-300';
        msg.textContent = 'Chart library failed to load — reload the page to see charts.';
        card.appendChild(msg);
        saveBtn.remove();
        return { destroy: () => card.remove() };
    }

    const config = buildConfig(spec);
    config.plugins = [backgroundPlugin];
    const chart = new ChartJS(canvas, config);

    saveBtn.addEventListener('click', () => {
        canvas.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(spec.title || 'chart').replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    });

    return { destroy: () => { chart.destroy(); card.remove(); } };
}
