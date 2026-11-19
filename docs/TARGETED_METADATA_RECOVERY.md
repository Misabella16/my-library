# My Library: targeted missing-metadata repair (no large downloads)

Open **Imports & Undo → Repair my library** at the top of the tab.
Select **Repair my library** (or **Resume repair**). Keep the tab open while it
works. A scan alone makes no edits.

## What the single repair action does

1. Reuse the site's existing owner-only EPUB metadata repair for missing
   descriptions, subjects and embedded covers. It processes all saved EPUBs
   in bounded database batches and supports existing Undo.
2. Relink already stored, uniquely identified private cover images where
   they weren't selected for display. Ambiguous artwork is never guessed.
3. Scan the entire book catalogue with existing keyset pagination, selecting
   only entries missing descriptions or display covers.
4. Check these remaining entries against Open Library's public catalogue,
   verifying ISBN + author or exact title + author before writing anything.
   The single-request `repair-auto` route avoids looking up each book twice.
5. Fill blanks only. Never replace an owner synopsis, existing tags, private
   notes/reviews, cover or special-edition artwork. New online repairs have
   a guarded **Online repair history & Undo** control.

## Source limits and progress

This does **not** download Open Library's works, editions or author dumps.
Online repair continues through remaining missing covers and synopses in paced
batches, without an application-imposed daily book cap. Saved EPUB recovery
runs first. Compatible ISBN searches share a request, and public responses are
cached. Uncached source requests are spaced at least 1.1 seconds apart within
each Worker instance; this is not an account-wide distributed rate limiter.
Source limits and temporary errors pause the run, preserving completed work.
Open Library discourages bulk harvesting; this workflow only repairs existing
owner records with missing fields, and does not guarantee a match for every book.

The owner can **Pause** between books. The last completed book ID and
aggregate counts are saved in browser localStorage for resuming after a
refresh. The checkpoint contains no book titles, EPUBs, reviews, summaries,
or private file contents. Click **Restart scan from beginning** if the
catalogue changes and older IDs need checking, or to redo previously
unresolved items.

Leave the tab open during active work. The website does **not** automatically
run daily in the background. Resume from the same browser when ready.
If the site or source reaches a quota, completed changes remain saved;
the current unfinished book is not marked complete.

Books with ambiguous identities or unavailable descriptions are left for
review instead of being guessed or overwritten.

## Optional giant-dump workflow

The older offline bulk matcher and its export/import tools remain available
inside collapsed **Advanced tools** for people who already have the official source dumps.
They are **not required** for normal targeted repair.

Open Library developer guidance:
https://openlibrary.org/developers/api

## Faster source-friendly lookup (2026-11)

- The online repair now sends at most **four selected book IDs per request**.
  Multiple books with distinct, usable ISBNs are resolved by one
  `search.json?q=isbn:(... OR ...)` call, supported by the official Open
  Library Search API. Title-only entries use the existing individual query.
- Every returned document must still have the requested ISBN **and** the
  correct author for grouped lookups; the original per-book record is
  independently checked before a conditional D1 update.
- Public search and work responses are cached in Cloudflare's edge cache for
  1 day and 7 days respectively, where the cache API is available. Cached
  source JSON contains no My Library notes, reviews or EPUB contents.
  Cache availability is best-effort: different Cloudflare locations can miss
  independently, and evicted entries may be refetched.
- On source errors, the batch returns already completed result statuses
  without falsely advancing the browser's last-completed cursor. Previously
  applied changes remain protected by their existing Undo logs.
- There is no artificial daily book quota. The daily count is informational.
  A source throttle pauses processing; it does not advance the unfinished book.
- Multiple editions belonging to one existing book entry are already matched
  as one book; duplicate active title/author identities are constrained by the
  book database. We do not merge ambiguous works or special editions.


## Consolidated imports workspace

The tab now starts with **Repair my library**, followed by **Add books**,
**Review & Undo**, and collapsed **Advanced tools**. Goodreads uses one file
selection flow with steps for adding new books and updating existing records.
Individual EPUB, cover, catalogue-health, title and offline-snapshot tools are
kept under Advanced. Legacy partial-batch action aliases are hidden.

Saved EPUB repair and read-only inspection continue automatically through
small server pages; they no longer stop at 50 or 10,000 records. The main
repair reports each saved-file stage and its Pause control reaches those stages.
Competing panels are unavailable while the main repair is active. Inspection
already in progress must be paused or finished before starting the main repair.

Known transient database reads retry twice, after 1.5 and 4 seconds. Writes,
source limits, and daily database quotas are not automatically replayed.
Unfinished EPUBs remain at the resume cursor on database overload, and a pause
partway through the final page does not falsely mark the scan complete.
