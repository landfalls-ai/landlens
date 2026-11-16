// The card under a render_view or patch_view call in the dock (D205): Landlens's own, never the view itself. The title
// is Claude's (a checked text of the document), and Open view moves to the Views page through a landlens: link.
(function () {
  "use strict";
  var app = document.getElementById("app");
  view.onInfo(function (info) {
    app.textContent = "";
    app.appendChild(
      view.el("div", { class: "card" },
        view.el("div", { class: "grow" },
          view.el("div", { class: "t", text: info.title || "View" }),
          view.el("div", { class: "dim", text: "Version " + info.version + " · " + info.blocks + (info.blocks === 1 ? " block" : " blocks") })),
        view.el("button", { type: "button", id: "open" }, "Open view")));
    document.getElementById("open").addEventListener("click", function () {
      view.openLink("landlens://view/" + info.id);
    });
  });
})();
