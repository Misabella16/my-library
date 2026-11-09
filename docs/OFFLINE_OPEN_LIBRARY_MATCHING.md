# Entire-library offline Open Library matching

Open Library's regular API is not intended for thousands of lookups. Its
monthly downloadable catalogue is the right source for bulk matching.

## 1. Export from My Library

Open **Imports & Undo → Entire Library → Offline Metadata Matching**, then
select **Export my full library catalogue (JSON)**. Save the file in Downloads
as `my-library-catalogue.json`.

This contains book IDs, titles, authors, edition ISBNs, missing-field flags and
concurrency timestamps. It does not contain EPUBs, reviews, notes, or ebooks.

## 2. Match on your Mac

Save the source file `local-mac/openlibrary_dump_match.py` from this GitHub
repository into your Mac's Downloads folder. Python 3.9+ is required, without
third-party packages.

To automatically download the editions, works and authors compressed dumps
(around 13 GB combined, subject to change) and match your collection:

```bash
python3 "$HOME/Downloads/openlibrary_dump_match.py" \
  --catalogue "$HOME/Downloads/my-library-catalogue.json" \
  --download \
  --data-dir "$HOME/Downloads/OpenLibraryDumps" \
  --output "$HOME/Downloads/my-library-matches.json"
```

For another drive, change the `--data-dir` path. Prefer not to use your
actively indexing Fanfic Annex drive. At least 16 GB free is required for the
initial compressed downloads. They can take substantial time, but the matcher
streams them without creating uncompressed copies. It does not query external
sites during matching.

If the compressed files are already downloaded, omit `--download` and use
`--editions /path/editions.txt.gz --works /path/works.txt.gz --authors
/path/authors.txt.gz` instead.

Official dumps: https://openlibrary.org/developers/dumps

## 3. Repair all verified books

Back on My Library, choose `my-library-matches.json` and press **Apply ALL
verified matches**. This runs through the entire report with small internal
database transactions automatically, not 12 manual confirmations at a time.

There are Pause and Resume controls. Keep the same browser tab open; if
Cloudflare hits its database quota, successful batches remain saved.

Server-side checks confirm the book ID, timestamp, author and either a title
or ISBN match. A failure becomes a review item, never an overwrite.

## Covers, Undo and privacy

- Existing nonblank synopses, personal tags, manually selected covers,
  collector editions, copies, notes and reviews are never overwritten.
- Source-provided cover IDs are displayed via Open Library's public cover
  URLs as each book is viewed, instead of making thousands of mass image
  downloads. These source images may be missing or unavailable.
- Each applied repair is logged with guarded Undo.
- Books without trustworthy matches or usable source metadata remain in
  the review/unmatched report. The process cannot invent missing synopses.
- The bulk matching file never leaves your Mac until you explicitly upload
  match proposals to your own authenticated My Library site.

Open Library's policies recommend bulk data dumps:
https://openlibrary.org/developers/api

Open Library's cover guidelines recommend on-demand image linking and
discourage bulk cover API crawling:
https://openlibrary.org/dev/docs/api/covers
