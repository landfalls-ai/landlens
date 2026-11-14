// cluster_overview → a health card: the verdict, nodes, pods, deployments and restarts, and the problems worst first.
(function () {
  "use strict";
  var v = window.landlensView;
  var h = v.h;
  var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); };

  function render(data) {
    var hl = data.health;
    var app = document.getElementById("app");
    app.textContent = "";
    var bad = hl.problems.filter(function (p) { return p.tone === "bad"; }).length;
    var warn = hl.problems.length - bad;
    var tone = bad ? "bad" : warn ? "warn" : "ok";
    var verdict = bad ? plural(bad, "problem needs attention", "problems need attention") : warn ? "Nothing is broken; " + plural(warn, "thing", "things") + " to watch" : "All clear";
    var scope = data.namespace ? "namespace " + data.namespace : data.context;
    app.appendChild(h("div", { class: "verdict" },
      h("span", { class: "tile " + tone }, v.icon(tone, 16)),
      h("div", { class: "head-text" },
        h("div", { class: "title", text: verdict }),
        h("div", { class: "eyebrow", text: "Health of " + scope })),
    ));

    var p = hl.pods;
    var stats = [
      hl.nodes ? ["Nodes", hl.nodes.ready, "/" + hl.nodes.total] : null,
      ["Pods", p.total, ""],
      hl.deployments ? ["Deployments", hl.deployments.available, "/" + hl.deployments.total] : null,
      ["Restarts", p.restarts, ""],
    ].filter(Boolean);
    app.appendChild(h("div", { class: "stats" }, stats.map(function (s) {
      return h("div", { class: "stat" }, h("div", { class: "stat-label", text: s[0] }), h("div", { class: "stat-num" }, String(s[1]), s[2] ? h("span", { text: s[2] }) : null));
    })));
    if (p.total) {
      var seg = function (n, cls) { return n ? h("i", { class: cls, style: "flex:" + n }) : null; };
      app.appendChild(h("div", { class: "bar", role: "img", "aria-label": p.running + " running, " + p.pending + " pending, " + p.failing + " failing" },
        seg(p.running + p.succeeded, "ok"), seg(p.pending, "warn"), seg(p.failing, "bad")));
      app.appendChild(h("div", { class: "meta" },
        h("span", null, v.icon("ok", 12, "t-ok"), " ", h("b", { text: String(p.running) }), " running"),
        h("span", null, v.icon("warn", 12, "t-warn"), " ", h("b", { text: String(p.pending) }), " pending"),
        h("span", null, v.icon("bad", 12, "t-bad"), " ", h("b", { text: String(p.failing) }), " failing")));
    }

    if (hl.problems.length) {
      app.appendChild(h("div", { class: "section", text: "Problems, worst first" }));
      var shown = hl.problems.slice(0, 6);
      app.appendChild(h("ul", { class: "rows box" }, shown.map(function (x) {
        var where = (x.namespace ? x.namespace + "/" : "") + x.name;
        // The name leads (a narrow dock would otherwise show only "namespace/…"); the namespace goes with the detail.
        var detail = x.detail.replace(/; back-off .*$/, "");
        return h("li", null, h("button", {
          class: "row",
          title: "Open " + x.kind + " " + where + " in Landlens",
          "aria-label": x.kind + " " + where + ": " + x.reason + ". Open in Landlens",
          onclick: function () { v.openObject(x.kind, x.namespace, x.name).catch(function () {}); },
        },
          h("div", { class: "row-main" },
            h("div", { class: "row-name" }, h("span", { class: "kind", text: x.kind }), h("span", { text: x.name, title: where })),
            h("div", { class: "row-detail", text: x.namespace ? x.namespace + " · " + detail : detail })),
          v.pill(x.tone, x.reason),
          v.icon("open", 13, "dim")));
      })));
      if (hl.problems.length > shown.length) app.appendChild(h("div", { class: "sub", text: "and " + plural(hl.problems.length - shown.length, "more") }));
    }
    if (hl.warnings.length) app.appendChild(h("div", { class: "sub" }, v.icon("alert", 12, "t-warn"), " ", plural(hl.warnings.length, "warning event") + " in the last hour"));
  }

  v.start({ name: "landlens-health", result: render });
})();
