# Open Library Works-only repair for My Library

This is the **smaller-download, local-first** option for repairing an existing My Library collection. It works with the website's existing Offline matching importer and Undo and does **not** require the Open Library Editions dump or copying a large database into Cloudflare.

## What this does

- Streams the monthly **Works + Authors** dumps on your Mac, comparing books by exact normalized title and verified author. Ambiguous works, uncertain identities and unchanged books are safely held for review.
- Proposes missing descriptions, subjects and work-level cover identifiers when the source actually has them.
- Preserves personal notes, reading progress, shelves, your selected covers and special editions.
- Generates a small JSON report for the existing website's authenticated **Apply ALL verified matches** action. The site imports at most eight proposed books per request and records Undo information.
- The actual local scan does **not consume Cloudflare D1 reads**. Exporting the website collection or applying changes back does consume D1 resources.

## Limitations

- **No editions or ISBN-specific covers:** Works-only matching cannot distinguish precise special editions. Keep using saved EPUB or edition tools for that.
- **Cover IDs are not images:** Open Library supplies identifiers for the Covers service. The existing offline importer links an external cover image URL only when no display cover exists. It does not download images into private R2, so those links require the provider to remain available.
- **Subjects are not authoritative genres:** The current importer conservatively proposes only missing tags and caps subject additions at eight. Personal tags are preserved.
- Some book titles or authors in your catalogue will not exactly match the Works file. They are left unchanged rather than guessed.

## 1. Export your current catalogue

In your live My Library website, open **Imports & Undo -> Advanced tools -> Offline matching** and select **Export catalogue for offline matching**. Save the resulting *my-library-catalogue.json* privately on your Mac. It includes book identities and last-change timestamps, not EPUB file bytes.

If Cloudflare is temporarily overloaded or its daily quota is exhausted, do not keep clicking repair. Export when the database is available.

## 2. Download ONLY Works and Authors

Get a recent copy of your My Library GitHub repository on your Mac. Open Terminal in the repository folder. You need Python 3.9 or newer.

The following command downloads only the Works and Authors compressed dumps, then generates the match report:

~~~sh
python3 local-mac/openlibrary_works_only.py \
  --catalogue ~/Downloads/my-library-catalogue.json \
  --download \
  --output ~/Downloads/my-library-matches.json
~~~

Default dumps live in *~/Downloads/OpenLibraryDumps/*.

**To use an external drive** instead of your internal disk:

~~~sh
python3 local-mac/openlibrary_works_only.py \
  --catalogue ~/Downloads/my-library-catalogue.json \
  --download \
  --data-dir "/Volumes/YOUR_DRIVE/OpenLibraryDumps" \
  --output ~/Downloads/my-library-matches.json
~~~

Replace YOUR_DRIVE with your mounted disk's actual name.

**If you already have Works and Authors**, reuse them without re-downloading:

~~~sh
python3 local-mac/openlibrary_works_only.py \
  --catalogue ~/Downloads/my-library-catalogue.json \
  --works "/path/to/ol_dump_works_latest.txt.gz" \
  --authors "/path/to/ol_dump_authors_latest.txt.gz" \
  --output ~/Downloads/my-library-matches.json
~~~

The script reuses finished-looking files in the chosen data folder, too. Partial downloads are kept in a .part file and retried with HTTP Range when supported. If an existing compressed dump is corrupt or incomplete, replace it with a known-good official dump before matching. The script streams gzip: it never expands the entire datasets onto your disk.

Official sources: https://openlibrary.org/developers/dumps

## 3. Match locally

It streams the compressed Works and Authors data directly, finds a verified match for each eligible existing book and writes a small *my-library-matches.json* report. It does not place the full Open Library dump in D1 and has no 40/50-book local processing ceiling.

Books with multiple verified works, uncertain authors, missing source metadata or unrecognized titles are held back. A work-level match cannot safely manufacture publisher, ISBN, exact edition or a special-edition cover.

## 4. Import verified matches to the website

Return to **Imports & Undo -> Advanced tools -> Offline matching** on the live site, choose the generated *my-library-matches.json* file, and click **Apply ALL verified matches**. It proceeds automatically in guarded batches with Pause and Undo.

The site rechecks each book's identity and last-update timestamp before writing. If D1 is temporarily unavailable, stop and resume the unfinished import when it recovers. Keep the tab open for the in-page progress cursor; it is not yet a durable server-side job queue. This importer is separate from the slower online repair.

Run Catalogue Health again afterward to see what still needs attention. Review uncertain books manually instead of accepting title-only guesses.

**Back up your production D1 and private R2 before a large synchronization.** No local matcher modifies your production database automatically.

## Covers and quota notes

Open Library's Works dumps do not include cover image files. The existing importer links a specific cover ID through the Covers service only for books that lack a cover. It does **not** bulk-download images or overwrite special-edition artwork.

Cloudflare D1 is used only to export existing site book identities and apply verified small batches. Matching the Works and Authors files locally does not consume D1 quota. If My Library and Novel Conservatory share one Cloudflare account, their D1 allowance is pooled.

The separate local My Library site also avoids production D1 for local operations, but it does not automatically contain your live EPUBs, production R2 assets, or all website book records. See the local-mac README for backups and restoration.
