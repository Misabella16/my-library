# My Library: targeted missing-metadata repair (no large downloads)

Open **Imports & Undo → Repair missing covers, summaries and tags**.
Select **Repair missing data (no downloads)**. Keep the tab open while it
works. A scan alone makes no edits.

## What the single repair action does

1. Reuse the site's existing owner-only EPUB metadata repair for missing
   descriptions, subjects and embedded covers. It processes all saved EPUBs
   in bounded database batches and supports existing Undo.
2. Relink already stored, uniquely identified private cover images where
   they weren't selected for display. Ambiguous artwork is never guessed.
3. Scan the entire book catalogue with existing keyset pagination, selecting
   only entries missing descriptions, tags or display covers.
4. Check these remaining entries against Open Library's public catalogue,
   verifying ISBN + author or exact title + author before writing anything.
   The single-request `repair-auto` route avoids looking up each book twice.
5. Fill blanks only. Never replace an owner synopsis, existing tags, private
   notes/reviews, cover or special-edition artwork. New online repairs have
   a guarded **Online repair history & Undo** control.

## Source limits and progress

This does **not** download Open Library's works, editions or author dumps.
The whole catalogue is scanned locally, but online checks stop after **40
book entries per UTC day**. An individual entry may require a search,
a work record and, if relevant, a cover download. The client paces requests
and the server respects 429/503 source limits. This is deliberately not a
mass API harvester and does not guarantee all missing books have matches.

The owner can **Pause** between books. The last completed book ID and
aggregate counts are saved in browser localStorage for resuming after a
refresh. The checkpoint contains no book titles, EPUBs, reviews, summaries,
or private file contents. Click **Restart scan from beginning** if the
catalogue changes and older IDs need checking, or to redo previously
unresolved items. The 40/day limit does not reset with this button.

Leave the tab open during active work. The website does **not** automatically
run daily in the background. Retry the next day from the same browser.
If the site or source reaches a quota, completed changes remain saved;
the current unfinished book is not marked complete.

Books with ambiguous identities or unavailable descriptions are left for
review instead of being guessed or overwritten.

## Optional giant-dump workflow

The older offline bulk matcher and its export/import tools remain available
below the new section for people who already have the official source dumps.
They are **not required** for normal targeted repair.

Open Library developer guidance:
https://openlibrary.org/developers/api
