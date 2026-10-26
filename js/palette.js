/* GOD'S EYE — command palette and keyboard help.
 *
 * The map now carries ~40 layer/tool controls, which is great once you know
 * where they are and poor when you do not. This module gives every control one
 * searchable surface (Ctrl/⌘ K or "/"), plus the keyboard sheet ("?").
 *
 * It is deliberately thin: commands are the existing buttons, invoked with
 * .click(), so the palette can never drift from the real handlers. Camera rows
 * only search the index already loaded in this tab — nothing extra is fetched,
 * stored or inferred.
 */
const Palette = (() => {
  const LIMIT = 40;
  const CAM_LIMIT = 6;
  const COORD_RE = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

  let hooks = null;
  let root = null, input = null, results = null, counter = null;
  let rows = [], index = 0, openedAt = 0, lastFocus = null;
  let helpRoot = null, helpClose = null;

  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  /* Lower is better; -1 means no match. Exact > prefix > substring > ordered
   * subsequence, with a small penalty for long labels and late hits. */
  function score(text, query) {
    const t = clean(text).toLowerCase();
    const q = clean(query).toLowerCase();
    if (!q) return 1;
    if (!t) return -1;
    if (t === q) return 1000;
    if (t.startsWith(q)) return 800 - t.length * 0.1;
    const at = t.indexOf(q);
    if (at >= 0) return 600 - at * 2 - t.length * 0.05;
    let pos = -1, gaps = 0;
    for (const ch of q.replace(/\s+/g, "")) {
      const next = t.indexOf(ch, pos + 1);
      if (next < 0) return -1;
      gaps += next - pos - 1;
      pos = next;
    }
    /* A loose subsequence matches almost any long description. Keep the
     * abbreviation case ("wlrs" -> world layers) but reject text where the
     * letters are scattered across half a sentence. */
    if (gaps > Math.max(6, q.replace(/\s+/g, "").length * 2)) return -1;
    return Math.max(1, 300 - gaps - t.length * 0.1);
  }

  /** "13.08, 80.27" means lat, lon (same order as the registry search). */
  function coordTarget(query) {
    const match = COORD_RE.exec(String(query ?? ""));
    if (!match) return null;
    const lat = Number(match[1]), lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 85.051129 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function rank(items, query, limit = LIMIT) {
    const scored = [];
    for (const item of items || []) {
      const direct = score(item.label, query);
      const keyword = item.keywords ? score(item.keywords, query) : -1;
      const best = Math.max(direct, keyword >= 0 ? keyword - 120 : -1);
      if (best > 0) scored.push({ item, score: best });
    }
    scored.sort((a, b) => b.score - a.score ||
      (b.item.priority || 0) - (a.item.priority || 0) ||
      a.item.label.localeCompare(b.item.label));
    return scored.slice(0, limit).map((entry) => entry.item);
  }

  /* ------------------------------------------------------------------ rows -- */

  function groupOf(node) {
    const section = node.closest(".tools-group");
    if (!section) return "";
    const head = section.querySelector("h4 span, summary");
    return clean(head && head.textContent);
  }

  function buttonRows() {
    const nodes = document.querySelectorAll(
      "#map-tools-panel button, .hud-actions button, #panel-toggle, #compass");
    const out = [];
    for (const node of nodes) {
      if (!node.id || node.id === "btn-palette" || node.id === "map-tools-close") continue;
      const label = clean(node.textContent) || clean(node.title);
      if (!label || !/[A-Za-z0-9]/.test(label)) continue;
      const state = node.getAttribute("aria-pressed") === "true" || node.classList.contains("active");
      const group = groupOf(node);
      const isLayer = node.hasAttribute("data-layer");
      out.push({
        id: "btn:" + node.id,
        kind: isLayer ? "layer" : "tool",
        label,
        keywords: [node.title, node.id.replace(/^btn-/, "").replace(/-/g, " ")].filter(Boolean).join(" "),
        hint: [group, state ? "ON" : ""].filter(Boolean).join(" · "),
        priority: isLayer ? (state ? 8 : 2) : 0,
        run: () => node.click(),
      });
    }
    return out;
  }

  function staticRows() {
    const out = [
      {
        id: "static:shortcuts", kind: "help", label: "Keyboard shortcuts",
        keywords: "keys help cheatsheet", hint: "HELP", priority: 6,
        run: () => openHelp(),
      },
      {
        id: "static:random", kind: "feed", label: "Random public feed",
        keywords: "camera random surprise", hint: "FEED", priority: 5,
        run: () => {
          const cams = hooks && hooks.getCameras ? hooks.getCameras() : [];
          if (!cams.length) return message("No feeds indexed yet.");
          const live = cams.filter((cam) => cam && cam.id && (cam.status === "live" || cam.live === 1));
          const pool = live.length ? live : cams;
          const pick = pool[Math.floor(Math.random() * pool.length)];
          if (pick && hooks.openCamera) hooks.openCamera(pick.id, true);
        },
      },
      {
        id: "static:share", kind: "map", label: "Copy link to this view",
        keywords: "share scene url link", hint: "MAP", priority: 4,
        run: () => { if (hooks && hooks.shareScene) hooks.shareScene(); },
      },
      {
        id: "static:clear", kind: "filter", label: "Clear camera filters",
        keywords: "reset search filter country type status", hint: "REGISTRY", priority: 1,
        run: () => {
          const set = (sel, value) => {
            const node = document.querySelector(sel);
            if (!node) return;
            node.value = value;
            node.dispatchEvent(new Event("change", { bubbles: true }));
          };
          set("#f-type", "all");
          set("#f-country", "all");
          set("#f-live", "all");
          const q = document.querySelector("#q");
          if (q) { q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true })); }
        },
      },
      {
        id: "static:density", kind: "view", label: "Toggle compact layout",
        keywords: "density spacing compact ui", hint: hooks && hooks.densityState ? hooks.densityState() : "",
        priority: 3,
        run: () => { if (hooks && hooks.toggleDensity) hooks.toggleDensity(); },
      },
      {
        id: "static:motion", kind: "view", label: "Toggle reduced motion",
        keywords: "animation motion accessibility", hint: hooks && hooks.motionState ? hooks.motionState() : "",
        priority: 3,
        run: () => { if (hooks && hooks.toggleMotion) hooks.toggleMotion(); },
      },
    ];
    return out;
  }

  function savedRows() {
    let saved = [];
    try {
      if (typeof SavedViews !== "undefined" && SavedViews.read) saved = SavedViews.read(localStorage);
    } catch { saved = []; }
    return saved.map((view, i) => ({
      id: "saved:" + i, kind: "saved", label: view.name,
      keywords: "saved position map", hint: "SAVED POSITION",
      run: () => {
        const map = hooks && hooks.getMap ? hooks.getMap() : null;
        if (!map) return;
        map.easeTo({ center: view.center, zoom: view.zoom, pitch: view.pitch,
          bearing: view.bearing, duration: 900 });
      },
    }));
  }

  let camCache = null, camCacheLen = -1, camCacheAt = 0;

  /* Cameras use substring matching only: a global registry has tens of
   * thousands of long names, and subsequence matching would return noise
   * ("compact" hitting a Colorado highway) instead of the thing asked for. */
  function cameraRows(query) {
    const q = clean(query).toLowerCase();
    if (q.length < 2 || !hooks || !hooks.getCameras) return [];
    const cams = hooks.getCameras() || [];
    if (!camCache || camCacheLen !== cams.length || Date.now() - camCacheAt > 60000) {
      camCache = cams.map((cam) => {
        const label = clean(cam.name) || clean(cam.id);
        const keywords = [cam.place, cam.region, cam.country, cam.src].filter(Boolean).join(" ");
        return { cam, label, keywords, text: (label + " " + keywords).toLowerCase() };
      });
      camCacheLen = cams.length;
      camCacheAt = Date.now();
    }
    const hits = [];
    for (const entry of camCache) {
      const at = entry.text.indexOf(q);
      if (at >= 0) hits.push({ entry, at });
    }
    hits.sort((a, b) => a.at - b.at || a.entry.label.localeCompare(b.entry.label));
    return hits.slice(0, CAM_LIMIT).map(({ entry }) => ({
      id: "cam:" + entry.cam.id,
      kind: "feed",
      label: entry.label,
      keywords: entry.keywords,
      hint: ["FEED", entry.cam.place || entry.cam.country].filter(Boolean).join(" · "),
      run: () => { if (hooks.openCamera) hooks.openCamera(entry.cam.id, true); },
    }));
  }

  function coordinateRows(query) {
    const point = coordTarget(query);
    if (!point) return [];
    return [{
      id: "coord:target", kind: "coord",
      label: `Fly to ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`,
      hint: "LAT, LON",
      run: () => {
        const map = hooks && hooks.getMap ? hooks.getMap() : null;
        if (map) map.flyTo({ center: [point.lon, point.lat], zoom: 9, duration: 1400 });
      },
    }];
  }

  /* ---------------------------------------------------------------- render -- */

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function message(text) {
    const node = document.getElementById("sync-msg");
    if (!node) return;
    node.textContent = text;
    setTimeout(() => { if (node.textContent === text) node.textContent = ""; }, 3000);
  }

  function select(next) {
    if (!rows.length) return;
    index = Math.max(0, Math.min(rows.length - 1, next));
    [...results.children].forEach((child, i) => {
      const on = i === index;
      child.classList.toggle("selected", on);
      child.setAttribute("aria-selected", String(on));
      if (on) {
        input.setAttribute("aria-activedescendant", child.id);
        if (child.scrollIntoView) child.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function render() {
    if (!results) return;
    results.replaceChildren();
    rows.forEach((row, i) => {
      const node = document.createElement("div");
      node.className = "palette-row";
      node.id = "palette-row-" + i;
      node.dataset.index = String(i);
      node.setAttribute("role", "option");
      node.setAttribute("aria-selected", "false");
      node.innerHTML = `<span class="palette-kind">${escapeHTML(row.kind)}</span>` +
        `<span class="palette-label">${escapeHTML(row.label)}</span>` +
        `<span class="palette-hint">${escapeHTML(row.hint || "")}</span>`;
      node.addEventListener("mousemove", () => { if (index !== i) select(i); });
      node.addEventListener("click", () => run(row));
      results.appendChild(node);
    });
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = "No matching command, feed or place.";
      results.appendChild(empty);
    }
    if (counter) counter.textContent = rows.length ? `${rows.length} MATCH${rows.length === 1 ? "" : "ES"}` : "";
    select(0);
  }

  function refresh() {
    const query = input ? input.value : "";
    const base = buttonRows().concat(staticRows());
    let found = coordinateRows(query).concat(rank(base, query, LIMIT));
    found = found.concat(rank(savedRows(), query, 6));
    const cams = cameraRows(query);
    const seen = new Set();
    rows = found.concat(cams).filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    }).slice(0, LIMIT);
    render();
  }

  function run(row) {
    if (!row) return;
    close();
    try { row.run(); } catch (error) { console.warn("palette command failed", error); }
  }

  /* ------------------------------------------------------------------ open -- */

  function isTyping(target) {
    return !!(target && target.closest &&
      target.closest("input, select, textarea, [contenteditable='true']"));
  }

  function open() {
    if (!root) return;
    lastFocus = document.activeElement;
    root.classList.remove("hidden");
    openedAt = Date.now();
    if (input) { input.value = ""; input.focus(); }
    refresh();
  }

  function close() {
    if (!root) return;
    root.classList.add("hidden");
    rows = [];
    index = 0;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  function toggle() {
    if (!root) return;
    if (root.classList.contains("hidden")) open(); else close();
  }

  function isOpen() {
    return !!(root && !root.classList.contains("hidden"));
  }

  /* ------------------------------------------------------------------ help -- */

  function openHelp() {
    if (!helpRoot) return;
    lastFocus = document.activeElement;
    helpRoot.classList.remove("hidden");
    if (helpClose) helpClose.focus();
  }

  function closeHelp() {
    if (!helpRoot) return;
    helpRoot.classList.add("hidden");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ------------------------------------------------------------------ init -- */

  function init(options) {
    hooks = options || {};
    root = document.getElementById("palette");
    input = document.getElementById("palette-input");
    results = document.getElementById("palette-results");
    counter = document.getElementById("palette-count");
    helpRoot = document.getElementById("shortcuts");
    helpClose = document.getElementById("shortcuts-close");
    if (!root || !input || !results) return;

    input.addEventListener("input", refresh);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); select(index + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); select(index - 1); }
      else if (e.key === "Home") { e.preventDefault(); select(0); }
      else if (e.key === "End") { e.preventDefault(); select(rows.length - 1); }
      else if (e.key === "Enter") { e.preventDefault(); run(rows[index]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    root.addEventListener("pointerdown", (e) => { if (e.target === root) close(); });
    if (helpRoot) {
      helpRoot.addEventListener("pointerdown", (e) => { if (e.target === helpRoot) closeHelp(); });
      if (helpClose) helpClose.onclick = closeHelp;
    }

    const paletteButton = document.getElementById("btn-palette");
    if (paletteButton) paletteButton.onclick = () => toggle();

    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === "/") { e.preventDefault(); open(); return; }
      if (e.key === "?") { e.preventDefault(); openHelp(); return; }
      if (e.key === "Escape") {
        if (isOpen()) close();
        else if (helpRoot && !helpRoot.classList.contains("hidden")) closeHelp();
      }
    });
  }

  return { score, coordTarget, rank, init, open, close, toggle, isOpen,
    openHelp, closeHelp, refresh, _rows: () => rows, _openedAt: () => openedAt };
})();
