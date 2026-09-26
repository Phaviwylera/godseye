/* Recent AISStream observations; server publishes one shared snapshot every two minutes. */
const Vessels = (() => {
  let map, enabled = false, timer = null, bound = false, requestId = 0;
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  const chip = () => document.getElementById('vessel-chip');
  const button = () => document.getElementById('btn-vessels');
  function status(message) {
    if (chip()) { chip().textContent = message; chip().classList.toggle('hidden', !enabled); }
  }
  function restore() {
    if (!enabled || !map) return;
    if (!map.getSource('vessels')) map.addSource('vessels', { type: 'geojson', data: empty() });
    if (!map.getLayer('vessel-points')) map.addLayer({
      id: 'vessel-points', type: 'circle', source: 'vessels',
      paint: { 'circle-radius': 5.5, 'circle-color': '#65e4d2',
        'circle-stroke-color': '#042627', 'circle-stroke-width': 1.8 },
    });
    if (bound) return;
    bound = true;
    map.on('click', 'vessel-points', event => {
      const item = event.features?.[0];
      if (!item) return;
      const p = item.properties;
      const box = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = String(p.name);
      const detail = document.createElement('div');
      detail.textContent = `MMSI ${p.mmsi} · ${p.speed == null ? 'speed unknown' : `${p.speed} kn`} · observed ${new Date(p.received).toLocaleTimeString()}`;
      box.append(title, detail);
      new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(item.geometry.coordinates).setDOMContent(box).addTo(map);
    });
    map.on('mouseenter', 'vessel-points', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'vessel-points', () => { map.getCanvas().style.cursor = ''; });
  }
  async function refresh() {
    if (!enabled) return;
    const id = ++requestId;
    try {
      const response = await fetch('/.netlify/functions/ais-vessels', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const snapshot = await response.json();
      if (!enabled || id !== requestId) return;
      restore();
      const features = (snapshot.vessels || []).map(p => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { mmsi: p.mmsi, name: p.name, speed: p.speed, received: p.received },
      }));
      map.getSource('vessels')?.setData({ type: 'FeatureCollection', features });
      status(`◇ ${features.length} VESSELS · RECENT AIS`);
      chip().title = `AIS positions observed within the last five minutes. Snapshot: ${new Date(snapshot.observed).toLocaleString()}. Coverage: selected shipping corridors.`;
    } catch {
      if (enabled && id === requestId) {
        map.getSource('vessels')?.setData(empty());
        status('◇ AIS UNAVAILABLE');
        chip().title = 'No recent AIS snapshot. Configure AISSTREAM_API_KEY in Netlify Functions or retry later.';
      }
    }
  }
  function toggle() {
    enabled = !enabled;
    button()?.classList.toggle('active', enabled);
    button()?.setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      restore();
      status('◇ AIS CONNECTING…');
      refresh();
      timer = setInterval(refresh, 60000);
    } else {
      requestId++;
      clearInterval(timer);
      chip()?.classList.add('hidden');
      if (map.getLayer('vessel-points')) map.removeLayer('vessel-points');
      if (map.getSource('vessels')) map.removeSource('vessels');
    }
    return enabled;
  }
  function init(instance) { map = instance; }
  return { init, toggle, restore, refresh };
})();
