/* GeoCam – EXIF-GPS in JPEG lesen und schreiben. Ohne Abhängigkeiten.
   Browser: window.GCExif · Node (Test): module.exports */
(function (root) {
  "use strict";

  /* ---------- schreiben ---------- */
  function ascii(s) {
    var b = new Uint8Array(s.length + 1);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
    return b;
  }
  function rationals(list) {
    var b = new Uint8Array(list.length * 8), dv = new DataView(b.buffer);
    list.forEach(function (r, i) {
      dv.setUint32(i * 8, r[0] >>> 0, true);
      dv.setUint32(i * 8 + 4, r[1] >>> 0, true);
    });
    return b;
  }
  function long(v) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return b;
  }
  function dms(v) {
    v = Math.abs(v);
    var d = Math.floor(v), mf = (v - d) * 60, m = Math.floor(mf);
    var s = Math.min(599999, Math.round((mf - m) * 60 * 10000));
    return [[d, 1], [m, 1], [s, 10000]];
  }
  function p2(n) { return String(n).padStart(2, "0"); }
  function exifDate(d) {
    return d.getFullYear() + ":" + p2(d.getMonth() + 1) + ":" + p2(d.getDate()) + " " +
      p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }
  /* Ein IFD samt ausgelagerter Werte; base = Offset des IFD innerhalb des TIFF-Blocks. */
  function buildIfd(entries, base) {
    var n = entries.length, head = 2 + n * 12 + 4, extra = 0;
    entries.forEach(function (e) {
      if (e.data.length > 4) { e.off = base + head + extra; extra += e.data.length + (e.data.length & 1); }
    });
    var out = new Uint8Array(head + extra), dv = new DataView(out.buffer);
    dv.setUint16(0, n, true);
    entries.forEach(function (e, i) {
      var p = 2 + i * 12;
      dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true);
      if (e.data.length > 4) { dv.setUint32(p + 8, e.off, true); out.set(e.data, e.off - base); }
      else out.set(e.data, p + 8);
    });
    return out;
  }
  function buildTiff(meta) {
    var dt = ascii(exifDate(meta.date || new Date()));
    var ifd0 = function (pe, pg) {
      return [
        { tag: 0x0131, type: 2, count: 7, data: ascii("GeoCam") },
        { tag: 0x0132, type: 2, count: 20, data: dt },
        { tag: 0x8769, type: 4, count: 1, data: long(pe) },
        { tag: 0x8825, type: 4, count: 1, data: long(pg) }
      ];
    };
    var exif = [{ tag: 0x9003, type: 2, count: 20, data: dt }];
    var gps = [
      { tag: 0, type: 1, count: 4, data: new Uint8Array([2, 3, 0, 0]) },
      { tag: 1, type: 2, count: 2, data: ascii(meta.lat >= 0 ? "N" : "S") },
      { tag: 2, type: 5, count: 3, data: rationals(dms(meta.lat)) },
      { tag: 3, type: 2, count: 2, data: ascii(meta.lng >= 0 ? "E" : "W") },
      { tag: 4, type: 5, count: 3, data: rationals(dms(meta.lng)) }
    ];
    if (typeof meta.alt === "number" && isFinite(meta.alt)) {
      gps.push({ tag: 5, type: 1, count: 1, data: new Uint8Array([meta.alt < 0 ? 1 : 0]) });
      gps.push({ tag: 6, type: 5, count: 1, data: rationals([[Math.round(Math.abs(meta.alt) * 100), 100]]) });
    }
    var l0 = buildIfd(ifd0(0, 0), 8).length;
    var bExif = buildIfd(exif, 8 + l0);
    var bGps = buildIfd(gps, 8 + l0 + bExif.length);
    var b0 = buildIfd(ifd0(8 + l0, 8 + l0 + bExif.length), 8);
    var tiff = new Uint8Array(8 + b0.length + bExif.length + bGps.length);
    tiff.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
    tiff.set(b0, 8); tiff.set(bExif, 8 + b0.length); tiff.set(bGps, 8 + b0.length + bExif.length);
    return tiff;
  }
  /* Setzt einen APP1-Exif-Block direkt hinter SOI. buf: ArrayBuffer eines JPEG. */
  function insertGps(buf, meta) {
    var u8 = new Uint8Array(buf);
    if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return u8;
    var tiff = buildTiff(meta), len = 2 + 6 + tiff.length;
    if (len > 0xffff) return u8;
    var out = new Uint8Array(u8.length + 2 + len);
    out.set([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0], 0);
    out.set(tiff, 12);
    /* vorhandene Exif-Blöcke nicht doppelt mitführen */
    var w = 12 + tiff.length, p = 2;
    while (p + 4 <= u8.length && u8[p] === 0xff && u8[p + 1] !== 0xda && u8[p + 1] !== 0xd9) {
      var sl = 2 + ((u8[p + 2] << 8) | u8[p + 3]);
      var isExif = u8[p + 1] === 0xe1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66;
      if (!isExif) { out.set(u8.subarray(p, p + sl), w); w += sl; }
      p += sl;
    }
    out.set(u8.subarray(p), w); w += u8.length - p;
    return out.subarray(0, w);
  }

  /* ---------- lesen ---------- */
  var TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  function parseTiff(dv, t, end) {
    var le = dv.getUint16(t) === 0x4949;
    var u16 = function (o) { return dv.getUint16(t + o, le); };
    var u32 = function (o) { return dv.getUint32(t + o, le); };
    function ifd(off) {
      var m = {}, n = u16(off);
      for (var i = 0; i < n; i++) {
        var p = off + 2 + i * 12, type = u16(p + 2), count = u32(p + 4);
        var size = (TYPE_SIZE[type] || 1) * count;
        m[u16(p)] = { type: type, count: count, at: size > 4 ? u32(p + 8) : p + 8 };
      }
      return m;
    }
    function rat(e, i) { var d = u32(e.at + i * 8 + 4); return d ? u32(e.at + i * 8) / d : 0; }
    function str(e) {
      var s = "";
      for (var i = 0; i < e.count && t + e.at + i < end; i++) {
        var c = dv.getUint8(t + e.at + i); if (!c) break; s += String.fromCharCode(c);
      }
      return s;
    }
    var out = { lat: null, lng: null, alt: null, ts: null };
    var i0 = ifd(u32(4));
    if (i0[0x8825]) {
      var g = ifd(u32(i0[0x8825].at));
      if (g[2] && g[4] && g[2].count === 3 && g[4].count === 3) {
        var lat = rat(g[2], 0) + rat(g[2], 1) / 60 + rat(g[2], 2) / 3600;
        var lng = rat(g[4], 0) + rat(g[4], 1) / 60 + rat(g[4], 2) / 3600;
        if (g[1] && str(g[1]) === "S") lat = -lat;
        if (g[3] && str(g[3]) === "W") lng = -lng;
        if (isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          out.lat = lat; out.lng = lng;
          if (g[6]) { out.alt = rat(g[6], 0); if (g[5] && dv.getUint8(t + g[5].at) === 1) out.alt = -out.alt; }
        }
      }
    }
    var ds = null;
    if (i0[0x8769]) { var ex = ifd(u32(i0[0x8769].at)); if (ex[0x9003]) ds = str(ex[0x9003]); }
    if (!ds && i0[0x0132]) ds = str(i0[0x0132]);
    var m = ds && /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(ds);
    if (m) {
      var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (!isNaN(d.getTime())) out.ts = d.getTime();
    }
    return out;
  }
  /* buf: ArrayBuffer (Dateianfang genügt). Liefert {lat,lng,alt,ts} oder null. */
  function read(buf) {
    try {
      var dv = new DataView(buf);
      if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return null;
      var p = 2;
      while (p + 4 <= dv.byteLength) {
        if (dv.getUint8(p) !== 0xff) break;
        var marker = dv.getUint8(p + 1);
        if (marker === 0xda || marker === 0xd9) break;
        var len = dv.getUint16(p + 2);
        if (marker === 0xe1 && len >= 8 && dv.getUint32(p + 4) === 0x45786966 && dv.getUint16(p + 8) === 0) {
          return parseTiff(dv, p + 10, Math.min(dv.byteLength, p + 2 + len));
        }
        p += 2 + len;
      }
    } catch (e) { /* abgeschnittene/defekte Datei */ }
    return null;
  }

  var api = { insertGps: insertGps, read: read };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GCExif = api;
})(typeof window !== "undefined" ? window : this);
