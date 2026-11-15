// metrics → CPU and memory over the range as two line charts: a line per container, pod or node (past four the rest
// fold into "other"), request dashed and limit or allocatable solid, each labelled where it ends; a legend with the
// latest values, and a readout that follows the pointer. Colour is identity, never state.
(function () {
  "use strict";
  var v = window.landlensView;
  var h = v.h;
  var s = v.svg;
  var data;
  var hoverT = null;

  var cores = function (x) { return x < 1 ? Math.round(x * 1000) + "m" : (Math.round(x * 100) / 100).toString(); };
  var bytes = function (x) { return x >= Math.pow(2, 30) ? (x / Math.pow(2, 30)).toFixed(1) + " GiB" : Math.round(x / Math.pow(2, 20)) + " MiB"; };
  var clock = function (t) { var d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

  /** At most four series; the rest summed as "other". */
  function fold(series) {
    var mean = function (l) { var t = 0; l.points.forEach(function (p) { t += p[1]; }); return l.points.length ? t / l.points.length : 0; };
    var sorted = series.slice().sort(function (a, b) { return mean(b) - mean(a); });
    if (sorted.length <= 4) return sorted;
    var keep = sorted.slice(0, 3);
    var rest = sorted.slice(3);
    var sums = new Map();
    rest.forEach(function (l) { l.points.forEach(function (p) { sums.set(p[0], (sums.get(p[0]) || 0) + p[1]); }); });
    var pts = Array.from(sums.entries()).sort(function (a, b) { return a[0] - b[0]; });
    return keep.concat([{ key: "other (" + rest.length + ")", points: pts, other: true }]);
  }
  function at(line, t) {
    var best = null;
    line.points.forEach(function (p) { if (best === null || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; });
    return best;
  }

  function chart(title, panel, fmt, width) {
    var lines = fold(panel.series);
    var W = Math.max(220, width), H = 118, L = 44, R = 10, T = 8, B = 18;
    var from = data.series.from, to = data.series.to;
    var max = 0;
    lines.forEach(function (l) { l.points.forEach(function (p) { if (p[1] > max) max = p[1]; }); });
    [panel.request, panel.limit, panel.allocatable].forEach(function (r) { if (typeof r === "number" && r > max) max = r; });
    max = max > 0 ? max * 1.1 : 1;
    var x = function (t) { return L + ((t - from) / Math.max(1, to - from)) * (W - L - R); };
    var y = function (val) { return T + (1 - val / max) * (H - T - B); };
    var root = s("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title + " over " + data.range });
    for (var i = 0; i <= 2; i++) {
      var val = (max / 1.1) * (i / 2);
      root.appendChild(s("line", { x1: L, x2: W - R, y1: y(val), y2: y(val), stroke: "var(--viz-grid)", "shape-rendering": "crispEdges" }));
      var label = s("text", { x: L - 6, y: y(val) + 3.5, "text-anchor": "end", fill: "var(--color-text-tertiary)", "font-size": "10.5" });
      label.textContent = fmt(val);
      root.appendChild(label);
    }
    [[from, "start"], [to, "end"]].forEach(function (pair) {
      var t = s("text", { x: pair[1] === "start" ? L : W - R, y: H - 4, "text-anchor": pair[1], fill: "var(--color-text-tertiary)", "font-size": "10.5" });
      t.textContent = clock(pair[0]);
      root.appendChild(t);
    });
    var refs = [["request", panel.request, "4 3"], ["limit", panel.limit, null], ["allocatable", panel.allocatable, null]];
    refs.forEach(function (r) {
      if (typeof r[1] !== "number") return;
      root.appendChild(s("line", { x1: L, x2: W - R, y1: y(r[1]), y2: y(r[1]), stroke: "var(--color-text-secondary)", "stroke-dasharray": r[2] || undefined }));
      var t = s("text", { x: W - R, y: y(r[1]) - 4, "text-anchor": "end", fill: "var(--color-text-secondary)", "font-size": "10.5", "paint-order": "stroke", stroke: "var(--color-background-primary)", "stroke-width": "3" });
      t.textContent = r[0] + " " + fmt(r[1]);
      root.appendChild(t);
    });
    lines.forEach(function (l, i) {
      if (!l.points.length) return;
      var d = l.points.map(function (p, j) { return (j ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1); }).join(" ");
      root.appendChild(s("path", { d: d, fill: "none", stroke: l.other ? "var(--viz-other)" : "var(--viz-" + (i + 1) + ")", "stroke-width": "2", "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });
    if (hoverT !== null) {
      root.appendChild(s("line", { x1: x(hoverT), x2: x(hoverT), y1: T, y2: H - B, stroke: "var(--color-text-tertiary)", "shape-rendering": "crispEdges" }));
      lines.forEach(function (l, i) {
        var p = at(l, hoverT);
        if (p) root.appendChild(s("circle", { cx: x(p[0]), cy: y(p[1]), r: 3.5, fill: l.other ? "var(--viz-other)" : "var(--viz-" + (i + 1) + ")", stroke: "var(--color-background-primary)", "stroke-width": "2" }));
      });
    }
    var plot = h("div", { class: "plot" });
    plot.appendChild(root);
    plot.addEventListener("pointermove", function (e) {
      var r = root.getBoundingClientRect();
      var t = from + ((e.clientX - r.left - L) / (W - L - R)) * (to - from);
      hoverT = Math.min(to, Math.max(from, t));
      render(data);
    });
    plot.addEventListener("pointerleave", function () { hoverT = null; render(data); });

    var head = h("div", { class: "head" },
      h("b", { text: title }),
      h("span", { class: "dim", style: "flex:1", text: hoverT !== null ? "at " + clock(hoverT) : "latest" }));
    var legend = h("div", { class: "meta" }, lines.map(function (l, i) {
      var p = hoverT !== null ? at(l, hoverT) : l.points[l.points.length - 1];
      return h("span", null,
        h("i", { style: "display:inline-block;width:10px;height:2px;border-radius:1px;vertical-align:middle;margin-right:5px;background:" + (l.other ? "var(--viz-other)" : "var(--viz-" + (i + 1) + ")") }),
        h("b", { text: p ? fmt(p[1]) : "–" }), " ", l.key);
    }));
    return h("div", { class: "box", style: "padding:8px 10px;display:grid;gap:6px" }, head, plot, lines.length ? legend : h("div", { class: "sub", text: "No samples in this range." }));
  }

  function render(d) {
    data = d;
    var app = document.getElementById("app");
    var width = Math.max(220, (app.getBoundingClientRect().width || 360) - 24 - 20);
    app.textContent = "";
    var what = d.scope === "cluster" ? d.context : d.scope === "namespace" ? "namespace " + d.namespace : (d.namespace ? d.namespace + "/" : "") + d.name;
    var src = d.series.source === "clickland" ? "Clickland" : d.series.source === "prometheus" ? "Prometheus" : d.series.source === "metrics-server" ? "metrics-server, live" : "no source";
    app.appendChild(h("div", { class: "head" },
      h("span", { class: "tile" }, v.icon("chart", 16)),
      h("div", { class: "head-text" },
        h("div", { class: "eyebrow", text: (d.scope === "cluster" || d.scope === "namespace" ? "" : d.scope[0].toUpperCase() + d.scope.slice(1) + " · ") + "CPU and memory · " + d.range + " · " + src }),
        h("div", { class: "title", text: what }))));
    if (d.series.source === "none") {
      app.appendChild(h("div", { class: "empty" }, v.icon("alert", 14, "t-warn"), h("span", { text: d.series.reasons.map(function (r) { return r.message; }).join(" ") })));
      return;
    }
    app.appendChild(chart("CPU", d.series.cpu, cores, width));
    app.appendChild(chart("Memory", d.series.memory, bytes, width));
  }

  window.addEventListener("resize", function () { if (data) render(data); });
  v.start({ name: "landlens-metrics", result: render });
})();
