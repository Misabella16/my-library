#!/usr/bin/env python3
"""Review ALL ISBNs in the saved second-pass report, in paced search batches.

Reuses saved second-pass JSON; does not scan Works or Authors, download dumps,
or modify My Library. Search results are evidence only, not verified editions.

Example:
  python3 local-mac/openlibrary_isbn_batch.py \
    --report "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json"

The script continues through every eligible ISBN, one modest request at a
time, checkpointing results. Run it again only after an interruption, and
completed identifiers are skipped.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from openlibrary_dump_match import WORK_KEY_RE, isbn13
from openlibrary_second_pass import atomic_json, write_csv

FORMAT = "my-library-openlibrary-second-pass-review-v1"
DEFAULT_BATCH_SIZE = 15
MAX_BATCH_SIZE = 25
MAX_BYTES = 4 * 1024 * 1024
MIN_INTERVAL_SECONDS = 1.5


class TemporarySourceProblem(Exception):
    """An API error for which all saved progress should be retained."""


def requested_isbns(rows):
    """Use all valid, unique ISBNs rather than just the first ISBN of each book."""
    result = []
    seen = set()
    for row in rows:
        for raw in row.get("isbns", []):
            normalized = isbn13(raw)
            if normalized and normalized not in seen:
                seen.add(normalized)
                result.append(normalized)
    return result


def query_url(isbns, limit=100):
    if not isbns or len(isbns) > MAX_BATCH_SIZE:
        raise ValueError("Expected 1 to 25 ISBNs")
    if any(not re.fullmatch(r"(?:978|979)\d{10}", x) for x in isbns):
        raise ValueError("Invalid ISBN")
    params = urllib.parse.urlencode({
        "q": "isbn:(" + " OR ".join(isbns) + ")",
        "fields": "key,title,author_name,isbn,cover_i",
        "limit": str(limit),
    })
    return "https://openlibrary.org/search.json?" + params


def fetch_search(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "MyLibraryPersonalISBNReview/3.0 (user-initiated; read-only)",
    })
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            if response.status != 200:
                raise TemporarySourceProblem("Unexpected Open Library response status")
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise TemporarySourceProblem("Open Library search response too large")
            data = json.loads(raw)
    except urllib.error.HTTPError as error:
        if error.code in (403, 429):
            raise TemporarySourceProblem(
                "Open Library is limiting requests (HTTP " + str(error.code) +
                "). Checkpoint saved; resume later."
            ) from error
        raise TemporarySourceProblem("Open Library returned HTTP " + str(error.code)) from error
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError) as error:
        raise TemporarySourceProblem(
            "Network or response issue. Checkpoint saved; resume later."
        ) from error
    if not isinstance(data, dict) or not isinstance(data.get("docs"), list):
        raise TemporarySourceProblem("Invalid Open Library search data; no records marked complete")
    return data


def analyze_search(requested, payload):
    """Never infer an ISBN identity from a fuzzy title or search-result rank."""
    docs = payload["docs"]
    num_found = payload.get("numFound", payload.get("num_found", len(docs)))
    truncated = not isinstance(num_found, int) or num_found > len(docs)
    hits = {isbn: {} for isbn in requested}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        work_id = doc.get("key")
        if not isinstance(work_id, str) or not WORK_KEY_RE.fullmatch(work_id):
            continue
        values = doc.get("isbn")
        if not isinstance(values, list):
            continue
        isbn_values = {isbn13(value) for value in values if isinstance(value, str)}
        for isbn in isbn_values.intersection(hits):
            hits[isbn][work_id] = {
                "work": work_id,
                "source_title": str(doc.get("title") or "")[:300],
                "source_authors": [
                    name[:150] for name in (doc.get("author_name") or [])[:5]
                    if isinstance(name, str)
                ],
                "cover_id": doc.get("cover_i") if isinstance(doc.get("cover_i"), int)
                else None,
            }
    entries = {}
    for isbn in requested:
        options = list(hits[isbn].values())
        if truncated:
            state = "isbn_search_incomplete"
        elif len(options) == 1:
            state = "isbn_work_candidate"
        elif len(options) > 1:
            state = "isbn_multiple_work_candidates"
        else:
            state = "isbn_no_candidate_in_search"
        entries[isbn] = {
            "status": state,
            "source_work": options[0]["work"] if len(options) == 1 else "",
            "edition_title": "",
            "work_candidates": options[:5],
            "note": "Work-level search evidence; verify edition and author before importing",
        }
    return entries


def load_checkpoint(path):
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("Corrupt ISBN checkpoint; retain it for inspection")
    if payload.get("format") != "my-library-isbn-batch-checkpoint-v1":
        raise ValueError("Wrong checkpoint format; do not overwrite")
    cache = payload.get("results")
    if not isinstance(cache, dict):
        raise ValueError("ISBN checkpoint has no results")
    return cache


def persist_checkpoint(path, cache):
    atomic_json(path, {
        "format": "my-library-isbn-batch-checkpoint-v1",
        "results": cache,
    })


def project_results(rows, cache):
    for row in rows:
        evidence = {}
        for raw in row.get("isbns", []):
            value = isbn13(raw)
            if value in cache:
                evidence[value] = cache[value]
        if evidence:
            row["isbn_evidence_by_isbn"] = evidence
            # Preserve existing CSV column contract for the first available ISBN.
            row["isbn_evidence"] = next(iter(evidence.values()))


def batch_all(rows, checkpoint, *, size=DEFAULT_BATCH_SIZE,
              request_fn=fetch_search, sleep_fn=time.sleep, on_progress=None):
    """Process the entire remaining queue; no 100-ISBN manual limit.

    Each successful batch is written atomically to checkpoint immediately.
    If interrupted, the caller can merge the checkpoint into the report,
    and rerun without duplicating completed lookups.
    """
    if not (1 <= size <= MAX_BATCH_SIZE):
        raise ValueError("Batch size must be 1–25")
    cache = load_checkpoint(checkpoint)
    queue = [isbn for isbn in requested_isbns(rows) if isbn not in cache]
    total = len(queue)
    done = 0
    # Pace from the beginning; no parallel workers or multiple-IP bypass.
    while done < total:
        group = queue[done:done + size]
        try:
            response = request_fn(query_url(group))
            additions = analyze_search(group, response)
        except TemporarySourceProblem:
            persist_checkpoint(checkpoint, cache)
            raise
        cache.update(additions)
        persist_checkpoint(checkpoint, cache)
        done += len(group)
        if on_progress:
            on_progress(done, total, cache)
        if done < total:
            sleep_fn(MIN_INTERVAL_SECONDS)
    return cache, done, total


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--report", required=True, type=Path,
                   help="Existing second-pass-review.json file")
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                   help="ISBNs per search request, between 1 and 25 (default: 15)")
    args = p.parse_args(argv)
    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        p.error("--batch-size must be between 1 and 25")
    if not args.report.is_file():
        p.error("The second-pass report was not found")
    with args.report.open("r", encoding="utf-8") as f:
        report = json.load(f)
    if (report.get("format") != FORMAT
            or not isinstance(report.get("review"), list)
            or not isinstance(report.get("unresolved"), list)):
        p.error("Expected the saved second-pass review JSON, not the first-pass import JSON")
    rows = report["review"] + report["unresolved"]
    checkpoint = args.report.with_suffix(".isbn-batch-checkpoint.json")
    csv_path = args.report.with_suffix(".csv")
    if checkpoint.resolve() == args.report.resolve():
        p.error("Checkpoint cannot overwrite report")
    all_identifiers = requested_isbns(rows)
    print(f"Found {len(all_identifiers):,} distinct valid ISBNs across "
          f"{len(rows):,} books.", flush=True)
    print(f"Checking in batches of {args.batch_size}, with automatic "
          "checkpoint and rate pacing.", flush=True)

    last_count = [0]
    def progress(done, total, cache):
        last_count[0] = done
        print(f"ISBNs checked this run: {done:,}/{total:,}; "
              f"cached total: {len(cache):,}", flush=True)

    try:
        cache, _, _ = batch_all(rows, checkpoint, size=args.batch_size,
                                on_progress=progress)
    except (KeyboardInterrupt, TemporarySourceProblem) as error:
        cache = load_checkpoint(checkpoint)
        project_results(rows, cache)
        atomic_json(args.report, report)
        write_csv(csv_path, rows)
        reason = str(error) or "Stopped by user"
        print(f"Paused safely: {reason}. Saved {len(cache):,} ISBN lookups. "
              "Re-run the SAME command to resume without repeated requests.", flush=True)
        return 2

    project_results(rows, cache)
    report["counts"]["isbn_batch_unique_checked"] = sum(
        identifier in cache for identifier in all_identifiers
    )
    atomic_json(args.report, report)
    write_csv(csv_path, rows)
    print(f"Complete: {report['counts']['isbn_batch_unique_checked']:,} unique ISBNs "
          f"cached; results written to {args.report} and {csv_path}", flush=True)
    print("Review only. No live My Library records, copies, or editions were changed.",
          flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError) as error:
        sys.exit(f"ISBN batch review stopped safely: {error}")
