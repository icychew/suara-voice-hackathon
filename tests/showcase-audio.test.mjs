import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import manifest from '../src/showcase/audio-manifest.json' with {type:'json'};
import {LANE_FIXTURES} from '../src/showcase/fixture.js';
import {createSyntheticReviewExport} from '../src/showcase/export.js';
test('every playable sample matches its declared PCM duration, hash and script',async()=>{
  for(const [key,media] of Object.entries(manifest.lanes)) {
    assert.match(media.src,/^\/assets\/synthetic\/(en|ms|zh)-family-memory\.wav$/);
    const bytes=await readFile(new URL(`../public${media.src}`,import.meta.url));
    assert.equal(bytes.toString('ascii',0,4),'RIFF');
    assert.equal(bytes.readUInt32LE(24),24000);
    assert.equal((bytes.length-44)/48000,media.duration);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),media.sha256);
    assert.deepEqual(media.segments.map(s=>s.text),LANE_FIXTURES[key].segments.map(s=>s.text));
    media.segments.forEach((s,i)=>{assert.ok(s.start>=0&&s.end>s.start&&s.end<=media.duration);if(i)assert.ok(s.start>=media.segments[i-1].end);});
  }
});
test('synthetic export refuses unresolved or unapproved material and retains exact source',()=>{
  const lane=LANE_FIXTURES.en;
  const base={lane,reviewStates:{E1:'approved',E2:'excluded',E3:'approved'},selectedEvidence:['E1'],title:'Demo'};
  const text=createSyntheticReviewExport(base);
  assert.match(text,/SYNTHETIC DEMO — REVIEW ONLY/);
  assert.ok(text.includes(lane.segments[0].text));
  assert.ok(!text.includes(lane.segments[1].text));
  assert.throws(()=>createSyntheticReviewExport({...base,selectedEvidence:['E2']}));
  assert.throws(()=>createSyntheticReviewExport({...base,reviewStates:{...base.reviewStates,E3:'followup'}}));
});
