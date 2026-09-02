# Benchmark datapack

`openrouter-benchmarks.json` is generated daily by
`.github/workflows/refresh-openrouter-benchmarks.yml` and published as the
replaceable asset on the `benchmark-data-latest` GitHub Release. Normal package
releases download that asset into this directory as an offline fallback. It
contains public model metadata and benchmark results only. The OpenRouter API
key remains in GitHub Actions secrets and is never written here or shipped with
the CLI.
