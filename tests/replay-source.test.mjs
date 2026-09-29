import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReplaySource } from "../src/research/replaySource.js";

function tag(view, offset, text) {
  for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

function format(overrides = {}) {
  const values = { size: 16, encoding: 1, channels: 1, rate: 48_000, byteRate: 96_000, alignment: 2, bits: 16, extra: 0, ...overrides };
  const bytes = new Uint8Array(values.size);
  const view = new DataView(bytes.buffer);
  if (values.size >= 16) {
    view.setUint16(0, values.encoding, true);
    view.setUint16(2, values.channels, true);
    view.setUint32(4, values.rate, true);
    view.setUint32(8, values.byteRate, true);
    view.setUint16(12, values.alignment, true);
    view.setUint16(14, values.bits, true);
  }
  if (values.size >= 18) view.setUint16(16, values.extra, true);
  return bytes;
}

function pcm(frames = 2_400, sample = () => 0) {
  const bytes = new Uint8Array(frames * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < frames; index += 1) view.setInt16(index * 2, sample(index), true);
  return bytes;
}

function riff(chunks) {
  const length = 12 + chunks.reduce((sum, [, bytes]) => sum + 8 + bytes.length + bytes.length % 2, 0);
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  tag(view, 0, "RIFF");
  view.setUint32(4, length - 8, true);
  tag(view, 8, "WAVE");
  let offset = 12;
  for (const [name, bytes] of chunks) {
    tag(view, offset, name);
    view.setUint32(offset + 4, bytes.length, true);
    new Uint8Array(buffer, offset + 8, bytes.length).set(bytes);
    offset += 8 + bytes.length + bytes.length % 2;
  }
  return buffer;
}

function wav(frames = 2_400, sample = () => 0, overrides = {}) {
  return riff([["fmt ", format(overrides)], ["data", pcm(frames, sample)]]);
}

function resizeRiff(buffer, length) {
  const result = new ArrayBuffer(length);
  new Uint8Array(result).set(new Uint8Array(buffer, 0, Math.min(length, buffer.byteLength)));
  new DataView(result).setUint32(4, length - 8, true);
  return result;
}

function readSamples(buffer) {
  const view = new DataView(buffer);
  return Array.from({ length: buffer.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
}

function allSamples(source, rate) {
  return Array.from({ length: source.metadata.chunkCount }, (_, index) => readSamples(source.frameAt(rate, index))).flat();
}

function reference(samples, rate) {
  const step = 48_000 / rate;
  const cutoff = 0.45 / step;
  const coefficients = Array.from({ length: 63 }, (_, tap) => {
    const distance = tap - 31;
    const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
    return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * tap / 62));
  });
  const sum = coefficients.reduce((value, coefficient) => value + coefficient, 0);
  return Array.from({ length: samples.length / step }, (_, index) => {
    let value = 0;
    for (let tap = 0; tap < 63; tap += 1) value += (samples[index * step - tap] ?? 0) * (coefficients[tap] / sum);
    return Math.max(-32_768, Math.min(32_767, Math.round(value)));
  });
}

test("minimum replay has an exact frozen metadata contract and fixed-size silent frames", async () => {
  const input = wav();
  const source = await createReplaySource(input);
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(source.metadata));
  assert.deepEqual(Object.keys(source).sort(), ["frameAt", "metadata"]);
  assert.deepEqual(source.metadata, {
    schema: 1,
    sourceSha256: createHash("sha256").update(new Uint8Array(input)).digest("hex"),
    sourceRateHz: 48_000,
    sourceFrames: 2_400,
    durationMs: 50,
    chunkMs: 50,
    chunkCount: 1,
    conversion: "fir63-hamming-causal-v1",
    filterDelaySourceFrames: 31,
  });
  assert.match(source.metadata.sourceSha256, /^[a-f0-9]{64}$/);
  for (const [rate, bytes] of [[16_000, 1_600], [24_000, 2_400]]) {
    const frame = source.frameAt(rate, 0);
    assert.ok(frame instanceof ArrayBuffer);
    assert.equal(frame.byteLength, bytes);
    assert.ok(new Uint8Array(frame).every((value) => value === 0));
  }
  assert.throws(() => { source.metadata.durationMs = 1; }, TypeError);
  assert.throws(() => { source.frameAt = () => null; }, TypeError);
});

test("exact 60-second boundary is accepted without a padded filter tail", async () => {
  const source = await createReplaySource(wav(48_000 * 60));
  assert.equal(source.metadata.sourceFrames, 2_880_000);
  assert.equal(source.metadata.durationMs, 60_000);
  assert.equal(source.metadata.chunkCount, 1_200);
  assert.equal(source.frameAt(16_000, 1_199).byteLength, 1_600);
  assert.equal(source.frameAt(24_000, 1_199).byteLength, 2_400);
  assert.throws(() => source.frameAt(16_000, 1_200), RangeError);
});

test("empty, too short, partial final chunks, and over-60-second audio are rejected", async () => {
  for (const frames of [0, 1, 2_399, 2_401, 4_799, 48_000 * 60 + 2_400]) {
    await assert.rejects(createReplaySource(wav(frames)), /complete PCM16/);
  }
});

test("input must be an owned ArrayBuffer, not a view, object, or shared buffer", async () => {
  const input = wav();
  for (const value of [undefined, null, {}, new Uint8Array(input), new DataView(input), "audio.wav", new SharedArrayBuffer(input.byteLength)]) {
    await assert.rejects(createReplaySource(value), TypeError);
  }
  const detached = wav();
  structuredClone(detached, { transfer: [detached] });
  await assert.rejects(createReplaySource(detached), TypeError);
});

test("the entire WAV byte budget is at most 6,000,000 before copying", async () => {
  await assert.rejects(createReplaySource(new ArrayBuffer(6_000_001)), TypeError);
  const exact = riff([["fmt ", format()], ["JUNK", new Uint8Array(5_995_148)], ["data", pcm()]]);
  assert.equal(exact.byteLength, 6_000_000);
  assert.equal((await createReplaySource(exact)).metadata.durationMs, 50);
});

test("fmt PCM extension of exactly two zero bytes is accepted", async () => {
  const source = await createReplaySource(wav(2_400, () => 0, { size: 18 }));
  assert.equal(source.metadata.chunkCount, 1);
});

test("bounded unknown chunks and odd-byte padding are ignored but included in the full-file hash", async () => {
  const metadata = new TextEncoder().encode("synthetic private metadata");
  const input = riff([["JUNK", metadata], ["fmt ", format()], ["data", pcm()], ["LIST", new Uint8Array([1, 2, 3])]]);
  const source = await createReplaySource(input);
  assert.equal(source.metadata.sourceSha256, createHash("sha256").update(new Uint8Array(input)).digest("hex"));
  assert.notEqual(source.metadata.sourceSha256, (await createReplaySource(wav())).metadata.sourceSha256);
  assert.equal(JSON.stringify(source.metadata).includes("private"), false);
  assert.deepEqual(source.frameAt(16_000, 0), (await createReplaySource(wav())).frameAt(16_000, 0));
});

test("zero-length unknown chunks advance safely and data need not precede or follow metadata", async () => {
  const input = riff([["data", pcm()], ["JUNK", new Uint8Array()], ["fmt ", format()], ["LIST", new Uint8Array()]]);
  assert.equal((await createReplaySource(input)).metadata.sourceFrames, 2_400);
});

for (const [label, change] of [
  ["non-RIFF", (view) => tag(view, 0, "RF64")],
  ["non-WAVE", (view) => tag(view, 8, "AVI ")],
  ["too-small RIFF length", (view) => view.setUint32(4, view.byteLength - 10, true)],
  ["too-large RIFF length", (view) => view.setUint32(4, view.byteLength, true)],
  ["overflowing chunk length", (view) => view.setUint32(40, 0xffffffff, true)],
]) {
  test(`rejects ${label}`, async () => {
    const input = wav();
    change(new DataView(input));
    await assert.rejects(createReplaySource(input), TypeError);
  });
}

test("truncated RIFF headers, chunk headers, payloads and missing odd padding are rejected", async () => {
  for (const size of [0, 1, 8, 11]) await assert.rejects(createReplaySource(new ArrayBuffer(size)), TypeError);
  await assert.rejects(createReplaySource(resizeRiff(wav(), 17)), TypeError);
  await assert.rejects(createReplaySource(resizeRiff(wav(), 4_842)), TypeError);
  const odd = riff([["fmt ", format()], ["data", pcm()], ["JUNK", new Uint8Array([1])]]);
  await assert.rejects(createReplaySource(resizeRiff(odd, odd.byteLength - 1)), TypeError);
  await assert.rejects(createReplaySource(resizeRiff(wav(), wav().byteLength + 1)), TypeError);
});

test("fmt and data must each appear exactly once", async () => {
  for (const chunks of [
    [["data", pcm()]],
    [["fmt ", format()]],
    [["fmt ", format()], ["fmt ", format()], ["data", pcm()]],
    [["fmt ", format()], ["data", pcm()], ["data", pcm()]],
    [["fmt ", format()], ["data", new Uint8Array()], ["data", pcm()]],
    [["JUNK", pcm()]],
  ]) await assert.rejects(createReplaySource(riff(chunks)), TypeError);
});

for (const [label, overrides] of [
  ["float encoding", { encoding: 3 }],
  ["extensible encoding", { encoding: 0xfffe }],
  ["stereo", { channels: 2 }],
  ["16 kHz source", { rate: 16_000, byteRate: 32_000 }],
  ["24 kHz source", { rate: 24_000, byteRate: 48_000 }],
  ["44.1 kHz source", { rate: 44_100, byteRate: 88_200 }],
  ["wrong byte rate", { byteRate: 48_000 }],
  ["wrong alignment", { alignment: 4 }],
  ["8-bit PCM", { bits: 8 }],
  ["24-bit PCM", { bits: 24 }],
  ["short fmt", { size: 14 }],
  ["odd fmt", { size: 17 }],
  ["extended fmt payload", { size: 20 }],
  ["nonzero cbSize", { size: 18, extra: 2 }],
]) {
  test(`rejects ${label}`, async () => {
    await assert.rejects(createReplaySource(wav(2_400, () => 0, overrides)), TypeError);
  });
}

test("odd data byte lengths are not accepted as half samples", async () => {
  await assert.rejects(createReplaySource(riff([["fmt ", format()], ["data", new Uint8Array(4_801)]])), TypeError);
});

test("caller mutation during async hashing cannot change hash or copied audio", async () => {
  const input = wav(4_800, (index) => index % 100 < 50 ? 8_000 : -8_000);
  const original = input.slice(0);
  const pending = createReplaySource(input);
  new Uint8Array(input).fill(255);
  const source = await pending;
  const expected = await createReplaySource(original);
  assert.deepEqual(source.metadata, expected.metadata);
  for (const rate of [16_000, 24_000]) {
    for (let index = 0; index < 2; index += 1) assert.deepEqual(source.frameAt(rate, index), expected.frameAt(rate, index));
  }
});

test("detaching the caller buffer after invocation does not affect the private source", async () => {
  const input = wav(2_400, () => 1234);
  const hash = createHash("sha256").update(new Uint8Array(input)).digest("hex");
  const pending = createReplaySource(input);
  structuredClone(input, { transfer: [input] });
  const source = await pending;
  assert.equal(source.metadata.sourceSha256, hash);
  assert.equal(readSamples(source.frameAt(24_000, 0)).at(-1), 1234);
});

test("every returned frame is fresh and caller writes or transfers cannot alter cached streams", async () => {
  const source = await createReplaySource(wav(4_800, () => 4321));
  for (const rate of [16_000, 24_000]) {
    const first = source.frameAt(rate, 0);
    const expected = first.slice(0);
    assert.notEqual(first, source.frameAt(rate, 0));
    new Uint8Array(first).fill(0);
    assert.deepEqual(source.frameAt(rate, 0), expected);
    structuredClone(first, { transfer: [first] });
    assert.deepEqual(source.frameAt(rate, 0), expected);
    assert.equal(readSamples(source.frameAt(rate, 1)).at(-1), 4321);
  }
});

test("only exact target rates and in-range safe integer indices are accepted", async () => {
  const source = await createReplaySource(wav(4_800));
  for (const rate of [undefined, null, "16000", 0, 16_001, 48_000, NaN, Infinity, {}, new Number(16_000)]) {
    assert.throws(() => source.frameAt(rate, 0), RangeError);
  }
  for (const index of [undefined, null, "0", -1, 0.5, 2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => source.frameAt(16_000, index), RangeError);
  }
});

test("FIR output matches continuous source-zero convolution and deterministic PCM16 quantization", async () => {
  const samples = Array.from({ length: 7_200 }, (_, index) => (index * 7919 % 65_536) - 32_768);
  const source = await createReplaySource(wav(samples.length, (index) => samples[index]));
  for (const rate of [16_000, 24_000]) {
    assert.deepEqual(allSamples(source, rate), reference(samples, rate));
    assert.equal(allSamples(source, rate).length, rate * 0.15);
  }
});

test("an impulse just before a 50 ms boundary retains its filter history in the next frame", async () => {
  const samples = Array.from({ length: 4_800 }, (_, index) => index === 2_399 ? 30_000 : 0);
  const source = await createReplaySource(wav(samples.length, (index) => samples[index]));
  for (const rate of [16_000, 24_000]) {
    assert.ok(readSamples(source.frameAt(rate, 0)).every((sample) => sample === 0));
    assert.ok(readSamples(source.frameAt(rate, 1)).some((sample) => sample !== 0));
    assert.deepEqual(allSamples(source, rate), reference(samples, rate));
  }
});

test("full-scale step overshoot is clamped instead of wrapping PCM16", async () => {
  const samples = Array.from({ length: 2_400 }, (_, index) => index < 1200 ? 32_767 : -32_768);
  const source = await createReplaySource(wav(samples.length, (index) => samples[index]));
  for (const rate of [16_000, 24_000]) {
    const output = allSamples(source, rate);
    assert.deepEqual(output, reference(samples, rate));
    assert.equal(Math.max(...output), 32_767);
    assert.equal(Math.min(...output), -32_768);
    assert.ok(output.slice(100, 200).every((sample) => sample === 32_767));
    assert.ok(output.slice(-100).every((sample) => sample === -32_768));
  }
});

test("63-tap low-pass preserves a 1 kHz tone and attenuates above-Nyquist energy at both rates", async () => {
  const amplitude = 12_000;
  const sourceFor = (frequency) => createReplaySource(wav(9_600, (index) => Math.round(amplitude * Math.sin(2 * Math.PI * frequency * index / 48_000))));
  const pass = await sourceFor(1_000);
  const reject16 = await sourceFor(12_000);
  const reject24 = await sourceFor(18_000);
  const rms = (values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
  for (const [rate, rejected] of [[16_000, reject16], [24_000, reject24]]) {
    const passRms = rms(allSamples(pass, rate).slice(200));
    const stopRms = rms(allSamples(rejected, rate).slice(200));
    assert.ok(passRms > amplitude / Math.sqrt(2) * 0.97 && passRms < amplitude / Math.sqrt(2) * 1.03);
    assert.ok(stopRms < passRms * 0.01, `stopband exceeds -40 dB at ${rate} Hz`);
  }
});

test("identical bytes produce identical metadata and both complete converted streams", async () => {
  const input = wav(4_800, (index) => Math.round(10_000 * Math.sin(index / 11)));
  const first = await createReplaySource(input);
  const second = await createReplaySource(input.slice(0));
  assert.deepEqual(first.metadata, second.metadata);
  for (const rate of [16_000, 24_000]) assert.deepEqual(allSamples(first, rate), allSamples(second, rate));
});
