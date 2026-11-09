#!/usr/bin/env python3
"""Build My Library bulk repair matches entirely offline from official Open Library dumps.

Usage:
  python3 local-mac/openlibrary_dump_match.py --catalogue my-library-catalogue.json \
    --editions ol_dump_editions_latest.txt.gz --works ol_dump_works_latest.txt.gz \
    --authors ol_dump_authors_latest.txt.gz --output my-library-matches.json

Requires Python 3.9+. The matcher itself is offline and does not open
the Calibre DB or contact My Library. With --download, it first downloads the
official compressed dumps to a chosen folder. It never decompresses the dumps
to disk. The downloads are approximately 13 GB total.
"""
import argparse
import gzip
import json
import re
import sys
import shutil
import unicodedata
import urllib.request
from collections import defaultdict
from pathlib import Path

MAX_MATCHES_PER_TITLE = 100
MAX_DESCRIPTION = 10000
MAX_ENTRIES = 100000
ISBN13_RE = re.compile(r"^(978|979)\d{10}$")
WORK_KEY_RE = re.compile(r"^/works/OL\d+W$")
AUTHOR_KEY_RE = re.compile(r"^/authors/OL\d+A$")
UUID_RE = re.compile(r"^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$")


def normalize(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(c for c in value if not unicodedata.combining(c))
    return " ".join(re.findall(r"[\w]+", value.casefold(), re.UNICODE))


def isbn13(value):
    chars = re.sub(r"[\s-]", "", str(value or "")).upper()
    if len(chars) == 10 and chars[:9].isdigit() and (chars[9].isdigit() or chars[9] == "X"):
        total = sum((10 - i) * int(c) for i, c in enumerate(chars[:9]))
        total += 10 if chars[9] == "X" else int(chars[9])
        if total % 11:
            return ""
        chars = "978" + chars[:9]
        s = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(chars))
        chars += str((10 - s % 10) % 10)
    if not ISBN13_RE.fullmatch(chars):
        return ""
    s = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(chars[:12]))
    return chars if int(chars[12]) == (10 - s % 10) % 10 else ""


def desc(value):
    if isinstance(value, dict):
        value = value.get("value", "")
    if not isinstance(value, str):
        return ""
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", " ", value)
    return " ".join(value.split())[:MAX_DESCRIPTION]


def subjects(raw):
    result, seen = [], set()
    for item in (raw if isinstance(raw, list) else [])[:60]:
        if not isinstance(item, str):
            continue
        name = " ".join(item.split())[:75]
        if 3 <= len(name) <= 75 and normalize(name) not in seen:
            result.append(name)
            seen.add(normalize(name))
        if len(result) >= 8:
            break
    return result


def cover_id(raw):
    for n in raw if isinstance(raw, list) else []:
        if type(n) is int and 0 < n <= 1000000000:
            return n
    return None


def work_refs(raw):
    out = []
    for item in raw if isinstance(raw, list) else []:
        key = item.get("key", "") if isinstance(item, dict) else ""
        if WORK_KEY_RE.fullmatch(key):
            out.append(key)
    return out


def author_refs(work):
    output = []
    for value in work.get("authors", []):
        author = value.get("author", {}) if isinstance(value, dict) else {}
        key = author.get("key", "") if isinstance(author, dict) else ""
        if AUTHOR_KEY_RE.fullmatch(key):
            output.append(key)
    return output


def dump_records(path):
    path = Path(path)
    opener = gzip.open if path.name.lower().endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\r\n").split("\t", 4)
            if len(parts) != 5:
                continue
            try:
                obj = json.loads(parts[4])
            except (ValueError, TypeError):
                continue
            if isinstance(obj, dict):
                yield parts[0], parts[1], obj


def read_catalogue(path):
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict) or payload.get("format") != "my-library-bulk-catalogue-v1":
        raise ValueError("Expected My Library's JSON catalogue export, version 1")
    books = payload.get("books")
    if not isinstance(books, list) or len(books) > MAX_ENTRIES:
        raise ValueError("Invalid catalogue size")
    targets = []
    for book in books:
        if not isinstance(book, dict) or not UUID_RE.fullmatch(str(book.get("id", ""))):
            continue
        if book.get("has_synopsis") and book.get("has_cover") and book.get("has_tags"):
            continue
        title, author = str(book.get("title") or ""), str(book.get("author") or "")
        if not normalize(title) or not normalize(author) or normalize(author) in {
            "unknown", "unknown author", "not set", "n a"
        }:
            continue
        if not book.get("updated_at"):
            continue
        isbn_values = []
        for raw in book.get("isbns", []):
            valid = isbn13(raw)
            if valid and valid not in isbn_values:
                isbn_values.append(valid)
        targets.append({
            "id": book["id"], "title": title, "author": author,
            "updated_at": book["updated_at"], "title_key": normalize(title),
            "author_key": normalize(author), "isbns": isbn_values,
            "needs_synopsis": not book.get("has_synopsis"),
            "needs_tags": not book.get("has_tags"),
            "needs_cover": not book.get("has_cover"),
        })
    return targets


def build_matches(catalogue, editions_path, works_path, authors_path):
    targets = read_catalogue(catalogue)
    title_targets = defaultdict(list)
    isbn_targets = defaultdict(list)
    by_id = {b["id"]: b for b in targets}
    for b in targets:
        title_targets[b["title_key"]].append(b["id"])
        for isbn in b["isbns"]:
            isbn_targets[isbn].append(b["id"])

    # A compressed editions dump is read exactly once. Capture matching work
    # references, but never load its millions of unrelated edition records.
    candidates = defaultdict(dict)
    counts = {"editions_scanned": 0, "works_scanned": 0, "authors_scanned": 0}
    for kind, key, e in dump_records(editions_path):
        if kind != "/type/edition":
            continue
        counts["editions_scanned"] += 1
        isbn_hits = set()
        for value in (e.get("isbn_13", []) or []) + (e.get("isbn_10", []) or []):
            clean = isbn13(value)
            isbn_hits.update(isbn_targets.get(clean, []))
        title_hits = set(title_targets.get(normalize(e.get("title")), []))
        if not isbn_hits and not title_hits:
            continue
        ref = work_refs(e.get("works"))
        if len(ref) != 1:
            continue
        wk = ref[0]
        for bid in isbn_hits | title_hits:
            entries = candidates[bid]
            # A common title alone is not enough evidence; cap collisions.
            if len(entries) >= MAX_MATCHES_PER_TITLE and wk not in entries and bid not in isbn_hits:
                continue
            old = entries.get(wk, {})
            isbn_match = bid in isbn_hits or old.get("isbn_match", False)
            entries[wk] = {
                "isbn_match": isbn_match, "edition_key": key if isbn_match or not old else old.get("edition_key", ""),
                "edition_title": e.get("title") or "",
                "by_statement": e.get("by_statement") or old.get("by_statement", ""),
                "cover_id": cover_id(e.get("covers")) or old.get("cover_id"),
                "description": desc(e.get("description")) or old.get("description", "")
            }
        if counts["editions_scanned"] % 3000000 == 0:
            print("Editions scanned:", counts["editions_scanned"], file=sys.stderr, flush=True)

    target_keys = {work for group in candidates.values() for work in group}
    work_data = {}
    title_collisions = defaultdict(list)
    for kind, key, work in dump_records(works_path):
        if kind != "/type/work":
            continue
        counts["works_scanned"] += 1
        title_key = normalize(work.get("title"))
        matched_title = title_key in title_targets
        if not WORK_KEY_RE.fullmatch(key):
            continue
        if not matched_title and key not in target_keys:
            continue
        # Common generic titles can have thousands of unrelated works.
        # Keep all ISBN-linked records, but bound title-only candidates.
        if matched_title and key not in target_keys and len(title_collisions[title_key]) >= MAX_MATCHES_PER_TITLE:
            continue
        data = {
            "key": key, "title": work.get("title") or "",
            "description": desc(work.get("description")),
            "subjects": subjects(work.get("subjects")),
            "covers": cover_id(work.get("covers")),
            "author_keys": author_refs(work),
        }
        work_data[key] = data
        if matched_title and len(title_collisions[title_key]) <= MAX_MATCHES_PER_TITLE:
            title_collisions[title_key].append(key)
        if counts["works_scanned"] % 3000000 == 0:
            print("Works scanned:", counts["works_scanned"], file=sys.stderr, flush=True)

    needed_authors = {a for w in work_data.values() for a in w["author_keys"]}
    author_names = {}
    for kind, key, author in dump_records(authors_path):
        if kind != "/type/author":
            continue
        counts["authors_scanned"] += 1
        if key in needed_authors:
            names = [author.get("name", "")] + (author.get("alternate_names") or [])[:20]
            author_names[key] = [n for n in names if isinstance(n, str)]
        if counts["authors_scanned"] % 3000000 == 0:
            print("Authors scanned:", counts["authors_scanned"], file=sys.stderr, flush=True)

    matches, reviews, misses = [], [], []
    for b in targets:
        work_ids = set(candidates.get(b["id"], {}))
        work_ids.update(title_collisions.get(b["title_key"], []))
        verified = []
        for wk in work_ids:
            w = work_data.get(wk)
            if not w:
                continue
            edition = candidates.get(b["id"], {}).get(wk, {})
            authors = [name for k in w["author_keys"] for name in author_names.get(k, [])]
            if not authors and edition.get("by_statement"):
                authors = [edition["by_statement"]]
            matching_author = next((n for n in authors if normalize(n) == b["author_key"]), "")
            if not matching_author:
                continue
            same_title = normalize(w["title"]) == b["title_key"] or (
                normalize(edition.get("edition_title")) == b["title_key"])
            isbn_match = bool(edition.get("isbn_match"))
            if not same_title and not isbn_match:
                continue
            verified.append((wk, w, edition, matching_author, isbn_match))
        if len(verified) != 1:
            problem = {"book_id": b["id"], "title": b["title"],
                       "reason": "multiple_verified_works" if verified else "not_found_or_author_unverified"}
            (reviews if verified else misses).append(problem)
            continue
        wk, work, edition, author_name, isbn_match = verified[0]
        synopsis = (work["description"] or edition.get("description", "")) if b["needs_synopsis"] else ""
        tags = work["subjects"] if b["needs_tags"] else []
        cover = (edition.get("cover_id") or work["covers"]) if b["needs_cover"] else None
        if not synopsis and not tags and not cover:
            misses.append({"book_id": b["id"], "title": b["title"], "reason": "matched_but_no_missing_fields_available"})
            continue
        matches.append({
            "book_id": b["id"], "expected_updated_at": b["updated_at"],
            "title": b["title"], "author": b["author"], "source_title": work["title"],
            "source_author": author_name, "source_work": wk,
            "source_edition": edition.get("edition_key") or "",
            "match_type": "isbn_author" if isbn_match else "title_author",
            "matched_isbn": b["isbns"][0] if isbn_match and b["isbns"] else "",
            "synopsis": synopsis, "tags": tags, "cover_id": cover,
        })
    return {"format": "my-library-openlibrary-matches-v1",
            "source": "Open Library official monthly data dumps",
            "counts": {**counts, "books_needing_data": len(targets),
                       "verified_matches": len(matches),
                       "needs_review": len(reviews), "unmatched": len(misses)},
            "items": matches, "needs_review": reviews[:2000], "unmatched": misses[:2000]}


OFFICIAL_DUMPS = {
    "editions": "https://openlibrary.org/data/ol_dump_editions_latest.txt.gz",
    "works": "https://openlibrary.org/data/ol_dump_works_latest.txt.gz",
    "authors": "https://openlibrary.org/data/ol_dump_authors_latest.txt.gz",
}


def download_dump(url, destination):
    """Download compressed source bytes only, resuming via HTTP Range when supported."""
    if destination.exists() and destination.stat().st_size > 1024 * 1024:
        print("Reusing existing dump:", destination, flush=True)
        return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    have = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "MyLibraryPersonalDumpMatcher/1.0"}
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        status = getattr(response, "status", 200)
        resume = have > 0 and status == 206
        mode = "ab" if resume else "wb"
        if have and not resume:
            print("Remote server did not resume; restarting this one download.", flush=True)
        written = have if resume else 0
        print("Downloading", url, "to", destination, flush=True)
        with partial.open(mode="wb" if mode == "wb" else "ab") as file:
            while True:
                chunk = response.read(1024 * 1024 * 4)
                if not chunk:
                    break
                file.write(chunk)
                written += len(chunk)
                if written // (256 * 1024 * 1024) != (written-len(chunk)) // (256*1024*1024):
                    print(f"  received {written / (1024**3):.2f} GiB", flush=True)
    if written < 1024 * 1024:
        raise ValueError("Downloaded file is unexpectedly small; keeping partial for inspection")
    partial.replace(destination)
    print("Saved", destination, flush=True)
    return destination


def get_downloads(data_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    # Conservative check: at least 16 GiB free before an estimated 13 GiB
    # download. This does not promise success if the files grow.
    free = shutil.disk_usage(data_dir).free
    if free < 16 * 1024**3:
        raise ValueError("Choose a disk with at least 16 GiB free for the compressed dumps")
    return {
        name: download_dump(url, data_dir / f"ol_dump_{name}_latest.txt.gz")
        for name, url in OFFICIAL_DUMPS.items()
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--catalogue", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--download", action="store_true",
                    help="Download all three official compressed dumps if absent")
    ap.add_argument("--data-dir", type=Path, default=Path.home() / "Downloads" / "OpenLibraryDumps")
    for key in ("editions", "works", "authors"):
        ap.add_argument("--" + key, type=Path)
    args = ap.parse_args()
    if not args.catalogue.is_file():
        ap.error("Catalogue JSON not found: " + str(args.catalogue))
    if args.download:
        found = get_downloads(args.data_dir)
        for key in ("editions", "works", "authors"):
            if getattr(args, key) is None:
                setattr(args, key, found[key])
    for key in ("editions", "works", "authors"):
        path = getattr(args, key)
        if path is None or not path.is_file():
            ap.error("Provide --" + key + " path or use --download")
    print("Matching offline, without calling Open Library APIs.", flush=True)
    report = build_matches(args.catalogue, args.editions, args.works, args.authors)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, separators=(",", ":"))
    print("RESULT:", json.dumps(report["counts"], indent=2), flush=True)
    print("Import this file in My Library:", args.output, flush=True)


if __name__ == "__main__":
    main()
