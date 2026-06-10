/* MyFreeAudioTool — minimal ID3v2 reader/writer.
   Reads ID3v2.2 / v2.3 / v2.4 text frames + cover art; writes a clean ID3v2.3
   tag (UTF-16 text frames, APIC cover) in front of the untouched MPEG audio
   data — no re-encoding. */
(function (global) {
  'use strict';
  var ID3 = {};

  var TEXT_FRAMES = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TDRC: 'year', TCON: 'genre', TRCK: 'track' };
  var V22_MAP = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TYE: 'TYER', TCO: 'TCON', TRK: 'TRCK', PIC: 'APIC' };

  function syncsafe(b0, b1, b2, b3) {
    return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
  }

  function decodeText(bytes, enc) {
    try {
      if (enc === 0) return new TextDecoder('latin1').decode(bytes);
      if (enc === 3) return new TextDecoder('utf-8').decode(bytes);
      if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
      // enc 1: UTF-16 with BOM
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
      return new TextDecoder('utf-16le').decode(bytes);
    } catch (e) { return ''; }
  }

  function stripNulls(s) { return s.replace(/\0+$/g, '').replace(/^\0+/, ''); }

  // ---------- read ----------
  // returns { tags: {title, artist, album, year, genre, track},
  //           cover: {mime, bytes} | null, audioOffset, version } — or null tags if no ID3v2
  ID3.read = function (arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var out = { tags: {}, cover: null, audioOffset: 0, version: 0 };
    if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return out;

    var ver = u8[3];
    var tagSize = syncsafe(u8[6], u8[7], u8[8], u8[9]);
    out.audioOffset = 10 + tagSize;
    out.version = ver;
    var pos = 10;
    var end = Math.min(10 + tagSize, u8.length);
    // skip extended header (v2.3/2.4)
    if ((u8[5] & 0x40) && ver >= 3) {
      var extSize = ver === 4
        ? syncsafe(u8[10], u8[11], u8[12], u8[13])
        : ((u8[10] << 24) | (u8[11] << 16) | (u8[12] << 8) | u8[13]) + 4;
      pos += extSize;
    }

    while (pos < end - (ver === 2 ? 6 : 10)) {
      var id, size, headerLen;
      if (ver === 2) {
        if (u8[pos] === 0) break;
        id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2]);
        size = (u8[pos + 3] << 16) | (u8[pos + 4] << 8) | u8[pos + 5];
        headerLen = 6;
        id = V22_MAP[id] || id;
      } else {
        if (u8[pos] === 0) break;
        id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
        size = ver === 4
          ? syncsafe(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7])
          : ((u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7]);
        headerLen = 10;
      }
      if (size <= 0 || pos + headerLen + size > end) break;
      var body = u8.subarray(pos + headerLen, pos + headerLen + size);

      if (TEXT_FRAMES[id]) {
        var key = TEXT_FRAMES[id];
        if (!out.tags[key]) {
          var txt = stripNulls(decodeText(body.subarray(1), body[0]));
          if (key === 'year') txt = (txt.match(/\d{4}/) || [txt])[0];
          out.tags[key] = txt;
        }
      } else if (id === 'APIC' && !out.cover) {
        var enc = body[0];
        var i = 1;
        var mime;
        if (ver === 2) {
          mime = 'image/' + String.fromCharCode(body[1], body[2], body[3]).toLowerCase().replace('jpg', 'jpeg');
          i = 4;
        } else {
          var m0 = i;
          while (i < body.length && body[i] !== 0) i++;
          mime = decodeText(body.subarray(m0, i), 0) || 'image/jpeg';
          i++;
        }
        i++; // picture type
        // description, encoding-dependent terminator
        if (enc === 1 || enc === 2) {
          while (i + 1 < body.length && (body[i] !== 0 || body[i + 1] !== 0)) i += 2;
          i += 2;
        } else {
          while (i < body.length && body[i] !== 0) i++;
          i++;
        }
        out.cover = { mime: mime, bytes: body.slice(i) };
      }
      pos += headerLen + size;
    }
    return out;
  };

  // ---------- write ----------
  function encodeUtf16(str) {
    var out = new Uint8Array(2 + str.length * 2);
    out[0] = 0xFF; out[1] = 0xFE; // BOM, little-endian
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      out[2 + i * 2] = c & 0xFF;
      out[3 + i * 2] = c >> 8;
    }
    return out;
  }

  function frame(id, body) {
    var f = new Uint8Array(10 + body.length);
    for (var i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
    f[4] = (body.length >>> 24) & 0xFF;
    f[5] = (body.length >>> 16) & 0xFF;
    f[6] = (body.length >>> 8) & 0xFF;
    f[7] = body.length & 0xFF;
    f.set(body, 10);
    return f;
  }

  function textFrame(id, str) {
    var enc = encodeUtf16(str);
    var body = new Uint8Array(1 + enc.length);
    body[0] = 1; // UTF-16 with BOM
    body.set(enc, 1);
    return frame(id, body);
  }

  // tags: {title, artist, album, year, genre, track}; cover: {mime, bytes} | null
  ID3.build = function (tags, cover) {
    var frames = [];
    var map = { title: 'TIT2', artist: 'TPE1', album: 'TALB', year: 'TYER', genre: 'TCON', track: 'TRCK' };
    Object.keys(map).forEach(function (key) {
      if (tags[key]) frames.push(textFrame(map[key], String(tags[key]).trim()));
    });
    if (cover && cover.bytes && cover.bytes.length) {
      var mime = new TextEncoder().encode(cover.mime);
      var body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + cover.bytes.length);
      var p = 0;
      body[p++] = 0;                 // latin1 for mime/desc
      body.set(mime, p); p += mime.length;
      body[p++] = 0;                 // mime terminator
      body[p++] = 3;                 // picture type: cover (front)
      body[p++] = 0;                 // empty description
      body.set(cover.bytes, p);
      frames.push(frame('APIC', body));
    }
    var framesLen = frames.reduce(function (s, f) { return s + f.length; }, 0);
    var padding = 128;
    var size = framesLen + padding;
    var tag = new Uint8Array(10 + size);
    tag[0] = 0x49; tag[1] = 0x44; tag[2] = 0x33; // "ID3"
    tag[3] = 3; tag[4] = 0; tag[5] = 0;          // v2.3.0, no flags
    tag[6] = (size >>> 21) & 0x7F;
    tag[7] = (size >>> 14) & 0x7F;
    tag[8] = (size >>> 7) & 0x7F;
    tag[9] = size & 0x7F;
    var pos = 10;
    frames.forEach(function (f) { tag.set(f, pos); pos += f.length; });
    return tag;
  };

  global.ID3 = ID3;
})(window);
