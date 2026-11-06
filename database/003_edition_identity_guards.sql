-- Only use against the standalone My Library D1 database.
-- One record for each distinct edition type under a book.
-- These constraints do not touch copies, cover files or notes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_type
ON editions (
  book_id,
  format,
  is_special,
  CASE WHEN lower(replace(replace(replace(replace(replace(trim(edition_name),' ',''),'-',''),'_',''),'.',''),'/',''))
        IN ('standard','standardedition','regular','regularedition')
       THEN 'standard'
       ELSE lower(replace(replace(replace(replace(replace(trim(edition_name),' ',''),'-',''),'_',''),'.',''),'/',''))
  END,
  CASE WHEN is_special=1
       THEN lower(replace(replace(replace(replace(trim(vendor),' ',''),'-',''),'_',''),'.',''))
       ELSE '' END
);
-- Ignore superficial ISBN formatting; blank ISBNs aren't unique identifiers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_editions_unique_isbn
ON editions (book_id, upper(replace(replace(trim(isbn),'-',''),' ','')))
WHERE isbn IS NOT NULL AND trim(isbn)<>'';
