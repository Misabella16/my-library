import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildLocalRuntime} from '../local-mac/build-local.mjs';

const repoRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
test('Mac local build stays separate from production and never copies live secrets',()=>{
  const base=mkdtempSync(join(tmpdir(),'my-library-local-test-'));
  try{
    const originalWorker=readFileSync(join(repoRoot,'_worker.js'),'utf8');
    const result=buildLocalRuntime({root:repoRoot,base});
    assert.equal(result.runtime,join(base,'site'));
    assert.ok(existsSync(join(result.runtime,'goodreads-ui.mjs')));
    assert.ok(existsSync(join(result.runtime,'pastoral.css')));
    assert.ok(existsSync(join(result.runtime,'index.html')));
    assert.ok(existsSync(join(result.runtime,'_worker.js')));
    const copy=readFileSync(join(result.runtime,'_worker.js'),'utf8');
    assert.ok(copy.includes('const access={ok:true}; // LOCAL GENERATED COPY ONLY.'));
    assert.ok(copy.includes("['localhost','127.0.0.1']"));
    assert.ok(!copy.includes('const access=await verifyAccess(request,env);'));
    assert.equal(readFileSync(join(repoRoot,'_worker.js'),'utf8'),originalWorker);
    assert.ok(readFileSync(join(result.runtime,'index.html'),'utf8').includes('Mac local edition'));
    assert.ok(!readFileSync(join(result.runtime,'index.html'),'utf8').includes('href="/_logout"'));
    const syntax=spawnSync(process.execPath,['--check',join(result.runtime,'_worker.js')],{
      encoding:'utf8'
    });
    assert.equal(syntax.status,0,syntax.stderr);
  }finally{rmSync(base,{recursive:true,force:true});}
});
test('Local Wrangler configuration uses placeholders and isolated emulator bindings',()=>{
  const base=mkdtempSync(join(tmpdir(),'my-library-local-config-'));
  try{
    const result=buildLocalRuntime({root:repoRoot,base});
    const config=JSON.parse(readFileSync(result.config,'utf8'));
    assert.equal(config.pages_build_output_dir,'./site');
    assert.equal(config.name,'my-library-local-only');
    assert.deepEqual(config.d1_databases.map(x=>x.binding),['BOOK_DB']);
    assert.equal(config.d1_databases[0].database_name,'my-library-local-only');
    assert.equal(config.d1_databases[0].preview_database_id,'BOOK_DB');
    assert.equal(config.r2_buckets[0].bucket_name,'my-library-private-local-only');
    assert.ok(!result.localWorker.includes('access@'));
    const ignores=readFileSync(join(repoRoot,'.gitignore'),'utf8');
    assert.ok(ignores.includes('.my-library-local/'));
  }finally{rmSync(base,{recursive:true,force:true});}
});
test('Mac launcher uses loopback and local-only D1 commands, never remote storage',()=>{
  const src=readFileSync(join(repoRoot,'local-mac','local.mjs'),'utf8');
  assert.ok(src.includes("'127.0.0.1'"));
  assert.ok(src.includes("'--local'"));
  assert.ok(src.includes("['d1','execute','BOOK_DB'"));
  assert.ok(src.includes("'--persist-to'"));
  assert.ok(!src.includes("'--remote'"));
  assert.ok(!src.includes('wrangler d1 delete'));
  const pkg=JSON.parse(readFileSync(join(repoRoot,'package.json'),'utf8'));
  for(const name of ['local:setup','local:start','local:backup','local:restore'])
    assert.ok(pkg.scripts[name]);
});
