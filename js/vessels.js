/* Recent AIS observations and their actual sampled trail (up to 30 minutes). */
const Vessels = (() => {
  let map, enabled = false, timer = null, bound = false, requestId = 0;
  let selected = null, latest = [], lastOk = 0, source = '';

  /* The corridor collector needs a provider key configured on the server. When it is not — or
   * when the app is served by `python3 server.py` — fall back to Digitraffic's open AIS, which
   * is keyless and covers Finnish waters. Both are real observations; the chip says which. */
  const OPEN_AIS = 'https://meri.digitraffic.fi/api/v1/locations/latest';

  /* Public AIS endpoints do not all agree on their envelope or field names, so accept the
   * shapes that are actually published rather than the one shape we would have preferred. */
  function parseOpenAis(payload) {
    const rows = Array.isArray(payload) ? payload
      : (payload && (payload.locations || payload.features || payload.data)) || [];
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const geometry = row && row.geometry;
      const props = (row && row.properties) || row || {};
      const coords = Array.isArray(geometry && geometry.coordinates) ? geometry.coordinates : [];
      const lat = Number(coords.length ? coords[1] : (props.lat ?? props.latitude));
      const lon = Number(coords.length ? coords[0] : (props.lon ?? props.longitude));
      const mmsi = String(props.mmsi ?? props.MMSI ?? props.userId ?? '').trim();
      if (!/^\d{9}$/.test(mmsi) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
      const speed = Number(props.sog ?? props.speed ?? props.Sog);
      const course = Number(props.cog ?? props.course ?? props.heading ?? props.Cog);
      const received = props.time || props.timestamp || props.lastReport || new Date().toISOString();
      out.push({ mmsi, name: String(props.name || props.shipName || props.ShipName || '').trim().slice(0, 70) || `MMSI ${mmsi}`,
        lat, lon,
        speed: Number.isFinite(speed) && speed >= 0 && speed < 102.3 ? Math.round(speed * 10) / 10 : null,
        course: Number.isFinite(course) && course >= 0 && course < 360 ? course : null,
        received: new Date(received).toISOString(), track: [] });
    }
    return out;
  }

  function ago() {
    if (!lastOk) return '';
    const minutes = Math.max(1, Math.round((Date.now() - lastOk) / 60000));
    return minutes < 60 ? `${minutes} MIN AGO` : `${(minutes / 60).toFixed(1)} H AGO`;
  }
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
    map.getSource('vessel-endpoints')?.setData({ type: 'FeatureCollection',
      features: track.length < 2 ? [] : [
        { type: 'Feature', properties: { label: 'FIRST OBSERVED' }, geometry: { type: 'Point', coordinates: track[0].slice(0, 2) } },
        { type: 'Feature', properties: { label: 'LATEST' }, geometry: { type: 'Point', coordinates: track.at(-1).slice(0, 2) } },
      ] });
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
    for (const source of ['vessels', 'vessel-trail', 'vessel-waypoints', 'vessel-endpoints']) {
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
    if (!map.getLayer('vessel-endpoint-labels')) map.addLayer({
      id: 'vessel-endpoint-labels', type: 'symbol', source: 'vessel-endpoints',
      layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, 1.8],
        'text-allow-overlap': true },
      paint: { 'text-color': '#a9f9eb', 'text-halo-color': '#041c22', 'text-halo-width': 2 },
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
      note.textContent = count > 1 ? `${count} observed trail positions in the last 30 minutes · first and latest are sample endpoints, not the full voyage` : 'Trail begins after a second distinct AIS position is observed';
      box.append(title, detail, note);
      new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(item.geometry.coordinates).setDOMContent(box).addTo(map);
    });
    map.on('mouseenter', 'vessel-points', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'vessel-points', () => { map.getCanvas().style.cursor = 'grab'; });
  }
  async function refresh() {
    if (!enabled) return;
    const id = ++requestId;
    let vessels = [];
    let provenance = '';

    try {
      const response = await fetch('/.netlify/functions/ais-vessels', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const snapshot = await response.json();
      vessels = snapshot.vessels || [];
      if (vessels.length) {
        provenance = `AIS positions observed within the last five minutes. Snapshot: ${new Date(snapshot.observed).toLocaleString()}. Coverage: selected shipping corridors.`;
      }
    } catch { /* no keyed collector here: try the open feed below */ }

    if (!vessels.length) {
      try {
        const open = parseOpenAis(await Sources.fetchJSON(OPEN_AIS, 60));
        if (open.length) {
          vessels = open;
          provenance = 'Open AIS published by Digitraffic (Finnish Transport Agency), no key required. Coverage: Finnish waters. The corridor collector is not configured on this host.';
        }
      } catch { /* neither source answered: keep what is on the map and say so */ }
    }

    if (!enabled || id !== requestId) return;

    if (!vessels.length) {
      /* A failed poll must not empty the ocean: hold the last good sweep and report its age. */
      if (latest.length) {
        status(`◇ ${latest.length} VESSELS · HELD · ${ago()}`);
        chip().title = `Neither AIS source answered this poll. Showing the last sweep that succeeded, ${ago().toLowerCase()}. ${source}`;
        return;
      }
      latest = []; showVessels();
      status('◇ AIS UNAVAILABLE');
      chip().title = 'No recent AIS snapshot from the corridor collector or the open Digitraffic feed; retry later.';
      return;
    }

    latest = vessels;
    lastOk = Date.now();
    source = provenance;
    restore();
    status(`◇ ${latest.length} VESSELS · RECENT AIS`);
    chip().title = provenance;
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
      Contacts.close();
      for (const layer of ['vessel-points', 'vessel-endpoint-labels', 'vessel-waypoint-dots', 'vessel-trail-line']) {
        if (map.getLayer(layer)) map.removeLayer(layer);
      }
      for (const source of ['vessels', 'vessel-endpoints', 'vessel-waypoints', 'vessel-trail']) {
        if (map.getSource(source)) map.removeSource(source);
      }
    }
    return enabled;
  }
  function openList() {
    if (!enabled) return;
    const center = map.getCenter();
    const rows = [...latest].sort((a, b) =>
      Math.abs(a.lon - center.lng) + Math.abs(a.lat - center.lat) -
      Math.abs(b.lon - center.lng) - Math.abs(b.lat - center.lat));
    Contacts.open(`${latest.length} VESSELS · RECENT AIS`, rows.map(v => ({
      label: v.name, detail: `MMSI ${v.mmsi} · ${v.speed == null ? 'speed unknown' : `${v.speed} kn`} · ${v.track?.length || 0} observed positions`, vessel: v,
    })), row => {
      const vessel = row.vessel;
      selected = vessel.mmsi;
      showTrack();
      map.easeTo({ center: [vessel.lon, vessel.lat], zoom: Math.max(map.getZoom(), 9),
        duration: 650, essential: true });
    });
  }
  function init(instance) { map = instance; }
  return { init, toggle, restore, refresh, openList, parseOpenAis };
})();
