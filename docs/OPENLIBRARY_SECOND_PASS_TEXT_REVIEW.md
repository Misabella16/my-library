# Second-pass Open Library text review (no new dumps, no fabricated editions)

The first pass found 2,066 verified matches, while the second pass identified
5,364 candidates requiring further review. This workflow narrows the review
queue to one author-verified Work whose primary title agrees with a strong
title variant of your library book.

**The output remains review-only.** No data is sent to My Library until you
choose exactly which proposals to approve on the private Imports & Undo page.
Only missing synopsis and tags can be added. Covers, copies, private EPUBs,
edition names and special-edition artwork cannot be changed here.

## 1. Export the current catalogue

On your private My Library site, open
Imports & Undo → Local-first Open Library Works repair → Export my full library catalogue (JSON).

Export a fresh my-library-catalogue.json. If earlier imports added tags or
synopses, the fresh catalogue prevents proposals for fields that are no
longer missing and includes the latest book version.

## 2. Prepare text proposals on your Mac

Update the my-library-main/local-mac helper to the latest
prepare_second_pass_text.py from this repository. Keep the existing
openlibrary_dump_match.py and openlibrary_second_pass.py beside it.

~~~bash
cd ~/Downloads/my-library-main

python3 local-mac/prepare_second_pass_text.py \
  --review "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json" \
  --catalogue ~/Downloads/my-library-catalogue.json \
  --output "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-text-proposals.json"
~~~

This offline step does not read the huge Works or Authors dumps. It uses
the saved second-pass report. It includes source-backed tags, but deliberately
does not paste the truncated synopsis preview into your books.

For **complete** synopses, optionally rerun using --fetch-synopses.
This fetches individual Work descriptions, checks title and preview against
saved source evidence, throttles requests and saves a local checkpoint.
If interrupted, use the same command to resume without repeating completed
source lookups. Python 3.11 users whose macOS certificate bundle is missing
can use their installed certifi bundle without disabling SSL verification:

~~~bash
cd ~/Downloads/my-library-main

SSL_CERT_FILE="$(python3 -m certifi)" python3 local-mac/prepare_second_pass_text.py \
  --review "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-review.json" \
  --catalogue ~/Downloads/my-library-catalogue.json \
  --output "/Volumes/Fanfic Annex/MyLibrary/OpenLibraryDumps/second-pass-text-proposals.json" \
  --fetch-synopses
~~~

The source retrieval is optional; without it, the report contains only
tag proposals for books whose source has tags. The full synopsis is not
reconstructed from the 350-character first-look preview.

## 3. Preview, choose and apply

In your private My Library site, open
Imports & Undo → Review second-pass Open Library text repairs.

1. Choose second-pass-text-proposals.json.
2. Click Preview 20 (read-only).
3. Compare the book/author, official Open Library work, proposed synopsis
   and tags. Check only items you approve. You can select all ready on
   this page after reviewing.
4. Click Apply selected text repairs, or Next 20 to continue reviewing.

The website re-checks the current book title, author, title variant and
version on preview and save. A book edited since export is held for review.
The server never creates fake Online display editions, nor attaches generic
artwork to a special edition.

Changes are logged with Text repair history & Undo. Undo is blocked if later
user edits would be overwritten. A lost network response can leave the last
batch uncertain, so inspect history before resubmitting after Load failed.

## Other candidates

Entries with multiple author-verified works, insufficient author evidence,
common titles, or no useful text metadata remain outside this first batch.
Treat them as a separate review list. This workflow does not turn 5,364
candidate leads into 5,364 verified book identities.
