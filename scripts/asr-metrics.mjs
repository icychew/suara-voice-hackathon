export function normalizedText(text) {
  if(typeof text!=='string') throw new TypeError('Transcript must be text');
  return text.normalize('NFKC').toLocaleLowerCase('en').replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/gu,' ').trim();
}
export function editDistance(reference,hypothesis) {
  let row=Array.from({length:hypothesis.length+1},(_,i)=>i);
  for(let i=1;i<=reference.length;i++) {
    const next=[i];
    for(let j=1;j<=hypothesis.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(reference[i-1]===hypothesis[j-1]?0:1));
    row=next;
  }
  return row[hypothesis.length];
}
export function scoreTranscript(reference,hypothesis,language) {
  if(!['en','zh'].includes(language)) throw new TypeError('Unsupported scoring language');
  const tokenize=text=>language==='zh'?Array.from(normalizedText(text).replace(/\s/gu,'')):normalizedText(text).split(' ').filter(Boolean);
  const ref=tokenize(reference),hyp=tokenize(hypothesis);
  if(!ref.length) throw new Error('Empty reference is not scoreable');
  const errors=editDistance(ref,hyp);
  return {metric:language==='zh'?'CER':'WER',errors,referenceUnits:ref.length,hypothesisUnits:hyp.length,rate:errors/ref.length};
}
