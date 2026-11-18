// Draws the London Congestion Charge zone on top of Google Maps.
//
// Google Maps doesn't expose its map object to extensions, so we read the
// camera from the URL (".../@lat,lng,14z" or ".../@lat,lng,4562m" in
// satellite view) and project the zone ourselves with Web Mercator.
// The URL only updates once the map stops moving, so while you drag we shift
// the overlay with the mouse, and while you scroll-zoom we fade it out.

(() => {
  "use strict";
  if (window.__cczOverlayLoaded) return;
  window.__cczOverlayLoaded = true;

  const ZONE = globalThis.CCZ_BOUNDARY;
  if (!Array.isArray(ZONE) || ZONE.length < 3) return;

  const TILE = 256;
  const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137; // metres
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STORAGE_KEY = "cczVisible";

  // ---------- Projection ----------

  // Lat/lng -> normalised Web Mercator (0..1 across the whole world).
  function project(lat, lng) {
    const s = Math.sin((lat * Math.PI) / 180);
    return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }

  const zoneWorld = ZONE.map(([lat, lng]) => project(lat, lng));
  const zoneBox = zoneWorld.reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity]
  );

  // Reads the camera out of a Google Maps URL. Returns null for views we
  // can't draw on accurately (Street View, tilted 3D, no coordinates).
  function parseView(url, mapHeight) {
    const m = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)([zm])((?:,[\d.\-]+[a-z])*)/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const value = parseFloat(m[3]);
    const extras = m[5] || "";

    const tilt = extras.match(/,([\d.]+)t/);
    if (tilt && parseFloat(tilt[1]) > 0.5) return null;
    const heading = extras.match(/,(-?[\d.]+)h/);

    let zoom;
    if (m[4] === "z") {
      zoom = value;
    } else {
      // Satellite view: the number is the height of the visible map in metres.
      if (!(value > 0) || !(mapHeight > 0)) return null;
      const metresPerPxAtZoom0 = (EARTH_CIRCUMFERENCE / TILE) * Math.cos((lat * Math.PI) / 180);
      zoom = Math.log2((metresPerPxAtZoom0 * mapHeight) / value);
    }
    if (!Number.isFinite(zoom)) return null;
    return { lat, lng, zoom, heading: heading ? parseFloat(heading[1]) : 0 };
  }

  // ---------- Charging hours (Europe/London) ----------

  // Daily charge since 2 January 2026. Update here if TfL changes it.
  const DAILY_CHARGE = "£18";
  const DAY_MS = 86400000;
  const londonFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23",
  });

  function londonNow(date) {
    const p = {};
    for (const part of londonFmt.formatToParts(date)) p[part.type] = part.value;
    return {
      day: Date.UTC(+p.year, +p.month - 1, +p.day), // midnight UTC of the London calendar date
      minutes: +p.hour * 60 + +p.minute,
    };
  }

  function easterSunday(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, month - 1, day);
  }

  function firstMonday(y, month) {
    const d = new Date(Date.UTC(y, month, 1));
    return Date.UTC(y, month, 1 + ((8 - d.getUTCDay()) % 7));
  }

  function lastMonday(y, month) {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, last.getUTCDate() - ((last.getUTCDay() + 6) % 7));
  }

  function newYearBankHoliday(y) {
    const dow = new Date(Date.UTC(y, 0, 1)).getUTCDay();
    return Date.UTC(y, 0, dow === 6 ? 3 : dow === 0 ? 2 : 1);
  }

  // England & Wales bank holidays that fall outside the Christmas break.
  // (One-off extra bank holidays can't be predicted and aren't included.)
  function isBankHoliday(day) {
    const y = new Date(day).getUTCFullYear();
    const easter = easterSunday(y);
    return [
      easter - 2 * DAY_MS, easter + DAY_MS,
      firstMonday(y, 4), lastMonday(y, 4), lastMonday(y, 7),
    ].includes(day);
  }

  // Charging window for a London date as [startMin, endMin], or null.
  function chargingWindow(day) {
    const d = new Date(day);
    const y = d.getUTCFullYear(), month = d.getUTCMonth(), date = d.getUTCDate();
    // No charge from Christmas Day to the New Year's Day bank holiday, inclusive.
    if (month === 11 && date >= 25) return null;
    if (day <= newYearBankHoliday(y) && month === 0) return null;
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6 || isBankHoliday(day)) return [12 * 60, 18 * 60];
    return [7 * 60, 18 * 60];
  }

  function fmtTime(min) {
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = ((h + 11) % 12) + 1;
    return h12 + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
  }

  function chargeStatus(date = new Date()) {
    const { day, minutes } = londonNow(date);
    const today = chargingWindow(day);
    if (today && minutes >= today[0] && minutes < today[1]) {
      return { active: true, text: `Charging now · until ${fmtTime(today[1])}` };
    }
    for (let i = 0; i <= 21; i++) {
      const d = day + i * DAY_MS;
      const w = chargingWindow(d);
      if (!w || (i === 0 && minutes >= w[0])) continue;
      let when;
      if (i === 0) when = "today";
      else if (i === 1) when = "tomorrow";
      else if (i < 7) when = new Date(d).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
      else when = new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
      return { active: false, text: `Not charging · starts ${fmtTime(w[0])} ${when}` };
    }
    return { active: false, text: "Not charging now" };
  }

  // ---------- DOM ----------

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ccz-overlay");
  svg.setAttribute("aria-hidden", "true");
  const group = document.createElementNS(SVG_NS, "g");
  const halo = document.createElementNS(SVG_NS, "path");
  halo.setAttribute("class", "ccz-halo");
  const outline = document.createElementNS(SVG_NS, "path");
  outline.setAttribute("class", "ccz-outline");
  group.append(halo, outline);
  svg.append(group);

  const badge = document.createElement("div");
  badge.className = "ccz-badge";
  badge.hidden = true;
  badge.innerHTML = `
    <span class="ccz-sign" aria-hidden="true">C</span>
    <span class="ccz-text">
      <span class="ccz-title">Congestion Charge zone</span>
      <span class="ccz-status"></span>
    </span>
    <button type="button" class="ccz-toggle"></button>`;
  badge.title =
    `${DAILY_CHARGE} daily charge.\n` +
    "Mon–Fri 7am–6pm; Sat, Sun & bank holidays 12pm–6pm.\n" +
    "No charge from Christmas Day to the New Year's Day bank holiday.";
  const statusEl = badge.querySelector(".ccz-status");
  const toggleBtn = badge.querySelector(".ccz-toggle");

  // ---------- State ----------

  let visible = true;
  let mapCanvas = null;
  let lastKey = "";
  let lastView = null;
  let lastRect = null;
  let dragOffset = [0, 0];
  let dragging = null; // {x, y} at pointerdown
  let settleTimer = 0;
  let fadeTimer = 0;
  let lastCanvasLookup = 0;

  function findMapCanvas() {
    let best = null, bestArea = 0;
    for (const c of document.querySelectorAll("canvas")) {
      if (c.closest(".ccz-badge")) continue;
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = c; bestArea = area; }
    }
    return bestArea >= 200 * 200 ? best : null;
  }

  function ensureAttached() {
    const now = performance.now();
    if (mapCanvas && mapCanvas.isConnected && now - lastCanvasLookup < 2000) return mapCanvas;
    lastCanvasLookup = now;
    const canvas = findMapCanvas();
    if (!canvas) return null;
    // Google Maps stacks several full-size canvases (map, imagery, etc.).
    // Sit just above the last of them; place markers and labels drawn as
    // HTML still stay on top of the zone.
    let anchor = canvas;
    for (const el of canvas.parentNode.children) {
      if (el.tagName === "CANVAS" && el.clientWidth === canvas.clientWidth && el.clientHeight === canvas.clientHeight) {
        anchor = el;
      }
    }
    if (canvas !== mapCanvas || svg.previousElementSibling !== anchor) {
      mapCanvas = canvas;
      anchor.after(svg);
      lastKey = "";
    }
    if (!badge.isConnected) document.body.append(badge);
    return mapCanvas;
  }

  function setTransform() {
    if (!lastRect || !lastView) return;
    const cx = lastRect.width / 2, cy = lastRect.height / 2;
    let t = `translate(${dragOffset[0]} ${dragOffset[1]})`;
    if (lastView.heading) t += ` rotate(${-lastView.heading} ${cx} ${cy})`;
    group.setAttribute("transform", t);
  }

  function render() {
    const canvas = ensureAttached();
    if (!canvas) return;
    const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
    const key = `${location.href}|${rect.width}x${rect.height}|${canvas.offsetLeft},${canvas.offsetTop}`;
    if (key === lastKey) return;
    lastKey = key;

    const view = parseView(location.href, rect.height);
    lastView = view;
    lastRect = rect;
    dragOffset = [0, 0];
    clearTimeout(settleTimer);
    svg.classList.remove("ccz-fading");

    if (!view) {
      svg.style.display = "none";
      badge.hidden = true;
      return;
    }

    svg.style.left = canvas.offsetLeft + "px";
    svg.style.top = canvas.offsetTop + "px";
    svg.setAttribute("width", rect.width);
    svg.setAttribute("height", rect.height);
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

    const scale = TILE * Math.pow(2, view.zoom);
    const [cx, cy] = project(view.lat, view.lng);
    const ox = rect.width / 2 - cx * scale;
    const oy = rect.height / 2 - cy * scale;

    let d = "";
    for (let i = 0; i < zoneWorld.length; i++) {
      const [x, y] = zoneWorld[i];
      d += (i ? "L" : "M") + (x * scale + ox).toFixed(1) + " " + (y * scale + oy).toFixed(1);
    }
    d += "Z";
    halo.setAttribute("d", d);
    outline.setAttribute("d", d);
    setTransform();

    // Only show the badge when the zone is (roughly) on screen.
    const pad = Math.max(rect.width, rect.height) * 0.25;
    const onScreen =
      zoneBox[2] * scale + ox > -pad && zoneBox[0] * scale + ox < rect.width + pad &&
      zoneBox[3] * scale + oy > -pad && zoneBox[1] * scale + oy < rect.height + pad;
    badge.hidden = !onScreen;
    svg.style.display = visible ? "" : "none";
  }

  function updateStatus() {
    const s = chargeStatus();
    statusEl.textContent = s.text;
    badge.classList.toggle("ccz-active", s.active);
  }

  function applyVisibility() {
    svg.style.display = visible && lastView ? "" : "none";
    toggleBtn.textContent = visible ? "Hide" : "Show";
    toggleBtn.setAttribute("aria-label", visible ? "Hide congestion zone" : "Show congestion zone");
    badge.classList.toggle("ccz-off", !visible);
  }

  // ---------- Following the map while it moves ----------

  function isOnMap(target) {
    return mapCanvas && mapCanvas.parentNode && target instanceof Node && mapCanvas.parentNode.contains(target);
  }

  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary || !isOnMap(e.target)) return;
    dragging = { x: e.clientX - dragOffset[0], y: e.clientY - dragOffset[1] };
    clearTimeout(settleTimer);
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (!dragging || !e.isPrimary) return;
    if (!(e.buttons & 1)) { dragging = null; return; }
    dragOffset = [e.clientX - dragging.x, e.clientY - dragging.y];
    setTransform();
  }, true);

  const endDrag = () => {
    if (!dragging) return;
    dragging = null;
    // The URL normally updates after the map settles and we redraw then.
    // If it never changes (e.g. the map snapped back), trust the URL again.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { lastKey = ""; render(); }, 2500);
  };
  window.addEventListener("pointerup", endDrag, true);
  window.addEventListener("pointercancel", endDrag, true);

  // Zooming animates without updating the URL, so fade out until it settles
  // (render() clears the fade as soon as the URL changes).
  function fadeUntilSettled(e) {
    if (!isOnMap(e.target)) return;
    svg.classList.add("ccz-fading");
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { lastKey = ""; render(); }, 1500);
  }
  window.addEventListener("wheel", fadeUntilSettled, { capture: true, passive: true });
  window.addEventListener("dblclick", fadeUntilSettled, true);

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    visible = !visible;
    applyVisibility();
    try { chrome.storage?.local.set({ [STORAGE_KEY]: visible }); } catch (_) {}
  });

  try {
    chrome.storage?.local.get({ [STORAGE_KEY]: true }, (r) => {
      visible = r[STORAGE_KEY] !== false;
      applyVisibility();
    });
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area === "local" && STORAGE_KEY in changes) {
        visible = changes[STORAGE_KEY].newValue !== false;
        applyVisibility();
      }
    });
  } catch (_) {}

  // ---------- Main loop ----------

  function tick() {
    if (!dragging) render();
    requestAnimationFrame(tick);
  }

  applyVisibility();
  updateStatus();
  setInterval(updateStatus, 30000);
  requestAnimationFrame(tick);

  // Exposed for debugging in the page console of the extension's world.
  globalThis.__cczDebug = { parseView, chargeStatus, chargingWindow };
})();
