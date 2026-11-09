import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {webcrypto} from 'node:crypto';
import {inspectEpub,readZipEntry,zipEntries,parsePackageXml} from '../epub-reader.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
function fixtureZip(files,compressed=false){
 const chunks=[],directory=[];let offset=0;
 for(const [name,raw] of Object.entries(files)){
  const filename=Buffer.from(name),content=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
  const stored=compressed?deflateRawSync(content):content;
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt16LE(compressed?8:0,8);
  local.writeUInt32LE(stored.length,18);local.writeUInt32LE(content.length,22);
  local.writeUInt16LE(filename.length,26);chunks.push(local,filename,stored);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);
  central.writeUInt16LE(20,6);central.writeUInt16LE(compressed?8:0,10);
  central.writeUInt32LE(stored.length,20);central.writeUInt32LE(content.length,24);
  central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
  directory.push(central,filename);
  offset+=local.length+filename.length+stored.length;
 }
 const count=Object.keys(files).length,dir=Buffer.concat(directory),eocd=Buffer.alloc(22);
 eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(count,8);eocd.writeUInt16LE(count,10);
 eocd.writeUInt32LE(dir.length,12);eocd.writeUInt32LE(offset,16);
 return Buffer.concat([...chunks,dir,eocd]);
}
const container='<container><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf='<package><metadata><dc:title>The Star &amp; Garden</dc:title><dc:creator>Anne Writer</dc:creator><dc:description>A &lt;private&gt; book.</dc:description><dc:identifier>urn:isbn:9781234567897</dc:identifier><dc:subject>Fantasy</dc:subject><dc:subject>Romance</dc:subject><dc:subject>fantasy</dc:subject></metadata><manifest><item id="c" href="images/cover.png" media-type="image/png" properties="cover-image"/></manifest></package>';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const content=()=>({'mimetype':'application/epub+zip','META-INF/container.xml':container,'OPS/content.opf':opf,'OPS/images/cover.png':png});
test('EPUB metadata, hash and cover extraction from ZIP',async()=>{
 const file=new File([fixtureZip(content())],'story.epub',{type:'application/epub+zip'});
 const book=await inspectEpub(file);
 assert.equal(book.title,'The Star & Garden');
 assert.equal(book.author,'Anne Writer');
 assert.equal(book.description,'A <private> book.');
 assert.equal(book.identifier,'urn:isbn:9781234567897');
 assert.deepEqual(book.subjects,['Fantasy','Romance']);
 assert.equal(book.coverType,'image/png');
 assert.equal(book.cover.size,png.length);
 assert.equal(book.coverPath,'OPS/images/cover.png');
 assert.match(book.sha256,/^[a-f0-9]{64}$/);
 assert.equal(book.file,file);
});
test('Deflate compressed EPUB XML and cover are supported',async()=>{
 const file=new File([fixtureZip(content(),true)],'compressed.epub');
 const book=await inspectEpub(file);
 assert.equal(book.title,'The Star & Garden');
 assert.equal(book.coverType,'image/png');
});
test('Preview omits large cover payload until upload but preserves cover path',async()=>{
 const file=new File([fixtureZip(content())],'story.epub');
 const book=await inspectEpub(file,{includeCover:false});
 assert.equal(book.cover,null);
 assert.equal(book.coverType,null);
 assert.equal(book.coverPath,'OPS/images/cover.png');
 assert.deepEqual(book.subjects,['Fantasy','Romance']);
});

test('EPUB2 manifest cover metadata can be read',async()=>{
 const epub2=opf.replace(' properties="cover-image"','').replace('</metadata>','<meta name="cover" content="c"/></metadata>');
 const book=await inspectEpub(new File([fixtureZip({...content(),'OPS/content.opf':epub2})],'epub2.epub'));
 assert.equal(book.coverType,'image/png');
});
test('Reject unsupported ZIP archives and unsafe paths',async()=>{
 await assert.rejects(inspectEpub(new File([fixtureZip({'mimetype':'application/epub+zip'})],'broken.epub')),/missing META-INF/);
 assert.throws(()=>zipEntries(fixtureZip({'../private.txt':'bad'})),/unsafe ZIP path/);
 assert.throws(()=>zipEntries(new Uint8Array([1,2,3])),/valid EPUB ZIP archive/);
});
test('Missing entries return null and parsed XML remains plain text',async()=>{
 const result=parsePackageXml(container,opf,'OPS/content.opf');
 assert.equal(result.description,'A <private> book.');
 const archive=zipEntries(fixtureZip(content()));
 assert.equal(await readZipEntry(archive,'NOT_A_REAL_FILE'),null);
});
test('Reject oversized and non-EPUB selections',async()=>{
 await assert.rejects(inspectEpub(new File([Buffer.alloc(10)],'test.zip')),/\.epub/);
 await assert.rejects(inspectEpub(new File([],'empty.epub')),/96 MiB/);
});

test('Fallback extracts a uniquely labeled EPUB2 manifest cover without meta or guide',async()=>{
 const oldStyle=opf.replace(' properties="cover-image"','');
 const file=new File([fixtureZip({...content(),'OPS/content.opf':oldStyle})],'old-style.epub');
 const book=await inspectEpub(file);
 assert.equal(book.coverType,'image/png');
 assert.equal(book.coverPath,'OPS/images/cover.png');
});
test('Never guess between multiple candidate cover images',async()=>{
 const uncertain=opf.replace(' properties="cover-image"','').replace(
  '</manifest>','<item id="frontcover" href="images/frontcover.png" media-type="image/png"/></manifest>');
 const file=new File([fixtureZip({...content(),'OPS/content.opf':uncertain,
  'OPS/images/frontcover.png':png})],'ambiguous.epub');
 const book=await inspectEpub(file);
 assert.equal(book.coverPath,'');
 assert.equal(book.cover,null);
});
test('Unrelated image in manifest is not mistaken for cover',()=>{
 const noncover=opf.replace(' properties="cover-image"','')
  .replace('id="c" href="images/cover.png"','id="chapter-art" href="images/chapter.png"');
 const value=parsePackageXml(container,noncover,'OPS/content.opf');
 assert.equal(value.coverPath,'');
});

test('EPUB chooses a valid ISBN from multiple identifiers after a UUID',async()=>{
 const multi=opf.replace(
  '<dc:identifier>urn:isbn:9781234567897</dc:identifier>',
  '<dc:identifier id="uuid">urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</dc:identifier>'+
  '<dc:identifier id="isbn">urn:isbn:9780306406157</dc:identifier>'
 );
 const book=await inspectEpub(new File([fixtureZip({...content(),'OPS/content.opf':multi})],'identifiers.epub'));
 assert.equal(book.identifier,'urn:isbn:9780306406157');
 assert.equal(book.coverType,'image/png');
});
test('Unlabeled UUID stays available when no valid ISBN exists',()=>{
 const onlyUuid=opf.replace('urn:isbn:9781234567897','urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
 const details=parsePackageXml(container,onlyUuid,'OPS/content.opf');
 assert.equal(details.identifier,'urn:uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});
