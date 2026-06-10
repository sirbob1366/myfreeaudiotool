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

  // ---------- Human-friendly errors ----------
  Engine.humanError = function (err) {
    var m = (err && err.message) || String(err || '');
    if (/decod|demux|EncodingError|NotSupportedError/i.test(m) || (err && err.name === 'EncodingError')) {
      return 'This file appears to be corrupted or in a format your browser cannot decode. Try converting it first.';
    }
    if (/memory|allocation/i.test(m)) {
      return 'Your device ran out of memory for this file. Try a shorter or smaller file.';
    }
    if (/Failed to load|fetch|network/i.test(m)) {
      return 'A required component could not be downloaded. Check your connection and try again.';
    }
    return m || 'Something went wrong. Please try again.';
  };

  // ---------- File loading ----------
  Engine.decodeFile = function (file) {
    return file.arrayBuffer().then(function (buf) {
      var ctx = Engine.getAudioContext();
      return new Promise(function (resolve, reject) {
        ctx.decodeAudioData(buf, resolve, function (e) {
          reject(e || new Error('decode failed'));
        });
      });
    });
  };
  Engine.loadAudioFile = Engine.decodeFile; // alias

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

  // ---------- Waveform drawing (retina-aware) ----------
  // opts: { selStart, selEnd } fractions 0..1; { playhead } fraction
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
    var baseColor = styles.getPropertyValue('--wave-base').trim() || '#d9e8f4';
    var accent = styles.getPropertyValue('--accent').trim() || '#0ea5e9';

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

    if (selStart !== null) {
      g.fillStyle = accent;
      [selStart, selEnd].forEach(function (f) {
        var hx = f * w;
        g.fillRect(hx - 1.5, 0, 3, h);
        g.beginPath();
        g.arc(hx, mid > 14 ? 10 : mid, 7, 0, Math.PI * 2);
        g.fill();
      });
      g.fillStyle = 'rgba(14,165,233,0.08)';
      g.fillRect(selStart * w, 0, (selEnd - selStart) * w, h);
    }

    if (typeof opts.playhead === 'number' && opts.playhead >= 0) {
      g.fillStyle = styles.getPropertyValue('--text').trim() || '#0b1526';
      g.fillRect(opts.playhead * w - 1, 0, 2, h);
    }
  };
  Engine.renderWaveform = Engine.drawWaveform; // alias

  // ---------- Buffer utilities ----------
  Engine.sliceBuffer = function (buffer, startSec, endSec) {
    var ctx = Engine.getAudioContext();
    var rate = buffer.sampleRate;
    var start = Math.max(0, Math.floor(startSec * rate));
    var end = Math.min(buffer.length, Math.ceil(endSec * rate));
    var frames = Math.max(1, end - start);
    var out = ctx.createBuffer(buffer.numberOfChannels, frames, rate);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      out.getChannelData(c).set(buffer.getChannelData(c).subarray(start, end));
    }
    return out;
  };

  Engine.reverseBuffer = function (buffer) {
    var ctx = Engine.getAudioContext();
    var out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var src = buffer.getChannelData(c);
      var dst = out.getChannelData(c);
      for (var i = 0, n = buffer.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    return out;
  };

  // Linear fade in/out, seconds. Mutates a copy and returns it.
  Engine.applyFades = function (buffer, fadeInSec, fadeOutSec) {
    var ctx = Engine.getAudioContext();
    var out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    var rate = buffer.sampleRate;
    var n = buffer.length;
    var inN = Math.min(n, Math.floor((fadeInSec || 0) * rate));
    var outN = Math.min(n, Math.floor((fadeOutSec || 0) * rate));
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var src = buffer.getChannelData(c);
      var dst = out.getChannelData(c);
      dst.set(src);
      for (var i = 0; i < inN; i++) dst[i] *= i / inN;
      for (var j = 0; j < outN; j++) dst[n - 1 - j] *= j / outN;
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
    var rate = Math.max.apply(null, buffers.map(function (b) { return b.sampleRate; }));
    var chans = Math.min(Math.max.apply(null, buffers.map(function (b) { return b.numberOfChannels; })), 2);
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

  // ---------- Offline rendering ----------
  // Renders `buffer` through a node graph. build(off, source) wires the graph
  // and returns the output node to connect to off.destination (or null if it
  // already connected everything itself). tailSec adds room for reverb tails.
  Engine.renderBufferThrough = function (buffer, build, tailSec, channels) {
    var rate = buffer.sampleRate;
    var frames = Math.ceil((buffer.duration + (tailSec || 0)) * rate);
    var off = new OfflineAudioContext(channels || buffer.numberOfChannels || 2, frames, rate);
    var src = off.createBufferSource();
    src.buffer = buffer;
    var out = build(off, src);
    if (out) out.connect(off.destination);
    src.start(0);
    return off.startRendering();
  };

  // Synthetic impulse response: stereo decaying noise burst.
  // opts: { seconds, decay (exp curve, higher = faster die-off), brightness 0..1
  //         (one-pole lowpass amount; 1 = full bandwidth), shimmer (early density) }
  Engine.makeImpulse = function (ctx, opts) {
    opts = opts || {};
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor((opts.seconds || 2) * rate));
    var ir = ctx.createBuffer(2, len, rate);
    var bright = typeof opts.brightness === 'number' ? opts.brightness : 0.7;
    // one-pole lowpass coefficient from brightness (0 = very dark, 1 = none)
    var a = 1 - Math.pow(1 - bright, 1.5) * 0.96;
    for (var c = 0; c < 2; c++) {
      var d = ir.getChannelData(c);
      var lp = 0;
      for (var i = 0; i < len; i++) {
        var t = i / len;
        var env = Math.pow(1 - t, opts.decay || 2.5);
        var n = (Math.random() * 2 - 1);
        lp += a * (n - lp);
        d[i] = lp * env;
      }
      // soften the very first samples so the IR doesn't click
      var ramp = Math.min(64, len);
      for (var j = 0; j < ramp; j++) d[j] *= j / ramp;
    }
    return ir;
  };

  // Peak |sample| across all channels — clipping checks after a render.
  Engine.bufferPeak = function (buffer) {
    var peak = 0;
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < d.length; i++) {
        var v = Math.abs(d[i]);
        if (v > peak) peak = v;
      }
    }
    return peak;
  };

  // Scale every sample by `gain` (in place), e.g. to pull a clipped render under 0 dBFS.
  Engine.scaleBuffer = function (buffer, gain) {
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < d.length; i++) d[i] *= gain;
    }
    return buffer;
  };

  // ---------- FFT (iterative radix-2, in-place; n must be a power of 2) ----------
  Engine.fft = function (re, im, inverse) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = (inverse ? 2 : -2) * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var s = 0; s < n; s += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var ur = re[s + k], ui = im[s + k];
          var vr = re[s + k + len / 2] * cr - im[s + k + len / 2] * ci;
          var vi = re[s + k + len / 2] * ci + im[s + k + len / 2] * cr;
          re[s + k] = ur + vr; im[s + k] = ui + vi;
          re[s + k + len / 2] = ur - vr; im[s + k + len / 2] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) for (var m = 0; m < n; m++) { re[m] /= n; im[m] /= n; }
  };

  // ---------- WAV encoding (16-bit PCM) ----------
  Engine.encodeWav = function (audioBuffer) {
    var numChannels = audioBuffer.numberOfChannels;
    var sampleRate = audioBuffer.sampleRate;
    var frames = audioBuffer.length;
    var blockAlign = numChannels * 2;
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
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
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
  Engine.encodeWAV = Engine.encodeWav; // alias

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
        reject(new Error('Failed to load ' + src));
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
  Engine.encodeMP3 = Engine.encodeMp3; // alias

  // ---------- FFmpeg.wasm (lazy, single-threaded core — no COOP/COEP needed) ----------
  // Loaded once per session; the ~25 MB core wasm is prefetched with byte-level
  // progress (lands in the HTTP cache, so ff.load() reuses it instantly).
  var FF_JS = 'https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js';
  var FF_CORE = 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js';
  var FF_WASM = 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.wasm';
  var _ffmpeg = null;
  var _ffmpegPromise = null;

  // onProgress(fraction|null, loadedBytes, totalBytes) — fraction null = size unknown
  Engine.getFFmpeg = function (onProgress) {
    if (_ffmpeg) return Promise.resolve(_ffmpeg);
    if (!_ffmpegPromise) {
      _ffmpegPromise = Engine.loadScript(FF_JS)
        .then(function () {
          // Prefetch the big wasm with streaming progress
          return fetch(FF_WASM).then(function (res) {
            if (!res.ok || !res.body) return null;
            var total = parseInt(res.headers.get('Content-Length') || '0', 10);
            var reader = res.body.getReader();
            var got = 0;
            function pump() {
              return reader.read().then(function (r) {
                if (r.done) return null;
                got += r.value.length;
                if (onProgress) onProgress(total ? got / total : null, got, total);
                return pump();
              });
            }
            return pump();
          }).catch(function () { /* progress is best-effort; ff.load() will fetch anyway */ });
        })
        .then(function () {
          var ff = FFmpeg.createFFmpeg({ corePath: FF_CORE, mainName: 'main', log: false });
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
  // Accepts drops anywhere on the page, not just the box.
  // Warns (without blocking) above 200 MB.
  var SIZE_WARN = 200 * 1048576;
  Engine.setupDropzone = function (zone, input, onFiles, opts) {
    opts = opts || {};
    var accept = opts.video
      ? function (f) { return /^(audio|video)\//.test(f.type) || /\.(mp4|webm|mov|mkv|avi|m4v|mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name); }
      : function (f) { return /^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|oga|flac|aac|webm|opus|wma|aiff?|mp4)$/i.test(f.name); };

    function handle(files) {
      files = files.filter(accept);
      if (!files.length) return;
      var big = files.filter(function (f) { return f.size > SIZE_WARN; });
      if (big.length) {
        var note = zone.querySelector('.size-warn') || (function () {
          var d = document.createElement('p');
          d.className = 'status error size-warn';
          zone.appendChild(d);
          return d;
        })();
        note.textContent = '⚠ ' + big[0].name + ' is over 200 MB — processing may be slow on this device, but we\'ll try.';
      }
      onFiles(files);
    }

    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files.length) handle(Array.prototype.slice.call(input.files));
      input.value = '';
    });

    // page-wide drag & drop
    ['dragenter', 'dragover'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        e.preventDefault();
        if (evt === 'drop' || e.target === document.documentElement) zone.classList.remove('dragover');
      });
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handle(Array.prototype.slice.call(e.dataTransfer.files));
      }
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
