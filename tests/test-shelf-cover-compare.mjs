import test from 'node:test';
import assert from 'node:assert/strict';
import {cropBounds,coverSignature,visualCoverSimilarity,rankedCoverCandidates}
 from '../shelf-cover-compare.mjs';
const solid=(r,g,b)=>{
 const width=90,height=80,data=new Uint8ClampedArray(width*height*4);
 for(let i=0;i<data.length;i+=4){data[i]=r;data[i+1]=g;data[i+2]=b;data[i+3]=255;}
 return {width,height,data};
};
const striped=(invert=false)=>{
 const image=solid(0,0,0);
 for(let y=0;y<80;y++)for(let x=0;x<90;x++){
  const bright=(Math.floor(x/10)+Math.floor(y/10))%2===0;
  const value=(bright!==invert)?245:18;
  const index=(y*90+x)*4;image.data[index]=value;
  image.data[index+1]=value;image.data[index+2]=value;
 }
 return image;
};
test('Cover crop bounds normalize drag direction and reject empty or tiny crops',()=>{
 assert.deepEqual(cropBounds({x:93,y:80},{x:12,y:17},100,100),
  {x:12,y:17,width:81,height:63});
 assert.deepEqual(cropBounds({x:-10,y:5},{x:130,y:110},100,100),
  {x:0,y:5,width:100,height:95});
 assert.equal(cropBounds({x:1,y:1},{x:5,y:5},100,100),null);
 assert.equal(cropBounds({x:3,y:3},{x:34,y:35},0,100),null);
});
test('Local artwork fingerprints compare identical images and distinguish different visual layouts',()=>{
 const warm=coverSignature(striped());
 const same=coverSignature(striped());
 const different=coverSignature(striped(true));
 assert.equal(warm.bits.length,64);
 assert.equal(warm.colors.length,48);
 assert.equal(visualCoverSimilarity(warm,same),1);
 assert.ok(visualCoverSimilarity(warm,different)<.75);
 assert.throws(()=>coverSignature({width:0,height:0,data:[]}));
});
test('Rank candidate covers, cap suggestions at five, without assuming ownership or edition identity',()=>{
 const picture=coverSignature(striped());
 const different=coverSignature(solid(180,10,25));
 const ranked=rankedCoverCandidates(picture,[
  {id:'weak',title:'Another edition',cover_id:'weak-cover',signature:different},
  {id:'strong',title:'The photographed book',cover_id:'strong-cover',signature:picture},
  {id:'no-art',title:'No cover'}
 ],{limit:5});
 assert.equal(ranked.length,2);
 assert.equal(ranked[0].bookId,'strong');
 assert.equal(ranked[0].similarity,1);
 assert.ok(ranked[1].similarity<ranked[0].similarity);
 assert.ok(!Object.hasOwn(ranked[0],'ownership'));
 assert.ok(!Object.hasOwn(ranked[0],'editionId'));
});
