#!/usr/bin/env python3
"""Build a compact extraction batch from raw inbox JSON files.

Usage:
  python scripts/make_batch.py --limit 20 > /tmp/trench_batch.md
  python scripts/make_batch.py --since 2026-05-01 > /tmp/trench_batch.md
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INBOX = ROOT / "raw" / "inbox"
PROMPT = ROOT / "prompts" / "mimo_extractor.md"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--include-prompt", action="store_true")
    args = p.parse_args()

    files = sorted(INBOX.glob("*.json"), reverse=True)[: args.limit]
    if args.include_prompt and PROMPT.exists():
        print(PROMPT.read_text(encoding="utf-8"))
        print("\n---\n")

    print("# Trench Intel Extraction Batch\n")
    print(f"Files included: {len(files)}\n")
    for path in reversed(files):
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"## {path.name}\nERROR reading file: {exc}\n")
            continue
        print(f"## {path.name}")
        print(f"source: {rec.get('source', 'unknown')}")
        print(f"url: {rec.get('url', '')}")
        if rec.get("title"):
            print(f"title: {rec['title']}")
        print("\n```text")
        print((rec.get("text") or "").strip())
        print("```\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
