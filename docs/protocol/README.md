# Protocol

UltraCode has three versioned internal protocols, defined in spec section 5 "Versioned internal protocols":

- `app.v1` — public JSON-RPC/JSONL app-server contract (lands in Stage 2)
- `host.v1` — typed desktop host bridge (lands in Stage 8)
- `worker.v1` — compatibility-worker RPC (lands in Stage 8)

Versioned schemas and generated clients for each live here when implemented. All protocols evolve additively within a minor version; major-version mismatches are hard rejections.
