import {cleanEpubTitle,cleanEpubAuthor,normalizeEpubTitle} from './epub-metadata.mjs';
import {extractIsbn13} from './epub-isbn.mjs';
// Owner-only private EPUB intake. The enclosing Worker already verifies Access
// and write origin. One file per request keeps D1/R2 usage predictable.
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers});
const bad=(message,status=400)=>json({error:message},status);
const run=(db,sql,args=[])=>db.prepare(sql).bind(...args).run();
const one=(db,sql,args=[])=>db.prepare(sql).bind(...args).first();
const many=async(db,sql,args=[])=>((await db.prepare(sql).bind(...args).all()).results||[]);
const MAX_FILE=24*1024*1024, MAX_COVER=5*1024*1024;
export const normalizeEpubText=value=>String(value||'').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const clean=(s,max)=>typeof s==='string'?s.trim().slice(0,max):'';
const uuid=()=>crypto.randomUUID();
const byteHex=bytes=>[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
const jpg=b=>b[0]===255&&b[1]===216&&b[2]===255;
const png=b=>b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v);
const webp=b=>b.length>=12&&new TextDecoder().decode(b.subarray(0,4))==='RIFF'&&
  new TextDecoder().decode(b.subarray(8,12))==='WEBP';
const coverType=b=>jpg(b)?'image/jpeg':png(b)?'image/png':webp(b)?'image/webp':null;
export async function matchEpub(db,{title,author,sha256,identifier}){
  if(sha256){
    const duplicate=await one(db,
      'SELECT id,book_id,edition_id,original_filename FROM epub_files WHERE sha256=?',[sha256]);
    if(duplicate)return {status:'already_uploaded',existing:duplicate};
  }
  const normalizedTitle=normalizeEpubTitle(title),normalizedAuthor=normalizeEpubText(author);
  const isbn=extractIsbn13(identifier);
  if(isbn&&normalizedAuthor){
    const byIsbn=await many(db,'SELECT DISTINCT b.id,b.title,b.author FROM editions e JOIN books b ON b.id=e.book_id WHERE e.isbn=? AND b.archived_at IS NULL LIMIT 3',[isbn]);
    if(byIsbn.length>1)return {status:'needs_review',reason:'ISBN points to multiple different books'};
    if(byIsbn.length===1){
      if(normalizeEpubText(byIsbn[0].author)!==normalizedAuthor)
        return {status:'needs_review',reason:'ISBN matches a book with a different author'};
      return {status:'match',book_id:byIsbn[0].id,matched_title:byIsbn[0].title,matched_author:byIsbn[0].author,reason:'Exact ISBN-13 and author match'};
    }
  }
  if(!normalizedTitle||!normalizedAuthor)
    return {status:'needs_review',reason:'EPUB title or author is missing'};
  // Only auto-match when original EPUB metadata confirms both title and
  // author. Filename-only fallbacks remain in manual review.
  // Use indexed active identity, plus a conservative same-title check.
  const same=await many(db,
    'SELECT id,title,author FROM books WHERE archived_at IS NULL AND normalized_title=? LIMIT 101',
    [normalizedTitle]);
  if(same.length>=101)return {status:'needs_review',reason:'Too many books have this title'};
  const exact=same.filter(b=>normalizeEpubText(b.author)===normalizedAuthor);
  if(exact.length===1)return {status:'match',book_id:exact[0].id,matched_title:exact[0].title,matched_author:exact[0].author};
  if(exact.length>1)return {status:'needs_review',reason:'Multiple books match this title and author'};
  if(same.length)return {status:'needs_review',reason:'Title exists with a different author'};
  const aliases=await many(db,
    'SELECT b.id,b.title,b.author FROM book_aliases a JOIN books b ON b.id=a.book_id '+
    'WHERE b.archived_at IS NULL AND a.normalized_alias=? LIMIT 101',[normalizedTitle]);
  if(aliases.length>=101)return {status:'needs_review',reason:'Too many alternate titles match'};
  const aliasExact=aliases.filter(b=>normalizeEpubText(b.author)===normalizedAuthor);
  if(aliasExact.length===1)return {status:'match',book_id:aliasExact[0].id,matched_title:aliasExact[0].title,matched_author:aliasExact[0].author,reason:'Existing alternate title and author'};
  if(aliases.length)return {status:'needs_review',reason:'Alternate title matches require review'};
  // Old books occasionally used ASCII-only normalization. An indexed fallback
  // checks only the old title key, never scans the entire catalogue.
  const legacy=String(title).normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  if(legacy!==normalizedTitle){
    const old=await many(db,
      'SELECT id,title,author FROM books WHERE archived_at IS NULL AND normalized_title=? LIMIT 101',
      [legacy]);
    if(old.length>=101)return {status:'needs_review',reason:'Ambiguous older title normalization'};
    const sameLegacy=old.filter(b=>normalizeEpubText(b.title)===normalizedTitle);
    const exactLegacy=sameLegacy.filter(b=>normalizeEpubText(b.author)===normalizedAuthor);
    if(exactLegacy.length===1)return {status:'match',book_id:exactLegacy[0].id,matched_title:exactLegacy[0].title,matched_author:exactLegacy[0].author};
    if(sameLegacy.length)return {status:'needs_review',reason:'Existing book may be a match'};
  }
  return {status:'new'};
}
export async function batchPreviewEpub(db,items){
  if(!Array.isArray(items)||items.length<1||items.length>50)
    throw Error('Preview 1 to 50 EPUBs at a time');
  const inputs=items.map(item=>({
    title:cleanEpubTitle(item?.title),author:cleanEpubAuthor(item?.author),
    sha256:String(item?.sha256||''),identifier:clean(item?.identifier,250)
  }));
  if(inputs.some(x=>!/^[a-f0-9]{64}$/.test(x.sha256)))
    throw Error('One or more EPUB hashes are invalid');
  const values=a=>a.map(()=>'?').join(',');
  const hashes=[...new Set(inputs.map(i=>i.sha256))];
  const existing=await many(db,
    'SELECT id,sha256,book_id,edition_id,original_filename FROM epub_files WHERE sha256 IN ('+
    values(hashes)+')',hashes);
  const hashIndex=new Map(existing.map(row=>[row.sha256,row]));
  // Entire batches of already-imported EPUBs need exactly one indexed
  // hash lookup, not title, alias, ISBN and legacy catalogue reads.
  if(inputs.every(item=>hashIndex.has(item.sha256)))
    return inputs.map(item=>({
      status:'already_uploaded',existing:hashIndex.get(item.sha256)
    }));
  const titleKeys=[...new Set(inputs.map(i=>normalizeEpubTitle(i.title)).filter(Boolean))];
  const books=titleKeys.length?await many(db,
    'SELECT id,title,author,normalized_title FROM books WHERE archived_at IS NULL AND normalized_title IN ('+
    values(titleKeys)+') LIMIT 5051',titleKeys):[];
  const groups=new Map();
  for(const b of books){
    if(!groups.has(b.normalized_title))groups.set(b.normalized_title,[]);
    groups.get(b.normalized_title).push(b);
  }
  const aliasBooks=titleKeys.length?await many(db,
    'SELECT a.normalized_alias,b.id,b.title,b.author FROM book_aliases a '+
    'JOIN books b ON b.id=a.book_id WHERE b.archived_at IS NULL AND a.normalized_alias IN ('+
    values(titleKeys)+') LIMIT 5051',titleKeys):[];
  const aliasIndex=new Map();
  for(const b of aliasBooks){
    if(!aliasIndex.has(b.normalized_alias))aliasIndex.set(b.normalized_alias,[]);
    aliasIndex.get(b.normalized_alias).push(b);
  }
  const aliasTruncated=aliasBooks.length>=5051;
  const truncated=books.length>=5051;
  const isbns=[...new Set(inputs.map(i=>extractIsbn13(i.identifier)).filter(Boolean))];
  const isbnMatches=isbns.length?await many(db,
    'SELECT DISTINCT e.isbn,b.id,b.title,b.author FROM editions e JOIN books b ON b.id=e.book_id '+
    'WHERE b.archived_at IS NULL AND e.isbn IN ('+values(isbns)+') LIMIT 151',isbns):[];
  const isbnIndex=new Map();
  for(const row of isbnMatches){
    if(!isbnIndex.has(row.isbn))isbnIndex.set(row.isbn,[]);
    if(!isbnIndex.get(row.isbn).some(x=>x.id===row.id))isbnIndex.get(row.isbn).push(row);
  }
  const isbnTruncated=isbnMatches.length>=151;
  // A bounded second lookup handles older ASCII-only title normalization.
  const legacyNormalize=value=>String(value||'').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  const legacyKeys=[...new Set(inputs.map(item=>legacyNormalize(item.title))
    .filter((key,i)=>key!==normalizeEpubTitle(inputs[i].title)))];
  const oldBooks=legacyKeys.length?await many(db,
    'SELECT id,title,author,normalized_title FROM books WHERE archived_at IS NULL AND normalized_title IN ('+
    values(legacyKeys)+') LIMIT 5051',legacyKeys):[];
  const oldGroups=new Map();
  for(const b of oldBooks){
    if(!oldGroups.has(b.normalized_title))oldGroups.set(b.normalized_title,[]);
    oldGroups.get(b.normalized_title).push(b);
  }
  const legacyTruncated=oldBooks.length>=5051;
  const outcomes=inputs.map(item=>{
    const hash=hashIndex.get(item.sha256);
    if(hash)return {status:'already_uploaded',existing:hash};
    const title=normalizeEpubTitle(item.title),author=normalizeEpubText(item.author);
    if(!title||!author)return {status:'needs_review',reason:'EPUB title or author is missing'};
    const isbn=extractIsbn13(item.identifier);
    if(isbn){
      if(isbnTruncated)return {status:'needs_review',reason:'ISBN matches need individual review'};
      const byIsbn=isbnIndex.get(isbn)||[];
      if(byIsbn.length>1)return {status:'needs_review',reason:'ISBN points to multiple different books'};
      if(byIsbn.length===1){
        if(normalizeEpubText(byIsbn[0].author)!==author)
          return {status:'needs_review',reason:'ISBN matches a book with a different author'};
        return {status:'match',book_id:byIsbn[0].id,matched_title:byIsbn[0].title,matched_author:byIsbn[0].author,reason:'Exact ISBN-13 and author match'};
      }
    }
    if(truncated)return {status:'needs_review',reason:'Catalogue match requires individual review'};
    const group=groups.get(title)||[];
    if(group.length>=101)return {status:'needs_review',reason:'Too many existing books match this title'};
    const exact=group.filter(b=>normalizeEpubText(b.author)===author&&
      normalizeEpubTitle(b.title)===title);
    if(exact.length===1)return {status:'match',book_id:exact[0].id,matched_title:exact[0].title,matched_author:exact[0].author};
    if(exact.length||group.length)return {status:'needs_review',reason:'Same title has a conflicting or ambiguous author'};
    if(aliasTruncated)return {status:'needs_review',reason:'Alternate title matching needs individual review'};
    const aliasGroup=aliasIndex.get(title)||[];
    const aliasExact=aliasGroup.filter(b=>normalizeEpubText(b.author)===author);
    if(aliasExact.length===1)return {status:'match',book_id:aliasExact[0].id,matched_title:aliasExact[0].title,matched_author:aliasExact[0].author,reason:'Existing alternate title and author'};
    if(aliasGroup.length)return {status:'needs_review',reason:'Alternate title has ambiguous or conflicting authors'};
    // Unicode entries can be confidently previewed after the second
    // indexed check; a true old-title collision still needs manual review.
    const legacy=legacyNormalize(item.title);
    if(legacy!==title){
      if(legacyTruncated)return {status:'needs_review',reason:'Legacy title matches are ambiguous'};
      const old=(oldGroups.get(legacy)||[]).filter(b=>normalizeEpubTitle(b.title)===title);
      const exactOld=old.filter(b=>normalizeEpubText(b.author)===author);
      if(exactOld.length===1)return {status:'match',book_id:exactOld[0].id,matched_title:exactOld[0].title,matched_author:exactOld[0].author};
      if(old.length)return {status:'needs_review',reason:'Ambiguous older title normalization'};
    }
    return {status:'new'};
  });
  return outcomes;
}
// Shared commit path for small multipart-form and large staged R2 uploads.
// No duplicates, physical copies, or special-edition cover overwrites.
export async function commitStoredEpub(db,env,{fileName,metadata,actual,coverBytes=null,ctype=null,
 bytes=null,storedKey=null,storedFileId=null}){
 const title=cleanEpubTitle(metadata.title),author=cleanEpubAuthor(metadata.author);
 const subjectList=Array.isArray(metadata.subjects)?metadata.subjects.slice(0,8):[];
 if(subjectList.some(tag=>typeof tag!=='string'||!tag.trim()||tag.trim().length>90))
  return bad('Invalid EPUB subject tags');
 const subjects=[...new Map(subjectList.map(tag=>[tag.trim().toLocaleLowerCase(),tag.trim()])).values()];
    const matched=await matchEpub(db,{title,author,sha256:actual,identifier:metadata.identifier});
    if(matched.status==='already_uploaded')return json({...matched,uploaded:false});
    if(matched.status==='needs_review')return json(matched,409);
    const desiredId=clean(metadata.book_id,40);
    if(desiredId && (matched.status!=='match'||matched.book_id!==desiredId))
      return bad('The target book changed since preview. Re-preview this EPUB.',409);
    if(matched.status==='new' && !normalizeEpubText(title))return bad('Title is required');
    const bookId=matched.status==='match'?matched.book_id:uuid();
    // A unique R2 key per attempted import prevents failed concurrent requests
    // from deleting a successful import's file when cleanup runs.
    const fileId=storedFileId||uuid();
    const key=storedKey||'epubs/'+actual.slice(0,2)+'/'+fileId+'.epub';
    const coverId=coverBytes?uuid():null;
    const coverKey=coverBytes?'epub-covers/'+actual.slice(0,2)+'/'+actual+'-'+coverId+
      (ctype==='image/png'?'.png':ctype==='image/webp'?'.webp':'.jpg'):null;
    const uploaded=[];
    try{
      // R2 blobs are saved before the atomic SQL batch. If SQL rejects the
      // file for any reason, the newly written blobs are removed.
      if(bytes)await env.BOOK_FILES.put(key,bytes,{httpMetadata:{contentType:'application/epub+zip'}});
      uploaded.push(key);
      if(coverBytes){
        await env.BOOK_FILES.put(coverKey,coverBytes,{httpMetadata:{contentType:ctype}});
        uploaded.push(coverKey);
      }
      const ts=new Date().toISOString(),editionId=uuid(),batchId=uuid();
      const statements=[];
      if(matched.status==='new'){
        statements.push(db.prepare(
          'INSERT INTO books (id,title,author,normalized_title,normalized_author,synopsis,created_at,updated_at) '+
          'VALUES (?,?,?,?,?,?,?,?)'
        ).bind(bookId,title,author,normalizeEpubText(title),normalizeEpubText(author),
          clean(metadata.description,3000),ts,ts));
      }
      // Fill only truly missing synopsis text. The WHERE guard runs inside
      // the same transaction as the EPUB record, so concurrent manual edits
      // always win. This never replaces an existing Goodreads or user synopsis.
      const epubSynopsis=clean(metadata.description,3000);
      if(matched.status==='match'&&epubSynopsis){
        statements.push(db.prepare(
          "UPDATE books SET synopsis=?,updated_at=? WHERE id=? AND archived_at IS NULL AND trim(synopsis)=''"
        ).bind(epubSynopsis,ts,bookId));
      }
      // Only use explicit EPUB OPF subjects. Tags are added, never removed
      // or fabricated, and a successful import's book record remains intact.
      for(const subject of subjects){
        const tagId=uuid();
        statements.push(db.prepare(
          "INSERT OR IGNORE INTO tags(id,label,kind) VALUES (?,?,'imported')"
        ).bind(tagId,subject));
        statements.push(db.prepare(
          "INSERT OR IGNORE INTO book_tags(book_id,tag_id,source) "+
          "SELECT ?,id,'epub' FROM tags WHERE label=? COLLATE NOCASE"
        ).bind(bookId,subject));
      }
      // Never attach EPUB artwork to special or physical editions.
      const ebook=await one(db,
        "SELECT id FROM editions WHERE book_id=? AND format='ebook' AND is_special=0 ORDER BY created_at LIMIT 1",
        [bookId]);
      const targetEdition=ebook?.id||editionId;
      if(!ebook){
        statements.push(db.prepare(
          "INSERT INTO editions(id,book_id,edition_name,format,is_special,created_at,updated_at) "+
          "VALUES (?,?,'Standard','ebook',0,?,?)"
        ).bind(editionId,bookId,ts,ts));
      }
      const titleSafe=clean(fileName,500);
      statements.push(db.prepare(
        'INSERT INTO import_batches(id,source,status,report,created_at) VALUES '+
        "(?,'epub','complete',?,?)"
      ).bind(batchId,JSON.stringify({created:matched.status==='new'?1:0,uploaded:1}),ts));
      statements.push(db.prepare(
        'INSERT INTO epub_files(id,sha256,original_filename,cleaned_title,private_object_key,metadata_json,'+
        'book_id,edition_id,batch_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).bind(fileId,actual,titleSafe,normalizeEpubText(title),key,JSON.stringify({
        title,author,description:clean(metadata.description,3000),
        identifier:clean(metadata.identifier,250),subjects,cover_extracted:!!coverBytes
      }),bookId,targetEdition,batchId,ts));
      if(coverBytes){
        const existing=ebook?await one(db,
          'SELECT id FROM edition_images WHERE edition_id=? AND display_cover=1',[targetEdition]):null;
        statements.push(db.prepare(
          'INSERT INTO edition_images(id,edition_id,origin,private_object_key,role,match_status,display_cover) '+
          'VALUES (?,?,'+"'epub'"+',?,'+"'cover'"+','+"'unverified'"+',?)'
        ).bind(coverId,targetEdition,coverKey,existing?0:1));
      }
      statements.push(db.prepare(
        'INSERT INTO change_log(id,batch_id,action,entity_type,entity_id,after_json,created_at) '+
        "VALUES (?,?,'epub_import','epub_files',?, ?,?)"
      ).bind(uuid(),batchId,fileId,JSON.stringify({book_id:bookId,edition_id:targetEdition,
        cover_id:coverId,sha256:actual}),ts));
      await db.batch(statements);
      return json({status:'uploaded',uploaded:true,book_id:bookId,
        book_created:matched.status==='new',edition_id:targetEdition,
        cover_extracted:!!coverBytes,file_id:fileId,batch_id:batchId},201);
    }catch(error){
      // Only delete keys this request added. Never delete an existing digest
      // already referenced by another EPUB record.
      for(const objectKey of uploaded){try{await env.BOOK_FILES.delete(objectKey);}catch{}}
      if(/UNIQUE|constraint/i.test(String(error)))
        return bad('EPUB was already imported or the matching book changed. Re-preview to continue.',409);
      throw error;
    }
}

export async function handleEpubApi(request,db,env,path){
  const method=request.method;
  // List files only when the owner explicitly opens the EPUB section.
  // Do not add a scan to every ordinary book detail page on D1 free tier.
  const bookFiles=new RegExp('^/api/epubs/book/([0-9a-f-]{36})$').exec(path);
  if(bookFiles&&method==='GET'){
    const files=await many(db,
      'SELECT id,edition_id,original_filename,created_at FROM epub_files WHERE book_id=? ORDER BY created_at LIMIT 100',
      [bookFiles[1]]);
    return json({files,truncated:files.length===100});
  }
  // Only the outer owner-authenticated Worker can reach this route.
  // Never reveal R2 keys or create public signed URLs.
  const privateDownload=new RegExp('^/api/epubs/file/([0-9a-f-]{36})$').exec(path);
  if(privateDownload&&method==='GET'){
    if(!env.BOOK_FILES)return bad('Private EPUB storage is not configured',503);
    const file=await one(db,
      'SELECT private_object_key,original_filename FROM epub_files WHERE id=?',[privateDownload[1]]);
    if(!file)return bad('EPUB not found',404);
    const object=await env.BOOK_FILES.get(file.private_object_key);
    if(!object)return bad('EPUB not found',404);
    const original=String(file.original_filename||'book.epub').slice(0,180);
    const encoded=encodeURIComponent(original).replace(/'/g,'%27');
    return new Response(object.body,{headers:{
      'content-type':'application/epub+zip',
      'content-disposition':`attachment; filename="book.epub"; filename*=UTF-8''${encoded}`,
      'cache-control':'private, no-store',
      'x-content-type-options':'nosniff',
      'content-security-policy':"default-src 'none'; sandbox"
    }});
  }
  if(path==='/api/epubs/preview'&&method==='POST'){
    let body;
    try{body=await request.json();}catch{return bad('EPUB preview requires valid JSON');}
    if(!body||Array.isArray(body)||typeof body!=='object')return bad('Invalid EPUB metadata');
    if(Array.isArray(body.items)){
      try{return json({results:await batchPreviewEpub(db,body.items)});}
      catch(e){return bad(e.message||'Invalid EPUB preview items');}
    }
    const title=clean(body.title,300),author=clean(body.author,400),identifier=clean(body.identifier,250);
    const sha=String(body.sha256||'');
    if(!/^[a-f0-9]{64}$/.test(sha))return bad('Invalid EPUB file hash');
    return json(await matchEpub(db,{title,author,sha256:sha,identifier}));
  }
  if(path==='/api/epubs/upload'&&method==='POST'){
    if(!env.BOOK_FILES)return bad('Private EPUB storage is not configured',503);
    if(Number(request.headers.get('content-length')||0)>MAX_FILE+MAX_COVER+100000)
      return bad('EPUB upload is too large',413);
    let form;
    try{form=await request.formData();}catch{return bad('Could not read the EPUB upload');}
    const file=form.get('epub'),cover=form.get('cover');
    if(!(file instanceof File)||! /\.epub$/i.test(file.name||'')||!file.size||file.size>MAX_FILE)
      return bad('Choose an EPUB file smaller than 24 MB');
    let metadata;
    try{metadata=JSON.parse(form.get('metadata')||'{}');}
    catch{return bad('Invalid EPUB metadata');}
    const title=cleanEpubTitle(metadata.title),author=cleanEpubAuthor(metadata.author);
    const subjectList=Array.isArray(metadata.subjects)?metadata.subjects.slice(0,8):[];
    if(subjectList.some(tag=>typeof tag!=='string'||!tag.trim()||tag.trim().length>90))
      return bad('Invalid EPUB subject tags');
    const subjects=[...new Map(subjectList.map(tag=>[tag.trim().toLocaleLowerCase(),tag.trim()])).values()];
    const expected=String(metadata.sha256||'');
    if(!/^[a-f0-9]{64}$/.test(expected))return bad('Invalid EPUB hash');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(bytes.length!==file.size||bytes[0]!==80||bytes[1]!==75)
      return bad('File is not a ZIP-based EPUB');
    const actual=byteHex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
    if(actual!==expected)return bad('EPUB hash changed since preview; select the file again');
    let coverBytes=null,ctype=null;
    if(cover&&cover instanceof File&&cover.size){
      if(cover.size>MAX_COVER)return bad('EPUB cover exceeds 5 MB');
      coverBytes=new Uint8Array(await cover.arrayBuffer());
      ctype=coverType(coverBytes);
      if(!ctype)return bad('EPUB cover must be JPEG, PNG, or WebP');
    }
    return commitStoredEpub(db,env,{fileName:file.name,metadata,actual,coverBytes,ctype,bytes});
  }
  return null;
}
