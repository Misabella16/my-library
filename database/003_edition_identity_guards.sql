-- Stop concurrent imports creating the same active work twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_active_identity
ON books(normalized_title,normalized_author) WHERE archived_at IS NULL;

-- Only use against the standalone My Library D1 database.
-- One record for each distinct edition type under a book.
-- These constraints do not touch copies, cover files or notes.
-- Separate partial indexes keep edition identity rules readable and easy to
-- apply in the Cloudflare D1 Console one statement at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_standard
ON editions (
  book_id,
  format,
  CASE WHEN lower(replace(replace(trim(edition_name), ' ', ''), '-', ''))
    IN ('standard', 'standardedition', 'regular', 'regularedition')
  THEN 'standard'
  ELSE lower(replace(replace(trim(edition_name), ' ', ''), '-', '')) END
)
WHERE is_special = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_special
ON editions (
  book_id,
  format,
  lower(replace(replace(trim(edition_name), ' ', ''), '-', '')),
  lower(replace(replace(trim(vendor), ' ', ''), '-', ''))
)
WHERE is_special = 1;
-- Ignore superficial ISBN formatting; blank ISBNs aren't unique identifiers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_isbn
ON editions (book_id, upper(replace(replace(trim(isbn),'-',''),' ','')))
WHERE isbn IS NOT NULL AND trim(isbn)<>'';
