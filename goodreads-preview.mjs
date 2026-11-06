// Local-only Goodreads export inspection. No network requests and no database writes.
// Every row stays in browser memory; the UI never renders CSV content as HTML.
export const MAX_GOODREADS_BYTES = 15 * 1024 * 1024;
export const MAX_GOODREADS_ROWS = 50000;

function parseCsv(text, maxRows = MAX_GOODREADS_ROWS) {
  if (typeof text !== 'string' || !text.trim()) throw Error('Choose a nonempty Goodreads CSV export.');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  const endField = () => { row.push(field); field = ''; afterQuote = false; };
  const endRow = () => {
    endField();
    if (row.some(value => value.trim() !== '')) {
      rows.push(row);
      if (rows.length > maxRows + 1) throw Error('This export has more than 50,000 rows. Split it into smaller CSV files.');
    }
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; afterQuote = true; }
      else field += ch;
      continue;
    }
    if (ch === ',' || ch === '\n' || ch === '\r') {
      if (ch === ',') endField();
      else {
        endRow();
        if (ch === '\r' && source[i + 1] === '\n') i++;
      }
    } else if (ch === '"' && field === '' && !afterQuote) {
      quoted = true;
    } else if ((ch === '"' && field !== '') || (afterQuote && ch.trim() !== '')) {
      throw Error('Malformed CSV quoting near row ' + (rows.length + 1) + '.');
    } else if (!afterQuote) field += ch;
  }
  if (quoted) throw Error('Unclosed quoted field in CSV export.');
  if (row.length || field !== '' || afterQuote) endRow();
  return rows;
}

const clean = value => String(value ?? '').trim();
const heading = value => clean(value).toLowerCase().replace(/\s+/g, ' ');
const normalize = value => clean(value).normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const safeISBN = value => clean(value).replace(/^="(.*)"$/, '$1');
const numericRating = value => {
  const raw = clean(value);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : null;
};

export function parseGoodreadsExport(text) {
  if (new TextEncoder().encode(text).byteLength > MAX_GOODREADS_BYTES)
    throw Error('This file exceeds the 15 MB local-preview limit.');
  const all = parseCsv(text);
  if (!all.length) throw Error('The CSV does not contain a header row.');
  const headers = all.shift().map(heading);
  if (new Set(headers).size !== headers.length) throw Error('The CSV has duplicate column headers.');
  if (!headers.includes('title') || !headers.includes('author') ||
      !['book id','exclusive shelf','bookshelves'].some(name => headers.includes(name)))
    throw Error('Choose a Goodreads library CSV export with Title, Author, and Goodreads shelf or book ID columns.');
  const get = (cells, field) => clean(cells[headers.indexOf(field)] ?? '');
  const entries = [];
  const warnings = [];
  for (const [index, cells] of all.entries()) {
    if (cells.length !== headers.length) {
      warnings.push('Skipped malformed column count on CSV row ' + (index + 2) + '.');
      continue;
    }
    const title = get(cells, 'title'), author = get(cells, 'author');
    if (!title) {
      warnings.push('Skipped missing title on CSV row ' + (index + 2) + '.');
      continue;
    }
    const shelves = new Set();
    for (const field of [get(cells, 'exclusive shelf'), get(cells, 'bookshelves')]) {
      field.split(',').map(clean).filter(Boolean).forEach(x => shelves.add(x));
    }
    entries.push({
      rowNumber: index + 2,
      goodreadsId: get(cells, 'book id'),
      title, author,
      isbn: safeISBN(get(cells, 'isbn')),
      isbn13: safeISBN(get(cells, 'isbn13')),
      myRating: numericRating(get(cells, 'my rating')),
      exclusiveShelf: get(cells, 'exclusive shelf'),
      shelves: [...shelves],
      review: get(cells, 'my review'),
      dateRead: get(cells, 'date read'),
      dateAdded: get(cells, 'date added')
    });
  }
  if (!entries.length) throw Error('No valid titled books were found in this CSV.');
  return {entries, warnings, headers, sourceCount: all.length};
}

export function matchGoodreadsRows(entries, existingBooks, {complete = true} = {}) {
  const identities = new Map(), titles = new Map(), existingGoodreadsIds = new Map(),
    csvIdentities = new Map(), csvGoodreadsIds = new Map();
  // Mark every conflicting CSV row for review, including the first occurrence.
  for (const entry of entries) {
    const identity = normalize(entry.title) + '\0' + normalize(entry.author);
    csvIdentities.set(identity, (csvIdentities.get(identity) || 0) + 1);
    if (entry.goodreadsId)
      csvGoodreadsIds.set(entry.goodreadsId, (csvGoodreadsIds.get(entry.goodreadsId) || 0) + 1);
  }
  for (const book of existingBooks) {
    const title = normalize(book.title);
    const key = title + '\0' + normalize(book.author);
    if(book.goodreads_id){
      const id=String(book.goodreads_id).trim();
      if(!existingGoodreadsIds.has(id))existingGoodreadsIds.set(id,[]);
      existingGoodreadsIds.get(id).push(book);
    }
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(book);
    if (!titles.has(title)) titles.set(title, []);
    titles.get(title).push(book);
  }
  const results = entries.map(entry => {
    const title = normalize(entry.title), author = normalize(entry.author);
    const identity = title + '\0' + author;
    const repeated = csvIdentities.get(identity) > 1 ||
      Boolean(entry.goodreadsId && csvGoodreadsIds.get(entry.goodreadsId) > 1);
    const exact = author && title ? (identities.get(identity) || []) : [];
    const idMatches = entry.goodreadsId ? (existingGoodreadsIds.get(entry.goodreadsId) || []) : [];
    const titleMatches = titles.get(title) || [];
    let matchStatus, matchReason, existingBookId = null;
    if (repeated) {
      // Goodreads exports can include different editions sharing the same identity.
      matchStatus = 'review';
      matchReason = 'repeated_csv_identity';
    } else if (idMatches.length===1) {
      matchStatus = 'existing';
      matchReason = 'goodreads_id_match';
      existingBookId = idMatches[0].id;
    } else if(idMatches.length>1) {
      matchStatus = 'review';
      matchReason = 'ambiguous_library_identity';
    } else if (!title || !author) {
      matchStatus = 'review';
      matchReason = 'missing_author_or_title';
    } else if (exact.length === 1) {
      matchStatus = 'existing';
      matchReason = 'already_in_library';
      existingBookId = exact[0].id;
    } else if (exact.length > 1) {
      matchStatus = 'review';
      matchReason = 'ambiguous_library_identity';
    } else if (titleMatches.length) {
      matchStatus = 'review';
      matchReason = 'title_author_conflict';
    } else {
      matchStatus = complete ? 'new' : 'unverified';
      matchReason = complete ? 'safe_to_import' : 'incomplete_catalogue_scan';
    }
    return {...entry, matchStatus, matchReason, existingBookId, repeatedCsvIdentity: repeated};
  });
  const counts = {existing:0, review:0, new:0, unverified:0, repeatedCsv:0};
  for (const entry of results) {
    counts[entry.matchStatus]++;
    if (entry.repeatedCsvIdentity) counts.repeatedCsv++;
  }
  return {results, counts, complete};
}
