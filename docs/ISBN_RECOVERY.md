# ISBN Recovery: Goodreads + Calibre + saved EPUBs + online edition research

This owner-only module is part of My Library under:

**Imports & Undo → Advanced tools → ISBN Recovery**

It finds candidate ISBNs for **existing editions missing an ISBN**.
ISBNs belong to editions, not intellectual works. Never assign an
Open Library work's ISBN list to a random owned edition.

## Full catalogue workflow

1. Optionally choose a Goodreads library export CSV (has ISBN and ISBN13
   columns). It stays in your browser; no Goodreads password, review or
   shelf data is uploaded.
2. Optionally choose Calibre CSV/JSON or its root folder containing
   metadata.opf files. It is inspected locally, not reuploaded in bulk.
3. Click **Scan all missing edition ISBNs**. My Library reads only its
   existing books, editions and saved EPUB metadata in automatically
   advancing, cursor-paginated pages. Watch the live counters. There is
   no manual 100-book scan limit; Pause and Resume work in the same tab.
4. The report groups evidence from saved EPUBs, Goodreads CSV and Calibre
   exports for each actual existing standard edition, showing the ISBN-13
   and its source. ISBN-10 identifiers are checksum-validated and
   converted to ISBN-13.
5. Press **Preview this page** to re-check current edition timestamps,
   previously assigned identifiers, title/author identities, Goodreads
   identity, and saved EPUB provenance.
6. Examine only the actual editions you can verify. Tick approval, then
   **Apply selected approved ISBNs**. Approved writes occur in small
   transactional groups, with change-log history and Undo.
7. Use **ISBN recovery history & Undo** to reverse an approved addition
   unless you edited the edition later.

You can work through the entire catalogue without rescanning the huge
Open Library Works/Authors downloads. Only the read-only My Library
database and optional local files are consulted during the full scan.

## Read-only online research

Use **Find book in scanned catalogue** or the **Research ISBN
candidates online** action on a suggested record.

For that ONE book, the site checks official Open Library search results
and Google Books volume metadata, shows their candidate ISBNs and links
to original records. An online work title/author match is not
edition-level proof. Online candidates cannot be automatically applied
by this endpoint. Verify a particular publisher, format, and cover
against your copy before editing its existing edition.

The online lookup is manual/on-demand, not a crawler of all 15,000
books. It avoids huge downloads, mass API harvests, and filling an
edition with an unrelated ISBN.

## Safety

- The script never creates books, editions, copies, or placeholder
  Online display editions.
- It refuses to overwrite any existing ISBN, even when invalid.
- It blocks special/collector editions and mismatched Goodreads IDs.
- It does not change book titles, synopsis, reviews, shelf placements,
  private EPUB files, ratings, notes, covers, or special-edition images.
- Saved EPUB suggestions are confirmed against the EPUB file already
  linked to the *same book and same edition* on the server.
- Goodreads and Calibre source files are read locally by the browser,
  and their suggestions require explicit owner review.
- A checksum-valid ISBN alone doesn't verify publisher edition identity.
  If multiple candidates disagree, the UI flags the conflict and
  won't bulk-approve that edition.
- A failed/ambiguous write response is never automatically resent.
  Inspect history before scanning again or retrying.
- Undo checks the edition version and ISBN, and refuses to overwrite
  changes made after the recovery.
- No new database migration is required, and no new Open Library dump
  needs to be downloaded.

## If you previously deleted Works and Authors dumps

That does not affect ISBN Recovery. It uses already-saved catalogue
records and metadata, with optional small per-book external lookups.

Existing Open Library / Google Books developer docs:
https://openlibrary.org/dev/docs/api/search
https://developers.google.com/books/docs/v1/using
