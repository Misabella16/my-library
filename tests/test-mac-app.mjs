import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync,existsSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {launcherScript,stopScript,makeApps} from '../local-mac/make-mac-app.mjs';

test('launcher quotes odd folder names and only talks to the loopback site',()=>{
 const root="/Users/x/My Library/it's mine";
 const s=launcherScript(root,'/usr/local/bin');
 assert.match(s,/LIB=\$\{MY_LIBRARY_ROOT:-'\/Users\/x\/My Library\/it'\\''s mine'\}/);
 assert.match(s,/http:\/\/127\.0\.0\.1:8788\//);
 assert.match(s,/npm run local:start/);
 assert.match(s,/arch -arm64/);
 assert.match(s,/--app="\$URL"/);
 assert.match(s,/\/usr\/bin\/open "\$URL"/);
 assert.doesNotMatch(s,/--remote|wrangler deploy|d1 execute/);
 const syntax=spawnSync('/bin/bash',['-n'],{input:s});
 assert.equal(syntax.status,0,String(syntax.stderr));
 const stop=stopScript(root);
 assert.match(stop,/pkill -f -- "--persist-to \$LIB\/\.my-library-local\/state"/);
 assert.equal(spawnSync('/bin/bash',['-n'],{input:stop}).status,0);
});

test('apps are built as executable bundles with a Desktop shortcut',()=>{
 const dir=mkdtempSync(join(tmpdir(),'my-library-app-'));
 try{
  const made=makeApps({root:'/tmp/lib',out:dir,desktop:dir,nodeDir:'/usr/local/bin'});
  const exe=join(made.open,'Contents','MacOS','MyLibrary');
  assert.ok(statSync(exe).mode&0o100);
  assert.match(readFileSync(join(made.open,'Contents','Info.plist'),'utf8'),/<string>arm64<\/string>/);
  assert.ok(existsSync(join(made.stop,'Contents','MacOS','StopMyLibrary')));
  assert.equal(readlinkSync(made.shortcut),made.open);
  // Rebuilding replaces the shortcut instead of failing.
  assert.ok(makeApps({root:'/tmp/lib',out:dir,desktop:dir,nodeDir:'/usr/local/bin'}).shortcut);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
