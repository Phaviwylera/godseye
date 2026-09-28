/* Browser-local map positions. Does not record people, cameras or feed history. */
const SavedViews = (() => {
  const KEY = 'ge_saved_positions_v1';
  function valid(view) {
    return view && typeof view.name === 'string' && view.name.length > 0 && view.name.length <= 60 &&
      Array.isArray(view.center) && view.center.length === 2 &&
      view.center.every(Number.isFinite) && Math.abs(view.center[0]) <= 180 && Math.abs(view.center[1]) <= 90 &&
      Number.isFinite(view.zoom) && view.zoom >= 0 && view.zoom <= 24 &&
      Number.isFinite(view.pitch) && view.pitch >= 0 && view.pitch <= 85 && Number.isFinite(view.bearing);
  }
  function read(storage) {
    try { const values = JSON.parse(storage.getItem(KEY) || '[]'); return Array.isArray(values) ? values.filter(valid).slice(0, 12) : []; }
    catch { return []; }
  }
  function init(getMap, storage) {
    const form = document.getElementById('saved-view-form');
    if (!form) return;
    const input = document.getElementById('saved-view-name');
    const list = document.getElementById('saved-view-list');
    const status = document.getElementById('saved-view-status');
    let values = read(storage);
    function commit(next) {
      try { storage.setItem(KEY, JSON.stringify(next)); values = next; render(); return true; }
      catch { status.textContent = 'Browser storage unavailable; position was not saved.'; return false; }
    }
    function render() {
      list.replaceChildren();
      for (const [index, view] of values.entries()) {
        const row = document.createElement('div'); row.className = 'btn-group';
        const go = document.createElement('button'); go.type = 'button'; go.textContent = view.name;
        go.onclick = () => {
          const map = getMap(); if (!map) return;
          map.easeTo({center:view.center,zoom:view.zoom,pitch:view.pitch,bearing:view.bearing,duration:800});
          document.getElementById('map-tools-close').click();
        };
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove saved position ${view.name}`);
        remove.onclick = () => { if (commit(values.filter((_, i) => i !== index))) status.textContent = 'Saved position removed.'; };
        row.append(go, remove); list.append(row);
      }
    }
    form.onsubmit = event => {
      event.preventDefault();
      const map = getMap(); const name = input.value.trim();
      if (!map || !name) { status.textContent = 'Enter a name after the map loads.'; return; }
      if (values.length >= 12) { status.textContent = 'Limit: 12 saved positions. Remove one first.'; return; }
      const center = map.getCenter();
      const view = {name,center:[((center.lng + 180) % 360 + 360) % 360 - 180,center.lat],zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()};
      if (!valid(view)) { status.textContent = 'This map position cannot be saved.'; return; }
      if (commit([...values, view])) { input.value = ''; status.textContent = 'Saved on this browser.'; }
    };
    render();
  }
  return {valid,read,init};
})();
if (typeof document !== 'undefined') {
  try { SavedViews.init(() => typeof map === 'undefined' ? null : map, localStorage); } catch { /* unavailable storage must not stop the globe */ }
}
