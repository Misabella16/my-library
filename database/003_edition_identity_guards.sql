-- Apply ONLY to your separate My Library D1 database after the editions table exists.
-- Safe for empty or non-duplicated editions; does not delete rows.
-- If a uniqueness error appears, stop and review existing editions. Do not delete copies.

-- One record per distinct edition type, regardless of retailer for standard editions.
-- Distinct special-edition releases must have distinct names or ISBNs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_type
  ON editions (book_id, format, is_special, lower(trim(edition_name)),
    CASE WHEN is_special=1 THEN lower(trim(vendor)) ELSE '' END);
-- ISBN formatting differences (hyphens and spaces) are not separate editions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_isbn
  ON editions (book_id, upper(replace(replace(trim(isbn),'-',''),' ','')))
  WHERE isbn IS NOT NULL AND trim(isbn)<>'';
