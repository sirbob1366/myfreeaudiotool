/* MyFreeAudioTool — multitrack Audio Studio.
   Tracks → clips on a shared timeline. Drag clips by their header strip,
   drag lane bodies to select, split at the cursor, per-track mute/solo/
   volume/pan, mic recording straight to a track, FX rack on the active
   clip, structural undo/redo (buffer-sharing snapshots), minimap
   navigation and WAV/MP3 mixdown. 100% client-side. */
(function () {
  'use strict';
  var E = window.AudioEngine;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- state ----------------
  var tracks = [];            // {id,name,color,gain,pan,muted,solo,clips:[{id,buffer,start}]}
  var nextId = 1;
  var activeTrackId = null, activeClipId = null;
  var view = { start: 0, end: 10 };
  var sel = null;             // {a,b} timeline seconds
  var cursor = 0;
  var loopOn = false;
  var clipboard = null;       // AudioBuffer
  var undoStack = [], redoStack = [];
  var playing = null;         // {sources:[], trackNodes:Map, startedAt, startPos, raf}
  var busy = false;
  var recorder = null;        // {mr, chunks, startCursor, timer}
  function headW() {          // track header width (responsive via --headw)
    var h = document.querySelector('.track__head');
    return h ? h.getBoundingClientRect().width : 172;
  }

  var COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#34d399', '#fb7185', '#f472b6', '#22d3ee'];

  // ---------------- utils ----------------
  function ctx() { return E.getAudioContext(); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function span() { return view.end - view.start; }
  function clipEnd(c) { return c.start + c.buffer.duration; }
  function projectEnd() {
    var end = 0;
    tracks.forEach(function (t) {
      t.clips.forEach(function (c) { end = Math.max(end, clipEnd(c)); });
    });
    return end;
  }
  function track(id) { for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i]; return null; }
  function activeTrack() { return track(activeTrackId); }
  function activeClip() {
    var t = activeTrack();
    if (!t) return null;
    for (var i = 0; i < t.clips.length; i++) if (t.clips[i].id === activeClipId) return t.clips[i];
    return null;
  }
  function clipAt(t, sec) {
    if (!t) return null;
    for (var i = 0; i < t.clips.length; i++) {
      if (sec >= t.clips[i].start - 1e-6 && sec <= clipEnd(t.clips[i]) + 1e-6) return t.clips[i];
    }
    return null;
  }

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

  // ---------------- history (structure snapshots share buffers) ----------------
  function snapshot() {
    return {
      tracks: tracks.map(function (t) {
        return {
          id: t.id, name: t.name, color: t.color, gain: t.gain, pan: t.pan,
          muted: t.muted, solo: t.solo,
          clips: t.clips.map(function (c) { return { id: c.id, buffer: c.buffer, start: c.start }; })
        };
      }),
      activeTrackId: activeTrackId, activeClipId: activeClipId
    };
  }
  function restore(s) {
    tracks = s.tracks.map(function (t) {
      return {
        id: t.id, name: t.name, color: t.color, gain: t.gain, pan: t.pan,
        muted: t.muted, solo: t.solo,
        clips: t.clips.map(function (c) { return { id: c.id, buffer: c.buffer, start: c.start }; })
      };
    });
    activeTrackId = s.activeTrackId;
    activeClipId = s.activeClipId;
    if (!track(activeTrackId) && tracks.length) activeTrackId = tracks[0].id;
  }
  function pushHistory(snap) {
    undoStack.push(snap || snapshot());
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  }
  function doUndo() {
    if (!undoStack.length) return;
    stopPlayback(false);
    redoStack.push(snapshot());
    restore(undoStack.pop());
    afterStructureChange('Undo.');
  }
  function doRedo() {
    if (!redoStack.length) return;
    stopPlayback(false);
    undoStack.push(snapshot());
    restore(redoStack.pop());
    afterStructureChange('Redo.');
  }
  function afterStructureChange(msg, kind) {
    sel = sel && projectEnd() > 0 ? { a: clamp(sel.a, 0, projectEnd()), b: clamp(sel.b, 0, projectEnd()) } : null;
    if (sel && sel.b - sel.a < 0.001) sel = null;
    cursor = clamp(cursor, 0, Math.max(projectEnd(), 0));
    rebuildTracks();
    redrawAll();
    updateUI();
    updateTime();
    if (msg) status(msg, kind);
  }

  // ---------------- track / clip management ----------------
  function addTrack(buffer, name, startSec) {
    var t = {
      id: nextId++,
      name: name || ('Track ' + (tracks.length + 1)),
      color: COLORS[(tracks.length) % COLORS.length],
      gain: 1, pan: 0, muted: false, solo: false,
      clips: []
    };
    if (buffer) t.clips.push({ id: nextId++, buffer: buffer, start: startSec || 0 });
    tracks.push(t);
    activeTrackId = t.id;
    activeClipId = t.clips.length ? t.clips[0].id : null;
    return t;
  }

  // ---------------- DOM: track rows ----------------
  function rebuildTracks() {
    var list = $('tracksList');
    list.innerHTML = '';
    tracks.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'track' + (t.id === activeTrackId ? ' track--active' : '');
      row.dataset.trackId = t.id;
      row.innerHTML =
        '<div class="track__head" style="--tc:' + t.color + '">' +
        '<div class="track__row1">' +
        '<span class="track__color"></span>' +
        '<input class="track__name" value="' + t.name.replace(/"/g, '&quot;') + '" aria-label="Track name" spellcheck="false">' +
        '<button class="track__btn track__del" data-act="del" title="Delete track">✕</button>' +
        '</div>' +
        '<div class="track__row2">' +
        '<button class="track__btn' + (t.muted ? ' on' : '') + '" data-act="mute" title="Mute">M</button>' +
        '<button class="track__btn' + (t.solo ? ' on-solo' : '') + '" data-act="solo" title="Solo">S</button>' +
        '<input type="range" class="track__vol" data-act="vol" min="0" max="1.5" step="0.01" value="' + t.gain + '" title="Track volume" aria-label="Track volume">' +
        '<input type="range" class="track__pan" data-act="pan" min="-1" max="1" step="0.02" value="' + t.pan + '" title="Pan (double-click to center)" aria-label="Track pan">' +
        '</div>' +
        '</div>' +
        '<div class="track__lanewrap"><canvas class="track__lane" height="10"></canvas></div>';
      list.appendChild(row);
      wireTrackRow(row, t);
    });
    $('edEmpty').style.display = tracks.length ? 'none' : '';
    positionOverlays();
  }

  function wireTrackRow(row, t) {
    var lane = row.querySelector('.track__lane');
    wireLane(lane, t);
    row.querySelector('.track__name').addEventListener('change', function () {
      t.name = this.value || t.name;
    });
    row.querySelector('.track__name').addEventListener('keydown', function (e) { e.stopPropagation(); });
    row.querySelectorAll('.track__btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var act = btn.dataset.act;
        if (act === 'mute') { t.muted = !t.muted; btn.classList.toggle('on', t.muted); applyLiveMix(); }
        else if (act === 'solo') { t.solo = !t.solo; btn.classList.toggle('on-solo', t.solo); applyLiveMix(); }
        else if (act === 'del') {
          if (t.clips.length && !window.confirm('Delete "' + t.name + '" and its audio?')) return;
          pushHistory();
          tracks = tracks.filter(function (x) { return x.id !== t.id; });
          if (activeTrackId === t.id) {
            activeTrackId = tracks.length ? tracks[0].id : null;
            activeClipId = null;
          }
          stopPlayback(false);
          afterStructureChange('Track deleted.');
        }
      });
    });
    var vol = row.querySelector('.track__vol');
    vol.addEventListener('input', function () { t.gain = parseFloat(this.value); applyLiveMix(); });
    var pan = row.querySelector('.track__pan');
    pan.addEventListener('input', function () { t.pan = parseFloat(this.value); applyLiveMix(); });
    pan.addEventListener('dblclick', function () { this.value = 0; t.pan = 0; applyLiveMix(); });
    row.querySelector('.track__head').addEventListener('pointerdown', function () {
      if (activeTrackId !== t.id) {
        activeTrackId = t.id;
        activeClipId = null;
        rebuildTracks();
        redrawAll();
        updateUI();
      }
    });
  }

  // ---------------- geometry ----------------
  function laneWidth() {
    var lane = document.querySelector('.track__lane');
    return lane ? lane.getBoundingClientRect().width : Math.max(100, $('tracksWrap').getBoundingClientRect().width - headW());
  }
  function secToX(sec) { return (sec - view.start) / span() * laneWidth(); }
  function xToSec(x) { return clamp(view.start + (x / laneWidth()) * span(), 0, Math.max(projectEnd() + 60, 60)); }

  // ---------------- drawing ----------------
  function css(name, fb) {
    var v = getComputedStyle($('editorApp')).getPropertyValue(name).trim();
    return v || fb;
  }
  function hexA(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function drawLane(t) {
    var row = document.querySelector('.track[data-track-id="' + t.id + '"]');
    if (!row) return;
    var canvas = row.querySelector('.track__lane');
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    var W = Math.max(1, Math.round(r.width * dpr));
    var H = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = r.width, h = r.height;
    g.clearRect(0, 0, w, h);

    // faint beat grid
    g.strokeStyle = 'rgba(148,163,184,0.07)';
    g.lineWidth = 1;
    var step = gridStep();
    for (var gt = Math.ceil(view.start / step) * step; gt <= view.end; gt += step) {
      var gx = secToX(gt);
      g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, h); g.stroke();
    }

    t.clips.forEach(function (c) {
      var x0 = secToX(c.start), x1 = secToX(clipEnd(c));
      if (x1 < -20 || x0 > w + 20) return;
      var cw = Math.max(2, x1 - x0);
      var isActive = c.id === activeClipId && t.id === activeTrackId;

      // clip card
      g.fillStyle = hexA(t.color, isActive ? 0.16 : 0.10);
      g.strokeStyle = hexA(t.color, isActive ? 0.95 : 0.45);
      g.lineWidth = isActive ? 1.6 : 1;
      roundRect(g, x0 + 0.5, 3, cw - 1, h - 6, 8);
      g.fill();
      g.stroke();
      // header strip (drag handle)
      g.fillStyle = hexA(t.color, isActive ? 0.85 : 0.5);
      roundRectTop(g, x0 + 0.5, 3, cw - 1, 14, 8);
      g.fill();
      // grip dots
      if (cw > 36) {
        g.fillStyle = 'rgba(7,7,11,0.55)';
        for (var d = 0; d < 3; d++) g.fillRect(x0 + cw / 2 - 7 + d * 6, 9, 2.5, 2.5);
      }

      // waveform with vertical gradient
      var data = c.buffer.getChannelData(0);
      var data2 = c.buffer.numberOfChannels > 1 ? c.buffer.getChannelData(1) : null;
      var rate = c.buffer.sampleRate;
      var mid = 3 + 14 + (h - 6 - 14) / 2;
      var amp = (h - 6 - 14) / 2 - 2;
      var grad = g.createLinearGradient(0, mid - amp, 0, mid + amp);
      grad.addColorStop(0, hexA(t.color, 0.95));
      grad.addColorStop(0.5, hexA(t.color, 0.6));
      grad.addColorStop(1, hexA(t.color, 0.95));
      g.fillStyle = grad;
      var px0 = Math.max(0, Math.floor(x0)), px1 = Math.min(w, Math.ceil(x1));
      var sppx = span() * rate / r.width;
      var stride = Math.max(1, Math.floor(sppx / 70));
      for (var x = px0; x < px1; x++) {
        var f0 = Math.floor((view.start + x / r.width * span() - c.start) * rate);
        var f1 = Math.max(f0 + 1, f0 + Math.floor(sppx));
        if (f1 <= 0 || f0 >= data.length) continue;
        f0 = Math.max(0, f0); f1 = Math.min(data.length, f1);
        var max = 0;
        for (var i = f0; i < f1; i += stride) {
          var v = Math.abs(data[i]);
          if (data2) { var v2 = Math.abs(data2[i]); if (v2 > v) v = v2; }
          if (v > max) max = v;
        }
        var hh = Math.max(max * amp, 0.6);
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
    });

    // selection veil on the active track
    if (sel && t.id === activeTrackId) {
      var sx0 = secToX(sel.a), sx1 = secToX(sel.b);
      g.fillStyle = 'rgba(56,189,248,0.13)';
      g.fillRect(sx0, 0, sx1 - sx0, h);
      g.fillStyle = 'rgba(56,189,248,0.9)';
      g.fillRect(sx0 - 1, 0, 2, h);
      g.fillRect(sx1 - 1, 0, 2, h);
    }
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function roundRectTop(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    g.beginPath();
    g.moveTo(x, y + h);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h);
    g.closePath();
  }

  function gridStep() {
    var steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    var minPx = 60;
    for (var i = 0; i < steps.length; i++) if (steps[i] / span() * laneWidth() >= minPx) return steps[i];
    return 600;
  }

  function drawRuler() {
    var canvas = $('edRuler');
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    g.font = '9px ui-monospace, monospace';
    g.fillStyle = 'rgba(148,163,184,0.75)';
    g.strokeStyle = 'rgba(148,163,184,0.3)';
    var step = gridStep();
    for (var t = Math.ceil(view.start / step) * step; t <= view.end; t += step) {
      var x = secToX(t);
      g.beginPath(); g.moveTo(x, r.height - 7); g.lineTo(x, r.height); g.stroke();
      g.fillText(fmtTime(t, step < 1), x + 3, r.height - 9);
    }
  }

  function drawMinimap() {
    var canvas = $('edMinimap');
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    var total = Math.max(projectEnd(), view.end, 1);
    var laneH = Math.max(2, (r.height - 4) / Math.max(tracks.length, 1));
    tracks.forEach(function (t, ti) {
      g.fillStyle = hexA(t.color, 0.65);
      t.clips.forEach(function (c) {
        var x0 = c.start / total * r.width;
        var cw = Math.max(1.5, c.buffer.duration / total * r.width);
        g.fillRect(x0, 2 + ti * laneH, cw, laneH - 1.5);
      });
    });
    // viewport window
    var vx0 = view.start / total * r.width;
    var vx1 = view.end / total * r.width;
    g.fillStyle = 'rgba(56,189,248,0.12)';
    g.fillRect(vx0, 0, vx1 - vx0, r.height);
    g.strokeStyle = 'rgba(56,189,248,0.8)';
    g.lineWidth = 1;
    g.strokeRect(vx0 + 0.5, 0.5, vx1 - vx0 - 1, r.height - 1);
  }

  function positionOverlays() {
    var wrapR = $('tracksWrap').getBoundingClientRect();
    var h = $('tracksList').getBoundingClientRect().height;
    ['playheadLine', 'cursorLine'].forEach(function (id) {
      $(id).style.height = h + 'px';
    });
    moveLine('cursorLine', cursor);
    moveLine('playheadLine', playing ? playPos() : -1);
  }
  function moveLine(id, sec) {
    var el = $(id);
    if (sec < view.start || sec > view.end || sec < 0 || !tracks.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.transform = 'translateX(' + (headW() + secToX(sec)) + 'px)';
  }

  var drawQueued = false;
  function redrawAll() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () {
      drawQueued = false;
      tracks.forEach(drawLane);
      drawRuler();
      drawMinimap();
      positionOverlays();
    });
  }

  // ---------------- lane interaction ----------------
  function wireLane(lane, t) {
    var drag = null; // {mode, startX, startSec, clip, grabOffset, snapshot, moved}

    function hit(e) {
      var r = lane.getBoundingClientRect();
      var x = e.clientX - r.left;
      var y = e.clientY - r.top;
      var sec = xToSec(x);
      var c = clipAt(t, sec);
      return { x: x, y: y, sec: sec, clip: c, onHeader: c && y <= 18 };
    }

    lane.addEventListener('pointerdown', function (e) {
      lane.setPointerCapture(e.pointerId);
      var hv = hit(e);
      activeTrackId = t.id;
      if (hv.clip) activeClipId = hv.clip.id;
      document.querySelectorAll('.track').forEach(function (row) {
        row.classList.toggle('track--active', row.dataset.trackId == String(t.id));
      });

      // selection edge grips (active track only)
      if (sel) {
        var ax = secToX(sel.a), bx = secToX(sel.b);
        if (Math.abs(hv.x - ax) < 8) { drag = { mode: 'edgeA', snapshotSel: true }; e.preventDefault(); return; }
        if (Math.abs(hv.x - bx) < 8) { drag = { mode: 'edgeB' }; e.preventDefault(); return; }
      }
      if (hv.onHeader && hv.clip) {
        drag = { mode: 'move', clip: hv.clip, grabOffset: hv.sec - hv.clip.start, snap: snapshot(), moved: false };
      } else {
        drag = { mode: 'select', startSec: hv.sec, startX: hv.x, moved: false };
      }
      e.preventDefault();
      updateUI();
      redrawAll();
    });

    lane.addEventListener('pointermove', function (e) {
      var hv = hit(e);
      if (!drag) {
        lane.style.cursor = (sel && (Math.abs(hv.x - secToX(sel.a)) < 8 || Math.abs(hv.x - secToX(sel.b)) < 8)) ? 'ew-resize'
          : hv.onHeader ? 'grab' : 'text';
        return;
      }
      if (drag.mode === 'move') {
        drag.moved = true;
        var ns = Math.max(0, hv.sec - drag.grabOffset);
        // magnetic snap: 0, cursor, neighboring clip edges
        var cands = [0, cursor];
        t.clips.forEach(function (o) {
          if (o.id === drag.clip.id) return;
          cands.push(o.start, clipEnd(o));
          cands.push(o.start - drag.clip.buffer.duration, clipEnd(o) - drag.clip.buffer.duration);
        });
        var snapPx = 8 / laneWidth() * span();
        for (var i = 0; i < cands.length; i++) {
          if (cands[i] >= 0 && Math.abs(ns - cands[i]) < snapPx) { ns = cands[i]; break; }
        }
        drag.clip.start = ns;
        redrawAll();
        updateTime();
      } else if (drag.mode === 'select') {
        if (Math.abs(hv.x - drag.startX) > 3) drag.moved = true;
        if (drag.moved) {
          sel = { a: Math.min(drag.startSec, hv.sec), b: Math.max(drag.startSec, hv.sec) };
          redrawAll();
          updateTime();
          updateUI();
        }
      } else if (drag.mode === 'edgeA') {
        sel.a = Math.min(hv.sec, sel.b - 0.001);
        redrawAll(); updateTime();
      } else if (drag.mode === 'edgeB') {
        sel.b = Math.max(hv.sec, sel.a + 0.001);
        redrawAll(); updateTime();
      }
    });

    function up(e) {
      if (!drag) return;
      if (drag.mode === 'move' && drag.moved) {
        pushHistory(drag.snap);
        status('Clip moved to ' + fmtTime(drag.clip.start, true) + '.', 'success');
      } else if (drag.mode === 'select' && !drag.moved) {
        cursor = drag.startSec;
        sel = null;
        if (playing) { var was = true; stopPlayback(false); play(); }
        updateTime();
        updateUI();
        redrawAll();
      }
      drag = null;
    }
    lane.addEventListener('pointerup', up);
    lane.addEventListener('pointercancel', function () { drag = null; });
    lane.addEventListener('dblclick', function (e) {
      var hv = hit(e);
      if (hv.clip) {
        sel = { a: hv.clip.start, b: clipEnd(hv.clip) };
        activeClipId = hv.clip.id;
        redrawAll(); updateTime(); updateUI();
      }
    });
    lane.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = lane.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        panView((e.deltaX || e.deltaY) / r.width * span());
      } else {
        zoomAt(xToSec(e.clientX - r.left), Math.pow(1.25, e.deltaY / 100));
      }
    }, { passive: false });
  }

  // ruler: click to place cursor
  $('edRuler').addEventListener('pointerdown', function (e) {
    var r = this.getBoundingClientRect();
    cursor = xToSec(e.clientX - r.left);
    redrawAll(); updateTime();
  });

  // minimap: click / drag to navigate
  (function () {
    var mm = $('edMinimap');
    var dragging = false;
    function nav(e) {
      var r = mm.getBoundingClientRect();
      var total = Math.max(projectEnd(), view.end, 1);
      var t = (e.clientX - r.left) / r.width * total;
      var sp = span();
      view.start = clamp(t - sp / 2, 0, Math.max(0, total - sp));
      view.end = view.start + sp;
      redrawAll();
    }
    mm.addEventListener('pointerdown', function (e) { dragging = true; mm.setPointerCapture(e.pointerId); nav(e); });
    mm.addEventListener('pointermove', function (e) { if (dragging) nav(e); });
    mm.addEventListener('pointerup', function () { dragging = false; });
  })();

  // ---------------- zoom / pan ----------------
  function zoomAt(centerSec, factor) {
    var total = Math.max(projectEnd(), 1);
    var sp = clamp(span() * factor, 0.02, Math.max(total * 1.2, 10));
    var frac = (centerSec - view.start) / span();
    view.start = Math.max(0, centerSec - frac * sp);
    view.end = view.start + sp;
    redrawAll();
  }
  function panView(d) {
    var total = Math.max(projectEnd(), 1);
    view.start = clamp(view.start + d, 0, Math.max(0, total * 1.2 - span()));
    view.end = view.start + span();
    redrawAll();
  }
  function fit() {
    view.start = 0;
    view.end = Math.max(projectEnd() * 1.02, 1);
    redrawAll();
  }

  // ---------------- playback (multitrack mixdown graph) ----------------
  function audibleTracks() {
    var anySolo = tracks.some(function (t) { return t.solo; });
    return tracks.filter(function (t) { return anySolo ? t.solo : !t.muted; });
  }

  function buildMixGraph(c, startPos, liveNodes) {
    var master = c.createGain();
    master.connect(c.destination);
    var sources = [];
    audibleTracks().forEach(function (t) {
      var g = c.createGain();
      g.gain.value = t.gain;
      var p = c.createStereoPanner();
      p.pan.value = t.pan;
      g.connect(p);
      p.connect(master);
      if (liveNodes) liveNodes[t.id] = { gain: g, pan: p };
      t.clips.forEach(function (clip) {
        if (clipEnd(clip) <= startPos + 0.001) return;
        var src = c.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(g);
        var when = Math.max(0, clip.start - startPos);
        var offset = Math.max(0, startPos - clip.start);
        src.start((c.currentTime || 0) + when, offset);
        sources.push(src);
      });
    });
    return { sources: sources, master: master };
  }

  function applyLiveMix() {
    redrawAll();
    if (!playing) return;
    var anySolo = tracks.some(function (t) { return t.solo; });
    tracks.forEach(function (t) {
      var n = playing.trackNodes[t.id];
      if (!n) return; // track became audible mid-play → restart picks it up
      var audible = anySolo ? t.solo : !t.muted;
      n.gain.gain.setTargetAtTime(audible ? t.gain : 0, ctx().currentTime, 0.02);
      n.pan.pan.setTargetAtTime(t.pan, ctx().currentTime, 0.02);
    });
  }

  function playPos() {
    if (!playing) return cursor;
    return playing.startPos + (ctx().currentTime - playing.startedAt);
  }

  function stopPlayback(setCursor) {
    if (!playing) return;
    var pos = playPos();
    var p = playing;
    playing = null;
    cancelAnimationFrame(p.raf);
    p.sources.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) {} });
    try { p.master.disconnect(); } catch (e) {}
    if (setCursor) cursor = clamp(pos, 0, projectEnd());
    $('playBtn').classList.remove('is-playing');
    $('playBtn').innerHTML = ICON_PLAY;
    moveLine('playheadLine', -1);
    updateTime();
  }

  function play(fromSec) {
    if (!tracks.length) return;
    stopPlayback(false);
    var a = typeof fromSec === 'number' ? fromSec : (sel ? sel.a : cursor);
    var end = sel ? sel.b : projectEnd();
    if (a >= end - 0.005) a = sel ? sel.a : 0;
    var liveNodes = {};
    var built = buildMixGraph(ctx(), a, liveNodes);
    playing = { sources: built.sources, master: built.master, trackNodes: liveNodes, startedAt: ctx().currentTime, startPos: a, raf: 0 };
    $('playBtn').classList.add('is-playing');
    $('playBtn').innerHTML = ICON_PAUSE;
    (function tick() {
      if (!playing) return;
      var pos = playPos();
      if (pos >= end - 0.002) {
        if (loopOn) { play(sel ? sel.a : 0); return; }
        stopPlayback(false);
        return;
      }
      // follow the playhead when it walks off-screen
      if (pos > view.end) { panView(span() * 0.85); }
      moveLine('playheadLine', pos);
      updateTime();
      playing.raf = requestAnimationFrame(tick);
    })();
  }

  function togglePlay() {
    if (playing) stopPlayback(true);
    else play();
  }

  function updateTime() {
    $('edTime').innerHTML = fmtTime(playing ? playPos() : cursor, true) +
      ' <small>/ ' + fmtTime(projectEnd(), true) + '</small>';
    $('edSelInfo').textContent = sel
      ? 'sel ' + fmtTime(sel.a, true) + ' – ' + fmtTime(sel.b, true) + ' (' + fmtTime(sel.b - sel.a, true) + ')'
      : '';
  }

  // ---------------- clip-level editing ----------------
  // resolve selection ∩ active clip in clip-local seconds
  function clipRange() {
    var c = activeClip();
    if (!c) return null;
    var a = sel ? Math.max(sel.a, c.start) : c.start;
    var b = sel ? Math.min(sel.b, clipEnd(c)) : clipEnd(c);
    if (b - a < 0.001) return null;
    return { clip: c, a: a - c.start, b: b - c.start };
  }
  function needRange() {
    var r = clipRange();
    if (!r) status(sel ? 'The selection doesn\'t touch the active clip — click a clip first.' : 'Click a clip first (or drag a selection on it).', 'error');
    return r;
  }
  function replaceClip(t, oldClip, newClips) {
    var idx = t.clips.indexOf(oldClip);
    var args = [idx, 1].concat(newClips);
    Array.prototype.splice.apply(t.clips, args);
    if (newClips.length) activeClipId = newClips[0].id;
  }

  function doSplit() {
    var t = activeTrack();
    var c = clipAt(t, cursor);
    if (!c) { status('Place the cursor over a clip on the active track to split it.', 'error'); return; }
    var local = cursor - c.start;
    if (local < 0.01 || local > c.buffer.duration - 0.01) { status('Cursor is at the very edge — nothing to split.', 'error'); return; }
    pushHistory();
    var left = { id: nextId++, buffer: E.sliceBuffer(c.buffer, 0, local), start: c.start };
    var right = { id: nextId++, buffer: E.sliceBuffer(c.buffer, local, c.buffer.duration), start: c.start + local };
    replaceClip(t, c, [left, right]);
    afterStructureChange('Split at ' + fmtTime(cursor, true) + '.', 'success');
  }

  function doCopy() {
    var r = needRange();
    if (!r) return;
    clipboard = E.sliceBuffer(r.clip.buffer, r.a, r.b);
    status('Copied ' + fmtTime(r.b - r.a, true) + '.', 'success');
    updateUI();
  }

  function doDelete() {
    var r = needRange();
    if (!r) return;
    stopPlayback(true);
    pushHistory();
    var t = activeTrack();
    var c = r.clip;
    var parts = [];
    if (r.a > 0.005) parts.push({ id: nextId++, buffer: E.sliceBuffer(c.buffer, 0, r.a), start: c.start });
    if (r.b < c.buffer.duration - 0.005) parts.push({ id: nextId++, buffer: E.sliceBuffer(c.buffer, r.b, c.buffer.duration), start: c.start + r.a });
    replaceClip(t, c, parts);
    cursor = c.start + r.a;
    sel = null;
    afterStructureChange('Deleted ' + fmtTime(r.b - r.a, true) + '.', 'success');
  }

  function doCut() {
    var r = clipRange();
    if (!r) { needRange(); return; }
    clipboard = E.sliceBuffer(r.clip.buffer, r.a, r.b);
    doDelete();
  }

  function doPaste() {
    if (!clipboard) return;
    stopPlayback(true);
    pushHistory();
    var t = activeTrack();
    if (!t) t = addTrack(null);
    var c = clipAt(t, cursor);
    if (c && cursor > c.start + 0.005 && cursor < clipEnd(c) - 0.005) {
      // insert inside the clip
      var local = cursor - c.start;
      var rate = c.buffer.sampleRate;
      var aF = Math.round(local * rate);
      var out = ctx().createBuffer(c.buffer.numberOfChannels, c.buffer.length + Math.round(clipboard.duration * rate), rate);
      for (var ch = 0; ch < out.numberOfChannels; ch++) {
        var d = out.getChannelData(ch);
        var s = c.buffer.getChannelData(ch);
        var ins = clipboard.getChannelData(Math.min(ch, clipboard.numberOfChannels - 1));
        d.set(s.subarray(0, aF), 0);
        d.set(ins, aF);
        d.set(s.subarray(aF), aF + ins.length);
      }
      var nc = { id: nextId++, buffer: out, start: c.start };
      replaceClip(t, c, [nc]);
    } else {
      var added = { id: nextId++, buffer: clipboard, start: cursor };
      t.clips.push(added);
      activeClipId = added.id;
    }
    afterStructureChange('Pasted ' + fmtTime(clipboard.duration, true) + '.', 'success');
  }

  function doCrop() {
    var r = needRange();
    if (!r) return;
    stopPlayback(true);
    pushHistory();
    var c = r.clip;
    var nc = { id: nextId++, buffer: E.sliceBuffer(c.buffer, r.a, r.b), start: c.start + r.a };
    replaceClip(activeTrack(), c, [nc]);
    sel = null;
    afterStructureChange('Cropped clip to selection.', 'success');
  }

  function regionEdit(label, fn) {
    var r = needRange();
    if (!r) return;
    stopPlayback(true);
    pushHistory();
    var c = r.clip;
    var buf = copyBuffer(c.buffer);
    var rate = buf.sampleRate;
    fn(buf, Math.round(r.a * rate), Math.round(r.b * rate));
    var nc = { id: nextId++, buffer: buf, start: c.start };
    replaceClip(activeTrack(), c, [nc]);
    afterStructureChange(label, 'success');
  }

  function doSilence() {
    regionEdit('Silenced region.', function (buf, a, b) {
      for (var ch = 0; ch < buf.numberOfChannels; ch++) buf.getChannelData(ch).fill(0, a, b);
    });
  }
  function doFade(dir) {
    regionEdit(dir === 'in' ? 'Fade in applied.' : 'Fade out applied.', function (buf, a, b) {
      var n = b - a;
      for (var ch = 0; ch < buf.numberOfChannels; ch++) {
        var d = buf.getChannelData(ch);
        for (var i = 0; i < n; i++) d[a + i] *= dir === 'in' ? i / n : 1 - i / n;
      }
    });
  }
  function doNormalize() {
    regionEdit('Normalized to −0.2 dBFS.', function (buf, a, b) {
      var peak = 0, ch, i, d;
      for (ch = 0; ch < buf.numberOfChannels; ch++) {
        d = buf.getChannelData(ch);
        for (i = a; i < b; i++) { var v = Math.abs(d[i]); if (v > peak) peak = v; }
      }
      if (peak < 1e-6) return;
      var gain = 0.98 / peak;
      for (ch = 0; ch < buf.numberOfChannels; ch++) {
        d = buf.getChannelData(ch);
        for (i = a; i < b; i++) d[i] *= gain;
      }
    });
  }
  function doReverse() {
    regionEdit('Reversed region.', function (buf, a, b) {
      for (var ch = 0; ch < buf.numberOfChannels; ch++) {
        var d = buf.getChannelData(ch);
        for (var i = a, j = b - 1; i < j; i++, j--) { var t2 = d[i]; d[i] = d[j]; d[j] = t2; }
      }
    });
  }

  // ---------------- FX rack ----------------
  function mixGains(mixPct) {
    var m = mixPct / 100;
    return { dry: Math.cos(m * Math.PI / 2), wet: Math.sin(m * Math.PI / 2) };
  }

  var FX = {
    gain: {
      name: 'Volume', note: 'Boost or cut the selected region. Track faders handle balance; this prints into the clip.',
      params: [{ id: 'db', label: 'Gain', unit: 'dB', min: -24, max: 24, step: 0.5, def: 6, decimals: 1, signed: true }],
      build: function (c, src, p) { var g = c.createGain(); g.gain.value = Math.pow(10, p.db / 20); src.connect(g); return g; }
    },
    bass: {
      name: 'Bass Boost', note: 'Studio low-shelf with a limiter so the boost never clips.',
      params: [
        { id: 'freq', label: 'Frequency', unit: 'Hz', min: 40, max: 250, step: 5, def: 110 },
        { id: 'boost', label: 'Boost', unit: 'dB', min: 0, max: 18, step: 0.5, def: 9, decimals: 1 }
      ],
      build: function (c, src, p) {
        var shelf = c.createBiquadFilter();
        shelf.type = 'lowshelf'; shelf.frequency.value = p.freq; shelf.gain.value = p.boost;
        var comp = c.createDynamicsCompressor();
        comp.threshold.value = -1; comp.knee.value = 0; comp.ratio.value = 20;
        comp.attack.value = 0.001; comp.release.value = 0.1;
        src.connect(shelf); shelf.connect(comp);
        return comp;
      }
    },
    reverb: {
      name: 'Reverb', note: 'Convolution reverb — the tail is kept, blending into whatever plays next.',
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
      name: 'Speed', note: 'True playback-rate change — pitch shifts with it, like tape.',
      params: [{ id: 'rate', label: 'Speed', unit: '×', min: 0.5, max: 2, step: 0.01, def: 0.85, decimals: 2 }],
      rate: function (p) { return p.rate; },
      build: function (c, src) { var g = c.createGain(); src.connect(g); return g; }
    },
    vocal: {
      name: 'Vocal Remover', note: 'Center-channel cancellation — needs a stereo clip; results vary by mix.',
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
      name: '8D Orbit', note: 'Auto-panner sweeping the clip around your head. Headphones!',
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
  var fxScope = 'sel';
  var fxPreview = null;
  var noiseProfile = null;
  var fxValues = {};

  $('fxParams').addEventListener('input', function (e) {
    if (e.target.id && e.target.id.indexOf('fxp_') === 0) {
      (fxValues[currentFx] = fxValues[currentFx] || {})[e.target.id.slice(4)] = parseFloat(e.target.value);
    }
  });
  $('fxParams').addEventListener('change', function (e) {
    if (fxPreview && e.target.id && e.target.id.indexOf('fxp_') === 0) {
      stopFxPreview();
      toggleFxPreview();
    }
  });

  function fxParams() {
    var fx = FX[currentFx];
    var out = {};
    var stored = fxValues[currentFx] || {};
    (fx.params || []).forEach(function (p) {
      var el = $('fxp_' + p.id);
      out[p.id] = el ? parseFloat(el.value) : (stored[p.id] !== undefined ? stored[p.id] : p.def);
    });
    return out;
  }

  function renderFxPanel() {
    var fx = FX[currentFx];
    var stored = fxValues[currentFx] || {};
    function val(p) { return stored[p.id] !== undefined ? stored[p.id] : p.def; }
    document.querySelectorAll('.fx-list button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.fx === currentFx);
    });
    var c = activeClip();
    var html = '<h3>' + fx.name + '</h3><p class="fx-note">' + (fx.note || '') + '</p>';
    if (currentFx === 'noisered') {
      var strength = stored.strength !== undefined ? stored.strength : 60;
      html +=
        '<p class="fx-note"><b>1.</b> Select a noise-only moment on the clip → <b>2.</b> Learn → <b>3.</b> Apply to the whole clip.</p>' +
        '<div class="fx-actions">' +
        '<button class="btn btn--ghost btn--sm" id="fxLearnBtn" type="button">Learn noise from selection</button>' +
        '<span class="editor-selinfo" id="fxProfileInfo">' + (noiseProfile ? '✓ profile ready' : 'no profile yet') + '</span>' +
        '</div>' +
        '<div class="knob-row" style="justify-content:flex-start">' +
        '<input type="range" id="fxp_strength" data-knob data-label="Strength" data-unit="%" data-default="60" min="0" max="100" step="1" value="' + strength + '">' +
        '</div>' +
        '<div class="fx-actions">' +
        '<button class="btn btn--primary btn--sm" id="fxApplyBtn" type="button"' + (noiseProfile && c ? '' : ' disabled') + '>Apply to clip</button>' +
        '</div>';
    } else {
      html += '<div class="knob-row" style="justify-content:flex-start">';
      fx.params.forEach(function (p) {
        html += '<input type="range" id="fxp_' + p.id + '" data-knob data-label="' + p.label + '" data-unit="' + p.unit + '"' +
          (p.signed ? ' data-signed' : '') +
          (p.decimals ? ' data-decimals="' + p.decimals + '"' : '') +
          ' data-default="' + p.def + '" min="' + p.min + '" max="' + p.max + '" step="' + p.step + '" value="' + val(p) + '">';
      });
      html += '</div>';
      var blocked = !c || (fx.stereoOnly && c.buffer.numberOfChannels < 2);
      html +=
        '<div class="fx-actions">' +
        '<div class="fx-scope" id="fxScope">' +
        '<button type="button" data-scope="sel"' + (sel ? '' : ' disabled') + '>Selection</button>' +
        '<button type="button" data-scope="clip">Whole clip</button>' +
        '</div>' +
        '<button class="btn btn--ghost btn--sm" id="fxPreviewBtn" type="button"' + (blocked ? ' disabled' : '') + '>▶ Preview</button>' +
        '<button class="btn btn--primary btn--sm" id="fxApplyBtn" type="button"' + (blocked ? ' disabled' : '') + '>Apply</button>' +
        (!c ? '<span class="editor-selinfo">click a clip first</span>'
          : (fx.stereoOnly && c.buffer.numberOfChannels < 2 ? '<span class="editor-selinfo" style="color:var(--err)">needs a stereo clip</span>' : '')) +
        '</div>';
    }
    $('fxParams').innerHTML = html;
    if (window.Controls) Controls.upgrade($('fxParams'));

    var scopeBtns = document.querySelectorAll('#fxScope button');
    function setScope(s) {
      fxScope = s;
      scopeBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.scope === s); });
    }
    if (scopeBtns.length) setScope(sel ? (fxScope === 'clip' ? 'clip' : 'sel') : 'clip');
    scopeBtns.forEach(function (b) {
      b.addEventListener('click', function () { setScope(b.dataset.scope); });
    });
    var prevBtn = $('fxPreviewBtn');
    if (prevBtn) prevBtn.addEventListener('click', toggleFxPreview);
    var applyBtn = $('fxApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', currentFx === 'noisered' ? applyNoiseReduction : applyFx);
    var learnBtn = $('fxLearnBtn');
    if (learnBtn) learnBtn.addEventListener('click', learnNoise);
  }

  function fxRange() { // clip-local {clip, a, b}
    var c = activeClip();
    if (!c) return null;
    if (fxScope === 'sel' && sel) {
      var a = Math.max(sel.a, c.start), b = Math.min(sel.b, clipEnd(c));
      if (b - a < 0.001) return null;
      return { clip: c, a: a - c.start, b: b - c.start };
    }
    return { clip: c, a: 0, b: c.buffer.duration };
  }

  function stopFxPreview() {
    if (!fxPreview) return;
    fxPreview.sources.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) {} });
    fxPreview = null;
    var b = $('fxPreviewBtn');
    if (b) b.textContent = '▶ Preview';
  }

  function toggleFxPreview() {
    if (fxPreview) { stopFxPreview(); return; }
    var r = fxRange();
    if (!r) return;
    stopPlayback(true);
    var fx = FX[currentFx];
    var p = fxParams();
    var src = ctx().createBufferSource();
    src.buffer = r.clip.buffer;
    if (fx.rate) src.playbackRate.value = fx.rate(p);
    var out = fx.build(ctx(), src, p);
    out.connect(ctx().destination);
    src.start(0, r.a, r.b - r.a);
    fxPreview = { sources: [src] };
    src.onended = function () { stopFxPreview(); };
    $('fxPreviewBtn').textContent = '⏸ Stop';
  }

  function applyFx() {
    var r = fxRange();
    if (!r || busy) return;
    var fx = FX[currentFx];
    if (fx.stereoOnly && r.clip.buffer.numberOfChannels < 2) return;
    stopFxPreview();
    stopPlayback(true);
    busy = true;
    status('Applying ' + fx.name + '…');
    var p = fxParams();
    var c = r.clip;
    var rate = c.buffer.sampleRate;
    var slice = E.sliceBuffer(c.buffer, r.a, r.b);
    var tailSec = fx.tail ? fx.tail(p) : 0;
    var rendered;
    if (fx.rate) {
      var spd = fx.rate(p);
      var frames = Math.max(1, Math.ceil(slice.duration / spd * rate));
      var off = new OfflineAudioContext(slice.numberOfChannels, frames, rate);
      var s2 = off.createBufferSource();
      s2.buffer = slice;
      s2.playbackRate.value = spd;
      fx.build(off, s2, p).connect(off.destination);
      s2.start(0);
      rendered = off.startRendering();
    } else {
      var outCh = currentFx === 'spatial' ? 2 : slice.numberOfChannels;
      rendered = E.renderBufferThrough(slice, function (off2, s3) { return fx.build(off2, s3, p); }, tailSec, outCh);
    }
    rendered.then(function (ren) {
      var peak = E.bufferPeak(ren);
      if (peak > 1) E.scaleBuffer(ren, 0.98 / peak);
      pushHistory();
      // stitch: [0,a) + rendered(with tail mixed over what followed) + (b,end)
      var chN = Math.max(c.buffer.numberOfChannels, ren.numberOfChannels);
      var aF = Math.round(r.a * rate), bF = Math.round(r.b * rate);
      var afterLen = c.buffer.length - bF;
      var mainLen = fx.rate ? ren.length : ren.length - Math.round(tailSec * rate);
      var total = Math.max(aF + ren.length, aF + mainLen + afterLen);
      var out = ctx().createBuffer(chN, Math.max(1, total), rate);
      for (var ch = 0; ch < chN; ch++) {
        var d = out.getChannelData(ch);
        var srcD = c.buffer.getChannelData(Math.min(ch, c.buffer.numberOfChannels - 1));
        var renD = ren.getChannelData(Math.min(ch, ren.numberOfChannels - 1));
        d.set(srcD.subarray(0, aF), 0);
        // lay the untouched after-region down first, then mix the rendered
        // audio (processed main + effect tail) on top
        d.set(srcD.subarray(bF), aF + mainLen);
        for (var i = 0; i < renD.length; i++) d[aF + i] += renD[i];
      }
      var peak2 = E.bufferPeak(out);
      if (peak2 > 1) E.scaleBuffer(out, 0.98 / peak2);
      var nc = { id: nextId++, buffer: out, start: c.start };
      replaceClip(activeTrack(), c, [nc]);
      busy = false;
      // keep the selection on the processed region for tweak → re-apply loops
      if (fxScope === 'sel' && sel) sel = { a: c.start + r.a, b: c.start + r.a + mainLen / rate };
      afterStructureChange(fx.name + ' applied.', 'success');
      renderFxPanel();
    }).catch(function (err) {
      busy = false;
      status(E.humanError(err), 'error');
    });
  }

  // ---------------- noise reduction ----------------
  var FRAME = 2048, HOP = 512;
  var hann = new Float32Array(FRAME);
  for (var hi = 0; hi < FRAME; hi++) hann[hi] = 0.5 * (1 - Math.cos(2 * Math.PI * hi / FRAME));

  function learnNoise() {
    var c = activeClip();
    if (!c || !sel) { status('Select a noise-only moment on the active clip first.', 'error'); return; }
    var a = Math.max(sel.a, c.start) - c.start, b = Math.min(sel.b, clipEnd(c)) - c.start;
    if (b - a < 0.15) { status('Select at least 0.15 s of noise-only audio on the clip.', 'error'); return; }
    var buf = c.buffer;
    var bins = FRAME / 2 + 1;
    noiseProfile = [];
    var re = new Float32Array(FRAME), im = new Float32Array(FRAME);
    for (var chn = 0; chn < buf.numberOfChannels; chn++) {
      var data = buf.getChannelData(chn);
      var s0 = clamp(Math.floor(a * buf.sampleRate), 0, Math.max(0, data.length - FRAME));
      var s1 = Math.min(data.length - FRAME, Math.floor(b * buf.sampleRate) - FRAME);
      var prof = new Float32Array(bins);
      var count = 0;
      for (var pos = s0; pos <= Math.max(s0, s1); pos += HOP) {
        for (var i = 0; i < FRAME; i++) { re[i] = data[pos + i] * hann[i]; im[i] = 0; }
        E.fft(re, im, false);
        for (var bb = 0; bb < bins; bb++) prof[bb] += Math.sqrt(re[bb] * re[bb] + im[bb] * im[bb]);
        count++;
      }
      if (count) for (var b2 = 0; b2 < bins; b2++) prof[b2] /= count;
      noiseProfile.push(prof);
    }
    status('✓ Noise profile learned.', 'success');
    var info = $('fxProfileInfo');
    if (info) info.textContent = '✓ profile ready';
    var applyBtn = $('fxApplyBtn');
    if (applyBtn) applyBtn.disabled = false;
  }

  function applyNoiseReduction() {
    var c = activeClip();
    if (!c || !noiseProfile || busy) return;
    stopPlayback(true);
    busy = true;
    var strengthEl = $('fxp_strength');
    var strength = (strengthEl ? parseFloat(strengthEl.value) : 60) / 100;
    var beta = 1 + 2.5 * strength;
    var floorGain = 0.45 - 0.43 * strength;
    var bins = FRAME / 2 + 1;
    var buf = c.buffer;
    var out = ctx().createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    var re = new Float32Array(FRAME), im = new Float32Array(FRAME);
    var prevGain = new Float32Array(bins);
    var gains = new Float32Array(bins);
    var norm = new Float32Array(buf.length);
    var chn = 0, pos = 0;
    var totalWork = buf.numberOfChannels * buf.length;

    function chunk() {
      var deadline = Date.now() + 40;
      var data = buf.getChannelData(chn);
      var dst = out.getChannelData(chn);
      var prof = noiseProfile[Math.min(chn, noiseProfile.length - 1)];
      while (Date.now() < deadline) {
        if (pos >= data.length) {
          for (var n = 0; n < dst.length; n++) if (norm[n] > 1e-6) dst[n] /= norm[n];
          chn++; pos = 0; prevGain.fill(0); norm.fill(0);
          if (chn >= buf.numberOfChannels) { finish(); return; }
          data = buf.getChannelData(chn);
          dst = out.getChannelData(chn);
          prof = noiseProfile[Math.min(chn, noiseProfile.length - 1)];
        }
        var nIn = Math.min(FRAME, data.length - pos);
        for (var i = 0; i < FRAME; i++) { re[i] = i < nIn ? data[pos + i] * hann[i] : 0; im[i] = 0; }
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
      status('Reducing noise… ' + Math.round((chn * buf.length + pos) / totalWork * 100) + '%');
      setTimeout(chunk, 0);
    }
    function finish() {
      busy = false;
      pushHistory();
      var nc = { id: nextId++, buffer: out, start: c.start };
      replaceClip(activeTrack(), c, [nc]);
      afterStructureChange('Noise reduction applied.', 'success');
    }
    status('Reducing noise… 0%');
    chunk();
  }

  // ---------------- recording ----------------
  function toggleRecord() {
    if (recorder) { stopRecord(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mr = new MediaRecorder(stream);
      var chunks = [];
      mr.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      mr.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        var f = new File([blob], 'recording.webm', { type: blob.type });
        status('Decoding recording…');
        E.decodeFile(f).then(function (buf) {
          pushHistory();
          var n = tracks.filter(function (x) { return /^Recording/.test(x.name); }).length;
          addTrack(buf, 'Recording' + (n ? ' ' + (n + 1) : ''), recAnchor);
          recorder = null;
          afterStructureChange('✓ Recording added as a new track.', 'success');
          fit();
        }).catch(function (err) {
          recorder = null;
          status(E.humanError(err), 'error');
          updateUI();
        });
      };
      var recAnchor = cursor;
      mr.start();
      recorder = { mr: mr, startCursor: recAnchor, t0: Date.now(), timer: 0 };
      recorder.timer = setInterval(function () {
        status('● Recording… ' + fmtTime((Date.now() - recorder.t0) / 1000, false) + ' — press Record again to stop.', 'error');
      }, 250);
      $('recBtn').classList.add('is-rec');
      play(recAnchor); // monitor the existing tracks while recording over them
    }).catch(function () {
      status('Microphone access was denied.', 'error');
    });
  }
  function stopRecord() {
    if (!recorder) return;
    clearInterval(recorder.timer);
    $('recBtn').classList.remove('is-rec');
    stopPlayback(false);
    try { recorder.mr.stop(); } catch (e) { recorder = null; }
  }

  // ---------------- file I/O ----------------
  function openFile(file) {
    status('Decoding ' + file.name + '…');
    E.decodeFile(file).then(function (buf) {
      pushHistory();
      var name = file.name.replace(/\.[^.]+$/, '');
      addTrack(buf, name.length > 22 ? name.slice(0, 22) + '…' : name, tracks.length ? cursor : 0);
      afterStructureChange('✓ ' + file.name + ' added as a track.', 'success');
      fit();
      renderFxPanel();
      $('edFileName').textContent = file.name;
      $('edFileMeta').textContent = fmtTime(buf.duration, true) + ' · ' + buf.sampleRate + ' Hz · ' + buf.numberOfChannels + ' ch';
    }).catch(function (err) {
      status(E.humanError(err), 'error');
    });
  }

  function loadDemo() {
    var rate = 44100, secs = 8;
    function render(build) {
      var off = new OfflineAudioContext(2, rate * secs, rate);
      build(off);
      return off.startRendering();
    }
    var melody = render(function (off) {
      var master = off.createGain(); master.gain.value = 0.7; master.connect(off.destination);
      [220, 277.18, 329.63, 440, 329.63, 277.18, 220, 164.81].forEach(function (f, i) {
        var t = i * 0.9 + 0.1;
        var osc = off.createOscillator();
        osc.type = i % 2 ? 'triangle' : 'sine';
        osc.frequency.value = f;
        var g = off.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.5, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
        var pan = off.createStereoPanner();
        pan.pan.value = i % 2 ? -0.3 : 0.3;
        osc.connect(g); g.connect(pan); pan.connect(master);
        osc.start(t); osc.stop(t + 0.9);
      });
    });
    var beat = render(function (off) {
      var master = off.createGain(); master.gain.value = 0.8; master.connect(off.destination);
      var noiseBuf = off.createBuffer(1, rate * 0.08, rate);
      var nd = noiseBuf.getChannelData(0);
      for (var i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nd.length, 2);
      for (var b = 0; b < 16; b++) {
        var src = off.createBufferSource();
        src.buffer = noiseBuf;
        var g2 = off.createGain();
        g2.gain.value = b % 4 === 0 ? 0.55 : 0.2;
        src.connect(g2); g2.connect(master);
        src.start(0.1 + b * 0.45);
      }
    });
    Promise.all([melody, beat]).then(function (bufs) {
      pushHistory();
      addTrack(bufs[0], 'Melody', 0);
      addTrack(bufs[1], 'Beat', 0);
      activeTrackId = tracks[tracks.length - 2].id;
      afterStructureChange('Demo project loaded — two tracks. Try dragging a clip by its colored strip.', 'success');
      fit();
      renderFxPanel();
    });
  }

  function exportAs(kind) {
    if (!tracks.length || busy) return;
    stopPlayback(true);
    var end = projectEnd();
    if (end <= 0) return;
    var rate = 44100;
    var off = new OfflineAudioContext(2, Math.ceil(end * rate), rate);
    buildMixGraph(off, 0, null);
    busy = true;
    status('Mixing down…');
    off.startRendering().then(function (mix) {
      var peak = E.bufferPeak(mix);
      if (peak > 1) E.scaleBuffer(mix, 0.98 / peak);
      if (kind === 'wav') {
        var blob = E.encodeWav(mix);
        E.downloadBlob(blob, 'mixdown.wav');
        busy = false;
        status('✓ WAV mixdown saved (' + E.formatBytes(blob.size) + ').', 'success');
      } else {
        status('Encoding MP3… 0%');
        return E.encodeMp3(mix, 192, function (p) {
          status('Encoding MP3… ' + Math.round(p * 100) + '%');
        }).then(function (blob) {
          E.downloadBlob(blob, 'mixdown.mp3');
          busy = false;
          status('✓ MP3 mixdown saved (' + E.formatBytes(blob.size) + ').', 'success');
        });
      }
    }).catch(function (err) {
      busy = false;
      status(E.humanError(err), 'error');
    });
  }

  // ---------------- toolbar / transport wiring ----------------
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

  function updateUI() {
    var has = !!tracks.length;
    var c = activeClip();
    var hasSel = !!sel;
    ['playBtn', 'stopBtn', 'loopBtn', 'zoomInBtn', 'zoomOutBtn', 'fitBtn', 'exportWavBtn', 'exportMp3Btn']
      .forEach(function (id) { $(id).disabled = !has; });
    ['cutBtn', 'copyBtn', 'delBtn', 'silBtn', 'fadeInBtn', 'fadeOutBtn'].forEach(function (id) {
      $(id).disabled = !(c && hasSel);
    });
    ['cropBtn', 'normBtn', 'revBtn'].forEach(function (id) { $(id).disabled = !c; });
    $('splitBtn').disabled = !(activeTrack() && clipAt(activeTrack(), cursor));
    $('pasteBtn').disabled = !clipboard;
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }

  $('openBtn').addEventListener('click', function () { $('edFileInput').click(); });
  $('edFileInput').addEventListener('change', function () {
    if (this.files.length) Array.prototype.forEach.call(this.files, openFile);
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
    if (files && files.length) Array.prototype.forEach.call(files, openFile);
  });

  $('playBtn').addEventListener('click', togglePlay);
  $('stopBtn').addEventListener('click', function () { stopPlayback(false); cursor = sel ? sel.a : 0; redrawAll(); updateTime(); });
  $('loopBtn').addEventListener('click', function () {
    loopOn = !loopOn;
    this.classList.toggle('ebtn--on', loopOn);
  });
  $('recBtn').addEventListener('click', toggleRecord);
  $('addTrackBtn').addEventListener('click', function () {
    pushHistory();
    addTrack(null);
    afterStructureChange('Empty track added — paste into it or drop a file.', 'success');
  });
  $('undoBtn').addEventListener('click', doUndo);
  $('redoBtn').addEventListener('click', doRedo);
  $('cutBtn').addEventListener('click', doCut);
  $('copyBtn').addEventListener('click', doCopy);
  $('pasteBtn').addEventListener('click', doPaste);
  $('delBtn').addEventListener('click', doDelete);
  $('splitBtn').addEventListener('click', doSplit);
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
    else if (mod && e.key === 'a') {
      e.preventDefault();
      var c = activeClip() || (activeTrack() && activeTrack().clips[0]);
      if (c) { activeClipId = c.id; sel = { a: c.start, b: clipEnd(c) }; redrawAll(); updateTime(); updateUI(); }
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(); }
    else if (e.key === 'Escape') { sel = null; redrawAll(); updateTime(); updateUI(); }
    else if (e.key === 's' || e.key === 'S') { doSplit(); }
    else if (e.key === '+' || e.key === '=') { zoomAt(cursor, 0.5); }
    else if (e.key === '-') { zoomAt(cursor, 2); }
    else if (e.key === '0') { fit(); }
    else if (e.key === 'Home') { e.preventDefault(); cursor = 0; redrawAll(); updateTime(); }
    else if (e.key === 'End') { e.preventDefault(); cursor = projectEnd(); redrawAll(); updateTime(); }
    else if (e.key === 'l' || e.key === 'L') { $('loopBtn').click(); }
    else if (e.key === 'r' || e.key === 'R') { toggleRecord(); }
  });

  window.addEventListener('resize', function () { redrawAll(); });
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
      openFile(new File([h.blob], h.name || 'from-tool.wav', { type: h.blob.type || 'audio/wav' }));
    }).catch(function () {});
  }

  rebuildTracks();
  renderFxPanel();
  updateUI();
  updateTime();
  redrawAll();
})();
