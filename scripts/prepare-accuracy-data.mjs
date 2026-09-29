// Public CC-BY-4.0 FLEURS subset. Audio stays in the explicitly named local folder.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error('Supply an absolute output directory.');
await mkdir(output,{recursive:true});
const dataset='google/fleurs', items=[];
const api='https://datasets-server.huggingface.co';
const splits=await (await fetch(`${api}/splits?dataset=${encodeURIComponent(dataset)}`,{signal:AbortSignal.timeout(60000)})).json();
const configs={en:'en_us',zh:'cmn_hans_cn'};
for(const [language,config] of Object.entries(configs)) {
  for(const split of ['validation','test']) {
    // The published test viewer currently returns 500/501. Freeze disjoint
    // development/holdout rows from the available validation split before calls.
    const sourceSplit='validation', offset=split==='validation'?0:10;
    if(!splits.splits?.some(s=>s.config===config&&s.split===sourceSplit)) throw new Error('Missing dataset split');
    const url=new URL(`${api}/rows`);
    Object.entries({dataset,config,split:sourceSplit,offset:String(offset),length:'3'}).forEach(([k,v])=>url.searchParams.set(k,v));
    console.log(`Preparing ${config}/${split}`);
    let response=await fetch(url,{signal:AbortSignal.timeout(60000)});
    if(response.status>=500) {
      const fallback=new URL(`${api}/first-rows`);
      Object.entries({dataset,config,split:sourceSplit}).forEach(([k,v])=>fallback.searchParams.set(k,v));
      response=await fetch(fallback,{signal:AbortSignal.timeout(60000)});
    }
    if(!response.ok) throw new Error(`Dataset metadata ${config}/${split} HTTP ${response.status}`);
    const data=await response.json();
    if(data.rows?.length<3) throw new Error('Incomplete dataset page');
    const chosen=data.rows.filter(row=>row.row_idx>=offset&&row.row_idx<offset+3);
    if(chosen.length!==3)throw new Error('Missing predeclared row range');
    for(const entry of chosen) {
      const row=entry.row, src=new URL(row.audio?.[0]?.src);
      if(src.protocol!=='https:'||src.hostname!=='datasets-server.huggingface.co') throw new Error('Unexpected media origin');
      const duration=row.num_samples/16000;
      if(!(duration>0&&duration<=40)) throw new Error('Audio duration outside declared budget');
      const media=await fetch(src,{signal:AbortSignal.timeout(60000)});
      if(!media.ok) throw new Error(`Dataset audio HTTP ${media.status}`);
      const bytes=Buffer.from(await media.arrayBuffer());
      if(bytes.length>4000000||bytes.toString('ascii',0,4)!=='RIFF') throw new Error('Invalid WAV');
      const id=`fleurs-${config}-${split}-${entry.row_idx}`;
      await writeFile(join(output,`${id}.wav`),bytes);
      items.push({id,language,config,split,sourceSplit,rowIndex:entry.row_idx,sourceId:row.id,
        revision:src.pathname.split('/--/')[1],audio:`${id}.wav`,duration,reference:row.raw_transcription,
        sha256:createHash('sha256').update(bytes).digest('hex')});
    }
  }
}
for(const language of Object.keys(configs)) {
  const dev=new Set(items.filter(i=>i.language===language&&i.split==='validation').map(i=>i.sourceId));
  if(items.some(i=>i.language===language&&i.split==='test'&&dev.has(i.sourceId))) throw new Error('Split leakage');
}
const manifest={schema:'suara.accuracy_corpus/1',dataset,license:'CC-BY-4.0',
  source:'https://huggingface.co/datasets/google/fleurs',
  attribution:'Conneau et al. (2022), FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech.',
  selection:'Published validation rows 0-2 for development, rows 10-12 for local holdout, English and Mandarin. Published test viewer unavailable (500/501); these are not the official FLEURS test split. Frozen before provider evaluation.',
  purpose:'ASR evaluation only; not participant recordings or weight training',items};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({items:items.length,seconds:items.reduce((n,i)=>n+i.duration,0),license:manifest.license}));
