#!/usr/bin/env node
// Build a temporary, loopback-only copy of My Library for Wrangler + local D1/R2.
// Nothing here modifies the deployed _worker.js or makes Cloudflare API calls.
import {readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const repoRoot=resolve(here,'..');
const ALLOWED=new Set(['.html','.css','.js','.mjs','.svg','.png','.jpg','.jpeg','.webp','.ico']);
const PLACEHOLDER_UUID='00000000-0000-4000-8000-000000000001';

export function buildLocalRuntime({root=repoRoot,base=join(repoRoot,'.my-library-local')}={}){
  const runtime=join(base,'site'),state=join(base,'state');
  mkdirSync(runtime,{recursive:true});
  mkdirSync(state,{recursive:true});

  let copied=0;
  for(const entry of readdirSync(root,{withFileTypes:true})){
    if(!entry.isFile()||!ALLOWED.has(extname(entry.name).toLowerCase()))continue;
    // Never copy source _worker.js directly. A controlled, local-only
    // copy is created below; production auth remains unchanged.
    if(entry.name==='_worker.js')continue;
    copyFileSync(join(root,entry.name),join(runtime,entry.name));copied++;
  }
  const source=readFileSync(join(root,'_worker.js'),'utf8');
  const authMarker='    const access=await verifyAccess(request,env);';
  const configMarker='    if(!env.BOOK_DB || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN || !env.OWNER_EMAIL)';
  const routeMarker='    const path=new URL(request.url).pathname;';
  if(!source.includes(authMarker)||!source.includes(configMarker)||!source.includes(routeMarker))
    throw Error('The production Worker changed. Refusing to generate a potentially unsafe local copy.');
  let local=source.replace(authMarker,
    '    const access={ok:true}; // LOCAL GENERATED COPY ONLY. No Cloudflare Access on loopback.');
  local=local.replace(configMarker,'    if(!env.BOOK_DB)');
  local=local.replace(routeMarker,routeMarker+
    "\n    // This guard is in the generated local copy only, never in production.\n"+
    "    // Wrangler must also listen exclusively on 127.0.0.1.\n"+
    "    if(!['localhost','127.0.0.1'].includes(new URL(request.url).hostname))\n"+
    "      return secureHeaders(fail('This private local library is only available on this Mac.',403),true);");
  writeFileSync(join(runtime,'_worker.js'),local,{mode:0o600});

  // The local copy has no external Access session. Remove the production
  // logout control rather than pretending logging out protects local files.
  const indexPath=join(runtime,'index.html');
  if(existsSync(indexPath)){
    let html=readFileSync(indexPath,'utf8');
    const original='<a class="btn subtle" href="/_logout">Log out</a>';
    if(!html.includes(original))throw Error('Could not safely replace the production logout control.');
    html=html.replace(original,
      '<span class="btn subtle" title="Only this Mac can access the running local site">Mac local edition</span>');
    html=html.replace('<title>My Library | A Garden of Stories</title>',
      '<title>My Library | Local Mac Edition</title>');
    writeFileSync(indexPath,html,{mode:0o600});
  }
  const uiPath=join(runtime,'library.js');
  if(existsSync(uiPath)){
    const ui=readFileSync(uiPath,'utf8').replaceAll(
      'Owner session verified · Private library connected',
      'Mac local edition · Stored on this computer');
    writeFileSync(uiPath,ui,{mode:0o600});
  }
  // These names are intentionally different from every production resource.
  // The UUID is a local emulator placeholder, NEVER a deployable database ID.
  const wrangler={
    name:'my-library-local-only',
    compatibility_date:'2026-11-01',
    pages_build_output_dir:'./site',
    d1_databases:[{
      binding:'BOOK_DB',database_name:'my-library-local-only',
      database_id:PLACEHOLDER_UUID,preview_database_id:'BOOK_DB'
    }],
    r2_buckets:[{binding:'BOOK_FILES',bucket_name:'my-library-private-local-only'}],
    vars:{
      ACCESS_AUD:'local-disabled',ACCESS_TEAM_DOMAIN:'https://local-only.cloudflareaccess.com',
      OWNER_EMAIL:'owner@localhost.invalid'
    }
  };
  const config=join(base,'wrangler.jsonc');
  writeFileSync(config,JSON.stringify(wrangler,null,2)+'\n',{mode:0o600});
  return {root,base,runtime,state,config,copied,localWorker:local};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const done=buildLocalRuntime();
  process.stdout.write('Prepared '+done.copied+' library assets for local Mac use.\n'+
    'Local database and storage: '+done.state+'\n'+
    'Cloudflare production and private login code were not changed.\n');
}
