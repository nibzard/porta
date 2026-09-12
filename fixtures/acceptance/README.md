# Acceptance fixture

This fixture is the small repository the acceptance demonstration
operates on (SPEC.md section 22.1). It is plain content: Portable
records it as workspace revisions, and the acceptance driver executes
its recipes on attached environments.

## Why each environment is needed

The fixture needs three kinds of environment, each for a concrete
reason:

- **Lightweight evaluation** (`exec.python@1`): inspecting the
  readings dataset is pure computation over bound files. A sandboxed
  Python call answers the summary questions without allocating a
  machine, and the engine's no-network declaration is exactly the
  guarantee the data inspection wants.
- **Native processes** (`exec.process@1`): the data integrity test
  and the dependency installation need the real `node` binary — real
  exit codes, a real filesystem, and a real package layout. No
  sandboxed interpreter can stand in for them.
- **Independent browser inspection** (`browser.session@1`): the
  dashboard page fills its summary through a script that fetches
  `/api/summary`. Only a browser that renders and executes the page
  observes what a user sees, and the browser must outlive any one
  compute allocation to prove the server was replaced underneath it.

## Layout

| Path | What it holds |
| --- | --- |
| `data/readings.csv` | The dataset every environment inspects. |
| `inspection/summarize.py` | The data inspection program, run through lightweight Python with the data directory bound read-only. |
| `recipes/dependencies.json` | The declared dependency reconstruction recipe. |
| `recipes/server.json` | The declared application startup recipe. |
| `vendor/acme-format/` | The dependency the recipes install. |
| `app/server.mjs` | The dashboard application server. |
| `app/dashboard.html` | The browser-visible page. |
| `tests/check-data.mjs` | The native data integrity test. |
| `scripts/check-artifact.mjs` | The artifact checker the acceptance driver runs. |
| `verification/artifact.schema.json` | The rules a verification artifact must satisfy. |
| `verification/sample-report.json` | One valid artifact, for reference. |

## Recipes

Portable imports and transfers state; it executes no recipe. The
recipes are declared data the acceptance driver follows when it
reconstructs dependencies and starts the application on a fresh
environment:

1. `recipes/dependencies.json` runs `recipes/install-vendor.mjs`,
   which installs `vendor/acme-format` into `node_modules`. The step
   is idempotent, so a reconstruction that runs twice changes nothing.
2. `recipes/server.json` names `dependencies` as its requirement and
   starts `app/server.mjs`. The server prints one `dashboard-ready`
   line with the bound port; the driver reads that line and stops
   waiting.

## Artifacts

A verification artifact names the workspace revision it verifies.
`scripts/check-artifact.mjs` validates report files against
`verification/artifact.schema.json` and fails any report whose checks
are not all passed. The acceptance driver records its artifacts in
this shape and runs the checker over them.
