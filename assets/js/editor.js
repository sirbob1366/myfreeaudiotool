/* MyFreeAudioTool — all-in-one Audio Editor.
   Single-track waveform editor: zoom/pan, selection editing (cut/copy/paste/
   crop/silence), fades, normalize, reverse, an FX rack (gain, bass, reverb,
   echo, speed, vocal remover, 8D, noise reduction) with preview + apply,
   multi-level undo/redo, and WAV/MP3 export. 100% client-side. */
(function () {
  'use strict';
  var E = window.AudioEngine;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- state ----------------
  var buffer = null;          // current AudioBuffer
  var fileName = 'untitled.wav';
  var view = { start: 0, end: 1 };   // visible window, seconds
  var sel = null;             // {a, b} seconds or null
  var cursor = 0;             // playhead origin, seconds
  var playing = null;         // {source, startedAt, startPos, endPos, loop}
  var loopOn = false;
  var clipboard = null;       // AudioBuffer
  var undoStack = [], redoStack = [];
  var HISTORY_SAMPLE_BUDGET = 48e6;  // ≈190 MB of float32 across the stack
  var cacheDirty = true;
  var busy = false;

  var waveCanvas = $('edWave');
  var rulerCanvas = $('edRuler');
  var cache = document.createElement('canvas');

  // ---------------- utilities ----------------
  function ctx() { return E.getAudioContext(); }
  function dur() { return buffer ? buffer.duration : 0; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function span() { return view.end - view.start; }

  function fmtTime(sec, ms) {
    if (!isFinite(sec)) sec = 0;
    sec = Math.max(0, sec);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    var ss = ms ? s.toFixed(2) : s.toFixed(1);
    if (s < 10) ss = '0' + ss;
    return m + ':' + ss;
  }

  function status(msg, kind) {
    var el = $('edStatus');
    el.textContent = msg || '';
    el.className = 'editor-status' + (kind ? ' ' + kind : '');
  }

  function copyBuffer(src) {
    var out = ctx().createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (var c = 0; c < src.numberOfChannels; c++) out.getChannelData(c).set(src.getChannelData(c));
    return out;
  }

  // [0,a) + insert + (b,end] — insert may be null (pure delete)
  function splice(src, aSec, bSec, insert) {
    var rate = src.sampleRate;
    var ch = src.numberOfChannels;
    var a = clamp(Math.round(aSec * rate), 0, src.length);
    var b = clamp(Math.round(bSec * rate), a, src.length);
    var insFrames = insert ? insert.length : 0;
    var total = Math.max(1, a + insFrames + (src.length - b));
    var out = ctx().createBuffer(ch, total, rate);
    for (var c = 0; c < ch; c++) {
      var d = out.getChannelData(c);
      var s = src.getChannelData(c);
      d.set(s.subarray(0, a), 0);
      if (insert) d.set(insert.getChannelData(Math.min(c, insert.numberOfChannels - 1)), a);
      d.set(s.subarray(b), a + insFrames);
    }
    return out;
  }

  function historySamples(stack) {
    return stack.reduce(function (s, b) { return s + b.length * b.numberOfChannels; }, 0);
  }

  function setBuffer(next, label, keepSel) {
    if (buffer) {
      undoStack.push(buffer);
      redoStack.length = 0;
      while (undoStack.length > 2 && historySamples(undoStack) > HISTORY_SAMPLE_BUDGET) undoStack.shift();
    }
    buffer = next;
    if (!keepSel) sel = null;
    cursor = clamp(cursor, 0, dur());
    view.start = clamp(view.start, 0, Math.max(0, dur() - 0.001));
    view.end = clamp(view.end, view.start + 0.001, dur());
    if (label) status('✓ ' + label, 'success');
    cacheDirty = true;
    requestDraw();
    updateUI();
  }

  // ---------------- waveform rendering ----------------
  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; draw(); });
  }

  function fitCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      cacheDirty = true;
    }
    return { w: w, h: h, dpr: dpr };
  }

  function css(name, fb) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  }

  function redrawCache(W, H) {
    cache.width = W;
    cache.height = H;
    var g = cache.getContext('2d');
    g.fillStyle = css('--card', '#fff');
    g.fillRect(0, 0, W, H);
    if (!buffer) return;
    var chN = Math.min(2, buffer.numberOfChannels);
    var laneH = H / chN;
    var rate = buffer.sampleRate;
    var accent = css('--accent', '#0ea5e9');
    var border = css('--border', '#dbeaf5');
    var sec0 = view.start, sp = span();
    var sppx = sp * rate / W; // samples per pixel column

    g.strokeStyle = border;
    g.lineWidth = 1;
    for (var l = 1; l < chN; l++) {
      g.beginPath(); g.moveTo(0, l * laneH); g.lineTo(W, l * laneH); g.stroke();
    }

    g.fillStyle = accent;
    g.globalAlpha = 0.85;
    var stride = Math.max(1, Math.floor(sppx / 80));
    for (var c = 0; c < chN; c++) {
      var data = buffer.getChannelData(c);
      var mid = c * laneH + laneH / 2;
      var amp = laneH / 2 - 3;
      for (var x = 0; x < W; x++) {
        var f0 = Math.floor((sec0 + (x / W) * sp) * rate);
        var f1 = Math.max(f0 + 1, Math.floor((sec0 + ((x + 1) / W) * sp) * rate));
        if (f0 >= data.length) break;
        f1 = Math.min(f1, data.length);
        var max = 0;
        for (var i = f0; i < f1; i += stride) {
          var v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        var hh = Math.max(max * amp, 0.7);
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
      // center line
      g.globalAlpha = 0.5;
      g.fillRect(0, mid - 0.5, W, 1);
      g.globalAlpha = 0.85;
    }
    g.globalAlpha = 1;
  }

  function secToX(sec, W) { return (sec - view.start) / span() * W; }
  function xToSec(xCss) {
    var r = waveCanvas.getBoundingClientRect();
    return clamp(view.start + (xCss / r.width) * span(), 0, dur());
  }

  function draw() {
    var f = fitCanvas(waveCanvas);
    var W = f.w, H = f.h;
    var g = waveCanvas.getContext('2d');
    if (cacheDirty) { redrawCache(W, H); cacheDirty = false; }
    g.clearRect(0, 0, W, H);
    g.drawImage(cache, 0, 0);

    if (buffer) {
      // selection
      if (sel) {
        var x0 = secToX(sel.a, W), x1 = secToX(sel.b, W);
        g.fillStyle = 'rgba(14,165,233,0.14)';
        g.fillRect(x0, 0, x1 - x0, H);
        g.fillStyle = css('--accent', '#0ea5e9');
        g.fillRect(x0 - 1, 0, 2, H);
        g.fillRect(x1 - 1, 0, 2, H);
      }
      // cursor
      var cx = secToX(cursor, W);
      if (cx >= 0 && cx <= W) {
        g.fillStyle = css('--text', '#0b1526');
        g.fillRect(cx - 0.5, 0, 1.5, H);
      }
      // playhead
      if (playing) {
        var px = secToX(playPos(), W);
        if (px >= 0 && px <= W) {
          g.fillStyle = css('--accent-2', '#22d3ee');
          g.fillRect(px - 1, 0, 2, H);
        }
      }
    }
    drawRuler();
  }

  function drawRuler() {
    var f = fitCanvas(rulerCanvas);
    var W = f.w, H = f.h, dpr = f.dpr;
    var g = rulerCanvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!buffer) return;
    g.font = (9 * dpr) + 'px ui-monospace, monospace';
    g.fillStyle = css('--muted', '#56708a');
    g.strokeStyle = css('--border', '#dbeaf5');
    var steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    var minPx = 80 * dpr;
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] / span() * W >= minPx) { step = steps[i]; break; }
    }
    var t = Math.ceil(view.start / step) * step;
    g.lineWidth = 1;
    for (; t <= view.end; t += step) {
      var x = secToX(t, W);
      g.beginPath(); g.moveTo(x, H - 7 * dpr); g.lineTo(x, H); g.stroke();
      g.fillText(fmtTime(t, step < 1), x + 3 * dpr, H - 9 * dpr);
    }
  }

  // ---------------- playback ----------------
  function playPos() {
    if (!playing) return cursor;
    var t = ctx().currentTime - playing.startedAt;
    if (playing.loop) {
      var len = playing.endPos - playing.startPos;
      return playing.startPos + (t % len);
    }
    return Math.min(playing.startPos + t, playing.endPos);
  }

  function stopPlayback(setCursorToPos) {
    if (!playing) return;
    var pos = playPos();
    var p = playing;
    playing = null;
    try { p.source.onended = null; p.source.stop(); } catch (e) {}
    if (setCursorToPos) cursor = clamp(pos, 0, dur());
    $('playBtn').innerHTML = ICON_PLAY + '<span class="ebtn-label">Play</span>';
    requestDraw();
    updateTime();
  }

  function play() {
    if (!buffer) return;
    stopPlayback(false);
    var a = sel ? sel.a : cursor;
    var b = sel ? sel.b : dur();
    if (a >= b - 0.005) a = sel ? sel.a : 0;
    var source = ctx().createBufferSource();
    source.buffer = buffer;
    if (loopOn) {
      source.loop = true;
      source.loopStart = a;
      source.loopEnd = b;
    }
    source.connect(ctx().destination);
    source.start(0, a, loopOn ? undefined : b - a);
    playing = { source: source, startedAt: ctx().currentTime, startPos: a, endPos: b, loop: loopOn };
    source.onended = function () { stopPlayback(false); };
    $('playBtn').innerHTML = ICON_PAUSE + '<span class="ebtn-label">Pause</span>';
    (function tick() {
      if (!playing) return;
      requestDraw();
      updateTime();
      requestAnimationFrame(tick);
    })();
  }

  function togglePlay() {
    if (playing) stopPlayback(true);
    else play();
  }

  function updateTime() {
    $('edTime').innerHTML = fmtTime(playing ? playPos() : cursor, true) +
      ' <small>/ ' + fmtTime(dur(), true) + '</small>';
    $('edSelInfo').textContent = sel
      ? 'sel ' + fmtTime(sel.a, true) + ' – ' + fmtTime(sel.b, true) + ' (' + fmtTime(sel.b - sel.a, true) + ')'
      : '';
  }

  // ---------------- zoom / pan ----------------
  function zoomAt(centerSec, factor) {
    var sp = clamp(span() * factor, 0.01, dur());
    var frac = (centerSec - view.start) / span();
    view.start = clamp(centerSec - frac * sp, 0, Math.max(0, dur() - sp));
    view.end = view.start + sp;
    cacheDirty = true;
    requestDraw();
  }
  function fit() {
    view.start = 0;
    view.end = Math.max(0.01, dur());
    cacheDirty = true;
    requestDraw();
  }
  function pan(deltaSec) {
    var sp = span();
    view.start = clamp(view.start + deltaSec, 0, Math.max(0, dur() - sp));
    view.end = view.start + sp;
    cacheDirty = true;
    requestDraw();
  }

  // ---------------- pointer interaction ----------------
  var drag = null; // {mode:'select'|'edgeA'|'edgeB', startX, startSec, moved}
  function nearEdge(xCss) {
    if (!sel) return null;
    var r = waveCanvas.getBoundingClientRect();
    var xa = secToX(sel.a, r.width), xb = secToX(sel.b, r.width);
    if (Math.abs(xCss - xa) < 8) return 'edgeA';
    if (Math.abs(xCss - xb) < 8) return 'edgeB';
    return null;
  }
  waveCanvas.addEventListener('pointerdown', function (e) {
    if (!buffer) return;
    waveCanvas.setPointerCapture(e.pointerId);
    var r = waveCanvas.getBoundingClientRect();
    var x = e.clientX - r.left;
    var mode = nearEdge(x) || 'select';
    drag = { mode: mode, startX: x, startSec: xToSec(x), moved: false };
    e.preventDefault();
  });
  waveCanvas.addEventListener('pointermove', function (e) {
    var r = waveCanvas.getBoundingClientRect();
    var x = e.clientX - r.left;
    if (!drag) {
      waveCanvas.style.cursor = nearEdge(x) ? 'ew-resize' : 'text';
      return;
    }
    var t = xToSec(x);
    if (Math.abs(x - drag.startX) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.mode === 'select') {
      sel = { a: Math.min(drag.startSec, t), b: Math.max(drag.startSec, t) };
    } else if (drag.mode === 'edgeA') {
      sel.a = clamp(Math.min(t, sel.b - 0.001), 0, dur());
    } else {
      sel.b = clamp(Math.max(t, sel.a + 0.001), 0, dur());
    }
    requestDraw();
    updateTime();
    updateUI();
  });
  function endDrag(e) {
    if (!drag) return;
    if (!drag.moved) {
      cursor = drag.startSec;
      sel = null;
      if (playing) { stopPlayback(false); play(); }
      updateUI();
    }
    drag = null;
    requestDraw();
    updateTime();
  }
  waveCanvas.addEventListener('pointerup', endDrag);
  waveCanvas.addEventListener('pointercancel', function () { drag = null; });
  waveCanvas.addEventListener('dblclick', function () {
    if (!buffer) return;
    sel = { a: 0, b: dur() };
    requestDraw(); updateTime(); updateUI();
  });
  waveCanvas.addEventListener('wheel', function (e) {
    if (!buffer) return;
    e.preventDefault();
    var r = waveCanvas.getBoundingClientRect();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      pan((e.deltaX || e.deltaY) / r.width * span());
    } else {
      zoomAt(xToSec(e.clientX - r.left), Math.pow(1.25, e.deltaY / 100));
    }
  }, { passive: false });
  rulerCanvas.addEventListener('click', function (e) {
    if (!buffer) return;
    var r = rulerCanvas.getBoundingClientRect();
    cursor = xToSec(e.clientX - r.left);
    requestDraw(); updateTime();
  });
  window.addEventListener('resize', function () { cacheDirty = true; requestDraw(); });

  // ---------------- edit operations ----------------
  function scope() { return sel || { a: 0, b: dur() }; }

  function doDelete() {
    if (!sel) return;
    stopPlayback(true);
    var a = sel.a;
    setBuffer(splice(buffer, sel.a, sel.b, null), 'Deleted ' + fmtTime(sel.b - sel.a, true));
    cursor = clamp(a, 0, dur());
    fitIfOutOfRange();
  }
  function doCopy() {
    if (!sel) return;
    clipboard = E.sliceBuffer(buffer, sel.a, sel.b);
    status('Copied ' + fmtTime(sel.b - sel.a, true) + ' to clipboard.', 'success');
    updateUI();
  }
  function doCut() {
    if (!sel) return;
    clipboard = E.sliceBuffer(buffer, sel.a, sel.b);
    doDelete();
  }
  function doPaste() {
    if (!clipboard) return;
    stopPlayback(true);
    var at = sel ? sel.a : cursor;
    var end = sel ? sel.b : cursor;
    var pasteLen = clipboard.duration;
    setBuffer(splice(buffer, at, end, clipboard), 'Pasted ' + fmtTime(pasteLen, true));
    sel = { a: at, b: at + pasteLen };
    cursor = at;
    requestDraw(); updateUI(); updateTime();
  }
  function doCrop() {
    if (!sel) return;
    stopPlayback(true);
    setBuffer(E.sliceBuffer(buffer, sel.a, sel.b), 'Cropped to selection');
    cursor = 0;
    fit();
  }
  function doSilence() {
    if (!sel) return;
    stopPlayback(true);
    var out = copyBuffer(buffer);
    var a = Math.round(sel.a * out.sampleRate), b = Math.round(sel.b * out.sampleRate);
    for (var c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).fill(0, a, b);
    var keep = sel;
    setBuffer(out, 'Silenced selection', true);
    sel = keep;
    requestDraw();
  }
  function doFade(dir) {
    if (!sel) return;
    stopPlayback(true);
    var out = copyBuffer(buffer);
    var a = Math.round(sel.a * out.sampleRate), b = Math.round(sel.b * out.sampleRate);
    var n = b - a;
    for (var c = 0; c < out.numberOfChannels; c++) {
      var d = out.getChannelData(c);
      for (var i = 0; i < n; i++) {
        var f = i / n;
        d[a + i] *= dir === 'in' ? f : 1 - f;
      }
    }
    var keep = sel;
    setBuffer(out, dir === 'in' ? 'Fade in applied' : 'Fade out applied', true);
    sel = keep;
    requestDraw();
  }
  function doNormalize() {
    stopPlayback(true);
    var sc = scope();
    var out = copyBuffer(buffer);
    var a = Math.round(sc.a * out.sampleRate), b = Math.round(sc.b * out.sampleRate);
    var peak = 0, c, i, d;
    for (c = 0; c < out.numberOfChannels; c++) {
      d = out.getChannelData(c);
      for (i = a; i < b; i++) { var v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    if (peak < 1e-6) { status('Nothing to normalize — the region is silent.', 'error'); return; }
    var gain = 0.98 / peak;
    for (c = 0; c < out.numberOfChannels; c++) {
      d = out.getChannelData(c);
      for (i = a; i < b; i++) d[i] *= gain;
    }
    var keep = sel;
    setBuffer(out, 'Normalized to −0.2 dBFS (' + (20 * Math.log10(gain)).toFixed(1) + ' dB)', true);
    sel = keep;
    requestDraw();
  }
  function doReverse() {
    stopPlayback(true);
    var sc = scope();
    var out = copyBuffer(buffer);
    var a = Math.round(sc.a * out.sampleRate), b = Math.round(sc.b * out.sampleRate);
    for (var c = 0; c < out.numberOfChannels; c++) {
      var d = out.getChannelData(c);
      for (var i = a, j = b - 1; i < j; i++, j--) {
        var t = d[i]; d[i] = d[j]; d[j] = t;
      }
    }
    var keep = sel;
    setBuffer(out, 'Reversed ' + (sel ? 'selection' : 'track'), true);
    sel = keep;
    requestDraw();
  }
  function doUndo() {
    if (!undoStack.length) return;
    stopPlayback(true);
    redoStack.push(buffer);
    buffer = undoStack.pop();
    sel = null;
    cursor = clamp(cursor, 0, dur());
    fitIfOutOfRange();
    cacheDirty = true;
    status('Undo.');
    requestDraw(); updateUI(); updateTime();
  }
  function doRedo() {
    if (!redoStack.length) return;
    stopPlayback(true);
    undoStack.push(buffer);
    buffer = redoStack.pop();
    sel = null;
    cursor = clamp(cursor, 0, dur());
    fitIfOutOfRange();
    cacheDirty = true;
    status('Redo.');
    requestDraw(); updateUI(); updateTime();
  }
  function fitIfOutOfRange() {
    if (view.end > dur() || span() > dur()) fit();
  }

  // ---------------- FX rack ----------------
  function mixGains(mixPct) {
    var m = mixPct / 100;
    return { dry: Math.cos(m * Math.PI / 2), wet: Math.sin(m * Math.PI / 2) };
  }

  var FX = {
    gain: {
      name: 'Volume', note: 'Boost or attenuate. Use Normalize in the toolbar for automatic leveling.',
      params: [{ id: 'db', label: 'Gain', unit: 'dB', min: -24, max: 24, step: 0.5, def: 6, decimals: 1, signed: true }],
      build: function (c, src, p) {
        var g = c.createGain();
        g.gain.value = Math.pow(10, p.db / 20);
        src.connect(g);
        return g;
      }
    },
    bass: {
      name: 'Bass Boost', note: 'Studio low-shelf with a limiter so the boost never clips.',
      params: [
        { id: 'freq', label: 'Frequency', unit: 'Hz', min: 40, max: 250, step: 5, def: 110 },
        { id: 'boost', label: 'Boost', unit: 'dB', min: 0, max: 18, step: 0.5, def: 9, decimals: 1 }
      ],
      build: function (c, src, p) {
        var shelf = c.createBiquadFilter();
        shelf.type = 'lowshelf';
        shelf.frequency.value = p.freq;
        shelf.gain.value = p.boost;
        var comp = c.createDynamicsCompressor();
        comp.threshold.value = -1; comp.knee.value = 0; comp.ratio.value = 20;
        comp.attack.value = 0.001; comp.release.value = 0.1;
        src.connect(shelf); shelf.connect(comp);
        return comp;
      }
    },
    reverb: {
      name: 'Reverb', note: 'Convolution reverb. The tail blends naturally into the audio after the selection.',
      params: [
        { id: 'size', label: 'Size', unit: 's', min: 0.3, max: 4.5, step: 0.1, def: 1.7, decimals: 1 },
        { id: 'mix', label: 'Mix', unit: '%', min: 0, max: 100, step: 1, def: 35 }
      ],
      tail: function (p) { return p.size + 0.1; },
      build: function (c, src, p) {
        var g = mixGains(p.mix);
        var dry = c.createGain(); dry.gain.value = g.dry;
        var wet = c.createGain(); wet.gain.value = g.wet;
        var conv = c.createConvolver();
        conv.buffer = E.makeImpulse(c, { seconds: p.size, decay: 2.4, brightness: 0.65 });
        var sum = c.createGain();
        src.connect(dry); dry.connect(sum);
        src.connect(conv); conv.connect(wet); wet.connect(sum);
        return sum;
      }
    },
    echo: {
      name: 'Echo / Delay', note: 'Classic feedback delay.',
      params: [
        { id: 'time', label: 'Delay', unit: 'ms', min: 40, max: 1000, step: 10, def: 300 },
        { id: 'fb', label: 'Feedback', unit: '%', min: 0, max: 85, step: 1, def: 40 },
        { id: 'mix', label: 'Mix', unit: '%', min: 0, max: 100, step: 1, def: 35 }
      ],
      tail: function (p) { return Math.min(6, (p.time / 1000) * (p.fb >= 80 ? 12 : p.fb >= 50 ? 8 : 5)); },
      build: function (c, src, p) {
        var g = mixGains(p.mix);
        var dry = c.createGain(); dry.gain.value = g.dry;
        var wet = c.createGain(); wet.gain.value = g.wet;
        var delay = c.createDelay(1.2);
        delay.delayTime.value = p.time / 1000;
        var fb = c.createGain(); fb.gain.value = p.fb / 100;
        var sum = c.createGain();
        src.connect(dry); dry.connect(sum);
        src.connect(delay);
        delay.connect(fb); fb.connect(delay);
        delay.connect(wet); wet.connect(sum);
        return sum;
      }
    },
    speed: {
      name: 'Speed', note: 'True playback-rate change — pitch shifts with it, like tape or vinyl.',
      params: [{ id: 'rate', label: 'Speed', unit: '×', min: 0.5, max: 2, step: 0.01, def: 0.85, decimals: 2 }],
      rate: function (p) { return p.rate; },
      build: function (c, src) { var g = c.createGain(); src.connect(g); return g; }
    },
    vocal: {
      name: 'Vocal Remover', note: 'Center-channel cancellation — needs stereo audio; results vary by mix.',
      stereoOnly: true,
      params: [
        { id: 'strength', label: 'Strength', unit: '%', min: 0, max: 100, step: 1, def: 100 },
        { id: 'bass', label: 'Keep bass below', unit: 'Hz', min: 60, max: 300, step: 5, def: 120 }
      ],
      build: function (c, src, p) {
        var split = c.createChannelSplitter(2);
        src.connect(split);
        var hL = c.createGain(); hL.gain.value = 0.5;
        var hR = c.createGain(); hR.gain.value = 0.5;
        split.connect(hL, 0); split.connect(hR, 1);
        var hp = c.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = p.bass; hp.Q.value = 0.707;
        hL.connect(hp); hR.connect(hp);
        var inv = c.createGain(); inv.gain.value = -(p.strength / 100);
        hp.connect(inv);
        var pL = c.createGain(), pR = c.createGain();
        split.connect(pL, 0); split.connect(pR, 1);
        var merger = c.createChannelMerger(2);
        pL.connect(merger, 0, 0); pR.connect(merger, 0, 1);
        inv.connect(merger, 0, 0); inv.connect(merger, 0, 1);
        return merger;
      }
    },
    spatial: {
      name: '8D Orbit', note: 'Auto-panner sweeping the sound around your head. Headphones!',
      params: [
        { id: 'speed', label: 'Rotation', unit: 'Hz', min: 0.05, max: 0.5, step: 0.01, def: 0.15, decimals: 2 },
        { id: 'width', label: 'Width', unit: '%', min: 30, max: 100, step: 1, def: 90 }
      ],
      build: function (c, src, p) {
        var panner = c.createStereoPanner();
        var lfo = c.createOscillator();
        lfo.frequency.value = p.speed;
        var lg = c.createGain(); lg.gain.value = p.width / 100;
        lfo.connect(lg); lg.connect(panner.pan);
        lfo.start(0);
        src.connect(panner);
        return panner;
      }
    },
    noisered: { name: 'Noise Reduction', custom: true }
  };

  var currentFx = 'gain';
  var fxScope = 'auto'; // 'sel' | 'all'
  var fxPreview = null;
  var noiseProfile = null;

  function fxParams() {
    var fx = FX[currentFx];
    var out = {};
    (fx.params || []).forEach(function (p) {
      var el = $('fxp_' + p.id);
      out[p.id] = el ? parseFloat(el.value) : p.def;
    });
    return out;
  }

  function renderFxPanel() {
    var fx = FX[currentFx];
    document.querySelectorAll('.fx-list button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.fx === currentFx);
    });
    var html = '<h3>' + fx.name + '</h3><p class="fx-note">' + (fx.note || '') + '</p>';
    if (currentFx === 'noisered') {
      html +=
        '<p class="fx-note"><b>1.</b> Drag-select a moment of pure noise on the waveform → <b>2.</b> Learn → <b>3.</b> Apply to the whole track.</p>' +
        '<div class="fx-actions">' +
        '<button class="btn btn--ghost btn--sm" id="fxLearnBtn" type="button">Learn noise from selection</button>' +
        '<span class="editor-selinfo" id="fxProfileInfo">' + (noiseProfile ? '✓ profile ready' : 'no profile yet') + '</span>' +
        '</div>' +
        '<div class="knob-row" style="justify-content:flex-start">' +
        '<input type="range" id="fxp_strength" data-knob data-label="Strength" data-unit="%" data-default="60" min="0" max="100" step="1" value="60">' +
        '</div>' +
        '<div class="fx-actions">' +
        '<button class="btn btn--primary btn--sm" id="fxApplyBtn" type="button"' + (noiseProfile ? '' : ' disabled') + '>Apply noise reduction</button>' +
        '</div>';
    } else {
      html += '<div class="knob-row" style="justify-content:flex-start">';
      fx.params.forEach(function (p) {
        html += '<input type="range" id="fxp_' + p.id + '" data-knob data-label="' + p.label + '" data-unit="' + p.unit + '"' +
          (p.signed ? ' data-signed' : '') +
          (p.decimals ? ' data-decimals="' + p.decimals + '"' : '') +
          ' data-default="' + p.def + '" min="' + p.min + '" max="' + p.max + '" step="' + p.step + '" value="' + p.def + '">';
      });
      html += '</div>';
      html +=
        '<div class="fx-actions">' +
        '<div class="fx-scope" id="fxScope">' +
        '<button type="button" data-scope="sel"' + (sel ? '' : ' disabled') + '>Selection</button>' +
        '<button type="button" data-scope="all">Whole track</button>' +
        '</div>' +
        '<button class="btn btn--ghost btn--sm" id="fxPreviewBtn" type="button">▶ Preview</button>' +
        '<button class="btn btn--primary btn--sm" id="fxApplyBtn" type="button">Apply</button>' +
        (fx.stereoOnly && buffer && buffer.numberOfChannels < 2
          ? '<span class="editor-selinfo" style="color:var(--err)">needs stereo audio</span>' : '') +
        '</div>';
    }
    $('fxParams').innerHTML = html;
    if (window.Controls) Controls.upgrade($('fxParams'));

    // scope buttons
    var scopeBtns = document.querySelectorAll('#fxScope button');
    function setScope(s) {
      fxScope = s;
      scopeBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.scope === s); });
    }
    if (scopeBtns.length) setScope(sel ? 'sel' : 'all');
    scopeBtns.forEach(function (b) {
      b.addEventListener('click', function () { setScope(b.dataset.scope); });
    });

    var prevBtn = $('fxPreviewBtn');
    if (prevBtn) prevBtn.addEventListener('click', toggleFxPreview);
    var applyBtn = $('fxApplyBtn');
    if (applyBtn) {
      applyBtn.addEventListener('click', currentFx === 'noisered' ? applyNoiseReduction : applyFx);
      if (FX[currentFx].stereoOnly && buffer && buffer.numberOfChannels < 2) applyBtn.disabled = true;
    }
    var learnBtn = $('fxLearnBtn');
    if (learnBtn) learnBtn.addEventListener('click', learnNoise);
  }

  function fxScopeRange() {
    if (fxScope === 'sel' && sel) return sel;
    return { a: 0, b: dur() };
  }

  function stopFxPreview() {
    if (!fxPreview) return;
    try { fxPreview.source.onended = null; fxPreview.source.stop(); } catch (e) {}
    if (fxPreview.lfo) { try { fxPreview.lfo.stop(); } catch (e) {} }
    fxPreview = null;
    var b = $('fxPreviewBtn');
    if (b) b.textContent = '▶ Preview';
  }

  function toggleFxPreview() {
    if (fxPreview) { stopFxPreview(); return; }
    if (!buffer) return;
    stopPlayback(true);
    var fx = FX[currentFx];
    var p = fxParams();
    var r = fxScopeRange();
    var source = ctx().createBufferSource();
    source.buffer = buffer;
    if (fx.rate) source.playbackRate.value = fx.rate(p);
    var out = fx.build(ctx(), source, p);
    out.connect(ctx().destination);
    source.start(0, r.a, r.b - r.a);
    fxPreview = { source: source };
    source.onended = function () { stopFxPreview(); };
    $('fxPreviewBtn').textContent = '⏸ Stop';
  }

  function applyFx() {
    if (!buffer || busy) return;
    var fx = FX[currentFx];
    if (fx.stereoOnly && buffer.numberOfChannels < 2) return;
    stopFxPreview();
    stopPlayback(true);
    busy = true;
    status('Applying ' + fx.name + '…');
    var p = fxParams();
    var r = fxScopeRange();
    // the 8D orbit needs a stereo canvas — upgrade mono tracks first
    if (currentFx === 'spatial' && buffer.numberOfChannels === 1) {
      var st = ctx().createBuffer(2, buffer.length, buffer.sampleRate);
      st.getChannelData(0).set(buffer.getChannelData(0));
      st.getChannelData(1).set(buffer.getChannelData(0));
      buffer = st; // same audio, no history entry needed for the channel upgrade
      cacheDirty = true;
    }
    var slice = E.sliceBuffer(buffer, r.a, r.b);
    var tailSec = fx.tail ? fx.tail(p) : 0;
    var rate = buffer.sampleRate;
    var rendered;
    if (fx.rate) {
      var spd = fx.rate(p);
      var frames = Math.max(1, Math.ceil(slice.duration / spd * rate));
      var off = new OfflineAudioContext(slice.numberOfChannels, frames, rate);
      var src = off.createBufferSource();
      src.buffer = slice;
      src.playbackRate.value = spd;
      fx.build(off, src, p).connect(off.destination);
      src.start(0);
      rendered = off.startRendering();
    } else {
      var outCh = currentFx === 'spatial' ? 2 : slice.numberOfChannels;
      rendered = E.renderBufferThrough(slice, function (off, src) {
        return fx.build(off, src, p);
      }, tailSec, outCh);
    }
    rendered.then(function (ren) {
      var peak = E.bufferPeak(ren);
      if (peak > 1) E.scaleBuffer(ren, 0.98 / peak);
      var tailFrames = Math.round(tailSec * rate);
      var mainFrames = ren.length - tailFrames;
      // main part replaces the scope region
      var main = ctx().createBuffer(ren.numberOfChannels, Math.max(1, mainFrames), rate);
      for (var c = 0; c < ren.numberOfChannels; c++) {
        main.getChannelData(c).set(ren.getChannelData(c).subarray(0, mainFrames));
      }
      var next = splice(buffer, r.a, r.b, main);
      // blend the effect tail into whatever follows the region
      if (tailFrames > 0) {
        var startFrame = Math.round(r.a * rate) + mainFrames;
        if (startFrame + tailFrames > next.length) {
          var grown = ctx().createBuffer(next.numberOfChannels, startFrame + tailFrames, rate);
          for (var c2 = 0; c2 < next.numberOfChannels; c2++) grown.getChannelData(c2).set(next.getChannelData(c2));
          next = grown;
        }
        for (var c3 = 0; c3 < next.numberOfChannels; c3++) {
          var d = next.getChannelData(c3);
          var t = ren.getChannelData(Math.min(c3, ren.numberOfChannels - 1));
          for (var i = 0; i < tailFrames; i++) d[startFrame + i] += t[mainFrames + i];
        }
        var peak2 = E.bufferPeak(next);
        if (peak2 > 1) E.scaleBuffer(next, 0.98 / peak2);
      }
      busy = false;
      setBuffer(next, fx.name + ' applied');
      fitIfOutOfRange();
      renderFxPanel();
    }).catch(function (err) {
      busy = false;
      status(E.humanError(err), 'error');
    });
  }

  // ---------------- noise reduction (spectral gate) ----------------
  var FRAME = 2048, HOP = 512;
  var hann = new Float32Array(FRAME);
  for (var hi = 0; hi < FRAME; hi++) hann[hi] = 0.5 * (1 - Math.cos(2 * Math.PI * hi / FRAME));

  function learnNoise() {
    if (!sel || sel.b - sel.a < 0.15) {
      status('Select at least 0.15 s of noise-only audio on the waveform first.', 'error');
      return;
    }
    var bins = FRAME / 2 + 1;
    noiseProfile = [];
    var re = new Float32Array(FRAME), im = new Float32Array(FRAME);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var data = buffer.getChannelData(c);
      var s0 = clamp(Math.floor(sel.a * buffer.sampleRate), 0, Math.max(0, data.length - FRAME));
      var s1 = Math.min(data.length - FRAME, Math.floor(sel.b * buffer.sampleRate) - FRAME);
      var prof = new Float32Array(bins);
      var count = 0;
      for (var pos = s0; pos <= Math.max(s0, s1); pos += HOP) {
        for (var i = 0; i < FRAME; i++) { re[i] = data[pos + i] * hann[i]; im[i] = 0; }
        E.fft(re, im, false);
        for (var b = 0; b < bins; b++) prof[b] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
        count++;
      }
      if (count) for (var b2 = 0; b2 < bins; b2++) prof[b2] /= count;
      noiseProfile.push(prof);
    }
    status('✓ Noise profile learned from selection.', 'success');
    var info = $('fxProfileInfo');
    if (info) info.textContent = '✓ profile ready';
    var applyBtn = $('fxApplyBtn');
    if (applyBtn) applyBtn.disabled = false;
  }

  function applyNoiseReduction() {
    if (!buffer || !noiseProfile || busy) return;
    stopPlayback(true);
    busy = true;
    var strengthEl = $('fxp_strength');
    var strength = (strengthEl ? parseFloat(strengthEl.value) : 60) / 100;
    var beta = 1 + 2.5 * strength;
    var floorGain = 0.45 - 0.43 * strength;
    var bins = FRAME / 2 + 1;
    var out = ctx().createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    var re = new Float32Array(FRAME), im = new Float32Array(FRAME);
    var prevGain = new Float32Array(bins);
    var gains = new Float32Array(bins);
    var norm = new Float32Array(buffer.length);
    var c = 0, pos = 0;
    var totalWork = buffer.numberOfChannels * buffer.length;

    function chunk() {
      var deadline = Date.now() + 40;
      var data = buffer.getChannelData(c);
      var dst = out.getChannelData(c);
      var prof = noiseProfile[Math.min(c, noiseProfile.length - 1)];
      while (Date.now() < deadline) {
        if (pos >= data.length) {
          for (var n = 0; n < dst.length; n++) if (norm[n] > 1e-6) dst[n] /= norm[n];
          c++; pos = 0; prevGain.fill(0); norm.fill(0);
          if (c >= buffer.numberOfChannels) { finish(); return; }
          data = buffer.getChannelData(c);
          dst = out.getChannelData(c);
          prof = noiseProfile[Math.min(c, noiseProfile.length - 1)];
        }
        var nIn = Math.min(FRAME, data.length - pos);
        for (var i = 0; i < FRAME; i++) {
          re[i] = i < nIn ? data[pos + i] * hann[i] : 0;
          im[i] = 0;
        }
        E.fft(re, im, false);
        for (var b = 0; b < bins; b++) {
          var mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
          var g = mag > 0 ? Math.max(floorGain, 1 - beta * prof[b] / mag) : floorGain;
          gains[b] = g > 1 ? 1 : g;
        }
        var prev = gains[0];
        for (var b2 = 1; b2 < bins - 1; b2++) {
          var sm = (prev + gains[b2] + gains[b2 + 1]) / 3;
          prev = gains[b2];
          sm = 0.4 * prevGain[b2] + 0.6 * sm;
          prevGain[b2] = sm;
          gains[b2] = sm;
        }
        for (var b3 = 0; b3 < bins; b3++) {
          var g2 = gains[b3];
          re[b3] *= g2; im[b3] *= g2;
          if (b3 > 0 && b3 < FRAME / 2) { re[FRAME - b3] *= g2; im[FRAME - b3] *= g2; }
        }
        E.fft(re, im, true);
        var lim = Math.min(FRAME, dst.length - pos);
        for (var o = 0; o < lim; o++) {
          dst[pos + o] += re[o] * hann[o];
          norm[pos + o] += hann[o] * hann[o];
        }
        pos += HOP;
      }
      status('Reducing noise… ' + Math.round((c * buffer.length + pos) / totalWork * 100) + '%');
      setTimeout(chunk, 0);
    }
    function finish() {
      busy = false;
      setBuffer(out, 'Noise reduction applied');
    }
    status('Reducing noise… 0%');
    chunk();
  }

  // ---------------- file I/O ----------------
  function loadDecoded(buf, name) {
    stopPlayback(false);
    buffer = buf;
    fileName = name || 'untitled.wav';
    undoStack.length = 0;
    redoStack.length = 0;
    sel = null;
    cursor = 0;
    noiseProfile = null;
    fit();
    $('edEmpty').style.display = 'none';
    $('edFileName').textContent = fileName;
    $('edFileMeta').textContent = fmtTime(buf.duration, true) + ' · ' + buf.sampleRate + ' Hz · ' + buf.numberOfChannels + ' ch';
    document.title = fileName + ' — Audio Editor | MyFreeAudioTool';
    status('Loaded. Drag on the waveform to select, Space to play.', 'success');
    cacheDirty = true;
    requestDraw();
    updateUI();
    updateTime();
    renderFxPanel();
  }

  function openFile(file) {
    if (undoStack.length && !window.confirm('Load "' + file.name + '"? Unsaved edits to the current session will be lost.')) return;
    status('Decoding ' + file.name + '…');
    E.decodeFile(file).then(function (buf) {
      loadDecoded(buf, file.name);
    }).catch(function (err) {
      status(E.humanError(err), 'error');
    });
  }

  // demo clip so the editor is instantly try-able
  function loadDemo() {
    var rate = 44100, secs = 8;
    var off = new OfflineAudioContext(2, rate * secs, rate);
    var master = off.createGain();
    master.gain.value = 0.8;
    master.connect(off.destination);
    var notes = [220, 277.18, 329.63, 440, 329.63, 277.18, 220, 164.81];
    notes.forEach(function (f, i) {
      var t = i * 0.9 + 0.1;
      var osc = off.createOscillator();
      osc.type = i % 2 ? 'triangle' : 'sine';
      osc.frequency.value = f;
      var g = off.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
      var pan = off.createStereoPanner();
      pan.pan.value = (i % 2 ? -0.4 : 0.4);
      osc.connect(g); g.connect(pan); pan.connect(master);
      osc.start(t); osc.stop(t + 0.9);
    });
    // soft noise hits as percussion
    var noiseBuf = off.createBuffer(1, rate * 0.08, rate);
    var nd = noiseBuf.getChannelData(0);
    for (var i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nd.length, 2);
    for (var b = 0; b < 16; b++) {
      var src = off.createBufferSource();
      src.buffer = noiseBuf;
      var g2 = off.createGain();
      g2.gain.value = b % 4 === 0 ? 0.5 : 0.18;
      src.connect(g2); g2.connect(master);
      src.start(0.1 + b * 0.45);
    }
    off.startRendering().then(function (buf) { loadDecoded(buf, 'demo-clip.wav'); });
  }

  function exportAs(kind) {
    if (!buffer || busy) return;
    stopPlayback(true);
    var base = (fileName.replace(/\.[^.]+$/, '') || 'audio') + '-edited';
    if (kind === 'wav') {
      status('Encoding WAV…');
      setTimeout(function () {
        var blob = E.encodeWav(buffer);
        E.downloadBlob(blob, base + '.wav');
        status('✓ WAV saved (' + E.formatBytes(blob.size) + ').', 'success');
      }, 30);
    } else {
      status('Encoding MP3… 0%');
      E.encodeMp3(buffer, 192, function (p) {
        status('Encoding MP3… ' + Math.round(p * 100) + '%');
      }).then(function (blob) {
        E.downloadBlob(blob, base + '.mp3');
        status('✓ MP3 saved (' + E.formatBytes(blob.size) + ').', 'success');
      }).catch(function (err) {
        status(E.humanError(err), 'error');
      });
    }
  }

  // ---------------- UI wiring ----------------
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';

  function updateUI() {
    var has = !!buffer;
    var hasSel = !!sel;
    ['playBtn', 'stopBtn', 'loopBtn', 'zoomInBtn', 'zoomOutBtn', 'fitBtn', 'normBtn', 'revBtn', 'exportWavBtn', 'exportMp3Btn']
      .forEach(function (id) { $(id).disabled = !has; });
    ['cutBtn', 'copyBtn', 'delBtn', 'cropBtn', 'silBtn', 'fadeInBtn', 'fadeOutBtn']
      .forEach(function (id) { $(id).disabled = !hasSel; });
    $('pasteBtn').disabled = !has || !clipboard;
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }

  $('openBtn').addEventListener('click', function () { $('edFileInput').click(); });
  $('edFileInput').addEventListener('change', function () {
    if (this.files.length) openFile(this.files[0]);
    this.value = '';
  });
  $('demoBtn').addEventListener('click', loadDemo);
  $('edEmpty').addEventListener('click', function (e) {
    if (e.target.id !== 'demoBtn') $('edFileInput').click();
  });
  ['dragenter', 'dragover'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      e.preventDefault();
      $('edEmpty').classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      e.preventDefault();
      if (evt === 'drop' || e.target === document.documentElement) $('edEmpty').classList.remove('dragover');
    });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) openFile(files[0]);
  });

  $('playBtn').addEventListener('click', togglePlay);
  $('stopBtn').addEventListener('click', function () { stopPlayback(false); cursor = sel ? sel.a : 0; requestDraw(); updateTime(); });
  $('loopBtn').addEventListener('click', function () {
    loopOn = !loopOn;
    this.classList.toggle('ebtn--on', loopOn);
    if (playing) { stopPlayback(true); play(); }
  });
  $('undoBtn').addEventListener('click', doUndo);
  $('redoBtn').addEventListener('click', doRedo);
  $('cutBtn').addEventListener('click', doCut);
  $('copyBtn').addEventListener('click', doCopy);
  $('pasteBtn').addEventListener('click', doPaste);
  $('delBtn').addEventListener('click', doDelete);
  $('cropBtn').addEventListener('click', doCrop);
  $('silBtn').addEventListener('click', doSilence);
  $('fadeInBtn').addEventListener('click', function () { doFade('in'); });
  $('fadeOutBtn').addEventListener('click', function () { doFade('out'); });
  $('normBtn').addEventListener('click', doNormalize);
  $('revBtn').addEventListener('click', doReverse);
  $('zoomInBtn').addEventListener('click', function () { zoomAt(sel ? (sel.a + sel.b) / 2 : cursor, 0.5); });
  $('zoomOutBtn').addEventListener('click', function () { zoomAt(sel ? (sel.a + sel.b) / 2 : cursor, 2); });
  $('fitBtn').addEventListener('click', fit);
  $('exportWavBtn').addEventListener('click', function () { exportAs('wav'); });
  $('exportMp3Btn').addEventListener('click', function () { exportAs('mp3'); });

  document.querySelectorAll('.fx-list button').forEach(function (b) {
    b.addEventListener('click', function () {
      stopFxPreview();
      currentFx = b.dataset.fx;
      renderFxPanel();
    });
  });

  // ---------------- keyboard ----------------
  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || e.key === 'Z')) { e.preventDefault(); doRedo(); }
    else if (mod && e.key === 'c') { e.preventDefault(); doCopy(); }
    else if (mod && e.key === 'x') { e.preventDefault(); doCut(); }
    else if (mod && e.key === 'v') { e.preventDefault(); doPaste(); }
    else if (mod && e.key === 'a') { e.preventDefault(); if (buffer) { sel = { a: 0, b: dur() }; requestDraw(); updateTime(); updateUI(); } }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(); }
    else if (e.key === 'Escape') { sel = null; requestDraw(); updateTime(); updateUI(); }
    else if (e.key === '+' || e.key === '=') { zoomAt(cursor, 0.5); }
    else if (e.key === '-') { zoomAt(cursor, 2); }
    else if (e.key === '0') { fit(); }
    else if (e.key === 'Home') { cursor = 0; requestDraw(); updateTime(); }
    else if (e.key === 'End') { cursor = dur(); requestDraw(); updateTime(); }
    else if (e.key === 'l' || e.key === 'L') { $('loopBtn').click(); }
  });

  window.addEventListener('beforeunload', function (e) {
    if (undoStack.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------- handoff from tool pages ----------------
  if (E.readEditorHandoff) {
    E.readEditorHandoff().then(function (h) {
      if (!h || !h.blob) return;
      status('Loading audio from the tool page…');
      var f = new File([h.blob], h.name || 'from-tool.wav', { type: h.blob.type || 'audio/wav' });
      openFile(f);
    }).catch(function () { /* nothing waiting — normal load */ });
  }

  updateUI();
  updateTime();
  requestDraw();
})();
