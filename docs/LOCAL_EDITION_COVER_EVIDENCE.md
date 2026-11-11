# Local-first edition and cover evidence (no ISBN required)

Use this tool for books that don't have an ISBN in My Library. It is a careful
**book-level** recovery workflow, not a claim that a Calibre image proves the
precise publisher or collector edition.

## How to use

Open private My Library → Imports & Undo → Advanced tools →
**Local Calibre & EPUB edition evidence (without ISBN)**.

1. Select your **Calibre library root folder** (contains metadata.opf and
   cover.jpg files), or select a Calibre CSV/JSON export. The folder is read
   locally by your browser; nothing is bulk-uploaded.
2. Select **Read local Calibre metadata**. Calibre folder selection supports
   large local catalogues without re-downloading Open Library databases.
3. Search a title or author already in My Library and open its result. The
   site retrieves only this book's existing editions and linked EPUB metadata.
4. The screen displays stored EPUB identifiers and extracted-cover flags.
   Your actual EPUB file is not downloaded or resent.
5. Book-level title and author matches in your local Calibre library appear
   below. Local cover files are available only if you selected the actual
   Calibre folder, not a CSV or JSON export.
6. When a local record has a unique cover file, select its cover, review
   the image and **choose an existing standard ebook edition that has no
   attached cover**.
7. Tick the owner confirmation and choose **Approve and attach this local
   cover**. The cover is copied to private storage, linked to that existing
   ebook edition and labeled **possible, edition unverified**.
8. Check **Local cover history & Undo** for saved repairs. Undo refuses to
   erase any cover that was later edited or manually verified.

## Safety and scope

- No new book, edition, owned copy or fake Online display edition is created.
- No collector editions (FairyLoot, Illumicrate, OwlCrate, signed or special)
  receive local covers through this tool.
- No existing cover files or display choices are overwritten.
- No owner notes, reviews, book synopsis, shelves, ratings or EPUB files change.
- No remote Editions or Covers dumps are downloaded.
- Only your chosen cover bytes are uploaded, after an explicit approval.
- A title and author match is necessary, but not enough to establish a
  precise edition. Sources without ISBNs remain *provisional* and a separate
  ISBN/publisher/manual verification is needed for an exact edition claim.
- If your Calibre folder lacks a usable cover or your book has no eligible
  standard ebook, the workflow stays read-only.
- This is an owner-initiated one-book-at-a-time workflow, minimizing Cloudflare
  D1 reads rather than scanning all 15,000 books repeatedly.
- If a save reports Load failed, inspect Local cover history before retrying
  to avoid uncertain duplicate operations.

## Existing workflows retained

The previous **Edition & Cover Recovery (Open Library, exact ISBN only)**
remains available for edition-specific publisher and Open Library artwork.
The **Compare or import from Calibre** tool remains available for your
existing full-library comparison, metadata repair and import workflows.

The distinction is deliberate: local EPUB and Calibre content supplies a
book-level identity and real local cover, whereas exact Open Library edition
ISBN evidence can establish a particular published edition.
