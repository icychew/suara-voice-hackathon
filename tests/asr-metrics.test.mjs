import test from 'node:test';
import assert from 'node:assert/strict';
import {editDistance,scoreTranscript} from '../scripts/asr-metrics.mjs';
test('ASR scores insertions, omissions and substitutions without hiding errors',()=>{
  assert.equal(scoreTranscript('we remember our shop','we remember the small shop','en').errors,2);
  assert.equal(scoreTranscript('we remember our shop','','en').rate,1);
  assert.equal(scoreTranscript('one','one two three','en').rate,2);
  assert.equal(editDistance([],['a','b']),2);
});
test('Mandarin CER does not depend on whitespace tokenization',()=>{
  assert.deepEqual(scoreTranscript('我在巴生长大。','我在巴生长大','zh'),{metric:'CER',errors:0,referenceUnits:6,hypothesisUnits:6,rate:0});
  assert.equal(scoreTranscript('我在巴生长大','我在巴黎长大','zh').errors,1);
  assert.throws(()=>scoreTranscript('','','en'),/Empty reference/);
  assert.throws(()=>scoreTranscript('a','a','ms'),/Unsupported/);
});
