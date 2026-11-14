// The MCP Apps view runtime Landlens's own views share: the 2026-01-26 protocol (JSON-RPC 2.0 over postMessage to the
// host that framed us) without an SDK, and a few DOM helpers. Data is only ever set as text, never parsed as HTML.
(function () {
  "use strict";
  var host = window.parent;
  var nextId = 1;
  var pending = new Map();
  var handlers = {};
  var context = {};

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
      // A request from the host: teardown and ping are answered; nothing else is offered.
      if (m.method === "ui/resource-teardown" || m.method === "ping") post({ jsonrpc: "2.0", id: m.id, result: {} });
      else post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (m.method === "ui/notifications/host-context-changed") applyContext(m.params || {});
    var h = handlers[m.method];
    if (h) h(m.params || {});
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
  }

  var lastSize = "";
  function reportSize() {
    var el = document.getElementById("app");
    if (!el) return;
    var r = el.getBoundingClientRect();
    var w = Math.ceil(r.width);
    var h = Math.ceil(r.height);
    var key = w + "x" + h;
    if (key === lastSize) return;
    lastSize = key;
    notify("ui/notifications/size-changed", { width: w, height: h });
  }

  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) append(el, c[i]);
      return;
    }
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  /** h("div", { class: "x", text: "y", onclick: f }, children…) */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = String(v);
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  var NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) el.setAttribute(k, String(attrs[k]));
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }

  // Lucide's shapes (ISC), the same as the app's: state is a shape and a word, never colour alone.
  var ICONS = {
    ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    bad: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    warn: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    muted: '<path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0"/><path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7"/><path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8"/><path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69"/><path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0"/><path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7"/><path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8"/><path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69"/>',
    pod: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    workload: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    node: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
    other: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    open: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    logs: '<path d="M15 12H3"/><path d="M17 18H3"/><path d="M21 6H3"/>',
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };
  function icon(name, size, cls) {
    var span = document.createElement("span");
    span.className = "ic" + (cls ? " " + cls : "");
    span.setAttribute("aria-hidden", "true");
    var s = size || 14;
    // Constant markup from ICONS above; no data ever goes through here.
    span.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.other) + "</svg>";
    return span;
  }
  function kindIcon(kind) {
    if (kind === "Pod") return "pod";
    if (kind === "Node") return "node";
    if (/^(Deployment|StatefulSet|DaemonSet|ReplicaSet|Job|CronJob)$/.test(kind)) return "workload";
    return "other";
  }
  function pill(tone, text) {
    return h("span", { class: "pill " + (tone || "muted") }, icon(tone === "ok" || tone === "bad" || tone === "warn" ? tone : "muted", 12), text);
  }
  function fail(message) {
    var app = document.getElementById("app");
    app.textContent = "";
    app.appendChild(h("div", { class: "empty" }, icon("alert", 16, "t-warn"), h("span", { text: message })));
  }

  window.landlensView = {
    h: h,
    svg: svg,
    icon: icon,
    kindIcon: kindIcon,
    pill: pill,
    fail: fail,
    context: function () {
      return context;
    },
    callTool: function (name, args) {
      return request("tools/call", { name: name, arguments: args || {} });
    },
    openLink: function (url) {
      return request("ui/open-link", { url: url });
    },
    /** "Open in Landlens": a landlens: link, which the Landlens host handles itself (it never reaches a browser). */
    openObject: function (kind, namespace, name) {
      var url = "landlens://object/" + encodeURIComponent(kind) + "/" + encodeURIComponent(namespace || "_") + "/" + encodeURIComponent(name);
      return request("ui/open-link", { url: url });
    },
    start: function (opts) {
      handlers["ui/notifications/tool-input"] = function (p) {
        if (opts.input) opts.input(p.arguments || {});
      };
      handlers["ui/notifications/tool-result"] = function (r) {
        try {
          if (r && r.isError) return fail(textOf(r) || "The tool failed.");
          if (!r || !r.structuredContent) return fail("This result has nothing to draw; Claude has it as text.");
          opts.result(r.structuredContent, r);
        } catch (err) {
          fail("Couldn't draw this result: " + (err && err.message));
        }
      };
      handlers["ui/notifications/tool-cancelled"] = function () {
        fail("The tool call was cancelled.");
      };
      return request("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: opts.name, version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["inline"] },
      }).then(function (r) {
        applyContext((r && r.hostContext) || {});
        notify("ui/notifications/initialized", {});
        new ResizeObserver(reportSize).observe(document.getElementById("app"));
        reportSize();
      });
    },
  };
  function textOf(r) {
    return (r.content || []).filter(function (c) { return c && c.type === "text"; }).map(function (c) { return c.text; }).join("\n");
  }
})();
