/* GeoCam – App-Logik (Kamera mit Stempel, Galerie nach Ort, Karte, Navigation, eigenes Logo) */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var p2 = function (n) { return String(n).padStart(2, "0"); };
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  var OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

  /* ================= Einstellungen ================= */
  var DEF = {
    tpl: "modern", pos: "bottom", scale: 1, coordFmt: "dec",
    fields: { map: true, place: true, address: true, coords: true, datetime: true, alt: false, acc: false,
      compass: false, weather: true, project: false, note: false },
    project: "", note: "", logoPos: "tr", logoSize: 18,
    exif: true, audio: true, stampImport: true, quality: 0.92,
    hiRes: true, keepOrig: true, maxRec: 10, mapKind: "ov",
    groupBy: "city", geocodeOnline: true,
    timer: 0, mode: "photo", facing: "environment", sort: "place"
  };
  var S = (function () {
    var s = JSON.parse(JSON.stringify(DEF));
    try {
      var o = JSON.parse(localStorage.getItem("gc_settings") || "{}");
      Object.keys(o).forEach(function (k) { if (k !== "fields" && k in s) s[k] = o[k]; });
      if (o.fields) Object.keys(o.fields).forEach(function (k) { if (k in s.fields) s.fields[k] = !!o.fields[k]; });
    } catch (e) { /* defekte Einstellungen -> Standard */ }
    return s;
  })();
  function saveS() { try { localStorage.setItem("gc_settings", JSON.stringify(S)); } catch (e) {} }

  /* ================= IndexedDB ================= */
  var _db = null;
  function db() {
    return _db || (_db = new Promise(function (res, rej) {
      var r = indexedDB.open("geocam", 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore("media", { keyPath: "id" });
        d.createObjectStore("blobs");
        d.createObjectStore("kv");
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    }));
  }
  /* fn bekommt die Transaktion; liefert es einen IDBRequest, wird dessen Ergebnis zurückgegeben */
  function tx(stores, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(stores, mode), out;
        t.oncomplete = function () { res(out && typeof out === "object" && "result" in out ? out.result : out); };
        t.onerror = t.onabort = function () { rej(t.error || new Error("Speicherfehler")); };
        out = fn(t);
      });
    });
  }
  function putItem(meta, blob) {
    return tx(["media", "blobs"], "readwrite", function (t) {
      t.objectStore("media").put(meta);
      if (blob) t.objectStore("blobs").put(blob, meta.id);
    });
  }
  function getBlob(id) { return tx(["blobs"], "readonly", function (t) { return t.objectStore("blobs").get(id); }); }
  function delItem(id) {
    return tx(["media", "blobs"], "readwrite", function (t) {
      t.objectStore("media").delete(id); t.objectStore("blobs").delete(id); t.objectStore("blobs").delete(id + ORIG);
    });
  }
  /* ungestempeltes Original (Key id + ":orig") – damit sich der Stempel nach „Ort/Adresse ändern" neu setzen lässt */
  var ORIG = ":orig";
  function putOrig(id, blob) { return tx(["blobs"], "readwrite", function (t) { t.objectStore("blobs").put(blob, id + ORIG); }); }
  function getOrig(id) { return getBlob(id + ORIG); }

  /* ================= Zustand ================= */
  var items = [];                 // Metadaten, neueste zuerst
  var logo = null;                // HTMLImageElement
  var view = "cam";
  var loc = { lat: null, lng: null, alt: null, acc: null, heading: null, manual: false,
    place: "", city: "", suburb: "", address: "", weather: "", map: null };
  var gpsRaw = null;
  var ovDirty = true;

  /* ================= kleine Helfer ================= */
  var toastT = 0;
  function toast(msg, ms) {
    var t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }
  function busy(msg) { $("#busy-txt").textContent = msg || "Bitte warten …"; $("#busy").hidden = false; }
  function unbusy() { $("#busy").hidden = true; }
  function hasLoc(o) { return typeof o.lat === "number" && typeof o.lng === "number"; }
  function dist(a, b) {
    var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function de(n, d) { return n.toFixed(d).replace(".", ","); }
  function fmtCoords(lat, lng, fmt) {
    var ns = lat >= 0 ? "N" : "S", ew = lng >= 0 ? "O" : "W";
    if ((fmt || S.coordFmt) === "dms") {
      var f = function (v) {
        v = Math.abs(v); var d = Math.floor(v), mf = (v - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
        if (s >= 59.95) { s = 0; m += 1; } if (m >= 60) { m = 0; d += 1; }
        return d + "°" + p2(m) + "'" + de(s, 1).padStart(4, "0") + '"';
      };
      return f(lat) + " " + ns + "  " + f(lng) + " " + ew;
    }
    return de(Math.abs(lat), 6) + "° " + ns + ", " + de(Math.abs(lng), 6) + "° " + ew;
  }
  function fmtDate(d) {
    return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtDur(s) { s = Math.max(0, Math.round(s || 0)); return p2(Math.floor(s / 60)) + ":" + p2(s % 60); }
  function compassTxt(h) { return ["N", "NO", "O", "SO", "S", "SW", "W", "NW"][Math.round(h / 45) % 8] + " " + Math.round(h) + "°"; }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function mapsNav(it) { return "https://www.google.com/maps/dir/?api=1&destination=" + it.lat.toFixed(6) + "," + it.lng.toFixed(6) + "&travelmode=driving"; }
  function mapsShow(it) { return "https://www.google.com/maps/search/?api=1&query=" + it.lat.toFixed(6) + "," + it.lng.toFixed(6); }
  function canvasBlob(c, type, q) {
    return new Promise(function (res, rej) {
      c.toBlob(function (b) { b ? res(b) : rej(new Error("Bild konnte nicht erzeugt werden")); }, type, q);
    });
  }
  function online() { return navigator.onLine !== false && S.geocodeOnline; }

  /* ================= Online-Dienste: Adresse, Wetter, Mini-Karte ================= */
  var geoCache = new Map(), geoQ = Promise.resolve(), geoT = 0;
  function nominatim(url) {
    var run = function () {
      var wait = 1100 - (Date.now() - geoT);
      return (wait > 0 ? sleep(wait) : Promise.resolve()).then(function () {
        geoT = Date.now();
        return fetch(url, { headers: { Accept: "application/json" } });
      }).then(function (r) { if (!r.ok) throw new Error("Geocoder " + r.status); return r.json(); });
    };
    var p = geoQ.then(run, run); geoQ = p.catch(function () {}); return p;
  }
  function parseAddr(j) {
    var a = (j && j.address) || {};
    var city = a.city || a.town || a.village || a.municipality || a.hamlet || a.county || "";
    var suburb = a.suburb || a.city_district || a.quarter || a.neighbourhood || "";
    if (suburb === city) suburb = "";
    var road = [a.road || a.pedestrian || a.footway || a.path || "", a.house_number || ""].join(" ").trim();
    var address = [road, [a.postcode || "", city].join(" ").trim(), a.country || ""].filter(Boolean).join(", ");
    var place = city ? (suburb ? suburb + ", " + city : city) : (a.state || a.country || "");
    return { place: place, city: city, suburb: suburb, address: address };
  }
  function reverse(lat, lng) {
    var key = lat.toFixed(4) + "," + lng.toFixed(4);
    if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
    return nominatim("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=de&lat=" +
      lat.toFixed(6) + "&lon=" + lng.toFixed(6)).then(function (j) {
      var g = parseAddr(j); geoCache.set(key, g); return g;
    });
  }
  var WMO = { 0: "klar", 1: "heiter", 2: "teils bewölkt", 3: "bedeckt", 45: "Nebel", 48: "Nebel", 51: "Nieselregen", 53: "Nieselregen",
    55: "Nieselregen", 56: "gefrierender Niesel", 57: "gefrierender Niesel", 61: "leichter Regen", 63: "Regen", 65: "starker Regen",
    66: "gefrierender Regen", 67: "gefrierender Regen", 71: "leichter Schneefall", 73: "Schneefall", 75: "starker Schneefall",
    77: "Schneegriesel", 80: "Regenschauer", 81: "Regenschauer", 82: "starke Regenschauer", 85: "Schneeschauer", 86: "Schneeschauer",
    95: "Gewitter", 96: "Gewitter mit Hagel", 99: "Gewitter mit Hagel" };
  function fetchWeather(lat, lng) {
    return fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(3) + "&longitude=" + lng.toFixed(3) +
      "&current=temperature_2m,weather_code").then(function (r) { if (!r.ok) throw new Error("Wetter " + r.status); return r.json(); })
      .then(function (j) {
        var c = j.current || {};
        if (typeof c.temperature_2m !== "number") return "";
        var w = WMO[c.weather_code];
        return Math.round(c.temperature_2m) + " °C" + (w ? ", " + w : "");
      });
  }
  var mapCache = new Map();
  function loadTile(z, x, y) {
    return new Promise(function (res, rej) {
      var im = new Image(); im.crossOrigin = "anonymous";
      im.onload = function () { res(im); }; im.onerror = function () { rej(new Error("Kachel")); };
      im.src = OSM_TILES.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    });
  }
  function miniMap(lat, lng) {
    var key = lat.toFixed(4) + "," + lng.toFixed(4);
    if (mapCache.has(key)) return Promise.resolve(mapCache.get(key));
    var z = 16, n = Math.pow(2, z), r = lat * Math.PI / 180;
    var fx = (lng + 180) / 360 * n, fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
    var tx0 = Math.floor(fx), ty0 = Math.floor(fy), jobs = [];
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      (function (dx, dy) {
        var y = ty0 + dy; if (y < 0 || y >= n) return;
        jobs.push(loadTile(z, ((tx0 + dx) % n + n) % n, y).then(function (im) { return { im: im, dx: dx, dy: dy }; }));
      })(dx, dy);
    }
    return Promise.all(jobs).then(function (tiles) {
      var SZ = 320, c = document.createElement("canvas"); c.width = c.height = SZ;
      var g = c.getContext("2d"), px = (fx - tx0) * 256, py = (fy - ty0) * 256;
      tiles.forEach(function (t) { g.drawImage(t.im, Math.round(t.dx * 256 - px + SZ / 2), Math.round(t.dy * 256 - py + SZ / 2)); });
      g.beginPath(); g.arc(SZ / 2, SZ / 2, 17, 0, 6.3); g.fillStyle = "#fff"; g.fill();
      g.beginPath(); g.arc(SZ / 2, SZ / 2, 12, 0, 6.3); g.fillStyle = "#ef4444"; g.fill();
      g.font = "600 17px " + FONT; var label = "© OpenStreetMap", tw = g.measureText(label).width;
      g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(SZ - tw - 10, SZ - 24, tw + 10, 24);
      g.fillStyle = "#1f2937"; g.textBaseline = "middle"; g.fillText(label, SZ - tw - 5, SZ - 11);
      g.getImageData(0, 0, 1, 1);   // wirft, falls eine Kachel ohne CORS-Freigabe kam
      if (mapCache.size > 40) mapCache.clear();
      mapCache.set(key, c); return c;
    });
  }

  /* ================= Stempel ================= */
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function wrap(g, text, maxW, maxLines) {
    var words = String(text).split(/\s+/).filter(Boolean), lines = [], cur = "";
    words.forEach(function (w) {
      var t = cur ? cur + " " + w : w;
      if (!cur || g.measureText(t).width <= maxW) cur = t; else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    var cut = lines.length > maxLines; if (cut) lines.length = maxLines;
    return lines.map(function (l, i) {
      var more = cut && i === lines.length - 1;
      if (!more && g.measureText(l).width <= maxW) return l;
      l += "…";
      while (l.length > 2 && g.measureText(l).width > maxW) l = l.slice(0, -2) + "…";
      return l;
    });
  }
  /* d = {lat,lng,alt,acc,heading,place,address,weather,date,note,map} – zeichnet Stempel + Logo */
  function drawStamp(g, W, H, d) {
    var f = S.fields, tpl = S.tpl, u = Math.max(10, Math.round(Math.min(W, H) * 0.028 * S.scale));
    var rows = [];
    if (f.project && S.project) rows.push({ k: "head", t: S.project.toUpperCase() });
    if (f.place && d.place) rows.push({ k: "title", t: d.place });
    if (f.address && d.address) rows.push({ k: "text", t: d.address });
    if (f.coords && hasLoc(d)) rows.push({ k: "text", t: fmtCoords(d.lat, d.lng) });
    if (f.datetime) rows.push({ k: "text", t: fmtDate(d.date || new Date()) });
    var ex = [];
    if (f.alt && typeof d.alt === "number") ex.push("Höhe " + Math.round(d.alt) + " m");
    if (f.acc && typeof d.acc === "number") ex.push("± " + Math.round(d.acc) + " m");
    if (f.compass && typeof d.heading === "number") ex.push(compassTxt(d.heading));
    if (f.weather && d.weather) ex.push(d.weather);
    if (ex.length) rows.push({ k: "text", t: ex.join("  ·  ") });
    if (f.note && d.note) rows.push({ k: "note", t: d.note });

    var showMap = f.map && d.map && hasLoc(d), box = null;
    if (rows.length || showMap) {
      var pad = Math.round(u * 0.8), margin = tpl === "classic" ? 0 : Math.round(u * 0.7);
      var stripe = tpl === "modern" ? Math.round(u * 0.45) : 0;
      var mapS = showMap ? Math.round(u * 6.5) : 0, mapPart = showMap ? mapS + pad : 0;
      var maxBox = tpl === "classic" ? W : Math.min(W - 2 * margin, u * 34);
      var textMax = Math.max(u * 6, maxBox - 2 * pad - stripe - mapPart);
      var fonts = { head: "700 " + Math.round(u * 0.78) + "px " + FONT, title: "700 " + Math.round(u * 1.3) + "px " + FONT,
        text: "400 " + Math.round(u * 0.92) + "px " + FONT, note: "italic 400 " + Math.round(u * 0.92) + "px " + FONT };
      var lh = { head: u * 1.15, title: u * 1.65, text: u * 1.3, note: u * 1.3 };
      var lines = [], textW = 0, textH = 0;
      rows.forEach(function (r) {
        g.font = fonts[r.k];
        wrap(g, r.t, textMax, r.k === "head" || r.k === "title" ? 1 : 2).forEach(function (l) {
          lines.push({ k: r.k, t: l }); textW = Math.max(textW, g.measureText(l).width); textH += lh[r.k];
        });
      });
      var bw = tpl === "classic" ? W : Math.ceil(2 * pad + stripe + mapPart + textW - (lines.length ? 0 : pad));
      var bh = Math.ceil(Math.max(textH, mapS) + 2 * pad);
      var bx = margin, by = S.pos === "top" ? margin : H - margin - bh;
      box = { x: bx, y: by, w: bw, h: bh };

      g.save();
      var cTitle = "#fff", cText = "#e5e7eb", cHead = "#5eead4";
      if (tpl === "classic") { g.fillStyle = "rgba(0,0,0,.62)"; g.fillRect(bx, by, bw, bh); }
      else if (tpl === "modern") {
        g.fillStyle = "rgba(11,18,32,.80)"; rr(g, bx, by, bw, bh, u * 0.9); g.fill();
        g.save(); rr(g, bx, by, bw, bh, u * 0.9); g.clip(); g.fillStyle = "#14b8a6"; g.fillRect(bx, by, Math.round(u * 0.3), bh); g.restore();
      } else if (tpl === "pro") {
        g.fillStyle = "rgba(255,255,255,.94)"; rr(g, bx, by, bw, bh, u * 0.5); g.fill();
        cTitle = "#0b1220"; cText = "#334155"; cHead = "#0f766e";
      }
      var cx = bx + pad + stripe;
      if (showMap) {
        var my = by + Math.round((bh - mapS) / 2);
        g.save(); rr(g, cx, my, mapS, mapS, u * 0.45); g.clip(); g.drawImage(d.map, cx, my, mapS, mapS); g.restore();
        g.lineWidth = Math.max(1, u * 0.08); g.strokeStyle = tpl === "pro" ? "rgba(15,23,42,.35)" : "rgba(255,255,255,.75)";
        rr(g, cx, my, mapS, mapS, u * 0.45); g.stroke();
        cx += mapS + pad;
      }
      if (tpl === "minimal") { g.shadowColor = "rgba(0,0,0,.9)"; g.shadowBlur = u * 0.4; g.shadowOffsetY = u * 0.06; }
      g.textBaseline = "middle"; g.textAlign = "left";
      var ty = by + pad + (bh - 2 * pad - textH) / 2;
      lines.forEach(function (l) {
        g.font = fonts[l.k]; g.fillStyle = l.k === "title" ? cTitle : l.k === "head" ? cHead : cText;
        g.fillText(l.t, cx, ty + lh[l.k] / 2); ty += lh[l.k];
      });
      g.restore();
    }
    if (logo) {
      var m = Math.round(u * 0.8), L0 = Math.min(W, H) * S.logoSize / 100, ratio = logo.naturalWidth / logo.naturalHeight || 1;
      var lw = ratio >= 1 ? L0 : L0 * ratio, lhh = ratio >= 1 ? L0 / ratio : L0;
      var top = S.logoPos.charAt(0) === "t", lx = S.logoPos.charAt(1) === "l" ? m : W - m - lw, ly = top ? m : H - m - lhh;
      if (box && lx < box.x + box.w && lx + lw > box.x && ly < box.y + box.h && ly + lhh > box.y) ly = top ? box.y + box.h + m : box.y - m - lhh;
      g.save(); g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = u * 0.4; g.drawImage(logo, lx, ly, lw, lhh); g.restore();
    }
  }
  function liveData() {
    return { lat: loc.lat, lng: loc.lng, alt: loc.alt, acc: loc.acc, heading: loc.heading, place: loc.place,
      address: loc.address, weather: loc.weather, map: loc.map, date: new Date(), note: S.note };
  }

  /* ================= Standort ================= */
  var geoAt = null, mapAt = null, wxAt = 0, geoFail = 0;
  function chip() {
    var c = $("#gps-chip"); c.classList.remove("ok", "warn");
    if (!hasLoc(loc)) {
      c.textContent = geoState === "ask" ? "Standort freigeben – tippen" : geoState === "denied" ? "Standort blockiert – tippen"
        : geoState === "unavail" ? "GPS aus? – tippen" : "Standort wird gesucht …";
      c.classList.add("warn"); return;
    }
    var t = loc.place || (de(loc.lat, 4) + ", " + de(loc.lng, 4));
    if (loc.manual) t = "Manuell · " + t;
    else if (typeof loc.acc === "number") t += " · ± " + Math.round(loc.acc) + " m";
    c.textContent = t; c.classList.add(!loc.manual && loc.acc > 60 ? "warn" : "ok");
  }
  function setLoc(lat, lng, alt, acc) {
    loc.lat = lat; loc.lng = lng; loc.alt = typeof alt === "number" ? alt : null; loc.acc = typeof acc === "number" ? acc : null;
    ovDirty = true; geoUi(); refreshLocInfo();
  }
  function refreshLocInfo() {
    if (!hasLoc(loc) || !online()) return;
    var here = { lat: loc.lat, lng: loc.lng };
    /* von Hand geänderte Adresse gilt, bis man sich deutlich vom Ort entfernt */
    if (loc.addrManual && loc.addrAt && dist(loc.addrAt, here) > 150) {
      loc.addrManual = false; loc.place = loc.city = loc.suburb = loc.address = ""; geoAt = null; ovDirty = true; chip();
    }
    if (!loc.addrManual && (!geoAt || dist(geoAt, here) > 40) && Date.now() - geoFail > 30000) {
      if (geoAt && dist(geoAt, here) > 1500) { loc.place = loc.city = loc.suburb = loc.address = ""; }
      geoAt = here;
      reverse(here.lat, here.lng).then(function (g) {
        if (geoAt !== here || loc.addrManual) return;
        loc.place = g.place; loc.city = g.city; loc.suburb = g.suburb; loc.address = g.address;
        ovDirty = true; chip(); if (view === "set") drawPreview(); refreshOpen();
      }).catch(function () { if (geoAt === here) { geoAt = null; geoFail = Date.now(); } });
    }
    if (S.fields.map && (!mapAt || dist(mapAt, here) > 25)) {
      mapAt = here;
      miniMap(here.lat, here.lng).then(function (c) { if (mapAt === here) { loc.map = c; ovDirty = true; } })
        .catch(function () { if (mapAt === here) mapAt = null; });
    }
    if (S.fields.weather && Date.now() - wxAt > 15 * 60000) {
      wxAt = Date.now();
      fetchWeather(here.lat, here.lng).then(function (w) { loc.weather = w; ovDirty = true; }).catch(function () { wxAt = 0; });
    }
  }
  /* Standortfreigabe: "search" | "ask" (noch nicht gefragt) | "denied" | "unavail" | "ok" */
  var geoState = "search", geoWatch = null, geoHide = false, geoNoApi = false;
  function geoUi() {
    var need = !geoHide && !hasLoc(loc) && (geoState === "ask" || geoState === "denied" || geoState === "unavail");
    $("#geo-ask").hidden = !need;
    if (need) {
      $("#geo-ask-h").textContent = geoState === "ask" ? "Standort freigeben" : geoState === "denied" ? "Standort ist blockiert" : geoNoApi ? "Kein Standort verfügbar" : "Bitte Standort (GPS) einschalten";
      $("#geo-ask-t").textContent = geoState === "ask"
        ? "GeoCam braucht deinen Standort, um Fotos und Videos mit Ort und Adresse zu stempeln und in der Karte zu zeigen. Dafür muss der Standort (GPS) am Gerät eingeschaltet sein."
        : geoState === "denied"
          ? "Ist der Standort (GPS) am Gerät ausgeschaltet? Dann zuerst einschalten. Sonst bitte erlauben: Schloss-Symbol neben der Adresse → Berechtigungen → Standort → „Zulassen“ (installierte App: App-Symbol lange drücken → App-Info → Website-Einstellungen). Danach „Erneut versuchen“."
          : geoNoApi ? "Dieser Browser unterstützt keine Standortabfrage. Der Ort lässt sich manuell wählen."
            : "GeoCam bekommt keinen Standort. Bitte den Standort (GPS) in den Schnelleinstellungen des Geräts einschalten, dann „Erneut versuchen“ – oder den Ort manuell wählen.";
      $("#geo-ask-btn").textContent = geoState === "ask" ? "Standort freigeben" : "Erneut versuchen";
      $("#geo-ask-btn").hidden = geoNoApi;
    }
    chip();
  }
  var geoSlow = null;
  function watchGeo() {
    var g = navigator.geolocation;
    if (geoWatch !== null) { g.clearWatch(geoWatch); geoWatch = null; }
    if (geoState !== "ok") { geoState = "search"; geoUi(); }
    /* GPS am Gerät aus: der Browser meldet das oft erst nach dem Timeout oder gar nicht -> selbst nach 6 s hinweisen */
    clearTimeout(geoSlow);
    geoSlow = setTimeout(function () { if (geoState === "search" && !gpsRaw) { geoState = "unavail"; geoUi(); } }, 6000);
    geoWatch = g.watchPosition(function (p) {
      clearTimeout(geoSlow);
      gpsRaw = p.coords;
      if (geoState !== "ok") { geoState = "ok"; geoUi(); }
      if (!loc.manual) setLoc(p.coords.latitude, p.coords.longitude, p.coords.altitude, p.coords.accuracy);
    }, function (e) {
      if (e && e.code === 1) { g.clearWatch(geoWatch); geoWatch = null; gpsRaw = null; geoState = "denied"; }
      else if (!gpsRaw) geoState = "unavail";      // Timeout / kein Signal: Watch läuft weiter
      geoUi();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  /* Aufruf aus einer Nutzergeste (Banner-Knopf / Chip) -> der Browser zeigt die Abfrage zuverlässig */
  function requestGeo() {
    if (!navigator.geolocation) return;
    geoHide = false; watchGeo();
  }
  function startGps() {
    if (!navigator.geolocation) { geoNoApi = true; geoState = "unavail"; geoUi(); return; }
    var q = navigator.permissions && navigator.permissions.query ? navigator.permissions.query({ name: "geolocation" }) : Promise.reject();
    q.then(function (st) {
      st.onchange = function () {
        if (st.state === "granted") { if (geoWatch === null) watchGeo(); }
        else if (geoState !== "ok" && geoWatch === null) { geoState = st.state === "denied" ? "denied" : "ask"; geoUi(); }
      };
      if (st.state === "granted") watchGeo();
      else { geoState = st.state === "denied" ? "denied" : "ask"; geoUi(); }
    }).catch(function () { whenCam(watchGeo); });   // Status unbekannt: erst nach der Kamera-Abfrage fragen
  }
  var camDone = false, afterCam = null;
  function camSettle() { camDone = true; if (afterCam) { var f = afterCam; afterCam = null; f(); } }
  function whenCam(f) { if (camDone || view !== "cam") f(); else afterCam = f; }
  var compassOn = false;
  function onOri(e) {
    var h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;
    if (h !== null) loc.heading = (h + 360) % 360;
  }
  function startCompass(fromGesture) {
    if (!S.fields.compass || compassOn || !window.DeviceOrientationEvent) return;
    var add = function () {
      compassOn = true;
      window.addEventListener("deviceorientationabsolute", onOri);
      window.addEventListener("deviceorientation", onOri);
    };
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      if (fromGesture) DeviceOrientationEvent.requestPermission().then(function (r) { if (r === "granted") add(); }).catch(function () {});
    } else add();
  }

  /* ================= Kamera ================= */
  var video = $("#cam-video"), canvas = $("#cam-canvas"), cctx = canvas.getContext("2d");
  var overlay = document.createElement("canvas"), octx = overlay.getContext("2d");
  var camStream = null, camStarting = false, raf = 0, ovT = 0, torchOn = false;
  var rec = null, recChunks = [], recStart = 0, recTick = 0, recAudio = null, recMeta = null, counting = false;

  function loop() {
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || !video.videoWidth) return;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (canvas.width !== vw || canvas.height !== vh) {
      if (rec) return;                       // Format während der Aufnahme nicht wechseln
      canvas.width = overlay.width = vw; canvas.height = overlay.height = vh; ovDirty = true;
    }
    var now = performance.now();
    if (ovDirty || now - ovT > 400) {
      ovT = now; ovDirty = false;
      octx.clearRect(0, 0, vw, vh); drawStamp(octx, vw, vh, liveData());
    }
    cctx.drawImage(video, 0, 0, vw, vh);
    cctx.drawImage(overlay, 0, 0);
  }
  function camFail(e) {
    var n = e && e.name, msg = "Die Kamera konnte nicht gestartet werden.";
    if (n === "NotAllowedError" || n === "SecurityError") msg = "Bitte den Kamerazugriff im Browser erlauben.";
    else if (n === "NotFoundError" || n === "OverconstrainedError") msg = "Auf diesem Gerät wurde keine Kamera gefunden.";
    else if (n === "NotReadableError") msg = "Die Kamera wird gerade von einer anderen App verwendet.";
    $("#cam-fallback-msg").textContent = msg; $("#cam-fallback").hidden = false; camSettle();
  }
  /* Bildschirm wach halten, solange die Kamera läuft (das System gibt die Sperre beim Verlassen selbst frei) */
  var wake = null, wakeReq = false;
  function wakeOn() {
    if (!navigator.wakeLock || wake || wakeReq || document.hidden) return;
    wakeReq = true;
    navigator.wakeLock.request("screen").then(function (w) {
      wakeReq = false;
      if (view !== "cam") { w.release().catch(function () {}); return; }
      wake = w; w.addEventListener("release", function () { if (wake === w) wake = null; });
    }).catch(function () { wakeReq = false; });
  }
  function wakeOff() { if (wake) { var w = wake; wake = null; w.release().catch(function () {}); } }
  /* Zoom über die Kamera selbst (nur wenn das Gerät es anbietet): Zwei-Finger-Geste oder Knopf */
  var zoomCaps = null, zoomV = 1, zoomT = 0, pinch = null;
  function zoomLbl() {
    var b = $("#btn-zoom"); b.hidden = !zoomCaps;
    if (zoomCaps) { $("#zoom-lbl").textContent = de(zoomV / zoomCaps.min, zoomV / zoomCaps.min < 10 ? 1 : 0).replace(/,0$/, "") + "×"; b.classList.toggle("on", zoomV > zoomCaps.min + 0.01); }
  }
  function setZoom(v) {
    if (!zoomCaps || !camStream) return;
    v = Math.max(zoomCaps.min, Math.min(zoomCaps.max, v));
    if (Math.abs(v - zoomV) < 0.005) return;
    zoomV = v; zoomLbl();
    clearTimeout(zoomT);
    zoomT = setTimeout(function () {
      var tr = camStream && camStream.getVideoTracks()[0];
      if (tr) tr.applyConstraints({ advanced: [{ zoom: zoomV }] }).catch(function () {});
    }, 40);
  }
  function zoomStep() {
    if (!zoomCaps) return;
    var f = zoomV / zoomCaps.min, steps = [1, 2, 4, 8].filter(function (s) { return s * zoomCaps.min <= zoomCaps.max + 0.01; });
    var nx = steps.filter(function (s) { return s > f + 0.05; })[0] || 1;
    setZoom(nx * zoomCaps.min);
  }
  function touchDist(e) { var a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function startCamera() {
    wakeOn();
    if (camStream || camStarting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camFail(null); return; }
    camStarting = true;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: S.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    }).then(function (st) {
      camStarting = false; camSettle();
      if (view !== "cam" || document.hidden) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
      camStream = st; video.srcObject = st; $("#cam-fallback").hidden = true;
      var p = video.play(); if (p && p.catch) p.catch(function () {});
      var tr = st.getVideoTracks()[0], caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
      torchOn = false; $("#btn-torch").hidden = !caps.torch; $("#btn-torch").classList.remove("on");
      zoomCaps = caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min || 1, max: caps.zoom.max } : null;
      zoomV = zoomCaps ? zoomCaps.min : 1; zoomLbl();
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    }).catch(function (e) { camStarting = false; camFail(e); });
  }
  function stopCamera() {
    if (rec) stopRec();
    wakeOff();
    cancelAnimationFrame(raf);
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; video.srcObject = null; }
  }
  function setMode(m) {
    if (rec || counting) return;
    S.mode = m; saveS();
    $$(".mode button").forEach(function (b) { b.classList.toggle("on", b.dataset.mode === m); });
    $("#v-cam").classList.toggle("video", m === "video");
  }
  function timerLbl() { $("#timer-lbl").textContent = S.timer ? S.timer + "s" : ""; $("#btn-timer").classList.toggle("on", !!S.timer); }
  function countdown() {
    if (!S.timer) return Promise.resolve();
    counting = true; var el = $("#cam-count"), n = S.timer; el.hidden = false;
    return new Promise(function (res) {
      (function tick() {
        if (n <= 0) { el.hidden = true; counting = false; res(); return; }
        el.textContent = n--; setTimeout(tick, 1000);
      })();
    });
  }
  function thumbOf(src, sw, sh) {
    var T = 320, c = document.createElement("canvas"); c.width = c.height = T;
    var s = Math.min(sw, sh); c.getContext("2d").drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, T, T);
    return c.toDataURL("image/jpeg", 0.72);
  }
  function placeholderThumb(txt) {
    var c = document.createElement("canvas"); c.width = c.height = 320; var g = c.getContext("2d");
    g.fillStyle = "#1e293b"; g.fillRect(0, 0, 320, 320); g.fillStyle = "#94a3b8"; g.font = "600 90px " + FONT;
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, 160, 165);
    return c.toDataURL("image/jpeg", 0.72);
  }
  /* Bildquelle + Stempel -> JPEG (optional mit EXIF-GPS). Liefert {blob, canvas} */
  function renderStamped(src, sw, sh, d, maxSide) {
    var k = maxSide && Math.max(sw, sh) > maxSide ? maxSide / Math.max(sw, sh) : 1;
    var c = document.createElement("canvas"); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    var g = c.getContext("2d"); g.drawImage(src, 0, 0, c.width, c.height); drawStamp(g, c.width, c.height, d);
    return canvasBlob(c, "image/jpeg", S.quality).then(function (b) {
      if (!S.exif || !hasLoc(d)) return { blob: b, canvas: c };
      return b.arrayBuffer().then(function (buf) {
        var u8 = GCExif.insertGps(buf, { lat: d.lat, lng: d.lng, alt: d.alt, date: d.date });
        return { blob: new Blob([u8], { type: "image/jpeg" }), canvas: c };
      });
    });
  }
  /* Bild ohne Stempel als JPEG (das „Original" zum späteren Neu-Stempeln) */
  function plainJpeg(src, sw, sh, maxSide) {
    var k = maxSide && Math.max(sw, sh) > maxSide ? maxSide / Math.max(sw, sh) : 1;
    var c = document.createElement("canvas"); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return canvasBlob(c, "image/jpeg", S.quality);
  }
  /* Stempel aus dem Original neu setzen (nach „Ort/Adresse ändern"). Liefert den neuen Blob oder null, wenn kein Original da ist */
  function restamp(it) {
    if (!it.orig || it.type !== "photo") return Promise.resolve(null);
    return getOrig(it.id).then(function (ob) {
      if (!ob) return null;
      return Promise.all([decodeImage(ob), dataFor(it)]).then(function (a) {
        var sz = imgSize(a[0]);
        return renderStamped(a[0], sz.w, sz.h, a[1]);
      }).then(function (r) {
        it.w = r.canvas.width; it.h = r.canvas.height; it.thumb = thumbOf(r.canvas, it.w, it.h);
        return r.blob;
      });
    }).catch(function (e) { console.warn("restamp", e); return null; });
  }
  function metaFromLive(d, type) {
    return { id: newId(), type: type, ts: d.date.getTime(), lat: hasLoc(d) ? d.lat : null, lng: hasLoc(d) ? d.lng : null,
      alt: d.alt, acc: d.acc, heading: d.heading, place: hasLoc(d) ? loc.place : "", city: hasLoc(d) ? loc.city : "",
      suburb: hasLoc(d) ? loc.suburb : "", address: hasLoc(d) ? loc.address : "", weather: d.weather || "", note: "",
      project: S.project, stamped: true, geoPending: hasLoc(d) && !loc.place && !loc.addrManual };
  }
  function addItem(meta, blob) {
    return putItem(meta, blob).then(function () {
      items.push(meta); items.sort(function (a, b) { return b.ts - a.ts; });
      if (hasLoc(meta)) { mapSel = meta; mapList = null; }   /* neue Aufnahme ist auf der Karte sofort die gewählte */
      lastThumb(); persistOnce(); backfill();
      return meta;
    });
  }
  function saveErr(e) { console.error(e); toast("Speichern fehlgeschlagen – ist der Gerätespeicher voll?", 5000); }
  function takePhoto() {
    if (!camStream || !video.videoWidth) { toast("Kamera ist noch nicht bereit."); return; }
    var fl = $("#cam-flash"); fl.classList.remove("go"); void fl.offsetWidth; fl.classList.add("go");
    var d = liveData(), vw = video.videoWidth, vh = video.videoHeight;
    /* sofort ein Standbild sichern (Rückfall) – das Foto in voller Sensorauflösung kommt etwas später */
    var frame = document.createElement("canvas"); frame.width = vw; frame.height = vh;
    frame.getContext("2d").drawImage(video, 0, 0, vw, vh);
    var tr = camStream.getVideoTracks()[0], src = { im: frame, w: vw, h: vh };
    var hi = S.hiRes && window.ImageCapture && tr ? new Promise(function (res) {
      var t = setTimeout(function () { res(null); }, 5000);
      try {
        new ImageCapture(tr).takePhoto().then(decodeImage).then(function (im) {
          clearTimeout(t); var sz = imgSize(im);
          res(sz.w * sz.h > vw * vh ? { im: im, w: sz.w, h: sz.h } : null);
        }).catch(function () { clearTimeout(t); res(null); });
      } catch (e) { clearTimeout(t); res(null); }
    }) : Promise.resolve(null);
    var orig = null;
    hi.then(function (h) {
      if (h) src = h;
      return S.keepOrig ? plainJpeg(src.im, src.w, src.h, 4096).then(function (b) { orig = b; }).catch(function () {}) : null;
    }).then(function () {
      return renderStamped(src.im, src.w, src.h, d, 4096);
    }).then(function (r) {
      var m = metaFromLive(d, "photo");
      m.mime = "image/jpeg"; m.w = r.canvas.width; m.h = r.canvas.height; m.thumb = thumbOf(r.canvas, m.w, m.h);
      return addItem(m, r.blob).then(function () {
        return orig ? putOrig(m.id, orig).then(function () { m.orig = true; return putItem(m); }).catch(function () {}) : null;
      }).then(function () {
        if (parkArmed) {
          armPark(false);
          return setPark(m.id).then(function () {
            openPark();
            if (!hasLoc(d)) toast("Parkplatz-Foto gespeichert – aber ohne Standort. Bitte den Ort in der Aufnahme setzen.", 6000);
          });
        }
        if (!hasLoc(d)) toast("Ohne Standort gespeichert – Ort lässt sich später setzen.");
      });
    }).catch(saveErr);
  }
  function recMime() {
    var c = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported(c[i])) return c[i];
    return "";
  }
  function startRec() {
    if (!camStream || !video.videoWidth) { toast("Kamera ist noch nicht bereit."); return; }
    if (!window.MediaRecorder || !canvas.captureStream) { toast("Videoaufnahme wird von diesem Browser nicht unterstützt."); return; }
    var audioP = S.audio ? navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () { toast("Ohne Ton – Mikrofon nicht freigegeben."); return null; })
      : Promise.resolve(null);
    audioP.then(function (au) {
      var st = canvas.captureStream(30); recAudio = au;
      if (au) au.getAudioTracks().forEach(function (t) { st.addTrack(t); });
      var mime = recMime(), d = liveData();
      rec = new MediaRecorder(st, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : { videoBitsPerSecond: 6000000 });
      recChunks = []; recMeta = metaFromLive(d, "video");
      recMeta.w = canvas.width; recMeta.h = canvas.height; recMeta.thumb = thumbOf(canvas, canvas.width, canvas.height);
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.onstop = function () {
        var type = (rec.mimeType || mime || "video/webm").split(";")[0], m = recMeta;
        var blob = new Blob(recChunks, { type: type });
        m.mime = type; m.dur = (Date.now() - recStart) / 1000;
        rec = null; recChunks = []; recMeta = null; clearInterval(recTick);
        if (recAudio) { recAudio.getTracks().forEach(function (t) { t.stop(); }); recAudio = null; }
        $("#v-cam").classList.remove("rec"); $("#cam-rec").hidden = true;
        if (!blob.size) { toast("Die Aufnahme war leer."); return; }
        addItem(m, blob).then(function () { toast("Video gespeichert."); }).catch(saveErr);
      };
      recStart = Date.now(); rec.start(1000);
      var maxS = (Number(S.maxRec) || 10) * 60, maxTxt = " / " + fmtDur(maxS), warned = false;
      $("#v-cam").classList.add("rec"); $("#cam-rec").hidden = false; $("#rec-time").textContent = "00:00" + maxTxt;
      recTick = setInterval(function () {
        var s = (Date.now() - recStart) / 1000;
        $("#rec-time").textContent = fmtDur(s) + maxTxt;
        /* das Video liegt bis zum Speichern im Arbeitsspeicher → Länge begrenzen */
        if (s >= maxS) { stopRec(); toast("Maximale Videolänge erreicht – Aufnahme gespeichert. Die Grenze lässt sich in den Einstellungen ändern.", 6000); }
        else if (!warned && maxS - s <= 30) { warned = true; toast("Noch 30 Sekunden bis zur maximalen Videolänge."); }
      }, 500);
      spaceCheck(maxS);
    });
  }
  /* freier Speicher vs. erwartete Videogröße (ca. 6 Mbit/s ≈ 45 MB je Minute) */
  function spaceCheck(maxS) {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then(function (e) {
      if (!e || !e.quota) return;
      var free = e.quota - (e.usage || 0), min = Math.floor(free / 45e6);
      if (min < maxS / 60) toast(min < 1 ? "Der Speicher ist fast voll – das Video lässt sich womöglich nicht speichern. Bitte zuerst Aufnahmen sichern und löschen."
        : "Wenig Speicher frei: reicht für etwa " + min + (min === 1 ? " Minute" : " Minuten") + " Video.", 6000);
    }).catch(function () {});
  }
  function stopRec() { if (rec && rec.state !== "inactive") rec.stop(); }
  function shutter() {
    startCompass(true);
    if (counting) return;
    if (rec) { stopRec(); return; }
    if (!hasLoc(loc)) { geoHide = false; if (geoState === "search") geoState = "unavail"; geoUi(); toast("Kein Standort – bitte GPS am Gerät einschalten. Die Aufnahme wird ohne Ort gespeichert.", 4500); }
    else if (!loc.manual && loc.acc > 50) toast("GPS noch ungenau (± " + Math.round(loc.acc) + " m) – der Ort kann daneben liegen. Kurz warten oder den Ort später in der Aufnahme korrigieren.", 5000);
    countdown().then(function () { if (view !== "cam") return; if (S.mode === "video") startRec(); else takePhoto(); });
  }
  function lastThumb() {
    var b = $("#btn-last"), it = items[0];
    b.style.backgroundImage = it ? 'url("' + it.thumb + '")' : ""; b.style.backgroundSize = "cover"; b.style.backgroundPosition = "center";
  }
  var persisted = false;
  function persistOnce() {
    if (persisted || !navigator.storage || !navigator.storage.persist) return;
    persisted = true; navigator.storage.persist().catch(function () {});
  }

  /* ================= Import ================= */
  function decodeImage(blob) {
    var viaTag = function () {
      return new Promise(function (res, rej) {
        var u = URL.createObjectURL(blob), im = new Image();
        im.onload = function () { URL.revokeObjectURL(u); res(im); };
        im.onerror = function () { URL.revokeObjectURL(u); rej(new Error("Bildformat wird nicht unterstützt")); };
        im.src = u;
      });
    };
    if (window.createImageBitmap) return createImageBitmap(blob, { imageOrientation: "from-image" }).catch(viaTag);
    return viaTag();
  }
  function imgSize(im) { return { w: im.naturalWidth || im.width, h: im.naturalHeight || im.height }; }
  function videoInfo(blob) {
    return new Promise(function (res) {
      var v = document.createElement("video"), u = URL.createObjectURL(blob), done = false;
      var fin = function (r) { if (done) return; done = true; URL.revokeObjectURL(u); res(r); };
      v.muted = true; v.playsInline = true; v.preload = "auto";
      v.onloadeddata = function () { try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); } catch (e) { fin(null); } };
      v.onseeked = function () {
        try { fin({ thumb: thumbOf(v, v.videoWidth, v.videoHeight), w: v.videoWidth, h: v.videoHeight, dur: isFinite(v.duration) ? v.duration : 0 }); }
        catch (e) { fin(null); }
      };
      v.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 7000);
      v.src = u;
    });
  }
  /* Stempeldaten für eine gespeicherte Position (Adresse/Karte online nachladen, kein Live-Wetter) */
  function dataFor(o) {
    var d = { lat: o.lat, lng: o.lng, alt: o.alt, acc: o.acc, heading: o.heading, place: o.place || "", address: o.address || "",
      city: o.city || "", suburb: o.suburb || "", weather: o.weather || "", date: new Date(o.ts), note: S.note, map: null };
    if (!hasLoc(d) || !online()) return Promise.resolve(d);
    var a = d.place ? Promise.resolve() : reverse(d.lat, d.lng).then(function (g) {
      d.place = g.place; d.city = g.city; d.suburb = g.suburb; d.address = g.address;
    }).catch(function () {});
    var b = S.fields.map ? miniMap(d.lat, d.lng).then(function (c) { d.map = c; }).catch(function () {}) : Promise.resolve();
    return Promise.all([a, b]).then(function () { return d; });
  }
  function importImage(file, live) {
    var isJpeg = /jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name);
    return file.slice(0, 262144).arrayBuffer().then(function (head) {
      var ex = isJpeg ? GCExif.read(head) : null;
      var m = { id: newId(), type: "photo", ts: (ex && ex.ts) || file.lastModified || Date.now(), lat: null, lng: null, alt: null,
        acc: null, heading: null, place: "", city: "", suburb: "", address: "", weather: "", note: "", project: S.project,
        mime: file.type || "image/jpeg", stamped: false, geoPending: false };
      var liveD = null;
      if (ex && ex.lat !== null) { m.lat = ex.lat; m.lng = ex.lng; m.alt = ex.alt; }
      else if (live && hasLoc(loc)) { liveD = liveData(); Object.assign(m, metaFromLive(liveD, "photo"), { id: m.id, stamped: false }); }
      return decodeImage(file).then(function (im) {
        var sz = imgSize(im); m.w = sz.w; m.h = sz.h;
        if (!hasLoc(m) || !(S.stampImport || live)) {
          m.thumb = thumbOf(im, sz.w, sz.h); m.geoPending = hasLoc(m) && !m.place;
          return addItem(m, file);
        }
        return (liveD ? Promise.resolve(liveD) : dataFor(m)).then(function (d) {
          if (!liveD) { m.place = d.place; m.city = d.city; m.suburb = d.suburb; m.address = d.address; }
          return renderStamped(im, sz.w, sz.h, d, 4096);
        }).then(function (r) {
          m.w = r.canvas.width; m.h = r.canvas.height; m.mime = "image/jpeg"; m.stamped = true;
          m.thumb = thumbOf(r.canvas, m.w, m.h); m.geoPending = !m.place;
          return addItem(m, r.blob);
        }).then(function (res) {
          if (!S.keepOrig) return res;
          return plainJpeg(im, sz.w, sz.h, 4096).then(function (ob) { return putOrig(m.id, ob); })
            .then(function () { m.orig = true; return putItem(m); }).catch(function () {}).then(function () { return res; });
        });
      });
    });
  }
  function importVideo(file) {
    return videoInfo(file).then(function (v) {
      var m = { id: newId(), type: "video", ts: file.lastModified || Date.now(), lat: null, lng: null, alt: null, acc: null,
        heading: null, place: "", city: "", suburb: "", address: "", weather: "", note: "", project: S.project,
        mime: file.type || "video/mp4", stamped: false, geoPending: false,
        w: v ? v.w : 0, h: v ? v.h : 0, dur: v ? v.dur : 0, thumb: v ? v.thumb : placeholderThumb("▶") };
      return addItem(m, file);
    });
  }
  function importFiles(files, live) {
    files = Array.prototype.slice.call(files || []); if (!files.length) return;
    var ok = 0, bad = 0, noLoc = 0, i = 0;
    busy("Importiere 1 von " + files.length + " …");
    (function next() {
      if (i >= files.length) {
        unbusy(); render();
        var msg = ok + (ok === 1 ? " Aufnahme" : " Aufnahmen") + " importiert";
        if (noLoc) msg += " · " + noLoc + " ohne Standort (Ort in der Detailansicht setzen)";
        if (bad) msg += " · " + bad + " nicht lesbar";
        toast(msg + ".", 5000); return;
      }
      var f = files[i++]; busy("Importiere " + i + " von " + files.length + " …");
      var p = /^video\//.test(f.type) ? importVideo(f) : importImage(f, live);
      p.then(function (m) { ok++; if (m && !hasLoc(m)) noLoc++; }).catch(function (e) { console.warn("Import", f.name, e); bad++; }).then(next);
    })();
  }

  /* fehlende Ortsnamen nachtragen (z. B. offline aufgenommen) */
  var bfRun = false;
  function backfill() {
    if (bfRun || !online()) return;
    var todo = items.filter(function (it) { return it.geoPending && hasLoc(it); });
    if (!todo.length) return;
    bfRun = true; var changed = false;
    (function next() {
      var it = todo.shift();
      if (!it) { bfRun = false; if (changed) render(); return; }
      reverse(it.lat, it.lng).then(function (g) {
        it.place = g.place; it.city = g.city; it.suburb = g.suburb; it.address = g.address; it.geoPending = false; changed = true;
        return putItem(it);
      }).then(next, function () { bfRun = false; if (changed) render(); });
    })();
  }

  /* ================= Galerie ================= */
  var PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-6.200 7-12a7 7 0 1 0-14 0c0 5.800 7 12 7 12z"/><circle cx="12" cy="10" r="2.500"/></svg>';
  function groupOf(it) {
    if (!hasLoc(it)) return { key: "~none", label: "Ohne Ort", none: true };
    if (it.city) {
      var l = S.groupBy === "suburb" && it.suburb ? it.city + " – " + it.suburb : it.city;
      return { key: "c:" + l, label: l };
    }
    if (it.place) return { key: "c:" + it.place, label: it.place };
    var a = Math.round(it.lat / 0.02) * 0.02, b = Math.round(it.lng / 0.02) * 0.02;
    return { key: "g:" + a.toFixed(2) + "," + b.toFixed(2), label: "Bei " + de(Math.abs(a), 2) + "° " + (a >= 0 ? "N" : "S") + ", " + de(Math.abs(b), 2) + "° " + (b >= 0 ? "O" : "W") };
  }
  /* Filter (Art, Zeitraum, Projekt) und Mehrfachauswahl */
  var galF = { type: "", proj: "", range: "" }, galShown = [], selMode = false, sel = {};
  function galFrom() {
    var n = new Date(), day = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    if (galF.range === "today") return day;
    if (galF.range === "7") return day - 6 * 864e5;
    if (galF.range === "30") return day - 29 * 864e5;
    if (galF.range === "year") return new Date(n.getFullYear(), 0, 1).getTime();
    return 0;
  }
  function galProjects() {
    var s = $("#gal-proj"), seen = {}, names = [];
    items.forEach(function (it) { if (it.project && !seen[it.project]) { seen[it.project] = 1; names.push(it.project); } });
    names.sort(function (a, b) { return a.localeCompare(b, "de"); });
    if (galF.proj && !seen[galF.proj]) galF.proj = "";
    if (s.dataset.k !== names.join("\n")) {
      s.dataset.k = names.join("\n"); s.textContent = "";
      [""].concat(names).forEach(function (n) { var o = document.createElement("option"); o.value = n; o.textContent = n || "Alle Projekte"; s.appendChild(o); });
    }
    s.value = galF.proj; s.hidden = !names.length;
  }
  function selList() { return items.filter(function (it) { return sel[it.id]; }); }
  function selUi() {
    var n = selList().length;
    $("#btn-sel").textContent = selMode ? "Fertig" : "Auswählen"; $("#btn-sel").hidden = !items.length && !selMode;
    $("#sel-bar").hidden = !selMode; $("#v-gal").classList.toggle("selecting", selMode);
    $("#sel-n").textContent = n + " ausgewählt";
    $$("#sel-bar [data-need]").forEach(function (b) { b.disabled = !n; });
    $("#sel-all").textContent = galShown.length && galShown.every(function (it) { return sel[it.id]; }) ? "Keine" : "Alle";
  }
  function selEnd() { selMode = false; sel = {}; renderGallery(); }
  /* Dateien samt eindeutigen Namen laden (nacheinander, damit der Speicher nicht überläuft) */
  function loadFiles(list, each) {
    var used = {}, i = 0;
    return (function next() {
      if (i >= list.length) return Promise.resolve();
      var it = list[i++];
      return getBlob(it.id).then(function (b) {
        if (!b) return null;
        var name = fileName(it), k = 1, base = name.replace(/\.[^.]+$/, ""), ext = name.slice(base.length);
        while (used[name]) name = base + "_" + (++k) + ext;
        used[name] = 1;
        return each({ name: name, blob: b, ts: it.ts, it: it }, i);
      }).then(next);
    })();
  }
  /* ZIP ohne Kompression (Fotos/Videos sind schon komprimiert) – kleiner eigener Schreiber, keine Fremdbibliothek */
  var crcT = null;
  function crc32(u8, c) {
    if (!crcT) { crcT = new Uint32Array(256); for (var n = 0; n < 256; n++) { var v = n; for (var k = 0; k < 8; k++) v = v & 1 ? 0xEDB88320 ^ (v >>> 1) : v >>> 1; crcT[n] = v >>> 0; } }
    c = ~c; for (var i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  }
  function zipOf(list, label) {
    var total = 0, parts = [], cen = [], off = 0, cnt = 0, enc = new TextEncoder();
    var hdr = function (n) { var b = new ArrayBuffer(n); return { b: b, v: new DataView(b) }; };
    return loadFiles(list, function (f, i) {
      busy(label + " " + i + " von " + list.length + " …");
      total += f.blob.size;
      if (total > 3.9e9 || cnt >= 65000) throw new Error("zip-size");
      return f.blob.arrayBuffer().then(function (buf) {
        var crc = crc32(new Uint8Array(buf), 0), nm = enc.encode(f.name), d = new Date(f.ts);
        var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        var date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        var l = hdr(30); l.v.setUint32(0, 0x04034b50, true); l.v.setUint16(4, 20, true); l.v.setUint16(6, 0x0800, true);
        l.v.setUint16(10, time, true); l.v.setUint16(12, date, true); l.v.setUint32(14, crc, true);
        l.v.setUint32(18, buf.byteLength, true); l.v.setUint32(22, buf.byteLength, true); l.v.setUint16(26, nm.length, true);
        var c = hdr(46); c.v.setUint32(0, 0x02014b50, true); c.v.setUint16(4, 20, true); c.v.setUint16(6, 20, true); c.v.setUint16(8, 0x0800, true);
        c.v.setUint16(12, time, true); c.v.setUint16(14, date, true); c.v.setUint32(16, crc, true);
        c.v.setUint32(20, buf.byteLength, true); c.v.setUint32(24, buf.byteLength, true); c.v.setUint16(28, nm.length, true);
        c.v.setUint32(42, off, true);
        parts.push(l.b, nm, f.blob); cen.push(c.b, nm);   /* der Blob selbst bleibt auf der Platte, nur CRC wurde gelesen */
        off += 30 + nm.length + buf.byteLength; cnt++;
      });
    }).then(function () {
      if (!cnt) throw new Error("zip-empty");
      var size = cen.reduce(function (s, p) { return s + p.byteLength; }, 0), e = hdr(22);
      e.v.setUint32(0, 0x06054b50, true); e.v.setUint16(8, cnt, true); e.v.setUint16(10, cnt, true);
      e.v.setUint32(12, size, true); e.v.setUint32(16, off, true);
      return new Blob(parts.concat(cen, [e.b]), { type: "application/zip" });
    });
  }
  function zipName() { var d = new Date(); return "GeoCam_Export_" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" + p2(d.getHours()) + p2(d.getMinutes()) + ".zip"; }
  function exportZip(list) {
    if (!list.length) { toast("Es gibt noch keine Aufnahmen."); return Promise.resolve(); }
    busy("Sicherung wird erstellt …");
    return zipOf(list, "Sichere").then(function (z) {
      download(z, zipName());
      toast(list.length + (list.length === 1 ? " Aufnahme" : " Aufnahmen") + " als ZIP gesichert (" + de(z.size / 1048576, 1) + " MB).", 5000);
    }).catch(function (e) {
      console.warn("zip", e);
      toast(e && e.message === "zip-size" ? "Zu groß für eine einzelne ZIP-Datei (über 3,9 GB) – bitte in der Galerie in Teilen auswählen und sichern."
        : "Die Sicherung konnte nicht erstellt werden – womöglich reicht der Arbeitsspeicher nicht. Bitte weniger Aufnahmen auswählen.", 7000);
    }).then(unbusy);
  }
  function selDownload() {
    var l = selList(); if (!l.length) return;
    if (l.length > 1) { exportZip(l).then(selEnd); return; }
    getBlob(l[0].id).then(function (b) { if (b) download(b, fileName(l[0])); selEnd(); }).catch(saveErr);
  }
  function selShare() {
    var l = selList(), files = []; if (!l.length) return;
    if (!navigator.canShare || !window.File) { toast("Teilen mehrerer Dateien wird hier nicht unterstützt – bitte „Herunterladen“ nutzen.", 4500); return; }
    busy("Wird vorbereitet …");
    loadFiles(l, function (f) { files.push(new File([f.blob], f.name, { type: f.it.mime })); }).then(function () {
      unbusy();
      if (!files.length || !navigator.canShare({ files: files })) { toast("Diese Auswahl lässt sich hier nicht teilen – bitte „Herunterladen“ nutzen.", 4500); return; }
      return navigator.share({ files: files, title: "GeoCam" }).then(selEnd, function (e) {
        /* nach dem Laden kann die Nutzergeste verfallen sein */
        if (e && e.name === "NotAllowedError") toast("Teilen wurde vom Browser blockiert – bitte weniger Aufnahmen wählen oder „Herunterladen“ nutzen.", 5000);
      });
    }).catch(function (e) { unbusy(); saveErr(e); });
  }
  function selDelete() {
    var l = selList(); if (!l.length) return;
    if (!confirm(l.length + (l.length === 1 ? " Aufnahme" : " Aufnahmen") + " endgültig löschen?")) return;
    var park = l.some(function (it) { return it.id === parkId; });
    Promise.all(l.map(function (it) { return delItem(it.id); })).then(function () {
      items = items.filter(function (it) { return !sel[it.id]; });
      return park ? setPark(null) : null;
    }).then(function () {
      selMode = false; sel = {}; render(); lastThumb();
      toast(l.length + (l.length === 1 ? " Aufnahme gelöscht." : " Aufnahmen gelöscht."));
    }).catch(saveErr);
  }
  function renderGallery() {
    var list = $("#gal-list"), q = $("#gal-search").value.trim().toLowerCase();
    list.textContent = "";
    galProjects();
    var from = galFrom(), filt = !!(q || galF.type || galF.proj || galF.range);
    var shown = items.filter(function (it) {
      if (galF.type && it.type !== galF.type) return false;
      if (galF.proj && (it.project || "") !== galF.proj) return false;
      if (from && it.ts < from) return false;
      if (!q) return true;
      return [it.place, it.city, it.suburb, it.address, it.note, it.project].join(" ").toLowerCase().indexOf(q) >= 0;
    });
    galShown = shown; selUi();
    var empty = $("#gal-empty"); empty.hidden = shown.length > 0;
    if (!shown.length) {
      $("b", empty).textContent = items.length ? "Keine Treffer" : "Noch keine Aufnahmen";
      $("span", empty).textContent = items.length ? (filt && !q ? "Für diesen Filter wurde nichts gefunden." : "Für diese Suche wurde nichts gefunden.") : "Fotos und Videos erscheinen hier – automatisch nach Ort sortiert.";
      return;
    }
    var groups = [], idx = {};
    shown.forEach(function (it) {
      var g;
      if (S.sort === "date") {
        var d = new Date(it.ts), k = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
        g = { key: k, label: d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) };
      } else g = groupOf(it);
      if (!idx[g.key]) { idx[g.key] = { label: g.label, none: g.none, list: [] }; groups.push(idx[g.key]); }
      idx[g.key].list.push(it);
    });
    if (S.sort !== "date") groups.sort(function (a, b) { return (a.none ? 1 : 0) - (b.none ? 1 : 0) || a.label.localeCompare(b.label, "de"); });
    groups.forEach(function (g) {
      var sec = document.createElement("section"); sec.className = "grp";
      var h = document.createElement("div"); h.className = "grp-h"; h.innerHTML = PIN_SVG;
      var b = document.createElement("b"); b.textContent = g.label; h.appendChild(b);
      var sp = document.createElement("span"); sp.textContent = g.list.length + (g.list.length === 1 ? " Aufnahme" : " Aufnahmen"); h.appendChild(sp);
      var geo = g.list.filter(hasLoc);
      if (geo.length) {
        var mb = document.createElement("button"); mb.type = "button"; mb.textContent = "Karte";
        mb.addEventListener("click", function () { show("map", geo); }); h.appendChild(mb);
      }
      sec.appendChild(h);
      var grid = document.createElement("div"); grid.className = "grid";
      g.list.forEach(function (it) {
        var t = document.createElement("button"); t.type = "button"; t.className = "th"; t.dataset.id = it.id;
        var im = document.createElement("img"); im.loading = "lazy"; im.alt = it.place || "Aufnahme"; im.src = it.thumb; t.appendChild(im);
        if (it.type === "video") { var v = document.createElement("span"); v.className = "vid"; v.textContent = "▶ " + fmtDur(it.dur); t.appendChild(v); }
        if (it.id === parkId) { var pk = document.createElement("span"); pk.className = "pk"; pk.textContent = "P"; t.appendChild(pk); }
        if (sel[it.id]) t.classList.add("sel");
        t.addEventListener("click", function () {
          if (!selMode) { openDetail(it.id); return; }
          if (sel[it.id]) delete sel[it.id]; else sel[it.id] = true;
          t.classList.toggle("sel", !!sel[it.id]); selUi();
        });
        /* langer Druck startet die Auswahl */
        t.addEventListener("contextmenu", function (e) {
          e.preventDefault(); if (selMode) return;
          selMode = true; sel = {}; sel[it.id] = true; renderGallery();
        });
        grid.appendChild(t);
      });
      sec.appendChild(grid); list.appendChild(sec);
    });
  }

  /* ================= Karte (Google Maps) =================
     Eingebettete Google-Maps-Karte ohne API-Schlüssel: Sie zeigt immer einen Ort. Die Aufnahmen
     liegen als Bildleiste darunter – antippen springt auf der Karte zu diesem Ort. */
  var mapSel = null, mapList = null, mapSrc = null;
  function gmapUrl(lat, lng, z) {
    return "https://www.google.com/maps?q=" + lat.toFixed(6) + "," + lng.toFixed(6) + "&z=" + z + "&hl=de&output=embed";
  }
  /* iframe jedes Mal neu anlegen: ein geändertes src würde einen Verlaufseintrag erzeugen (Zurück-Taste der Sheets) */
  function gmapShow(url) {
    if (url === mapSrc) return false; mapSrc = url;
    var box = $("#map"); box.textContent = "";
    if (!url) { var p = document.createElement("p"); p.textContent = "Die Google-Maps-Karte braucht eine Internetverbindung."; box.appendChild(p); return true; }
    var f = document.createElement("iframe");
    f.title = "Google-Maps-Karte"; f.setAttribute("allowfullscreen", ""); f.referrerPolicy = "no-referrer"; f.src = url;
    box.appendChild(f);
    return true;
  }
  /* Foto der gewählten Aufnahme über der Stecknadel. Die eingebettete Karte meldet kein Verschieben –
     sobald sie berührt wird (Fokus wandert ins iframe), rückt das Foto in die Ecke, statt falsch zu zeigen. */
  function gmapPhoto(it, fresh) {
    var box = $("#map"), b = $(".gc-bub", box);
    if (!it) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement("button"); b.type = "button"; b.className = "gc-bub"; b.appendChild(document.createElement("img"));
      b.addEventListener("click", function () { if (mapSel) openDetail(mapSel.id); });
      box.appendChild(b); fresh = true;
    }
    if (fresh) b.classList.remove("dock");
    var im = b.firstChild; im.src = it.thumb; im.alt = it.place || "Aufnahme";
    b.title = "Aufnahme öffnen";
  }
  window.addEventListener("blur", function () {
    var a = document.activeElement, b = $("#map .gc-bub");
    if (b && a && a.tagName === "IFRAME" && $("#map").contains(a)) b.classList.add("dock");
  });
  function renderMap() {
    var all = items.filter(hasLoc);
    var list = mapList ? mapList.filter(function (it) { return items.indexOf(it) >= 0 && hasLoc(it); }) : all;
    if (mapList && !list.length) { mapList = null; list = all; }
    if (list.indexOf(mapSel) < 0) mapSel = list[0] || null;
    $("#map-empty").hidden = all.length > 0;
    var strip = $("#map-strip"); strip.textContent = ""; strip.hidden = !list.length;
    if (mapList && list.length < all.length) {
      var ab = document.createElement("button"); ab.type = "button"; ab.className = "map-all"; ab.textContent = "Alle Orte";
      ab.addEventListener("click", function () { mapList = null; ovFit = true; renderMap(); }); strip.appendChild(ab);
    }
    var selEl = null;
    list.forEach(function (it) {
      var t = document.createElement("button"); t.type = "button"; t.className = "th" + (it === mapSel ? " on" : ""); t.dataset.id = it.id;
      var im = document.createElement("img"); im.loading = "lazy"; im.alt = it.place || "Aufnahme"; im.src = it.thumb; t.appendChild(im);
      if (it.type === "video") { var v = document.createElement("span"); v.className = "vid"; v.textContent = "▶"; t.appendChild(v); }
      if (it.id === parkId) { var pk = document.createElement("span"); pk.className = "pk"; pk.textContent = "P"; t.appendChild(pk); }
      t.addEventListener("click", function () { if (it === mapSel) openDetail(it.id); else { mapSel = it; ovPan = true; renderMap(); } });
      if (it === mapSel) selEl = t;
      strip.appendChild(t);
    });
    if (selEl) strip.scrollLeft = Math.max(0, selEl.offsetLeft - (strip.clientWidth - selEl.offsetWidth) / 2);
    var bar = $("#map-bar"); bar.hidden = !mapSel;
    if (mapSel) {
      $("#map-place").textContent = mapSel.place || mapSel.address || fmtCoords(mapSel.lat, mapSel.lng);
      $("#map-sub").textContent = [mapSel.place ? mapSel.address : "", fmtDate(new Date(mapSel.ts))].filter(Boolean).join(" · ");
      $("#map-ext").href = mapsShow(mapSel);
    }
    var ov = S.mapKind !== "g" && !!window.L;
    $$("#map-mode button").forEach(function (b) { b.classList.toggle("on", (b.dataset.mode === "g") !== ov); });
    $("#map-ov").hidden = !ov; $("#map").hidden = ov;
    if (ov) { ovShow(list); return; }
    if (navigator.onLine === false) { gmapShow(""); gmapPhoto(null); }
    else if (mapSel) gmapPhoto(mapSel, gmapShow(gmapUrl(mapSel.lat, mapSel.lng, 17)));
    else if (hasLoc(loc)) gmapShow(gmapUrl(loc.lat, loc.lng, 14));
    else gmapShow("https://www.google.com/maps?q=Deutschland&z=6&hl=de&output=embed");
  }
  /* Übersicht: alle Aufnahmen als Pins auf einer OpenStreetMap-Karte (Leaflet) */
  var ovMap = null, ovLayer = null, ovFit = true, ovPan = false;
  function ovShow(list) {
    if (!ovMap) {
      ovMap = L.map("map-ov", { maxZoom: 19 });
      L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTR }).addTo(ovMap);
      ovLayer = L.layerGroup().addTo(ovMap); ovFit = true;
    }
    ovMap.invalidateSize(); ovLayer.clearLayers();
    var pts = [];
    if (hasLoc(loc)) L.marker([loc.lat, loc.lng], { interactive: false, keyboard: false, zIndexOffset: -500,
      icon: L.divIcon({ className: "", html: '<div class="gc-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(ovLayer);
    list.forEach(function (it) {
      var park = it.id === parkId, on = it === mapSel;
      pts.push([it.lat, it.lng]);
      /* Marker = Vorschaubild der Aufnahme (Parkplatz zusätzlich mit „P") */
      var el = document.createElement("div"); el.className = "gc-ph" + (on ? " sel" : "");
      var im = document.createElement("img"); im.alt = ""; im.src = it.thumb; el.appendChild(im);
      if (park) { var pb = document.createElement("b"); pb.textContent = "P"; el.appendChild(pb); }
      L.marker([it.lat, it.lng], { zIndexOffset: on ? 1000 : park ? 500 : 0, title: it.place || "Aufnahme",
        icon: L.divIcon({ className: "", html: el, iconSize: [48, 48], iconAnchor: [24, 57] }) })
        .on("click", function () { if (it === mapSel) return; mapSel = it; renderMap(); }).addTo(ovLayer);
    });
    if (ovFit) {
      if (pts.length > 1) ovMap.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
      else if (pts.length) ovMap.setView(pts[0], 16);
      else if (hasLoc(loc)) ovMap.setView([loc.lat, loc.lng], 14);
      else ovMap.setView([51.2, 10.4], 6);
    } else if (ovPan && mapSel) ovMap.panTo([mapSel.lat, mapSel.lng]);
    ovFit = ovPan = false;
  }

  /* ================= Sheets (Android-Zurück schließt) ================= */
  var sheets = [];
  function openSheet(el, onClose) {
    el.hidden = false; sheets.push({ el: el, onClose: onClose });
    el.style.zIndex = 1000 + sheets.length;   /* später geöffnete Sheets liegen oben */
    try { history.pushState({ gc: sheets.length }, ""); } catch (e) {}
  }
  function closeSheet() { if (sheets.length) history.back(); }
  window.addEventListener("popstate", function () {
    var s = sheets.pop(); if (!s) return;
    s.el.hidden = true; if (s.onClose) s.onClose();
  });

  /* ================= Detailansicht ================= */
  var cur = null;   // {it, blob, url}
  function extOf(mime) {
    var m = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "video/mp4": "mp4",
      "video/webm": "webm", "video/quicktime": "mov" };
    return m[mime] || (mime || "").split("/")[1] || "bin";
  }
  function fileName(it) {
    var d = new Date(it.ts), slug = (it.city || it.place || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
    return "GeoCam_" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" + p2(d.getHours()) + p2(d.getMinutes()) +
      p2(d.getSeconds()) + (slug ? "_" + slug : "") + "." + extOf(it.mime);
  }
  function fillDetail() {
    var it = cur.it, geo = hasLoc(it);
    $("#d-title").textContent = it.place || (geo ? "Aufnahme" : "Ohne Ort");
    var nav = $("#d-nav"), sh = $("#d-show");
    nav.classList.toggle("off", !geo); sh.classList.toggle("off", !geo);
    if (geo) { nav.href = mapsNav(it); sh.href = mapsShow(it); } else { nav.removeAttribute("href"); sh.removeAttribute("href"); }
    $("#d-stamp").hidden = !(it.type === "photo" && !it.stamped && geo);
    $("#d-loc").textContent = geo ? "Ort ändern" : "Ort setzen";
    $("#d-qr").classList.toggle("off", !geo);
    $("#d-park").textContent = it.id === parkId ? "Mein Parkplatz ✓" : "Als Parkplatz merken";
    var dl = $("#d-info"); dl.textContent = "";
    var row = function (k, v) {
      if (!v) return;
      var dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    };
    row("Ort", it.place || (geo ? (it.geoPending ? "wird ermittelt, sobald Internet besteht" : "") : "kein Standort gespeichert"));
    row("Adresse", it.address);
    row("Koordinaten", geo ? fmtCoords(it.lat, it.lng) : "");
    row("Höhe", typeof it.alt === "number" ? Math.round(it.alt) + " m" : "");
    row("Genauigkeit", typeof it.acc === "number" ? "± " + Math.round(it.acc) + " m" : "");
    row("Aufgenommen", fmtDate(new Date(it.ts)));
    row("Wetter", it.weather);
    row("Projekt", it.project);
    row("Datei", (it.type === "video" ? "Video" : "Foto") + (it.w ? " · " + it.w + " × " + it.h : "") +
      (it.type === "video" && it.dur ? " · " + fmtDur(it.dur) + " min" : "") +
      (cur.blob ? " · " + de(cur.blob.size / 1048576, 1) + " MB" : "") + (it.stamped ? " · gestempelt" : ""));
    $("#d-note").value = it.note || "";
  }
  function showMedia() {
    var box = $("#d-media"); box.textContent = "";
    if (cur.url) URL.revokeObjectURL(cur.url);
    cur.url = URL.createObjectURL(cur.blob);
    var el;
    if (cur.it.type === "video") { el = document.createElement("video"); el.controls = true; el.playsInline = true; el.preload = "metadata"; }
    else { el = document.createElement("img"); el.alt = cur.it.place || "Aufnahme"; }
    el.src = cur.url; box.appendChild(el);
  }
  function openDetail(id) {
    var it = items.find(function (x) { return x.id === id; }); if (!it) return;
    getBlob(id).then(function (blob) {
      if (!blob) { toast("Die Datei wurde nicht gefunden."); return; }
      cur = { it: it, blob: blob, url: null };
      showMedia(); fillDetail();
      openSheet($("#detail"), function () {
        if (cur && cur.url) URL.revokeObjectURL(cur.url);
        $("#d-media").textContent = ""; cur = null; render();
      });
    }).catch(saveErr);
  }
  function download(blob, name) {
    var u = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
  }
  function share() {
    var it = cur.it, name = fileName(it), file;
    try { file = new File([cur.blob], name, { type: it.mime }); } catch (e) { file = null; }
    var text = [it.place, it.address, hasLoc(it) ? mapsShow(it) : ""].filter(Boolean).join("\n");
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: it.place || "GeoCam", text: text }).catch(function () {});
    } else if (navigator.share && hasLoc(it)) {
      navigator.share({ title: it.place || "GeoCam", text: text }).catch(function () {});
    } else { download(cur.blob, name); toast("Teilen wird hier nicht unterstützt – Datei wurde heruntergeladen."); }
  }
  function burnStamp() {
    var it = cur.it; busy("Stempel wird eingebrannt …");
    Promise.all([decodeImage(cur.blob), dataFor(it)]).then(function (a) {
      var sz = imgSize(a[0]), d = a[1];
      if (d.place && !it.place) { it.place = d.place; it.city = d.city; it.suburb = d.suburb; it.address = d.address; it.geoPending = false; }
      return renderStamped(a[0], sz.w, sz.h, d, 4096);
    }).then(function (r) {
      it.w = r.canvas.width; it.h = r.canvas.height; it.mime = "image/jpeg"; it.stamped = true; it.thumb = thumbOf(r.canvas, it.w, it.h);
      var ob = S.keepOrig ? cur.blob : null;   /* die bisherige Datei ist das ungestempelte Original */
      return putItem(it, r.blob).then(function () {
        return ob ? putOrig(it.id, ob).then(function () { it.orig = true; return putItem(it); }).catch(function () {}) : null;
      }).then(function () { cur.blob = r.blob; showMedia(); fillDetail(); lastThumb(); toast("Stempel eingebrannt."); });
    }).catch(function (e) { console.error(e); toast("Das Bild konnte nicht gestempelt werden."); }).then(unbusy);
  }
  function setItemLoc(it, lat, lng) {
    it.lat = lat; it.lng = lng; it.alt = null; it.acc = null; it.place = it.city = it.suburb = it.address = ""; it.geoPending = true; it.addrManual = false;
    var wasStamped = it.stamped;
    var geoP = online() ? reverse(lat, lng).then(function (g) {
      it.place = g.place; it.city = g.city; it.suburb = g.suburb; it.address = g.address; it.geoPending = false;
    }).catch(function () {}) : Promise.resolve();
    /* EXIF nur bei von GeoCam erzeugten JPEGs neu schreiben (Originale behalten ihre Metadaten) */
    var blobP = wasStamped && it.mime === "image/jpeg" && S.exif ? getBlob(it.id).then(function (b) { return b.arrayBuffer(); })
      .then(function (buf) { return new Blob([GCExif.insertGps(buf, { lat: lat, lng: lng, date: new Date(it.ts) })], { type: "image/jpeg" }); })
      .catch(function () { return null; }) : Promise.resolve(null);
    /* liegt das ungestempelte Original vor, wird der Stempel mit dem neuen Ort neu gesetzt */
    var newP = wasStamped && it.orig ? geoP.then(function () { busy("Stempel wird aktualisiert …"); return restamp(it); }) : Promise.resolve(null);
    return Promise.all([geoP, blobP, newP]).then(function (a) {
      var nb = a[2] || a[1];
      return putItem(it, nb).then(function () {
        if (cur && cur.it === it && nb) { cur.blob = nb; if (a[2]) showMedia(); }
        refreshOpen(); lastThumb();
        toast(a[2] ? "Ort geändert – der Stempel im Bild wurde aktualisiert." : wasStamped ? "Ort geändert. Der eingebrannte Stempel im Bild bleibt unverändert." : "Ort gespeichert.", 4500);
        backfill();
      });
    }).catch(saveErr).then(unbusy);
  }

  /* ================= Ortswahl ================= */
  var pk = { map: null, marker: null, target: null, sel: null };
  function pickSet(lat, lng, pan) {
    pk.sel = { lat: lat, lng: lng };
    if (!pk.marker) pk.marker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="gc-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 22] }) }).addTo(pk.map);
    else pk.marker.setLatLng([lat, lng]);
    if (pan) pk.map.setView([lat, lng], Math.max(pk.map.getZoom(), 16));
    $("#p-info").textContent = fmtCoords(lat, lng, "dec"); $("#p-ok").disabled = false;
  }
  function openPicker(target) {
    pk.target = target; pk.sel = null; $("#p-ok").disabled = true; $("#p-q").value = "";
    $("#p-info").textContent = "Auf die Karte tippen, um den Ort zu setzen.";
    $("#p-gps").hidden = !(target === "live" && loc.manual);
    openSheet($("#picker"));
    if (!pk.map) {
      pk.map = L.map("p-map", { maxZoom: 19 }).setView([51.2, 10.4], 6);
      L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTR }).addTo(pk.map);
      pk.map.on("click", function (e) { pickSet(e.latlng.lat, e.latlng.lng); });
    }
    if (pk.marker) { pk.marker.remove(); pk.marker = null; }
    var start = target !== "live" && hasLoc(target) ? target : hasLoc(loc) ? loc : gpsRaw ? { lat: gpsRaw.latitude, lng: gpsRaw.longitude } : null;
    setTimeout(function () {
      pk.map.invalidateSize();
      if (start) pk.map.setView([start.lat, start.lng], 16, { animate: false }); else pk.map.setView([51.2, 10.4], 6, { animate: false });
    }, 60);
  }
  function pickerOk() {
    var s = pk.sel, t = pk.target; if (!s) return;
    closeSheet();
    if (t === "live") {
      loc.manual = true; loc.addrManual = false; geoAt = mapAt = null; wxAt = 0; loc.place = loc.city = loc.suburb = loc.address = ""; loc.map = null; loc.weather = "";
      setLoc(s.lat, s.lng, null, null); refreshOpen(); toast("Standort manuell gesetzt.");
    } else setTimeout(function () { setItemLoc(t, s.lat, s.lng); }, 80);
  }

  /* ================= Adresse ändern (Aufnahme, Parkplatz, aktueller Standort) ================= */
  var adT = null, adGeo = null;   // Ziel: Aufnahme oder "live"
  function adObj() { return adT === "live" ? loc : adT; }
  function fillAddr() {
    var o = adObj(); if (!o) return;
    var geo = hasLoc(o);
    $("#a-place").value = o.place || ""; $("#a-address").value = o.address || "";
    $("#a-coords").textContent = geo ? fmtCoords(o.lat, o.lng) : "Kein Standort gespeichert";
    $("#a-pos").textContent = geo ? "Position auf der Karte ändern" : "Position auf der Karte setzen";
    $("#a-auto").hidden = !geo;
    $("#a-stamp").hidden = !(adT !== "live" && o.stamped);
    $("#a-stamp").textContent = o.orig ? "Der Stempel im Bild wird mit der neuen Adresse neu gesetzt." : "Der bereits ins Bild eingebrannte Stempel bleibt unverändert.";
  }
  function openAddr(t) {
    if (!t) return;
    adT = t; adGeo = null; fillAddr();
    openSheet($("#addr"), function () { adT = null; adGeo = null; });
  }
  function addrAuto() {
    var o = adObj(); if (!o || !hasLoc(o)) return;
    if (!online()) { toast("Dafür wird eine Internetverbindung gebraucht – und „Adresse online ermitteln“ in den Einstellungen.", 5000); return; }
    var t = adT; busy("Adresse wird ermittelt …");
    reverse(o.lat, o.lng).then(function (g) {
      if (adT !== t) return;
      adGeo = g; $("#a-place").value = g.place || ""; $("#a-address").value = g.address || "";
    }).catch(function () { toast("Die Adresse konnte gerade nicht ermittelt werden."); }).then(unbusy);
  }
  function addrSave() {
    var t = adT, o = adObj(); if (!o) return;
    var p = $("#a-place").value.trim(), a = $("#a-address").value.trim().replace(/\s*\n\s*/g, ", ");
    var auto = adGeo && p === (adGeo.place || "") && a === (adGeo.address || "") ? adGeo : null;
    closeSheet();
    o.place = p; o.address = a;
    if (auto) { o.city = auto.city; o.suburb = auto.suburb; }
    if (t === "live") {
      loc.addrManual = !auto; loc.addrAt = hasLoc(loc) ? { lat: loc.lat, lng: loc.lng } : null;
      ovDirty = true; chip(); if (view === "set") drawPreview();
      refreshOpen(); toast("Adresse geändert – sie gilt für die nächsten Aufnahmen an diesem Ort.", 4500);
    } else {
      o.geoPending = false; o.addrManual = !auto;
      if (o.stamped && o.orig) busy("Stempel wird aktualisiert …");
      (o.stamped ? restamp(o) : Promise.resolve(null)).then(function (nb) {
        return putItem(o, nb).then(function () {
          if (nb && cur && cur.it === o) { cur.blob = nb; showMedia(); }
          refreshOpen(); lastThumb(); if (!cur && $("#park").hidden) render();
          toast(nb ? "Adresse geändert – der Stempel im Bild wurde aktualisiert." : o.stamped ? "Adresse geändert. Der eingebrannte Stempel im Bild bleibt unverändert." : "Adresse geändert.", 4500);
        });
      }).catch(saveErr).then(unbusy);
    }
  }
  /* offene Ansichten nach einer Orts-/Adressänderung neu füllen */
  function refreshOpen() {
    if (cur) fillDetail();
    if (!$("#park").hidden) fillPark();
    if (adT && !$("#addr").hidden) fillAddr();
    if (qrCur && !$("#qr").hidden && hasLoc(qrCur.src)) qrFill(qrCur.src);
  }

  /* ================= Einstellungen ================= */
  function sampleMap() {
    var c = document.createElement("canvas"); c.width = c.height = 320; var g = c.getContext("2d");
    g.fillStyle = "#e8e4d8"; g.fillRect(0, 0, 320, 320); g.fillStyle = "#b9dcae"; g.fillRect(190, 20, 110, 90);
    g.fillStyle = "#a5cdf0"; g.fillRect(0, 230, 320, 50);
    g.strokeStyle = "#fff"; g.lineWidth = 16; g.beginPath(); g.moveTo(0, 150); g.lineTo(320, 130); g.moveTo(130, 0); g.lineTo(160, 320); g.stroke();
    g.strokeStyle = "#f6d37a"; g.lineWidth = 10; g.beginPath(); g.moveTo(0, 60); g.lineTo(320, 200); g.stroke();
    g.beginPath(); g.arc(160, 160, 17, 0, 6.3); g.fillStyle = "#fff"; g.fill();
    g.beginPath(); g.arc(160, 160, 12, 0, 6.3); g.fillStyle = "#ef4444"; g.fill();
    return c;
  }
  var _sample = null, _bg = null;
  function drawPreview() {
    var c = $("#set-preview"), g = c.getContext("2d"), W = c.width, H = c.height;
    var sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, "#5b9bd5"); sky.addColorStop(0.62, "#cfe3f3"); sky.addColorStop(0.62, "#6b8f5a"); sky.addColorStop(1, "#3f5d3a");
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    if (!_bg) { _bg = new Image(); _bg.onload = function () { drawPreview(); }; _bg.src = "./preview-freising.jpg?v=9"; }
    if (_bg.complete && _bg.naturalWidth) {   /* Illustration der Freisinger Altstadt, formatfüllend */
      var k = Math.max(W / _bg.naturalWidth, H / _bg.naturalHeight), bw = _bg.naturalWidth * k, bh = _bg.naturalHeight * k;
      g.drawImage(_bg, (W - bw) / 2, (H - bh) / 2, bw, bh);
    }
    var d = hasLoc(loc) && loc.place ? liveData() : { lat: 48.402880, lng: 11.748870, alt: 448, acc: 5, heading: 48, place: "Altstadt, Freising",
      address: "Marienplatz, 85354 Freising, Deutschland", weather: "18 °C, heiter", date: new Date(), note: S.note, map: null };
    if (typeof d.alt !== "number") d.alt = 448; if (typeof d.acc !== "number") d.acc = 5; if (typeof d.heading !== "number") d.heading = 48;
    if (!d.weather) d.weather = "18 °C, heiter";
    if (!d.map) d.map = _sample || (_sample = sampleMap());
    drawStamp(g, W, H, d);
  }
  function setLogo(blob) {
    return new Promise(function (res) {
      var prev = $("#logo-prev"); prev.textContent = "";
      if (!blob) {
        logo = null; var s = document.createElement("span"); s.textContent = "Kein Logo"; prev.appendChild(s);
        $("#btn-logo-del").hidden = true; ovDirty = true; res(); return;
      }
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { logo = im; prev.appendChild(im.cloneNode()); $("#btn-logo-del").hidden = false; ovDirty = true; res(); };
      im.onerror = function () { logo = null; res(); };
      im.src = u;   // bleibt als Objekt-URL für die Laufzeit bestehen
    });
  }
  function pickLogo(file) {
    if (!file) return;
    decodeImage(file).then(function (im) {
      var sz = imgSize(im), k = Math.min(1, 512 / Math.max(sz.w, sz.h));
      var c = document.createElement("canvas"); c.width = Math.max(1, Math.round(sz.w * k)); c.height = Math.max(1, Math.round(sz.h * k));
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      return canvasBlob(c, "image/png");
    }).then(function (b) {
      return tx(["kv"], "readwrite", function (t) { t.objectStore("kv").put(b, "logo"); }).then(function () { return setLogo(b); });
    }).then(function () { drawPreview(); toast("Logo gespeichert – es erscheint auf allen neuen Aufnahmen."); })
      .catch(function () { toast("Dieses Bild konnte nicht als Logo geladen werden."); });
  }
  function storageInfo() {
    var el = $("#storage-info"), n = items.length + (items.length === 1 ? " Aufnahme" : " Aufnahmen") + " auf diesem Gerät";
    el.textContent = n + ".";
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) {
      if (!e || !e.quota) return;
      el.textContent = n + " · " + de((e.usage || 0) / 1048576, 1) + " MB belegt, etwa " + de(e.quota / 1073741824, 1) +
        " GB verfügbar. Aufnahmen liegen nur in dieser App – zum Sichern teilen oder herunterladen.";
    }).catch(function () {});
  }
  function bindSettings() {
    $$("#tpls button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.tpl === S.tpl);
      b.addEventListener("click", function () {
        S.tpl = b.dataset.tpl; saveS(); ovDirty = true;
        $$("#tpls button").forEach(function (x) { x.classList.toggle("on", x === b); }); drawPreview();
      });
    });
    $$("input[data-f]").forEach(function (i) {
      i.checked = !!S.fields[i.dataset.f];
      i.addEventListener("change", function () {
        S.fields[i.dataset.f] = i.checked; saveS(); ovDirty = true;
        if (i.dataset.f === "compass") startCompass(true);
        refreshLocInfo(); drawPreview();
      });
    });
    $$("[data-s]").forEach(function (i) {
      var k = i.dataset.s, cb = i.type === "checkbox";
      if (cb) i.checked = !!S[k]; else i.value = String(S[k]);
      i.addEventListener(cb || i.tagName === "SELECT" ? "change" : "input", function () {
        S[k] = cb ? i.checked : "num" in i.dataset ? Number(i.value) : i.value; saveS(); ovDirty = true;
        if (k === "geocodeOnline") { refreshLocInfo(); backfill(); }
        drawPreview();
      });
    });
  }

  /* ================= Mein Parkplatz ================= */
  var parkId = null, parkArmed = false, parkUrl = null, parkT = 0;
  function parkItem() { return parkId ? items.filter(function (x) { return x.id === parkId; })[0] || null : null; }
  function parkUi() { $("#btn-park").classList.toggle("on", !!parkItem()); }
  function setPark(id) {
    if ((id || null) !== parkId && parkUntil) setMeter(0);   /* neue Parkuhr je Parkplatz */
    parkId = id || null; parkUi();
    return tx(["kv"], "readwrite", function (t) { if (parkId) t.objectStore("kv").put(parkId, "park"); else t.objectStore("kv").delete("park"); })
      .catch(function (e) { console.error(e); });
  }
  /* Parkuhr: Ablaufzeit + Erinnerung. Ohne Server gibt es keinen Weckdienst – die Erinnerung kommt nur,
     solange die App geöffnet (oder im Hintergrund noch aktiv) ist. */
  var parkUntil = 0, parkWarnT = 0, parkEndT = 0, parkTold = false;
  function hm(ms) { var d = new Date(ms); return p2(d.getHours()) + ":" + p2(d.getMinutes()); }
  function parkNotify(msg) {
    toast(msg, 9000);
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (e) {}
    if (!("Notification" in window) || Notification.permission !== "granted" || !navigator.serviceWorker) return;
    navigator.serviceWorker.ready.then(function (r) {
      return r.showNotification("GeoCam – Parkuhr", { body: msg, tag: "gc-park", icon: "./icon-192.png", data: "./app.html?go=park" });
    }).catch(function () {});
  }
  function parkTimers() {
    clearTimeout(parkWarnT); clearTimeout(parkEndT); parkWarnT = parkEndT = 0;
    if (!parkUntil) return;
    var left = parkUntil - Date.now();
    if (left <= 0) { if (!parkTold) { parkTold = true; parkNotify("Die Parkzeit ist seit " + hm(parkUntil) + " Uhr abgelaufen."); } return; }
    if (left > 6e5) parkWarnT = setTimeout(function () { parkNotify("Die Parkzeit läuft in 10 Minuten ab (" + hm(parkUntil) + " Uhr)."); parkLive(); }, left - 6e5);
    parkEndT = setTimeout(function () { parkTold = true; parkNotify("Die Parkzeit ist abgelaufen."); parkLive(); }, left);
  }
  function setMeter(until) {
    parkUntil = until || 0; parkTold = false; parkTimers(); parkLive();
    return tx(["kv"], "readwrite", function (t) { if (parkUntil) t.objectStore("kv").put(parkUntil, "parkUntil"); else t.objectStore("kv").delete("parkUntil"); })
      .catch(function (e) { console.error(e); });
  }
  function meterStart(until) {
    setMeter(until);
    var note = "";
    if (!("Notification" in window)) note = " Erinnerung nur als Hinweis in der geöffneten App.";
    else if (Notification.permission === "default") { try { var p = Notification.requestPermission(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
    else if (Notification.permission === "denied") note = " Mitteilungen sind blockiert – Erinnerung nur in der geöffneten App.";
    toast("Parkuhr gestellt: läuft ab um " + hm(until) + " Uhr." + note, 5000);
  }
  function meterTxt() {
    var el = $("#pk-meter-info"), left = parkUntil - Date.now();
    $("#pk-meter-x").hidden = !parkUntil; el.classList.toggle("warn", !!parkUntil && left < 6e5);
    if (!parkUntil) { el.textContent = "Keine Ablaufzeit gestellt."; return; }
    if (left <= 0) { el.textContent = "Parkzeit abgelaufen (seit " + hm(parkUntil) + " Uhr)."; return; }
    var m = Math.ceil(left / 60000);
    el.textContent = "Läuft ab um " + hm(parkUntil) + " Uhr – noch " + (m >= 60 ? Math.floor(m / 60) + " Std. " + (m % 60) + " Min." : m + " Min.");
  }
  function armPark(on) { parkArmed = !!on; $("#park-arm").hidden = !parkArmed; }
  function bearing(a, b) {
    var r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
    var x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + " m" : de(m / 1000, m < 10000 ? 1 : 0) + " km"; }
  function fmtAgo(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return "gerade eben";
    if (m < 60) return "vor " + m + " Min.";
    var h = Math.floor(m / 60); if (h < 24) return "vor " + h + " Std. " + (m % 60) + " Min.";
    var dd = Math.floor(h / 24); return "vor " + dd + (dd === 1 ? " Tag" : " Tagen");
  }
  function mapsWalk(it) { return "https://www.google.com/maps/dir/?api=1&destination=" + it.lat.toFixed(6) + "," + it.lng.toFixed(6) + "&travelmode=walking"; }
  function parkLive() {
    var it = parkItem(); if (!it || $("#park").hidden) return;
    var el = $("#pk-dist");
    if (!hasLoc(it)) el.textContent = "Kein Ort gespeichert";
    else if (!hasLoc(loc)) el.textContent = "Entfernung: eigener Standort noch unbekannt";
    else {
      var m = dist(loc, it);
      el.textContent = m < 15 ? "Du stehst am Parkplatz" : "ca. " + fmtDist(m) + " entfernt · Richtung " + compassTxt(bearing(loc, it)).split(" ")[0];
    }
    $("#pk-since").textContent = "Geparkt " + fmtAgo(Date.now() - it.ts) + " · " + fmtDate(new Date(it.ts));
    meterTxt();
  }
  function fillPark() {
    var it = parkItem();
    $("#pk-empty").hidden = !!it; $("#pk-full").hidden = !it;
    if (parkUrl) { URL.revokeObjectURL(parkUrl); parkUrl = null; }
    if (!it) return;
    var geo = hasLoc(it), nav = $("#pk-nav"), img = $("#pk-img");
    img.src = it.thumb;
    if (it.type === "photo") getBlob(it.id).then(function (b) {
      if (!b || parkId !== it.id || $("#park").hidden) return;
      parkUrl = URL.createObjectURL(b); img.src = parkUrl;
    }).catch(function () {});
    nav.classList.toggle("off", !geo); if (geo) nav.href = mapsWalk(it); else nav.removeAttribute("href");
    $("#pk-noloc").hidden = geo; $("#pk-qr").classList.toggle("off", !geo);
    var dl = $("#pk-info"); dl.textContent = "";
    var row = function (k, v) {
      if (!v) return;
      var dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    };
    row("Ort", it.place || (geo && it.geoPending ? "wird ermittelt, sobald Internet besteht" : ""));
    row("Adresse", it.address);
    row("Koordinaten", geo ? fmtCoords(it.lat, it.lng) : "");
    row("Genauigkeit", typeof it.acc === "number" ? "± " + Math.round(it.acc) + " m" : "");
    dl.hidden = !dl.firstChild;
    $("#pk-note").value = it.note || ""; $("#pk-time").value = "";
    parkLive();
  }
  function openPark() {
    if (!$("#park").hidden) { fillPark(); return; }
    openSheet($("#park"), function () {
      clearInterval(parkT); if (parkUrl) { URL.revokeObjectURL(parkUrl); parkUrl = null; }
      $("#pk-img").removeAttribute("src"); render();
    });
    fillPark(); clearInterval(parkT); parkT = setInterval(parkLive, 3000);
  }
  /* Das Sheet verdeckt den Sucher: schließen, Kamera zeigen, nächstes Foto wird der Parkplatz */
  function parkShoot() {
    closeSheet(); armPark(true);
    if (view !== "cam") show("cam");
    setMode("photo");
  }

  /* ================= Standort-QR-Code ================= */
  var qrCur = null;   // {src, lat, lng, place, address, url} – src = Aufnahme oder loc (aktueller Standort)
  function qrDraw(c, text, pad) {
    var q = qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), g = c.getContext("2d"), W = c.width, quiet = 4;
    var cell = Math.floor((W - 2 * (pad || 0)) / (n + 2 * quiet)), off = Math.floor((W - cell * n) / 2);
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, c.height); g.fillStyle = "#000";
    for (var r = 0; r < n; r++) for (var k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect(off + k * cell, off + r * cell, cell, cell);
  }
  function qrFill(o) {
    var q = { src: o, lat: o.lat, lng: o.lng, place: o.place || "", address: o.address || "", url: mapsShow(o) };
    try { qrDraw($("#qr-canvas"), q.url); } catch (e) { console.error(e); return false; }
    qrCur = q;
    $("#qr-place").textContent = q.place || q.address || "Standort";
    $("#qr-address").textContent = q.place && q.address ? q.address : "";
    $("#qr-coords").textContent = fmtCoords(q.lat, q.lng);
    $("#qr-link").href = q.url;
    return true;
  }
  function openQr(o) {
    if (!o || !hasLoc(o)) { toast("Dafür ist noch kein Standort bekannt."); return; }
    if (!qrFill(o)) { toast("Der QR-Code kann gerade nicht erzeugt werden."); return; }
    openSheet($("#qr"), function () { qrCur = null; });
  }
  /* Bild zum Weitergeben: QR-Code mit Ort und Koordinaten darunter */
  function qrCard(q) {
    var c = document.createElement("canvas"); c.width = 720; c.height = 900;
    qrDraw(c, q.url, 20);
    var g = c.getContext("2d"); g.fillStyle = "#0b1220"; g.textAlign = "center"; g.textBaseline = "middle";
    var t = q.place || q.address || "Standort"; g.font = "700 34px " + FONT;
    while (t.length > 4 && g.measureText(t).width > 660) t = t.slice(0, -2).trim() + "…";
    g.fillText(t, 360, 746);
    g.font = "400 24px " + FONT; g.fillStyle = "#334155";
    var ad = q.place && q.address ? q.address : "";
    while (ad.length > 4 && g.measureText(ad).width > 660) ad = ad.slice(0, -2).trim() + "…";
    if (ad) g.fillText(ad, 360, 784);
    g.fillText(fmtCoords(q.lat, q.lng), 360, ad ? 816 : 800);
    g.font = "600 22px " + FONT; g.fillStyle = "#0f766e"; g.fillText("GeoCam · scannen öffnet Google Maps", 360, 860);
    return canvasBlob(c, "image/png");
  }
  function qrName(q) {
    var s = (q.place || "Standort").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
      .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
    return "GeoCam_QR" + (s ? "_" + s : "") + ".png";
  }
  function qrShare() {
    if (!qrCur) return;
    var q = qrCur, name = qrName(q);
    qrCard(q).then(function (b) {
      var file; try { file = new File([b], name, { type: "image/png" }); } catch (e) { file = null; }
      var text = [q.place, q.address, q.url].filter(Boolean).join("\n");
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: q.place || "Standort", text: text }).catch(function () {});
      else if (navigator.share) navigator.share({ title: q.place || "Standort", text: text }).catch(function () {});
      else { download(b, name); toast("Teilen wird hier nicht unterstützt – der QR-Code wurde heruntergeladen."); }
    }).catch(function (e) { console.error(e); toast("Der QR-Code konnte nicht erzeugt werden."); });
  }
  function qrCopy() {
    if (!qrCur) return;
    var u = qrCur.url, ok = function () { toast("Link kopiert."); }, bad = function () { toast(u, 8000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(ok, bad); else bad();
  }

  /* ================= Ansichten ================= */
  function render() {
    lastThumb(); parkUi();
    if (view === "gal") renderGallery();
    else if (view === "map") renderMap();
    else if (view === "set") storageInfo();
  }
  function show(v, focus) {
    if (rec && v !== "cam") stopRec();
    view = v;
    ["cam", "gal", "map", "set"].forEach(function (n) { $("#v-" + n).hidden = n !== v; });
    $$("#tabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.view === v); });
    if (v === "cam") startCamera(); else stopCamera();
    if (v !== "gal" && selMode) { selMode = false; sel = {}; selUi(); }
    if (v === "gal") renderGallery();
    if (v === "map") {
      mapList = focus && focus.length ? focus : null;
      if (mapList) mapSel = mapList[0];
      ovFit = true; renderMap();
    }
    if (v === "set") { drawPreview(); storageInfo(); }
  }

  /* ================= Verdrahtung ================= */
  function wire() {
    $$("#tabs button").forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.view); }); });
    $$(".mode button").forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.mode); }); });
    $("#btn-shutter").addEventListener("click", shutter);
    $("#btn-last").addEventListener("click", function () { show("gal"); });
    $("#btn-flip").addEventListener("click", function () {
      if (rec || counting) return;
      S.facing = S.facing === "environment" ? "user" : "environment"; saveS(); stopCamera(); startCamera();
    });
    $("#btn-timer").addEventListener("click", function () { S.timer = S.timer === 0 ? 3 : S.timer === 3 ? 10 : 0; saveS(); timerLbl(); });
    $("#btn-torch").addEventListener("click", function () {
      var tr = camStream && camStream.getVideoTracks()[0]; if (!tr) return;
      torchOn = !torchOn;
      tr.applyConstraints({ advanced: [{ torch: torchOn }] }).then(function () { $("#btn-torch").classList.toggle("on", torchOn); })
        .catch(function () { torchOn = false; });
    });
    $("#btn-pin").addEventListener("click", function () { openPicker("live"); });
    $("#btn-park").addEventListener("click", openPark);
    $("#btn-qr").addEventListener("click", function () {
      if (!hasLoc(loc)) { toast("Noch kein Standort – bitte Standort freigeben oder den Ort von Hand wählen."); return; }
      openQr(loc);
    });
    $("#park-arm-x").addEventListener("click", function () { armPark(false); });
    $("#gps-chip").addEventListener("click", function () {
      if (!hasLoc(loc) && geoState !== "ok") requestGeo(); else if (hasLoc(loc)) openAddr("live"); else openPicker("live");
    });
    $("#geo-ask-btn").addEventListener("click", requestGeo);
    $("#geo-ask-man").addEventListener("click", function () { openPicker("live"); });
    $("#geo-ask-x").addEventListener("click", function () { geoHide = true; geoUi(); });
    $("#btn-cam-retry").addEventListener("click", startCamera);
    $("#btn-cam-native").addEventListener("click", function () { $("#file-capture").click(); });
    var imp = function () { $("#file-import").click(); };
    $("#btn-import").addEventListener("click", imp); $("#btn-import2").addEventListener("click", imp);
    $("#file-import").addEventListener("change", function (e) { importFiles(e.target.files, false); e.target.value = ""; });
    $("#file-capture").addEventListener("change", function (e) { importFiles(e.target.files, true); e.target.value = ""; });
    $("#file-logo").addEventListener("change", function (e) { pickLogo(e.target.files[0]); e.target.value = ""; });
    $("#btn-logo").addEventListener("click", function () { $("#file-logo").click(); });
    $("#btn-logo-del").addEventListener("click", function () {
      tx(["kv"], "readwrite", function (t) { t.objectStore("kv").delete("logo"); }).then(function () { return setLogo(null); }).then(drawPreview);
    });
    $("#gal-search").addEventListener("input", renderGallery);
    [["#gal-type", "type"], ["#gal-range", "range"], ["#gal-proj", "proj"]].forEach(function (a) {
      $(a[0]).addEventListener("change", function () { galF[a[1]] = $(a[0]).value; renderGallery(); });
    });
    /* Mehrfachauswahl */
    $("#btn-sel").addEventListener("click", function () { if (selMode) selEnd(); else { selMode = true; sel = {}; renderGallery(); } });
    $("#sel-all").addEventListener("click", function () {
      var all = galShown.length && galShown.every(function (it) { return sel[it.id]; });
      galShown.forEach(function (it) { if (all) delete sel[it.id]; else sel[it.id] = true; });
      renderGallery();
    });
    $("#sel-share").addEventListener("click", selShare);
    $("#sel-dl").addEventListener("click", selDownload);
    $("#sel-del").addEventListener("click", selDelete);
    $("#btn-zip-all").addEventListener("click", function () { exportZip(items.slice()); });
    /* Zoom: Knopf springt durch die Stufen, zwei Finger zoomen stufenlos */
    $("#btn-zoom").addEventListener("click", zoomStep);
    var cv = $("#cam-canvas");
    cv.addEventListener("touchstart", function (e) { if (e.touches.length === 2 && zoomCaps) pinch = { d: touchDist(e), z: zoomV }; }, { passive: true });
    cv.addEventListener("touchmove", function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault(); if (pinch.d > 0) setZoom(pinch.z * touchDist(e) / pinch.d);
    }, { passive: false });
    cv.addEventListener("touchend", function (e) { if (e.touches.length < 2) pinch = null; });
    cv.addEventListener("touchcancel", function () { pinch = null; });
    /* Karte: Übersicht (alle Pins) oder Google Maps */
    $$("#map-mode button").forEach(function (b) {
      b.addEventListener("click", function () { S.mapKind = b.dataset.mode; saveS(); ovFit = true; renderMap(); });
    });
    $$("#gal-sort button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.sort === S.sort);
      b.addEventListener("click", function () {
        S.sort = b.dataset.sort; saveS();
        $$("#gal-sort button").forEach(function (x) { x.classList.toggle("on", x === b); }); renderGallery();
      });
    });
    $("#btn-wipe").addEventListener("click", function () {
      if (!items.length || !confirm("Wirklich alle " + items.length + " Aufnahmen endgültig löschen?")) return;
      tx(["media", "blobs"], "readwrite", function (t) { t.objectStore("media").clear(); t.objectStore("blobs").clear(); })
        .then(function () { items = []; mapSel = null; mapList = null; selMode = false; sel = {}; setPark(null); render(); toast("Alle Aufnahmen gelöscht."); }).catch(saveErr);
    });
    /* Detail */
    $("#d-close").addEventListener("click", closeSheet);
    $("#d-del").addEventListener("click", function () {
      if (!cur || !confirm("Diese Aufnahme endgültig löschen?")) return;
      var id = cur.it.id;
      delItem(id).then(function () {
        items = items.filter(function (x) { return x.id !== id; });
        if (id === parkId) { setPark(null); if (!$("#park").hidden) fillPark(); }
        closeSheet(); toast("Aufnahme gelöscht.");
      }).catch(saveErr);
    });
    $("#d-nav").addEventListener("click", function (e) { if (!cur || !hasLoc(cur.it)) { e.preventDefault(); toast("Für diese Aufnahme ist kein Standort gespeichert – bitte zuerst „Ort setzen“."); } });
    $("#d-show").addEventListener("click", function (e) { if (!cur || !hasLoc(cur.it)) { e.preventDefault(); toast("Für diese Aufnahme ist kein Standort gespeichert."); } });
    $("#d-share").addEventListener("click", function () { if (cur) share(); });
    $("#d-dl").addEventListener("click", function () { if (cur) download(cur.blob, fileName(cur.it)); });
    $("#d-loc").addEventListener("click", function () { if (cur) openPicker(cur.it); });
    $("#d-addr").addEventListener("click", function () { if (cur) openAddr(cur.it); });
    $("#d-stamp").addEventListener("click", function () { if (cur) burnStamp(); });
    $("#d-qr").addEventListener("click", function () { if (cur) openQr(cur.it); });
    $("#d-park").addEventListener("click", function () {
      if (!cur) return;
      if (cur.it.id === parkId) { toast("Diese Aufnahme ist bereits dein Parkplatz."); return; }
      if (!hasLoc(cur.it)) { toast("Für diese Aufnahme ist kein Standort gespeichert – bitte zuerst „Ort setzen“."); return; }
      setPark(cur.it.id).then(function () { if (cur) fillDetail(); if (!$("#park").hidden) fillPark(); toast("Als Parkplatz gemerkt."); });
    });
    /* Mein Parkplatz */
    $("#pk-close").addEventListener("click", closeSheet);
    $("#pk-shoot").addEventListener("click", parkShoot);
    $("#pk-new").addEventListener("click", parkShoot);
    $("#pk-nav").addEventListener("click", function (e) { var it = parkItem(); if (!it || !hasLoc(it)) e.preventDefault(); });
    $("#pk-qr").addEventListener("click", function () { var it = parkItem(); if (it) openQr(it); });
    $("#pk-addr").addEventListener("click", function () { openAddr(parkItem()); });
    $("#pk-open").addEventListener("click", function () { if (parkItem()) openDetail(parkId); });
    $("#pk-note").addEventListener("change", function () { var it = parkItem(); if (!it) return; it.note = $("#pk-note").value.trim(); putItem(it).catch(saveErr); });
    $$("#pk-meter [data-min]").forEach(function (b) {
      b.addEventListener("click", function () { meterStart(Date.now() + Number(b.dataset.min) * 60000); });
    });
    $("#pk-time").addEventListener("change", function () {
      var m = /^(\d\d):(\d\d)/.exec($("#pk-time").value); if (!m) return;
      var d = new Date(); d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   /* Uhrzeit schon vorbei → morgen */
      meterStart(d.getTime());
    });
    $("#pk-meter-x").addEventListener("click", function () { setMeter(0); toast("Parkuhr gelöscht."); });
    $("#pk-end").addEventListener("click", function () {
      if (!confirm("Parkplatz beenden? Das Foto bleibt in der Galerie.")) return;
      setPark(null).then(function () { fillPark(); toast("Parkplatz beendet."); });
    });
    /* QR-Code */
    $("#qr-close").addEventListener("click", closeSheet);
    $("#qr-share").addEventListener("click", qrShare);
    $("#qr-save").addEventListener("click", function () {
      if (!qrCur) return; var q = qrCur;
      qrCard(q).then(function (b) { download(b, qrName(q)); }).catch(function () { toast("Der QR-Code konnte nicht gespeichert werden."); });
    });
    $("#qr-copy").addEventListener("click", qrCopy);
    $("#qr-addr").addEventListener("click", function () { if (qrCur) openAddr(qrCur.src === loc ? "live" : qrCur.src); });
    /* Adresse ändern */
    $("#a-cancel").addEventListener("click", closeSheet);
    $("#a-ok").addEventListener("click", addrSave);
    $("#a-auto").addEventListener("click", addrAuto);
    $("#a-pos").addEventListener("click", function () { if (adT) openPicker(adT); });
    $("#map-open").addEventListener("click", function () { if (mapSel) openDetail(mapSel.id); });
    $("#d-note").addEventListener("change", function () { if (!cur) return; cur.it.note = $("#d-note").value.trim(); putItem(cur.it).catch(saveErr); });
    /* Ortswahl */
    $("#p-cancel").addEventListener("click", closeSheet);
    $("#p-ok").addEventListener("click", pickerOk);
    $("#p-gps").addEventListener("click", function () {
      loc.manual = false; loc.addrManual = false; geoAt = mapAt = null; wxAt = 0; closeSheet();
      loc.place = loc.city = loc.suburb = loc.address = "";
      if (gpsRaw) setLoc(gpsRaw.latitude, gpsRaw.longitude, gpsRaw.altitude, gpsRaw.accuracy);
      else { loc.lat = loc.lng = null; loc.map = null; geoUi(); }
      refreshOpen();
      toast("GPS-Standort wird wieder verwendet.");
    });
    $("#p-form").addEventListener("submit", function (e) {
      e.preventDefault(); var q = $("#p-q").value.trim(); if (!q) return;
      if (navigator.onLine === false) { toast("Die Ortssuche braucht eine Internetverbindung."); return; }
      $("#p-info").textContent = "Suche …";
      nominatim("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=de&q=" + encodeURIComponent(q)).then(function (j) {
        if (!j || !j.length) { $("#p-info").textContent = "Nichts gefunden – bitte genauer eingeben."; return; }
        pickSet(parseFloat(j[0].lat), parseFloat(j[0].lon), true);
      }).catch(function () { $("#p-info").textContent = "Die Suche ist gerade nicht erreichbar."; });
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { if (!rec) stopCamera(); return; }
      if (view === "cam") startCamera();
      parkTimers(); parkLive();   /* Zeitgeber können im Hintergrund eingeschlafen sein */
    });
    window.addEventListener("online", function () { refreshLocInfo(); backfill(); if (view === "map") renderMap(); });
    window.addEventListener("offline", function () { if (view === "map") renderMap(); });
  }

  /* ================= Start ================= */
  function init() {
    wire(); bindSettings(); timerLbl(); setMode(S.mode === "video" ? "video" : "photo"); chip();
    var go = null;
    try {
      var u = new URL(location.href); go = u.searchParams.get("go");
      if (go) { u.searchParams.delete("go"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
    } catch (e) {}
    var loadAll = tx(["media", "kv"], "readonly", function (t) {
      var out = {}, a = t.objectStore("media").getAll(), b = t.objectStore("kv").get("logo"), c = t.objectStore("kv").get("park"),
        d = t.objectStore("kv").get("parkUntil");
      a.onsuccess = function () { out.items = a.result || []; }; b.onsuccess = function () { out.logo = b.result || null; };
      c.onsuccess = function () { out.park = c.result || null; }; d.onsuccess = function () { out.until = d.result || 0; };
      return out;
    }).then(function (o) {
      items = (o.items || []).sort(function (a, b) { return b.ts - a.ts; });
      parkId = o.park || null; parkUntil = parkId ? Number(o.until) || 0 : 0;
      return o.logo ? setLogo(o.logo) : null;
    }).catch(function (e) { console.error(e); toast("Der Gerätespeicher ist nicht verfügbar (privater Modus?). Aufnahmen können nicht gespeichert werden.", 7000); });
    loadAll.then(function () {
      show(go === "gal" || go === "map" || go === "set" ? go : "cam");
      lastThumb(); parkUi(); startGps(); startCompass(false); backfill();
      if (go === "park") openPark();
      parkTimers();
    });
  }
  init();
})();
