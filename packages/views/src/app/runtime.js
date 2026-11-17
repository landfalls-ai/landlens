// The runtime of a block Claude wrote (wave 10, D204): the MCP Apps handshake (2026-01-26, JSON-RPC over postMessage
// to the host that framed us) without an SDK, and the one object Claude's script gets, `view`. Data comes in only from
// the host: the tool result's structuredContent at first, then `ui/notifications/landlens-data`, a Landlens extension
// (the protocol has no host-to-view update after the first result). The frame has no network (connect-src 'none'),
// no bridge and no preload; this file adds nothing to that: it is a convenience, not a wall.
(function () {
  "use strict";
  var host = window.parent;
  var nextId = 1;
  var pending = new Map();
  var context = {};
  var store = Object.create(null);
  var listeners = Object.create(null);
  var infoListeners = [];

  function post(message) {
    host.postMessage(message, "*");
  }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
    });
  }
  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }
  function safely(fn, arg) {
    try {
      fn(arg);
    } catch (err) {
      notify("notifications/message", { level: "error", data: String((err && err.message) || err).slice(0, 500) });
    }
  }

  // Escape and the app's ⌘/Ctrl chords go to the host, as in Landlens's own views; nothing else typed here leaves.
  window.addEventListener("keydown", function (e) {
    var chord = (e.metaKey || e.ctrlKey) && /^[a-z0-9]$/i.test(e.key);
    if (e.key !== "Escape" && !chord) return;
    notify("ui/notifications/landlens-key", { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
  });

  function setData(source, data) {
    if (typeof source !== "string" || !data || typeof data !== "object") return;
    store[source] = data;
    var fns = listeners[source] || [];
    for (var i = 0; i < fns.length; i++) safely(fns[i], data);
  }

  window.addEventListener("message", function (e) {
    if (e.source !== host) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined) {
      var p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error((m.error && m.error.message) || "failed"));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined) {
      if (m.method === "ui/resource-teardown" || m.method === "ping") post({ jsonrpc: "2.0", id: m.id, result: {} });
      else post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    var params = m.params || {};
    if (m.method === "ui/notifications/host-context-changed") applyContext(params);
    else if (m.method === "ui/notifications/tool-input") {
      var a = params.arguments || {};
      if (a.params && typeof a.params === "object") view.params = Object.freeze(Object.assign({}, a.params));
    } else if (m.method === "ui/notifications/tool-result") {
      var sc = params.structuredContent || {};
      if (sc.view && typeof sc.view === "object") {
        view.info = Object.freeze({ id: String(sc.view.id || ""), title: String(sc.view.title || ""), version: Number(sc.view.version) || 0, blocks: Number(sc.view.blocks) || 0 });
        for (var j = 0; j < infoListeners.length; j++) safely(infoListeners[j], view.info);
      }
      var data = sc.data || {};
      for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) setData(k, data[k]);
    } else if (m.method === "ui/notifications/landlens-data") setData(params.source, params.data);
  });

  var SAFE_VALUE = /^[^;{}<>\\]*$/;
  function applyContext(c) {
    for (var k in c) context[k] = c[k];
    var root = document.documentElement;
    if (c.theme === "light" || c.theme === "dark") {
      root.setAttribute("data-theme", c.theme);
      root.style.colorScheme = c.theme;
    }
    var vars = c.styles && c.styles.variables;
    if (vars && typeof vars === "object") {
      for (var name in vars) {
        var v = vars[name];
        if (/^--[a-z0-9-]+$/.test(name) && typeof v === "string" && SAFE_VALUE.test(v)) root.style.setProperty(name, v);
      }
    }
    // A block that fills the page gets the page's height (a fixed height, in the protocol's containerDimensions).
    var fixed = c.containerDimensions && c.containerDimensions.height;
    root.classList.toggle("fill", typeof fixed === "number");
  }

  var lastSize = "";
  function reportSize() {
    var el = document.getElementById("app");
    if (!el) return;
    if (document.documentElement.classList.contains("fill")) return;
    var r = el.getBoundingClientRect();
    var key = Math.ceil(r.width) + "x" + Math.ceil(r.height);
    if (key === lastSize) return;
    lastSize = key;
    notify("ui/notifications/size-changed", { width: Math.ceil(r.width), height: Math.ceil(r.height) });
  }

  // What `view.el` makes: never a tag that runs or loads a document (script, a frame, an object, a link, a meta or a
  // base), never an event handler (on…) or `srcdoc`, and an address only to https:, mailto:, landlens: or a #fragment.
  // The address is read as the URL parser reads it, with every tab, newline and control character taken out first, so
  // "java\tscript:" and "\x01javascript:" are what they are (security review of wave 10 part 2, L1). The sandbox and the
  // CSP are the wall; this keeps Claude's own markup from doing what the page didn't mean.
  var REFUSED_TAG = /^(script|iframe|frame|frameset|object|embed|link|meta|base|portal)$/i;
  var URL_ATTR = /^(href|src|action|formaction|xlink:href|poster|data|background|ping|cite|srcset|codebase|manifest)$/i;
  var GOOD_URL = /^(https:|mailto:|landlens:|#)/i;
  function goodUrl(v) {
    return GOOD_URL.test(String(v).replace(/[\x00-\x20\x7f]/g, ""));
  }
  function el(tag, attrs) {
    var name = String(tag);
    if (REFUSED_TAG.test(name.replace(/[\x00-\x20]/g, ""))) throw new Error("view.el doesn't make <" + name.slice(0, 20) + ">");
    var node = document.createElement(name);
    if (attrs && typeof attrs === "object") {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (typeof v !== "string" && typeof v !== "number" && v !== true) continue;
        if (/^on/i.test(k) || /^srcdoc$/i.test(k)) continue;
        if (k === "class") node.className = String(v);
        else if (k === "text") node.textContent = String(v);
        else if (URL_ATTR.test(k) && !goodUrl(v)) continue;
        else node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) append(node, c[i]);
      return;
    }
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function refUrl(kind, ref) {
    if (!ref || typeof ref !== "object") return "";
    return "landlens://" + kind + "/" + encodeURIComponent(String(ref.kind || "")) + "/" + encodeURIComponent(String(ref.namespace || "_")) + "/" + encodeURIComponent(String(ref.name || ""));
  }
  function age(ms) {
    var s = Math.max(0, Math.floor(Number(ms) / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function bytes(n) {
    var v = Number(n);
    if (!isFinite(v)) return "";
    var units = ["B", "KiB", "MiB", "GiB", "TiB"];
    var i = 0;
    while (Math.abs(v) >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (i ? v.toFixed(v < 10 ? 1 : 0) : String(v)) + " " + units[i];
  }
  function cpu(cores) {
    var v = Number(cores);
    if (!isFinite(v)) return "";
    return v < 1 ? Math.round(v * 1000) + "m" : (Math.round(v * 100) / 100).toString();
  }

  var view = {
    /** The view this block is in: id, title, version (from the host). */
    info: Object.freeze({ id: "", title: "", version: 0, blocks: 0 }),
    params: Object.freeze({}),
    onInfo: function (fn) {
      if (typeof fn !== "function") return;
      infoListeners.push(fn);
      if (view.info.id) safely(fn, view.info);
    },
    /** The latest data of a source, then every change (whole replacement, at most once a second). */
    onData: function (source, fn) {
      if (typeof fn !== "function") return;
      (listeners[source] = listeners[source] || []).push(fn);
      if (store[source]) safely(fn, store[source]);
    },
    data: function (source) {
      return store[source];
    },
    /** Pull a source now (view_data, the one tool a block may call). */
    read: function (source) {
      return request("tools/call", { name: "view_data", arguments: { source: String(source) } }).then(function (r) {
        if (r && r.structuredContent) setData(String(source), r.structuredContent);
        return r && r.structuredContent;
      });
    },
    el: el,
    openObject: function (ref) {
      return request("ui/open-link", { url: refUrl("object", ref) });
    },
    action: function (verb, ref) {
      return request("ui/open-link", { url: "landlens://action/" + encodeURIComponent(String(verb)) + refUrl("", ref).slice("landlens://".length) });
    },
    ask: function (ref) {
      return request("ui/open-link", { url: refUrl("ask", ref) });
    },
    /** Open the object's logs in Landlens's panel (a pod, or a workload whose pods log). */
    logs: function (ref) {
      return request("ui/open-link", { url: refUrl("logs", ref) });
    },
    /** Choose rows of one kind (at most 50): Landlens shows them in its selection bar; the person acts. */
    select: function (refs) {
      var list = Array.isArray(refs) ? refs.filter(function (r) { return r && typeof r === "object"; }).slice(0, 50) : [];
      if (!list.length) return Promise.resolve({ isError: true });
      var url = "landlens://select/" + encodeURIComponent(String(list[0].kind || ""));
      for (var i = 0; i < list.length; i++) url += "/" + encodeURIComponent(String(list[i].namespace || "_")) + "/" + encodeURIComponent(String(list[i].name || ""));
      return request("ui/open-link", { url: url });
    },
    openLink: function (url) {
      return request("ui/open-link", { url: String(url) });
    },
    format: { age: age, bytes: bytes, cpu: cpu },
  };
  Object.freeze(view.format);
  window.view = view;

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "landlens-view-block", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
  }).then(function (r) {
    applyContext((r && r.hostContext) || {});
    notify("ui/notifications/initialized", {});
    var app = document.getElementById("app");
    if (app) new ResizeObserver(reportSize).observe(app);
    reportSize();
  });
})();
