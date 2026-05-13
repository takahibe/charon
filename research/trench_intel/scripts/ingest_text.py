#!/usr/bin/env python3
"""Append raw trench-intel text into timestamped inbox files.

Usage:
  python scripts/ingest_text.py --source badattrading_ --url https://x.com/... --text "..."
  pbpaste | python scripts/ingest_text.py --source x_community --url https://x.com/...
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INBOX = ROOT / "raw" / "inbox"


def slugify(s: str, max_len: int = 60) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]+", "-", s.strip()).strip("-")
    return (s[:max_len] or "unknown").lower()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--source", default="unknown", help="badattrading_, x_community, gmgn_note, axiom_note, nova_note, etc.")
    p.add_argument("--url", default="", help="Source URL if available")
    p.add_argument("--text", default="", help="Raw text. If empty, stdin is read.")
    p.add_argument("--title", default="", help="Optional title/label")
    args = p.parse_args()

    text = args.text if args.text else sys.stdin.read()
    text = text.strip()
    if not text:
        print("No text provided", file=sys.stderr)
        return 2

    INBOX.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).astimezone()
    stamp = now.strftime("%Y%m%d_%H%M%S")
    label = slugify(args.title or args.source)
    out = INBOX / f"{stamp}_{label}.json"
    record = {
        "ingested_at": now.isoformat(),
        "source": args.source,
        "url": args.url,
        "title": args.title,
        "text": text,
    }
    out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
