// Build-time synthetic narration only. No provider credential or runtime TTS.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { LANE_FIXTURES } from '../src/showcase/fixture.js';
const run = promisify(execFile);
const python = process.argv[2];
if (!python) throw new Error('Supply the Python executable with edge-tts installed.');
const destination = resolve('public/assets/synthetic');
const temporary = resolve('tmp/audio-generation');
await mkdir(destination, { recursive: true });
await mkdir(temporary, { recursive: true });
const voices = { en: 'en-US-JennyNeural', ms: 'ms-MY-YasminNeural', zh: 'zh-CN-XiaoxiaoNeural' };
const sampleRate = 24000;
function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const manifest = { schema: 'suara.synthetic_audio/1', generator: 'edge-tts 7.2.8', sampleRate, synthetic: true, lanes: {} };
for (const [locale, lane] of Object.entries(LANE_FIXTURES)) {
  const chunks = [], segments = [];
  let bytes = 0;
  for (const segment of lane.segments) {
    const mp3 = join(temporary, `${locale}-${segment.id}.mp3`);
    const raw = join(temporary, `${locale}-${segment.id}.pcm`);
    await run(python, ['-m', 'edge_tts', '--voice', voices[locale], '--rate=-8%', '--text', segment.text, '--write-media', mp3], { timeout: 45000, windowsHide: true });
    await run('ffmpeg', ['-v','error','-y','-i',mp3,'-f','s16le','-ac','1','-ar',String(sampleRate),raw], { timeout: 30000, windowsHide: true });
    const pcm = await readFile(raw);
    if (!pcm.length || pcm.length % 2) throw new Error('Invalid generated PCM');
    const start = bytes / (sampleRate * 2);
    chunks.push(pcm); bytes += pcm.length;
    segments.push({ id:segment.id, start, end:bytes / (sampleRate * 2), text:segment.text });
    const gap = Buffer.alloc(sampleRate * 2 * 0.35); chunks.push(gap); bytes += gap.length;
  }
  const audio = wav(Buffer.concat(chunks));
  const file = `${locale}-family-memory.wav`;
  await writeFile(join(destination,file),audio);
  manifest.lanes[locale] = { src:`/assets/synthetic/${file}`, voice:voices[locale], duration:bytes/(sampleRate*2),
    sha256:createHash('sha256').update(audio).digest('hex'), segments };
  console.log(`${locale}: ${manifest.lanes[locale].duration.toFixed(2)} seconds, ${audio.length} bytes`);
}
await writeFile('src/showcase/audio-manifest.json',JSON.stringify(manifest,null,2)+'\n');
