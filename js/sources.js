/* GOD'S EYE — live source adapters.
 * All network calls go through the app server (/api/fetch, /api/proxy) so this
 * works from any host and over HTTPS (no CORS / mixed-content problems).
 */
const Sources = (() => {

  const fetchJSON = async (url) => {
    try {
      const r = await fetch("/api/fetch?url=" + encodeURIComponent(url));
      if (r.ok) return await r.json();
    } catch (e) { /* static hosting: fall back to direct (works when the source sends CORS) */ }
    const r2 = await fetch(url);
    if (!r2.ok) throw new Error("fetch " + r2.status);
    return r2.json();
  };

  /* --- each adapter returns an array of normalised cams (same shape as the
         bundled data/cameras.geojson properties) ------------------------- */

  async function ny511() {
    const d = await fetchJSON("https://511ny.org/api/getcameras?key=SIGNUP&format=json");
    return (d || []).filter(c => !c.Disabled && !c.Blocked && (c.Latitude || c.Latitude === 0)).map(c => {
      const vid = c.VideoUrl || "";
      const isHls = vid.includes(".m3u8");
      return {
        id: "511ny-" + c.ID, name: c.Name, src: "511ny",
        stype: isHls ? "m3u8" : "embed",
        stream: isHls ? vid : c.Url,
        country: "US", region: "NY", place: (c.RoadwayName || "").split("[")[0].trim(),
        dir: c.DirectionOfTravel || "", attr: "NYSDOT / 511NY", status: "live",
        page: c.Url || "", lon: c.Longitude, lat: c.Latitude,
      };
    });
  }

  async function singapore() {
    const d = await fetchJSON("https://api.data.gov.sg/v1/transport/traffic-images");
    const cams = ((d.items || [{}])[0].cameras) || [];
    return cams.map(c => ({
      id: "sg-" + c.camera_id, name: "Traffic camera " + c.camera_id, src: "sg",
      stype: "dynamic", stream: "https://api.data.gov.sg/v1/transport/traffic-images",
      country: "SG", region: "Singapore", place: "", dir: "",
      attr: "LTA / data.gov.sg", status: "live", page: "https://data.gov.sg",
      lon: c.location.longitude, lat: c.location.latitude,
    }));
  }

  /* dynamic snapshots: the image URL rotates — re-resolve the current frame */
  async function singaporeFrame(camId) {
    const d = await fetchJSON("https://api.data.gov.sg/v1/transport/traffic-images");
    const cams = ((d.items || [{}])[0].cameras) || [];
    const hit = cams.find(c => "sg-" + c.camera_id === camId || c.camera_id === camId);
    return hit ? hit.image : null;
  }

  async function otcMaster() {
    const d = await fetchJSON("https://raw.githubusercontent.com/AidanWelch/OpenTrafficCamMap/master/cameras/USA.json");
    const out = [];
    for (const [state, counties] of Object.entries(d)) {
      for (const [county, cams] of Object.entries(counties)) {
        for (const c of cams) {
          out.push({
            id: "otc-" + (c.description || "cam").slice(0, 40) + "-" + c.latitude + "," + c.longitude,
            name: c.description || "DOT camera", src: "otc",
            stype: c.format === "M3U8" ? "m3u8" : "image", stream: c.url,
            country: "US", region: state, place: county, dir: c.direction || "",
            attr: state + " DOT via OpenTrafficCamMap", status: "unknown",
            page: "https://github.com/AidanWelch/OpenTrafficCamMap",
            lon: c.longitude, lat: c.latitude,
          });
        }
      }
    }
    return out;
  }

  async function quebec() {
    const d = await fetchJSON(
      "https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0" +
      "&request=getfeature&typename=ms:infos_cameras&srsname=EPSG:4326&outputformat=geojson");
    return (d.features || []).map(f => {
      const p = f.properties || {}, g = f.geometry || {};
      const [lon, lat] = g.coordinates || [];
      return {
        id: "qc511-" + p.IDEcamera, name: p.DescriptionLocalisationEn || p.DescriptionLocalisationFr,
        src: "qc511", stype: "embed", stream: p.URL_FLUX_DONNEE,
        country: "CA", region: "Quebec", place: p.NomRegionDiffusion || "", dir: "",
        attr: "MTMD du Québec", status: "live", page: "https://www.quebec511.info/",
        lon, lat,
      };
    });
  }

  const LIVE_SOURCES = [
    { id: "511ny", fn: ny511, label: "511NY" },
    { id: "sg", fn: singapore, label: "Singapore LTA" },
    { id: "otc", fn: otcMaster, label: "OpenTrafficCamMap" },
    { id: "qc511", fn: quebec, label: "Quebec 511" },
  ];

  /** Background re-sync: pull the newest camera lists, merge anything new. */
  async function liveSync(onProgress) {
    const merged = [];
    for (const s of LIVE_SOURCES) {
      try {
        onProgress && onProgress(`syncing ${s.label}…`);
        const cams = await s.fn();
        merged.push(...cams);
        onProgress && onProgress(`${s.label}: ${cams.length} feeds`);
      } catch (e) {
        onProgress && onProgress(`${s.label}: unreachable`);
      }
    }
    return merged;
  }

  return { liveSync, singaporeFrame, fetchJSON, LIVE_SOURCES };
})();
