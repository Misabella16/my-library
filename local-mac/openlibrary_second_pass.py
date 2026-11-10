#!/usr/bin/env python3
"""Second-pass, review-only Open Library matcher for My Library.

Reuses the *existing* Works and Authors dumps and first-pass JSON report.
Does not download new dumps or change the catalogue, database, or website.

Example:
  python3 local-mac/openlibrary_second_pass.py \
    --catalogue ~/Downloads/my-library-catalogue.json \
    --previous "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/my-library-matches-works.json" \
    --works "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/ol_dump_works_2026-10-31.txt.gz" \
    --authors ~/Downloads/ol_dump_authors_2026-10-31.txt \
    --output "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json"

--isbn-lookups N optionally checks up to N exact ISBNs against Open Library's
individual-edition endpoint, with a local checkpoint and pacing. Default: 0.
ISBN hits are evidence for human review, never automatically imported.
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

from openlibrary_dump_match import (
    AUTHOR_KEY_RE, WORK_KEY_RE, author_refs, cover_id, desc,
    dump_records, isbn13, normalize, read_catalogue, subjects,
)

# A broad title is *not* an identity. Bound memory and flag crowded titles.
PER_BOOK_LIMIT = 24
SERIES_SUFFIX = re.compile(
    r"\s*(?:\([^)]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^)]*\)"
    r"|\[[^\]]*(?:#\s*\d+|(?:book|volume|vol\.?|part)\s*#?\s*\d+)[^\]]*\])\s*$",
    re.I,
)
SUBTITLE_SPLIT = re.compile(r"\s*[:：]\s+|\s+[—–]\s+")
ISOLATED_SUBTITLE = re.compile(r"\s+(?:a novel|an autobiography|a memoir)\s*$", re.I)


def title_variants(title):
    """Return conservative lookup keys, never assertions of identity."""
    text = str(title or "").strip()
    found = {}

    def add(value, method):
        key = normalize(value)
        if key and key not in found and (method == "exact" or len(key.split()) >= 2):
            found[key] = method

    add(text, "exact")
    cleaned = SERIES_SUFFIX.sub("", text).strip()
    if cleaned != text:
        add(cleaned, "series_suffix")
    bare = ISOLATED_SUBTITLE.sub("", cleaned)
    if bare != cleaned:
        add(bare, "descriptor_removed")
    split = SUBTITLE_SPLIT.split(cleaned, 1)
    if len(split) == 2:
        add(split[0], "subtitle_removed")
    # Two spellings are common in community archives; still require author verification.
    for value, method in tuple((k, m) for k, m in found.items()):
        if " and " in value:
            add(value.replace(" and ", " "), "conjunction_variant")
    return found


def work_titles(work):
    result = [(str(work.get("title") or ""), "primary")]
    for field in ("other_titles", "alternative_titles"):
        aliases = work.get(field)
        if isinstance(aliases, list):
            result.extend((s, "source_alternate_title") for s in aliases[:20]
                          if isinstance(s, str))
    if isinstance(work.get("subtitle"), str):
        result.append((str(work.get("title") or "") + ": " + work["subtitle"],
                       "source_subtitle"))
    return result


def candidate_metadata(work):
    return {
        "work_id": work.get("_key", ""),
        "source_title": str(work.get("title") or "")[:350],
        "author_keys": author_refs(work)[:20],
        "has_synopsis": bool(desc(work.get("description"))),
        "synopsis_preview": desc(work.get("description"))[:350],
        "tags": subjects(work.get("subjects")),
        "cover_id": cover_id(work.get("covers")),
    }


def load_previous(path):
    with path.open("r", encoding="utf-8") as stream:
        report = json.load(stream)
    if report.get("format") != "my-library-openlibrary-matches-v1":
        raise ValueError("Expected the original Works-only match report")
    if not isinstance(report.get("items"), list):
        raise ValueError("First-pass report has no verified items")
    ids = [entry.get("book_id") for entry in report["items"]
           if isinstance(entry, dict)]
    if len(ids) != len(set(ids)):
        raise ValueError("First-pass report contains duplicate book identities")
    return set(ids)


def scan_local(books, works, authors, *, progress=True):
    by_title = defaultdict(set)
    for book in books:
        for title_key in title_variants(book["title"]):
            by_title[title_key].add(book["id"])

    candidates = defaultdict(dict)
    hit_count = defaultdict(int)
    works_scanned = 0
    for kind, key, data in dump_records(works):
        if kind != "/type/work" or not WORK_KEY_RE.fullmatch(key):
            continue
        works_scanned += 1
        matched = {}
        for title, source_method in work_titles(data):
            for title_key, target_method in title_variants(title).items():
                if title_key not in by_title:
                    continue
                for bid in by_title[title_key]:
                    rank = (target_method != "exact") + (source_method != "primary")
                    prior = matched.get(bid)
                    if prior is None or rank < prior[0]:
                        matched[bid] = (rank, target_method, source_method, title)
        if matched:
            data["_key"] = key
            payload = candidate_metadata(data)
            for bid, (_, target_method, source_method, matched_title) in matched.items():
                if key in candidates[bid]:
                    continue
                hit_count[bid] += 1
                if len(candidates[bid]) >= PER_BOOK_LIMIT:
                    continue
                candidates[bid][key] = {
                    **payload, "target_title_method": target_method,
                    "source_title_method": source_method,
                    "matched_title": str(matched_title)[:350],
                }
        if progress and works_scanned % 3000000 == 0:
            print(f"Works scanned: {works_scanned:,}", flush=True)

    required_author_keys = {
        key for group in candidates.values() for item in group.values()
        for key in item["author_keys"]
    }
    author_names = {}
    authors_scanned = 0
    for kind, key, data in dump_records(authors):
        if kind != "/type/author" or not AUTHOR_KEY_RE.fullmatch(key):
            continue
        authors_scanned += 1
        if key in required_author_keys:
            aliases = data.get("alternate_names")
            raw_names = [data.get("name", "")] + (aliases[:40] if isinstance(aliases, list) else [])
            names = {normalize(name) for name in raw_names if isinstance(name, str)}
            author_names[key] = names
        if progress and authors_scanned % 3000000 == 0:
            print(f"Authors scanned: {authors_scanned:,}", flush=True)
    return candidates, hit_count, author_names, works_scanned, authors_scanned


def review_second_pass(books, candidates, hit_count, authors):
    review, unresolved = [], []
    for book in books:
        bid = book["id"]
        all_candidates = list(candidates.get(bid, {}).values())
        verified = [
            c for c in all_candidates
            if any(book["author_key"] in authors.get(key, set())
                   for key in c["author_keys"])
        ]
        # A title that hit the 24-candidate safety limit is never "confirmed".
        crowded = hit_count.get(bid, 0) > PER_BOOK_LIMIT
        verified.sort(key=lambda c: (
            c["target_title_method"] != "exact",
            c["source_title_method"] != "primary", c["work_id"]
        ))
        candidate_rows = []
        for item in (verified if verified else all_candidates)[:5]:
            helpful = ((book["needs_synopsis"] and item["has_synopsis"])
                       or (book["needs_tags"] and bool(item["tags"]))
                       or (book["needs_cover"] and bool(item["cover_id"])))
            candidate_rows.append({
                "source_work": item["work_id"],
                "source_url": "https://openlibrary.org" + item["work_id"],
                "source_title": item["source_title"],
                "matched_title": item["matched_title"],
                "title_method": item["target_title_method"],
                "source_title_method": item["source_title_method"],
                "author_verified": item in verified,
                "provides_missing_data": bool(helpful),
                "has_synopsis": item["has_synopsis"],
                "synopsis_preview": item["synopsis_preview"],
                "tags": item["tags"],
                "cover_id": item["cover_id"],
            })

        base = {
            "book_id": bid, "title": book["title"], "author": book["author"],
            "isbns": book["isbns"], "candidate_count": hit_count.get(bid, 0),
            "candidates": candidate_rows,
        }
        if crowded:
            unresolved.append({**base, "reason": "crowded_title_candidate_limit"})
        elif len(verified) > 1:
            review.append({**base, "reason": "multiple_author_verified_works"})
        elif len(verified) == 1:
            if candidate_rows and candidate_rows[0]["provides_missing_data"]:
                # Even alternate title evidence is NOT permitted to auto-write.
                review.append({**base, "reason": "alternate_title_or_author_review"})
            else:
                unresolved.append({**base, "reason": "matched_but_no_missing_metadata_available"})
        elif all_candidates:
            review.append({**base, "reason": "title_candidate_author_unverified"})
        else:
            unresolved.append({**base, "reason": "no_matching_title_variant_in_works_dump"})
    return review, unresolved


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", newline="", encoding="utf-8-sig") as stream:
            out = csv.writer(stream)
            out.writerow(["book_id", "title", "author", "ISBNs", "reason",
                          "source_work", "source_title", "title_method",
                          "source_title_method", "author_verified", "synopsis_available",
                          "cover_available", "tags_available", "source_url"])
            for row in rows:
                sources = row["candidates"] or [{}]
                for cand in sources:
                    out.writerow([row["book_id"], row["title"], row["author"],
                                  ";".join(row["isbns"]), row["reason"],
                                  cand.get("source_work", ""), cand.get("source_title", ""),
                                  cand.get("title_method", ""),
                                  cand.get("source_title_method", ""),
                                  cand.get("author_verified", ""),
                                  cand.get("has_synopsis", ""),
                                  bool(cand.get("cover_id")), bool(cand.get("tags")),
                                  cand.get("source_url", "")])
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def online_isbn_check(rows, cache_path, limit):
    """Bounded, optional per-edition lookup; never imports or auto-verifies authors."""
    if limit <= 0:
        return 0
    if limit > 100:
        raise ValueError("Use at most 100 paced ISBN lookups per run")
    cache = {}
    if cache_path.is_file():
        loaded = json.loads(cache_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            cache = loaded
    requests = 0
    for row in rows:
        if requests >= limit:
            break
        if not row["isbns"]:
            continue
        isbn = row["isbns"][0]
        if isbn not in cache:
            req = urllib.request.Request(
                "https://openlibrary.org/isbn/" + isbn + ".json",
                headers={"User-Agent": "MyLibraryPersonalMatcher/2.0 (small manual ISBN batch)",
                         "Accept": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=25) as response:
                    if response.status != 200:
                        raise ValueError("Unexpected ISBN HTTP status")
                    raw = response.read(512 * 1024 + 1)
                    if len(raw) > 512 * 1024:
                        raise ValueError("ISBN response too large")
                    edition = json.loads(raw)
                    names = (edition.get("isbn_13") or []) + (edition.get("isbn_10") or [])
                    valid = any(isbn13(value) == isbn for value in names)
                    work_refs = [
                        w.get("key") for w in edition.get("works", [])
                        if isinstance(w, dict) and WORK_KEY_RE.fullmatch(w.get("key", ""))
                    ]
                    cache[isbn] = {
                        "status": "isbn_edition_candidate" if valid and len(work_refs) == 1
                        else "isbn_edition_unverified",
                        "source_work": work_refs[0] if len(work_refs) == 1 else "",
                        "edition_title": str(edition.get("title") or "")[:350],
                    }
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    cache[isbn] = {"status": "isbn_not_found"}
                elif error.code in (429, 403, 500, 502, 503):
                    print(f"Stopping ISBN lookups safely at HTTP {error.code}", flush=True)
                    break
                else:
                    print(f"Stopping ISBN lookups at HTTP {error.code}", flush=True)
                    break
            except (OSError, ValueError, json.JSONDecodeError) as error:
                print("Stopping ISBN lookups safely:", str(error), flush=True)
                break
            requests += 1
            atomic_json(cache_path, cache)
            time.sleep(2.5)
        row["isbn_evidence"] = cache[isbn]
    return requests


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("catalogue", "previous", "works", "authors", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--csv", type=Path, help="Default: same output name with .csv")
    parser.add_argument("--isbn-lookups", type=int, default=0,
                        help="Optional paced ONLINE ISBN edition lookups; default is zero")
    args = parser.parse_args(argv)
    paths = [args.catalogue, args.previous, args.works, args.authors]
    for path in paths:
        if not path.is_file():
            parser.error(f"Missing file: {path}")
    if args.output.resolve() in {p.resolve() for p in paths}:
        parser.error("Output must not overwrite an input file")
    if args.isbn_lookups < 0 or args.isbn_lookups > 100:
        parser.error("--isbn-lookups must be between 0 and 100")

    prior_verified = load_previous(args.previous)
    targets = [b for b in read_catalogue(args.catalogue)
               if b["id"] not in prior_verified]
    print(f"Preserving {len(prior_verified):,} first-pass matches; reviewing "
          f"{len(targets):,} remaining books.", flush=True)
    candidates, hit_count, authors, works_scanned, authors_scanned = scan_local(
        targets, args.works, args.authors
    )
    review, unresolved = review_second_pass(targets, candidates, hit_count, authors)
    reviewed_online = online_isbn_check(
        review + unresolved,
        args.output.with_suffix(".isbn-checkpoint.json"), args.isbn_lookups
    )
    counts = {
        "first_pass_verified_preserved": len(prior_verified),
        "second_pass_targets": len(targets),
        "works_scanned": works_scanned,
        "authors_scanned": authors_scanned,
        "needs_review": len(review),
        "unresolved": len(unresolved),
        "isbn_online_requests": reviewed_online,
    }
    result = {
        "format": "my-library-openlibrary-second-pass-review-v1",
        "note": "REVIEW ONLY. Not an auto-import file. No My Library records changed.",
        "counts": counts,
        "review": review,
        "unresolved": unresolved,
    }
    atomic_json(args.output, result)
    csv_path = args.csv or args.output.with_suffix(".csv")
    if csv_path.resolve() in {p.resolve() for p in paths} | {args.output.resolve()}:
        parser.error("CSV must not overwrite an input or report")
    write_csv(csv_path, review + unresolved)
    print(json.dumps(counts, indent=2), flush=True)
    print("Review report:", args.output, flush=True)
    print("Review spreadsheet:", csv_path, flush=True)
    print("No imports, changes, or new database dump downloads were performed.",
          flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, EOFError, UnicodeError) as error:
        sys.exit(f"Second-pass review stopped safely: {error}")
