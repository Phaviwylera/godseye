/* GOD'S EYE — registry rules: filtering, ordering, paging and shareable state.
 *
 * The camera registry holds ~30k rows, so the way it is narrowed and ordered is
 * a user-facing feature, not an implementation detail. Everything here is pure
 * (no DOM, no network) so the rules can be tested directly and a shared link can
 * be decoded before any data has loaded.
 */
const Registry = (() => {
  const SORTS = ["registry", "name", "country", "status"];
  const TYPES = ["all", "m3u8", "image", "embed"];
  const LIVE = ["all", "live", "down", "checking"];
  const PAGE = 300;

  const clean = (value, max = 120) =>
    String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const validSort = (value) => (SORTS.includes(value) ? value : "registry");
  const validType = (value) => (TYPES.includes(value) ? value : "all");
  const validLive = (value) => (LIVE.includes(value) ? value : "all");
  const validCountry = (value) => {
    const country = clean(value, 64);
    return country && country !== "all" ? country : "all";
  };

  /* Filters live in the query string so a narrowed registry can be linked,
   * bookmarked or reloaded. Parsed by hand: URLSearchParams is not available in
   * the bare VM used by the tests, and this keeps the rule portable. */
  function parse(search) {
    const raw = String(search || "").replace(/^\?/, "");
    const pairs = {};
    for (const part of raw.split("&")) {
      if (!part) continue;
      const at = part.indexOf("=");
      const key = at < 0 ? part : part.slice(0, at);
      const value = at < 0 ? "" : part.slice(at + 1);
      try {
        pairs[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
      } catch {
        /* a malformed escape is not worth failing the whole page for */
      }
    }
    return {
      q: clean(pairs.q),
      type: validType(pairs.type),
      country: validCountry(pairs.country),
      live: validLive(pairs.live),
      sort: validSort(pairs.sort),
    };
  }

  /* Only non-default values are written, so a plain visit keeps a clean URL. */
  function query(filters) {
    const f = filters || {};
    const parts = [];
    const add = (key, value) => parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    if (clean(f.q)) add("q", clean(f.q));
    if (f.type && f.type !== "all") add("type", validType(f.type));
    if (f.country && f.country !== "all") add("country", validCountry(f.country));
    if (f.live && f.live !== "all") add("live", validLive(f.live));
    if (f.sort && f.sort !== "registry") add("sort", validSort(f.sort));
    return parts.join("&");
  }

  function hasFilters(filters) {
    const f = filters || {};
    return Boolean(clean(f.q)) || Boolean(f.type && f.type !== "all") ||
      Boolean(f.country && f.country !== "all") || Boolean(f.live && f.live !== "all");
  }

  /* `ctx.statusOf` is the app's probe-aware status; without it the stored
   * `status` field is used, which is what the registry shipped with. */
  function matches(cam, filters, ctx) {
    if (!cam) return false;
    const f = filters || {};
    const type = validType(f.type);
    const country = validCountry(f.country);
    const live = validLive(f.live);

    if (type !== "all" && cam.stype !== type && !(type === "image" && cam.stype === "dynamic")) return false;
    if (country !== "all" && cam.country !== country) return false;
    if (ctx && ctx.favsOnly && ctx.favs && !ctx.favs.has(cam.id)) return false;

    if (live !== "all") {
      const status = ctx && ctx.statusOf ? ctx.statusOf(cam) : cam.status;
      if (live === "live" && status !== "live") return false;
      if (live === "down" && status !== "down") return false;
      if (live === "checking" && status !== "checking") return false;
    }

    const q = clean(f.q).toLowerCase();
    if (q) {
      const haystack = [cam.name, cam.place, cam.region, cam.country]
        .filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function statusRank(cam, statusOf) {
    const status = statusOf ? statusOf(cam) : cam && cam.status;
    if (status === "live") return 0;
    if (status === "checking") return 1;
    if (status === "down") return 3;
    return 2;
  }

  /* "registry" is the published order and is returned untouched: re-sorting the
   * default view would make the list jump between refreshes for no reason. */
  function sortCams(list, mode, statusOf) {
    const rows = (list || []).slice();
    const by = validSort(mode);
    if (by === "registry") return rows;
    const name = (cam) => String(cam.name || cam.id || "").toLowerCase();
    const country = (cam) => String(cam.country || "").toLowerCase();
    if (by === "name") {
      return rows.sort((a, b) => name(a).localeCompare(name(b)) || String(a.id).localeCompare(String(b.id)));
    }
    if (by === "country") {
      return rows.sort((a, b) => country(a).localeCompare(country(b)) ||
        name(a).localeCompare(name(b)) || String(a.id).localeCompare(String(b.id)));
    }
    return rows.sort((a, b) => statusRank(a, statusOf) - statusRank(b, statusOf) ||
      name(a).localeCompare(name(b)) || String(a.id).localeCompare(String(b.id)));
  }

  function page(list, shown) {
    const requested = Number(shown);
    const limit = Number.isFinite(requested) ? Math.max(0, requested) : PAGE;
    return (list || []).slice(0, limit);
  }

  return { SORTS, TYPES, LIVE, PAGE, validSort, parse, query, hasFilters,
    matches, statusRank, sortCams, page };
})();
