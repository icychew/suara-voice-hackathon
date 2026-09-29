import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/voice/pcm-processor.js", import.meta.url), "utf8");

function makeProcessor(inputSampleRate, frameSamples = 1_200, targetSampleRate = 24_000) {
  const frames = [];
  let Processor;
  vm.runInNewContext(source, {
    sampleRate: inputSampleRate,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage(frame, transfer) {
            // Match the real worklet transfer semantics: sent buffers detach.
            frames.push(structuredClone(frame, { transfer }));
          },
        };
      }
    },
    registerProcessor(name, implementation) {
      assert.equal(name, "suara-pcm-processor");
      Processor = implementation;
    },
  });
  const processor = new Processor({ processorOptions: { inputSampleRate, targetSampleRate, frameSamples } });
  return { processor, frames };
}

function feed(processor, samples, blockSize = 128) {
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    assert.equal(processor.process([[samples.subarray(offset, offset + blockSize)]]), true);
  }
}

function decode(frames) {
  return frames.flatMap((frame) => {
    const view = new DataView(frame);
    return Array.from({ length: frame.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true));
  });
}

test("native 24 kHz capture clips safely and writes exact signed little-endian PCM", () => {
  const { processor, frames } = makeProcessor(24_000, 8);
  feed(processor, new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]), 3);
  assert.deepEqual(decode(frames), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0]);
  assert.deepEqual([...new Uint8Array(frames[0]).subarray(0, 6)], [0, 128, 0, 128, 0, 192]);
});

test("capture batches complete 50 ms frames and retains a partial frame across render calls", () => {
  const { processor, frames } = makeProcessor(24_000);
  feed(processor, new Float32Array(1_199).fill(0.25));
  assert.equal(frames.length, 0);
  feed(processor, new Float32Array([0.5]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].byteLength, 2_400);
  assert.equal(decode(frames).at(-1), 16_384);
  feed(processor, new Float32Array(1_200).fill(-0.5));
  assert.equal(frames.length, 2);
  assert.equal(decode([frames[1]]).every((value) => value === -16_384), true);
});

for (const inputRate of [16_000, 44_100, 48_000, 96_000]) {
  test(`${inputRate} Hz conversion keeps sample count and waveform independent of render block boundaries`, () => {
    const signal = Float32Array.from({ length: inputRate }, (_, index) => 0.4 * Math.sin(2 * Math.PI * 997 * index / inputRate));
    const contiguous = makeProcessor(inputRate);
    const fragmented = makeProcessor(inputRate);
    feed(contiguous.processor, signal, signal.length);
    feed(fragmented.processor, signal, 128);
    assert.deepEqual(decode(fragmented.frames), decode(contiguous.frames));
    assert.equal(fragmented.processor.outputCount, Math.floor((signal.length - 1) / (inputRate / 24_000)) + 1);
    assert.equal(fragmented.frames.every((frame) => frame.byteLength === 2_400), true);
  });
}

test("upsampling interpolates across render boundaries instead of repeating a block's final sample", () => {
  const { processor, frames } = makeProcessor(12_000, 1);
  feed(processor, new Float32Array([0, 0.5, 1]), 1);
  assert.deepEqual(decode(frames), [0, 8192, 16384, 24575, 32767]);
});

function toneRms(inputRate, frequency, targetSampleRate = 24_000) {
  const frameSamples = targetSampleRate / 20;
  const { processor, frames } = makeProcessor(inputRate, frameSamples, targetSampleRate);
  const signal = Float32Array.from({ length: inputRate / 4 }, (_, index) => 0.5 * Math.sin(2 * Math.PI * frequency * index / inputRate));
  feed(processor, signal);
  const samples = decode(frames).slice(frameSamples); // Discard the filter's startup transient.
  return Math.sqrt(samples.reduce((total, sample) => total + (sample / 32768) ** 2, 0) / samples.length);
}

test("downsampling preserves speech-band energy and suppresses above-Nyquist aliasing", () => {
  const speech = toneRms(48_000, 1_000);
  const aliased = toneRms(48_000, 16_000);
  assert.ok(speech > 0.34 && speech < 0.36, `1 kHz RMS ${speech}`);
  assert.ok(aliased < speech / 100, `16 kHz alias RMS ${aliased}, speech RMS ${speech}`);
});

test("empty inputs keep the worklet alive without posting phantom audio", () => {
  const { processor, frames } = makeProcessor(48_000);
  assert.equal(processor.process([]), true);
  assert.equal(processor.process([[]]), true);
  assert.equal(processor.process([[new Float32Array()]]), true);
  assert.equal(frames.length, 0);
  assert.equal(processor.outputCount, 0);
});

test("native streaming 16 kHz clips safely into independent 1600-byte little-endian frames", () => {
  const { processor, frames } = makeProcessor(16_000, 800, 16_000);
  const signal = new Float32Array(1_600).fill(0.25);
  signal.set([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity, -Infinity]);
  signal.fill(-0.5, 800);
  feed(processor, signal, 128);
  assert.equal(frames.length, 2);
  assert.equal(frames.every((frame) => frame.byteLength === 1600), true);
  assert.deepEqual(decode([frames[0]]).slice(0, 10), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0, 0]);
  assert.deepEqual([...new Uint8Array(frames[0]).subarray(0, 6)], [0, 128, 0, 128, 0, 192]);
  assert.equal(decode([frames[1]]).every((sample) => sample === -16384), true);
  assert.notEqual(frames[0], frames[1]);
  assert.equal(processor.pending.buffer.byteLength, 1600, "the next writable frame is not a detached transfer");
  assert.equal(processor.pendingLength, 0);
});

test("streaming frame boundary is exactly 800 samples and partial tails are not padded or emitted", () => {
  const { processor, frames } = makeProcessor(16_000, 800, 16_000);
  feed(processor, new Float32Array(799).fill(0.25), 7);
  assert.equal(frames.length, 0);
  assert.equal(processor.pendingLength, 799);
  feed(processor, new Float32Array([0.5]), 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].byteLength, 1600);
  assert.equal(decode(frames).at(-1), 16384);
  feed(processor, new Float32Array(799).fill(-0.5), 17);
  assert.equal(frames.length, 1);
  assert.equal(processor.pendingLength, 799);
  assert.equal(processor.process([]), true);
  assert.equal(processor.process([[]]), true);
  assert.equal(processor.process([[new Float32Array()]]), true);
  assert.equal(frames.length, 1, "there is no worklet flush API; empty input must not manufacture a tail frame");
  assert.equal(processor.pendingLength, 799);
});

for (const inputRate of [44_100, 48_000]) {
  test(`${inputRate} Hz to streaming 16 kHz yields 20 exact PCM frames per source second independent of render blocks`, () => {
    const signal = Float32Array.from({ length: inputRate }, (_, index) => 0.4 * Math.sin(2 * Math.PI * 997 * index / inputRate));
    const contiguous = makeProcessor(inputRate, 800, 16_000);
    const fragmented = makeProcessor(inputRate, 800, 16_000);
    feed(contiguous.processor, signal, signal.length);
    feed(fragmented.processor, signal, 128);
    assert.equal(fragmented.processor.inputCount, inputRate);
    assert.equal(fragmented.processor.outputCount, 16_000);
    assert.equal(fragmented.frames.length, 20);
    assert.equal(fragmented.frames.every((frame) => frame.byteLength === 1600), true);
    assert.equal(fragmented.processor.pendingLength, 0);
    assert.deepEqual(decode(fragmented.frames), decode(contiguous.frames));
  });

  test(`${inputRate} Hz to streaming 16 kHz retains a 1 kHz tone and suppresses an above-Nyquist 12 kHz tone`, () => {
    const speech = toneRms(inputRate, 1_000, 16_000);
    const aliased = toneRms(inputRate, 12_000, 16_000);
    assert.ok(speech > 0.34 && speech < 0.36, `1 kHz RMS ${speech}`);
    assert.ok(aliased < speech / 100, `12 kHz alias RMS ${aliased}, speech RMS ${speech}`);
  });
}

test("empty streaming input posts no frame and changes no filter or resampling position", () => {
  const { processor, frames } = makeProcessor(48_000, 800, 16_000);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    assert.equal(processor.process([]), true);
    assert.equal(processor.process([[new Float32Array()]]), true);
  }
  assert.equal(frames.length, 0);
  assert.equal(processor.inputCount, 0);
  assert.equal(processor.outputCount, 0);
  assert.equal(processor.pendingLength, 0);
  assert.equal(processor.historyIndex, 0);
});

test("a fresh streaming processor retains no prior session filter samples or partial frame", () => {
  const previous = makeProcessor(48_000, 800, 16_000);
  feed(previous.processor, new Float32Array(1600).fill(0.75));
  assert.ok(previous.processor.pendingLength > 0);
  const current = makeProcessor(48_000, 800, 16_000);
  assert.equal(current.processor.pendingLength, 0);
  assert.equal(current.processor.inputCount, 0);
  assert.equal(current.processor.outputCount, 0);
  feed(current.processor, new Float32Array(2400));
  assert.equal(current.frames.length, 1);
  assert.equal(decode(current.frames).every((sample) => sample === 0), true);
  assert.equal(previous.frames.length, 0, "a new instance cannot flush the previous partial frame");
});
