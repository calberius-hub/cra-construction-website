#!/usr/bin/env python3
"""
fetch_ig_feed.py — CRA Construction Website
Fetches the 6 most recent CRA Instagram posts and writes instagram_feed.json.
Run after each successful post to keep the website feed current.
Secrets are read from the marketing agent's .secrets/ directory.
"""
from __future__ import annotations
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SECRETS_DIR = Path.home() / "projects" / "cra-marketing-agent" / ".secrets"
OUTPUT_FILE = Path(__file__).parent.parent / "instagram_feed.json"


def get_token() -> str:
    return (SECRETS_DIR / "instagram_token.txt").read_text().strip()


def get_ig_account_id() -> str:
    return (SECRETS_DIR / "instagram_account_id.txt").read_text().strip()


def fetch_feed() -> list[dict]:
    token = get_token()
    ig_id = get_ig_account_id()
    url = (
        f"https://graph.facebook.com/v20.0/{ig_id}/media"
        f"?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp"
        f"&limit=6&access_token={token}"
    )
    with urllib.request.urlopen(url, timeout=15) as r:
        data = json.loads(r.read())
    posts = []
    for p in data.get("data", []):
        posts.append({
            "id": p.get("id"),
            "caption": (p.get("caption") or "")[:200],
            "media_type": p.get("media_type"),
            "image_url": p.get("media_url") or p.get("thumbnail_url"),
            "permalink": p.get("permalink"),
            "timestamp": p.get("timestamp"),
        })
    return posts


def main() -> None:
    posts = fetch_feed()
    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "posts": posts,
    }
    OUTPUT_FILE.write_text(json.dumps(output, indent=2))
    print(f"Wrote {len(posts)} posts to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
