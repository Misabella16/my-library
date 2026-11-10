# Open Library second pass (review-only)

Use this after openlibrary_works_only.py has finished. Reuses the existing Works and Authors dumps and the first-pass report. **No new dump downloads and no changes to the website/database.** It makes a human-readable review queue, never an automatic import.

The earlier 2,066 verified matches remain excluded from this pass. The 1,025 ambiguous and 9,538 unmatched books are not necessarily absent from Open Library; many were rejected by strict first-pass matching rules.

## Run on the Mac

First update the local my-library-main folder with the latest GitHub version. Then in Terminal:

~~~sh
cd ~/Downloads/my-library-main

python3 local-mac/openlibrary_second_pass.py \
  --catalogue ~/Downloads/my-library-catalogue.json \
  --previous "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/my-library-matches-works.json" \
  --works "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/ol_dump_works_2026-10-31.txt.gz" \
  --authors ~/Downloads/ol_dump_authors_2026-10-31.txt \
  --output "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json"
~~~

The script reads the compressed Works dump directly without extracting a large text copy. It scans Works and Authors once to find new title variants and author aliases. Keep the Fanfic Annex drive connected.

Outputs on Fanfic Annex:

- second-pass-review.json: source evidence, separate review and unresolved categories.
- second-pass-review.csv: spreadsheet-friendly review queue, with source URL, author status, available synopsis/cover/tags, and optional ISBN evidence.

No first-pass verified match gets imported or modified. Similar titles alone are never accepted as verified identities.

## All ISBNs automatically (recommended)

The first ISBN script was limited to 100 requests per invocation. You no longer
need to repeat that command every 100 ISBNs. First, ensure the review report
already exists. Then run this **once** from the latest GitHub code:

~~~sh
cd ~/Downloads/my-library-main

python3 local-mac/openlibrary_isbn_batch.py \
  --report "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json"
~~~

This identifies all eligible ISBNs in the saved report and requests small
groups from Open Library's Search API: 15 ISBNs per request by default, or
up to 25 if you supply `--batch-size 25`. It uses no parallel requests,
pauses at least 1.5 seconds between requests and stops safely if the
source is rate-limiting. The entire eligible queue is processed by a
single invocation. You never need to start a new manual 100-item batch.

Progress is checkpointed **after every completed API batch** to
`second-pass-review.isbn-batch-checkpoint.json`, in the same folder as
the report. The existing old-style
`second-pass-review.isbn-checkpoint.json` from the earlier 100-item
command is also reused to avoid duplicate lookups. On interruption
or a network or rate-limit error, re-run the *same* command later:
completed ISBNs will not be searched again.

The script updates `second-pass-review.json` and
`second-pass-review.csv`. Evidence from search is marked as
a **work-level candidate**, not definitive proof of an exact edition or
a special-edition cover. Nothing is automatically applied to My Library.

Open Library asks that applications avoid hundreds of separate per-book
API calls, use batched Search API results, identify themselves, cache
results and avoid using its API as an automated high-volume data backend.
This script is intended for a one-time, owner-triggered review of missing
metadata in your personal catalogue, not ongoing harvesting. For larger
ongoing needs, use its monthly data dumps.

### Earlier ISBN command (still supported)

`openlibrary_second_pass.py --isbn-only --isbn-lookups 100` still
works, but is no longer the preferred way to process the entire queue.

## Review reasons

- alternate_title_or_author_review: one candidate with author evidence, still review-only.
- multiple_author_verified_works: more than one plausible work.
- title_candidate_author_unverified: title similarity without author proof.
- crowded_title_candidate_limit: title has too many candidates.
- matched_but_no_missing_metadata_available: identified source offers no missing synopsis, tags, or cover.
- no_matching_title_variant_in_works_dump: no conservative title match in the downloaded snapshot; does not prove the book is absent from Open Library.

Work-level cover art is not evidence for a specific FairyLoot, Illumicrate, paperback, hardcover, or other edition. Never create an invented Online display edition just to attach artwork.

The second-pass JSON intentionally has a different format and cannot be fed to My Library's Apply ALL verified matches control. Review first and create a separately verified import report if appropriate.
