/* Bot Hub — a Grok-Bot-style team view for Hermes WebUI.
 *
 * Adds a "Bots" entry to the rail:
 *  - sidebar: the team thread, what waits for you, and every bot with a live status dot
 *  - main view: an approvals inbox, one card per bot (what it is doing, its routines,
 *    one click to its conversation), "new bot in one sentence" and the team thread.
 *
 * Live state comes from the WebUI API (/api/sessions?all_profiles=1, /api/profiles,
 * /api/approval/*). Identity, routines, gateway approvals and the current tool come from
 * the bot-hub sidecar through the WebUI extension proxy; without it the hub still works
 * with less detail. Bot creation and the team thread are plain WebUI chats with the main
 * profile, which uses the bot-forge tools (create_agent, ask_agent).
 */
(function () {
  'use strict';
  if (window.__botHubLoaded) return;
  window.__botHubLoaded = true;

  var EXT_ID = 'bot-hub';
  var PANEL = 'bothub';
  var SIDECAR = '/api/extensions/' + EXT_ID + '/sidecar';
  var FAST_MS = 6000;
  var SLOW_MS = 20000;
  var PROFILES_MS = 60000;
  var LEAD = 'default';
  var TEAM_TITLE = '👥 Team';  // English key: a new thread is named t(TEAM_TITLE); either language's title is found

  var state = {
    profiles: null,
    profilesAt: 0,
    sessions: [],
    clockSkew: 0,
    meta: null,
    sidecar: 'unknown', // ok | consent | down | unknown
    webuiPending: [],
    error: null,
    lastUpdate: 0,
    showHidden: false,
  };
  var inFlight = false;
  var timer = null;
  var openingBot = null;
  var busy = {};     // action keys in progress
  var modal = null;  // {type: 'create'} | {type: 'routines', bot}

  // ── storage (extension-owned when available) ────────────────────────────
  var store = (function () {
    var handle = null;
    try { handle = window.hermesExt && window.hermesExt.register && window.hermesExt.register(EXT_ID); } catch (e) { handle = null; }
    return {
      get: function (k, d) {
        try {
          if (handle && handle.storage) { var v = handle.storage.get(k); return v === undefined || v === null ? d : v; }
          var raw = localStorage.getItem('bot-hub:' + k); return raw === null ? d : JSON.parse(raw);
        } catch (e) { return d; }
      },
      set: function (k, v) {
        try {
          if (handle && handle.storage) { handle.storage.set(k, v); return; }
          localStorage.setItem('bot-hub:' + k, JSON.stringify(v));
        } catch (e) { /* storage unavailable */ }
      },
    };
  })();
  state.showHidden = !!store.get('showHidden', false);

  // ── language ────────────────────────────────────────────────────────────
  // English by default; French when the WebUI is in French (its 'hermes-lang' setting), unless the
  // installation's config.json sets "language" ("en" or "fr"). The English text is the key:
  // t('Open {name}', {name: x}) looks it up in FR (bottom of this file) when French is on.
  var langOverride = '';
  function lang() {
    var l = langOverride;
    if (!l) { try { l = localStorage.getItem('hermes-lang') || ''; } catch (e) { l = ''; } }
    if (!l) l = document.documentElement.lang || navigator.language || 'en';
    return /^fr/i.test(l) ? 'fr' : 'en';
  }
  function t(en, vars) {
    var s = lang() === 'fr' && FR && Object.prototype.hasOwnProperty.call(FR, en) ? FR[en] : en;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? m : String(vars[k]); });
    return s;
  }
  function locale() { return lang() === 'fr' ? 'fr' : undefined; }

  // ── helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // plural form for a count: English "0 bots", French "0 bot" (0 and 1 are singular in French)
  function many(n) { return lang() === 'fr' ? n > 1 : n !== 1; }
  function nowSec() { return Date.now() / 1000 + state.clockSkew; }
  function ago(ts) {
    if (!ts) return '';
    var d = Math.max(0, nowSec() - ts);
    if (d < 60) return t('just now');
    if (d < 3600) return t('{n} min ago', { n: Math.round(d / 60) });
    if (d < 86400) return t('{n} h ago', { n: Math.round(d / 3600) });
    if (d < 172800) return t('yesterday');
    if (d < 86400 * 30) return t('{n} days ago', { n: Math.round(d / 86400) });
    var mo = Math.round(d / (86400 * 30));
    return mo === 1 ? t('{n} month ago', { n: mo }) : t('{n} months ago', { n: mo });
  }
  function whenIso(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (isNaN(dt)) return '';
    var hm = dt.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var day = new Date(dt); day.setHours(0, 0, 0, 0);
    var diff = Math.round((day - today) / 86400000);
    if (diff === 0) return t('today {time}', { time: hm });
    if (diff === 1) return t('tomorrow {time}', { time: hm });
    return dt.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm;
  }
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];  // t() where used
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function humanSchedule(s) {
    if (!s) return '';
    var x = String(s).trim(), m;
    if ((m = x.match(/^(\d+) (\d+) \* \* \*$/))) return t('every day at {time}', { time: pad(+m[2]) + ':' + pad(+m[1]) });
    if ((m = x.match(/^(\d+) (\d+) \* \* 1-5$/))) return t('weekdays at {time}', { time: pad(+m[2]) + ':' + pad(+m[1]) });
    if ((m = x.match(/^(\d+) (\d+) \* \* ([0-7])$/))) return t('every {day} at {time}', { day: t(DAYS[+m[3]]), time: pad(+m[2]) + ':' + pad(+m[1]) });
    if ((m = x.match(/^\*\/(\d+) \* \* \* \*$/))) return t('every {n} min', { n: m[1] });
    if (/^0 \* \* \* \*$/.test(x)) return t('every hour');
    if ((m = x.match(/^0 \*\/(\d+) \* \* \*$/))) return t('every {n} h', { n: m[1] });
    if ((m = x.match(/^every (\d+)\s*(m|min|h|d)$/i))) {
      var u = m[2].toLowerCase();
      if (u === 'd') return many(+m[1]) ? t('every {n} days', { n: m[1] }) : t('every {n} day', { n: m[1] });
      return u === 'h' ? t('every {n} h', { n: m[1] }) : t('every {n} min', { n: m[1] });
    }
    return x;
  }
  function shortModel(m) {
    if (!m) return '';
    var s = String(m), i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function sessTime(s) { return s.last_message_at || s.updated_at || s.created_at || 0; }
  function apiUrl(path) {
    var rel = path.charAt(0) === '/' ? path.slice(1) : path;
    return new URL(rel, document.baseURI || location.href).href;
  }
  async function getJSON(path) {
    var res = await fetch(apiUrl(path), { credentials: 'include', headers: { Accept: 'application/json' } });
    var body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, ok: res.ok, body: body };
  }
  async function postJSON(path, payload) {
    // the sidecar answers (errors, notes) in the hub's language
    if (path.indexOf(SIDECAR) === 0) payload = Object.assign({ _lang: lang() }, payload);
    var res = await fetch(apiUrl(path), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    var body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
    return body || {};
  }
  /* Sidecar action as a background job: the WebUI proxy gives one call 10 s, but hermes CLI calls,
     exports and speech can take longer. Post with _async, poll /job until done.
     Resolves with the action's JSON result, or the job id when opts.raw (speech audio). */
  async function sidecarJob(path, payload, opts) {
    opts = opts || {};
    var start = await postJSON(SIDECAR + path, Object.assign({}, payload, { _async: true }));
    if (!start.job) return start;
    var deadline = Date.now() + (opts.timeoutMs || 300000), wait = 700;
    while (Date.now() < deadline) {
      await sleep(wait);
      wait = Math.min(2000, wait + 300);
      var r = await getJSON(SIDECAR + '/job?id=' + encodeURIComponent(start.job));
      if (!r.ok || !r.body) throw new Error((r.body && r.body.error) || t('could not track the job ({status})', { status: r.status }));
      if (r.body.state === 'done') return opts.raw ? start.job : (r.body.result || {});
      if (r.body.state === 'error') throw new Error(r.body.error || t('failed'));
    }
    throw new Error(t('still running after {n} min', { n: Math.round((opts.timeoutMs || 300000) / 60000) }));
  }
  function toast(msg, type) {
    try { if (typeof showToast === 'function') showToast(msg, 3500, type); } catch (e) { /* noop */ }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function currentProfile() { return (typeof S !== 'undefined' && S && S.activeProfile) || 'default'; }

  var TOOL_LABELS = [  // English text; t() where used
    [/^(terminal|shell|bash|run_command|execute_code|code_execution)/, 'running a command'],
    [/^(web_search|search_web|web_extract|web_fetch|fetch_url)/, 'searching the web'],
    [/^browser/, 'browsing a website'],
    [/^(read_file|search_files|list_files|grep)/, 'reading files'],
    [/^(write_file|patch|edit_file|apply_patch)/, 'writing files'],
    [/^delegate/, 'delegating to a sub-agent'],
    [/^ask_agent/, 'consulting another bot'],
    [/^create_agent/, 'creating a new bot'],
    [/^(memory|honcho)/, 'checking its memory'],
    [/^(send_message|telegram|discord)/, 'sending a message'],
    [/^(cron|schedule)/, 'scheduling a routine'],
    [/^(image|vision)/, 'working on an image'],
    [/^(skill)/, 'using a skill'],
    [/^mcp_/, 'using a connector'],
  ];
  function toolLabel(tool) {
    if (!tool) return '';
    var low = String(tool).toLowerCase();
    for (var i = 0; i < TOOL_LABELS.length; i++) if (TOOL_LABELS[i][0].test(low)) return t(TOOL_LABELS[i][1]);
    return t('using {tool}', { tool: tool });
  }

  // ── avatar: deterministic friendly bot face from a seed ─────────────────
  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function blobPath(r, cx, cy, base, jitter, n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 - Math.PI / 2;
      var rad = base + (r() - 0.5) * 2 * jitter;
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
    var d = '';
    for (var j = 0; j < n; j++) {
      var p0 = pts[(j - 1 + n) % n], p1 = pts[j], p2 = pts[(j + 1) % n], p3 = pts[(j + 2) % n];
      if (j === 0) d += 'M' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1);
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d + 'Z';
  }
  // The ten bot-forge / desktop face silhouettes. Colours and eyes come from the seed alone,
  // so one face can be tried in every shape; the shape only changes the body (and eye height).
  var FACE_STYLES = ['organic', 'round', 'boxy', 'capsule', 'nub', 'cloud', 'droplet', 'hexagon', 'sun', 'triangle'];
  var FACE_LABELS = {  // English text; t() where used
    organic: 'Organic', round: 'Circle', boxy: 'Square', capsule: 'Capsule', nub: 'Antennae',
    cloud: 'Cloud', droplet: 'Drop', hexagon: 'Hexagon', sun: 'Sun', triangle: 'Triangle',
  };
  function faceBody(style, r, fill, accent) {
    var f = ' fill="' + fill + '"';
    switch (style) {
      case 'round': return { body: '<circle cx="40" cy="42" r="28"' + f + '/>', dy: 0 };
      case 'boxy': return { body: '<rect x="13" y="15" width="54" height="52" rx="16"' + f + '/>', dy: 0 };
      case 'capsule': return { body: '<rect x="19" y="8" width="42" height="66" rx="21"' + f + '/>', dy: 0 };
      case 'nub': return {
        body: '<line x1="27" y1="22" x2="21" y2="9" stroke="' + accent + '" stroke-width="3" stroke-linecap="round"/>' +
          '<line x1="53" y1="22" x2="59" y2="9" stroke="' + accent + '" stroke-width="3" stroke-linecap="round"/>' +
          '<circle cx="21" cy="9" r="4.5" fill="' + accent + '"/><circle cx="59" cy="9" r="4.5" fill="' + accent + '"/>' +
          '<circle cx="40" cy="45" r="27"' + f + '/>', dy: 3 };
      case 'cloud': return {
        body: '<g' + f + '><circle cx="26" cy="47" r="17"/><circle cx="54" cy="47" r="17"/>' +
          '<circle cx="40" cy="33" r="19"/><rect x="24" y="44" width="32" height="20"/></g>', dy: 4 };
      case 'droplet': return { body: '<path d="M40 7 C40 7 67 37 67 52 A27 27 0 0 1 13 52 C13 37 40 7 40 7 Z"' + f + '/>', dy: 9 };
      case 'hexagon': {
        var pts = [];
        for (var i = 0; i < 6; i++) {
          var a = Math.PI / 6 + (i / 6) * Math.PI * 2;
          pts.push((40 + Math.cos(a) * 31).toFixed(1) + ',' + (42 + Math.sin(a) * 31).toFixed(1));
        }
        return { body: '<polygon points="' + pts.join(' ') + '" stroke="' + fill + '" stroke-width="6" stroke-linejoin="round"' + f + '/>', dy: 0 };
      }
      case 'sun': {
        var rays = '';
        for (var j = 0; j < 10; j++) {
          var b = (j / 10) * Math.PI * 2;
          rays += '<circle cx="' + (40 + Math.cos(b) * 31).toFixed(1) + '" cy="' + (41 + Math.sin(b) * 31).toFixed(1) + '" r="5" fill="' + accent + '"/>';
        }
        return { body: rays + '<circle cx="40" cy="41" r="27"' + f + '/>', dy: 0 };
      }
      case 'triangle': return {
        body: '<path d="M40 9 Q45 9 48 15 L71 60 Q74 69 64 69 L16 69 Q6 69 9 60 L32 15 Q35 9 40 9 Z"' + f + '/>', dy: 11, narrow: true };
      default: return { body: '<path d="' + blobPath(r, 40, 42, 28, 4, 7) + '"' + f + '/>', dy: 0 };
    }
  }
  // Face parts the user can pick. Without a choice, eyes are round and the mouth comes from the
  // seed (smile or small mouth), so existing faces keep their look.
  // Labels are English text, t() where used. Each distinct French label needs its own English key.
  var EYES = [
    ['round', 'Round'], ['happy', 'Happy'], ['sleepy', 'Closed'], ['wink', 'Wink'], ['dots', 'Dots'],
    ['surprised', 'Wide'], ['angry', 'Frowning'], ['sad', 'Downcast'], ['star', 'Stars'], ['heart', 'Hearts'],
  ];
  var MOUTHS = [
    ['smile', 'Smile'], ['grin', 'Grin'], ['mini', 'Small'], ['neutral', 'Neutral'], ['o', 'Astonished'],
    ['sad', 'Sad'], ['tongue', 'Tongue'], ['smirk', 'Smirk'], ['cat', 'Cat :3'],
  ];
  var MOODS = [
    ['Happy', 'happy', 'grin'], ['Content', 'round', 'smile'], ['Calm', 'sleepy', 'smile'],
    ['Focused', 'dots', 'neutral'], ['Surprised', 'surprised', 'o'], ['Amazed', 'star', 'grin'],
    ['In love', 'heart', 'smile'], ['Playful', 'wink', 'tongue'], ['Sly', 'wink', 'smirk'],
    ['Cute', 'round', 'cat'], ['Angry', 'angry', 'sad'], ['Sad', 'sad', 'sad'],
  ];
  var COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#10ac84', '#48dbfb', '#2e86de',
    '#5f27cd', '#a55eea', '#ff6b9d', '#8395a7', '#576574'];
  var INK = '#1b1b26';
  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(rgb, target, t) {
    return 'rgb(' + rgb.map(function (c, i) { return Math.round(c + (target[i] - c) * t); }).join(',') + ')';
  }
  function eyesSvg(kind, ex, ey, px, py) {
    var L = 40 - ex, R = 40 + ex;
    var whites = function (rx, ry) {
      return '<ellipse cx="' + L + '" cy="' + ey + '" rx="' + rx + '" ry="' + ry + '" fill="#fff"/>' +
        '<ellipse cx="' + R + '" cy="' + ey + '" rx="' + rx + '" ry="' + ry + '" fill="#fff"/>';
    };
    var pupils = function (r, dx, dy) {
      return '<circle cx="' + (L + dx).toFixed(1) + '" cy="' + (ey + dy).toFixed(1) + '" r="' + r + '" fill="' + INK + '"/>' +
        '<circle cx="' + (R + dx).toFixed(1) + '" cy="' + (ey + dy).toFixed(1) + '" r="' + r + '" fill="' + INK + '"/>';
    };
    var arc = function (x, up) {
      return '<path d="M' + (x - 5.5) + ' ' + (ey + (up ? 2 : -1)) + ' Q' + x + ' ' + (ey + (up ? -6 : 5)) + ' ' + (x + 5.5) + ' ' + (ey + (up ? 2 : -1)) +
        '" stroke="' + INK + '" stroke-width="3" fill="none" stroke-linecap="round"/>';
    };
    var star = function (x) {
      var p = [];
      for (var i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? 3 : 7.5;
        p.push((x + Math.cos(a) * rad).toFixed(1) + ',' + (ey + Math.sin(a) * rad).toFixed(1));
      }
      return '<polygon points="' + p.join(' ') + '" fill="#fff" stroke="' + INK + '" stroke-width="1.2" stroke-linejoin="round"/>';
    };
    var heart = function (x) {
      return '<path d="M' + x + ' ' + (ey + 6) + ' C' + (x - 9) + ' ' + (ey - 1) + ' ' + (x - 5) + ' ' + (ey - 8) + ' ' + x + ' ' + (ey - 3) +
        ' C' + (x + 5) + ' ' + (ey - 8) + ' ' + (x + 9) + ' ' + (ey - 1) + ' ' + x + ' ' + (ey + 6) + ' Z" fill="#ff3b6b" stroke="#fff" stroke-width="1"/>';
    };
    var brows = function (inward) {
      var d = inward ? 1 : -1;
      return '<path d="M' + (L - 6) + ' ' + (ey - 10 - 2 * d) + ' L' + (L + 5) + ' ' + (ey - 10 + 2 * d) + '" stroke="' + INK + '" stroke-width="2.6" stroke-linecap="round"/>' +
        '<path d="M' + (R + 6) + ' ' + (ey - 10 - 2 * d) + ' L' + (R - 5) + ' ' + (ey - 10 + 2 * d) + '" stroke="' + INK + '" stroke-width="2.6" stroke-linecap="round"/>';
    };
    switch (kind) {
      case 'happy': return arc(L, true) + arc(R, true);
      case 'sleepy': return arc(L, false) + arc(R, false);
      case 'wink':
        return '<ellipse cx="' + L + '" cy="' + ey + '" rx="6.2" ry="7" fill="#fff"/>' +
          '<circle cx="' + (L + px).toFixed(1) + '" cy="' + (ey + py).toFixed(1) + '" r="3.1" fill="' + INK + '"/>' + arc(R, true);
      case 'dots': return pupils(3.4, 0, 0);
      case 'surprised': return whites(7.8, 8.6) + pupils(2.3, 0, 0);
      case 'angry': return whites(6.2, 6) + pupils(3, px * 0.4, 1) + brows(true);
      case 'sad': return whites(6.2, 7) + pupils(3, 0, 2) + brows(false);
      case 'star': return star(L) + star(R);
      case 'heart': return heart(L) + heart(R);
      default: return whites(6.2, 7) + pupils(3.1, px, py);
    }
  }
  function mouthSvg(kind, my) {
    var s = ' stroke="' + INK + '" stroke-opacity=".8" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
    switch (kind) {
      case 'grin':
        return '<path d="M32 ' + my + ' Q40 ' + (my + 12) + ' 48 ' + my + ' Z" fill="' + INK + '" fill-opacity=".85"/>' +
          '<ellipse cx="40" cy="' + (my + 6) + '" rx="3.6" ry="2.2" fill="#ff7a93"/>';
      case 'mini': return '<ellipse cx="40" cy="' + (my + 1) + '" rx="4" ry="2.6" fill="' + INK + '" fill-opacity=".8"/>';
      case 'neutral': return '<path d="M35 ' + (my + 2) + ' L45 ' + (my + 2) + '"' + s;
      case 'o': return '<ellipse cx="40" cy="' + (my + 2) + '" rx="3.4" ry="4.3" fill="' + INK + '" fill-opacity=".85"/>';
      case 'sad': return '<path d="M34 ' + (my + 5) + ' Q40 ' + (my - 1) + ' 46 ' + (my + 5) + '"' + s;
      case 'tongue':
        return '<path d="M34 ' + my + ' Q40 ' + (my + 6) + ' 46 ' + my + '"' + s +
          '<path d="M38 ' + (my + 3) + ' Q38 ' + (my + 8) + ' 41 ' + (my + 8) + ' Q44 ' + (my + 8) + ' 43.5 ' + (my + 3) + '" fill="#ff7a93"/>';
      case 'smirk': return '<path d="M35 ' + (my + 2) + ' Q41 ' + (my + 5) + ' 46 ' + (my - 1) + '"' + s;
      case 'cat': return '<path d="M33 ' + my + ' Q36.5 ' + (my + 4) + ' 40 ' + my + ' Q43.5 ' + (my + 4) + ' 47 ' + my + '"' + s;
      default: return '<path d="M34 ' + my + ' Q40 ' + (my + 5) + ' 46 ' + my + '"' + s;
    }
  }
  var avatarCache = {};
  function avatarSvg(seed, style, opts) {
    opts = opts || {};
    var key = [seed, style || '', opts.color || '', opts.eyes || '', opts.mouth || ''].join('|');
    if (avatarCache[key]) return avatarCache[key];
    var r = rng(hash(String(seed)));
    var h1 = Math.floor(r() * 360), h2 = (h1 + 35 + Math.floor(r() * 50)) % 360;
    var gid = 'bh-g-' + hash(key).toString(36);
    var exr = r(), eyr = r(), pxr = r(), pyr = r(), smile = r() > 0.5;
    var rgb = hexToRgb(opts.color);
    var top = rgb ? mix(rgb, [255, 255, 255], 0.28) : 'hsl(' + h1 + ' 80% 66%)';
    var bottom = rgb ? mix(rgb, [0, 0, 0], 0.18) : 'hsl(' + h2 + ' 70% 50%)';
    var accent = rgb ? mix(rgb, [255, 255, 255], 0.45) : 'hsl(' + h2 + ' 75% 62%)';
    var shape = faceBody(style, rng(hash(seed + '|blob')), 'url(#' + gid + ')', accent);
    var ex = (shape.narrow ? 6 : 8) + Math.floor(exr * (shape.narrow ? 2 : 4)), ey = 38 + Math.floor(eyr * 4) + shape.dy;
    var px = (pxr - 0.5) * 2.4, py = (pyr - 0.3) * 2;
    var svg = '<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + top + '"/><stop offset="1" stop-color="' + bottom + '"/>' +
      '</linearGradient></defs>' + shape.body +
      eyesSvg(opts.eyes || 'round', ex, ey, px, py) +
      mouthSvg(opts.mouth || (smile ? 'smile' : 'mini'), ey + 13) + '</svg>';
    avatarCache[key] = svg;
    return svg;
  }
  function faceOpts(a) { return a ? { color: a.color || '', eyes: a.eyes || '', mouth: a.mouth || '' } : {}; }

  // ── model: one row per bot ──────────────────────────────────────────────
  function buildBots() {
    var profiles = (state.profiles && state.profiles.profiles) || [];
    var active = currentProfile();
    var metaByName = {};
    var gateway = state.meta && state.meta.gateway;
    ((state.meta && state.meta.bots) || []).forEach(function (b) { metaByName[b.name] = b; });
    var names = profiles.map(function (p) { return p.name; });
    Object.keys(metaByName).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    // The sidecar reads the disk on every poll: trust it over the WebUI's cached profile list,
    // so a bot deleted a second ago does not linger.
    if (state.sidecar === 'ok' && state.meta && state.meta.bots) names = names.filter(function (n) { return metaByName[n]; });

    return names.map(function (name) {
      var p = profiles.find(function (x) { return x.name === name; }) || { name: name };
      var m = metaByName[name] || {};
      var mine = state.sessions.filter(function (s) { return s.profile === name && !s.archived; })
        .sort(function (a, b) { return sessTime(b) - sessTime(a); });
      var live = m.live || null;

      var attention = mine.find(function (s) { return s.attention && s.attention.kind && (s.attention.count == null || s.attention.count > 0); });
      var running = mine.filter(function (s) { return s.is_streaming || s.active_stream_id || s.cron_running; });
      var liveBusy = live && (live.status === 'working' || live.status === 'thinking');
      var liveWaiting = live && (live.status === 'waiting' || live.waiting);

      var st, label, detail = '';
      if (attention || liveWaiting) {
        st = 'attention';
        var kind = attention && attention.attention.kind;
        label = kind === 'clarify' ? t('Has a question for you') : t('Waiting for your approval');
        var on = attention ? attention.title : (live && live.title);
        if (on) detail = t('in “{title}”', { title: on });
        if (!attention && live && live.platform) detail = (detail ? detail + ' · ' : '') + 'via ' + live.platform;
      } else if (running.length || liveBusy) {
        st = 'working';
        label = t('Working');
        var bits = [];
        if (live && live.tool) bits.push(toolLabel(live.tool));
        else if (live && live.status === 'thinking') bits.push(t('thinking'));
        var cur = running[0];
        if (cur && cur.cron_running) bits.push(t('routine running'));
        var title = (cur && cur.title) || (live && live.title);
        if (title) bits.push(t('in “{title}”', { title: title }));
        if (live && live.subagents) bits.push(many(live.subagents) ? t('+{n} sub-agents', { n: live.subagents }) : t('+{n} sub-agent', { n: live.subagents }));
        detail = bits.join(' · ');
      } else if (mine.length) {
        st = 'idle'; label = t('Available'); detail = t('active {when}', { when: ago(sessTime(mine[0])) });
      } else {
        st = 'new'; label = t('Ready'); detail = t('not used yet');
      }

      var routines = m.routines || [];
      var enabled = routines.filter(function (r) { return r.enabled && !r.paused; });
      var next = enabled.map(function (r) { return r.next_run_at; }).filter(Boolean).sort()[0];
      var display = m.display_name || (name === LEAD ? 'Hermes' : name.charAt(0).toUpperCase() + name.slice(1));
      var platforms = [];
      if (gateway && gateway.running && (gateway.served_profiles || []).indexOf(name) >= 0) {
        Object.keys(gateway.platforms || {}).forEach(function (k) {
          if (gateway.platforms[k] === 'connected' && (name === LEAD || (m.channels || []).indexOf(k) >= 0)) {
            platforms.push(k.charAt(0).toUpperCase() + k.slice(1));
          }
        });
      }
      return {
        name: name,
        display: display,
        role: m.role || m.description || (name === LEAD ? t('Main agent · team lead') : ''),
        roleTitle: m.role || '',
        description: m.description || '',
        avatar: m.avatar || { seed: name, style: '' },
        model: shortModel((m.model && m.model.default) || p.model),
        modelRaw: m.model || { default: p.model || '', provider: p.provider || '' },
        visible: p.visible !== false && !m.hidden,
        isDefault: name === LEAD,
        isHere: name === active,
        state: st, label: label, detail: detail,
        attentionSession: attention || null,
        lastSession: mine[0] || null,
        lastAt: mine[0] ? sessTime(mine[0]) : (live && live.updated_at) || 0,
        threads: mine.length,
        routines: routines,
        routinesOn: enabled.length,
        nextRoutine: next || null,
        channels: m.channels || [],
        hiddenFlag: !!m.hidden,
        voice: m.voice || null,
        platforms: platforms,
      };
    });
  }
  var ORDER = { attention: 0, working: 1, idle: 2, new: 3 };
  function sortBots(bots) {
    return bots.sort(function (a, b) {
      if (ORDER[a.state] !== ORDER[b.state]) return ORDER[a.state] - ORDER[b.state];
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return (b.lastAt || 0) - (a.lastAt || 0);
    });
  }
  function findBot(name) { return buildBots().find(function (b) { return b.name === name; }); }

  // ── inbox: everything waiting for the user ──────────────────────────────
  function buildInbox(bots) {
    var byName = {};
    bots.forEach(function (b) { byName[b.name] = b; });
    var items = [], seen = {};
    state.webuiPending.forEach(function (p) {
      var key = 'w:' + p.sid + ':' + (p.approvalId || p.kind);
      items.push({
        key: key, source: 'webui', kind: p.kind, profile: p.profile, bot: byName[p.profile],
        sid: p.sid, title: p.title, command: p.command, question: p.question, choices: p.choices,
        approvalId: p.approvalId, runId: p.runId, mirrorToken: p.mirrorToken, since: p.since,
        answerable: p.kind === 'approval' && !!p.approvalId,
      });
      if (p.command) seen[p.profile + '|' + String(p.command).slice(0, 40)] = true;
    });
    ((state.meta && state.meta.approvals) || []).forEach(function (a) {
      if (seen[a.profile + '|' + String(a.command || '').slice(0, 40)]) return;
      items.push({
        key: 'g:' + (a.request_id || (a.profile + ':' + a.since)), source: 'gateway', kind: 'approval',
        profile: a.profile, bot: byName[a.profile], title: a.title, command: a.command, platform: a.platform,
        since: a.since, wait: a.wait, rid: a.request_id, answerable: !!a.answerable,
      });
    });
    return items;
  }

  // ── bot creations in progress (chats with the lead) ─────────────────────
  function activeCreations() {
    var list = store.get('creations', []);
    var keep = [], ghosts = [], changed = false;
    list.forEach(function (c) {
      if (Date.now() - c.at > 30 * 60 * 1000) { changed = true; return; }
      var s = state.sessions.find(function (x) { return x.session_id === c.sid; });
      var running = s ? !!(s.is_streaming || s.active_stream_id) : Date.now() - c.at < 90 * 1000;
      if (running) { keep.push(c); ghosts.push(c); } else { changed = true; state.profilesAt = 0; }
    });
    if (changed) store.set('creations', keep);
    return ghosts;
  }

  // ── data loading ────────────────────────────────────────────────────────
  var consentCheckedAt = 0;
  async function sidecarConsented(force) {
    if (state.sidecar === 'ok' && !force) return true;
    if (!force && Date.now() - consentCheckedAt < 60000) return state.sidecar !== 'consent';
    consentCheckedAt = Date.now();
    try {
      var r = await getJSON('/api/extensions/status');
      var sc = r.ok && r.body && (r.body.sidecars || []).find(function (s) { return s.id === EXT_ID; });
      if (sc && sc.proxy && sc.proxy.available && !sc.proxy.consented) { state.sidecar = 'consent'; return false; }
    } catch (e) { /* fall through and try the proxy */ }
    return true;
  }
  async function loadSidecar(force) {
    if (!(await sidecarConsented(force))) return;
    try {
      var r = await getJSON(SIDECAR + '/bots' + (force ? '?fresh=1' : ''));
      if (r.ok && r.body && r.body.bots) {
        state.meta = r.body; state.sidecar = 'ok';
        if (!configLoaded) await loadConfig();
        return;
      }
      state.sidecar = r.status === 403 ? 'consent' : 'down';
    } catch (e) { state.sidecar = 'down'; }
  }
  async function loadPending() {
    var asks = state.sessions.filter(function (s) {
      return !s.archived && s.attention && s.attention.kind && (s.attention.count == null || s.attention.count > 0);
    }).slice(0, 12);
    var out = await Promise.all(asks.map(async function (s) {
      var clarify = s.attention.kind === 'clarify';
      try {
        var r = await getJSON('/api/' + (clarify ? 'clarify' : 'approval') + '/pending?session_id=' + encodeURIComponent(s.session_id));
        var p = r.ok && r.body && r.body.pending;
        if (!p) return null;
        var mirror = String(p._gateway_mirror_token || '').trim(), run = String(p.run_id || '').trim();
        return {
          kind: clarify ? 'clarify' : 'approval', sid: s.session_id, profile: s.profile || 'default', title: s.title,
          command: p.command || p.description || '', question: p.question || p.prompt || p.text || '',
          choices: Array.isArray(p.choices) ? p.choices.slice(0, 4) : [],
          approvalId: p.approval_id || '', runId: run && mirror ? run : '', mirrorToken: run && mirror ? mirror : '',
          since: p.created_at || p.ts || sessTime(s),
        };
      } catch (e) { return null; }
    }));
    state.webuiPending = out.filter(Boolean);
  }
  async function refresh(force) {
    if (inFlight) return;
    inFlight = true;
    try {
      var jobs = [getJSON('/api/sessions?all_profiles=1'), loadSidecar(force)];
      var needProfiles = force || !state.profiles || Date.now() - state.profilesAt > PROFILES_MS;
      if (needProfiles) jobs.push(getJSON('/api/profiles'));
      var res = await Promise.all(jobs);
      var sess = res[0];
      if (sess.ok && sess.body) {
        state.sessions = sess.body.sessions || [];
        if (sess.body.server_time) state.clockSkew = sess.body.server_time - Date.now() / 1000;
        state.error = null;
      } else {
        state.error = t('Could not read the conversations ({status})', { status: sess.status });
      }
      if (needProfiles && res[2] && res[2].ok) { state.profiles = res[2].body; state.profilesAt = Date.now(); }
      await loadPending();
      state.lastUpdate = Date.now();
    } catch (e) {
      state.error = t('WebUI unreachable');
    } finally {
      inFlight = false;
    }
    render();
  }
  function isOpen() {
    var main = document.querySelector('main.main');
    return !!(main && main.classList.contains('showing-' + PANEL));
  }
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    timer = setTimeout(function () { refresh().then(schedule); }, isOpen() || modal ? FAST_MS : SLOW_MS);
  }

  // ── navigation actions ──────────────────────────────────────────────────
  async function ensureProfile(name, opening) {
    if (currentProfile() === name || typeof switchToProfile !== 'function') return true;
    try {
      if (opening && typeof _profileSwitchOpeningExistingSession !== 'undefined') _profileSwitchOpeningExistingSession = true;
      await switchToProfile(name);
    } finally {
      try { if (typeof _profileSwitchOpeningExistingSession !== 'undefined') _profileSwitchOpeningExistingSession = false; } catch (e) { /* noop */ }
    }
    return currentProfile() === name;
  }
  async function openSession(name, session) {
    if (!(await ensureProfile(name, true))) throw new Error(t('could not switch profile'));
    if (typeof switchPanel === 'function') await switchPanel('chat');
    if (typeof _openSidebarSession === 'function') await _openSidebarSession(session);
    else await loadSession(session.session_id);
  }
  async function openNewThread(name) {
    if (!(await ensureProfile(name, false))) throw new Error(t('could not switch profile'));
    if (typeof switchPanel === 'function') await switchPanel('chat');
    if (typeof newSession === 'function') await newSession();
    var box = document.getElementById('msg');
    if (box) try { box.focus(); } catch (e) { /* noop */ }
  }
  /* Start a fresh chat with `profile` and send `text` as the first message. */
  async function sendAs(profile, text) {
    await openNewThread(profile);
    var box = document.getElementById('msg');
    if (!box || typeof send !== 'function') throw new Error('composer');
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await send();
    return (typeof S !== 'undefined' && S && S.session && S.session.session_id) || null;
  }
  async function talkTo(bot, fresh) {
    if (openingBot) return;
    openingBot = bot.name;
    render();
    try {
      var target = fresh ? null : (bot.attentionSession || state.sessions
        .filter(function (s) { return s.profile === bot.name && !s.archived && s.session_source === 'webui' && !s.read_only; })
        .sort(function (a, b) { return sessTime(b) - sessTime(a); })[0]);
      if (target) await openSession(bot.name, target);
      else await openNewThread(bot.name);
    } catch (e) {
      toast(t('Could not open the conversation with {name}', { name: bot.display }), 'error');
    } finally {
      openingBot = null;
      render();
    }
  }

  // ── create a bot in one sentence ────────────────────────────────────────
  function createPrompt(desc, name) {
    return t('Create a new Hermes bot for me with the create_agent tool (bot-forge plugin; find it with tool_search if it is not visible).') + '\n\n' +
      t('Mission: {desc}', { desc: desc }) + '\n' +
      (name ? t('Preferred name: {name}', { name: name }) + '\n' : '') +
      '\n' + t('Rules: do not ask me any questions, design it yourself (original name, role, SOUL.md in English, tools; routines only if the mission is recurring). First check with list_agents that no bot already does this job. When it is done, give me a short report: name, role, routines, and what I need to set up next.');
  }
  async function createBot(desc, name) {
    desc = String(desc || '').trim();
    if (desc.length < 8) { toast(t('Describe the bot\'s mission in one sentence'), 'error'); return; }
    closeModal();
    try {
      var sid = await sendAs(LEAD, createPrompt(desc, String(name || '').trim()));
      var list = store.get('creations', []);
      list.push({ sid: sid, at: Date.now(), desc: desc.slice(0, 120) });
      store.set('creations', list.slice(-5));
      toast(t('{lead} is creating your bot — follow the progress here', { lead: leadName() }), 'success');
    } catch (e) {
      toast(t('Could not start the creation: {error}', { error: e.message || e }), 'error');
    }
  }
  function leadName() { var b = findBot(LEAD); return b ? b.display : 'Hermes'; }

  // ── team thread: the lead delegates to the other bots ───────────────────
  function teamPrompt() {
    var bots = buildBots();
    var lead = bots.find(function (b) { return b.isDefault; });
    var members = bots.filter(function (b) { return !b.isDefault && b.visible; });
    var roster = members.map(function (b) {
      return t('- @{name} ({display}): {role}', { name: b.name, display: b.display, role: b.role || b.description || 'bot' });
    }).join('\n');
    return t('This thread is our team thread. You are {lead}, the team lead.', { lead: lead ? lead.display : t('the main bot') }) + '\n\n' +
      t('Your team today:') + '\n' + roster + '\n\n' +
      t('When I give you a task here: break it down, delegate each part to the right bot with the ask_agent tool (bot-forge plugin; tool_search if needed), then give me a summary saying who did what. If I write @name, pass it straight to that bot. Use list_agents to know the current team, and do not do a specialist\'s work yourself.') + '\n\n' +
      t('To confirm, reply only “Team ready” followed by the list of members.');
  }
  async function openTeamThread() {
    if (busy.team) return;
    busy.team = true; render();
    try {
      var sid = store.get('teamSid', null);
      if (!sid) {
        // Another browser may have created it: same profile, same title.
        var found = state.sessions.find(function (x) {
          return x.profile === LEAD && !x.archived && (x.title === TEAM_TITLE || x.title === FR[TEAM_TITLE]);
        });
        if (found) sid = found.session_id;
      }
      if (sid) {
        // 409 = exists but belongs to another profile than this tab's: still ours.
        var known = state.sessions.find(function (x) { return x.session_id === sid; });
        var exists = known ? !known.archived : false;
        if (!known) {
          var r = await getJSON('/api/session?session_id=' + encodeURIComponent(sid));
          var s = r.body && (r.body.session || r.body);
          exists = (r.ok || r.status === 409) && !!s && s.session_id === sid && !s.archived;
        }
        if (exists) {
          await openSession(LEAD, { session_id: sid, profile: LEAD });
          return;
        }
      }
      var newSid = await sendAs(LEAD, teamPrompt());
      if (newSid) {
        store.set('teamSid', newSid);
        await sleep(1500);
        try { await postJSON('/api/session/rename', { session_id: newSid, title: t(TEAM_TITLE) }); } catch (e) { /* cosmetic */ }
        try { await postJSON('/api/session/pin', { session_id: newSid, pinned: true }); } catch (e) { /* cosmetic */ }
      }
    } catch (e) {
      toast(t('Could not open the team thread: {error}', { error: e.message || e }), 'error');
    } finally {
      busy.team = false; render();
    }
  }

  // ── approvals ───────────────────────────────────────────────────────────
  async function answer(item, choice) {
    if (busy[item.key]) return;
    busy[item.key] = choice; render();
    try {
      if (item.source === 'webui') {
        var body = { session_id: item.sid, choice: choice, approval_id: item.approvalId };
        if (item.runId && item.mirrorToken) { body.run_id = item.runId; body.mirror_token = item.mirrorToken; }
        await postJSON('/api/approval/respond', body);
      } else {
        await sidecarJob('/approval', { request_id: item.rid, choice: choice });
      }
      toast(choice === 'deny' ? t('Denied') : t('Allowed once'), 'success');
    } catch (e) {
      toast(t('Failed: {error}', { error: e.message || e }), 'error');
    } finally {
      delete busy[item.key];
      refresh(true);
    }
  }

  // ── routines ────────────────────────────────────────────────────────────
  async function routineAction(store_, id, action) {
    var key = 'r:' + id;
    if (busy[key]) return;
    busy[key] = action; renderModal(false);
    try {
      await sidecarJob('/routine', { action: action, store: store_, id: id });
      toast({ run: t('Routine started (on the scheduler\'s next pass)'), pause: t('Routine paused'), resume: t('Routine resumed') }[action], 'success');
    } catch (e) {
      toast(t('Failed: {error}', { error: e.message || e }), 'error');
    } finally {
      delete busy[key];
      await refresh(true);
      renderModal(false);
    }
  }
  function scheduleFromForm(root) {
    var kind = root.querySelector('[name=bh-when]').value;
    var time = (root.querySelector('[name=bh-time]').value || '08:00').split(':');
    var h = Math.min(23, Math.max(0, parseInt(time[0], 10) || 0)), m = Math.min(59, Math.max(0, parseInt(time[1], 10) || 0));
    var n = Math.max(1, parseInt(root.querySelector('[name=bh-every]').value, 10) || 2);
    switch (kind) {
      case 'daily': return m + ' ' + h + ' * * *';
      case 'weekdays': return m + ' ' + h + ' * * 1-5';
      case 'monday': return m + ' ' + h + ' * * 1';
      case 'hourly': return '0 * * * *';
      case 'every': return 'every ' + n + 'h';
      default: return root.querySelector('[name=bh-cron]').value.trim();
    }
  }
  async function routineCreate(botName) {
    var root = document.getElementById('bhModal');
    if (!root) return;
    var payload = {
      bot: botName,
      name: root.querySelector('[name=bh-rname]').value.trim(),
      schedule: scheduleFromForm(root),
      prompt: root.querySelector('[name=bh-rprompt]').value.trim(),
      deliver: root.querySelector('[name=bh-deliver]').value,
    };
    if (payload.prompt.length < 3) { toast(t('Write what the bot should do on each run'), 'error'); return; }
    busy.rcreate = true; renderModal(false);
    try {
      await sidecarJob('/routine/create', payload);
      toast(t('Routine created'), 'success');
      root.querySelector('[name=bh-rname]').value = '';
      root.querySelector('[name=bh-rprompt]').value = '';
    } catch (e) {
      toast(t('Failed: {error}', { error: e.message || e }), 'error');
    } finally {
      busy.rcreate = false;
      await refresh(true);
      renderModal(false);
    }
  }
  async function grantConsent() {
    try {
      await postJSON('/api/extensions/sidecar-proxy-consent', { id: EXT_ID, approved: true });
      toast(t('Bot details enabled'), 'success');
    } catch (e) {
      toast(t('Activation refused — see Settings → Extensions'), 'error');
    }
    refresh(true);
  }

  // ── rendering ───────────────────────────────────────────────────────────
  var STATE_CLASS = { attention: 'is-attention', working: 'is-working', idle: 'is-idle', new: 'is-new' };
  var ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  };

  function avatarHtml(bot, size) {
    if (!bot) return '<span class="bh-avatar is-idle" style="--bh-size:' + size + 'px"></span>';
    return '<span class="bh-avatar ' + STATE_CLASS[bot.state] + '" style="--bh-size:' + size + 'px">' +
      avatarSvg(bot.avatar.seed || bot.name, bot.avatar.style, faceOpts(bot.avatar)) + '<i class="bh-dot"></i></span>';
  }
  function view() {
    var all = sortBots(buildBots());
    var hidden = all.filter(function (b) { return !b.visible; });
    var shown = state.showHidden ? all : all.filter(function (b) { return b.visible; });
    return { shown: shown, hidden: hidden, all: all, inbox: buildInbox(all), ghosts: activeCreations() };
  }

  function sidebarHtml(v) {
    var top = '<button type="button" class="bh-row bh-row-team" data-bh-team title="' + t('Team thread: {lead} delegates to the other bots', { lead: esc(leadName()) }) + '">' +
      '<span class="bh-row-icon">' + ICONS.team + '</span><span class="bh-row-text"><span class="bh-row-name">' + t('Team thread') + '</span>' +
      '<span class="bh-row-status">' + t('{lead} delegates to the bots', { lead: esc(leadName()) }) + '</span></span>' + (busy.team ? '<span class="bh-spin"></span>' : '') + '</button>';
    if (v.inbox.length) {
      var n = v.inbox.length;
      top = '<button type="button" class="bh-row bh-row-inbox is-attention" data-bh-goto-inbox>' +
        '<span class="bh-row-icon">' + ICONS.bell + '</span><span class="bh-row-text"><span class="bh-row-name">' + t('To approve') + '</span>' +
        '<span class="bh-row-status">' + (many(n) ? t('{n} pending requests', { n: n }) : t('{n} pending request', { n: n })) + '</span></span></button>' + top;
    }
    var rows = v.shown.map(function (b) {
      return '<button type="button" class="bh-row ' + STATE_CLASS[b.state] + (b.isHere ? ' is-here' : '') + '" data-bh-talk="' + esc(b.name) + '" title="' + t('Chat with {name}', { name: esc(b.display) }) + '">' +
        avatarHtml(b, 30) +
        '<span class="bh-row-text"><span class="bh-row-name">' + esc(b.display) + (b.isDefault ? ' <em>' + t('lead') + '</em>' : '') + '</span>' +
        '<span class="bh-row-status">' + esc(b.label) + (b.state === 'idle' ? ' · ' + esc(ago(b.lastAt)) : '') + '</span></span>' +
        (openingBot === b.name ? '<span class="bh-spin"></span>' : '') +
        '</button>';
    }).join('');
    v.ghosts.forEach(function (g) {
      rows += '<button type="button" class="bh-row is-working is-ghost" data-bh-open-sid="' + esc(g.sid) + '"><span class="bh-avatar is-working" style="--bh-size:30px"><span class="bh-spin"></span></span>' +
        '<span class="bh-row-text"><span class="bh-row-name">' + t('New bot…') + '</span><span class="bh-row-status">' + esc(g.desc) + '</span></span></button>';
    });
    return top + '<div class="bh-side-sep"></div>' + (rows || '<div class="bh-empty-small">' + t('No bots yet.') + '</div>');
  }

  function summaryHtml(v) {
    var c = { attention: 0, working: 0, idle: 0, new: 0 };
    v.shown.forEach(function (b) { c[b.state]++; });
    var chips = [];
    if (v.inbox.length) chips.push('<button type="button" class="bh-chip is-attention" data-bh-goto-inbox><i></i>' + t('{n} to approve', { n: v.inbox.length }) + '</button>');
    chips.push('<span class="bh-chip is-working"><i></i>' + t('{n} working', { n: c.working }) + '</span>');
    var free = c.idle + c.new;
    chips.push('<span class="bh-chip is-idle"><i></i>' + (many(free) ? t('{n} bots available', { n: free }) : t('{n} bot available', { n: free })) + '</span>');
    var gw = state.meta && state.meta.gateway;
    if (gw) {
      var plats = Object.keys(gw.platforms || {}).filter(function (k) { return gw.platforms[k] === 'connected'; });
      chips.push('<span class="bh-chip ' + (gw.running ? 'is-ok' : 'is-off') + '"><i></i>Gateway ' + (gw.running ? (plats.length ? plats.join(', ') : t('running')) : t('stopped')) + '</span>');
    }
    return chips.join('');
  }

  function inboxHtml(items) {
    if (!items.length) return '';
    var now = nowSec();
    var rows = items.map(function (it) {
      var who = it.bot ? it.bot.display : it.profile;
      var head, body;
      if (it.kind === 'clarify') {
        head = t('{name} has a question for you', { name: '<strong>' + esc(who) + '</strong>' });
        body = '<div class="bh-ask-q">' + esc(it.question || t('Pending question')) + '</div>';
      } else {
        head = t('{name} asks for your approval', { name: '<strong>' + esc(who) + '</strong>' });
        body = it.command ? '<pre class="bh-cmd">' + esc(it.command) + '</pre>' : '';
      }
      var meta = [];
      if (it.platform) meta.push('via ' + it.platform);
      else if (it.source === 'webui') meta.push(t('in the WebUI'));
      if (it.since) meta.push(ago(it.since));
      var left = it.wait && it.since ? Math.round(it.wait - (now - it.since)) : null;
      var timer = left != null ? '<span class="bh-ask-timer' + (left < 20 ? ' is-urgent' : '') + '">' + (left > 0 ? left + ' s' : t('expiring')) + '</span>' : '';
      var b = busy[it.key];
      var actions = '';
      if (it.kind === 'approval' && it.answerable) {
        actions += '<button type="button" class="bh-btn primary" data-bh-answer="once" data-bh-key="' + esc(it.key) + '"' + (b ? ' disabled' : '') + '>' + (b === 'once' ? '<span class="bh-spin"></span>' : '') + t('Allow once') + '</button>' +
          '<button type="button" class="bh-btn danger" data-bh-answer="deny" data-bh-key="' + esc(it.key) + '"' + (b ? ' disabled' : '') + '>' + (b === 'deny' ? '<span class="bh-spin"></span>' : '') + t('Deny') + '</button>';
      }
      if (it.sid) actions += '<button type="button" class="bh-btn" data-bh-open-sid="' + esc(it.sid) + '" data-bh-profile="' + esc(it.profile) + '">' + (it.kind === 'clarify' ? t('Reply in the thread') : t('Open the thread')) + '</button>';
      else if (!it.answerable) actions += '<span class="bh-ask-note">' + t('Reply on {platform}', { platform: esc(it.platform || t('the original platform')) }) + '</span>';
      return '<div class="bh-ask">' + avatarHtml(it.bot, 34) +
        '<div class="bh-ask-body"><div class="bh-ask-head"><span>' + head + '</span><span class="bh-ask-meta">' + esc(meta.join(' · ')) + '</span>' + timer + '</div>' +
        body + (it.title ? '<div class="bh-ask-sub">' + t('in “{title}”', { title: esc(it.title) }) + '</div>' : '') +
        '<div class="bh-ask-actions">' + actions + '</div></div></div>';
    }).join('');
    return '<section class="bh-inbox" id="bhInbox"><h3>' + t('To approve') + ' <span>' + items.length + '</span></h3>' + rows + '</section>';
  }

  function cardHtml(b) {
    var chips = [];
    if (b.model) chips.push('<span class="bh-tag" title="' + t('Model') + '">' + esc(b.model) + '</span>');
    if (state.sidecar === 'ok') {
      var rt = b.routines.length
        ? '⏱ ' + (many(b.routinesOn) ? t('{n} routines', { n: b.routinesOn }) : t('{n} routine', { n: b.routinesOn })) +
          (b.nextRoutine ? ' · ' + t('next {when}', { when: esc(whenIso(b.nextRoutine)) }) : '') +
          (b.routines.length > b.routinesOn ? ' · ' + t('{n} paused', { n: b.routines.length - b.routinesOn }) : '')
        : '＋ routine';
      chips.push('<button type="button" class="bh-tag is-link" data-bh-routines="' + esc(b.name) + '" title="' + t('View and manage routines') + '">' + rt + '</button>');
    }
    b.platforms.forEach(function (pl) { chips.push('<span class="bh-tag">' + esc(pl) + '</span>'); });
    if (b.voice && b.voice.voice) chips.push('<span class="bh-tag" title="' + t('Voice for spoken replies ({provider})', { provider: esc(b.voice.provider) }) + '">🔊 ' + esc(b.voice.voice) + '</span>');
    if (b.isHere) chips.push('<span class="bh-tag is-here" title="' + t('Active profile in this tab') + '">' + t('open here') + '</span>');

    var last = b.lastSession
      ? '<div class="bh-last">' + t('Last thread:') + ' <span>' + esc(b.lastSession.title || t('Untitled')) + '</span> · ' + esc(ago(b.lastAt)) + ' · ' +
        (many(b.threads) ? t('{n} threads', { n: b.threads }) : t('{n} thread', { n: b.threads })) + '</div>'
      : '<div class="bh-last">' + t('No conversations yet.') + '</div>';
    var opening = openingBot === b.name;
    return '<article class="bh-card ' + STATE_CLASS[b.state] + (b.visible ? '' : ' is-hidden') + '" data-bot="' + esc(b.name) + '">' +
      (state.sidecar === 'ok' ? '<button type="button" class="bh-card-edit" data-bh-edit="' + esc(b.name) + '" title="' + t('Edit {name} (name, role, face, model…)', { name: esc(b.display) }) + '" aria-label="' + t('Edit {name}', { name: esc(b.display) }) + '">' + ICONS.edit + '</button>' : '') +
      '<header class="bh-card-head">' + avatarHtml(b, 52) +
        '<div class="bh-card-id"><div class="bh-card-name">' + esc(b.display) + (b.isDefault ? '<span class="bh-badge">' + t('team lead') + '</span>' : '') + '</div>' +
        '<div class="bh-card-role" title="' + esc(b.description) + '">' + esc(b.role || t('Profile “{name}”', { name: b.name })) + '</div></div>' +
      '</header>' +
      '<div class="bh-status"><span class="bh-pill ' + STATE_CLASS[b.state] + '"><i></i>' + esc(b.label) + '</span>' +
        (b.detail ? '<span class="bh-detail">' + esc(b.detail) + '</span>' : '') + '</div>' +
      (chips.length ? '<div class="bh-tags">' + chips.join('') + '</div>' : '') +
      last +
      '<footer class="bh-actions">' +
        '<button type="button" class="bh-btn primary" data-bh-talk="' + esc(b.name) + '"' + (opening ? ' disabled' : '') + '>' + (opening ? '<span class="bh-spin"></span>' : '') + (b.state === 'attention' ? t('Reply') : t('Chat')) + '</button>' +
        '<button type="button" class="bh-btn" data-bh-new="' + esc(b.name) + '"' + (opening ? ' disabled' : '') + '>' + t('New thread') + '</button>' +
      '</footer></article>';
  }
  function ghostHtml(g) {
    return '<article class="bh-card is-working is-ghost"><header class="bh-card-head"><span class="bh-avatar is-working" style="--bh-size:52px"><span class="bh-spin"></span></span>' +
      '<div class="bh-card-id"><div class="bh-card-name">' + t('New bot') + '</div><div class="bh-card-role">' + esc(g.desc) + '</div></div></header>' +
      '<div class="bh-status"><span class="bh-pill is-working"><i></i>' + t('{lead} is preparing it…', { lead: esc(leadName()) }) + '</span><span class="bh-detail">' + t('name, role, tools, routines — 1 to 3 min') + '</span></div>' +
      '<footer class="bh-actions"><button type="button" class="bh-btn" data-bh-open-sid="' + esc(g.sid) + '" data-bh-profile="' + LEAD + '">' + t('Follow the creation') + '</button></footer></article>';
  }
  function newCardHtml() {
    return '<button type="button" class="bh-card bh-card-new" data-bh-open-create><span class="bh-new-plus">' + ICONS.plus + '</span>' +
      '<span class="bh-card-name">' + t('New bot') + '</span><span class="bh-card-role">' + t('Describe its mission in one sentence, {lead} takes care of the rest.', { lead: esc(leadName()) }) + '</span></button>';
  }

  function bannerHtml() {
    if (state.sidecar === 'consent') {
      return '<div class="bh-banner"><div><strong>' + t('Enable bot details') + '</strong><br>' +
        t('Role, avatar, routines, approvals and current tool come from the Bot Hub service, on the Hermes machine. Allow the WebUI to contact it (local).') +
        '</div><button type="button" class="bh-btn primary" data-bh-consent>' + t('Enable') + '</button></div>';
    }
    if (state.sidecar === 'down') {
      return '<div class="bh-banner is-muted">' +
        t('Bot Hub service unreachable — limited view (no role, routines or approvals). On the Hermes machine: {cmd}', { cmd: '<code>systemctl --user restart bot-hub-sidecar</code>' }) + '</div>';
    }
    return '';
  }

  function mainHtml(v) {
    var updated = state.lastUpdate
      ? t('updated {time}', { time: new Date(state.lastUpdate).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
      : t('loading…');
    var cards = v.shown.map(cardHtml).join('') + v.ghosts.map(ghostHtml).join('');
    if (!state.profiles && !state.meta) cards = '<div class="bh-empty">' + t('Loading your team…') + '</div>';
    else cards += newCardHtml();
    var nh = v.hidden.length, hiddenText;
    if (state.showHidden) hiddenText = many(nh) ? t('Hide {n} hidden bots', { n: nh }) : t('Hide {n} hidden bot', { n: nh });
    else hiddenText = many(nh) ? t('Show {n} hidden bots', { n: nh }) : t('Show {n} hidden bot', { n: nh });
    var hiddenNote = nh
      ? '<button type="button" class="bh-link" data-bh-toggle-hidden>' + hiddenText + '</button>'
      : '';
    return '<div class="bh-intro"><p>' + t('Your team of Hermes agents. Write to them as you would to a colleague: they work on their own and come back to you when they need your approval.') + '</p>' +
      '<div class="bh-summary">' + summaryHtml(v) + '<span class="bh-updated">' + esc(updated) + '</span></div></div>' +
      (state.error ? '<div class="bh-banner is-error">' + esc(state.error) + '</div>' : '') +
      bannerHtml() + inboxHtml(v.inbox) +
      '<div class="bh-grid">' + cards + '</div>' +
      '<div class="bh-foot">' + hiddenNote + '</div>';
  }

  // ── modals ──────────────────────────────────────────────────────────────
  var SUGGESTIONS = [  // English text; t() where used
    'Sort my emails every morning at 8am and summarize the urgent ones',
    'Watch Fed and ECB announcements and alert me',
    'Keep an eye on AI news and send a digest every Friday',
    'Check the server\'s health (disk, RAM, services) every day',
  ];
  function createModalHtml() {
    return '<div class="bh-modal-head"><h2>' + t('New bot') + '</h2><button type="button" class="panel-head-btn" data-bh-close aria-label="' + t('Close') + '">' + ICONS.close + '</button></div>' +
      '<div class="bh-modal-body">' +
      '<label class="bh-field"><span>' + t('What should this bot do?') + '</span><textarea name="bh-desc" rows="3" placeholder="' + t('E.g. watch crypto news and send me a summary every evening at 7pm') + '"></textarea></label>' +
      '<div class="bh-suggest">' + SUGGESTIONS.map(function (s) { var x = t(s); return '<button type="button" class="bh-tag is-link" data-bh-suggest="' + esc(x) + '">' + esc(x) + '</button>'; }).join('') + '</div>' +
      '<label class="bh-field"><span>' + t('Name (optional)') + '</span><input name="bh-name" type="text" maxlength="40" placeholder="' + t('Leave empty, {lead} will find one', { lead: esc(leadName()) }) + '"></label>' +
      (features.bot_forge
        ? '<p class="bh-hint">' + t('{lead} designs the bot with bot-forge (role, SOUL, tools, routines) and tests it. You follow the creation in a thread; it shows up here when it is ready.', { lead: esc(leadName()) }) + '</p>'
        : '<p class="bh-hint">' + t('One-sentence creation uses the <strong>bot-forge</strong> plugin, which is not enabled on the main profile: <code>hermes plugins enable bot-forge</code>. You can also create a profile with <code>hermes profile create &lt;name&gt;</code>.') + '</p>') +
      '</div><div class="bh-modal-foot"><button type="button" class="bh-btn" data-bh-close>' + t('Cancel') + '</button>' +
      '<button type="button" class="bh-btn primary" data-bh-create' + (features.bot_forge ? '' : ' disabled') + '>' + t('Create the bot') + '</button></div>';
  }
  function routineListHtml(bot) {
    if (!bot) return '';
    if (!bot.routines.length) return '<div class="bh-empty-small">' + t('No routines. A routine makes {name} work on its own, at a set time.', { name: esc(bot.display) }) + '</div>';
    return bot.routines.map(function (r) {
      var b = busy['r:' + r.id];
      var stateChip = r.paused || !r.enabled ? '<span class="bh-pill is-idle"><i></i>' + t('Paused') + '</span>'
        : (r.last_status && r.last_status !== 'ok' ? '<span class="bh-pill is-attention"><i></i>' + t('Error') + '</span>' : '<span class="bh-pill is-working"><i></i>' + t('Active') + '</span>');
      var meta = [humanSchedule(r.schedule)];
      if (r.next_run_at && !r.paused) meta.push(t('next {when}', { when: whenIso(r.next_run_at) }));
      if (r.last_run_at) meta.push(t('last {when}', { when: whenIso(r.last_run_at) }) + (r.last_status ? ' (' + r.last_status + ')' : ''));
      return '<div class="bh-routine"><div class="bh-routine-head"><strong>' + esc(r.name) + '</strong>' + stateChip + '</div>' +
        '<div class="bh-routine-meta">' + esc(meta.filter(Boolean).join(' · ')) + '</div>' +
        (r.prompt ? '<div class="bh-routine-prompt">' + esc(r.prompt) + '</div>' : '') +
        (r.last_error ? '<div class="bh-routine-error">' + esc(r.last_error) + '</div>' : '') +
        '<div class="bh-ask-actions">' +
          '<button type="button" class="bh-btn" data-bh-raction="run" data-bh-store="' + esc(r.store) + '" data-bh-id="' + esc(r.id) + '"' + (b ? ' disabled' : '') + '>' + (b === 'run' ? '<span class="bh-spin"></span>' : '') + t('Run now') + '</button>' +
          (r.paused || !r.enabled
            ? '<button type="button" class="bh-btn" data-bh-raction="resume" data-bh-store="' + esc(r.store) + '" data-bh-id="' + esc(r.id) + '"' + (b ? ' disabled' : '') + '>' + (b === 'resume' ? '<span class="bh-spin"></span>' : '') + t('Resume') + '</button>'
            : '<button type="button" class="bh-btn" data-bh-raction="pause" data-bh-store="' + esc(r.store) + '" data-bh-id="' + esc(r.id) + '"' + (b ? ' disabled' : '') + '>' + (b === 'pause' ? '<span class="bh-spin"></span>' : '') + t('Pause') + '</button>') +
        '</div></div>';
    }).join('');
  }
  function routinesModalHtml(bot) {
    var delivers = [];
    bot.channels.forEach(function (c) { delivers.push('<option value="' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>'); });
    delivers.push('<option value="bot-chat:' + esc(bot.name) + '">' + t('{name}\'s thread', { name: esc(bot.display) }) + '</option>');
    delivers.push('<option value="local">' + t('Nowhere (log only)') + '</option>');
    return '<div class="bh-modal-head"><span class="bh-modal-av">' + avatarHtml(bot, 32) + '</span><h2>' + t('Routines — {name}', { name: esc(bot.display) }) + '</h2>' +
      '<button type="button" class="panel-head-btn" data-bh-close aria-label="' + t('Close') + '">' + ICONS.close + '</button></div>' +
      '<div class="bh-modal-body"><div id="bhRoutineList">' + routineListHtml(bot) + '</div>' +
      '<details class="bh-new-routine"' + (bot.routines.length ? '' : ' open') + '><summary>＋ ' + t('New routine') + '</summary>' +
        '<label class="bh-field"><span>' + t('Name') + '</span><input name="bh-rname" type="text" maxlength="80" placeholder="' + t('E.g. Evening summary') + '"></label>' +
        '<div class="bh-field-row"><label class="bh-field"><span>' + t('When') + '</span><select name="bh-when">' +
          '<option value="daily">' + t('Every day') + '</option><option value="weekdays">' + t('Weekdays') + '</option><option value="monday">' + t('Every Monday') + '</option>' +
          '<option value="hourly">' + t('Every hour') + '</option><option value="every">' + t('Every N hours') + '</option><option value="cron">' + t('Cron expression') + '</option>' +
        '</select></label>' +
        '<label class="bh-field" data-bh-when-for="daily weekdays monday"><span>' + t('At') + '</span><input name="bh-time" type="time" value="08:00"></label>' +
        '<label class="bh-field" data-bh-when-for="every" hidden><span>' + t('N hours') + '</span><input name="bh-every" type="number" min="1" max="24" value="2"></label>' +
        '<label class="bh-field" data-bh-when-for="cron" hidden><span>Cron</span><input name="bh-cron" type="text" placeholder="0 19 * * 1-5"></label></div>' +
        '<label class="bh-field"><span>' + t('What {name} should do on each run', { name: esc(bot.display) }) + '</span><textarea name="bh-rprompt" rows="3" placeholder="' + t('Standalone instruction: the bot receives it on its own, without the context of your conversations.') + '"></textarea></label>' +
        '<label class="bh-field"><span>' + t('Send the result to') + '</span><select name="bh-deliver">' + delivers.join('') + '</select></label>' +
        '<div class="bh-modal-foot is-inline"><button type="button" class="bh-btn primary" data-bh-rcreate="' + esc(bot.name) + '"' + (busy.rcreate ? ' disabled' : '') + '>' + (busy.rcreate ? '<span class="bh-spin"></span>' : '') + t('Create the routine') + '</button></div>' +
      '</details></div>';
  }
  // ── edit a bot: face, name, role, mission, model, persona — and delete ──
  var modelsCache = { at: 0, groups: null };
  async function loadModels() {
    if (modelsCache.groups && Date.now() - modelsCache.at < 300000) return modelsCache.groups;
    var r = await getJSON('/api/models');
    modelsCache.groups = (r.ok && r.body && r.body.groups) || [];
    modelsCache.at = Date.now();
    return modelsCache.groups;
  }
  function bareModel(id, provider) {
    var s = String(id || ''), p = '@' + provider + ':';
    return s.indexOf(p) === 0 ? s.slice(p.length) : s;
  }
  function sameModel(a, b) {
    var tail = function (x) { return String(x || '').toLowerCase().split('/').pop().replace(/\./g, '-'); };
    return tail(a) === tail(b);
  }
  function modelOptionsHtml(bot, groups) {
    var cur = bot.modelRaw || {};
    var found = false, html = '';
    (groups || []).forEach(function (g) {
      var prov = g.provider_id || g.id || '';
      var opts = (g.models || []).map(function (m) {
        var id = typeof m === 'string' ? m : m.id;
        var label = (typeof m === 'string' ? m : (m.label || m.id)) || id;
        var sel = !found && prov === cur.provider && sameModel(bareModel(id, prov), cur.default);
        if (sel) found = true;
        return '<option value="' + esc(prov + '||' + id) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('');
      if (opts) html += '<optgroup label="' + esc(g.provider || prov) + '">' + opts + '</optgroup>';
    });
    var keep = '<option value="__keep__"' + (found ? '' : ' selected') + '>' + t('Current: {model}', { model: esc(cur.default || '?') }) + (cur.provider ? ' (' + esc(cur.provider) + ')' : '') + '</option>';
    return keep + html;
  }
  function randomSeed() { return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '') || 'bot1'; }
  // ── face editor: shape, mood, eyes, mouth, colour ───────────────────────
  function seedMouth(seed) {  // the mouth a face gets when none was chosen (same draw order as avatarSvg)
    var r = rng(hash(String(seed)));
    for (var i = 0; i < 6; i++) r();
    return r() > 0.5 ? 'smile' : 'mini';
  }
  function curFace(over) {
    var o = { color: modal.color || '', eyes: modal.eyes || '', mouth: modal.mouth || '' };
    if (over) Object.keys(over).forEach(function (k) { o[k] = over[k]; });
    return o;
  }
  function chip(attr, value, label, svg, selected) {
    return '<button type="button" class="bh-face' + (selected ? ' is-selected' : '') + '" ' + attr + '="' + esc(value) + '" title="' + esc(label) + '">' +
      '<span class="bh-avatar is-idle" style="--bh-size:40px">' + svg + '</span><small>' + esc(label) + '</small></button>';
  }
  function faceGridHtml() {
    return FACE_STYLES.map(function (st) {
      return chip('data-bh-face', st, t(FACE_LABELS[st]), avatarSvg(modal.seed, st, curFace()), modal.style === st);
    }).join('');
  }
  function moodRowHtml() {
    var eyes = modal.eyes || 'round', mouth = modal.mouth || seedMouth(modal.seed);
    return MOODS.map(function (m) {
      return chip('data-bh-mood', m[1] + '|' + m[2], t(m[0]), avatarSvg(modal.seed, modal.style, curFace({ eyes: m[1], mouth: m[2] })),
        eyes === m[1] && mouth === m[2]);
    }).join('');
  }
  function eyesRowHtml() {
    var eyes = modal.eyes || 'round';
    return EYES.map(function (e) {
      return chip('data-bh-eyes', e[0], t(e[1]), avatarSvg(modal.seed, modal.style, curFace({ eyes: e[0] })), eyes === e[0]);
    }).join('');
  }
  function mouthRowHtml() {
    var mouth = modal.mouth || seedMouth(modal.seed);
    return MOUTHS.map(function (m) {
      return chip('data-bh-mouth', m[0], t(m[1]), avatarSvg(modal.seed, modal.style, curFace({ mouth: m[0] })), mouth === m[0]);
    }).join('');
  }
  function colorRowHtml() {
    var cur = (modal.color || '').toLowerCase();
    return '<button type="button" class="bh-swatch is-auto' + (cur ? '' : ' is-selected') + '" data-bh-color="auto" title="' + t('Automatic colors (🎲)') + '">Auto</button>' +
      COLORS.map(function (c) {
        return '<button type="button" class="bh-swatch' + (cur === c ? ' is-selected' : '') + '" data-bh-color="' + c + '" style="--sw:' + c + '" title="' + c + '"></button>';
      }).join('');
  }
  // ── installation settings (sidecar GET /config) ────────────────────────
  // Voices exist only when the installation configured a speech command; features say which
  // optional companions (pixel-office, bot-forge, bothub-team) are present.
  var VOICES = [], defaultVoice = '';
  var features = { pixel_office: true, bot_forge: true, team: true };
  var configLoaded = false, engineRegistered = false;
  async function loadConfig() {
    var r = await getJSON(SIDECAR + '/config');
    if (!r.ok || !r.body) return false;
    var c = r.body, voice = c.voice || {};
    langOverride = c.language === 'en' || c.language === 'fr' ? c.language : '';
    VOICES = voice.enabled && Array.isArray(voice.voices) ? voice.voices : [];
    defaultVoice = voice.default || (VOICES[0] && VOICES[0][0]) || '';
    features = Object.assign({}, features, c.features || {});
    configLoaded = true;
    if (VOICES.length && !engineRegistered) {
      try { registerVoiceEngine(); engineRegistered = true; } catch (e) { /* older WebUI without extension TTS engines */ }
    }
    return true;
  }
  async function speakBytes(bot, text, voice) {
    var job = await sidecarJob('/speak', voice ? { bot: bot, text: text, voice: voice } : { bot: bot, text: text },
      { raw: true, timeoutMs: 240000 });
    var res = await fetch(apiUrl(SIDECAR + '/job/audio?id=' + encodeURIComponent(job)), { credentials: 'include' });
    if (!res.ok) throw new Error(t('voice unavailable ({status})', { status: res.status }));
    return new Uint8Array(await res.arrayBuffer());
  }
  function speechChunks(text, max) {
    var parts = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*\s*/g) || [];
    var out = [], cur = '';
    parts.forEach(function (p) {
      while (p.length > max) { out.push(p.slice(0, max)); p = p.slice(max); }
      if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
      cur += p;
    });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  /* WebUI TTS engine: the Listen button and auto-read speak with the voice of the bot
     whose conversation is open. Long replies are synthesized in pieces and joined. */
  function registerVoiceEngine() {
    if (typeof window.registerHermesTtsEngine !== 'function') return;
    window.registerHermesTtsEngine({
      id: 'bothub',
      label: t('Bot voices (Bot Hub)'),
      synthesize: async function (text) {
        var chunks = speechChunks(text, 900).slice(0, 6);
        if (!chunks.length) throw new Error(t('nothing to read'));
        var bot = currentProfile(), parts = [], total = 0;
        for (var i = 0; i < chunks.length; i++) {
          var bytes = await speakBytes(bot, chunks[i]);
          parts.push(bytes); total += bytes.length;
        }
        var all = new Uint8Array(total), off = 0;
        parts.forEach(function (p) { all.set(p, off); off += p.length; });
        return all.buffer;
      },
    });
  }
  var previewAudio = null;
  async function previewVoice() {
    var root = document.getElementById('bhModal');
    var bot = modal && findBot(modal.bot);
    if (!root || !bot) return;
    var voice = root.querySelector('[name=bh-evoice]').value;
    var name = (root.querySelector('[name=bh-ename]') || {}).value || bot.display;
    var btn = root.querySelector('[data-bh-voice-test]');
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="bh-spin"></span>' + t('Listening…'); }
    try {
      var bytes = await speakBytes(bot.name, t('Hello, I am {name}. This is my voice: {voice}.', { name: name, voice: voice }), voice);
      previewAudio = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })));
      await previewAudio.play();
    } catch (e) {
      toast(t('Could not play the voice: {error}', { error: e.message || e }), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '▶ ' + t('Listen'); }
    }
  }
  function voiceOptionsHtml(current) {
    var known = VOICES.some(function (v) { return v[0] === current; });
    return (known || !current ? '' : '<option value="' + esc(current) + '" selected>' + esc(current) + '</option>') +
      VOICES.map(function (v) {
        return '<option value="' + esc(v[0]) + '"' + (v[0] === current ? ' selected' : '') + '>' + esc(v[0]) + (v[1] ? ' — ' + esc(v[1]) : '') + '</option>';
      }).join('');
  }

  function faceEditorHtml() {
    return '<div class="bh-face-editor">' +
      '<div class="bh-face-sub"><span>' + t('Mood') + '</span><div class="bh-face-grid is-6" id="bhMoodRow">' + moodRowHtml() + '</div></div>' +
      '<div class="bh-face-sub"><span>' + t('Shape') + '</span><div class="bh-face-grid" id="bhFaceGrid">' + faceGridHtml() + '</div></div>' +
      '<div class="bh-face-sub"><span>' + t('Eyes') + '</span><div class="bh-face-grid" id="bhEyesRow">' + eyesRowHtml() + '</div></div>' +
      '<div class="bh-face-sub"><span>' + t('Mouth') + '</span><div class="bh-face-grid is-9" id="bhMouthRow">' + mouthRowHtml() + '</div></div>' +
      '<div class="bh-face-sub"><span>' + t('Color') + '</span><div class="bh-swatches"><span id="bhColorRow">' + colorRowHtml() + '</span>' +
        '<label class="bh-swatch is-picker" title="' + t('Pick any color') + '"><input type="color" name="bh-ecolor" value="' + esc(modal.color || '#5f27cd') + '">🎨</label></div></div>' +
      '<button type="button" class="bh-link" data-bh-reroll>🎲 ' + t('Another face (eye spacing, auto colors)') + '</button></div>';
  }
  function refreshFace() {
    var set = function (id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; };
    set('bhMoodRow', moodRowHtml());
    set('bhFaceGrid', faceGridHtml());
    set('bhEyesRow', eyesRowHtml());
    set('bhMouthRow', mouthRowHtml());
    set('bhColorRow', colorRowHtml());
    set('bhEditPreview', '<span class="bh-avatar is-idle" style="--bh-size:36px">' + avatarSvg(modal.seed, modal.style, curFace()) + '</span>');
  }
  function editModalHtml(bot) {
    var isLead = bot.isDefault;
    return '<div class="bh-modal-head"><span class="bh-modal-av" id="bhEditPreview"><span class="bh-avatar is-idle" style="--bh-size:36px">' + avatarSvg(modal.seed, modal.style, curFace()) + '</span></span>' +
      '<h2>' + t('Edit — {name}', { name: esc(bot.display) }) + '</h2><button type="button" class="panel-head-btn" data-bh-close aria-label="' + t('Close') + '">' + ICONS.close + '</button></div>' +
      '<div class="bh-modal-body">' +
      '<details class="bh-face-box" open><summary>' + t('Face and mood') + '</summary>' + faceEditorHtml() + '</details>' +
      '<div class="bh-field-row"><label class="bh-field"><span>' + t('Name') + '</span><input name="bh-ename" type="text" maxlength="40" value="' + esc(bot.display) + '"></label>' +
        '<label class="bh-field"><span>' + t('Role') + '</span><input name="bh-erole" type="text" maxlength="80" placeholder="' + t('E.g. Crypto Watcher') + '" value="' + esc(bot.roleTitle) + '"></label></div>' +
      '<label class="bh-field"><span>' + t('Mission (short description, also used for delegation)') + '</span><textarea name="bh-edesc" rows="2" maxlength="400">' + esc(bot.description) + '</textarea></label>' +
      '<label class="bh-field"><span>' + t('Model') + '</span><select name="bh-emodel" id="bhEditModel"><option value="__keep__">' + t('Loading models…') + '</option></select></label>' +
      (VOICES.length ? '<div class="bh-field-row bh-voice-row"><label class="bh-field"><span>' + t('Voice (spoken replies)') + '</span><select name="bh-evoice">' + voiceOptionsHtml(modal.voice) + '</select></label>' +
        '<button type="button" class="bh-btn" data-bh-voice-test>▶ ' + t('Listen') + '</button></div>' : '') +
      (isLead ? '' : '<label class="bh-check"><input type="checkbox" name="bh-ehidden"' + (bot.hiddenFlag ? ' checked' : '') + '> ' + t('Hide this bot in Bot Hub and in the team') + '</label>') +
      (isLead ? '<p class="bh-hint">' + t('Main profile: the name, role and face change how it is displayed (Bot Hub, Pixel Office); its personality only changes if you edit the SOUL below.') + '</p>'
        : '<label class="bh-check"><input type="checkbox" name="bh-erewrite"> ' + t('Ask {lead} to rewrite its personality (SOUL) for this role', { lead: esc(leadName()) }) + '</label>') +
      '<details class="bh-soul" id="bhSoulBox"><summary data-bh-soul>' + t('Full personality (SOUL.md)') + '</summary>' +
        '<textarea name="bh-esoul" rows="12" spellcheck="false" placeholder="' + t('Loading…') + '" disabled></textarea>' +
        '<p class="bh-hint">' + t('The text the bot reads before each conversation. A backup copy is made on every save.') + '</p></details>' +
      (isLead ? '' :
        '<details class="bh-danger"><summary>' + t('Delete this bot') + '</summary>' +
        '<p class="bh-hint">' + t('Erases the profile “{name}”: conversations, memory, skills, routines. A full archive is created first in <code>~/.hermes/profile-exports/</code> (restorable with <code>hermes profile import</code>).', { name: esc(bot.name) }) + '</p>' +
        '<label class="bh-field"><span>' + t('Type {name} to confirm', { name: '<strong>' + esc(bot.display) + '</strong>' }) + '</span><input name="bh-delconfirm" type="text" autocomplete="off"></label>' +
        '<div class="bh-modal-foot is-inline"><button type="button" class="bh-btn danger" data-bh-delete="' + esc(bot.name) + '" disabled>' + t('Delete permanently') + '</button></div></details>') +
      '</div><div class="bh-modal-foot"><button type="button" class="bh-btn" data-bh-close>' + t('Cancel') + '</button>' +
      '<button type="button" class="bh-btn primary" data-bh-save="' + esc(bot.name) + '">' + t('Save') + '</button></div>';
  }
  function openEdit(botName) {
    var bot = findBot(botName);
    if (!bot) return;
    var av = bot.avatar || {};
    var face = { seed: av.seed || botName, style: av.style || 'organic', color: av.color || '', eyes: av.eyes || '', mouth: av.mouth || '' };
    var currentVoice = (bot.voice && bot.voice.voice) || defaultVoice;
    openModal({ type: 'edit', bot: botName, seed: face.seed, style: face.style, color: face.color, eyes: face.eyes, mouth: face.mouth,
      orig: face, soulOriginal: null, voice: currentVoice });
    loadModels().then(function (groups) {
      var sel = document.getElementById('bhEditModel');
      if (sel && modal && modal.type === 'edit') sel.innerHTML = modelOptionsHtml(bot, groups);
    }).catch(function () {
      var sel = document.getElementById('bhEditModel');
      if (sel) sel.innerHTML = modelOptionsHtml(bot, []);
    });
  }
  async function loadSoul() {
    if (!modal || modal.type !== 'edit' || modal.soulOriginal !== null) return;
    var ta = document.querySelector('#bhModal [name=bh-esoul]');
    try {
      var r = await getJSON(SIDECAR + '/bot/soul?bot=' + encodeURIComponent(modal.bot));
      modal.soulOriginal = (r.ok && r.body && r.body.soul) || '';
      if (ta) { ta.value = modal.soulOriginal; ta.disabled = false; ta.placeholder = ''; }
    } catch (e) {
      if (ta) ta.placeholder = t('Could not read SOUL.md');
    }
  }
  function rewritePrompt(bot, role, desc) {
    return t('Update the bot @{name} with the update_agent tool (bot-forge plugin; find it with tool_search if it is not visible).', { name: bot.name }) + '\n\n' +
      t('Its role: “{role}”.', { role: role || bot.role }) + (desc ? '\n' + t('Its mission: {desc}', { desc: desc }) : '') + '\n\n' +
      t('Rewrite its complete SOUL.md (soul_md parameter) for this role, in English, keeping its name {name}, its “Never” / “Ask first” rules and whatever is still relevant in the way it works. Do not change its model, its tools or its routines. Give me a short report.', { name: bot.display });
  }
  /* The WebUI applies /api/model/set to the profile in this browser's cookie. Point the cookie at the
     bot for that one call and put it back, without touching the page's own state (S.activeProfile).
     Works with or without a WebUI password, since it uses the browser's session. */
  async function setModelAs(bot, id, provider) {
    var prev = currentProfile();
    if (bot !== prev) await postJSON('/api/profile/switch', { name: bot });
    try {
      await postJSON('/api/model/set', { scope: 'main', model: id, provider: provider || 'auto' });
    } finally {
      if (bot !== prev) {
        try { await postJSON('/api/profile/switch', { name: prev }); }
        catch (e) { toast(t('Reload the page: the active profile could not be restored'), 'error'); }
      }
    }
  }
  async function saveBot(botName) {
    var bot = findBot(botName);
    var root = document.getElementById('bhModal');
    if (!bot || !root || busy.save) return;
    var val = function (n) { var el = root.querySelector('[name=' + n + ']'); return el ? el.value : null; };
    var payload = { bot: botName };
    var name = (val('bh-ename') || '').trim(), role = (val('bh-erole') || '').trim(), desc = (val('bh-edesc') || '').trim();
    if (!name) { toast(t('The name cannot be empty'), 'error'); return; }
    if (name !== bot.display) payload.display_name = name;
    if (role !== bot.roleTitle) payload.role = role;
    if (desc !== (bot.description || '')) payload.description = desc;
    var o = modal.orig || {};
    if (['seed', 'style', 'color', 'eyes', 'mouth'].some(function (k) { return (modal[k] || '') !== (o[k] || ''); })) {
      payload.avatar = { seed: modal.seed, style: modal.style, color: modal.color || '', eyes: modal.eyes || '', mouth: modal.mouth || '' };
    }
    var m = val('bh-emodel');
    if (m && m !== '__keep__') {
      var parts = m.split('||'), prov = parts[0], id = parts.slice(1).join('||');
      var cur = bot.modelRaw || {};
      if (!(prov === cur.provider && sameModel(bareModel(id, prov), cur.default))) payload.model = { provider: prov, id: id };
    }
    var soul = val('bh-esoul');
    if (modal.soulOriginal !== null && soul !== null && soul !== modal.soulOriginal) payload.soul = soul;
    var v = val('bh-evoice');
    if (v && v !== modal.voice) payload.voice = v;
    var hiddenBox = root.querySelector('[name=bh-ehidden]');
    if (hiddenBox && hiddenBox.checked !== !!bot.hiddenFlag) payload.hidden = hiddenBox.checked;
    var rewrite = !!(root.querySelector('[name=bh-erewrite]') || {}).checked;
    if (Object.keys(payload).length === 1 && !rewrite) { closeModal(); return; }
    busy.save = true;
    var btn = root.querySelector('[data-bh-save]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="bh-spin"></span>' + t('Saving…'); }
    try {
      var done = [];
      if (payload.model) {  // model first, through the browser's own WebUI session
        await setModelAs(botName, payload.model.id, payload.model.provider);
        delete payload.model;
        done.push(t('model'));
      }
      if (Object.keys(payload).length > 1) {
        var res = await sidecarJob('/bot/update', payload);
        done = done.concat(res.changed || []);
      }
      toast(done.length ? t('Updated: {list}', { list: done.join(', ') }) : t('Nothing to change'), 'success');
      state.profilesAt = 0;
      closeModal();
      if (rewrite) {
        await sendAs(LEAD, rewritePrompt({ name: bot.name, display: name, role: bot.role }, role, desc));
        toast(t('{lead} is rewriting the personality of {name}', { lead: leadName(), name: name }), 'success');
      }
    } catch (e) {
      toast(t('Failed: {error}', { error: e.message || e }), 'error');
      if (btn) { btn.disabled = false; btn.textContent = t('Save'); }
    } finally {
      busy.save = false;
      refresh(true);
    }
  }
  async function deleteBot(botName) {
    var root = document.getElementById('bhModal');
    var bot = findBot(botName);
    if (!root || !bot || busy.del) return;
    var confirmText = (root.querySelector('[name=bh-delconfirm]') || {}).value || '';
    busy.del = true;
    var btn = root.querySelector('[data-bh-delete]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="bh-spin"></span>' + t('Backing up, then deleting…'); }
    try {
      // 1. full archive on the Hermes machine (refused unless the name was typed back), 2. the WebUI's own delete
      var res = await sidecarJob('/bot/archive', { bot: botName, confirm: confirmText });
      try {
        await postJSON('/api/profile/delete', { name: botName });
      } catch (e) {
        throw new Error(t('{error} — nothing was deleted, archive: {file}', { error: e.message || e, file: String(res.backup || '').split('/').pop() }));
      }
      closeModal();
      toast(t('{name} deleted — archive: {file}', { name: bot.display, file: String(res.backup || '').split('/').pop() }), 'success');
      state.profilesAt = 0;
      lastHtml.main = '';
    } catch (e) {
      toast(t('Failed: {error}', { error: e.message || e }), 'error');
      if (btn) { btn.disabled = false; btn.textContent = t('Delete permanently'); }
    } finally {
      busy.del = false;
      refresh(true);
    }
  }
  var faceFrame = 0;
  function onInput(ev) {
    var picker = ev.target.closest && ev.target.closest('#bhModal [name=bh-ecolor]');
    if (picker && modal && modal.type === 'edit') {
      modal.color = picker.value;
      if (!faceFrame) faceFrame = requestAnimationFrame(function () { faceFrame = 0; if (modal && modal.type === 'edit') refreshFace(); });
      return;
    }
    var input = ev.target.closest && ev.target.closest('#bhModal [name=bh-delconfirm]');
    if (!input || !modal || modal.type !== 'edit') return;
    var bot = findBot(modal.bot);
    var btn = document.querySelector('#bhModal [data-bh-delete]');
    var typed = input.value.trim().toLowerCase();
    if (btn && bot) btn.disabled = !(typed && (typed === bot.display.toLowerCase() || typed === bot.name.toLowerCase()));
  }

  function renderModal(full) {
    var root = document.getElementById('bhModal');
    if (!modal) { if (root) root.parentNode.remove(); document.removeEventListener('keydown', onModalKey, true); return; }
    if (!root || full) {
      if (root) root.parentNode.remove();
      var wrap = document.createElement('div');
      wrap.className = 'bh-modal-backdrop';
      wrap.innerHTML = '<div class="bh-modal" id="bhModal" role="dialog" aria-modal="true"></div>';
      document.body.appendChild(wrap);
      root = wrap.firstChild;
      if (modal.type === 'create') root.innerHTML = createModalHtml();
      else if (modal.type === 'edit') {
        var eb = findBot(modal.bot);
        if (!eb) { modal = null; renderModal(); return; }
        root.innerHTML = editModalHtml(eb);
        root.classList.add('is-wide');
      } else {
        var bot = findBot(modal.bot);
        if (!bot) { modal = null; renderModal(); return; }
        root.innerHTML = routinesModalHtml(bot);
      }
      document.addEventListener('keydown', onModalKey, true);
      var first = root.querySelector('textarea, input');
      if (first && modal.type === 'create') setTimeout(function () { first.focus(); }, 30);
      return;
    }
    if (modal.type === 'routines') {
      var b2 = findBot(modal.bot);
      var list = document.getElementById('bhRoutineList');
      if (b2 && list) { var h = routineListHtml(b2); if (list.innerHTML !== h) list.innerHTML = h; }
      var btn = root.querySelector('[data-bh-rcreate]');
      if (btn) { btn.disabled = !!busy.rcreate; btn.innerHTML = (busy.rcreate ? '<span class="bh-spin"></span>' : '') + t('Create the routine'); }
    }
  }
  function openModal(m) { modal = m; renderModal(true); schedule(); }
  function closeModal() { modal = null; renderModal(); schedule(); }
  function onModalKey(ev) {
    if (!modal) return;
    if (ev.key === 'Escape') { ev.stopPropagation(); closeModal(); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && modal.type === 'create') {
      ev.preventDefault();
      var r = document.getElementById('bhModal');
      createBot(r.querySelector('[name=bh-desc]').value, r.querySelector('[name=bh-name]').value);
    }
  }

  var lastHtml = { side: '', main: '', badge: '' };
  function render() {
    relabel();
    var side = document.getElementById('bhSideList');
    var main = document.getElementById('bhMainBody');
    var v = view();
    if (side) {
      var sh = sidebarHtml(v);
      if (sh !== lastHtml.side) { side.innerHTML = sh; lastHtml.side = sh; }
    }
    if (main && isOpen()) {
      var mh = mainHtml(v);
      if (mh !== lastHtml.main) { main.innerHTML = mh; lastHtml.main = mh; }
    }
    var teamBtn = document.querySelector('#mainBothub [data-bh-team]');
    if (teamBtn) teamBtn.disabled = !!busy.team;
    updateBadge(v);
    if (modal) renderModal(false);
  }
  function updateBadge(v) {
    var work = v.all.filter(function (b) { return b.state === 'working'; }).length;
    var att = v.inbox.length || v.all.filter(function (b) { return b.state === 'attention'; }).length;
    var html = att ? '<span class="bh-badge-dot is-attention">' + att + '</span>' : (work ? '<span class="bh-badge-dot is-working">' + work + '</span>' : '');
    if (html === lastHtml.badge) return;
    lastHtml.badge = html;
    document.querySelectorAll('[data-panel="' + PANEL + '"] .bh-badge-slot').forEach(function (el) { el.innerHTML = html; });
  }

  // ── mounting into the WebUI shell ───────────────────────────────────────
  var RAIL_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4"/><circle cx="12" cy="3" r="1"/>' +
    '<circle cx="9" cy="13" r="1.3" fill="currentColor"/><circle cx="15" cy="13" r="1.3" fill="currentColor"/><path d="M2 12v3M22 12v3"/></svg>';

  function makeNavButton(template, rail) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = template ? template.className.replace(/\bactive\b/, '').trim() : (rail ? 'rail-btn nav-tab has-tooltip' : 'nav-tab has-tooltip');
    btn.dataset.panel = PANEL;
    btn.dataset.tooltip = 'Bots';
    if (!rail) btn.dataset.label = 'Bots';
    btn.setAttribute('aria-label', 'Bots');
    btn.innerHTML = RAIL_ICON + '<span class="bh-badge-slot"></span>';
    btn.addEventListener('click', function () {
      if (typeof switchPanel === 'function') switchPanel(PANEL, { fromRailClick: true });
    });
    return btn;
  }

  // Panel headers: built at mount, rebuilt by relabel() when the language changes (WebUI switch,
  // or config.json's "language" arriving after mount).
  var headLang = '';
  function sideHeadHtml() {
    return '<span>Bots</span><div class="panel-head-actions">' +
      '<button class="panel-head-btn" type="button" data-bh-open-create aria-label="' + t('New bot') + '" title="' + t('New bot') + '">' + ICONS.plus + '</button>' +
      '<button class="panel-head-btn" type="button" data-bh-refresh aria-label="' + t('Refresh') + '" title="' + t('Refresh') + '">' + ICONS.refresh + '</button></div>';
  }
  function mainHeadHtml() {
    return '<div class="main-view-title">' + t('Your bots') + '</div><div class="main-view-actions bh-head-actions">' +
      '<button class="bh-btn" type="button" data-bh-team title="' + t('Opens the thread where {lead} delegates to the bots', { lead: esc(t('the team lead')) }) + '">' + ICONS.team + '<span>' + t('Team thread') + '</span></button>' +
      '<button class="bh-btn primary" type="button" data-bh-open-create>' + ICONS.plus + '<span>' + t('New bot') + '</span></button>' +
      '<button class="panel-head-btn" type="button" data-bh-refresh aria-label="' + t('Refresh') + '" title="' + t('Refresh') + '">' + ICONS.refresh + '</button></div>';
  }
  function relabel() {
    if (headLang === lang()) return;
    headLang = lang();
    var side = document.querySelector('#panelBothub > .panel-head');
    if (side) side.innerHTML = sideHeadHtml();
    var main = document.querySelector('#mainBothub > .main-view-header');
    if (main) main.innerHTML = mainHeadHtml();
  }

  function mount() {
    var rail = document.querySelector('nav.rail');
    var mainEl = document.querySelector('main.main');
    var profilesPanel = document.getElementById('panelProfiles');
    if (!rail || !mainEl || !profilesPanel) return false;

    try { if (typeof MAIN_VIEW_PANELS !== 'undefined' && MAIN_VIEW_PANELS.indexOf(PANEL) < 0) MAIN_VIEW_PANELS.push(PANEL); } catch (e) { /* older WebUI */ }
    try {
      if (typeof APP_TITLEBAR_KEYS !== 'undefined') APP_TITLEBAR_KEYS[PANEL] = 'tab_bothub';
      if (typeof LOCALES !== 'undefined') Object.keys(LOCALES).forEach(function (k) { if (LOCALES[k] && !LOCALES[k].tab_bothub) LOCALES[k].tab_bothub = 'Bots'; });
    } catch (e) { /* titlebar falls back to the panel id */ }

    if (!rail.querySelector('[data-panel="' + PANEL + '"]')) {
      var tpl = rail.querySelector('[data-panel="profiles"]');
      var b = makeNavButton(tpl, true);
      if (tpl) rail.insertBefore(b, tpl); else rail.appendChild(b);
    }
    var mnav = document.querySelector('.sidebar-nav');
    if (mnav && !mnav.querySelector('[data-panel="' + PANEL + '"]')) {
      var mtpl = mnav.querySelector('[data-panel="profiles"]');
      var mb = makeNavButton(mtpl, false);
      if (mtpl) mnav.insertBefore(mb, mtpl); else mnav.appendChild(mb);
    }

    if (!document.getElementById('panelBothub')) {
      var panel = document.createElement('div');
      panel.className = 'panel-view';
      panel.id = 'panelBothub';
      panel.innerHTML = '<div class="panel-head">' + sideHeadHtml() + '</div><div class="bh-side" id="bhSideList"></div>';
      profilesPanel.parentNode.insertBefore(panel, profilesPanel);
    }
    if (!document.getElementById('mainBothub')) {
      var viewEl = document.createElement('div');
      viewEl.className = 'main-view';
      viewEl.id = 'mainBothub';
      viewEl.innerHTML = '<div class="main-view-header">' + mainHeadHtml() + '</div><div class="main-view-body bh-main" id="bhMainBody"></div>';
      mainEl.appendChild(viewEl);
    }
    headLang = lang();

    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('input', onInput, true);
    new MutationObserver(function () {
      if (isOpen()) { lastHtml.main = ''; render(); refresh().then(schedule); }
      else schedule();
    }).observe(mainEl, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh().then(schedule); else clearTimeout(timer);
    });
    return true;
  }

  function onChange(ev) {
    var sel = ev.target.closest && ev.target.closest('#bhModal [name=bh-when]');
    if (!sel) return;
    document.querySelectorAll('#bhModal [data-bh-when-for]').forEach(function (el) {
      el.hidden = el.getAttribute('data-bh-when-for').split(' ').indexOf(sel.value) < 0;
    });
  }

  function onClick(ev) {
    var backdrop = ev.target.classList && ev.target.classList.contains('bh-modal-backdrop');
    if (backdrop) { ev.preventDefault(); closeModal(); return; }
    // <summary> must keep its native toggle: just start loading the persona.
    if (ev.target.closest && ev.target.closest('[data-bh-soul]')) { loadSoul(); return; }
    var el = ev.target.closest && ev.target.closest('[data-bh-talk],[data-bh-new],[data-bh-consent],[data-bh-refresh],[data-bh-toggle-hidden],' +
      '[data-bh-open-create],[data-bh-create],[data-bh-suggest],[data-bh-close],[data-bh-team],[data-bh-goto-inbox],[data-bh-answer],' +
      '[data-bh-open-sid],[data-bh-routines],[data-bh-raction],[data-bh-rcreate],' +
      '[data-bh-edit],[data-bh-face],[data-bh-reroll],[data-bh-save],[data-bh-delete],' +
      '[data-bh-mood],[data-bh-eyes],[data-bh-mouth],[data-bh-color],[data-bh-voice-test]');
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    var a = function (n) { return el.getAttribute(n); };
    if (el.hasAttribute('data-bh-talk')) { var b1 = findBot(a('data-bh-talk')); if (b1) talkTo(b1, false); }
    else if (el.hasAttribute('data-bh-new')) { var b2 = findBot(a('data-bh-new')); if (b2) talkTo(b2, true); }
    else if (el.hasAttribute('data-bh-consent')) grantConsent();
    else if (el.hasAttribute('data-bh-refresh')) refresh(true);
    else if (el.hasAttribute('data-bh-toggle-hidden')) { state.showHidden = !state.showHidden; store.set('showHidden', state.showHidden); render(); }
    else if (el.hasAttribute('data-bh-open-create')) openModal({ type: 'create' });
    else if (el.hasAttribute('data-bh-close')) closeModal();
    else if (el.hasAttribute('data-bh-suggest')) { var ta = document.querySelector('#bhModal [name=bh-desc]'); if (ta) { ta.value = a('data-bh-suggest'); ta.focus(); } }
    else if (el.hasAttribute('data-bh-create')) {
      var r = document.getElementById('bhModal');
      createBot(r.querySelector('[name=bh-desc]').value, r.querySelector('[name=bh-name]').value);
    }
    else if (el.hasAttribute('data-bh-team')) openTeamThread();
    else if (el.hasAttribute('data-bh-goto-inbox')) {
      var go = function () { var box = document.getElementById('bhInbox'); if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      if (!isOpen() && typeof switchPanel === 'function') switchPanel(PANEL).then(function () { setTimeout(go, 150); }); else go();
    }
    else if (el.hasAttribute('data-bh-answer')) {
      var item = buildInbox(buildBots()).find(function (i) { return i.key === a('data-bh-key'); });
      if (item) answer(item, a('data-bh-answer'));
    }
    else if (el.hasAttribute('data-bh-open-sid')) {
      var prof = a('data-bh-profile') || LEAD;
      openSession(prof, { session_id: a('data-bh-open-sid'), profile: prof }).catch(function () { toast(t('Could not open this thread'), 'error'); });
    }
    else if (el.hasAttribute('data-bh-routines')) openModal({ type: 'routines', bot: a('data-bh-routines') });
    else if (el.hasAttribute('data-bh-raction')) routineAction(a('data-bh-store'), a('data-bh-id'), a('data-bh-raction'));
    else if (el.hasAttribute('data-bh-rcreate')) routineCreate(a('data-bh-rcreate'));
    else if (el.hasAttribute('data-bh-edit')) openEdit(a('data-bh-edit'));
    else if (el.matches('[data-bh-face],[data-bh-reroll],[data-bh-mood],[data-bh-eyes],[data-bh-mouth],[data-bh-color]')) {
      if (!modal || modal.type !== 'edit') return;
      if (el.hasAttribute('data-bh-face')) modal.style = a('data-bh-face');
      else if (el.hasAttribute('data-bh-reroll')) modal.seed = randomSeed();
      else if (el.hasAttribute('data-bh-mood')) { var mm = a('data-bh-mood').split('|'); modal.eyes = mm[0]; modal.mouth = mm[1]; }
      else if (el.hasAttribute('data-bh-eyes')) modal.eyes = a('data-bh-eyes');
      else if (el.hasAttribute('data-bh-mouth')) modal.mouth = a('data-bh-mouth');
      else if (el.hasAttribute('data-bh-color')) {
        modal.color = a('data-bh-color') === 'auto' ? '' : a('data-bh-color');
        var picker = document.querySelector('#bhModal [name=bh-ecolor]');
        if (picker && modal.color) picker.value = modal.color;
      }
      refreshFace();
    }
    else if (el.hasAttribute('data-bh-save')) saveBot(a('data-bh-save'));
    else if (el.hasAttribute('data-bh-voice-test')) previewVoice();
    else if (el.hasAttribute('data-bh-delete')) deleteBot(a('data-bh-delete'));
  }

  // ── French translations (key: the English text used in the code) ─────────
  var FR = {
    // relative times, schedules
    'just now': "à l'instant",
    '{n} min ago': 'il y a {n} min',
    '{n} h ago': 'il y a {n} h',
    'yesterday': 'hier',
    '{n} days ago': 'il y a {n} j',
    '{n} month ago': 'il y a {n} mois',
    '{n} months ago': 'il y a {n} mois',
    'today {time}': "aujourd'hui {time}",
    'tomorrow {time}': 'demain {time}',
    'every day at {time}': 'tous les jours à {time}',
    'weekdays at {time}': 'en semaine à {time}',
    'every {day} at {time}': 'chaque {day} à {time}',
    'every {n} min': 'toutes les {n} min',
    'every hour': 'toutes les heures',
    'every {n} h': 'toutes les {n} h',
    'every {n} day': 'toutes les {n} j',
    'every {n} days': 'toutes les {n} j',
    'Sunday': 'dimanche',
    'Monday': 'lundi',
    'Tuesday': 'mardi',
    'Wednesday': 'mercredi',
    'Thursday': 'jeudi',
    'Friday': 'vendredi',
    'Saturday': 'samedi',
    // background jobs, errors
    'could not track the job ({status})': 'suivi de la tâche impossible ({status})',
    'failed': 'échec',
    'still running after {n} min': 'toujours en cours après {n} min',
    'could not switch profile': 'profil',
    'Could not read the conversations ({status})': 'Impossible de lire les conversations ({status})',
    'WebUI unreachable': 'WebUI injoignable',
    'Failed: {error}': 'Échec : {error}',
    // current tool
    'running a command': 'exécute une commande',
    'searching the web': 'cherche sur le web',
    'browsing a website': 'navigue sur un site',
    'reading files': 'lit des fichiers',
    'writing files': 'écrit des fichiers',
    'delegating to a sub-agent': 'délègue à un sous-agent',
    'consulting another bot': 'consulte un autre bot',
    'creating a new bot': 'crée un nouveau bot',
    'checking its memory': 'consulte sa mémoire',
    'sending a message': 'envoie un message',
    'scheduling a routine': 'planifie une routine',
    'working on an image': 'travaille sur une image',
    'using a skill': 'utilise une compétence',
    'using a connector': 'utilise un connecteur',
    'using {tool}': 'utilise {tool}',
    // face shapes, eyes, mouths, moods
    'Organic': 'Organique',
    'Circle': 'Rond',
    'Square': 'Carré',
    'Capsule': 'Capsule',
    'Antennae': 'Antennes',
    'Cloud': 'Nuage',
    'Drop': 'Goutte',
    'Hexagon': 'Hexagone',
    'Sun': 'Soleil',
    'Triangle': 'Triangle',
    'Round': 'Ronds',
    'Happy': 'Joyeux',
    'Closed': 'Fermés',
    'Wink': "Clin d'œil",
    'Dots': 'Points',
    'Wide': 'Grands',
    'Frowning': 'Fâchés',
    'Downcast': 'Tristes',
    'Stars': 'Étoiles',
    'Hearts': 'Cœurs',
    'Smile': 'Sourire',
    'Grin': 'Grand sourire',
    'Small': 'Petite',
    'Neutral': 'Neutre',
    'Astonished': 'Étonnée',
    'Sad': 'Triste',
    'Tongue': 'Langue',
    'Smirk': 'En coin',
    'Cat :3': 'Chat :3',
    'Content': 'Content',
    'Calm': 'Calme',
    'Focused': 'Concentré',
    'Surprised': 'Surpris',
    'Amazed': 'Émerveillé',
    'In love': 'Amoureux',
    'Playful': 'Espiègle',
    'Sly': 'Malin',
    'Cute': 'Mignon',
    'Angry': 'Fâché',
    // bot status
    'Has a question for you': 'Te pose une question',
    'Waiting for your approval': 'Attend ton approbation',
    'in “{title}”': 'sur « {title} »',
    'Working': 'Au travail',
    'thinking': 'réfléchit',
    'routine running': 'routine en cours',
    '+{n} sub-agent': '+{n} sous-agent',
    '+{n} sub-agents': '+{n} sous-agents',
    'Available': 'Disponible',
    'active {when}': 'actif {when}',
    'Ready': 'Prêt',
    'not used yet': 'jamais sollicité',
    'Main agent · team lead': "Agent principal · chef d'équipe",
    // new bot in one sentence (prompt sent to the lead)
    'Create a new Hermes bot for me with the create_agent tool (bot-forge plugin; find it with tool_search if it is not visible).':
      'Crée-moi un nouveau bot Hermes avec l\'outil create_agent (plugin bot-forge ; trouve-le avec tool_search s\'il n\'est pas visible).',
    'Mission: {desc}': 'Mission : {desc}',
    'Preferred name: {name}': 'Nom souhaité : {name}',
    'Rules: do not ask me any questions, design it yourself (original name, role, SOUL.md in English, tools; routines only if the mission is recurring). First check with list_agents that no bot already does this job. When it is done, give me a short report: name, role, routines, and what I need to set up next.':
      'Règles : ne me pose aucune question, conçois-le toi-même (nom original, rôle, SOUL.md en français, outils ; ' +
      'des routines seulement si la mission est récurrente). Vérifie d\'abord avec list_agents qu\'aucun bot ne fait déjà ce travail. ' +
      'Quand c\'est fait, fais-moi un compte rendu court : nom, rôle, routines, et ce que je dois configurer ensuite.',
    'Describe the bot\'s mission in one sentence': 'Décris la mission du bot en une phrase',
    '{lead} is creating your bot — follow the progress here': "{lead} crée ton bot — suis l'avancement ici",
    'Could not start the creation: {error}': 'Impossible de lancer la création : {error}',
    'Could not open the conversation with {name}': "Impossible d'ouvrir la conversation de {name}",
    // team thread (title, kickoff prompt sent to the lead)
    '👥 Team': '👥 Équipe',
    '- @{name} ({display}): {role}': '- @{name} ({display}) : {role}',
    'This thread is our team thread. You are {lead}, the team lead.': 'Ce fil est notre fil d\'équipe. Tu es {lead}, chef d\'équipe.',
    'the main bot': 'le bot principal',
    'Your team today:': 'Ton équipe aujourd\'hui :',
    'When I give you a task here: break it down, delegate each part to the right bot with the ask_agent tool (bot-forge plugin; tool_search if needed), then give me a summary saying who did what. If I write @name, pass it straight to that bot. Use list_agents to know the current team, and do not do a specialist\'s work yourself.':
      'Quand je te confie une tâche ici : découpe-la, délègue chaque partie au bon bot avec l\'outil ask_agent ' +
      '(plugin bot-forge ; tool_search si besoin), puis fais-moi une synthèse qui dit qui a fait quoi. ' +
      'Si j\'écris @nom, transmets directement à ce bot. Utilise list_agents pour connaître l\'équipe à jour, ' +
      'et ne fais pas toi-même le travail d\'un spécialiste.',
    'To confirm, reply only “Team ready” followed by the list of members.': 'Pour confirmer, réponds seulement « Équipe prête » suivi de la liste des membres.',
    'Could not open the team thread: {error}': "Impossible d'ouvrir le fil d'équipe : {error}",
    'Could not open this thread': "Impossible d'ouvrir ce fil",
    // approvals, routines, consent
    'Denied': 'Refusé',
    'Allowed once': 'Autorisé une fois',
    'Routine started (on the scheduler\'s next pass)': 'Routine lancée (prochain passage du planificateur)',
    'Routine paused': 'Routine en pause',
    'Routine resumed': 'Routine reprise',
    'Write what the bot should do on each run': 'Écris ce que le bot doit faire à chaque passage',
    'Routine created': 'Routine créée',
    'Bot details enabled': 'Détails des bots activés',
    'Activation refused — see Settings → Extensions': 'Activation refusée — voir Paramètres → Extensions',
    // sidebar, summary
    'Team thread: {lead} delegates to the other bots': "Fil d'équipe : {lead} délègue aux autres bots",
    'Team thread': "Fil d'équipe",
    '{lead} delegates to the bots': '{lead} délègue aux bots',
    'To approve': 'À valider',
    '{n} pending request': '{n} demande en attente',
    '{n} pending requests': '{n} demandes en attente',
    'Chat with {name}': 'Discuter avec {name}',
    'lead': 'chef',
    'New bot…': 'Nouveau bot…',
    'No bots yet.': "Aucun bot pour l'instant.",
    '{n} to approve': '{n} à valider',
    '{n} working': '{n} au travail',
    '{n} bot available': '{n} disponible',
    '{n} bots available': '{n} disponibles',
    'running': 'actif',
    'stopped': 'arrêté',
    // inbox
    '{name} has a question for you': '{name} te pose une question',
    'Pending question': 'Question en attente',
    '{name} asks for your approval': '{name} demande ton accord',
    'in the WebUI': 'dans la WebUI',
    'expiring': 'expire',
    'Allow once': 'Autoriser une fois',
    'Deny': 'Refuser',
    'Reply in the thread': 'Répondre dans le fil',
    'Open the thread': 'Ouvrir le fil',
    'Reply on {platform}': 'Réponds sur {platform}',
    'the original platform': "la plateforme d'origine",
    // bot cards
    'Model': 'Modèle',
    '{n} routine': '{n} routine',
    '{n} routines': '{n} routines',
    'next {when}': 'prochaine {when}',
    '{n} paused': '{n} en pause',
    'View and manage routines': 'Voir et gérer les routines',
    'Voice for spoken replies ({provider})': 'Voix des réponses vocales ({provider})',
    'Active profile in this tab': 'Profil actif dans cet onglet',
    'open here': 'ouvert ici',
    'Last thread:': 'Dernier fil :',
    'Untitled': 'Sans titre',
    '{n} thread': '{n} fil',
    '{n} threads': '{n} fils',
    'No conversations yet.': 'Aucune conversation encore.',
    'Edit {name} (name, role, face, model…)': 'Modifier {name} (nom, rôle, visage, modèle…)',
    'Edit {name}': 'Modifier {name}',
    'team lead': "chef d'équipe",
    'Profile “{name}”': 'Profil « {name} »',
    'Reply': 'Répondre',
    'Chat': 'Discuter',
    'New thread': 'Nouveau fil',
    'New bot': 'Nouveau bot',
    '{lead} is preparing it…': '{lead} le prépare…',
    'name, role, tools, routines — 1 to 3 min': 'nom, rôle, outils, routines — 1 à 3 min',
    'Follow the creation': 'Suivre la création',
    'Describe its mission in one sentence, {lead} takes care of the rest.': "Décris sa mission en une phrase, {lead} s'occupe du reste.",
    // banners, main view
    'Enable bot details': 'Active les détails des bots',
    'Role, avatar, routines, approvals and current tool come from the Bot Hub service, on the Hermes machine. Allow the WebUI to contact it (local).':
      'Rôle, avatar, routines, approbations et outil en cours viennent du service Bot Hub, sur la machine de Hermes. Autorise la WebUI à le contacter (local).',
    'Enable': 'Activer',
    'Bot Hub service unreachable — limited view (no role, routines or approvals). On the Hermes machine: {cmd}':
      'Service Bot Hub injoignable — affichage limité (pas de rôle, routines ni approbations). Sur la machine de Hermes : {cmd}',
    'updated {time}': 'mis à jour {time}',
    'loading…': 'chargement…',
    'Loading your team…': 'Chargement de ton équipe…',
    'Hide {n} hidden bot': 'Masquer {n} bot masqué',
    'Hide {n} hidden bots': 'Masquer {n} bots masqués',
    'Show {n} hidden bot': 'Afficher {n} bot masqué',
    'Show {n} hidden bots': 'Afficher {n} bots masqués',
    'Your team of Hermes agents. Write to them as you would to a colleague: they work on their own and come back to you when they need your approval.':
      'Ton équipe d\'agents Hermes. Écris-leur comme à un collègue : ils travaillent seuls et reviennent vers toi quand il faut ton accord.',
    'Your bots': 'Tes bots',
    'Opens the thread where {lead} delegates to the bots': 'Ouvre le fil où {lead} délègue aux bots',
    'the team lead': "le chef d'équipe",
    'Refresh': 'Actualiser',
    // create modal
    'Sort my emails every morning at 8am and summarize the urgent ones': 'Trie mes emails chaque matin à 8h et résume-moi les urgents',
    'Watch Fed and ECB announcements and alert me': 'Surveille les annonces de la Fed et de la BCE et alerte-moi',
    'Keep an eye on AI news and send a digest every Friday': 'Fais une veille IA et un digest chaque vendredi',
    'Check the server\'s health (disk, RAM, services) every day': 'Surveille la santé du serveur (disque, RAM, services) chaque jour',
    'Close': 'Fermer',
    'What should this bot do?': 'Que doit faire ce bot ?',
    'E.g. watch crypto news and send me a summary every evening at 7pm': 'Ex. : surveille les news crypto et envoie-moi un résumé chaque soir à 19h',
    'Name (optional)': 'Nom (facultatif)',
    'Leave empty, {lead} will find one': 'Laisse vide, {lead} en trouvera un',
    '{lead} designs the bot with bot-forge (role, SOUL, tools, routines) and tests it. You follow the creation in a thread; it shows up here when it is ready.':
      '{lead} conçoit le bot avec bot-forge (rôle, SOUL, outils, routines) et le teste. Tu suis la création dans un fil ; il apparaît ici quand il est prêt.',
    'One-sentence creation uses the <strong>bot-forge</strong> plugin, which is not enabled on the main profile: <code>hermes plugins enable bot-forge</code>. You can also create a profile with <code>hermes profile create &lt;name&gt;</code>.':
      'La création en une phrase utilise le plugin <strong>bot-forge</strong>, qui n\'est pas activé sur le profil principal : <code>hermes plugins enable bot-forge</code>. Tu peux aussi créer un profil avec <code>hermes profile create &lt;nom&gt;</code>.',
    'Cancel': 'Annuler',
    'Create the bot': 'Créer le bot',
    // routines modal
    'No routines. A routine makes {name} work on its own, at a set time.': 'Aucune routine. Une routine fait travailler {name} tout seul, à heure fixe.',
    'Paused': 'En pause',
    'Error': 'Erreur',
    'Active': 'Active',
    'last {when}': 'dernière {when}',
    'Run now': 'Lancer maintenant',
    'Resume': 'Reprendre',
    'Pause': 'Pause',
    '{name}\'s thread': 'Fil de {name}',
    'Nowhere (log only)': 'Nulle part (journal seulement)',
    'Routines — {name}': 'Routines — {name}',
    'New routine': 'Nouvelle routine',
    'Name': 'Nom',
    'E.g. Evening summary': 'Ex. : Résumé du soir',
    'When': 'Quand',
    'Every day': 'Chaque jour',
    'Weekdays': 'En semaine',
    'Every Monday': 'Chaque lundi',
    'Every hour': 'Toutes les heures',
    'Every N hours': 'Toutes les N heures',
    'Cron expression': 'Expression cron',
    'At': 'À',
    'N hours': 'N heures',
    'What {name} should do on each run': 'Ce que {name} doit faire à chaque passage',
    'Standalone instruction: the bot receives it on its own, without the context of your conversations.':
      'Instruction autonome : le bot la reçoit seule, sans le contexte de vos conversations.',
    'Send the result to': 'Envoyer le résultat',
    'Create the routine': 'Créer la routine',
    // edit modal: face, voice, persona, delete
    'Current: {model}': 'Actuel : {model}',
    'Automatic colors (🎲)': 'Couleurs automatiques (🎲)',
    'voice unavailable ({status})': 'voix indisponible ({status})',
    'Bot voices (Bot Hub)': 'Voix des bots (Bot Hub)',
    'nothing to read': 'rien à lire',
    'Listening…': 'Écoute…',
    'Hello, I am {name}. This is my voice: {voice}.': 'Bonjour, je suis {name}. Voici ma voix : {voice}.',
    'Could not play the voice: {error}': 'Écoute impossible : {error}',
    'Listen': 'Écouter',
    'Mood': 'Humeur',
    'Shape': 'Forme',
    'Eyes': 'Yeux',
    'Mouth': 'Bouche',
    'Color': 'Couleur',
    'Pick any color': "Choisir n'importe quelle couleur",
    'Another face (eye spacing, auto colors)': 'Autre visage (espacement des yeux, couleurs auto)',
    'Edit — {name}': 'Modifier — {name}',
    'Face and mood': 'Visage et humeur',
    'Role': 'Rôle',
    'E.g. Crypto Watcher': 'Ex. : Veilleur Crypto',
    'Mission (short description, also used for delegation)': 'Mission (description courte, sert aussi à la délégation)',
    'Loading models…': 'Chargement des modèles…',
    'Voice (spoken replies)': 'Voix (réponses vocales)',
    'Hide this bot in Bot Hub and in the team': "Masquer ce bot dans Bot Hub et dans l'équipe",
    'Main profile: the name, role and face change how it is displayed (Bot Hub, Pixel Office); its personality only changes if you edit the SOUL below.':
      'Profil principal : le nom, le rôle et le visage changent l\'affichage (Bot Hub, Pixel Office) ; sa personnalité ne change que si tu modifies le SOUL ci-dessous.',
    'Ask {lead} to rewrite its personality (SOUL) for this role': 'Demander à {lead} de réécrire sa personnalité (SOUL) pour ce rôle',
    'Full personality (SOUL.md)': 'Personnalité complète (SOUL.md)',
    'Loading…': 'Chargement…',
    'The text the bot reads before each conversation. A backup copy is made on every save.':
      'Le texte que le bot lit avant chaque conversation. Une copie de sauvegarde est faite à chaque enregistrement.',
    'Delete this bot': 'Supprimer ce bot',
    'Erases the profile “{name}”: conversations, memory, skills, routines. A full archive is created first in <code>~/.hermes/profile-exports/</code> (restorable with <code>hermes profile import</code>).':
      'Efface le profil « {name} » : conversations, mémoire, compétences, routines. Une archive complète est d\'abord créée dans <code>~/.hermes/profile-exports/</code> (restaurable avec <code>hermes profile import</code>).',
    'Type {name} to confirm': 'Tape {name} pour confirmer',
    'Delete permanently': 'Supprimer définitivement',
    'Save': 'Enregistrer',
    'Could not read SOUL.md': 'Impossible de lire SOUL.md',
    // rewrite the SOUL (prompt sent to the lead)
    'Update the bot @{name} with the update_agent tool (bot-forge plugin; find it with tool_search if it is not visible).':
      'Mets à jour le bot @{name} avec l\'outil update_agent (plugin bot-forge ; trouve-le avec tool_search s\'il n\'est pas visible).',
    'Its role: “{role}”.': 'Son rôle : « {role} ».',
    'Its mission: {desc}': 'Sa mission : {desc}',
    'Rewrite its complete SOUL.md (soul_md parameter) for this role, in English, keeping its name {name}, its “Never” / “Ask first” rules and whatever is still relevant in the way it works. Do not change its model, its tools or its routines. Give me a short report.':
      'Réécris son SOUL.md complet (paramètre soul_md) pour ce rôle, en français, en gardant son nom {name}' +
      ', ses règles « Never » / « Ask first » et ce qui reste pertinent de sa façon de travailler. ' +
      'Ne change ni son modèle, ni ses outils, ni ses routines. Fais-moi un compte rendu court.',
    // save, delete
    'Reload the page: the active profile could not be restored': 'Recharge la page : le profil actif n\'a pas pu être rétabli',
    'The name cannot be empty': 'Le nom ne peut pas être vide',
    'Saving…': 'Enregistrement…',
    'model': 'modèle',
    'Updated: {list}': 'Modifié : {list}',
    'Nothing to change': 'Rien à changer',
    '{lead} is rewriting the personality of {name}': '{lead} réécrit la personnalité de {name}',
    'Backing up, then deleting…': 'Sauvegarde puis suppression…',
    '{error} — nothing was deleted, archive: {file}': '{error} — rien n\'a été supprimé, archive : {file}',
    '{name} deleted — archive: {file}': '{name} supprimé — archive : {file}',
  };

  function boot(tries) {
    if (mount()) { refresh(true).then(schedule); return; }
    if (tries > 80) return;
    setTimeout(function () { boot(tries + 1); }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { boot(0); });
  else boot(0);
})();
