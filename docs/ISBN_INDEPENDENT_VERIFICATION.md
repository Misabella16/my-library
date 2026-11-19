# Independent ISBN verification and safe bulk approval

The new verifier is part of the private ISBN Recovery panel in Imports & Undo.
It follows the Goodreads, Calibre and saved-EPUB catalogue scan. It does not
download Open Library dumps or infer an edition from title-only search.

## How to use it

1. In ISBN Recovery select your Calibre folder and optional Goodreads export,
   then click Scan all missing edition ISBNs.
2. Under Independently verify ISBNs before approving, click Verify / resume
   all ISBN candidates. The browser requests small batches of exact ISBN
   lookups from official Open Library Books API (jscmd=details) and Google
   Books (q=isbn:...). Source requests are paced. Pause and resume in-tab.
3. Outcomes are independently verified ebook ISBNs, needs-edition-review,
   mismatches, not found and conflicting identifiers. The source titles,
   authors, publishers, format evidence and direct edition links are shown.
4. Export verification checkpoint to save a local JSON report. After reload,
   run the catalogue scan again, then Restore previous verification.
   Restored results never authorize writes without fresh server checks.
5. Filter to Verified ebook ISBNs. Select individual records or select all
   independently verified ebook ISBNs. Apply selected verified ISBNs prompts
   for explicit owner confirmation and saves in guarded small batches.
6. If providers return 403, 429, 5xx or network errors, verification pauses
   without classifying the ISBN as missing. If an apply response is lost,
   inspect ISBN Recovery history before trying again.

## Strict verification policy

- A checksum-valid ISBN does not prove ownership of an edition.
- Open Library must return an individual edition with the exact ISBN,
  matching title and explicit matching author.
- Google Books must independently corroborate that exact ISBN, book title
  and author.
- For a bulk-verified status, an EPUB must be linked to the exact existing
  book and standard ebook edition, and the source edition must explicitly
  identify ebook/electronic-book format. No print ISBN is inferred to be
  an ebook ISBN based on a digital preview.
- Goodreads/Calibre title matches, vague online records, ISBNs for other
  formats, missing author or format evidence, and collector editions
  remain Needs review.
- Contradictory title/author source records are Mismatch, and genuinely
  absent source records become Not found. Temporary request failures
  are never mistaken for Not found.
- Conflicting local ISBNs for one edition cannot be bulk-approved.
- The server rechecks source records on each approved write and refuses
  stale, already-filled, duplicate or special-edition assignments.
- Only the blank ISBN on an existing non-special edition can be filled.
  No new books, editions, copies, covers, notes, reviews, EPUB files, or
  shelves are modified. Successful changes have guarded Undo.

## Limits

Many fanfiction EPUBs and special editions have no registered ISBN or
contain platform-specific IDs. Those are not silently assigned a print
ISBN. This workflow runs only while the browser remains open. It does not
create a perpetual background crawler or use massive Open Library dumps.

Open Library Books API: https://openlibrary.org/dev/docs/api/books
Google Books API: https://developers.google.com/books/docs/v1/using
