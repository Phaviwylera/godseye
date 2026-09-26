/* GOD'S EYE — feed players (multi-instance: modal + video wall run in parallel).
 * Types: m3u8 | mp4 | youtube | image | dynamic | mjpeg | embed
 * Resilience: silent reconnect attempts, background auto-heal, and a
 * nearest-alternative failover so one dead camera never dead-ends the user.
 */
const Players = (() => {

  const proxied = (u) => window.GE_NO_PROXY ? u : "/api/proxy?url=" + encodeURIComponent(u);
  const FRAME_MAX = 12;
  const HEAL_MS = 45000;
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  function safeLink(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? escapeHTML(url.href) : "#";
    } catch { return "#"; }
  }

  /** Lightweight feed liveness probe (accurate status). Returns boolean. */
  async function probe(url, stype) {
    if (!url) return false;
    const target = proxied(url);
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, 7000);
    try {
      const r = await fetch(target, {
        method: "GET",
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined,
        headers: stype === "m3u8" ? { Accept: "application/vnd.apple.mpegurl,*/*" } : { Accept: "*/*" },
      });
      if (!r.ok) return false;
      if (stype === "m3u8") {
        const text = await r.text();
        return text.trimStart().startsWith("#EXTM3U");
      }
      // image / mp4 / mjpeg — any non-empty body or 2xx is enough
      const buf = await r.arrayBuffer();
      return buf.byteLength > 32;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  // ------------------------------------------------------------ YouTube ---
  let ytApiPromise = null;
  function loadYT() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(window.YT); };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = reject;
      document.head.appendChild(s);
      setTimeout(() => (window.YT && window.YT.Player ? resolve(window.YT) : reject(new Error("yt timeout"))), 6000);
    });
    return ytApiPromise;
  }

  function extractYt(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.includes("youtu")) return null;
      const ok = (s) => /^[A-Za-z0-9_-]{6,}$/.test(s || "");
      const v = u.searchParams.get("v");
      if (ok(v)) return { videoId: v };
      const parts = u.pathname.split("/").filter(Boolean);
      for (const key of ["embed", "shorts", "live", "v"]) {
        const i = parts.indexOf(key);
        if (i >= 0 && ok(parts[i + 1])) return { videoId: parts[i + 1] };
      }
      if (u.hostname.includes("youtu.be") && ok(parts[0])) return { videoId: parts[0] };
      const ch = u.searchParams.get("channel");
      if (ch) return { channelId: ch };
      const iC = parts.indexOf("channel");
      if (iC >= 0 && parts[iC + 1]) return { channelId: parts[iC + 1] };
      if (parts[0] === "live_stream" && u.searchParams.get("channel")) {
        return { channelId: u.searchParams.get("channel") };
      }
    } catch (e) {}
    return null;
  }

  const YT_ERRORS = {
    2: "YouTube says the video id is invalid.",
    5: "YouTube HTML5 player error on this stream.",
    100: "The stream was removed or is private.",
    101: "The owner disallowed this video in embedded players.",
    150: "The owner disallowed this video in embedded players.",
    153: "YouTube blocked outside playback for this cam (error 153) — it only plays on YouTube itself.",
  };

  // -------------------------------------------------------- failover util --
  function nearestAlternative(cam) {
    const cams = Object.values(window.GE_CAMS || {});
    const PLAYABLE = { m3u8: 4, mp4: 3, youtube: 3, mjpeg: 2, image: 2, dynamic: 2 };
    let best = null, bestScore = 3.0;
    for (const c of cams) {
      if (c.id === cam.id || !PLAYABLE[c.stype]) continue;
      const dx = (c.lon - cam.lon) * 111.32 * Math.cos((cam.lat * Math.PI) / 180);
      const dy = (c.lat - cam.lat) * 111.32;
      const d = Math.hypot(dx, dy);
      const score = d + (PLAYABLE[c.stype] >= 4 ? 0 : 0.4); // prefer live video
      if (d < 3 && score < bestScore) { bestScore = score; best = { cam: c, km: d }; }
    }
    return best;
  }

  // ---------------------------------------------------------------- misc --
  function stopClock() {
    if (stopClock.t) { clearInterval(stopClock.t); stopClock.t = null; }
  }
  function startClock(el) {
    stopClock();
    const tick = () => { el.textContent = new Date().toISOString().slice(11, 19) + " UTC"; };
    tick();
    stopClock.t = setInterval(tick, 1000);
  }

  function msg(container, html) {
    container.innerHTML = `<div class="player-msg">${html}</div>`;
  }

  function portalCard(container, cam, kind) {
    const isYt = kind === "youtube";
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;height:100%;padding:24px;text-align:center";
    wrap.innerHTML = `
      <img src="assets/gods-eye-emblem.svg" alt="" style="width:104px;opacity:.88;filter:drop-shadow(0 0 12px rgba(42,223,255,.12))">
      <div style="letter-spacing:.28em;color:#8be9fa;font-size:13px">${isYt ? "YOUTUBE FEED" : "AGENCY PORTAL FEED"}</div>
      <div style="font-size:11px;max-width:460px;line-height:1.7;color:#51707c">
        ${escapeHTML(cam.name || "")}<br>
        ${isYt ? "This live cam plays on YouTube — the owner may restrict outside players. Open it directly and it will play."
               : "This agency publishes its live view only through its own secure portal and blocks outside embedding. One click through — the feed is live there."}
      </div>
      <a href="${safeLink(cam.stream || cam.page)}" target="_blank" rel="noopener noreferrer"
         style="font-family:inherit;font-size:13px;letter-spacing:.2em;color:#031018;background:#8be9fa;
                padding:12px 26px;text-decoration:none;box-shadow:0 0 24px rgba(139,233,250,.18)">
        ▶ ${isYt ? "OPEN ON YOUTUBE" : "OPEN LIVE FEED"} ↗
      </a>`;
    container.appendChild(wrap);
  }

  /** Mount one camera feed into a container. Returns a handle. */
  function mount(cam, container, opts = {}) {
    const st = {
      cam, container, hls: null, timer: null, healTimer: null, yt: null,
      video: null, img: null, frames: [], paused: false, attempts: 0,
      frameW: opts.frameW || 1024,
    };
    container.innerHTML = "";

    const pushFrame = (src) => {
      if (!opts.captureFrames) return;
      try {
        const c = document.createElement("canvas");
        const iw = src.naturalWidth || src.videoWidth, ih = src.naturalHeight || src.videoHeight;
        if (!iw || !ih) return;
        const scale = Math.min(1, st.frameW / iw);
        c.width = Math.round(iw * scale); c.height = Math.round(ih * scale);
        c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
        st.frames.push({ t: Date.now(), url: c.toDataURL("image/jpeg", 0.72) });
        if (st.frames.length > FRAME_MAX) st.frames.shift();
        opts.onFrame && opts.onFrame(st.frames.length);
      } catch (e) { /* tainted canvas in static mode */ }
    };

    const showFrame = (i) => {
      if (!st.img || !st.frames[i]) return;
      st.paused = true;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      st.img.src = st.frames[i].url;
    };
    const resume = () => {
      st.paused = false;
      if (cam.stype === "image" || cam.stype === "dynamic" || cam.stype === "mjpeg") startPolling();
    };

    // ---------------------------------------------------- fail + recovery --
    function failPanel(why) {
      clearInterval(st.timer); st.timer = null;
      if (st.hls) { try { st.hls.destroy(); } catch (e) {} st.hls = null; }
      opts.onStatus && opts.onStatus(false);
      const hint = cam.live === 0 ? "Last probe marked this camera DOWN."
        : cam.live === 1 ? "It was verified live recently — this may be temporary."
        : "Public DOT cams go offline sometimes (maintenance, network, weather).";
      const alt = nearestAlternative(cam);
      const isYt = cam.stype === "youtube";
      container.innerHTML = `
        <div class="player-msg" style="max-width:520px;line-height:1.8">
          <div style="color:#ff667d;letter-spacing:.25em;font-size:14px">SIGNAL LOST</div>
          <div style="font-size:11px;margin-top:8px">${escapeHTML(why)}</div>
          <div style="font-size:10px;color:#51707c;margin-top:6px">${hint}</div>
          <div style="font-size:9px;color:#3d5c66;margin-top:4px">background auto-heal: probing every 45s…</div>
          <div style="margin-top:14px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
            <button class="retry-btn">↻ RETRY</button>
            ${alt ? `<button class="retry-btn alt-btn">↪ ${escapeHTML(alt.cam.name.slice(0, 26))} · ${alt.km.toFixed(1)}km</button>` : ""}
            <a href="${safeLink(cam.stream || cam.page)}" target="_blank" rel="noopener noreferrer"
               style="font-size:10px;letter-spacing:.15em;color:#8be9fa;border:1px solid rgba(139,233,250,.22);padding:6px 12px;text-decoration:none">
              ${isYt ? "OPEN ON YOUTUBE ↗" : "OFFICIAL PAGE ↗"}</a>
          </div>
        </div>`;
      container.querySelector(".retry-btn").onclick = () => {
        st.attempts = 0;
        if (opts.onRetry) opts.onRetry();
        else retryInPlace();
      };
      const altBtn = container.querySelector(".alt-btn");
      if (altBtn && alt) {
        altBtn.onclick = () =>
          window.dispatchEvent(new CustomEvent("ge-open-cam", { detail: alt.cam.id }));
      }
      armHeal(retryInPlace);
    }

    function retryInPlace() {
      clearInterval(st.healTimer);
      container.innerHTML = "";
      if (st.hls) { try { st.hls.destroy(); } catch (e) {} st.hls = null; }
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      st.attempts = 0;
      run();
    }

    function armHeal(onHealed) {
      clearInterval(st.healTimer);
      st.healTimer = setInterval(async () => {
        try {
          const url = proxied(cam.stream) + (cam.stream.includes("?") ? "&" : "?") + "_heal=" + Date.now();
          const r = await fetch(url, { cache: "no-store" });
          if (r.ok) {
            clearInterval(st.healTimer);
            msg(container, '<span style="color:#41efc2">⚡ SIGNAL RESTORED — reconnecting…</span>');
            setTimeout(onHealed, 700);
          }
        } catch (e) { /* keep probing */ }
      }, HEAL_MS);
    }

    // ------------------------------------------------------------ image ----
    let n = 0;
    const loadImageOnce = async () => {
      if (st.paused) return;
      try {
        let url = proxied(cam.stream) + (cam.stream.includes("?") ? "&" : "?") + "_r=" + (++n);
        if (cam.stype === "dynamic" && cam.src === "sg") {
          const fresh = await Sources.singaporeFrame(cam.id);
          if (fresh) url = proxied(fresh) + "&_r=" + (++n);
        }
        st.img.src = url;
      } catch (e) { /* keep last frame */ }
    };

    function startPolling() {
      if (st.timer) clearInterval(st.timer);
      st.timer = setInterval(loadImageOnce, cam.stype === "dynamic" ? 10000 : cam.stype === "mjpeg" ? 1500 : 6000);
    }

    function playImage() {
      const img = document.createElement("img");
      img.alt = cam.name;
      st.img = img;
      img.onload = () => {
        pushFrame(img);
        if (!st._signaledOk) { st._signaledOk = true; opts.onStatus && opts.onStatus(true); }
      };
      img.onerror = () => {
        if (n > 4 && !st.frames.length) {
          failPanel("The agency's snapshot feed is unreachable right now.");
        }
      };
      container.appendChild(img);
      loadImageOnce();
      startPolling();
    }

    // ------------------------------------------------------------- m3u8 ----
    function playM3u8() {
      const video = document.createElement("video");
      video.autoplay = true; video.controls = !opts.minimal; video.muted = true; video.playsInline = true;
      st.video = video;
      container.appendChild(video);
      const src = proxied(cam.stream);

      const fail = (why, honest404) => {
        if (st.hls) { try { st.hls.destroy(); } catch (e) {} st.hls = null; }
        // silent reconnect x2 before showing the panel — many feeds flap
        if (!honest404 && st.attempts < 2) {
          st.attempts++;
          msg(container, `RECONNECTING… <span style="color:#51707c">attempt ${st.attempts + 1}/3</span>`);
          st.timer = setTimeout(() => { container.innerHTML = ""; playM3u8(); }, 1800 * st.attempts);
          return;
        }
        if (st.attempts < 2 && honest404) {
          // even "offline at source" gets one quiet later retry via heal; show panel now
        }
        failPanel(why);
      };

      if (window.Hls && Hls.isSupported()) {
        st.hls = new Hls({
          lowLatencyMode: true, maxBufferLength: 12,
          manifestLoadingTimeOut: 25000, manifestLoadingMaxRetry: 4, manifestLoadingMaxRetryTimeout: 12000,
          levelLoadingTimeOut: 25000, fragLoadingTimeOut: 30000,
        });
        st.hls.loadSource(src);
        st.hls.attachMedia(video);
        st.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          opts.onStatus && opts.onStatus(true);
        });
        st.hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          const isManifest = data.details === "manifestLoadError" || data.details === "manifestParsingError";
          if (isManifest) {
            const up = (data.response && data.response.code) || 0;
            fail(up === 404 || up === 410
              ? "The agency's stream is offline or removed right now."
              : "Stream manifest unreachable at the agency's server.", up === 404 || up === 410);
            return;
          }
          try { st.hls.startLoad(); st.hls.recoverMediaError(); } catch (e) { fail("stream error", false); }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.addEventListener("loadedmetadata", () => opts.onStatus && opts.onStatus(true), { once: true });
        video.onerror = () => fail("native player error", false);
      } else {
        fail("HLS not supported in this browser", true);
        return;
      }
      video.play().catch(() => {});
    }

    // ------------------------------------------------------------- mp4 ----
    function playVideo() {
      const v = document.createElement("video");
      v.src = proxied(cam.stream); v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
      v.controls = !opts.minimal;
      st.video = v;
      v.onerror = () => failPanel("The agency's video file is unreachable right now.");
      container.appendChild(v);
      v.play().catch(() => {});
    }

    // ---------------------------------------------------------- youtube ----
    async function playYouTube() {
      const parsed = extractYt(cam.stream);
      if (!parsed) return portalCard(container, cam, "youtube");

      if (parsed.channelId) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;width:100%;height:100%";
        const f = document.createElement("iframe");
        f.src = `https://www.youtube.com/embed/live_stream?channel=${parsed.channelId}&autoplay=1&mute=1&playsinline=1`;
        f.allow = "autoplay; encrypted-media; picture-in-picture";
        f.allowFullscreen = true;
        wrap.appendChild(f);
        const note = document.createElement("div");
        note.className = "player-msg";
        note.style.cssText = "position:absolute;bottom:4px;left:0;right:0;font-size:9px;pointer-events:none";
        note.textContent = "channel live — if blank: open on YouTube below";
        wrap.appendChild(note);
        container.appendChild(wrap);
        return;
      }

      const holder = document.createElement("div");
      holder.style.cssText = "width:100%;height:100%";
      container.appendChild(holder);
      const ytFail = (code) => {
        if (st.yt) { try { st.yt.destroy(); } catch (e) {} st.yt = null; }
        failPanel(YT_ERRORS[code] || `YouTube playback error (${code}).`);
      };
      try {
        const YT = await loadYT();
        st.yt = new YT.Player(holder, {
          videoId: parsed.videoId,
          playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: (e) => { try { e.target.playVideo(); } catch (e2) {} },
            onError: (e) => ytFail(e.data),
          },
        });
      } catch (e) {
        // API blocked — fall back to a plain embed with the styled portal behind it
        container.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;width:100%;height:100%";
        const f = document.createElement("iframe");
        f.src = `https://www.youtube.com/embed/${parsed.videoId}?autoplay=1&mute=1&playsinline=1&rel=0`;
        f.allow = "autoplay; encrypted-media; picture-in-picture";
        f.allowFullscreen = true;
        wrap.appendChild(f);
        container.appendChild(wrap);
      }
    }

    // ------------------------------------------------------------- misc ----
    function stop() {
      if (st.hls) { try { st.hls.destroy(); } catch (e) {} st.hls = null; }
      if (st.yt) { try { st.yt.destroy(); } catch (e) {} st.yt = null; }
      if (st.timer) { clearInterval(st.timer); clearTimeout(st.timer); st.timer = null; }
      clearInterval(st.healTimer);
    }

    function capture() {
      const src = st.video || st.img;
      if (!src || !(src.videoWidth || src.naturalWidth)) return null;
      try {
        const c = document.createElement("canvas");
        const iw = src.videoWidth || src.naturalWidth, ih = src.videoHeight || src.naturalHeight;
        c.width = iw; c.height = ih;
        c.getContext("2d").drawImage(src, 0, 0);
        return c.toDataURL("image/png");
      } catch (e) { return null; }
    }

    function run() {
      switch (cam.stype) {
        case "m3u8": playM3u8(); break;
        case "mp4": playVideo(); break;
        case "youtube": playYouTube(); break;
        case "image": case "dynamic": case "mjpeg": playImage(); break;
        case "embed": portalCard(container, cam); break;
        default: msg(container, "unsupported feed type");
      }
    }
    run();

    return { cam, stop, capture, showFrame, resume,
             get frames() { return st.frames; } };
  }

  // ---- modal convenience: one active feed ----
  let current = null;
  function play(cam, container, opts) {
    if (current) current.stop();
    current = mount(cam, container, opts);
    return current;
  }
  function stop() {
    if (current) current.stop();
    current = null;
    stopClock();
  }

  return { mount, play, stop, startClock, proxied, extractYt, probe };
})();
