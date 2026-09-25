/* GOD'S EYE — feed players. One entry point: Players.play(cam, container).
 * Camera stream types:
 *   m3u8    HLS video            -> hls.js (native on Safari)
 *   image   refreshing JPEG      -> <img> + cache-bust polling
 *   dynamic rotating snapshot URL -> <img> + API re-resolve polling
 *   embed   agency player page   -> <iframe>
 * All media goes through /api/proxy (mixed-content + CORS safe).
 */
const Players = (() => {
  let hls = null;
  let timer = null;
  let clockTimer = null;

  const proxied = (u) => window.GE_NO_PROXY ? u : "/api/proxy?url=" + encodeURIComponent(u);

  function stop() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (timer) { clearInterval(timer); timer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  function msg(container, html) {
    container.innerHTML = `<div class="player-msg">${html}</div>`;
  }

  function startClock(el) {
    const tick = () => {
      const d = new Date();
      el.textContent = d.toISOString().slice(11, 19) + " UTC";
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  function playImage(container, cam) {
    const img = document.createElement("img");
    img.alt = cam.name;
    let n = 0;
    const load = () => { img.src = proxied(cam.stream) + "&_r=" + (++n); };
    img.onerror = () => {
      if (n > 4) { stop(); msg(container, `NO SIGNAL<br><span style="font-size:10px">feed unreachable — <a href="${cam.page || "#"}" target="_blank" rel="noopener">open official page</a></span>`); }
    };
    load();
    container.appendChild(img);
    timer = setInterval(load, cam.stype === "dynamic" ? 8000 : 6000);
  }

  async function playDynamic(container, cam) {
    const img = document.createElement("img");
    img.alt = cam.name;
    container.appendChild(img);
    const load = async () => {
      try {
        let url = null;
        if (cam.src === "sg") url = await Sources.singaporeFrame(cam.id);
        if (url) img.src = proxied(url) + "&_r=" + Date.now();
        else if (!img.src) img.src = proxied(cam.stream);
      } catch (e) { /* keep last frame */ }
    };
    load();
    timer = setInterval(load, 10000);
  }

  function playM3u8(container, cam) {
    const video = document.createElement("video");
    video.autoplay = true; video.controls = true; video.muted = true; video.playsInline = true;
    container.appendChild(video);
    const src = proxied(cam.stream);
    const fail = (why) => {
      stop();
      msg(container, `SIGNAL LOST<br><span style="font-size:10px">${why} — <a href="${cam.page || "#"}" target="_blank" rel="noopener">open official page</a></span>`);
    };
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true, maxBufferLength: 12, manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 3, levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          try { hls.startLoad(); hls.recoverMediaError(); } catch (e) { fail("stream error"); }
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

  function playEmbed(container, cam) {
    // Agencies like Québec 511 serve their live view only through their own
    // viewer page (X-Frame-Options: SAMEORIGIN + Cloudflare) — embedding is
    // blocked by design. Present a launch card instead of a broken iframe.
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

  function play(cam, container) {
    stop();
    container.innerHTML = "";
    switch (cam.stype) {
      case "m3u8": playM3u8(container, cam); break;
      case "image": playImage(container, cam); break;
      case "dynamic": playDynamic(container, cam); break;
      case "embed": playEmbed(container, cam); break;
      default: msg(container, "unsupported feed type");
    }
  }

  return { play, stop, startClock, proxied };
})();
