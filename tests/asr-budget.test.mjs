import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {evaluateCorpus} from '../scripts/evaluate-asr.mjs';

test('evaluation validates hashes and refuses duplicate paid-run directories',async()=>{
  const root=await mkdtemp(join(tmpdir(),'suara-asr-'));
  try {
    const audio=Buffer.from('synthetic test-only bytes');
    await writeFile(join(root,'sample.wav'),audio);
    const item={id:'one',language:'en',split:'validation',reference:'hello',duration:1,audio:'sample.wav',sha256:createHash('sha256').update(audio).digest('hex')};
    const manifestPath=join(root,'manifest.json');
    await writeFile(manifestPath,JSON.stringify({schema:'suara.accuracy_corpus/1',license:'CC-BY-4.0',items:[item]}));
    const options={manifestPath,outputDirectory:join(root,'run')};
    const plan=await evaluateCorpus(options);
    assert.equal(plan.status,'validated_no_provider_calls');
    assert.match(plan.manifestSha256,/^[a-f0-9]{64}$/);
    await assert.rejects(evaluateCorpus(options),{code:'EEXIST'});
    await writeFile(join(root,'sample.wav'),'changed');
    await assert.rejects(evaluateCorpus({...options,outputDirectory:join(root,'other')}),/Audio changed/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('evaluation refuses overspend and development/holdout audio reuse before any paid call',async()=>{
  const root=await mkdtemp(join(tmpdir(),'suara-asr-'));
  try {
    const manifestPath=join(root,'manifest.json');
    const item={id:'one',duration:40,sha256:'same'};
    const manifest={schema:'suara.accuracy_corpus/1',license:'CC-BY-4.0',items:[item]};
    await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(evaluateCorpus({manifestPath,outputDirectory:join(root,'run'),maxUsd:0.001,execute:true}),/Budget refused/);
    await assert.rejects(evaluateCorpus({manifestPath,outputDirectory:join(root,'run'),maxUsd:NaN,execute:true}),/Budget refused/);
    manifest.items.push({...item,id:'two'});
    await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(evaluateCorpus({manifestPath,outputDirectory:join(root,'run'),execute:true}),/split leakage/);
  } finally {await rm(root,{recursive:true,force:true});}
});
