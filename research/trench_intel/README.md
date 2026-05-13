# Charon Trench Intelligence Pipeline

Purpose: turn messy X / Pump.fun / GMGN / Axiom / Nova resources into structured, testable Charon rules without burning expensive model/API budget.

## Doctrine

Raw material first, LLM second.

- Keep original evidence in `raw/`.
- Use cheap/bulk model for first-pass extraction.
- Use Kimi for normalization and Charon feature design.
- Use Codex/captain for final judgment and implementation risk review.
- Do not let bulk extractor output directly change trading behavior.

## Directory layout

```text
raw/
  inbox/          # user-dropped text/link/screenshot notes awaiting extraction
  x_posts/        # copied tweet/thread/community post text
  screenshots/    # screenshots from Telegram/browser/manual capture
  notes/          # manual notes from GMGN/Axiom/Nova usage
extracted/
  claims.jsonl    # first-pass extracted claims/signals
  tool_tips.jsonl
  wallet_methods.jsonl
normalized/
  rules.jsonl     # deduped Charon-compatible rules
  feature_candidates.md
reports/
  captain_synthesis.md
prompts/
  mimo_extractor.md
  kimi_rule_engineer.md
  codex_verifier.md
scripts/
  ingest_text.py
  make_batch.py
```

## Recommended profile routing

```text
MiMo Pro        bulk extraction / high-volume rough read
MiniMax 2.7     fallback extraction / routine operator work
Kimi 2.6        normalize into rules + implementation plans
Codex 5.5       verifier/debugger/final judgment
Older GPT       cheap formatting and lightweight summaries
```

## Workflow

1. Drop raw source text into `raw/inbox/` using `scripts/ingest_text.py` or by saving files manually.
2. Batch raw files with `scripts/make_batch.py`.
3. Send batch + `prompts/mimo_extractor.md` to MiMo/MiniMax.
4. Save JSONL extraction to `extracted/claims.jsonl`.
5. Send extracted claims + `prompts/kimi_rule_engineer.md` to Kimi.
6. Save normalized rules to `normalized/rules.jsonl` and feature candidates to `normalized/feature_candidates.md`.
7. Let captain/Codex attack the rules before any Charon code change.

## Evidence standard

Every useful claim should preserve:

- source URL or screenshot filename
- original text snippet
- category
- tool/context, if any
- Charon relevance
- data requirements
- risk / possible bias

No evidence = no production rule.
