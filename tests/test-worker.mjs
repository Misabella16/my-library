import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker,{verifyAccess,findMatchingEdition,classifyDatabaseError} from '../_worker.js';

if(!globalThis.crypto) globalThis.crypto=webcrypto;
const team='https://book-tests.cloudflareaccess.com';
const env={ACCESS_TEAM_DOMAIN:team, ACCESS_AUD:'book-audience', OWNER_EMAIL:'owner@example.com'};
let privateKey, keyInfo, oldFetch;
const encode=v=>Buffer.from(v instanceof Uint8Array || v instanceof ArrayBuffer ? v : (typeof v==='string'?v:JSON.stringify(v))).toString('base64url');
async function jwt(overrides={},mutate=false) {
  const now=Math.floor(Date.now()/1000);
  const header={alg:'RS256',typ:'JWT',kid:'test-rsa'};
  const claims={iss:team,aud:['book-audience'],email:'owner@example.com',exp:now+600,iat:now-2,...overrides};
  const signed=encode(header)+'.'+encode(claims);
  const sig=await crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5'},privateKey,new TextEncoder().encode(signed));
  return signed+'.'+encode(Buffer.from(sig))+(mutate?'x':'');
}
function req(url,token,method='GET',value,origin){
  const headers={'Cf-Access-Jwt-Assertion':token};
  if(origin) headers.origin=origin;
  if(value!==undefined) headers['content-type']='application/json';
  return new Request(url,{method,headers,body:value===undefined?undefined:JSON.stringify(value)});
}
before(async()=>{
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  privateKey=keys.privateKey;
  keyInfo={...(await crypto.subtle.exportKey('jwk',keys.publicKey)),kid:'test-rsa',alg:'RS256',use:'sig'};
  oldFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,team+'/cdn-cgi/access/certs');
    return Response.json({keys:[keyInfo]});
  };
});

test('valid Cloudflare Access signature and exact owner email work',async()=>{
  const token=await jwt();
  assert.equal((await verifyAccess(req('https://books.example.com/api/session',token),env)).ok,true);
  const response=await worker.fetch(req('https://books.example.com/api/session',token),{...env,BOOK_DB:{}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).owner,true);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('Cloudflare D1 quota and temporary errors are classified without leaking SQL',async()=>{
  const read="Your account has exceeded D1's free tier daily row read limit.";
  const write="Your account has exceeded D1's free tier daily row write limit.";
  const nested=new Error('D1_ERROR: request failed');
  nested.cause=new Error(read);
  const category=classifyDatabaseError(nested);
  assert.equal(category.code,'database_read_quota');
  assert.equal(category.retryable,false);
  assert.match(category.reset_utc,/T00:00:00\\.000Z$/);
  assert.equal(JSON.stringify(category).includes('D1_ERROR'),false);
  assert.equal(classifyDatabaseError(new Error(write)).code,'database_write_quota');
  assert.equal(classifyDatabaseError(new Error('D1 DB is overloaded. Requests queued for too long.')).code,
    'database_temporarily_unavailable');
  assert.equal(classifyDatabaseError(new Error('Secret SQL error: SELECT private_notes')).code,undefined);
});

test('Authenticated database-health request returns clear daily quota or transient error',async()=>{
  const token=await jwt();
  const readings=[
    ["Your account has exceeded D1's free tier daily row read limit.",'database_read_quota'],
    ["Your account has exceeded D1's free tier daily row write limit.",'database_write_quota'],
    ['D1 DB is overloaded. Requests queued for too long.','database_temporarily_unavailable']
  ];
  for(const [message,expected] of readings){
    const db={prepare(){throw Error(message);}};
    const response=await worker.fetch(req('https://books.example.com/api/health',token),{...env,BOOK_DB:db});
    assert.equal(response.status,503);
    const result=await response.json();
    assert.equal(result.code,expected);
    assert.ok(!JSON.stringify(result).includes('D1 DB'));
  }
  const okDb={prepare:()=>({bind:()=>({first:async()=>({ok:1})})})};
  const success=await worker.fetch(req('https://books.example.com/api/health',token),{...env,BOOK_DB:okDb});
  assert.equal(success.status,200);
  assert.equal((await success.json()).database,'connected');
});

test('Cloudflare signing-key fetch errors have a specific safe code',async()=>{
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{throw Error('network failure with private detail');};
    const token=await jwt();
    const badEnv={...env,ACCESS_TEAM_DOMAIN:'https://different-team.cloudflareaccess.com'};
    // A token with a different issuer gets denied before attempting to fetch keys.
    assert.equal((await verifyAccess(req('https://books.example.com/',token),badEnv)).reason,'team_domain_mismatch');
    // A team-shaped test token advances to the key-fetch stage.
    const signedForNewTeam=await jwt({iss:'https://different-team.cloudflareaccess.com'});
    const failed=await verifyAccess(req('https://books.example.com/',signedForNewTeam),badEnv);
    assert.deepEqual(failed,{ok:false,reason:'signing_keys_fetch_failed'});
    assert.equal(JSON.stringify(failed).includes('private detail'),false);
  } finally {globalThis.fetch=originalFetch;}
});

test('invalid Access configuration is diagnosed without exposing values',async()=>{
  const request=new Request('https://books.example.com/api/session');
  for(const [changes, reason] of [
    [{ACCESS_TEAM_DOMAIN:'https://not-a-team.invalid'},'config_team_domain'],
    [{ACCESS_TEAM_DOMAIN:'books.cloudflareaccess.com'},'config_team_domain'],
    [{ACCESS_TEAM_DOMAIN:''},'config_team_domain'],
    [{ACCESS_AUD:' '},'config_audience'],
    [{OWNER_EMAIL:' '},'config_owner_email'],
    [{OWNER_EMAIL:'not-an-email'},'config_owner_email']
  ]) {
    const result=await verifyAccess(request,{...env,...changes});
    assert.deepEqual(result,{ok:false,reason});
    assert.equal(JSON.stringify(result).includes('not-an-email'),false);
  }
});

test('invalid audience, issuer, owner, expiry and tampering are all denied',async()=>{
  for(const [claims, reason] of [
    [{aud:'wrong-audience'},'audience_mismatch'],
    [{iss:'https://evil.example'},'team_domain_mismatch'],
    [{email:'friend@example.com'},'owner_email_mismatch'],
    [{exp:Math.floor(Date.now()/1000)-10},'claims_invalid'],
    [{nbf:Math.floor(Date.now()/1000)+500},'claims_invalid']
  ]) {
    const result=await verifyAccess(req('https://books.example.com/',await jwt(claims)),env);
    assert.equal(result.ok,false);
    assert.equal(result.reason,reason);
  }
  assert.equal((await verifyAccess(req('https://books.example.com/',await jwt({},true)),env)).ok,false);
  assert.equal((await verifyAccess(new Request('https://books.example.com/'),env)).ok,false);
});

test('private API and static assets require owner authentication',async()=>{
  let served=false;
  const config={...env,BOOK_DB:{},ASSETS:{fetch:async()=>{served=true;return new Response('private files')}}};
  const missing=await worker.fetch(new Request('https://books.example.com/'),config);
  assert.equal(missing.status,403);assert.equal(served,false);
  const bad=await worker.fetch(req('https://books.example.com/api/books',await jwt({email:'other@example.com'})),config);
  assert.equal(bad.status,403);
  const good=await worker.fetch(req('https://books.example.com/',await jwt()),config);
  assert.equal(good.status,200);assert.equal(served,true);
  assert.match(good.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});

test('rejected owner sessions reveal only an actionable non-secret code',async()=>{
  const badEnv={...env,BOOK_DB:{}};
  const invalidEmail=await worker.fetch(
    req('https://books.example.com/',await jwt({email:'not-owner@example.com'})),badEnv);
  assert.equal(invalidEmail.status,403);
  assert.deepEqual(await invalidEmail.json(),{
    error:'Private owner authentication required',
    code:'owner_email_mismatch'
  });
  const wrongAudience=await worker.fetch(
    req('https://books.example.com/',await jwt({aud:'wrong'})),badEnv);
  assert.equal((await wrongAudience.json()).code,'audience_mismatch');
  const noToken=await worker.fetch(new Request('https://books.example.com/'),badEnv);
  const payload=await noToken.json();
  assert.equal(payload.code,'missing');
  assert.equal(JSON.stringify(payload).includes('owner@example.com'),false);
  assert.equal(noToken.headers.get('cache-control'),'no-store');
});

test('cross-origin write requests are rejected before data access',async()=>{
  const token=await jwt();
  const request=req('https://books.example.com/api/books',token,'POST',{title:'New Book'},'https://attacker.example');
  const response=await worker.fetch(request,{...env,BOOK_DB:{}});
  assert.equal(response.status,403);
  const missingOrigin=req('https://books.example.com/api/books',token,'POST',{title:'New Book'});
  assert.equal((await worker.fetch(missingOrigin,{...env,BOOK_DB:{}})).status,403);
});

test('book notes can be updated only via an authenticated same-origin request',async()=>{
  const bookId='11111111-2222-4333-8444-555555555555';
  const current={id:bookId,title:'Sample',author:'Writer',normalized_title:'sample',normalized_author:'writer',
    private_notes:'Old note',updated_at:'2026-11-05T17:00:00.000Z'};
  let audit=0;
  const db={
    prepare(sql) {
      return {bind(...values) {
        return {
          async first(){
            if(sql.startsWith('SELECT * FROM books WHERE id=?')) return {...current};
            return null;
          },
          async run(){
            if(sql.startsWith('UPDATE books SET ')) {
              assert.equal(values[values.length-2],bookId);
              assert.equal(values[values.length-1],current.updated_at);
              current.private_notes=values[0];
              current.updated_at=values[1];
              return {meta:{changes:1}};
            }
            if(sql.startsWith('INSERT INTO change_log ')) {audit++;return {meta:{changes:1}};}
            throw Error('Unexpected SQL '+sql);
          }
        };
      }};
    }
  };
  const token=await jwt();
  const res=await worker.fetch(req('https://books.example.com/api/books/'+bookId,token,'PATCH',
    {private_notes:'A private margin note',expected_updated_at:current.updated_at},'https://books.example.com'),{...env,BOOK_DB:db});
  assert.equal(res.status,200,await res.clone().text());
  const result=await res.json();
  assert.equal(result.item.private_notes,'A private margin note');
  assert.equal(current.private_notes,'A private margin note');
  assert.equal(audit,1);
  const conflict=await worker.fetch(req('https://books.example.com/api/books/'+bookId,token,'PATCH',
    {private_notes:'Stale note',expected_updated_at:'2020-01-01'},'https://books.example.com'),{...env,BOOK_DB:db});
  assert.equal(conflict.status,409);
  assert.equal(current.private_notes,'A private margin note');
});

test('edition identity matching reuses exact ISBNs and equivalent edition names',()=>{
  const current=[
    {id:'fairy',edition_name:'FairyLoot Exclusive',vendor:'FairyLoot',isbn:'978-1-234-56789-0',format:'hardcover',is_special:1},
    {id:'standard',edition_name:'Standard',vendor:'Bookshop A',isbn:'',format:'paperback',is_special:0}
  ];
  assert.equal(findMatchingEdition(current,{edition_name:'Different text',vendor:'Other store',
    isbn:'9781234567890',format:'hardcover',is_special:1})?.id,'fairy');
  assert.equal(findMatchingEdition(current,{edition_name:'fairyloot-exclusive',vendor:'fairy loot',
    isbn:'',format:'hardcover',is_special:1})?.id,'fairy');
  assert.equal(findMatchingEdition(current,{edition_name:'Standard Edition',vendor:'Bookshop B',
    isbn:'',format:'paperback',is_special:0})?.id,'standard');
  assert.equal(findMatchingEdition(current,{edition_name:'Illumicrate Exclusive',vendor:'Illumicrate',
    isbn:'',format:'hardcover',is_special:1}),null);
  assert.equal(findMatchingEdition(current,{edition_name:'FairyLoot Exclusive',vendor:'FairyLoot',
    isbn:'',format:'hardcover',is_special:1},'fairy'),null);
});

test('adding an existing edition returns a conflict without inserting',async()=>{
  const bookId='11111111-2222-4333-8444-555555555555';
  const existing={id:'22222222-3333-4444-8555-666666666666',edition_name:'FairyLoot Edition',
    vendor:'FairyLoot',isbn:'978-1-234-56789-0',format:'hardcover',is_special:1};
  let inserts=0;
  const db={prepare(sql){return {bind(...values){return {
    async first(){if(sql.startsWith('SELECT id FROM books WHERE id=?'))return {id:bookId};throw Error('Unexpected select '+sql);},
    async all(){if(sql.startsWith('SELECT id,edition_name,vendor,isbn,format,is_special FROM editions'))return {results:[existing]};throw Error('Unexpected list '+sql);},
    async run(){inserts++;throw Error('Must not insert duplicate');}
  };}};}};
  const response=await worker.fetch(req('https://books.example.com/api/books/'+bookId+'/editions',
    await jwt(),'POST',{edition_name:'Fairyloot edition',vendor:'fairyloot',format:'hardcover',
      is_special:true},'https://books.example.com'),{...env,BOOK_DB:db});
  assert.equal(response.status,409,await response.clone().text());
  assert.equal((await response.json()).existing_edition_id,existing.id);
  assert.equal(inserts,0);
});

test('logout is available even when the library rejects the current identity',async()=>{
  const anon=await worker.fetch(new Request('https://books.example.com/_logout'),{...env});
  assert.equal(anon.status,303);
  assert.equal(anon.headers.get('location'),'/cdn-cgi/access/logout');
  assert.match(anon.headers.get('set-cookie'),/CF_Authorization=; Max-Age=0/);
  assert.equal(anon.headers.get('cache-control'),'no-store');
  assert.equal(await anon.text(),'');
  const wrongAccount=await worker.fetch(
    req('https://books.example.com/_logout',await jwt({email:'another@example.com'})),{...env,BOOK_DB:{}});
  assert.equal(wrongAccount.status,303);
  const badConfig=await worker.fetch(new Request('https://books.example.com/_logout'),{...env,ACCESS_TEAM_DOMAIN:'https://elsewhere.invalid'});
  assert.equal(badConfig.status,303);
  assert.equal(badConfig.headers.get('location'),'/cdn-cgi/access/logout');
  const withoutConfig=await worker.fetch(new Request('https://books.example.com/_logout'),{});
  assert.equal(withoutConfig.status,303);
  assert.equal(withoutConfig.headers.get('location'),'/cdn-cgi/access/logout');
  const post=await worker.fetch(new Request('https://books.example.com/_logout',{method:'POST'}),{...env});
  assert.equal(post.status,405);
  const noAuth=await worker.fetch(new Request('https://books.example.com/'),{...env,BOOK_DB:{},ASSETS:{fetch:async()=>new Response('private')}});
  assert.equal(noAuth.status,403);
});
