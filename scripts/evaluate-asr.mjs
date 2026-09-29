import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scoreTranscript} from './asr-metrics.mjs';
export const ASR_PROFILES = Object.freeze([
  {id:'universal-2',speech_models:['universal-2']},
  {id:'universal-3-5-pro',speech_models:['universal-3-5-pro']},
  {id:'oral-history-context',speech_models:['universal-3-5-pro'],
    prompt:'An oral-history interview about childhood, family shops, food, dates and everyday memories in Malaysia, in English or Mandarin.',
    keyterms_prompt:['Klang','Selangor','kuih','nasi lemak','巴生','雪兰莪','年糕']},
]);
export async function evaluateCorpus({manifestPath,outputDirectory,apiKey,execute=false,maxUsd=1}) {
  if(!isAbsolute(manifestPath||'')||!isAbsolute(outputDirectory||'')) throw new Error('Use absolute operator paths');
  const manifestText=await readFile(manifestPath,'utf8');
  const manifest=JSON.parse(manifestText);
  if(manifest.schema!=='suara.accuracy_corpus/1'||manifest.license!=='CC-BY-4.0'||!Array.isArray(manifest.items)||!manifest.items.length||manifest.items.length>60) throw new Error('Invalid bounded corpus');
  const ids=new Set(), hashes=new Set();
  for(const item of manifest.items) {
    if(ids.has(item.id)||hashes.has(item.sha256)) throw new Error('Duplicate audio or split leakage');
    ids.add(item.id); hashes.add(item.sha256);
  }
  const corpusRoot=dirname(resolve(manifestPath));
  const seconds=manifest.items.reduce((n,i)=>n+i.duration,0);
  const estimatedUpperUsd=seconds/3600 * 0.50 * ASR_PROFILES.length;
  if(!Number.isFinite(maxUsd)||maxUsd<=0||!Number.isFinite(estimatedUpperUsd)||estimatedUpperUsd<=0||estimatedUpperUsd>maxUsd||maxUsd>5) throw new Error('Budget refused');
  for(const item of manifest.items) {
    if(!['en','zh'].includes(item.language)||!['validation','test'].includes(item.split)||typeof item.reference!=='string'||!(item.duration>0&&item.duration<=40))throw new Error('Invalid item');
    const rel=relative(corpusRoot,resolve(corpusRoot,item.audio));
    if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe audio path');
    const bytes=await readFile(resolve(corpusRoot,item.audio));
    if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Audio changed');
  }
  const plan={schema:'suara.asr_evaluation/1',createdAt:new Date().toISOString(),items:manifest.items.length,
    manifestSha256:createHash('sha256').update(manifestText).digest('hex'),selection:manifest.selection,
    profiles:ASR_PROFILES,estimatedUpperUsd,maxUsd,source:manifest.source,license:manifest.license,
    scoring:'English normalized word errors; Mandarin normalized character errors; no numeric rewriting; micro averages by language and split.',
    limitation:'Small fixed read-speech subset; model training overlap unknown; not Malaysian oral-history or live-agent quality proof.'};
  await mkdir(outputDirectory,{recursive:true});
  // Exclusive plan file prevents accidental reruns/budget duplication in this directory.
  await writeFile(resolve(outputDirectory,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx'});
  if(!execute)return {...plan,status:'validated_no_provider_calls'};
  if(!apiKey)throw new Error('Provider key required');
  const base='https://api.assemblyai.com';
  const call=async(path,options={})=>{
    const response=await fetch(`${base}${path}`,{...options,headers:{authorization:apiKey,...options.headers},redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`provider_http_${response.status}`);
    return response.json();
  };
  const results=[];
  for(const split of ['validation','test'])for(const item of manifest.items.filter(i=>i.split===split)) {
    const uploaded=await call('/v2/upload',{method:'POST',headers:{'content-type':'application/octet-stream'},body:await readFile(resolve(corpusRoot,item.audio))});
    const uploadedUrl=new URL(uploaded.upload_url);
    if(uploadedUrl.protocol!=='https:'||!uploadedUrl.hostname.endsWith('.assemblyai.com'))throw new Error('Unexpected upload destination');
    for(const profile of ASR_PROFILES) {
      const {id:profileId,...parameters}=profile;
      const row={sample:item.id,language:item.language,split:item.split,profile:profileId,status:'pending'};
      await appendFile(resolve(outputDirectory,'attempts.jsonl'),JSON.stringify({...row,event:'submit',time:new Date().toISOString()})+'\n');
      let transcriptId;
      try {
        const submitted=await call('/v2/transcript',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({audio_url:uploaded.upload_url,language_code:item.language,...parameters})});
        transcriptId=submitted.id;
        if(typeof transcriptId!=='string'||!/^[\w-]+$/.test(transcriptId))throw new Error('invalid_provider_id');
        // Provider IDs remain private in the operator output for retrieval/deletion.
        await appendFile(resolve(outputDirectory,'provider-ids.jsonl'),JSON.stringify({sample:item.id,profile:profileId,id:transcriptId})+'\n');
        const deadline=Date.now()+180000;
        let result;
        do {
          if(Date.now()>deadline)throw new Error('provider_timeout');
          await new Promise(done=>setTimeout(done,1500));
          result=await call(`/v2/transcript/${transcriptId}`);
          if(result.status==='error')throw new Error('provider_transcription_failed');
        }while(result.status!=='completed');
        Object.assign(row,{status:'completed',score:scoreTranscript(item.reference,result.text||'',item.language),
          modelUsed:result.speech_model_used||result.speech_models||null,audioSeconds:result.audio_duration});
        // Only public-corpus hypotheses are kept here for error analysis; never user recordings.
        await appendFile(resolve(outputDirectory,'hypotheses.jsonl'),JSON.stringify({sample:item.id,profile:profileId,text:result.text})+'\n');
      }catch(error){row.status='failed';row.error=/^provider_|^invalid_provider_id/.test(error.message)?error.message:'sanitized_failure';}
      results.push(row);
      await appendFile(resolve(outputDirectory,'attempts.jsonl'),JSON.stringify({...row,event:'result'})+'\n');
      console.log(JSON.stringify({sample:row.sample,profile:row.profile,status:row.status,metric:row.score?.metric,errors:row.score?.errors,units:row.score?.referenceUnits}));
      if(row.status==='failed') {await writeFile(resolve(outputDirectory,'results.json'),JSON.stringify({plan,results,status:'incomplete'},null,2));throw new Error('Evaluation stopped; no automatic replacement calls');}
    }
  }
  const summary=[];
  for(const split of ['validation','test'])for(const language of ['en','zh'])for(const profile of ASR_PROFILES) {
    const selected=results.filter(r=>r.split===split&&r.language===language&&r.profile===profile.id);
    const errors=selected.reduce((n,r)=>n+r.score.errors,0),units=selected.reduce((n,r)=>n+r.score.referenceUnits,0);
    summary.push({split,language,profile:profile.id,clips:selected.length,errors,units,rate:errors/units});
  }
  const report={plan,results,summary,status:'complete',weightTrainingPerformed:false};
  await writeFile(resolve(outputDirectory,'results.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [manifestPath,outputDirectory,mode]=process.argv.slice(2);
    if(!['--validate','--run'].includes(mode)) throw new Error('Choose --validate or --run explicitly');
    const result=await evaluateCorpus({manifestPath,outputDirectory,apiKey:process.env.ASSEMBLYAI_API_KEY,execute:mode==='--run'});
    console.log(JSON.stringify({status:result.status,summary:result.summary,estimatedUpperUsd:result.plan?.estimatedUpperUsd??result.estimatedUpperUsd}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
