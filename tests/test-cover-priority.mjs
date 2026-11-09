import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {PREFERRED_BOOK_COVER_SQL,preferredDetailCoverId} from '../cover-priority.mjs';

const bid='11111111-1111-4111-8111-111111111111';
const normal='22222222-2222-4222-8222-222222222222';
const special='33333333-3333-4333-8333-333333333333';
const generic='44444444-4444-4444-8444-444444444444';
const seCover='55555555-5555-4555-8555-555555555555';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/001_initial_schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO books(id,title,author,normalized_title,normalized_author) VALUES(?,?,?,?,?)')
  .run(bid,'Example Book','Writer','example book','writer');
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,'Standard','ebook',0)")
  .run(normal,bid);
 sql.prepare("INSERT INTO editions(id,book_id,edition_name,format,is_special) VALUES (?,?,'FairyLoot Exclusive','hardcover',1)")
  .run(special,bid);
 sql.prepare("INSERT INTO edition_images(id,edition_id,role,origin,private_object_key,match_status,display_cover) VALUES (?,?,'cover','epub','covers/generic.jpg','unverified',1)")
  .run(generic,normal);
 sql.prepare("INSERT INTO edition_images(id,edition_id,role,origin,private_object_key,match_status,display_cover) VALUES (?,?,'cover','manual','covers/special.jpg','user_verified',0)")
  .run(seCover,special);
 const query=()=>sql.prepare('SELECT '+PREFERRED_BOOK_COVER_SQL+' AS cover_id FROM books b WHERE b.id=?')
  .get(bid).cover_id;
 return {sql,query,close:()=>sql.close()};
}
test('Verified saved special-edition art wins over generic selected EPUB cover',()=>{
 const f=fixture();
 try{
  assert.equal(f.query(),seCover);
  f.sql.prepare("UPDATE edition_images SET match_status='possible' WHERE id=?").run(seCover);
  assert.equal(f.query(),generic);
  f.sql.prepare("UPDATE edition_images SET match_status='user_verified' WHERE id=?").run(seCover);
  f.sql.prepare("UPDATE edition_images SET private_object_key=NULL,image_url='https://covers.openlibrary.org/b/id/123-M.jpg?default=false' WHERE id=?").run(seCover);
  assert.equal(f.query(),generic);
 }finally{f.close();}
});
test('Owner-verified special-edition cover priority requires no destructive cover changes',()=>{
 const f=fixture();
 try{
  const before=f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(generic);
  assert.equal(f.query(),seCover);
  const after=f.sql.prepare('SELECT display_cover FROM edition_images WHERE id=?').get(generic);
  assert.deepEqual(after,before);
  assert.equal(after.display_cover,1);
 }finally{f.close();}
});
test('Detail and grid cover preference agree, with owned special editions first',()=>{
 const f=fixture();
 try{
  const card={
   preferred_edition_id:null,
   editions:[
    {id:normal,is_special:0,copies:[],images:[
     {id:generic,display_cover:1,role:'cover',match_status:'unverified',
      has_saved_asset:1}]},
    {id:special,is_special:1,copies:[{medium:'physical',ownership:'owned'}],
     images:[{id:seCover,display_cover:0,role:'cover',
      match_status:'user_verified',has_saved_asset:1}]}
   ]
  };
  assert.equal(f.query(),seCover);
  assert.equal(preferredDetailCoverId(card),seCover);
  card.editions[1].images[0].match_status='possible';
  assert.equal(preferredDetailCoverId(card),generic);
 }finally{f.close();}
});
