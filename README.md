<p align="center">
  <img width="160" height="160" src="./design/icon.svg" alt="Wingover logo">
</p>

<h1 align="center">Wingover</h1>

<p align="center">
Flight recorder and planner for paramotor pilots. Open source and privacy-first: no account, no telemetry, no server — your flights stay on your device. Optional sync, if you want it, goes only to a server you choose: your own CouchDB, or ours.
</p>

- [STEERING.md](./STEERING.md) — project direction and values
- [PLAN.md](./PLAN.md) — current status and next steps

## Development

Most development happens in a plain browser against a mock recording engine (append `?mock-speed=120` to time-compress simulated flights).

Maps: street view (OpenFreeMap) works with zero configuration. The satellite layer uses MapTiler — the built-in key is restricted to official builds (origin `wingover.app` / app user agent), so for your own satellite builds get a free key at maptiler.com and set `VITE_MAPTILER_KEY` (or paste it under Settings → MapTiler key).

```sh
pnpm install
pnpm dev        # browser ring with mock engine
pnpm test       # unit tests
pnpm e2e        # Playwright e2e, including reload kill drills
pnpm build      # typecheck + production build
```

## License

[AGPL-3.0](./LICENSE)
