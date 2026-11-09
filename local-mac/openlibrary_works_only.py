#!/usr/bin/env python3
"""Match My Library's missing metadata using ONLY Open Library Works + Authors.

The full Editions dump is NOT needed. No online API calls happen during
matching; only --download contacts Open Library to fetch two monthly dumps.

1. On My Library -> Imports & Undo -> Advanced tools -> Offline matching,
   export "my-library-catalogue.json".
2. python3 local-mac/openlibrary_works_only.py --catalogue ~/Downloads/my-library-catalogue.json --download --output ~/Downloads/my-library-matches.json
3. Import the resulting match report in My Library's Offline matching section.

Pass --works and --authors paths to reuse existing dumps without downloading.
The import API checks the book's identity and last update again before writing.
"""
import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

# Existing project helpers: format parsing, safe ISBN-independent identity
# normalization, catalogue eligibility, and field truncation.
from openlibrary_dump_match import (
    AUTHOR_KEY_RE, WORK_KEY_RE, author_refs, cover_id, desc,
    dump_records, normalize, read_catalogue, subjects,
)

DUMP_URLS = {
    "works": "https://openlibrary.org/data/ol_dump_works_latest.txt.gz",
    "authors": "https://openlibrary.org/data/ol_dump_authors_latest.txt.gz",
}
MAX_TITLE_CANDIDATES = 100
DUMP_MIN_BYTES = 1024 * 1024


def download_dump(url, destination, minimum=DUMP_MIN_BYTES):
    """Reuse completed dumps, resume partial downloads when Range is honored."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and destination.stat().st_size >= minimum:
        print("Reusing:", destination, flush=True)
        return destination
    partial = destination.with_name(destination.name + ".part")
    existing = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "MyLibraryWorksMatcher/1.0 (personal offline use)"}
    if existing:
        headers["Range"] = f"bytes={existing}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        status = getattr(response, "status", 200)
        continuing = bool(existing and status == 206)
        if continuing:
            content_range = response.headers.get("Content-Range", "")
            if not content_range.startswith(f"bytes {existing}-"):
                raise ValueError("Download resume offset did not match. Partial file preserved.")
        mode = "ab" if continuing else "wb"
        total = existing if continuing else 0
        print("Downloading:", url, flush=True)
        with partial.open(mode) as out:
            while True:
                block = response.read(4 * 1024 * 1024)
                if not block:
                    break
                out.write(block)
                total += len(block)
                if total % (256 * 1024 * 1024) < len(block):
                    print(f"  received {total / 1024**3:.2f} GiB", flush=True)
    if total < minimum:
        raise ValueError("Download unexpectedly small. Kept .part file for inspection.")
    partial.replace(destination)
    return destination


def required_dumps(args):
    found = {}
    for kind in DUMP_URLS:
        explicit = getattr(args, kind)
        expected = args.data_dir / f"ol_dump_{kind}_latest.txt.gz"
        path = explicit or expected
        if not path.is_file():
            if not args.download:
                raise ValueError(f"{kind} dump not found: {path}. Pass --{kind} PATH or --download.")
            free = shutil.disk_usage(args.data_dir if args.data_dir.exists() else args.data_dir.parent).free
            if free < 5 * 1024**3:
                raise ValueError("Need at least 5 GiB free to download Works + Authors.")
            path = download_dump(DUMP_URLS[kind], expected)
        else:
            print("Reusing existing", kind, "dump:", path, flush=True)
        found[kind] = path
    return found


def match_works_only(catalogue, works_path, authors_path, *, progress=False):
    targets = read_catalogue(catalogue)
    title_targets = defaultdict(list)
    for book in targets:
        title_targets[book["title_key"]].append(book)
    candidates = defaultdict(dict)
    overflow = set()
    scanned_works = 0
    for kind, key, work in dump_records(works_path):
        if kind != "/type/work" or not WORK_KEY_RE.fullmatch(key):
            continue
        scanned_works += 1
        title_key = normalize(work.get("title"))
        if title_key not in title_targets or title_key in overflow:
            continue
        if len(candidates[title_key]) >= MAX_TITLE_CANDIDATES:
            overflow.add(title_key)
            candidates.pop(title_key, None)
            continue
        candidates[title_key][key] = {
            "key": key,
            "title": work.get("title", ""),
            "author_keys": author_refs(work),
            "synopsis": desc(work.get("description")),
            "tags": subjects(work.get("subjects")),
            "cover_id": cover_id(work.get("covers")),
        }
        if progress and scanned_works % 3000000 == 0:
            print(f"Works scanned: {scanned_works:,}", file=sys.stderr, flush=True)

    needed_author_keys = {
        a for group in candidates.values() for work in group.values()
        for a in work["author_keys"]
    }
    authors = {}
    scanned_authors = 0
    for kind, key, person in dump_records(authors_path):
        if kind != "/type/author" or not AUTHOR_KEY_RE.fullmatch(key):
            continue
        scanned_authors += 1
        if key in needed_author_keys:
            names = [person.get("name", "")] + (
                person.get("alternate_names") if isinstance(person.get("alternate_names"), list) else []
            )[:30]
            authors[key] = {normalize(v) for v in names if isinstance(v, str) and normalize(v)}
        if progress and scanned_authors % 3000000 == 0:
            print(f"Authors scanned: {scanned_authors:,}", file=sys.stderr, flush=True)

    matches, review, unmatched = [], [], []
    for book in targets:
        title_key = book["title_key"]
        if title_key in overflow:
            review.append({"book_id": book["id"], "title": book["title"],
                           "reason": "too_many_works_with_this_title"})
            continue
        verified = [
            work for work in candidates.get(title_key, {}).values()
            if any(book["author_key"] in authors.get(key, set())
                   for key in work["author_keys"])
        ]
        if len(verified) > 1:
            review.append({"book_id": book["id"], "title": book["title"],
                           "reason": "multiple_verified_works"})
            continue
        if not verified:
            unmatched.append({"book_id": book["id"], "title": book["title"],
                              "reason": "no_exact_title_and_author_match"})
            continue
        work = verified[0]
        synopsis = work["synopsis"] if book["needs_synopsis"] else ""
        tags = work["tags"] if book["needs_tags"] else []
        cover = work["cover_id"] if book["needs_cover"] else None
        if not synopsis and not tags and not cover:
            unmatched.append({"book_id": book["id"], "title": book["title"],
                              "reason": "no_missing_metadata_in_work"})
            continue
        matches.append({
            "book_id": book["id"],
            "expected_updated_at": book["updated_at"],
            "title": book["title"],
            "author": book["author"],
            "source_title": work["title"],
            "source_author": book["author"],
            "source_work": work["key"],
            "source_edition": "",
            "match_type": "title_author",
            "matched_isbn": "",
            "synopsis": synopsis,
            "tags": tags,
            "cover_id": cover,
        })
    return {
        "format": "my-library-openlibrary-matches-v1",
        "source": "Open Library Works and Authors monthly dumps (no editions)",
        "counts": {
            "works_scanned": scanned_works,
            "authors_scanned": scanned_authors,
            "books_needing_data": len(targets),
            "verified_matches": len(matches),
            "needs_review": len(review),
            "unmatched": len(unmatched),
        },
        "items": matches,
        "needs_review": review[:2000],
        "unmatched": unmatched[:2000],
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--catalogue", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--works", type=Path, help="Path to existing compressed Works dump")
    p.add_argument("--authors", type=Path, help="Path to existing compressed Authors dump")
    p.add_argument("--download", action="store_true", help="Fetch missing Works + Authors only")
    p.add_argument("--data-dir", type=Path, default=Path.home() / "Downloads" / "OpenLibraryDumps")
    args = p.parse_args(argv)
    if not args.catalogue.is_file():
        p.error(f"Catalogue not found: {args.catalogue}")
    try:
        paths = required_dumps(args)
        result = match_works_only(args.catalogue, paths["works"], paths["authors"], progress=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        fd = os.open(args.output, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(result, out, ensure_ascii=False, separators=(",", ":"))
        os.chmod(args.output, 0o600)
    except (OSError, ValueError, EOFError, UnicodeError) as error:
        p.exit(1, f"Offline matching failed safely: {error}\n")
    print(json.dumps(result["counts"], indent=2))
    print("Import verified matches using My Library -> Imports & Undo -> Offline matching:")
    print(args.output)
    if result["counts"]["needs_review"]:
        print("Ambiguous titles were held for review; none were auto-applied.")


if __name__ == "__main__":
    main()
