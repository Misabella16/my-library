#!/usr/bin/env python3
"""Prepare REVIEW-ONLY, text-only second-pass proposals for My Library.

Inputs are the saved second-pass JSON and a fresh exported My Library catalogue.
No dump files needed. No My Library connection. No cover/edition changes.

Example:
 python3 local-mac/prepare_second_pass_text.py \
   --review "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json" \
   --catalogue ~/Downloads/my-library-catalogue.json \
   --output "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-text-proposals.json"

Full synopsis text cannot be reconstructed from the 350-character preview
stored in the report. Use --fetch-synopses to retrieve exact Work descriptions
from the official source, paced and checkpointed. Any interrupted run can
be restarted without losing completed lookups. No automatic site imports.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from openlibrary_dump_match import desc, normalize, read_catalogue, subjects, WORK_KEY_RE
from openlibrary_second_pass import atomic_json, title_variants

FORMAT = "my-library-openlibrary-second-pass-review-v1"
OUT_FORMAT = "my-library-openlibrary-second-pass-text-v1"
MIN_GAP = 1.5
MAX_REPLY = 1024 * 1024


def same_variant(book_title, source_title):
    """A strong shared title variant, NOT proof of edition identity."""
    left = set(title_variants(book_title))
    right = set(title_variants(source_title))
    return any(len(key) >= 12 and len(key.split()) >= 2 for key in left & right)


def select_proposals(report, catalogue):
    books = {book["id"]: book for book in read_catalogue(catalogue)}
    proposals, skipped = [], []
    seen = set()
    for entry in report["review"]:
        bid = entry.get("book_id")
        candidates = entry.get("candidates")
        if bid in seen or not isinstance(bid, str):
            skipped.append({"book_id": bid, "reason": "duplicate_review_entry"})
            continue
        seen.add(bid)
        book = books.get(bid)
        if not book or entry.get("reason") != "alternate_title_or_author_review":
            skipped.append({"book_id": bid, "reason": "not_single_verified_candidate"})
            continue
        if not isinstance(candidates, list) or len(candidates) != 1:
            skipped.append({"book_id": bid, "reason": "ambiguous_candidates"})
            continue
        c = candidates[0]
        work_key = c.get("source_work")
        if (c.get("author_verified") is not True
                or c.get("title_method") != "exact"
                or c.get("source_title_method") != "primary"
                or not isinstance(work_key, str)
                or not WORK_KEY_RE.fullmatch(work_key)
                or not same_variant(book["title"], c.get("source_title", ""))):
            skipped.append({"book_id": bid, "reason": "insufficient_title_or_author_evidence"})
            continue
        # Second pass recorded source-backed tags, but stored only a synopsis
        # preview. Do not paste that preview as if it were the full synopsis.
        tags = subjects(c.get("tags", [])) if book["needs_tags"] else []
        want_synopsis = bool(book["needs_synopsis"] and c.get("has_synopsis"))
        if not tags and not want_synopsis:
            skipped.append({"book_id": bid, "reason": "no_missing_text_to_recover"})
            continue
        proposals.append({
            "book_id": book["id"],
            "title": book["title"],
            "author": book["author"],
            "expected_updated_at": book["updated_at"],
            "source_work": work_key,
            "source_title": c["source_title"],
            "source_author": book["author"],
            "match_type": "reviewed_title_variant",
            "title_variant_author_verified": True,
            "source_edition": "",
            "matched_isbn": "",
            "cover_id": None,
            "synopsis": "",
            "tags": tags,
            "synopsis_pending": want_synopsis,
            "source_synopsis_preview": c.get("synopsis_preview", ""),
            "source_url": "https://openlibrary.org" + work_key,
        })
    return proposals, skipped


def fetch_work_description(work_key, expected_title, preview):
    req = urllib.request.Request(
        "https://openlibrary.org" + work_key + ".json",
        headers={"Accept": "application/json",
                 "User-Agent": "MyLibraryTextReview/1.0 (owner-initiated missing-field review)"}
    )
    with urllib.request.urlopen(req, timeout=35) as response:
        if response.status != 200:
            raise ValueError("Unexpected work response status")
        raw = response.read(MAX_REPLY + 1)
        if len(raw) > MAX_REPLY:
            raise ValueError("Work response too large")
        data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Invalid Work response")
    actual_key = data.get("key")
    if actual_key not in (None, work_key):
        return ""
    if normalize(data.get("title")) != normalize(expected_title):
        return ""
    full = desc(data.get("description"))
    if not full:
        return ""
    # Detect a changed or mismatched source record. We only have a short
    # preview from the original dump, but it should match the current source.
    if preview and not normalize(full).startswith(normalize(preview[:140])):
        return ""
    return full


def hydrate(proposals, checkpoint_path, *, sleep=time.sleep, getter=fetch_work_description,
            progress=print):
    cache = {}
    if checkpoint_path.exists():
        with checkpoint_path.open(encoding="utf-8") as f:
            cache = json.load(f)
        if not isinstance(cache, dict):
            raise ValueError("Synopsis checkpoint is invalid")
    waiting = [p for p in proposals if p["synopsis_pending"]]
    checked = 0
    paused = False
    for p in waiting:
        key = p["source_work"]
        if key not in cache:
            try:
                cache[key] = getter(key, p["source_title"], p["source_synopsis_preview"])
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    cache[key] = ""
                else:
                    progress("Paused synopsis retrieval at HTTP " + str(e.code))
                    paused = True
                    break
            except (OSError, ValueError, json.JSONDecodeError) as e:
                progress("Paused synopsis retrieval due to a connection/source error: "
                         + str(e))
                paused = True
                break
            atomic_json(checkpoint_path, cache)
            sleep(MIN_GAP)
        p["synopsis"] = cache[key]
        p["synopsis_pending"] = not bool(p["synopsis"])
        checked += 1
        if checked % 25 == 0:
            progress(f"Synopsis sources checked this run: {checked:,}/{len(waiting):,}; "
                     f"cached: {len(cache):,}")
    return len(cache), paused


def build_output(proposals, skipped, *, cache_count=0, paused=False):
    ready = [p for p in proposals if p["synopsis"] or p["tags"]]
    return {
        "format": OUT_FORMAT,
        "note": "REVIEW ONLY until the owner explicitly approves in My Library. "
                "Never writes editions or covers.",
        "counts": {
            "shortlisted": len(proposals),
            "text_proposals": len(ready),
            "synopses_recovered": sum(bool(p["synopsis"]) for p in ready),
            "tags_available": sum(bool(p["tags"]) for p in ready),
            "synopses_still_pending": sum(p["synopsis_pending"] for p in proposals),
            "source_checks_cached": cache_count,
            "source_checks_paused": paused,
            "skipped": len(skipped),
        },
        "items": ready,
        "skipped": skipped[:1000],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--catalogue", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fetch-synopses", action="store_true",
                        help="Retrieve complete Works descriptions at a conservative pace; "
                             "can resume via local checkpoint")
    args = parser.parse_args(argv)
    for source in (args.review, args.catalogue):
        if not source.is_file():
            parser.error("File not found: " + str(source))
    if args.output.resolve() in {args.review.resolve(), args.catalogue.resolve()}:
        parser.error("Output cannot overwrite a source file")
    with args.review.open(encoding="utf-8") as f:
        report = json.load(f)
    if report.get("format") != FORMAT or not isinstance(report.get("review"), list):
        parser.error("Expected original second-pass-review.json")
    proposals, skipped = select_proposals(report, args.catalogue)
    cache_path = args.output.with_suffix(".synopsis-checkpoint.json")
    cache_count, paused = 0, False
    if args.fetch_synopses:
        cache_count, paused = hydrate(proposals, cache_path)
    output = build_output(proposals, skipped, cache_count=cache_count, paused=paused)
    atomic_json(args.output, output)
    print(json.dumps(output["counts"], indent=2), flush=True)
    print("Review proposals:", args.output)
    print("No changes made to My Library, editions, covers, copies, or EPUBs.")
    if output["counts"]["synopses_still_pending"]:
        print("Synopsis preview was NOT imported as full text. "
              "Use --fetch-synopses to recover complete source descriptions.")
    if paused:
        print("Source requests paused. Re-run the same command to resume cached lookups.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, UnicodeError) as error:
        sys.exit("Text proposal preparation stopped safely: " + str(error))
