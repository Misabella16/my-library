#!/usr/bin/env node
// My Library local launcher. ALL database actions are explicitly --local.
// The local binding and data paths are isolated from Cloudflare production.
import {spawnSync,spawn} from 'node:child_process';
import {cpSync,existsSync,mkdirSync,statSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildLocalRuntime} from './build-local.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const command=args[0]||'help';
const base=join(root,'.my-library-local');
const wrangler=join(root,'node_modules','.bin','wrangler');
function fail(message){console.error('\nMy Library local: '+message+'\n');process.exit(1);}
function requireWrangler(){
  if(!existsSync(wrangler))fail('Wrangler is not installed. Run npm install inside the my-library folder first.');
}
function call(args){
  const result=spawnSync(wrangler,args,{cwd:base,stdio:'inherit',shell:false,env:process.env});
  if(result.error)fail(result.error.message);
  if(result.status!==0)fail('Local command failed with status '+result.status);
}
function prep(){
  const result=buildLocalRuntime({root,base});
  requireWrangler();
  return result;
}
const cliArgs=(result)=>['--config',result.config];
const persistence=result=>['--persist-to',result.state];
function safeLocalDb(sql,result){
  call(['d1','execute','BOOK_DB','--local',...cliArgs(result),...persistence(result),
    '--file',sql,'--yes']);
}
function withInit(result) {
  const schema=join(root,'database','001_initial_schema.sql');
  if(!existsSync(schema))fail('Required database schema not found: '+schema);
  // IF NOT EXISTS makes initialization idempotent and preserves existing books.
  safeLocalDb(schema,result);
  const shelfSchema=join(root,'database','002_shelf_photo_scanning.sql');
  if(existsSync(shelfSchema))safeLocalDb(shelfSchema,result);
}
function localDbBackup(result) {
  const backups=join(base,'backups');
  mkdirSync(backups,{recursive:true});
  const name='library-backup-'+new Date().toISOString().replace(/[:.]/g,'-');
  const destination=join(backups,name);
  if(!existsSync(result.state))fail('No local data yet. Start My Library and add a book before backing up.');
  cpSync(result.state,destination,{recursive:true,errorOnExist:true,force:false});
  console.log('\nLocal database and file-state backup created:\n'+destination+'\n');
}
switch(command){
  case 'setup': {
    const r=prep();
    withInit(r);
    console.log('\nLocal My Library initialized safely. Use: npm run local:start\n');
    break;
  }
  case 'start': {
    const r=prep();
    console.log('\nStarting your private library at http://127.0.0.1:8788\n');
    console.log('Leave this Terminal window open. Press Control+C to close the local server.\n');
    console.log('Your data is on this Mac: '+r.state+'\n');
    const child=spawn(wrangler,
      ['pages','dev',r.runtime,'--config',r.config,'--ip','127.0.0.1','--port','8788',
        ...persistence(r),'--show-interactive-dev-session=false'],
      {cwd:base,stdio:'inherit',env:process.env,shell:false});
    child.on('error',e=>fail(e.message));
    child.on('exit',status=>{process.exitCode=status||0;});
    break;
  }
  case 'backup': {
    const r=prep();
    localDbBackup(r);
    break;
  }
  case 'restore-export': {
    const input=args[1];
    if(!input)fail('Provide a path to a SQL export. Example: npm run local:restore -- /Users/you/Downloads/my-library-export.sql');
    const full=resolve(input);
    if(!existsSync(full)||!full.toLowerCase().endsWith('.sql')||!statSync(full).isFile())
      fail('The export must be an existing .sql file.');
    const r=prep();
    const marker=join(base,'restore-completed.txt');
    if(existsSync(marker))fail('A previous restore was recorded. This protects against duplicate imports. Do not restore twice.');
    // An export contains schema plus data. Import it into a fresh local DB
    // only. Never overwrite a local collection that already has books.
    let rowCount=0;
    try{
      const check=spawnSync(wrangler,['d1','execute','BOOK_DB','--local',
        ...cliArgs(r),...persistence(r),'--command',
        "SELECT COUNT(*) AS n FROM books",'--json'],
        {cwd:base,encoding:'utf8'});
      if(check.status===0){
        const parsed=JSON.parse(check.stdout||'[]');
        const first=Array.isArray(parsed)?parsed[0]:parsed;
        rowCount=Number(first?.results?.[0]?.n||0);
      }
    }catch{}
    if(rowCount>0)fail('Local database already contains '+rowCount+
      ' books. Restore into a fresh local installation instead of overwriting them.');
    console.log('Importing a SQL export into the LOCAL D1 emulator only; this does not contact your live D1.');
    safeLocalDb(full,r);
    writeFileSync(marker,'Completed '+new Date().toISOString()+'\n',{mode:0o600});
    console.log('\nLocal data import completed. Your live My Library is untouched.');
    break;
  }
  case 'help':default:
    console.log([
      'My Library · private Mac local edition',
      '',
      'First time:',
      '  npm install',
      '  npm run local:setup',
      '  npm run local:start',
      '',
      'Then open http://127.0.0.1:8788 in Safari.',
      '  npm run local:backup       Back up local D1 and local R2 files',
      '  npm run local:restore -- /absolute/path/export.sql  Import a D1 SQL export',
      '',
      'The localhost-only version never runs remote Wrangler commands.',
      'Never publish .my-library-local or any exported SQL file to GitHub.'
    ].join('\n'));
}
