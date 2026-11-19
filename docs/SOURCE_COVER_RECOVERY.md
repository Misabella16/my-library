# My Library: Recover missing covers and descriptions

The private **Imports & Undo** tab has a targeted "Repair missing covers,
summaries and tags" panel. It now prioritizes **covers and synopses only**
during its online pass.

## Why 3,990 scanned EPUBs might say "unchanged"

Before this fix, the saved EPUB repair primarily used the description and
cover flags cached during import. If an earlier import missed a source OPF
description, the repair could silently skip that EPUB.

The new **Recheck source EPUBs for missing descriptions & covers** button:
1. Scans saved EPUB records in small database pages.
2. Reopens a stored private EPUB only when a book is missing a description or
   a standard ebook is missing a cover and the source hash hasn't already
   been checked with the new extractor.
3. Verifies the original file SHA-256 before considering data from it.
4. Reads explicit OPF description metadata, including supported EPUB2/EPUB3
   metadata fields, and extracts unambiguous embedded cover art.
5. Fills only truly blank book descriptions or unselected/missing cover slots.
   Existing manual descriptions, tags, notes, reviews and special edition
   artwork are never overwritten.
6. Records verified negative inspection results by source file hash and
   extractor version to avoid repeatedly downloading the same EPUB from R2.
7. Reports the count of missing book descriptions, rechecked source EPUBs,
   and source EPUBs genuinely lacking a usable synopsis.

**The repair cannot invent missing book descriptions.** Where the EPUB truly
lacks a synopsis, the separate online matcher may find a trustworthy match.
Unknown/ambiguous identities are always left for review.

The broader "Repair all saved EPUBs" option is still available for tag
metadata too. The targeted one-click workflow and dedicated recheck button
do not add extra tags.

## Preferred special-edition artwork

The book grid and primary book detail cover now choose an uploaded,
**user-verified special-edition cover** before a generic ebook/regular
edition cover. An SE with a recorded owned physical copy ranks highest.
Artwork remains attached to its correct edition. No edition cover is deleted,
moved, or silently relabelled, and existing per-edition display-cover
selections stay intact. Unverified retailer/online images are **not** treated
as confirmed SE artwork.

If no verified saved SE image exists, the normal selected display cover
remains the fallback. You can continue editing an edition and selecting
its own cover normally.

## Low-cost behavior and Undo

- Owner-only API; no public/private EPUBs exposed to other visitors.
- Keyset pagination, small per-request R2 reads, verified negative-source
  markers, and only missing-field repairs.
- Existing EPUB repair history and Undo guards protect subsequent edits.
- The new online passes skip tag-only entries and keep source-friendly
  limits and existing progress/Undo behavior.
- The huge Open Library dumps remain optional and are **not** necessary.
