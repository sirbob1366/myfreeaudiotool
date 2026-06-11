/* MyFreeAudioTool — shared output meters.
   Taps every AudioNode.connect() aimed at a live AudioContext destination and
   routes it through one AnalyserNode rig, then draws a stereo LED VU pair and
   a mini spectrum strip into a rack injected at the top of .tool-panel.
   Pauses when the tab is hidden; static under prefers-reduced-motion. */
(function () {
  'use strict';
  if (window.__mfatMeters) return;
  window.__mfatMeters = true;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var taps = []; // one rig per AudioContext (in practice: one)
  var rack = null, vuCanvas = null, specCanvas = null;
  var raf = 0, idleTimer = 0, silentFrames = 0, running = false;

  // ---------- tap rig ----------
  var origConnect = AudioNode.prototype.connect;
  function getTap(ctx) {
    for (var i = 0; i < taps.length; i++) if (taps[i].ctx === ctx) return taps[i];
    var input = ctx.createGain();
    origConnect.call(input, ctx.destination);
    var splitter = ctx.createChannelSplitter(2);
    origConnect.call(input, splitter);
    var anL = ctx.createAnalyser(); anL.fftSize = 1024; anL.smoothingTimeConstant = 0.5;
    var anR = ctx.createAnalyser(); anR.fftSize = 1024; anR.smoothingTimeConstant = 0.5;
    origConnect.call(splitter, anL, 0);
    origConnect.call(splitter, anR, 1);
    var anF = ctx.createAnalyser(); anF.fftSize = 2048; anF.smoothingTimeConstant = 0.72;
    origConnect.call(input, anF);
    var tap = {
      ctx: ctx, input: input, anL: anL, anR: anR, anF: anF,
      tdL: new Float32Array(anL.fftSize), tdR: new Float32Array(anR.fftSize),
      fd: new Uint8Array(anF.frequencyBinCount),
      peakL: 0, peakR: 0, holdL: 0, holdR: 0
    };
    taps.push(tap);
    showRack();
    return tap;
  }

  AudioNode.prototype.connect = function (dest) {
    try {
      if (dest && typeof AudioDestinationNode !== 'undefined' &&
          dest instanceof AudioDestinationNode &&
          !(this.context && typeof OfflineAudioContext !== 'undefined' && this.context instanceof OfflineAudioContext)) {
        var tap = getTap(this.context);
        var args = Array.prototype.slice.call(arguments);
        args[0] = tap.input;
        return origConnect.apply(this, args);
      }
    } catch (e) { /* fall through to the real connect */ }
    return origConnect.apply(this, arguments);
  };

  // ---------- rack UI ----------
  function buildRack() {
    var panel = document.querySelector('.tool-panel');
    if (!panel || rack) return;
    rack = document.createElement('div');
    rack.className = 'meter-rack';
    rack.hidden = true;
    rack.setAttribute('aria-hidden', 'true');
    rack.innerHTML =
      '<span class="meter-rack__tag">OUT</span>' +
      '<canvas class="meter-rack__vu" width="10" height="10"></canvas>' +
      '<canvas class="meter-rack__spec" width="10" height="10"></canvas>';
    panel.insertBefore(rack, panel.firstChild);
    vuCanvas = rack.querySelector('.meter-rack__vu');
    specCanvas = rack.querySelector('.meter-rack__spec');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildRack);
  } else {
    buildRack();
  }

  function showRack() {
    if (!rack) buildRack();
    if (!rack) return;
    if (rack.hidden) {
      rack.hidden = false;
      drawStatic();
    }
    if (!reduced) start();
  }

  // ---------- drawing ----------
  var SEGS = 26;                       // LED segments per channel
  var DB_FLOOR = -48;

  function fit(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g: g, w: w, h: h };
  }

  function css(name, fallback) {
    // resolve against the rack so scoped themes (e.g. the editor) apply
    var v = getComputedStyle(rack || document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function rmsDb(td) {
    var sum = 0;
    for (var i = 0; i < td.length; i++) sum += td[i] * td[i];
    var rms = Math.sqrt(sum / td.length);
    return rms > 0 ? 20 * Math.log10(rms) : -120;
  }

  function segColor(i, lit, dark) {
    var frac = i / (SEGS - 1);
    if (!lit) return dark;
    if (frac > 0.88) return '#ff5470';
    if (frac > 0.7) return '#ffc24b';
    return css('--accent', '#0ea5e9');
  }

  function drawVu(tap) {
    var f = fit(vuCanvas), g = f.g, w = f.w, h = f.h;
    g.clearRect(0, 0, w, h);
    var dark = css('--wave-base', '#d9e8f4');
    var glow = document.documentElement.getAttribute('data-theme') === 'dark';
    var rows = [
      { db: tap.dbL, hold: tap.holdL },
      { db: tap.dbR, hold: tap.holdR }
    ];
    var rowH = (h - 4) / 2;
    var segW = (w - 16) / SEGS;
    g.font = '8px ui-monospace, monospace';
    g.textBaseline = 'middle';
    for (var r = 0; r < 2; r++) {
      var y = r * (rowH + 4);
      g.fillStyle = css('--muted', '#56708a');
      g.fillText(r === 0 ? 'L' : 'R', 0, y + rowH / 2 + 0.5);
      var level = (rows[r].db - DB_FLOOR) / -DB_FLOOR;     // 0..1
      var litCount = Math.round(Math.max(0, Math.min(1, level)) * SEGS);
      for (var i = 0; i < SEGS; i++) {
        var lit = i < litCount;
        g.fillStyle = segColor(i, lit, dark);
        if (lit && glow) { g.shadowColor = g.fillStyle; g.shadowBlur = 4; } else { g.shadowBlur = 0; }
        g.fillRect(10 + i * segW, y, Math.max(1, segW - 1.6), rowH);
      }
      g.shadowBlur = 0;
      // peak-hold tick
      var holdLevel = (rows[r].hold - DB_FLOOR) / -DB_FLOOR;
      if (holdLevel > 0.02) {
        var hx = 10 + Math.min(SEGS - 1, Math.floor(holdLevel * SEGS)) * segW;
        g.fillStyle = css('--text', '#0b1526');
        g.fillRect(hx, y, 1.5, rowH);
      }
    }
  }

  function drawSpec(tap) {
    var f = fit(specCanvas), g = f.g, w = f.w, h = f.h;
    g.clearRect(0, 0, w, h);
    var accent = css('--accent', '#0ea5e9');
    var bars = 48;
    var bins = tap.fd.length;
    g.fillStyle = accent;
    var glow = document.documentElement.getAttribute('data-theme') === 'dark';
    if (glow) { g.shadowColor = accent; g.shadowBlur = 3; }
    for (var i = 0; i < bars; i++) {
      // log-spaced bin sampling so lows don't hog the strip
      var t0 = i / bars, t1 = (i + 1) / bars;
      var b0 = Math.floor(Math.pow(bins, t0)) - 1, b1 = Math.max(b0 + 1, Math.floor(Math.pow(bins, t1)));
      var v = 0;
      for (var b = Math.max(0, b0); b < Math.min(bins, b1); b++) if (tap.fd[b] > v) v = tap.fd[b];
      var bh = Math.max(1, (v / 255) * (h - 2));
      g.globalAlpha = 0.35 + 0.65 * (v / 255);
      g.fillRect((i / bars) * w, h - bh, Math.max(1, w / bars - 1.5), bh);
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  }

  function drawStatic() {
    if (!vuCanvas) return;
    var fake = { dbL: -120, dbR: -120, holdL: -120, holdR: -120, fd: new Uint8Array(1024) };
    drawVu(fake);
    drawSpec(fake);
  }

  function frame() {
    raf = 0;
    if (!running || document.hidden) return;
    var loud = false;
    for (var i = 0; i < taps.length; i++) {
      var t = taps[i];
      t.anL.getFloatTimeDomainData(t.tdL);
      t.anR.getFloatTimeDomainData(t.tdR);
      t.anF.getByteFrequencyData(t.fd);
      t.dbL = rmsDb(t.tdL);
      t.dbR = rmsDb(t.tdR);
      t.holdL = Math.max(t.dbL, (t.holdL || -120) - 0.35);
      t.holdR = Math.max(t.dbR, (t.holdR || -120) - 0.35);
      if (t.dbL > -70 || t.dbR > -70) loud = true;
      drawVu(t);
      drawSpec(t);
    }
    silentFrames = loud ? 0 : silentFrames + 1;
    if (silentFrames > 300) {            // ~5 s of silence → low-power poll
      idleTimer = setTimeout(function () { raf = requestAnimationFrame(frame); }, 250);
    } else {
      raf = requestAnimationFrame(frame);
    }
  }

  function start() {
    if (running || reduced) return;
    running = true;
    silentFrames = 0;
    raf = requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      if (idleTimer) clearTimeout(idleTimer);
      raf = 0;
    } else if (running) {
      raf = requestAnimationFrame(frame);
    }
  });
})();
