// get_logs → a log view: numbered lines, the ones that look like the failure highlighted, and a switch to show only
// those (with a line of context each side).
(function () {
  "use strict";
  var v = window.landlensView;
  var h = v.h;
  var only = false;
  var data;

  function render(d) {
    data = d;
    var app = document.getElementById("app");
    app.textContent = "";
    var hits = new Set(d.hits || []);
    app.appendChild(h("div", { class: "head" },
      h("span", { class: "tile " + (hits.size || d.unreadable ? "bad" : "") }, v.icon("logs", 16)),
      h("div", { class: "head-text" },
        h("div", { class: "eyebrow", text: "Logs / " + d.namespace + (d.container ? " · " + d.container : "") + (d.previous ? " · the run before the last restart" : "") }),
        h("div", { class: "title", text: d.pod }))));
    if (d.unreadable) {
      // The kubelet answered with why it couldn't read the log, not a log: say so, in the bad tone.
      app.appendChild(h("div", { class: "unread", role: "status" }, v.icon("bad", 14),
        h("div", null, h("b", { text: "Logs couldn't be read" }), h("span", { class: "mono", text: d.unreadable }))));
      return;
    }
    if (!d.lines.length) {
      app.appendChild(h("div", { class: "empty" }, v.icon("muted", 14, "dim"), h("span", { text: "The log is empty." })));
      return;
    }
    var count = " · " + d.lines.length + (d.lines.length === 1 ? " line" : " lines");
    var bar = h("div", { class: "head" },
      h("div", { class: "sub", style: "flex:1" }, hits.size
        ? [v.icon("bad", 12, "t-bad"), " ", String(hits.size), hits.size === 1 ? " line looks like the failure" : " lines look like the failure", h("span", { class: "dim", text: count })]
        : [v.icon("ok", 12, "t-ok"), " Nothing looks like a failure", h("span", { class: "dim", text: count })]));
    if (hits.size) {
      bar.appendChild(h("div", { class: "seg", role: "group", "aria-label": "Lines" },
        h("button", { "aria-pressed": String(!only), onclick: function () { only = false; render(data); }, text: "All" }),
        h("button", { "aria-pressed": String(only), onclick: function () { only = true; render(data); }, text: "Failures" })));
    }
    app.appendChild(bar);
    var keep = function (i) { return !only || hits.has(i) || hits.has(i - 1) || hits.has(i + 1); };
    var well = h("pre", { class: "well" });
    var prev = -1;
    d.lines.forEach(function (line, i) {
      if (!keep(i)) return;
      if (only && prev >= 0 && i > prev + 1) well.appendChild(h("span", { class: "ln dim", "data-n": "", text: "…" }));
      prev = i;
      well.appendChild(h("span", { class: "ln" + (hits.has(i) ? " hit" : ""), "data-n": String(i + 1), text: line + "\n" }));
    });
    app.appendChild(well);
    var first = well.querySelector(".hit");
    if (first && !only) well.scrollTop = Math.max(0, first.offsetTop - 40);
  }

  v.start({ name: "landlens-logs", result: render });
})();
