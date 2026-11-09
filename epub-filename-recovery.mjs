import {cleanEpubTitle,machineTitleReason} from './epub-metadata.mjs';
/** Human-readable candidate from a private EPUB's ORIGINAL filename.
 * The EPUB must already be linked by its file ID to the exact saved book.
 * No author is inferred, and no titles are copied from other books.
 */
export function filenameTitleCandidate(value){
 if(typeof value!=='string'||value.length>600||!/\.epub$/i.test(value))return '';
 const base=value.replace(/.*[\\/]/,'');
 const candidate=cleanEpubTitle(base);
 if(!candidate||candidate.length<4||candidate.length>240||machineTitleReason(candidate))
  return '';
 // Do not turn empty download stamps, numeric IDs, ZIP release codes,
 // generic content names, or uninformative one-word files into titles.
 if(/^(?:book|ebook|novel|untitled|unknown|download|document|file|chapter|cover|content|epub|text)(?:\s*[-_]?\d+)?$/i.test(candidate))
  return '';
 if(/^(?:\d[\w -]*|[a-f0-9]{12,})$/i.test(candidate))return '';
 if(!/[\p{L}]{3}/u.test(candidate)||!/[\p{L}]/u.test(candidate))return '';
 if(candidate.split(/\s+/).length<2)return '';
 if(/^(?:[\w -]+)\s*\((?:z-library|z-lib|libgen|unknown author)\)/i.test(candidate))
  return '';
 return candidate;
}
