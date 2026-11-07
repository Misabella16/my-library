// Local-only, opt-in visual comparison. Never sends pixels or signatures to D1,
// R2, a third-party OCR service, or the private catalogue. Comparing one crop
// against a small, explicitly title-filtered set of EXISTING cover images does
// not identify every book in a 10,000-book library.
export function cropBounds(start,end,width,height){
 const w=Number(width),h=Number(height);
 if(!Number.isFinite(w)||!Number.isFinite(h)||w<1||h<1)return null;
 const clamp=(value,limit)=>Math.max(0,Math.min(limit,Number(value)||0));
 const x1=clamp(start?.x,w),y1=clamp(start?.y,h),
  x2=clamp(end?.x,w),y2=clamp(end?.y,h);
 const x=Math.floor(Math.min(x1,x2)),y=Math.floor(Math.min(y1,y2));
 const right=Math.ceil(Math.max(x1,x2)),bottom=Math.ceil(Math.max(y1,y2));
 return right-x>=12&&bottom-y>=12?{x,y,width:right-x,height:bottom-y}:null;
}
export function coverSignature(image){
 const {width,height,data}=image||{};
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<9||height<8||
  !data||data.length<width*height*4)throw Error('A readable cover crop is needed');
 const pixel=(rx,ry)=>{
  const x=Math.min(width-1,Math.floor((rx+.5)*width/9));
  const y=Math.min(height-1,Math.floor((ry+.5)*height/8));
  const i=(y*width+x)*4;
  return .299*data[i]+.587*data[i+1]+.114*data[i+2];
 };
 const bits=[];
 for(let y=0;y<8;y++)for(let x=0;x<8;x++)
  bits.push(pixel(x,y)>pixel(x+1,y)?1:0);
 const colors=[];
 // 4x4 spatial color sample retains layout, not only average ink color.
 for(let y=0;y<4;y++)for(let x=0;x<4;x++){
  const px=Math.min(width-1,Math.floor((x+.5)*width/4));
  const py=Math.min(height-1,Math.floor((y+.5)*height/4));
  const i=(py*width+px)*4;
  colors.push(data[i],data[i+1],data[i+2]);
 }
 return {bits,colors};
}
export function visualCoverSimilarity(left,right){
 if(!left||!right||left.bits?.length!==64||right.bits?.length!==64||
  left.colors?.length!==48||right.colors?.length!==48)
  throw Error('Missing comparable cover signatures');
 let different=0,colors=0;
 for(let i=0;i<64;i++)if(left.bits[i]!==right.bits[i])different++;
 for(let i=0;i<48;i++)colors+=Math.abs(left.colors[i]-right.colors[i]);
 return Math.max(0,Math.min(1,
  .67*(1-different/64)+.33*(1-colors/(48*255))));
}
export function rankedCoverCandidates(source,books,{limit=5}={}){
 const scored=[];
 for(const book of books||[]){
  if(!book?.id||!book.signature)continue;
  const similarity=visualCoverSimilarity(source,book.signature);
  scored.push({bookId:book.id,title:book.title,author:book.author,
   coverId:book.cover_id,similarity:Number(similarity.toFixed(3))});
 }
 return scored.sort((a,b)=>b.similarity-a.similarity)
  .slice(0,Math.max(1,Math.min(5,limit)));
}
