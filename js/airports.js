/* AIRPORTS — every aerodrome, heliport and seaplane base mapped, from the public-domain
 * OurAirports dataset (data/airports.json, rebuilt weekly by tools/build_airports.py).
 *
 * This is a static registry, not live traffic: what a port map sells as "47k airports"
 * is exactly this dataset, and it is drawn as such — 72k+ points, tiered in by zoom so the
 * globe stays honest and readable: large/medium aerodromes from the start, small fields from
 * regional zoom, heliports and seaplane bases only up close. Clicking one shows what the
 * registry actually knows: code, name, municipality, country and type — nothing inferred. */
const Airports = (() => {
  let map = null;
  let enabled = false;
  let doc = null;               // parsed airports.json
  let bound = false;

  const chip = () => document.getElementById('airport-chip');
  const button = () => document.getElementById('btn-airports');
  const empty = () => ({ type: 'FeatureCollection', features: [] });

  /* Tiering by the compact type codes the builder writes: large/medium paint from the start,
   * small airfields wait for regional zoom, helipads and water aerodromes for street zoom. */
  const TIERS = [
    { id: 'lm', kinds: ['l', 'm'], minzoom: 0, radius: [[0, 2.2], [6, 3.4], [10, 4.6]] },
    { id: 's', kinds: ['s'], minzoom: 6.5, radius: [[6.5, 1.6], [10, 2.6], [13, 3.6]] },
    { id: 'h', kinds: ['h', 'w', 'b'], minzoom: 9, radius: [[9, 1.6], [13, 3.2]] },
  ];
  const COLOURS = {
    l: '#cfeaf7',   // large aerodrome: brightest, it is a destination
    m: '#8be9fa',   // medium: the globe's cyan
    s: '#4a7d94',   // small: dim steel, present but quiet
    h: '#41efc2',   // helipad: the teal the vessel layer already uses
    w: '#5fd7c9',
    b: '#6b7f94',
  };
  const TYPE = { l: 'large airport', m: 'medium airport', s: 'small airport', h: 'heliport', w: 'seaplane base', b: 'balloonport' };

  async function load() {
    if (doc) return doc;
    const response = await fetch('data/airports.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Aerodrome registry unavailable');
    const json = await response.json();
    if (!json || !Array.isArray(json.records) || !json.records.length) throw new Error('Aerodrome registry is empty');
    doc = json;
    return doc;
  }

  function featuresFor(kinds) {
    const want = new Set(kinds);
    return {
      type: 'FeatureCollection',
      features: doc.records
        .filter((r) => want.has(r[2]))
        .map((r) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r[0], r[1]] },
          properties: { kind: r[2], code: r[3], name: r[4], muni: r[5], iso: r[6], type: TYPE[r[2]] || 'aerodrome' },
        })),
    };
  }

  function ensureLayers() {
    for (const tier of TIERS) {
      const sourceId = `airports-${tier.id}`;
      if (!map.getSource(sourceId)) map.addSource(sourceId, { type: 'geojson', data: empty() });
      if (!map.getLayer(`${sourceId}-dots`)) map.addLayer({
        id: `${sourceId}-dots`, type: 'circle', source: sourceId, minzoom: tier.minzoom,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            ...tier.radius.flatMap(([z, r]) => [z, r])],
          'circle-color': ['match', ['get', 'kind'],
            'l', COLOURS.l, 'm', COLOURS.m, 's', COLOURS.s, 'h', COLOURS.h, 'w', COLOURS.w, COLOURS.b],
          'circle-opacity': 0.88,
          'circle-stroke-width': 0.8,
          'circle-stroke-color': '#04121a',
        },
      });
      map.setLayoutProperty(`${sourceId}-dots`, 'visibility', 'visible');
    }
    /* IATA-style labels only appear once the regional clutter is gone. */
    if (!map.getLayer('airports-labels')) map.addLayer({
      id: 'airports-labels', type: 'symbol', source: 'airports-lm', minzoom: 7,
      layout: {
        'text-field': ['get', 'code'], 'text-size': 10, 'text-offset': [0, 1.15],
        'text-allow-overlap': false, 'text-font': ['Open Sans Regular'],
      },
      paint: { 'text-color': '#bfe9f7', 'text-halo-color': '#04121a', 'text-halo-width': 1.6 },
    });
  }

  function refresh() {
    for (const tier of TIERS) {
      const source = map.getSource(`airports-${tier.id}`);
      if (source) source.setData(featuresFor(tier.kinds));
    }
    const node = chip();
    if (node) {
      const counts = doc.records.reduce((tally, r) => tally.set(r[2], (tally.get(r[2]) || 0) + 1), new Map());
      node.textContent = `◇ ${doc.count.toLocaleString('en-US')} AERODROMES MAPPED`;
      node.title = 'Aerodrome registry (static) — ' +
        [...counts.entries()].map(([k, n]) => `${TYPE[k] || k}: ${n.toLocaleString('en-US')}`).join(' · ') +
        ' · zoom in for smaller fields · data: OurAirports (public domain), refreshed weekly';
      node.classList.remove('hidden');
    }
  }

  function popupFor(props, lonlat) {
    const box = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = props.name || props.code || 'Aerodrome';
    const detail = document.createElement('div');
    detail.textContent = [
      props.code && `code ${props.code}`,
      props.type,
      props.muni && props.iso ? `${props.muni}, ${props.iso}` : (props.muni || props.iso || ''),
    ].filter(Boolean).join(' · ');
    const note = document.createElement('div');
    note.textContent = 'Static registry position from OurAirports — not live traffic; the AIR layer tracks live aircraft.';
    const credit = document.createElement('div');
    credit.textContent = 'Registry: OurAirports (public domain) · ourairports.com';
    box.append(title, detail, note, credit);
    new maplibregl.Popup({ closeButton: true, maxWidth: '320px' }).setLngLat(lonlat).setDOMContent(box).addTo(map);
  }

  function bind() {
    if (bound || !map) return;
    bound = true;
    for (const tier of TIERS) {
      const layer = `airports-${tier.id}-dots`;
      map.on('click', layer, (event) => {
        const feature = event.features && event.features[0];
        if (!feature) return;
        popupFor(feature.properties, feature.geometry.coordinates);
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = 'grab'; });
    }
  }

  function openList() {
    if (!enabled || !doc) return;
    const center = map.getCenter();
    const rows = doc.records
      .filter((r) => r[2] === 'l' || r[2] === 'm')
      .map((r) => ({ r, d: Math.abs(r[0] - center.lng) + Math.abs(r[1] - center.lat) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 400)
      .map(({ r }) => ({
        label: `${r[3] ? `${r[3]} · ` : ''}${r[4]}`,
        detail: `${TYPE[r[2]]}${r[5] || r[6] ? ` · ${[r[5], r[6]].filter(Boolean).join(', ')}` : ''} · static registry`,
        r,
      }));
    Contacts.open(`${doc.count.toLocaleString('en-US')} AERODROMES · REGISTRY`, rows, (row) => {
      map.easeTo({ center: [row.r[0], row.r[1]], zoom: Math.max(map.getZoom(), 9), duration: 650, essential: true });
    });
  }

  function toggle() {
    enabled = !enabled;
    if (enabled) {
      load().then(() => { if (!enabled) return; ensureLayers(); refresh(); bind(); })
        .catch((error) => {
          enabled = false;
          if (button()) button().classList.remove('active');
          console.warn('airport registry unavailable', error);
        });
    } else {
      for (const tier of TIERS) {
        if (map.getLayer(`airports-${tier.id}-dots`)) map.removeLayer(`airports-${tier.id}-dots`);
        if (map.getSource(`airports-${tier.id}`)) map.removeSource(`airports-${tier.id}`);
      }
      if (map.getLayer('airports-labels')) map.removeLayer('airports-labels');
      chip()?.classList.add('hidden');
      Contacts.close();
    }
    return enabled;
  }

  /* Called on every basemap restyle: layers must be re-added, fixes are already fetched. */
  function restore() {
    if (!enabled || !map || !doc) return;
    ensureLayers();
    refresh();
    bind();
  }

  function init(instance) { map = instance; }

  return { init, toggle, restore, load, featuresFor, TIERS, TYPE };
})();
