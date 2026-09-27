/* Recent AIS observations and their actual sampled trail (up to 30 minutes). */
const Vessels = (() => {
  let map, enabled = false, timer = null, bound = false, requestId = 0;
  let selected = null, latest = [];
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  const chip = () => document.getElementById('vessel-chip');
  const button = () => document.getElementById('btn-vessels');
  function status(message) {
    if (chip()) { chip().textContent = message; chip().classList.toggle('hidden', !enabled); }
  }
  function shipIcon() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.shadowColor = '#65e4d2'; ctx.shadowBlur = 8;
    ctx.fillStyle = '#061d24'; ctx.strokeStyle = '#65e4d2'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(24, 3); ctx.lineTo(36, 19); ctx.lineTo(34, 36);
    ctx.quadraticCurveTo(24, 44, 14, 36); ctx.lineTo(12, 19); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0; ctx.fillStyle = '#9afbe9';
    ctx.fillRect(19, 20, 10, 13);
    ctx.fillStyle = '#65e4d2'; ctx.fillRect(22, 11, 4, 7);
    return ctx.getImageData(0, 0, 48, 48);
  }
  function showTrack() {
    const vessel = latest.find(item => item.mmsi === selected);
    const points = vessel?.track || [];
    const track = points.filter(p => Array.isArray(p) && p.length === 3 &&
      Number.isFinite(p[0]) && Number.isFinite(p[1]));
    map.getSource('vessel-trail')?.setData(track.length < 2 ? empty() : {
      type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: track.map(p => p.slice(0, 2)) } }],
    });
    map.getSource('vessel-waypoints')?.setData({ type: 'FeatureCollection',
      features: track.slice(0, -1).map(p => ({ type: 'Feature', properties: { observed: p[2] },
        geometry: { type: 'Point', coordinates: p.slice(0, 2) } })) });
  }
  function showVessels() {
    map.getSource('vessels')?.setData({ type: 'FeatureCollection', features: latest.map(p => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { mmsi: p.mmsi, name: p.name,
        speed: p.speed, course: p.course == null ? 0 : p.course, received: p.received },
    })) });
    showTrack();
  }
  function restore() {
    if (!enabled || !map) return;
    if (!map.hasImage('ge-ship')) map.addImage('ge-ship', shipIcon(), { pixelRatio: 2 });
    for (const source of ['vessels', 'vessel-trail', 'vessel-waypoints']) {
      if (!map.getSource(source)) map.addSource(source, { type: 'geojson', data: empty() });
    }
    if (!map.getLayer('vessel-trail-line')) map.addLayer({
      id: 'vessel-trail-line', type: 'line', source: 'vessel-trail',
      paint: { 'line-color': '#65e4d2', 'line-width': 2.5, 'line-opacity': 0.85,
        'line-dasharray': [2, 2] },
    });
    if (!map.getLayer('vessel-waypoint-dots')) map.addLayer({
      id: 'vessel-waypoint-dots', type: 'circle', source: 'vessel-waypoints',
      paint: { 'circle-radius': 3, 'circle-color': '#9afbe9',
        'circle-stroke-color': '#06232a', 'circle-stroke-width': 1 },
    });
    if (!map.getLayer('vessel-points')) map.addLayer({
      id: 'vessel-points', type: 'symbol', source: 'vessels',
      layout: { 'icon-image': 'ge-ship', 'icon-size': 1,
        'icon-rotate': ['get', 'course'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true },
    });
    showVessels();
    if (bound) return;
    bound = true;
    map.on('click', 'vessel-points', event => {
      const item = event.features?.[0];
      if (!item) return;
      const p = item.properties;
      selected = p.mmsi;
      showTrack();
      const vessel = latest.find(v => v.mmsi === selected);
      const count = vessel?.track?.length || 0;
      const box = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = String(p.name);
      const detail = document.createElement('div');
      detail.textContent = `MMSI ${p.mmsi} · ${p.speed == null ? 'speed unknown' : `${p.speed} kn`} · observed ${new Date(p.received).toLocaleTimeString()}`;
      const note = document.createElement('div');
      note.textContent = count > 1 ? `${count} observed trail positions in the last 30 minutes` : 'Trail begins after a second distinct AIS position is observed';
      box.append(title, detail, note);
      new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(item.geometry.coordinates).setDOMContent(box).addTo(map);
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
      latest = snapshot.vessels || [];
      restore();
      status(`◇ ${latest.length} VESSELS · RECENT AIS`);
      chip().title = `AIS positions observed within the last five minutes. Snapshot: ${new Date(snapshot.observed).toLocaleString()}. Coverage: selected shipping corridors.`;
    } catch {
      if (enabled && id === requestId) {
        latest = []; showVessels();
        status('◇ AIS UNAVAILABLE');
        chip().title = 'No recent AIS snapshot; retry later.';
      }
    }
  }
  function toggle() {
    enabled = !enabled;
    button()?.classList.toggle('active', enabled);
    button()?.setAttribute('aria-pressed', String(enabled));
    if (enabled) {
      restore(); status('◇ AIS CONNECTING…'); refresh();
      timer = setInterval(refresh, 60000);
    } else {
      requestId++; clearInterval(timer); selected = null; latest = [];
      chip()?.classList.add('hidden');
      for (const layer of ['vessel-points', 'vessel-waypoint-dots', 'vessel-trail-line']) {
        if (map.getLayer(layer)) map.removeLayer(layer);
      }
      for (const source of ['vessels', 'vessel-waypoints', 'vessel-trail']) {
        if (map.getSource(source)) map.removeSource(source);
      }
    }
    return enabled;
  }
  function init(instance) { map = instance; }
  return { init, toggle, restore, refresh };
})();
