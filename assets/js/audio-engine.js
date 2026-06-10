/* MyFreeAudioTool — shared audio engine
   All processing is 100% client-side. Files never leave the device. */
(function (global) {
  'use strict';

  var Engine = {};
  var _ctx = null;

  // ---------- AudioContext (iOS needs a user gesture before it can start) ----------
  Engine.getAudioContext = function () {
    if (!_ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      _ctx = new AC();
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  };

  // Unlock audio on first user gesture (iOS Safari)
  function unlock() {
    if (_ctx && _ctx.state === 'suspended') _ctx.resume();
  }
  ['touchstart', 'touchend', 'mousedown', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, unlock, { passive: true });
  });

  // ---------- File loading ----------
  Engine.decodeFile = function (file) {
    return file.arrayBuffer().then(function (buf) {
      var ctx = Engine.getAudioContext();
      return new Promise(function (resolve, reject) {
        // Callback form works on every browser incl. older Safari
        ctx.decodeAudioData(buf, resolve, function (e) {
          reject(e || new Error('Could not decode this audio file. The format may be unsupported.'));
        });
      });
    });
  };

  // ---------- Waveform peaks (downsample to ~N peaks so big files stay fast) ----------
  Engine.computePeaks = function (audioBuffer, count) {
    count = count || 2000;
    var length = audioBuffer.length;
    var block = Math.max(1, Math.floor(length / count));
    var peaks = new Float32Array(Math.ceil(length / block));
    var channels = [];
    for (var c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    for (var i = 0; i < peaks.length; i++) {
      var start = i * block;
      var end = Math.min(start + block, length);
      var max = 0;
      for (var ch = 0; ch < channels.length; ch++) {
        var data = channels[ch];
        // sample sparsely inside very large blocks for speed
        var step = block > 64 ? Math.floor(block / 64) : 1;
        for (var j = start; j < end; j += step) {
          var v = Math.abs(data[j]);
          if (v > max) max = v;
        }
      }
      peaks[i] = max;
    }
    return peaks;
  };

  // ---------- Waveform drawing ----------
  // opts: { selStart, selEnd } as fractions 0..1; { playhead } fraction; colors auto from CSS vars
  Engine.drawWaveform = function (canvas, peaks, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var styles = getComputedStyle(document.documentElement);
    var baseColor = styles.getPropertyValue('--wave-base').trim() || '#e4e4ea';
    var accent = styles.getPropertyValue('--accent').trim() || '#ff5c5c';

    var mid = h / 2;
    var n = peaks.length;
    var selStart = typeof opts.selStart === 'number' ? opts.selStart : null;
    var selEnd = typeof opts.selEnd === 'number' ? opts.selEnd : null;

    for (var i = 0; i < n; i++) {
      var x = (i / n) * w;
      var amp = Math.max(peaks[i] * (h / 2 - 2), 1);
      var frac = i / n;
      var inSel = selStart !== null && frac >= selStart && frac <= selEnd;
      g.fillStyle = (selStart === null || inSel) ? accent : baseColor;
      g.fillRect(x, mid - amp, Math.max(w / n - 0.5, 0.8), amp * 2);
    }

    // selection handles
    if (selStart !== null) {
      g.fillStyle = accent;
      [selStart, selEnd].forEach(function (f) {
        var hx = f * w;
        g.fillRect(hx - 1.5, 0, 3, h);
        g.beginPath();
        g.arc(hx, mid > 14 ? 10 : mid, 7, 0, Math.PI * 2);
        g.fill();
      });
      g.fillStyle = 'rgba(255,92,92,0.08)';
      g.fillRect(selStart * w, 0, (selEnd - selStart) * w, h);
    }

    // playhead
    if (typeof opts.playhead === 'number' && opts.playhead >= 0) {
      g.fillStyle = styles.getPropertyValue('--text').trim() || '#0d0d0f';
      g.fillRect(opts.playhead * w - 1, 0, 2, h);
    }
  };

  // ---------- Buffer utilities ----------
  Engine.sliceBuffer = function (buffer, startSec, endSec) {
    var ctx = Engine.getAudioContext();
    var rate = buffer.sampleRate;
    var start = Math.max(0, Math.floor(startSec * rate));
    var end = Math.min(buffer.length, Math.ceil(endSec * rate));
    var frames = Math.max(1, end - start);
    var out = ctx.createBuffer(buffer.numberOfChannels, frames, rate);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var src = buffer.getChannelData(c).subarray(start, end);
      out.getChannelData(c).set(src);
    }
    return out;
  };

  Engine.resampleBuffer = function (buffer, targetRate, targetChannels) {
    targetChannels = targetChannels || buffer.numberOfChannels;
    if (buffer.sampleRate === targetRate && buffer.numberOfChannels === targetChannels) {
      return Promise.resolve(buffer);
    }
    var frames = Math.ceil(buffer.duration * targetRate);
    var off = new OfflineAudioContext(targetChannels, frames, targetRate);
    var src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  };

  Engine.concatBuffers = function (buffers) {
    // Normalize to a common rate/channel count, then concatenate.
    var rate = Math.max.apply(null, buffers.map(function (b) { return b.sampleRate; }));
    var chans = Math.max.apply(null, buffers.map(function (b) { return b.numberOfChannels; }));
    chans = Math.min(chans, 2);
    return Promise.all(buffers.map(function (b) {
      return Engine.resampleBuffer(b, rate, chans);
    })).then(function (normalized) {
      var total = normalized.reduce(function (sum, b) { return sum + b.length; }, 0);
      var ctx = Engine.getAudioContext();
      var out = ctx.createBuffer(chans, total, rate);
      var offset = 0;
      normalized.forEach(function (b) {
        for (var c = 0; c < chans; c++) {
          out.getChannelData(c).set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), offset);
        }
        offset += b.length;
      });
      return out;
    });
  };

  // ---------- WAV encoding (16-bit PCM) ----------
  Engine.encodeWav = function (audioBuffer) {
    var numChannels = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var frames = audioBuffer.length;
    var bytesPerSample = 2;
    var blockAlign = numChannels * bytesPerSample;
    var dataSize = frames * blockAlign;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    function writeStr(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);            // fmt chunk size
    view.setUint16(20, 1, true);             // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);            // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    var channels = [];
    for (var c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));
    var offset = 44;
    for (var i = 0; i < frames; i++) {
      for (var ch = 0; ch < numChannels; ch++) {
        var s = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  };

  // ---------- Script loader ----------
  var _scriptPromises = {};
  Engine.loadScript = function (src) {
    if (_scriptPromises[src]) return _scriptPromises[src];
    _scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        delete _scriptPromises[src];
        reject(new Error('Failed to load ' + src + '. Check your connection and try again.'));
      };
      document.head.appendChild(s);
    });
    return _scriptPromises[src];
  };

  // ---------- MP3 encoding via lamejs (lazy-loaded from CDN) ----------
  Engine.encodeMp3 = function (audioBuffer, kbps, onProgress) {
    kbps = kbps || 192;
    return Engine.loadScript('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js').then(function () {
      var channels = Math.min(audioBuffer.numberOfChannels, 2);
      var sampleRate = audioBuffer.sampleRate;
      var encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
      var left = audioBuffer.getChannelData(0);
      var right = channels > 1 ? audioBuffer.getChannelData(1) : null;
      var len = left.length;
      var blockSize = 1152;
      var chunks = [];

      function toInt16(f32, start, end) {
        var out = new Int16Array(end - start);
        for (var i = start; i < end; i++) {
          var s = Math.max(-1, Math.min(1, f32[i]));
          out[i - start] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
      }

      return new Promise(function (resolve) {
        var i = 0;
        function work() {
          var deadline = Date.now() + 40; // keep UI responsive
          while (i < len && Date.now() < deadline) {
            var end = Math.min(i + blockSize, len);
            var l16 = toInt16(left, i, end);
            var mp3buf = right
              ? encoder.encodeBuffer(l16, toInt16(right, i, end))
              : encoder.encodeBuffer(l16);
            if (mp3buf.length) chunks.push(new Uint8Array(mp3buf));
            i = end;
          }
          if (onProgress) onProgress(i / len);
          if (i < len) {
            setTimeout(work, 0);
          } else {
            var tail = encoder.flush();
            if (tail.length) chunks.push(new Uint8Array(tail));
            resolve(new Blob(chunks, { type: 'audio/mpeg' }));
          }
        }
        work();
      });
    });
  };

  // ---------- FFmpeg.wasm (lazy, single-threaded core — no COOP/COEP needed) ----------
  var _ffmpeg = null;
  var _ffmpegPromise = null;
  Engine.getFFmpeg = function () {
    if (_ffmpeg) return Promise.resolve(_ffmpeg);
    if (!_ffmpegPromise) {
      _ffmpegPromise = Engine.loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js')
        .then(function () {
          var ff = FFmpeg.createFFmpeg({
            corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
            mainName: 'main',
            log: false
          });
          return ff.load().then(function () {
            _ffmpeg = ff;
            return ff;
          });
        })
        .catch(function (err) {
          _ffmpegPromise = null;
          throw err;
        });
    }
    return _ffmpegPromise;
  };
  Engine.fetchFile = function (file) {
    return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
  };

  // ---------- Download helper ----------
  Engine.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };

  // ---------- Formatting ----------
  Engine.formatTime = function (sec) {
    if (!isFinite(sec)) sec = 0;
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };

  Engine.formatBytes = function (bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  };

  Engine.baseName = function (filename) {
    return filename.replace(/\.[^.]+$/, '') || 'audio';
  };

  // ---------- Dropzone wiring ----------
  // setupDropzone(el, inputEl, onFiles) — handles click, drag/drop, file input
  Engine.setupDropzone = function (zone, input, onFiles) {
    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files.length) onFiles(Array.prototype.slice.call(input.files));
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.remove('dragover');
      });
    });
    zone.addEventListener('drop', function (e) {
      var files = Array.prototype.slice.call(e.dataTransfer.files).filter(function (f) {
        return /^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|oga|flac|aac|webm|opus|wma|aiff?|mp4)$/i.test(f.name);
      });
      if (files.length) onFiles(files);
    });
  };

  // ---------- Status helpers ----------
  Engine.status = function (el, msg, kind) {
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  };

  Engine.progress = function (el, fraction) {
    var bar = el.querySelector('.progress__bar');
    if (fraction === null || fraction === undefined) {
      el.classList.remove('active', 'indeterminate');
      bar.style.width = '0%';
    } else if (fraction === 'indeterminate') {
      el.classList.add('active', 'indeterminate');
    } else {
      el.classList.remove('indeterminate');
      el.classList.add('active');
      bar.style.width = Math.round(Math.min(1, Math.max(0, fraction)) * 100) + '%';
    }
  };

  global.AudioEngine = Engine;
})(window);
