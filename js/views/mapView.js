/**
 * Map View — stub.
 *
 * Spec: specs/ux.md  (View 2: Map)
 * Implementation planned for next iteration.
 *
 * Will use Leaflet.js (already loaded in index.html) to:
 *  - Show facility pins color-coded green/yellow/red
 *  - Click pin → popup with facility summary + Open in Tandem link
 *  - Allow users to set lat/lng for unlocated facilities (stored via locationStore.js)
 */

export function render(facilities, regionMap) {
    const container = document.getElementById('map-container');
    const unlocated  = document.getElementById('unlocatedPanel');

    container.innerHTML = `
        <div class="flex items-center justify-center h-full bg-dark-bg text-dark-text-secondary text-sm">
            Map view coming soon.
        </div>`;

    unlocated.innerHTML = '';
}
