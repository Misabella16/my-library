// Files above 24 MiB go to private R2 in 8 MiB verified parts.
// Retains resumable per-file session in the current browser selection only.
export const MULTIPART_THRESHOLD=24*1024*1024;
export const MAX_LARGE_EPUB_BYTES=96*1024*1024;
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
 b=>b.toString(16).padStart(2,'0')).join('');
export async function uploadLargeEpub(api,{file,metadata,cover=null,
 onSession=()=>{},resume=null,onProgress=()=>{}}){
 if(file.size<=MULTIPART_THRESHOLD||file.size>MAX_LARGE_EPUB_BYTES)
  throw Error('Multipart upload is only for EPUBs over 24 MiB through 96 MiB');
 if(!metadata?.sha256)throw Error('Preview EPUB metadata before uploading');
 let session=resume;
 if(!session){
  const result=await api('/api/epubs/large/start',{method:'POST',data:{
   name:file.name,size:file.size,sha256:metadata.sha256,metadata
  }});
  if(result.status==='already_uploaded')return result;
  if(!result.session_id)throw Error('Large EPUB upload session could not be started');
  session={id:result.session_id,part_bytes:result.part_bytes,total_parts:result.total_parts,
   parts:[]};
  onSession(session);
 }
 if(!session.id||!Number.isInteger(session.part_bytes)||!Array.isArray(session.parts))
  throw Error('Invalid resumed large EPUB upload session');
 for(let i=0;i<session.total_parts;i++){
  if(session.parts[i])continue;
  const part=file.slice(i*session.part_bytes,Math.min(file.size,(i+1)*session.part_bytes));
  const bytes=await part.arrayBuffer();
  const check=await sha(bytes);
  const returned=await api('/api/epubs/large/part?'+new URLSearchParams({
   session:session.id,part:String(i+1)
  }),{method:'POST',raw:new Blob([bytes]),contentType:'application/octet-stream',
   headers:{'x-part-sha256':check}});
  if(returned.part_number!==i+1||typeof returned.etag!=='string')
   throw Error('Large EPUB part upload was not confirmed');
  session.parts[i]={partNumber:i+1,etag:returned.etag};
  onSession(session);
  onProgress((i+1)/session.total_parts);
 }
 const form=new FormData();
 form.set('parts',JSON.stringify(session.parts));
 if(cover)form.set('cover',cover,'embedded-cover'+(
  cover.type==='image/png'?'.png':cover.type==='image/webp'?'.webp':'.jpg'));
 return api('/api/epubs/large/complete?'+new URLSearchParams({
  session:session.id
 }),{method:'POST',formData:form});
}
