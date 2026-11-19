#!/usr/bin/env node
// Find duplicate EPUB files in a folder and (only when asked) move the extras
// to the macOS Trash, where Finder's "Put Back" can restore them.
//
//   npm run local:epub-dupes -- estimate "/path/to/Books"  names and sizes only; downloads nothing
//   npm run local:epub-dupes -- scan  "/path/to/Books"     read-only; writes a plan + report
//   npm run local:epub-dupes -- trash "/path/to/Books"     moves exactly the planned extras to Trash
//
// Duplicates are: byte-identical files, or files whose EPUB metadata has the
// same cleaned title and author. Same title/author with *different* ISBNs may be
// a different edition or translation, so those groups are listed for review and
// never trashed. Book contents are never executed; nothing is uploaded.
//
// iCloud Drive keeps most files "dataless" (only in iCloud): reading one
// downloads it. So step 1 compares only names and sizes, which macOS knows
// without downloading, and step 2 reads just those suspected duplicates.
// Two copies with entirely different names *and* sizes are not caught.
import {createHash} from 'node:crypto';
import {createReadStream,openAsBlob,readdirSync,statSync,writeFileSync,readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,relative,basename,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectEpub,parsePackageXml,MAX_EPUB_BYTES} from '../epub-reader.mjs';
import {cleanEpubTitle,normalizeEpubTitle,normalizeEpubAuthor,machineTitleReason} from '../epub-metadata.mjs';
import {extractIsbn13} from '../epub-isbn.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const STATE=join(here,'..','.my-library-local');

export function walk(root){
 const files=[],packages=[],placeholders=[];
 const visit=dir=>{
  let entries;
  try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   const full=join(dir,e.name);
   if(e.isSymbolicLink())continue;
   if(e.isDirectory()){
    if(/\.epub$/i.test(e.name))packages.push(full);   // Apple Books package folder
    else visit(full);
   }else if(e.isFile()){
    if(/^\..*\.epub\.icloud$/i.test(e.name))placeholders.push(full);
    else if(/\.epub$/i.test(e.name)&&!e.name.startsWith('._'))files.push(full);
   }
  }
 };
 visit(root);
 return {files,packages,placeholders};
}

const sha256=path=>new Promise((ok,fail)=>{
 const h=createHash('sha256');
 createReadStream(path).on('data',c=>h.update(c)).on('error',fail).on('end',()=>ok(h.digest('hex')));
});

export async function describe(path){
 const st=statSync(path);
 const info={path,name:basename(path),size:st.size,mtime:st.mtimeMs,hash:await sha256(path),
  title:'',author:'',isbn:'',hasCover:false,hasSummary:false,error:''};
 if(st.size>0&&st.size<=MAX_EPUB_BYTES){
  try{
   const blob=await openAsBlob(path);
   const meta=await inspectEpub({name:info.name,size:st.size,arrayBuffer:()=>blob.arrayBuffer()},{includeCover:false});
   info.title=String(meta.title||'');info.author=String(meta.author||'');
   info.isbn=extractIsbn13(meta.identifier)||'';
   info.hasCover=!!meta.coverPath;info.hasSummary=!!String(meta.description||'').trim();
  }catch(error){info.error=String(error.message||error).slice(0,200);}
 }else info.error=st.size?'larger than 96 MB (checked by contents only)':'empty file';
 return info;
}

// Apple Books stores some EPUBs as folders. Read only their small OPF files.
export function folderSize(dir){
 let total=0;
 for(const e of readdirSync(dir,{withFileTypes:true})){
  const full=join(dir,e.name);
  if(e.isDirectory())total+=folderSize(full);else if(e.isFile())total+=statSync(full).size;
 }
 return total;
}
export function describePackage(dir){
 const st=statSync(dir);
 const info={path:dir,name:basename(dir),size:folderSize(dir),mtime:st.mtimeMs,hash:'folder:'+dir,
  package:true,title:'',author:'',isbn:'',hasCover:false,hasSummary:false,error:''};
 try{
  const container=readFileSync(join(dir,'META-INF','container.xml'),'utf8');
  const root=/full-path\s*=\s*["']([^"']+)["']/i.exec(container);
  if(!root||root[1].includes('..'))throw Error('missing OPF manifest');
  const meta=parsePackageXml(container,readFileSync(join(dir,root[1]),'utf8'),root[1]);
  info.title=String(meta.title||'');info.author=String(meta.author||'');
  info.isbn=extractIsbn13(meta.identifier)||'';
  info.hasCover=!!meta.coverPath;info.hasSummary=!!String(meta.description||'').trim();
 }catch(error){info.error=String(error.message||error).slice(0,200);}
 return info;
}

// Step 1 key from the file name alone: "Defy the Night (1).epub",
// "Defy the Night by Brigid Kemmerer.epub" and "defy_the_night.epub" agree.
export function nameKey(path){
 let name=basename(path).replace(/\.epub$/i,'').replace(/_/g,' ');
 name=cleanEpubTitle(name+'.epub');
 name=name.replace(/\s*[-–]\s*\d{1,3}$|\s+copy(?:\s*\d+)?$/i,'').replace(/\s+by\s+[^()]{2,80}$/i,'');
 return normalizeEpubTitle(name)||null;
}
// Paths worth reading in step 2: they share a name key or an exact size.
export function suspects(entries){
 const byName=new Map(),bySize=new Map();
 const add=(map,key,path)=>{if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(path);};
 for(const e of entries){add(byName,nameKey(e.path),e.path);if(!e.package&&e.size>0)add(bySize,e.size,e.path);}
 const out=new Set();
 for(const map of [byName,bySize])for(const list of map.values())if(list.length>1)list.forEach(p=>out.add(p));
 return [...out];
}

// Higher is better: the copy we keep.
const junkName=name=>/\(\d{1,3}\)\.epub$|\bcopy\b|z-?lib|libgen|annas?-?archive|oceanofpdf|\[.*\]/i.test(name);
export function score(f){
 return (f.error?0:1000)+(f.hasCover?300:0)+(f.isbn?200:0)+(f.hasSummary?100:0)+
  (junkName(f.name)?0:50)+Math.min(49,Math.log2(1+f.size/1024));
}
const better=(a,b)=>score(b)-score(a)||b.size-a.size||b.mtime-a.mtime||a.name.length-b.name.length||a.path.localeCompare(b.path);

const NO_AUTHOR=new Set(['unknown','unknown author','anonymous','author','n a','na','none']);
export function bookKey(f){
 if(f.error||!f.title||!f.author||machineTitleReason(f.title))return null;
 const title=normalizeEpubTitle(cleanEpubTitle(f.title)),author=normalizeEpubAuthor(f.author);
 return title&&author&&!NO_AUTHOR.has(author)?title+'\u0000'+author:null;
}

// Your folders are part of how the library is organised. With a root given:
// a copy filed in a subfolder beats a loose copy, and copies filed in
// *different* subfolders are left for review (maybe filed twice on purpose).
function choose(sorted,root){
 if(!root)return {keep:sorted[0],rest:sorted.slice(1),folders:[]};
 const folderOf=f=>{const r=relative(root,dirname(f.path));return r&&!r.startsWith('..')?r:'';};
 const filed=sorted.filter(f=>folderOf(f));
 const folders=[...new Set(filed.map(folderOf))];
 const keep=filed[0]||sorted[0];
 return {keep,rest:sorted.filter(f=>f!==keep),folders};
}

// Returns {groups:[{kind,keep,trash,review,reason}], stats}
export function planDuplicates(infos,{root=null}={}){
 const byHash=new Map();
 for(const f of infos){if(!byHash.has(f.hash))byHash.set(f.hash,[]);byHash.get(f.hash).push(f);}
 const groups=[];
 // One representative per identical-bytes set goes on to the title/author pass.
 const reps=[],heldBack=new Set();
 for(const set of byHash.values()){
  const {keep,rest,folders}=choose([...set].sort(better),root);
  reps.push(keep);
  if(!rest.length)continue;
  if(folders.length>1){
   heldBack.add(keep);
   groups.push({kind:'review',keep,trash:[],review:rest,
    reason:'Identical files filed in different folders ('+folders.join(', ')+'): maybe on purpose'});
  }
  else groups.push({kind:'identical',keep,trash:rest,review:[],reason:'Byte-for-byte identical files'});
 }
 const byBook=new Map();
 for(const f of reps){
  const k=bookKey(f);if(!k)continue;
  if(!byBook.has(k))byBook.set(k,[]);byBook.get(k).push(f);
 }
 for(const set of byBook.values()){
  if(set.length<2)continue;
  const isbns=new Set(set.map(f=>f.isbn).filter(Boolean));
  const {keep,rest,folders}=choose([...set].sort(better),root);
  if(set.some(f=>heldBack.has(f))){
   // A copy here is already held back for review; don't trash part of that set.
   groups.push({kind:'review',keep,trash:[],review:rest,
    reason:'Same book, and some copies are also filed in other folders: review together'});
  }else if(isbns.size>1){
   groups.push({kind:'review',keep,trash:[],review:rest,
    reason:'Same title and author but different ISBNs ('+[...isbns].join(', ')+'): possibly different editions or translations'});
  }else if(folders.length>1){
   groups.push({kind:'review',keep,trash:[],review:rest,
    reason:'Same book filed in different folders ('+folders.join(', ')+'): maybe on purpose'});
  }else{
   groups.push({kind:'same-book',keep,trash:rest,review:[],
    reason:'Same title and author in the EPUB metadata'});
  }
 }
 const trash=groups.flatMap(g=>g.trash);
 return {groups,stats:{
  identical:groups.filter(g=>g.kind==='identical').reduce((n,g)=>n+g.trash.length,0),
  sameBook:groups.filter(g=>g.kind==='same-book').reduce((n,g)=>n+g.trash.length,0),
  review:groups.filter(g=>g.kind==='review').length,
  trashFiles:trash.length,trashBytes:trash.reduce((n,f)=>n+f.size,0)
 }};
}

const mb=n=>(n/1024/1024).toFixed(n>1e9?0:1)+' MB';
function report(root,plan,walked,infos){
 const rel=p=>relative(root,p);
 const line=f=>'    '+rel(f.path)+'  ('+mb(f.size)+(f.isbn?', ISBN '+f.isbn:'')+(f.hasCover?', cover':'')+')';
 const out=['EPUB duplicates in '+root,'',
  'Checked '+(walked.files.length+walked.packages.length)+' EPUBs by name and size; read '+infos.length+' possible duplicates in full.',
  'Exact copies to trash: '+plan.stats.identical,
  'Same-book copies to trash: '+plan.stats.sameBook,
  'Groups to review yourself (different ISBNs, nothing trashed): '+plan.stats.review,
  'Total to move to Trash: '+plan.stats.trashFiles+' files, '+mb(plan.stats.trashBytes),
  'Unreadable files (compared by bytes only): '+infos.filter(f=>f.error).length+'.',
  'Not caught: copies whose file names and sizes are both different.',''];
 for(const kind of ['identical','same-book','review']){
  const list=plan.groups.filter(g=>g.kind===kind);
  if(!list.length)continue;
  out.push('== '+({identical:'Exact copies',['same-book']:'Same book, different file',review:'Review: possibly different editions'})[kind]+' ('+list.length+') ==');
  for(const g of list){
   out.push((g.keep.title||g.keep.name)+(g.keep.author?' — '+g.keep.author:'')+(g.kind==='review'?'  ['+g.reason+']':''));
   out.push('  keep:');out.push(line(g.keep));
   if(g.trash.length){out.push('  move to Trash:');g.trash.forEach(f=>out.push(line(f)));}
   if(g.review.length){out.push('  also found (left alone):');g.review.forEach(f=>out.push(line(f)));}
  }
  out.push('');
 }
 return out.join('\n');
}

async function pool(items,n,fn,onDone){
 const results=new Array(items.length);let next=0,done=0;
 await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{
  while(next<items.length){const i=next++;results[i]=await fn(items[i]);onDone(++done);}
 }));
 return results;
}

function step1(root){
 const walked=walk(root);
 const entries=[...walked.files.map(path=>({path,size:statSync(path).size})),
  // Apple Books folders are matched by name only here: sizing them means
  // listing every file inside, which is slow for iCloud folders.
  ...walked.packages.map(path=>({path,size:0,package:true}))];
 const list=suspects(entries);
 const sizes=new Map(entries.map(e=>[e.path,e.size]));
 return {walked,entries,list,downloadBytes:list.reduce((n,p)=>n+(sizes.get(p)||0),0)};
}

function estimate(root){
 const s=step1(root);
 console.log(JSON.stringify({epub_files:s.walked.files.length,apple_books_folders:s.walked.packages.length,
  suspects:s.list.length,suspect_folders:s.list.filter(p=>s.entries.find(e=>e.path===p)?.package).length,
  download_mb_files:Math.round(s.downloadBytes/1024/1024)}));
}

async function scan(root,reportPath){
 const s=step1(root),walked=s.walked;
 process.stdout.write(s.entries.length+' EPUBs; reading '+s.list.length+' possible duplicates…\n');
 const packages=new Set(walked.packages);
 const infos=await pool(s.list,4,p=>packages.has(p)?describePackage(p):describe(p),
  n=>{if(n%100===0||n===s.list.length)process.stdout.write('  '+n+' / '+s.list.length+'\n');});
 const plan=planDuplicates(infos,{root});
 mkdirSync(STATE,{recursive:true});
 writeFileSync(join(STATE,'epub-duplicates-plan.json'),JSON.stringify({root,created:new Date().toISOString(),
  trash:plan.groups.flatMap(g=>g.trash.map(f=>({path:f.path,size:f.size,hash:f.hash,package:!!f.package})))},null,1));
 writeFileSync(reportPath,report(root,plan,walked,infos));
 console.log(JSON.stringify({files:infos.length,...plan.stats,placeholders:walked.placeholders.length,
  packages:walked.packages.length,unreadable:infos.filter(f=>f.error).length,report:reportPath}));
}

async function trash(root){
 const planPath=join(STATE,'epub-duplicates-plan.json');
 if(!existsSync(planPath))throw Error('Run a scan first.');
 const plan=JSON.parse(readFileSync(planPath,'utf8'));
 if(resolve(plan.root)!==resolve(root))throw Error('The saved plan is for a different folder. Scan this folder first.');
 const tool=existsSync('/usr/bin/trash')?'/usr/bin/trash':null;
 let moved=0,skipped=0;
 for(const item of plan.trash){
  // Only move a file that is still exactly the one that was scanned.
  if(!existsSync(item.path)){skipped++;continue;}
  const same=item.package?folderSize(item.path)===item.size:
   statSync(item.path).size===item.size&&await sha256(item.path)===item.hash;
  if(!same){skipped++;continue;}
  const r=tool?spawnSync(tool,[item.path],{stdio:'ignore'}):
   spawnSync('/usr/bin/osascript',['-e','on run argv','-e','tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)','-e','end run',item.path],{stdio:'ignore'});
  if(r.status===0)moved++;else skipped++;
 }
 console.log(JSON.stringify({moved,skipped}));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,folder,reportArg]=process.argv.slice(2);
 if(!['estimate','scan','trash'].includes(mode)||!folder){
  console.error('Usage: npm run local:epub-dupes -- estimate|scan|trash "/path/to/EPUB folder"');process.exit(2);
 }
 const root=resolve(folder);
 const reportPath=resolve(reportArg||join(STATE,'epub-duplicates-report.txt'));
 (mode==='estimate'?Promise.resolve(estimate(root)):mode==='scan'?scan(root,reportPath):trash(root))
  .catch(e=>{console.error(e.message);process.exit(1);});
}
