# Verified ISBN edition enrichment (missing publisher and cover)

My Library keeps Work-level identity, ISBN-edition identity, and cover
identity as separate tasks. The new **ISBN edition enrichment** tool
is under private My Library → Imports & Undo → Advanced tools →
**Use recovered ISBNs to restore missing edition covers and publishers**.

## What it does

- Scans already-saved, non-special editions with checksum-valid ISBN-10
  or ISBN-13 and missing publisher or cover. Books without an ISBN,
  manually entered copies and special/collector editions are not
  modified.
- Paginates through the owner's private database in 150-record pages
  using an edition-ID cursor. It does not repeatedly scan the entire
  database for each record or download a giant Open Library dump.
- On an owner click, Check ISBN sources requests the Open Library
  ISBN-to-edition details using its official Books API. Source calls are
  paced at a minimum of about 1.2 seconds between starts in one Worker
  process. The owner can pause or resume in the same browser tab.
- Verifies the remote record is an Edition with the exact ISBN, and its
  title matches the existing book's title or a strong title variant.
  A present explicit author name cannot contradict the book.
- Shows source edition, publisher, publication date and an optional
  edition-specific cover preview. The owner chooses whether to include
  the cover, confirms their review, and clicks Apply.
- Fills only an empty publisher, and attaches an edition-level cover
  only if that edition has no images. Covers are marked possible, not
  user_verified. No cover image bytes are bulk-downloaded; a trusted
  Open Library cover URL is linked.
- Saves a record in ISBN edition enrichment history. Guarded Undo
  removes exactly the image this operation added and restores the
  previous publisher only if no later changes would be lost.

## What it never does

- No new books, editions or copies; no fabricated Online display edition.
- No replacing artwork, photos, or special-edition vendor covers.
- No changing original ISBNs, notes, reviews, shelves, ratings or EPUBs.
- No inferred publication editions from Work-level lists.
- No automatic writes on scan, check, preview or failed lookup.
- No repeating a potentially successful write after a lost response.
  Review history and Undo before attempting an uncertain write again.
- No guaranteed coverage: Open Library lacks some ISBN-editions or
  collectible covers.

## Order of operations

1. Run ISBN Recovery first, using Goodreads, Calibre and saved EPUB
   metadata, and explicitly approve any confirmed missing ISBNs.
2. Then run Scan all missing edition fields here.
3. Click Check ISBN sources (continue automatically). Keep the tab
   open for interactive research; this is not a background task.
   You can stop or resume. Provider rate limits may interrupt source
   retrieval, in which case retry later.
4. Filter or select a candidate, compare title, ISBN, publisher, date
   and cover against your actual edition.
5. Optionally deselect Include the previewed source cover to
   recover only the missing publisher.
6. Tick the review confirmation and Apply. Use history if you need Undo.

## Source

Open Library Books API:
https://openlibrary.org/dev/docs/api/books

The jscmd=details response contains the individual edition record for
an ISBN. The API also documents jscmd=data for bibliographic metadata.
This feature intentionally verifies fields from the source edition and
does not use Work-level cover IDs for special editions.
