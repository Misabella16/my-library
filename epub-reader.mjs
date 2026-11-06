// Local EPUB (ZIP + OPF) inspection for private My Library imports.
// Does not contact a server, fetch external XML, or execute book contents.
export const MAX_EPUB_BYTES=24*1024*1024;
const MAX_ZIP_ENTRIES=4000;
const MAX_XML_BYTES=2*1024*1024;
const MAX_COVER_BYTES=5*1024*1024;
const decoder=new TextDecoder('utf-8');
const normalizePath=path=>{
  const parts=String(path||'').replace(/\\/g,'/').split('/');
  const out=[];
  for(const part of parts){
    if(!part||part==='.')continue;
    if(part==='..'){if(!out.length)throw Error('EPUB has an unsafe ZIP path');out.pop();continue;}
    out.push(part);
  }
  return out.join('/');
};
const joinPath=(base,target)=>normalizePath((base.includes('/')?base.slice(0,base.lastIndexOf('/')+1):'')+target);
const xmlDecode=text=>String(text||'')
  .replace(/&#(x[0-9a-f]+|\d+);/gi,(_m,v)=>{
    const code=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):parseInt(v,10);
    return code>=0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
  })
  .replace(/&(?:amp|lt|gt|quot|apos);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[v]);
const cleanText=(v,max=1000)=>xmlDecode(v.replace(/<[^>]*>/g,'')).replace(/\s+/g,' ').trim().slice(0,max);
export const zipEntries=bytes=>{
  const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  let eocd=-1;
  for(let i=data.byteLength-22;i>=Math.max(0,data.byteLength-65557);i--){
    if(view.getUint32(i,true)===0x06054b50){eocd=i;break;}
  }
  if(eocd<0)throw Error('Not a valid EPUB ZIP archive');
  const count=view.getUint16(eocd+10,true);
  const dirSize=view.getUint32(eocd+12,true),dirStart=view.getUint32(eocd+16,true);
  if(count>=0xffff||count>MAX_ZIP_ENTRIES||dirStart+dirSize>eocd)
    throw Error('EPUB archive uses unsupported ZIP features or has too many entries');
  const entries=new Map();
  let cursor=dirStart;
  for(let i=0;i<count;i++){
    if(cursor+46>dirStart+dirSize||view.getUint32(cursor,true)!==0x02014b50)
      throw Error('Invalid EPUB ZIP directory');
    const flags=view.getUint16(cursor+8,true);
    const method=view.getUint16(cursor+10,true);
    const compressed=view.getUint32(cursor+20,true);
    const uncompressed=view.getUint32(cursor+24,true);
    const nameLength=view.getUint16(cursor+28,true);
    const extraLength=view.getUint16(cursor+30,true);
    const commentLength=view.getUint16(cursor+32,true);
    const localOffset=view.getUint32(cursor+42,true);
    const end=cursor+46+nameLength+extraLength+commentLength;
    if(end>dirStart+dirSize||localOffset+30>data.byteLength)
      throw Error('Malformed EPUB ZIP entry');
    if((flags&1)||![0,8].includes(method))
      throw Error('This EPUB uses encryption or an unsupported ZIP format');
    if(compressed===0xffffffff||uncompressed===0xffffffff)
      throw Error('ZIP64 EPUB archives are not supported');
    const rawName=decoder.decode(data.subarray(cursor+46,cursor+46+nameLength));
    const name=normalizePath(rawName);
    if(name&&!rawName.endsWith('/')){
      if(entries.has(name))throw Error('Duplicate ZIP entry found in EPUB');
      entries.set(name,{method,compressed,uncompressed,localOffset});
    }
    cursor=end;
  }
  return {data,entries};
};
export async function readZipEntry(archive,name,maxSize=MAX_XML_BYTES){
  const normalized=normalizePath(name);
  const entry=archive.entries.get(normalized);
  if(!entry)return null;
  if(entry.uncompressed>maxSize)throw Error('EPUB metadata or cover exceeds the size limit');
  const {data}=archive;
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const pos=entry.localOffset;
  if(view.getUint32(pos,true)!==0x04034b50)throw Error('Malformed EPUB ZIP file header');
  const start=pos+30+view.getUint16(pos+26,true)+view.getUint16(pos+28,true);
  if(start+entry.compressed>data.byteLength)throw Error('Truncated EPUB ZIP file');
  const compressed=data.subarray(start,start+entry.compressed);
  if(entry.method===0){
    if(compressed.length>maxSize)throw Error('EPUB file exceeds the size limit');
    return compressed.slice();
  }
  if(typeof DecompressionStream!=='function')throw Error('Your browser cannot decompress EPUB files.');
  const stream=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader=stream.getReader(),chunks=[];
  let length=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>maxSize)throw Error('Decompressed EPUB content exceeds the safe size limit');
      chunks.push(value);
    }
  }finally{
    reader.releaseLock();
  }
  if(length!==entry.uncompressed)throw Error('EPUB ZIP entry length mismatch');
  const out=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}
  return out;
}
const attrs=tag=>{
  const result={};
  for(const match of tag.matchAll(/([:\w.-]+)\s*=\s*(["'])(.*?)\2/gs))
    result[match[1].toLowerCase()]=xmlDecode(match[3]);
  return result;
};
const tagValue=(xml,name,max=1000)=>{
  const found=new RegExp('<(?:[\\w.-]+:)?'+name+'\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?'+name+'\\s*>','i').exec(xml);
  return found?cleanText(found[1],max):'';
};
const zipType=(bytes)=>{
  if(!bytes?.length)return null;
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))return 'image/png';
  if(bytes.length>=12&&decoder.decode(bytes.subarray(0,4))==='RIFF'&&decoder.decode(bytes.subarray(8,12))==='WEBP')return 'image/webp';
  return null;
};
export function parsePackageXml(containerXml,packageXml,packagePath){
  // The paths refer only to archive entries; external resources are ignored.
  const root=/<(?:[\w.-]+:)?rootfile\b[^>]*>/i.exec(containerXml);
  if(!root)throw Error('EPUB is missing its OPF package path');
  const opfPath=normalizePath(attrs(root[0])['full-path']||'');
  if(opfPath!==packagePath)throw Error('EPUB package path is inconsistent');
  const title=tagValue(packageXml,'title',300);
  const author=tagValue(packageXml,'creator',400);
  const description=tagValue(packageXml,'description',3000);
  const identifier=tagValue(packageXml,'identifier',250);
  const subjects=[...packageXml.matchAll(/<(?:[\\w.-]+:)?subject\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?subject\\s*>/gi)]
    .map(match=>cleanText(match[1],90)).filter(Boolean)
    .filter((subject,index,all)=>all.findIndex(x=>x.toLocaleLowerCase()===subject.toLocaleLowerCase())===index)
    .slice(0,8);
  const manifest=new Map();
  for(const match of packageXml.matchAll(/<(?:[\w.-]+:)?item\b[^>]*>/gi)){
    const a=attrs(match[0]);
    if(a.id&&a.href)manifest.set(a.id,a);
  }
  let coverItem=[...manifest.values()].find(a=>(a.properties||'').split(/\s+/).includes('cover-image'));
  if(!coverItem){
    const coverMeta=[...packageXml.matchAll(/<(?:[\w.-]+:)?meta\b[^>]*>/gi)]
      .map(match=>attrs(match[0])).find(a=>a.name?.toLowerCase()==='cover');
    if(coverMeta)coverItem=manifest.get(coverMeta.content);
  }
  // EPUB2 occasionally places the cover reference in a <guide> section.
  if(!coverItem){
    const guide=[...packageXml.matchAll(/<(?:[\w.-]+:)?reference\b[^>]*>/gi)]
      .map(match=>attrs(match[0])).find(a=>a.type==='cover' && /\.(png|jpe?g|webp)(?:$|[?#])/i.test(a.href||''));
    if(guide)coverItem=guide;
  }
  let coverPath='';
  if(coverItem?.href&&!/^[a-z]+:/i.test(coverItem.href)){
    const path=coverItem.href.split(/[?#]/)[0];
    coverPath=joinPath(packagePath,decodeURIComponent(path));
  }
  return {title,author,description,identifier,subjects,coverPath};
}
export async function inspectEpub(file){
  if(!file||!/\.epub$/i.test(file.name||''))throw Error('Choose an .epub file');
  if(file.size===0||file.size>MAX_EPUB_BYTES)throw Error('EPUB must be smaller than 24 MB');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const archive=zipEntries(bytes);
  const container=await readZipEntry(archive,'META-INF/container.xml');
  if(!container)throw Error('EPUB is missing META-INF/container.xml');
  const containerText=decoder.decode(container);
  const root=/<(?:[\w.-]+:)?rootfile\b[^>]*>/i.exec(containerText);
  if(!root)throw Error('EPUB is missing its OPF manifest');
  const packagePath=normalizePath(attrs(root[0])['full-path']||'');
  const packageBytes=await readZipEntry(archive,packagePath);
  if(!packageBytes)throw Error('EPUB package manifest could not be found');
  const metadata=parsePackageXml(containerText,decoder.decode(packageBytes),packagePath);
  let cover=null,coverType=null;
  if(metadata.coverPath&&archive.entries.has(metadata.coverPath)){
    try{
      const image=await readZipEntry(archive,metadata.coverPath,MAX_COVER_BYTES);
      coverType=zipType(image);
      if(coverType)cover=new Blob([image],{type:coverType});
    }catch{
      // An invalid or oversized cover never prevents importing a valid EPUB.
    }
  }
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const sha256=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {...metadata,cover,coverType,sha256,file,fileName:file.name};
}
