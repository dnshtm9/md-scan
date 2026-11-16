# md-scan

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/dnshtm9/md-scan/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/dnshtm9/md-scan/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, hand-written scanner that renders byte-identical HTML to marked 18.1.3 (GFM defaults) with no token tree: blocks and inline constructs are recognized by direct index scanning and the HTML is emitted as each construct is matched. On the 720-case benchmark it renders the whole set about 1.9x faster than marked itself (wall-clock minimum 334 ms vs 626 ms, best round 2.40x).

## Run it

```sh
node main.ts
```

It reads every case from `/input/cases.json` and writes the rendered HTML strings, in order, to `/output/html.json`; outside a container the `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` environment variables stand in for those mounts.

## How it works

The parser makes a single pass over the source: a block scanner classifies each line by its leading characters and appends finished HTML for headings, lists, tables, quotes, code and raw HTML blocks as it goes, queueing inline text for one combined scan. The inline scanner then walks each queued source with a per-character dispatch table, rendering links, emphasis, code spans, autolinks and escapes into HTML while it locates the next construct — no intermediate token objects are built and no dependencies are used. Module state is limited to read-only grammar tables, so every parse is independent and deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sage-kestrel-67&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
