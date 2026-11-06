import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createReview, ReviewStore } from '../assets/runtime/store.mjs';
import { startServer, sendT3 } from '../assets/runtime/server.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-work-platform-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd:repo, stdio:'ignore' });
  git('init','-b','develop'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'file.txt'),'fixture\n'); git('add','.'); git('commit','-m','fixture');
  const run = createReview({repo, home:path.join(root,'home'), branch:'develop', ...options});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,...run};
}

test('identity-bound authenticated shutdown closes cleanly and preserves state', async t => {
  const run = fixture(t); const service = await startServer({reviewDir:run.reviewDir});
  t.after(()=>service.close());
  const info=JSON.parse(fs.readFileSync(path.join(run.reviewDir,'server.json'),'utf8'));
  const payload={reviewId:info.reviewId,pid:info.pid,nonce:info.nonce};
  const landing=await fetch(service.url);const cookie=landing.headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:service.url,'Content-Type':'application/json'};
  const wrong=await fetch(service.url+'/api/shutdown',{method:'POST',headers,body:JSON.stringify({...payload,nonce:'wrong'})});
  assert.equal(wrong.status,409);
  const cross=await fetch(service.url+'/api/shutdown',{method:'POST',headers:{...headers,Origin:'https://example.invalid'},body:JSON.stringify(payload)});
  assert.equal(cross.status,403);
  const result=await fetch(service.url+'/api/shutdown',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(result.status,200);assert.equal((await result.json()).status,'stopping');
  await service.close();
  assert.equal(fs.existsSync(path.join(run.reviewDir,'server.json')),false);
  const db=new ReviewStore(run.reviewDir);assert.equal(db.manifest.id,run.manifest.id);db.close();
});

test('an explicit Electron launcher supplies Node-mode flags without arbitrary stored environment', async t => {
  const run=fixture(t,{deliveryMode:'t3',conversationId:'fixture-thread',t3Launcher:'electron',t3Command:[process.execPath]});
  assert.equal(run.manifest.t3Launcher,'electron');
  const script=path.join(run.root,'fake-t3.mjs');const result=path.join(run.root,'callback.json');
  fs.writeFileSync(script,`import fs from 'node:fs';let input='';for await(const x of process.stdin)input+=x;fs.writeFileSync(process.argv[2],JSON.stringify({electron:process.env.ELECTRON_RUN_AS_NODE,launcher:process.env.T3CODE_DESKTOP_CLI_LAUNCHER,args:process.argv.slice(3),input}));`);
  await sendT3({manifest:{...run.manifest,t3Command:[process.execPath,script,result]},reviewDir:run.reviewDir,batch:{id:'batch-fixture'}});
  const output=JSON.parse(fs.readFileSync(result,'utf8'));
  assert.equal(output.electron,'1');assert.equal(output.launcher,'1');
  assert.deepEqual(output.args,['thread','send','fixture-thread','-','--json']);
  assert.match(output.input,/batch-fixture/);
  assert.throws(()=>createReview({repo:path.join(run.root,'repo'),home:path.join(run.root,'home'),branch:'develop',t3Launcher:'arbitrary-env'}),/launcher/i);
});

test('custom T3 data directory is a thread-send flag and remains one argument', async t => {
  const run=fixture(t,{deliveryMode:'t3',conversationId:'fixture-thread',t3BaseDir:path.join(os.tmpdir(),'review-work custom data'),t3Command:[process.execPath]});
  const script=path.join(run.root,'strict-t3.mjs');const output=path.join(run.root,'callback.json');
  fs.writeFileSync(script,`import fs from 'node:fs';const args=process.argv.slice(3);if(args[0]!=='thread'||args[1]!=='send')process.exit(2);let input='';for await(const x of process.stdin)input+=x;fs.writeFileSync(process.argv[2],JSON.stringify({args,input}));`);
  await sendT3({manifest:{...run.manifest,t3Command:[process.execPath,script,output]},reviewDir:run.reviewDir,batch:{id:'custom-dir-batch'}});
  const sent=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.deepEqual(sent.args,['thread','send','--base-dir',run.manifest.t3BaseDir,'fixture-thread','-','--json']);
  assert.match(sent.input,/custom-dir-batch/);
});
