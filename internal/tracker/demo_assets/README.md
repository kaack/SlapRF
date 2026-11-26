# Pre-Generated Showcase Demo Assets

Pre-baked showcase workspace state (`showcase_state.json.gz`) and multi-gate `.rfbin` Practice RSSI traces (`session-1.rfbin.gz`, `session-2.rfbin.gz`, `session-3.rfbin.gz`) embedded into `slaprf/internal/tracker`.

To regenerate after updating `demo_showcase_gen.go`:

```bash
go generate ./internal/tracker
```
