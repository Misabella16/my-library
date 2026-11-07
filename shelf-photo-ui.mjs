import {extractIsbn13} from './epub-isbn.mjs';
import {suggestShelfMatches,planPhotoMatch} from './shelf-photo-matcher.mjs';
import {createPhotoReview,setReviewPhotos,assignPhotoMatch,photoReviewRows,photoReviewCsv} from './shelf-photo-review.mjs';

// A privacy-first shelf-photo helper. Images never leave the browser.
// Native BarcodeDetector is optional and cannot identify cover art or text.
export async function scanPhotoBarcodes(file){
 if(typeof BarcodeDetector!=='function'||typeof createImageBitmap!=='function')
  return {supported:false,codes:[]};
 try{
  const supported=typeof BarcodeDetector.getSupportedFormats==='function'
   ?await BarcodeDetector.getSupportedFormats():['ean_13'];
  if(!supported.includes('ean_13'))return {supported:false,codes:[]};
  const detector=new BarcodeDetector({formats:['ean_13']});
  const bitmap=await createImageBitmap(file);
  let found=[];
  try{found=await detector.detect(bitmap);}finally{bitmap.close?.();}
  const codes=[...new Set(found.map(x=>String(x.rawValue||''))
   .filter(x=>/^(978|979)\d{10}$/.test(x)))];
  return {supported:true,codes};
 }catch{return {supported:false,codes:[]};}
}
const node=(tag,text,cls)=>{
 const el=document.createElement(tag);
 if(text!==undefined)el.textContent=String(text);
 if(cls)el.className=cls;
 return el;
};
export function initShelfPhotoAssistant(api,{onSelectBook=async()=>{}}={}){
 const get=id=>document.getElementById?.(id)||document.querySelector?.('#'+id);
 const input=get('photo-files'),images=get('photo-preview'),
  search=get('photo-book-search'),button=get('photo-match-search'),
  results=get('photo-match-results'),status=get('photo-status'),
  isbnStatus=get('photo-isbn-status');
 if(!input||!images||!search||!button||!results||!status)return;
 let currentUrls=[],busy=false;
 const manualInput=get('photo-isbn-input'),manualButton=get('photo-isbn-search');
 const review=createPhotoReview();
 const barcodeMatches=node('div',undefined,'photo-barcode-matches');
 isbnStatus?.after?.(barcodeMatches);
 let selectionGeneration=0;
 const reviewArea=node('section',undefined,'photo-review-area');
 const reviewHeading=node('h3','Photo-by-photo review');
 const reviewText=node('p','Select a photo for each suggested book. These links are temporary and do not create copies or change your catalogue.','muted');
 const reviewList=node('div',undefined,'photo-review-rows');
 const exportButton=node('button','Download photo match review CSV','btn subtle mini');
 exportButton.type='button';
 exportButton.disabled=true;
 reviewArea.append(reviewHeading,reviewText,reviewList,exportButton);
 results.after?.(reviewArea);
 exportButton.addEventListener('click',()=>{
  const csv=photoReviewCsv(review);
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const anchor=node('a');anchor.href=url;anchor.download='my-library-shelf-photo-review.csv';
  document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 function renderReview(){
  reviewList.replaceChildren();
  for(const row of photoReviewRows(review)){
   const entry=node('p',row.photoName+' → '+(row.title||'Not matched yet'),'muted');
   reviewList.append(entry);
  }
  exportButton.disabled=review.photos.length===0;
 }
 const tell=text=>{status.textContent=text;};
 const clear=()=>{
  selectionGeneration++;
  barcodeMatches.replaceChildren();
  for(const url of currentUrls)URL.revokeObjectURL(url);
  currentUrls=[];images.replaceChildren();results.replaceChildren();
  setReviewPhotos(review,[]);renderReview();
 };
 input.addEventListener('change',async()=>{
  clear();
  const files=[...(input.files||[])].filter(x=>
   ['image/jpeg','image/png','image/webp'].includes(x.type)&&x.size<=8*1024*1024).slice(0,50);
  setReviewPhotos(review,files);renderReview();
  for(const file of files){
   const frame=node('figure');
   const image=node('img');
   const url=URL.createObjectURL(file);
   currentUrls.push(url);image.src=url;image.alt='Private local shelf photograph';
   const caption=node('figcaption',file.name);
   frame.append(image,caption);images.append(frame);
  }
  tell(files.length+' private shelf photo'+(files.length===1?'':'s')+
   ' selected. Images stay on this device; no location or copy is changed.');
  if(!isbnStatus)return;
  isbnStatus.textContent='Checking supported local ISBN barcodes…';
  const generation=selectionGeneration;
  const codes=new Map();let supported=false;
  for(let i=0;i<Math.min(files.length,10);i++){
   const result=await scanPhotoBarcodes(files[i]);
   if(generation!==selectionGeneration)return;
   supported ||=result.supported;
   for(const code of result.codes.slice(0,2)){
    if(codes.size>=10&&!codes.has(code))continue;
    if(!codes.has(code))codes.set(code,review.photos[i]);
   }
  }
  if(!codes.size){
   isbnStatus.textContent=supported
    ?'No readable ISBN barcode detected. Search for a title below.'
    :'Local barcode detection is unavailable in this browser. Search by title below.';
   return;
  }
  await displayIsbnMatches(codes,generation);

 async function displayIsbnMatches(codes,generation){
  isbnStatus.textContent='Checking '+codes.size+' ISBN'+
   (codes.size===1?'':'s')+' against your existing editions. Nothing is saved automatically.';
  for(const [code,photo] of codes){
   let response;
   try{response=await api('/api/shelf-photos/isbn?'+new URLSearchParams({isbn:code}));}
   catch(error){
    if(generation!==selectionGeneration)return;
    barcodeMatches.append(node('p','Could not match ISBN '+code+': '+
      (error.message||'Request failed'),'muted'));
    continue;
   }
   if(generation!==selectionGeneration)return;
   const matches=Array.isArray(response.matches)?response.matches:[];
   if(!matches.length){
    barcodeMatches.append(node('p','ISBN '+code+' from '+photo.name+
     ' is not in your library yet. Search by title or add a new book.','muted'));
    continue;
   }
   for(const match of matches){
    if(!match?.book_id||!match.title)continue;
    const row=node('article',undefined,'photo-match-result');
    row.append(node('strong',match.title),node('span',
      'ISBN '+code+' · '+photo.name+' · '+(match.edition_name||'Edition')+
      (match.vendor?' · '+match.vendor:'')+
      (matches.length>1?' · Check edition identity':'') ,'muted'));
    const associate=node('button','Associate this photo (review only)','btn subtle mini');
    associate.type='button';associate.disabled=!review.photos.length;
    associate.addEventListener('click',()=>{
     try{
      assignPhotoMatch(review,photo.id,{
       id:match.book_id,title:match.title,author:match.author
      });
      renderReview();
      tell('ISBN suggestion associated with '+photo.name+
       '. Confirm edition and physical copy on the book page.');
     }catch(error){tell(error.message||'Could not record photo suggestion');}
    });
    const open=node('button','Open book and editions','btn subtle mini');
    open.type='button';
    open.addEventListener('click',async()=>{
     open.disabled=true;
     try{await onSelectBook(match.book_id);}
     catch(error){tell('Could not open book: '+(error.message||'Request failed'));}
     finally{open.disabled=false;}
    });
    // A barcode match is only a candidate. Require a separate explicit
    // inventory preview before claiming ownership or recording a location.
    const inventory=node('button','Check physical inventory','btn subtle mini');
    inventory.type='button';inventory.disabled=match.format==='ebook'||match.format==='audiobook';
    const inventoryArea=node('div',undefined,'photo-inventory-review');
    inventory.addEventListener('click',async()=>{
     inventory.disabled=true;inventoryArea.replaceChildren();
     try{
      const inspected=await api('/api/shelf-photos/edition/'+match.edition_id+'/preview');
      if(generation!==selectionGeneration)return;
      if(inspected.isbn!==code||inspected.edition_id!==match.edition_id)
       throw Error('Edition identity changed; rescan or reload the photo.');
      inventoryArea.append(node('p','Edition: '+(inspected.edition_name||'Unknown')+
       (inspected.vendor?' · '+inspected.vendor:'')+
       (inspected.is_special?' · Special edition':'')+
       '. Exact ISBN: '+code,'muted'));
      const owned=inspected.existing_copies||[];
      if(owned.length||inspected.truncated){
       inventoryArea.append(node('p',
        'Existing physical copies: '+owned.length+(inspected.truncated?'+':'')+
        '. Open this book to edit a copy or its shelf position. Nothing was duplicated.','muted'));
       return;
      }
      const confirm=node('button','Confirm I own this physical edition','btn mini');
      confirm.type='button';
      const form=node('div',undefined,'photo-inventory-location');
      const fields=[
       ['room','Room (optional)'],['bookcase','Bookcase (optional)'],
       ['shelf','Shelf (optional)'],['shelf_position','Position (optional)']
      ];
      const entries={};
      for(const [name,label] of fields){
       const field=node('label',label,'muted');
       const input=node('input');input.type='text';input.maxLength=name==='shelf_position'?100:150;
       input.placeholder=label;field.append(input);form.append(field);entries[name]=input;
      }
      confirm.addEventListener('click',async()=>{
       if(!globalThis.confirm?.('Confirm that you physically own this exact ISBN edition? This creates one owned copy; it does not change other editions or cover images.'))return;
       confirm.disabled=true;
       try{
        const data={isbn:code,confirm:true};
        for(const [name,input] of Object.entries(entries))data[name]=input.value;
        const outcome=await api('/api/shelf-photos/edition/'+match.edition_id+'/claim',
         {method:'POST',data});
        inventoryArea.replaceChildren(node('p','Physical copy recorded. Open the book to review shelf placement and special edition details.','muted'));
        tell('Recorded your confirmed physical copy of '+match.title+'.');
        await onSelectBook(outcome.book_id);
       }catch(error){
        inventoryArea.append(node('p','Inventory not changed: '+(error.message||'Request failed'),'muted'));
        confirm.disabled=false;
       }
      });
      inventoryArea.append(node('p','Only confirm if you physically own this edition. Leave locations blank if unknown.','muted'),form,confirm);
     }catch(error){
      inventoryArea.replaceChildren(node('p','Inventory preview unavailable: '+(error.message||'Request failed'),'muted'));
     }finally{inventory.disabled=false;}
    });
    row.append(associate,open,inventory,inventoryArea);barcodeMatches.append(row);
   }
  }
  isbnStatus.textContent='ISBN lookup complete. Matches are suggestions only; no books, editions, or copies were modified.';
 }
 manualButton?.addEventListener('click',async()=>{
  if(busy)return;
  const isbn=extractIsbn13(manualInput?.value||'');
  if(!isbn){
   isbnStatus.textContent='Enter a valid ISBN-13 from the physical book barcode.';
   return;
  }
  busy=true;manualButton.disabled=true;
  selectionGeneration++;
  const generation=selectionGeneration;
  barcodeMatches.replaceChildren();
  try{
   // A manual entry can search without any photo. It never implies that
   // the book is owned, or changes the current photo review.
   const photo=review.photos[0]||{id:'',name:'Manual ISBN'};
   await displayIsbnMatches(new Map([[isbn,photo]]),generation);
  }finally{busy=false;manualButton.disabled=false;}
 });
 button.addEventListener('click',async()=>{
  if(busy)return;
  const q=search.value.trim().slice(0,150);
  if(q.length<2){tell('Enter at least two letters from a book title or author.');return;}
  busy=true;button.disabled=true;results.replaceChildren();
  try{
   // Bounded catalogue search, never a full 10k-book scan downloaded locally.
   const page=await api('/api/books?'+new URLSearchParams({q,limit:'40'}));
   const books=page.books||[];
   const candidate={title:q};
   const ranked=suggestShelfMatches(candidate,books,{limit:8});
   const order=ranked.length?ranked.map(x=>books.find(b=>b.id===x.bookId)).filter(Boolean):books.slice(0,8);
   if(!order.length)results.append(node('p','No matching books found. Try the title or author.','muted'));
   for(const book of order){
    const row=node('article',undefined,'photo-match-result');
    row.append(node('strong',book.title),node('span','muted',book.author||'Author unknown'));
    const open=node('button','Open book and manage editions/copies','btn subtle mini');
    open.type='button';
    open.addEventListener('click',async()=>{
     open.disabled=true;
     try{
      await onSelectBook(book.id);
      tell('Opened '+book.title+'. Review its editions and record a physical copy or shelf location explicitly.');
     }catch(error){
      tell('Book could not be opened: '+(error.message||'Request failed'));
     }finally{open.disabled=false;}
    });
    const label=node('label','Associate with photo: ','muted');
    const select=node('select');
    const placeholder=node('option','Select photo…');placeholder.value='';select.append(placeholder);
    for(const photo of review.photos){
     const option=node('option',photo.name);option.value=photo.id;select.append(option);
    }
    const assign=node('button','Keep as photo suggestion','btn subtle mini');assign.type='button';
    assign.disabled=!review.photos.length;
    assign.addEventListener('click',()=>{
     try{
      assignPhotoMatch(review,select.value,book);renderReview();
      tell('Suggested match recorded for photo review only. Open the book to verify edition and physical copy.');
     }catch(error){tell(error.message||'Choose a photo first.');}
    });
    label.append(select);row.append(label,assign,open);results.append(row);
   }
   tell('Showing '+order.length+' bounded catalogue suggestions. No photographs were uploaded and no copies were created.');
  }catch(e){tell('Shelf-photo matching unavailable: '+(e.message||'Request failed'));}
  finally{busy=false;button.disabled=false;}
 });
 return {clear};
}
