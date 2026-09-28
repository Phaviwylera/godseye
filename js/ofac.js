/* GOD'S EYE — OFAC SDN cross-check.
 *
 * data/ofac.json is a nightly-ish snapshot of the U.S. Treasury's public
 * Specially Designated Nationals list (tools/build_ofac.py). This module loads
 * it once and exposes pure matchers used by the AIR and SHIPS layers.
 *
 * Honesty rules: a match is a *flag for human verification*, never a verdict.
 * The UI always says which field matched (registration / IMO / name) and that
 * vessel name matches from public AIS can collide with ships of the same name.
 */
const Ofac = (() => {
  let cache = null; // Promise<null | doc> — null means "not built yet"

  function norm(s) {
    return String(s || "").replace(/[\s-]/g, "").toUpperCase();
  }

  /** Pure: does a registration (or, failing that, a callsign containing a
   *  registration-like token) hit the designated-aircraft index? */
  function matchAircraft(index, reg, callsign) {
    if (!index || !index.length) return null;
    const candidates = [];
    if (reg) candidates.push(norm(reg));
    if (callsign) {
      // Callsigns like "9V-OJC" or "N482UA" can carry the registration; try the
      // whole string and its last token, but never claim a match on a bare airline code.
      const cs = String(callsign).trim().toUpperCase();
      candidates.push(norm(cs));
      const last = cs.split(/\s+/).pop();
      if (last && last !== cs) candidates.push(norm(last));
    }
    for (const c of candidates) {
      if (!c || c.length < 3) continue;
      const hit = index.find(a => norm(a.reg) === c);
      if (hit) return { kind: "registration", ...hit };
    }
    return null;
  }

  /** Pure: IMO first (exact), then exact name (labelled as a name match). */
  function matchVessel(index, imo, name) {
    if (!index || !index.length) return null;
    if (imo) {
      const m = String(imo).replace(/\D/g, "");
      if (m) {
        const hit = index.find(v => v.imo && String(v.imo).replace(/\D/g, "") === m);
        if (hit) return { kind: "imo", ...hit };
      }
    }
    const n = norm(name);
    if (n && n.length >= 4) {
      const hit = index.find(v => norm(v.name) === n);
      if (hit) return { kind: "name", ...hit };
    }
    return null;
  }

  function flagText(match) {
    if (!match) return "";
    const by = match.kind === "imo" ? "IMO match" : match.kind === "name" ? "name match" : "registration match";
    const caution = match.kind === "name" ? " · verify IMO — ships share names" : "";
    return `OFAC DESIGNATION (${by})${caution}${match.reason ? " — " + match.reason : ""}`;
  }

  /** Load data/ofac.json once; resolves to the parsed doc or null (pending build). */
  function load() {
    if (!cache) {
      cache = fetch("data/ofac.json")
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return cache;
  }

  return { load, matchAircraft, matchVessel, flagText, norm };
})();
