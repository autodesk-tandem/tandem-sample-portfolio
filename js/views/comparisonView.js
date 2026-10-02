/**
 * Comparison View — stub.
 *
 * Spec: specs/ux.md  (View 3: Compare)
 * Implementation planned for next iteration.
 *
 * Will use Chart.js (already loaded in index.html) to:
 *  - Let user select up to 10 facilities to compare
 *  - Let user select a metric (stream type, matched via streamMatcher.js)
 *  - Render a bar chart + table with hot-spot highlighting
 *  - Prompt user to disambiguate ambiguous stream name matches
 */

export function render(facilities, regionMap) {
    const container = document.getElementById('compareContent');

    container.innerHTML = `
        <div class="flex items-center justify-center py-24 text-dark-text-secondary text-sm">
            Comparison view coming soon.
        </div>`;
}
