/* MyFreeAudioTool — shared skeleton for effect tool pages.
   Wires the standard page chrome (dropzone → waveform → live preview → WAV/MP3
   export) around two page-supplied hooks:

     FxPage({
       suffix:    '-reverb',                  // output filename suffix
       onLoad:    function (buffer, file) {}, // after decode (optional)
       buildLive: function (ctx, source) {},  // wire preview graph, return output node
       render:    function () {},             // -> Promise<AudioBuffer> for export
       rate:      function () { return 1; },  // playbackRate for preview + playhead math (optional)
       tweak:     function (buffer) {}        // post-render hook, e.g. clip check (optional)
     })

   Expects the standard element ids: dropzone, fileInput, editor, wave, status,
   progress, previewBtn, exportWavBtn, exportMp3Btn, newFileBtn, fileName, fileMeta. */
(function (global) {
  'use strict';

  global.FxPage = function (cfg) {
    var E = global.AudioEngine;
    var $ = function (id) { return document.getElementById(id); };

    var dropzone = $('dropzone'), fileInput = $('fileInput'), editor = $('editor');
    var canvas = $('wave'), statusEl = $('status'), progressEl = $('progress');
    var previewBtn = $('previewBtn');

    var state = { buffer: null, peaks: null, file: null, playing: null };

    function draw(playhead) {
      if (canvas && state.peaks) E.drawWaveform(canvas, state.peaks, { playhead: playhead });
    }

    function loadFile(file) {
      state.file = file;
      E.status(statusEl, 'Decoding audio…');
      E.progress(progressEl, 'indeterminate');
      E.decodeFile(file).then(function (buf) {
        state.buffer = buf;
        state.peaks = canvas ? E.computePeaks(buf, 2000) : null;
        if ($('fileName')) $('fileName').textContent = file.name;
        if ($('fileMeta')) {
          $('fileMeta').textContent = E.formatTime(buf.duration) + ' · ' + buf.sampleRate + ' Hz · ' +
            buf.numberOfChannels + ' ch · ' + E.formatBytes(file.size);
        }
        dropzone.style.display = 'none';
        editor.style.display = 'block';
        E.progress(progressEl, null);
        E.status(statusEl, '');
        draw();
        if (cfg.onLoad) cfg.onLoad(buf, file);
      }).catch(function (err) {
        E.progress(progressEl, null);
        E.status(statusEl, E.humanError(err), 'error');
      });
    }

    E.setupDropzone(dropzone, fileInput, function (files) { loadFile(files[0]); });

    // ---------- preview ----------
    function stopPreview() {
      if (!state.playing) return;
      try { state.playing.source.onended = null; state.playing.source.stop(); } catch (e) {}
      cancelAnimationFrame(state.playing.raf);
      if (cfg.teardownLive) cfg.teardownLive();
      state.playing = null;
      if (previewBtn) previewBtn.textContent = '▶ Preview';
      draw();
    }

    function startPreview(offsetSec) {
      var ctx = E.getAudioContext();
      var source = ctx.createBufferSource();
      source.buffer = state.buffer;
      var rate = cfg.rate ? cfg.rate() : 1;
      source.playbackRate.value = rate;
      var out = cfg.buildLive(ctx, source);
      if (out) out.connect(ctx.destination);
      var start = offsetSec || 0;
      source.start(0, start);
      var startedAt = ctx.currentTime;
      state.playing = { source: source, raf: 0, startSec: start, startedAt: startedAt };
      previewBtn.textContent = '⏸ Stop';
      source.onended = function () { stopPreview(); };
      var dur = state.buffer.duration;
      (function tick() {
        if (!state.playing) return;
        var pos = start + (ctx.currentTime - startedAt) * (cfg.rate ? cfg.rate() : rate);
        draw(Math.min(1, pos / dur));
        state.playing.raf = requestAnimationFrame(tick);
      })();
    }

    if (previewBtn) {
      previewBtn.addEventListener('click', function () {
        if (state.playing) { stopPreview(); return; }
        startPreview(0);
      });
    }

    // click-to-seek on the waveform
    if (canvas) {
      canvas.addEventListener('click', function (e) {
        if (!state.buffer) return;
        var rect = canvas.getBoundingClientRect();
        var f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        var wasPlaying = !!state.playing;
        stopPreview();
        if (wasPlaying) startPreview(f * state.buffer.duration);
        else draw(f);
      });
    }

    // restart preview so node-graph changes (not just AudioParams) are heard
    function restartIfPlaying() {
      if (!state.playing) return;
      var ctx = E.getAudioContext();
      var pos = state.playing.startSec + (ctx.currentTime - state.playing.startedAt) * (cfg.rate ? cfg.rate() : 1);
      stopPreview();
      startPreview(Math.min(pos, state.buffer.duration - 0.05));
    }

    // ---------- export ----------
    function doExport(kind) {
      stopPreview();
      E.status(statusEl, 'Processing…');
      E.progress(progressEl, 'indeterminate');
      cfg.render().then(function (rendered) {
        var peak = E.bufferPeak(rendered);
        var note = '';
        if (peak > 1) {
          E.scaleBuffer(rendered, 0.98 / peak);
          note = ' Output was normalized to prevent clipping.';
        }
        if (cfg.tweak) cfg.tweak(rendered);
        var base = E.baseName(state.file.name) + (cfg.suffix || '-processed');
        if (kind === 'wav') {
          var blob = E.encodeWav(rendered);
          E.downloadBlob(blob, base + '.wav');
          E.progress(progressEl, null);
          E.status(statusEl, '✓ WAV saved (' + E.formatBytes(blob.size) + ').' + note, 'success');
        } else {
          E.status(statusEl, 'Encoding MP3…');
          E.progress(progressEl, 0);
          return E.encodeMp3(rendered, 192, function (p) { E.progress(progressEl, p); }).then(function (blob) {
            E.downloadBlob(blob, base + '.mp3');
            E.progress(progressEl, null);
            E.status(statusEl, '✓ MP3 saved (' + E.formatBytes(blob.size) + ').' + note, 'success');
          });
        }
      }).catch(function (err) {
        E.progress(progressEl, null);
        E.status(statusEl, E.humanError(err), 'error');
      });
    }

    if ($('exportWavBtn')) $('exportWavBtn').addEventListener('click', function () { doExport('wav'); });
    if ($('exportMp3Btn')) $('exportMp3Btn').addEventListener('click', function () { doExport('mp3'); });

    // "Open in Editor": render the current effect, hand the result to /audio-editor/
    if ($('exportWavBtn') && E.sendToEditor && window.indexedDB) {
      var edBtn = document.createElement('button');
      edBtn.type = 'button';
      edBtn.className = 'btn btn--ghost';
      edBtn.textContent = 'Open in Editor →';
      edBtn.title = 'Continue working on the processed audio in the full Audio Editor';
      ($('exportMp3Btn') || $('exportWavBtn')).insertAdjacentElement('afterend', edBtn);
      edBtn.addEventListener('click', function () {
        stopPreview();
        E.status(statusEl, 'Processing for the editor…');
        E.progress(progressEl, 'indeterminate');
        cfg.render().then(function (rendered) {
          var peak = E.bufferPeak(rendered);
          if (peak > 1) E.scaleBuffer(rendered, 0.98 / peak);
          var blob = E.encodeWav(rendered);
          E.status(statusEl, 'Opening the editor…');
          return E.sendToEditor(blob, E.baseName(state.file.name) + (cfg.suffix || '') + '.wav');
        }).catch(function (err) {
          E.progress(progressEl, null);
          E.status(statusEl, E.humanError(err), 'error');
        });
      });
    }

    if ($('newFileBtn')) {
      $('newFileBtn').addEventListener('click', function () {
        stopPreview();
        editor.style.display = 'none';
        dropzone.style.display = '';
        E.status(statusEl, '');
      });
    }

    window.addEventListener('resize', function () { draw(); });

    return {
      get buffer() { return state.buffer; },
      get file() { return state.file; },
      get playing() { return !!state.playing; },
      stopPreview: stopPreview,
      restartIfPlaying: restartIfPlaying,
      draw: draw,
      status: function (msg, kind) { E.status(statusEl, msg, kind); }
    };
  };
})(window);
