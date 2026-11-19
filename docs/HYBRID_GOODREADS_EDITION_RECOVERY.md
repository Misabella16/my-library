# Hybrid Goodreads + Calibre + EPUB + Open Library ISBN recovery

This upgrade builds on My Library's existing private ISBN Recovery tools. It
uses Goodreads as a local, owner-provided CSV evidence source, not a public
Goodreads API, and makes Open Library's actual Work editions browseable
without downloading a full Editions dump.

## Data sources

- **Goodreads CSV:** book ID, ISBN-10, ISBN-13, publisher, binding, and
  publication year where provided by the export. Separate ISBN-10/13 values
  that disagree are retained as conflicting proposals. A specific Goodreads
  book ID helps locate the source edition, but it does not independently
  prove that the user owns that edition. A known paperback/hardcover binding
  is not proposed to an existing ebook edition.
- **Calibre folder/CSV/JSON:** identifiers, known formats, publisher and
  publication date are shown alongside proposals; nothing is uploaded in
  bulk to the website.
- **Stored EPUBs:** an identifier from a saved EPUB that is already linked
  to a particular owned standard ebook edition is treated as direct local
  evidence. It is still checked against external publisher edition records.
- **Open Library Books API:** exact ISBN-to-edition record, including known
  authors, title, publisher, publication format, year, and cover ID.
  Requests for up to 3 ISBNs are combined into one bounded Books API
  request to reduce traffic, with Google Books checked by ISBN.
- **Open Library Search + Work Editions API:** use per-book search to
  discover a possible Work and browse up to 20 of its actual editions
  (with edition ISBNs, publisher, year, format and cover). Pagination is
  bounded to 200 total offsets and is owner-initiated; this is research only.
- **Google Books:** an independent exact-ISBN volume lookup, including
  title, authors, publisher, date, and reference link.

## Matching labels

- **Verified ebook ISBN:** an existing linked EPUB identifier, exact
  edition-level ISBN + matching title/author in both sources, and explicit
  ebook format on the Open Library edition. Only these can be selected for
  bulk approval. Every write rechecks current library identity, ISBN,
  source, EPUB link and the live external records, with Undo.
- **Probable edition:** both providers agree about ISBN, title and author,
  but owned format or edition provenance is incomplete. This can be
  inspected and explicitly approved **one edition at a time** after the
  owner verifies the publisher, binding and actual copy. It cannot be
  selected for bulk approval.
- **Needs edition review:** only one online source corroborates the
  ISBN, or important identity fields are missing. Manual source research
  can proceed, but no bulk approval is permitted.
- **Mismatch:** exact-ISBN evidence contradicts a source title or
  author; must be resolved before assigning an ISBN.
- **Not found:** no corroborating exact-edition record was found. This
  does not prove that the ISBN is invalid or the book doesn't exist.
- **Conflicting proposals:** multiple valid ISBNs were offered for the
  same existing edition. These are excluded from bulk approval and must
  be reviewed manually.

## How to use

1. Open Imports & Undo → ISBN Recovery.
2. Select the Goodreads CSV and Calibre folder or export if available,
   and scan existing books, editions and linked EPUBs locally.
3. Run the independent ISBN verifier. It combines Open Library ISBN
   lookups into groups of at most three, and uses Google Books as a
   second source. Pause and export your verification checkpoint when
   needed. Rate limits do not become false "not found" results.
4. Filter Verified, Probable, Needs review or Conflicts. Read the actual
   Goodreads edition hints and direct source links; view candidate cover
   art where a source edition provides a cover ID.
5. Select verified ebook ISBNs for explicitly confirmed bulk approval.
   Probable and Needs-review items can only be approved individually
   after inspecting the actual owned edition, with a second confirmation
   and fresh edition checks. Any ambiguous save response requires
   inspection of the Undo history before retrying.
6. For books with no local ISBN at all, use Research ISBN candidates
   online → Browse actual editions and cover candidates under a matching
   Open Library Work. This is read-only; discovery never creates a
   fake owned edition, attaches a generic cover, or assigns an ISBN.

## Safety

No auto-created books, editions, copies, or fake Online display entries.
Never overwrite existing ISBNs, collector edition covers, personal photos,
reviews, notes, private EPUB files or shelf locations. Open Library and
Google Books cover art is displayed as candidate art; it is not silently
attached to a book. Only locally approved write operations change data.
Existing change-log and guarded Undo remain in effect.

Because the Goodreads public API is unavailable for new general usage,
the feature relies on the Goodreads CSV the owner exports. It does not
scrape Goodreads pages or pretend to have live Goodreads account access.
