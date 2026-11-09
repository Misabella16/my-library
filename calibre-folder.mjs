// Reads Calibre's usual Author/Book Title (number)/metadata.opf,
// cover.jpg and EPUB files from a folder selected on the owner's computer.
// No folder or file is sent to a server until a confirmed repair/upload action.
const xmlDecode=x=>String(x||'').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
 .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;/gi,"'")
 .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
const text=x=>xmlDecode(String(x||'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const values=(xml,name)=>[...xml.matchAll(new RegExp(
 '<(?:[\\w.-]+:)?'+name+'\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?'+name+'\\s*>','gi'))]
 .map(x=>text(x[1])).filter(Boolean);
const filesOf=folderFiles=>Array.from(folderFiles||[]);
const rel=file=>(file.webkitRelativePath||file.name||'').replace(/\\/g,'/');
export function calibreFolderId(path){
 const match=String(path||'').replace(/\\/g,'/')
  .match(/(?:^|\/)([^/]+) \((\d{1,12})\)\/[^/]+$/);
 return match?{id:match[2],folder:match[1],path:String(path).replace(/\/[^/]+$/,'')}:null;
}
function metadata(xml,id,available,folder){
 const title=values(xml,'title')[0]||folder;
 const authors=values(xml,'creator').join(' & ');
 const tags=values(xml,'subject').filter(x=>x.length<=90);
 const description=values(xml,'description')[0]||'';
 const identifiers=[...xml.matchAll(/<(?:[\w.-]+:)?identifier\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?identifier\s*>/gi)];
 let isbn='';
 for(const m of identifiers){
  const attr=m[1]||'',value=text(m[2]);
  if(/(?:\bISBN\b|isbn)/i.test(attr)||/^(?:97[89])[\d -]{10,16}$/.test(value)||
    /^\d{9}[\dX]$/i.test(value)){
   isbn=value;break;
  }
 }
 const series=/<(?:[\w.-]+:)?meta\b[^>]*name=["']calibre:series["'][^>]*content=["']([^"']+)/i.exec(xml)?.[1]||'';
 const series_index=/<(?:[\w.-]+:)?meta\b[^>]*name=["']calibre:series_index["'][^>]*content=["']([^"']+)/i.exec(xml)?.[1]||'';
 return {id,title,authors,tags,comments:description,identifiers:{isbn},
  formats:available.formats,cover:!!available.cover,series,series_index};
}
export function indexCalibreFolder(files){
 const covers=new Map(),epubs=new Map(),ops=[],groups=new Map();
 for(const file of filesOf(files)){
  const path=rel(file),meta=calibreFolderId(path);
  if(!meta)continue;
  const base=path.split('/').at(-1).toLowerCase();
  if(!groups.has(meta.id))groups.set(meta.id,{title:meta.folder,formats:new Set(),covers:[]});
  const group=groups.get(meta.id);
  if(base==='metadata.opf')ops.push({file,id:meta.id,folder:meta.folder});
  if(base==='cover.jpg'||base==='cover.jpeg'||base==='cover.png'||base==='cover.webp'){
   group.covers.push(file);covers.set(meta.id,group.covers.length===1?file:null);
  }
  const ext=base.match(/\.(epub|pdf|azw3|mobi)$/i)?.[1]?.toUpperCase();
  if(ext){
   group.formats.add(ext);
   if(ext==='EPUB'){
    if(!epubs.has(meta.id))epubs.set(meta.id,[]);
    epubs.get(meta.id).push(file);
   }
  }
 }
 return {covers,epubs,ops,groups};
}
export async function readCalibreFolder(files,{onProgress=()=>{},cancelled=()=>false}={}){
 const index=indexCalibreFolder(files);
 if(!index.ops.length)throw Error('No Calibre metadata.opf files found. Select the Calibre library root folder.');
 const records=[];
 // Process small groups so 10k+ Calibre records do not freeze the tab.
 for(let start=0;start<index.ops.length;start+=20){
  if(cancelled())return null;
  const chunk=index.ops.slice(start,start+20);
  const parsed=await Promise.all(chunk.map(async({file,id,folder})=>{
   const info=index.groups.get(id);
   if(!info)return null;
   if(file.size>2*1024*1024)return null;
   try{
    const xml=await file.text();
    return metadata(xml,id,{
     cover:index.covers.get(id),formats:[...info.formats]
    },folder);
   }catch{return null;}
  }));
  records.push(...parsed.filter(Boolean));
  onProgress(Math.min(start+20,index.ops.length),index.ops.length);
  if(start%200===0)await new Promise(resolve=>setTimeout(resolve,0));
 }
 if(!records.length)throw Error('No readable Calibre metadata.opf files found');
 return {books:records,covers:index.covers,epubs:index.epubs};
}
