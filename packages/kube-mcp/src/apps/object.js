// describe → an object card: what it is, its state, its containers and their last exits, its owners and recent
// events, and "Open in Landlens", which takes the main view to it.
(function () {
  "use strict";
  var v = window.landlensView;
  var h = v.h;

  function render(o) {
    var app = document.getElementById("app");
    app.textContent = "";
    var tone = o.status ? o.status.tone : "muted";
    app.appendChild(h("div", { class: "head" },
      h("span", { class: "tile " + (tone === "bad" || tone === "warn" ? tone : "") }, v.icon(v.kindIcon(o.kind), 16)),
      h("div", { class: "head-text" },
        h("div", { class: "eyebrow", text: o.kind + (o.namespace ? " / " + o.namespace : "") }),
        h("div", { class: "title", text: o.name }))));

    var meta = h("div", { class: "meta" });
    if (o.status) meta.appendChild(v.pill(o.status.tone, o.status.text));
    if (o.ready) meta.appendChild(h("span", null, h("b", { class: "mono", text: o.ready }), " ready"));
    if (o.restarts !== undefined) meta.appendChild(h("span", null, h("b", { class: "mono", text: String(o.restarts) }), " restarts"));
    meta.appendChild(h("span", null, h("b", { class: "mono", text: o.age }), " old"));
    if (o.node) meta.appendChild(h("span", null, "on ", h("b", { class: "mono", text: o.node })));
    app.appendChild(meta);

    if (o.containers && o.containers.length) {
      app.appendChild(h("div", { class: "section", text: "Containers" }));
      app.appendChild(h("ul", { class: "rows box" }, o.containers.map(function (c) {
        var running = c.state === "running" && c.ready;
        var ctone = running ? "ok" : c.state === "waiting" && /BackOff|Err|Error|Invalid/.test(c.reason || "") ? "bad" : c.state === "terminated" ? (c.reason === "Completed" ? "muted" : "bad") : "warn";
        var last = c.lastExit ? "last exit " + (c.lastExit.reason || "?") + ", code " + c.lastExit.code + (c.lastExit.message ? ": " + c.lastExit.message : "") : null;
        return h("li", { class: "row" },
          h("div", { class: "row-main" },
            h("div", { class: "row-name" }, h("span", { text: c.name }), h("span", { class: "dim mono", text: c.image })),
            h("div", { class: "row-detail", text: [c.restarts + " restarts", last].filter(Boolean).join(" · ") })),
          v.pill(ctone, c.reason || (running ? "Running" : c.state)));
      })));
    }

    var failing = (o.conditions || []).filter(function (c) { return !c.ok; });
    if (o.owners && o.owners.length) app.appendChild(h("div", { class: "sub" }, h("span", { class: "dim", text: "Owners " }), h("span", { class: "mono", text: o.owners.join(" → ") })));
    if (failing.length) app.appendChild(h("div", { class: "sub" }, h("span", { class: "dim", text: "Not true " }), failing.map(function (c) { return c.type + (c.reason ? " (" + c.reason + ")" : ""); }).join(", ")));

    if (o.events && o.events.length) {
      app.appendChild(h("div", { class: "section", text: "Recent events" }));
      app.appendChild(h("ul", { class: "rows box" }, o.events.slice(0, 4).map(function (e) {
        return h("li", { class: "row" },
          v.icon(e.type === "Warning" ? "alert" : "ok", 13, e.type === "Warning" ? "t-warn" : "dim"),
          h("div", { class: "row-main" },
            h("div", { class: "row-name" }, h("span", { text: e.reason }), h("span", { class: "dim mono", text: "×" + e.count + " · " + e.age })),
            h("div", { class: "row-detail", text: e.message, title: e.message })));
      })));
    }

    app.appendChild(h("div", { class: "actions" },
      h("button", {
        class: "btn primary",
        onclick: function () { v.openObject(o.kind, o.namespace, o.name).catch(function () {}); },
      }, v.icon("open", 13), "Open in Landlens")));
  }

  v.start({ name: "landlens-object", result: render });
})();
