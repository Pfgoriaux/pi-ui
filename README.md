# pi-ui

Two widgets shown below the input box in every interactive Pi tab:

- **Usage bar:** provider quota snapshots for Synthetic, Neuralwatt, Codex, and
  Claude, plus coloring of the footer's context token.
- **Context breakdown:** a stacked bar of what fills the context window, and a
  `/context` command with the detailed breakdown.

```sh
npm ci --ignore-scripts
pi install git:github.com/Pfgoriaux/pi-ui
# Or a local checkout:
pi install /absolute/path/to/pi-ui
```

Run `/reload` once in existing tabs; new tabs load it automatically. Print, JSON,
and RPC sessions show no widgets and do not poll.

## Context breakdown

After the first message, one line shows a colored stacked bar, used/total tokens
with the percentage, and a legend for categories at 3% or more of the estimate.
Categories are system prompt parts (base, context files, skills, tools,
sections, config, guidelines) and messages (user, assistant, tool calls, tool
results, images, summaries, other).

Category sizes are estimates at about four characters per token. Tool
definitions are approximated. When Pi reports actual usage, the total and
percentage use it; otherwise they use the estimate.

`/context` lists each nonzero category with a bar, estimated tokens, share, and
item count, followed by the estimated total and the context window. It adds the
actual total and usage when Pi reports them.

## Usage bar

The existing footer's context token (for example `51.2%/272k`) is colored by
**context remaining in this tab**: green at ≥75%, orange below 75%, red below 50%.
The displayed percentage still means **used**, like the native footer. Unknown
usage after compaction is grey. No extra context label is added to the quota bar.
The extension decorates Pi's exported native footer renderer, preserving its
accounting/layout, and removes the decoration on shutdown/reload.

## Data sources

- **Synthetic:** requests the installed `@aliou/pi-synthetic` extension's quota
  events every minute. Shows rolling five-hour and weekly percentages remaining,
  with refill countdowns; falls back to legacy request quota when supplied.
- **Neuralwatt:** requests the installed `@aliou/pi-neuralwatt` extension's quota
  events every minute. Shows remaining energy.
- **Codex:** polls ChatGPT's `/backend-api/wham/usage` every minute through
  Pi's existing `openai-codex` login, including while idle or using another model.
  Shows the five-hour/weekly limits and resets.
  Codex is direct, not routed through Aperture. This private endpoint can change;
  failed checks show a safe error or retain a visibly stale previous reading.
- **Claude:** polls `api.anthropic.com/api/oauth/usage`, the undocumented
  endpoint behind Claude Code's `/usage` screen, through Pi's existing
  `anthropic` login. It polls three minutes after a successful reading and
  retries once a minute after a failure. Shows the five-hour and weekly windows.
  The endpoint is rate limited per token and can change.

The bar hides credit balances (`$` and paid credits) and per-model weekly
limits, even when a provider reports them.

No credentials are copied or logged. Pi manages Codex and Claude login refresh.
Synthetic/Neuralwatt utility requests use those installed extensions' existing
configuration; this does not migrate their credential handling to Aperture.

Normalized numbers and timestamps are shared across local tabs under
`$PI_CODING_AGENT_DIR/cache/usage-bar` (default `~/.pi/agent/cache/usage-bar`).
Cache files and polling claims are schema-versioned so older open tabs cannot
overwrite percentage-aware readings or suppress their refreshes.
A per-minute claim limits this widget's polling to one tab per provider;
other extensions' own polling is independent. Tabs read the cache every five
seconds. The cache assumes one account per provider in a Pi agent directory;
clear it after changing accounts. Files are owner-only and contain no tokens,
account IDs, emails, or raw responses.

Colors use explicit RGB (independent of the Pi theme) and the lowest reported
remaining quota: **green ≥50%**, **orange <50%**, **red <25%**. Energy
quota uses its reported total to calculate a percentage.
Unknown totals, expired fixed reset times, and stale readings are grey.
A past Synthetic refill timestamp does not invalidate a fresh balance: pending
refills are labeled without removing the quota color.

Readings older than three minutes are marked **stale**. Expired fixed-window
countdowns say **refresh due**; the widget never invents a renewed balance.
Provider failures leave the previous reading visibly stale, or unavailable if
no reading exists. Provider extensions must be enabled for active refreshes.

## Development

`npm run check` runs formatting/lint, strict types, tests, and repo hygiene.
The tests are offline and do not establish live API or terminal compatibility.
