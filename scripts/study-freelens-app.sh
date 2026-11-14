#!/usr/bin/env bash
# Static Craft Anything study of the released Freelens app (the maintained OpenLens build): Electron fuses, the asar
# inventory by kind, and the app graph (windows, IPC, routes, native modules, vendors). Nothing is run.
# Writes compact parts to study/freelens-app/; the raw session (6+ MB) stays in study/downloads/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VER=${FREELENS_VERSION:-2.0.0}
CLI=$(ls -d tools/craft-anything/craft-anything-cli-*/craft-anything-cli | tail -1)
D=study/downloads/freelens
mkdir -p "$D" study/freelens-app
dmg="Freelens-$VER-macos-arm64.dmg"
[ -f "$D/$dmg" ] || gh release download "v$VER" -R freelensapp/freelens -p "$dmg" -p "$dmg.sha256" -D "$D"
(cd "$D" && shasum -a 256 -c "$dmg.sha256")
[ -d "$D/mnt/Freelens.app" ] || hdiutil attach -readonly -nobrowse -mountpoint "$D/mnt" "$D/$dmg" >/dev/null
APP=$ROOT/$D/mnt/Freelens.app
ASAR=$APP/Contents/Resources/app.asar
steps=$(mktemp)
python3 -I - "$steps" "$APP" "$ASAR" <<'PY'
import json, sys
path, app, asar = sys.argv[1:]
mapid = None
steps = [{"tool": "enable_toolset", "args": {"toolset": "javascript"}},
         {"tool": "js_electron_fuses_show", "args": {"path": app}},
         {"tool": "core_archive_show", "args": {"path": asar, "limit": 1, "max_depth": 0}},
         {"tool": "js_app_map", "args": {"input_path": asar, "limit": 1, "max_nodes": 60000,
                                          "source_paths": [asar + ".unpacked"]}}]
for part in ["windows", "ipc", "routes", "native_modules", "bundlers", "effects", "endpoints", "vendors", "modules"]:
    steps.append({"tool": "core_evidence_browse",
                  "args": {"source": {"kind": "saved", "evidence_id": "$MAP"},
                           "show": {"kind": "rows", "list": part, "limit": 1000}}})
json.dump(steps, open(path, "w"))
PY
# First pass finds the app map's evidence id; the second browses its lists.
python3 -I tools/craft-anything/mcp_session.py "$CLI" "$steps" --deep > "$D/session.jsonl"
MAP=$(python3 -I -c '
import json, sys
for l in open(sys.argv[1]):
    r = json.loads(l)
    if r["tool"] == "js_app_map":
        t = "".join(c.get("text", "") for c in r["reply"]["result"]["content"])
        j = json.loads(t); print((j.get("record") or j).get("evidence_id") or j.get("id"))' "$D/session.jsonl")
sed -i '' "s/\\\$MAP/$MAP/g" "$steps"
python3 -I tools/craft-anything/mcp_session.py "$CLI" "$steps" --deep > "$D/session.jsonl"
rm -f "$steps"
python3 -I - "$D/session.jsonl" study/freelens-app "$ROOT" "$HOME" <<'PY'
import json, sys
src, out, root, home = sys.argv[1:]
browse = ["windows", "ipc", "routes", "native_modules", "bundlers", "effects", "endpoints", "vendors", "modules"]
i = 0
for line in open(src):
    r = json.loads(line)
    rep = r["reply"]
    text = "".join(c.get("text", "") for c in rep.get("result", {}).get("content", [])) if "result" in rep else json.dumps(rep)
    text = text.replace(root + "/", "./").replace(root, ".").replace(home, "~")
    j = json.loads(text) if text.startswith("{") else {"raw": text}
    if r["tool"] == "core_archive_show":
        res = j.get("result", {})
        j = {k: j.get(k) for k in ("id", "operation", "subject", "coverage")} | {"by_kind": res.get("by_kind"), "containers": res.get("containers")}
        name = "asar-inventory"
    elif r["tool"] == "core_evidence_browse":
        name = "app-map-" + browse[i]; i += 1
    elif r["tool"] == "enable_toolset":
        continue
    else:
        name = {"js_electron_fuses_show": "electron-fuses", "js_app_map": "app-map-summary"}[r["tool"]]
    json.dump(j, open(f"{out}/{name}.json", "w"), indent=1)
    print(name, len(json.dumps(j)))
PY
