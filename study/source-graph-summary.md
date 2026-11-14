# Source graph summary

Counts from Craft Anything `app_source_import` (`scripts/study-source-graph.sh`). The graphs themselves are git-ignored.

| Graph | Files | Languages | Truncated |
|---|---|---|---|
| acp-typescript-sdk | 119 | typescript 86, json 17, markdown 6, other 5 | False |
| claude-agent-acp | 392 | typescript 244, other 132, markdown 7, javascript 5 | False |
| freelens-packages-core | 4005 | typescript 2932, typescript-jsx 709, stylesheet 256, other 103 | False |
| freelens-packages-kube-object | 101 | typescript 99, json 2 | False |
| openlens-packages-core | 3058 | typescript 2090, typescript-jsx 604, stylesheet 248, other 108 | False |
| openlens-packages-kube-object | 95 | typescript 90, javascript 2, json 2, markdown 1 | False |
| openlens-packages-technical-features | 166 | typescript 99, javascript 22, json 22, markdown 16 | False |

## OpenLens core vs Freelens core, by area (src/<process>/<area>)

| Area | OpenLens files | Freelens files |
|---|---|---|
| `src/renderer/components` | 1377 | 1742 |
| `src/features/preferences` | 124 | 176 |
| `src/common/front-end-routing` | 109 | 189 |
| `src/features/cluster` | 77 | 114 |
| `src/common/k8s-api` | 62 | 72 |
| `src/common/utils` | 56 | 63 |
| `src/features/application-menu` | 43 | 71 |
| `src/main/start-main-application` | 45 | 58 |
| `src/main/helm` | 46 | 53 |
| `src/features/helm-charts` | 41 | 49 |
| `src/main/electron-app` | 44 | 43 |
| `src/common/vars` | 37 | 40 |
| `src/features/extensions` | 18 | 59 |
| `src/features/application-update` | 74 | 0 |
| `src/main/cluster` | 29 | 38 |
| `src/common/fs` | 31 | 35 |
| `src/features/hotbar` | 33 | 32 |
| `src/main/routes` | 24 | 37 |
| `src/main/tray` | 22 | 26 |
| `src/features/terminal` | 21 | 25 |
| `src/features/user-preferences` | 21 | 24 |
| `src/renderer/api` | 18 | 27 |
| `src/renderer/frames` | 19 | 23 |
| `src/common/app-paths` | 17 | 24 |
| `src/main/shell-session` | 14 | 25 |
| `src/renderer/routes` | 18 | 19 |
| `src/features/weblinks` | 18 | 18 |
| `src/main/utils` | 15 | 20 |
| `src/common/path` | 17 | 18 |
| `src/extensions/extension-loader` | 16 | 19 |
| `src/renderer/utils` | 15 | 20 |
| `src/features/population-of-logs-to-a-file` | 16 | 18 |
| `src/extensions/__tests__` | 4 | 28 |
| `src/renderer/port-forward` | 14 | 17 |
| `src/renderer/before-frame-starts` | 14 | 17 |
| `src/main/freelens-proxy` | 0 | 30 |
| `src/features/persistent-storage` | 12 | 16 |
| `src/renderer/themes` | 13 | 14 |
| `src/features/shell-sync` | 11 | 16 |
| `src/common/catalog` | 12 | 14 |

Files in both: 2764; only OpenLens: 294; only Freelens: 1241.
