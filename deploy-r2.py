#!/usr/bin/env python3
"""Deploy dist/ to Cloudflare R2 via boto3 (S3-compatible API).

Required env vars:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
Optional:
  R2_BUCKET (default: casino-h5-games)
  SITE_URL  (canonical base URL, e.g. https://pub-xxx.r2.dev)
  CLOUDFLARE_API_TOKEN (used to enable r2.dev public access)
"""
import json
import mimetypes
import os
import pathlib
import sys
import urllib.request

import boto3
from botocore.config import Config

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / "dist"

ACCOUNT = os.environ["R2_ACCOUNT_ID"]
KEY = os.environ["R2_ACCESS_KEY_ID"]
SECRET = os.environ["R2_SECRET_ACCESS_KEY"]
BUCKET = os.environ.get("R2_BUCKET", "casino-h5-games")
SITE = os.environ.get("SITE_URL", "https://casino-h5-games.pages.dev").rstrip("/")
OLD = "https://casino-h5-games.pages.dev"

ENDPOINT = f"https://{ACCOUNT}.r2.cloudflarestorage.com"

s3 = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    aws_access_key_id=KEY,
    aws_secret_access_key=SECRET,
    region_name="auto",
    config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
)

# 1) ensure bucket
try:
    s3.head_bucket(Bucket=BUCKET)
    print(f"[1/3] bucket exists: {BUCKET}")
except Exception:
    s3.create_bucket(Bucket=BUCKET)
    print(f"[1/3] bucket created: {BUCKET}")

# 2) upload files
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_HTML = "public, max-age=3600, must-revalidate"

files = sorted(p for p in DIST.rglob("*") if p.is_file())
count = 0
for p in files:
    rel = p.relative_to(DIST).as_posix()
    if rel == "_headers":
        continue
    data = p.read_bytes()
    if SITE and rel.endswith((".html", ".xml", ".txt", ".md")):
        data = data.replace(OLD.encode(), SITE.encode())
    ctype, _ = mimetypes.guess_type(rel)
    if not ctype:
        ctype = "application/octet-stream"
    if rel.endswith(".js"):
        ctype = "application/javascript"
    if rel.endswith(".svg"):
        ctype = "image/svg+xml"
    if rel.endswith(".md"):
        ctype = "text/markdown; charset=utf-8"
    if rel.endswith((".html", ".xml", ".txt", ".md")) and "charset" not in ctype:
        ctype += "; charset=utf-8"
    cache = CACHE_IMMUTABLE if rel.endswith((".js", ".css", ".svg", ".woff2")) else CACHE_HTML
    s3.put_object(
        Bucket=BUCKET,
        Key=rel,
        Body=data,
        ContentType=ctype,
        CacheControl=cache,
    )
    count += 1
print(f"[2/3] uploaded {count} objects")

# 3) try enabling r2.dev public access via Cloudflare API
token = os.environ.get("CLOUDFLARE_API_TOKEN")
if token and SITE.startswith("https://"):
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/public_access"
    req = urllib.request.Request(url, data=b"{}", method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode())
            print(f"[3/3] public access: {body.get('success')} alias={body.get('result', {}).get('alias')}")
    except Exception as e:
        print(f"[3/3] public access skipped/failed: {e}")
else:
    print("[3/3] public access skipped (no token or custom domain)")

print(f"DONE bucket={BUCKET} site={SITE}")
