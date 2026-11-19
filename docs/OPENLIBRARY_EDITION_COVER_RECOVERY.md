# Edition & Cover Recovery (owner-reviewed)

This optional My Library tool investigates Open Library editions of a book
after its Work identity has been matched.

Open Library distinguishes Works from Editions. An edition can have ISBNs,
publishers, publication dates and cover IDs, but its existence does not mean
you own it or that it matches a collector's edition.

## Start with the saved first-pass Works report

On the protected My Library site, go to:

Imports & Undo → Advanced tools → Edition & Cover Recovery

1. Select the existing first-pass my-library-matches-works.json created by
   openlibrary_works_only.py. It contains verified Work references.
2. Type a book title or author to find that entry. Select a book.
3. The site queries official Open Library Work and Editions APIs on demand.
   Only up to 25 source editions are listed per page. Use Next 25 if needed.
4. Compare source edition title, publication year, publisher and cover.
   The site distinguishes research candidates from exact ISBN-13 matches
   to existing standard editions in My Library.
5. For an exact match with missing data, choose Preview missing edition
   details, inspect the proposed publisher and cover, tick approval and Apply.
6. See Edition recovery history & Undo for saved changes. Undo blocks edits
   that would overwrite changes made later by the owner.

## What this operation never does

- Never downloads the full Editions or historical Covers dump.
- Never creates a fake Online display edition or a new owned copy.
- Never attaches work-level generic artwork to a special edition.
- Never replaces any artwork already attached to the edition.
- Never overwrites an existing publisher.
- Never modifies ratings, private notes, reviews, physical locations or EPUBs.
- Never assumes similar titles alone prove edition identity.

Books without an existing edition or valid ISBN can still be researched.
They remain candidates for manual verification and the site's existing
Add Edition form; no new ownership is inferred.

Only exact ISBN-13 matches to an existing non-special edition can qualify
for missing-field recovery, with an explicit preview and owner approval.
Other editions can be verified manually against copyright pages, Calibre
metadata, publisher catalogues and the original vendor's special edition.

## API and safeguards

- Protected routes: /api/edition-recovery/research,
  /api/edition-recovery/preview, /api/edition-recovery/apply,
  /api/edition-recovery/history and /api/edition-recovery/undo.
- Source Work title and edition-to-work link are verified against official
  Open Library JSON. ISBN-13, current edition timestamp and existing
  artwork are rechecked on preview and apply.
- Work-level cover images cannot authorize attaching edition-level artwork.
  Source edition cover candidates are marked possible, not user_verified.
- Bounded owner-triggered source calls with per-session browser caching
  rather than high-volume bulk harvesting.
- Guarded database changes are recorded for Undo.

## References

https://openlibrary.org/dev/docs/api/books
https://openlibrary.org/developers/api
https://openlibrary.org/dev/docs/api/covers
