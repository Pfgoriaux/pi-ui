# pi-ui

Two independent Pi extensions in one package, each with its own entry in
`package.json` `pi.extensions`: `src/usage-bar/` and `src/context-breakdown/`.
See [README.md](README.md) for behavior and limits.

## Usage bar

The usage bar displays account quota snapshots, not session token costs.

Codex in Pi is direct, not routed through Aperture: resolve its existing login
through Pi's model registry for read-only usage polling. Never persist or log
credentials. Synthetic/Neuralwatt stay behind their installed extension event
APIs. Never interpret missing data as zero. Neuralwatt header events contain
placeholder balances; consume its API snapshots instead.

## Checks

Run `npm run check` before claiming completion. Tests use isolated temporary
caches and mocked events; they do not verify live provider responses.
