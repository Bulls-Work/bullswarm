# bullswarm changelog draft

## 0.35.2 — provider-owned durable history

- providers: OpenCode and Command Code expose the same durable-transcript
  reader contract as the first-class providers. OpenCode reads its SQLite
  sessions read-only; Command Code reads persisted project JSONL only when a
  session transcript exists and carries usage.
- reprice: transcript lookup follows the loaded provider registry, so
  `opencode2*`, `opencode2:orbit-*`, and `command-code` pools can reach their
  provider-owned readers without another hard-coded provider list. Ambiguous,
  missing, and checkpoint-only records stay unknown rather than becoming
  zero-cost attempts.
- command-code: the 116 historical attempts studied for this release used
  `--no-session`, so their checkpoints are documented as non-recoverable
  history; future recovery requires a matching persisted JSONL transcript.
- pricing: public model cards are retained only with a source and date (the
  cards in this draft were checked 2026-09-20).
  `orbit/*` and `opencode/union-alpha` relay identifiers have no public card,
  so the underlying OpenAI card is not substituted; observed Command Code
  models use the cited Command Code card.
- evidence: both live streams were captured for real on 2026-09-20 and checked
  in as `tests/fixtures/streams/opencode-hello.jsonl` and
  `tests/fixtures/streams/command-code-hello.jsonl`; each contrib connector now
  claims `eventStream.usage` rules those captures prove, so a live stream value
  is provider-reported for both pools. The durable reader remains the
  historical fallback where no live stream exists.
