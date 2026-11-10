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

## Optional ISBN lookups without repeating the huge scan

The Works dump does not contain a full edition/ISBN index. For selective edition identity evidence, you can run up to 50 paced ISBN queries *after* the review report exists:

~~~sh
cd ~/Downloads/my-library-main
python3 local-mac/openlibrary_second_pass.py --isbn-only --isbn-lookups 50 \
  --output "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json"
~~~

This uses the saved review report, persists a checkpoint, stops on source limits and **does not rescan the 41.7 million Works records**. You may run it again in small increments. ISBN results are strictly review evidence; they are not approved for automatic import. Do not automate large volumes of Open Library API requests.

## Review reasons

- alternate_title_or_author_review: one candidate with author evidence, still review-only.
- multiple_author_verified_works: more than one plausible work.
- title_candidate_author_unverified: title similarity without author proof.
- crowded_title_candidate_limit: title has too many candidates.
- matched_but_no_missing_metadata_available: identified source offers no missing synopsis, tags, or cover.
- no_matching_title_variant_in_works_dump: no conservative title match in the downloaded snapshot; does not prove the book is absent from Open Library.

Work-level cover art is not evidence for a specific FairyLoot, Illumicrate, paperback, hardcover, or other edition. Never create an invented Online display edition just to attach artwork.

The second-pass JSON intentionally has a different format and cannot be fed to My Library's Apply ALL verified matches control. Review first and create a separately verified import report if appropriate.
