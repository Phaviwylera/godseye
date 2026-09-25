/* GOD'S EYE — feed players (multi-instance: modal + video wall run in parallel).
 * Types: m3u8 (HLS) | image (polling jpg) | dynamic (rotating snapshot URL) | embed (agency portal)
 * Each mount() is independent: {stop, capture, frames, seekFrame, resume}
 * Frames of snapshot feeds are kept as data-URLs → 60s rewind + canvas capture
 * works even where streams are cross-origin.
 */
const Players = (() => {

  const proxied = (u) => window.GE_NO_PROXY ? u : "/api/proxy?url=" + encodeURIComponent(u);
  const FRAME_MAX = 12;

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

  function portalCard(container, cam) {
    // Agencies like Québec 511 serve video only through their own viewer
    // (X-Frame-Options + Cloudflare) — launch card, never a broken iframe.
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;height:100%;padding:24px;text-align:center";
    wrap.innerHTML = `
      <svg viewBox="0 0 120 60" style="width:72px;opacity:.8">
        <path d="M4 30 Q60 -18 116 30 Q60 78 4 30 Z" fill="none" stroke="#00f0ff" stroke-width="3"/>
        <circle cx="60" cy="30" r="12" fill="none" stroke="#00f0ff" stroke-width="3"/>
        <circle cx="60" cy="30" r="5" fill="#00f0ff"/>
      </svg>
      <div style="letter-spacing:.28em;color:#00f0ff;font-size:13px">AGENCY PORTAL FEED</div>
      <div style="font-size:11px;max-width:460px;line-height:1.7;color:#51707c">
        ${cam.name || ""}<br>
        This agency publishes its live view only through its own secure portal and
        blocks outside embedding. One click through — the feed is live there.
      </div>
      <a href="${cam.stream || cam.page || "#"}" target="_blank" rel="noopener"
         style="font-family:inherit;font-size:13px;letter-spacing:.2em;color:#04101a;background:#00f0ff;
                padding:12px 26px;text-decoration:none;box-shadow:0 0 24px rgba(0,240,255,.45)">
        ▶ OPEN LIVE FEED ↗
      </a>`;
    container.appendChild(wrap);
  }

  /** Mount one camera feed into a container. Returns a handle. */
  function mount(cam, container, opts = {}) {
    const st = {
      cam, container, hls: null, timer: null, video: null, img: null,
      frames: [], paused: false, frameW: opts.frameW || 1024,
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
      } catch (e) { /* tainted canvas in static mode — capture disabled */ }
    };

    const showFrame = (i) => {
      if (!st.img || !st.frames[i]) return;
      st.paused = true;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      st.img.src = st.frames[i].url;
    };
    const resume = () => {
      st.paused = false;
      if (cam.stype === "image" || cam.stype === "dynamic") startPolling();
    };

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
      st.timer = setInterval(loadImageOnce, cam.stype === "dynamic" ? 10000 : 6000);
    }

    function playImage() {
      const img = document.createElement("img");
      img.alt = cam.name;
      st.img = img;
      img.onload = () => pushFrame(img);
      img.onerror = () => {
        if (n > 4 && !st.frames.length) {
          stop();
          msg(container, `NO SIGNAL<br><span style="font-size:10px">feed unreachable — <a href="${cam.page || cam.stream || "#"}" target="_blank" rel="noopener">open official page</a></span>`);
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
      const fail = (why) => {
        stop();
        msg(container, `SIGNAL LOST<br><span style="font-size:10px">${why} — <a href="${cam.page || cam.stream || "#"}" target="_blank" rel="noopener">open official page</a></span>`);
      };
      if (window.Hls && Hls.isSupported()) {
        st.hls = new Hls({
          lowLatencyMode: true, maxBufferLength: 12,
          manifestLoadingTimeOut: 15000, manifestLoadingMaxRetry: 3,
          levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000,
        });
        st.hls.loadSource(src);
        st.hls.attachMedia(video);
        st.hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            try { st.hls.startLoad(); st.hls.recoverMediaError(); } catch (e) { fail("stream error"); }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.details === "manifestLoadError") fail("manifest unreachable");
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        video.onerror = () => fail("native player error");
      } else {
        fail("HLS not supported in this browser");
        return;
      }
      video.play().catch(() => {});
    }

    // ------------------------------------------------------------- misc ----
    function stop() {
      if (st.hls) { try { st.hls.destroy(); } catch (e) {} st.hls = null; }
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
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

    switch (cam.stype) {
      case "m3u8": playM3u8(); break;
      case "image": case "dynamic": playImage(); break;
      case "embed": portalCard(container, cam); break;
      default: msg(container, "unsupported feed type");
    }

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

  return { mount, play, stop, startClock, proxied };
})();
