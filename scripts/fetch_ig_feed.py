#!/usr/bin/env python3
"""
fetch_ig_feed.py — CRA Construction Website
Fetches the 12 most recent CRA Instagram posts and writes instagram_feed.json.
Run after each successful post to keep the website feed current.
Secrets are read from the marketing agent's .secrets/ directory.

Instagram's CDN image URLs are signed and expire after a few weeks, which
left the homepage strip blank. So each image is downloaded into
photos/instagram/ and the feed points at that local copy instead.
"""
from __future__ import annotations
import io
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
SECRETS_DIR = Path.home() / "projects" / "cra-marketing-agent" / ".secrets"
OUTPUT_FILE = REPO_ROOT / "instagram_feed.json"
IMAGE_DIR = REPO_ROOT / "photos" / "instagram"
# Tiles render at roughly 200px on desktop; 400px covers 2x screens.
IMAGE_WIDTH = 400


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
        f"&limit=12&access_token={token}"
    )
    with urllib.request.urlopen(url, timeout=15) as r:
        data = json.loads(r.read())
    posts = []
    for p in data.get("data", []):
        mt = p.get("media_type")
        # For VIDEO/REELS, thumbnail_url is a still image; media_url is the .mp4.
        # Prefer the thumbnail so the grid shows a proper poster, not a black tile.
        if mt in ("VIDEO", "REELS"):
            image_url = p.get("thumbnail_url") or p.get("media_url")
        else:
            image_url = p.get("media_url") or p.get("thumbnail_url")
        posts.append({
            "id": p.get("id"),
            "caption": (p.get("caption") or "")[:200],
            "media_type": mt,
            "image_url": image_url,
            "permalink": p.get("permalink"),
            "timestamp": p.get("timestamp"),
        })
    return posts


def save_image(post_id: str, url: str) -> str:
    """Download one post image into IMAGE_DIR and return its site-relative path."""
    with urllib.request.urlopen(url, timeout=30) as r:
        raw = r.read()
    dest = IMAGE_DIR / f"{post_id}.jpg"
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        if im.width > IMAGE_WIDTH:
            im = im.resize((IMAGE_WIDTH, round(im.height * IMAGE_WIDTH / im.width)), Image.LANCZOS)
        im.save(dest, "JPEG", quality=80, optimize=True, progressive=True)
    except ImportError:
        dest.write_bytes(raw)
    return f"photos/instagram/{dest.name}"


def localize_images(posts: list[dict]) -> None:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    keep = set()
    for p in posts:
        if p.get("image_url") and p.get("id"):
            p["image_url"] = save_image(p["id"], p["image_url"])
            keep.add(Path(p["image_url"]).name)
    # Drop images for posts that have rolled out of the 12 most recent.
    for f in IMAGE_DIR.glob("*.jpg"):
        if f.name not in keep:
            f.unlink()


def main() -> None:
    posts = fetch_feed()
    localize_images(posts)
    output = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "posts": posts,
    }
    OUTPUT_FILE.write_text(json.dumps(output, indent=2))
    print(f"Wrote {len(posts)} posts to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
