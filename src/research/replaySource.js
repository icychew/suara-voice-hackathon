const SOURCE_RATE_HZ = 48_000;
const SOURCE_CHUNK_FRAMES = 2_400;
const MAX_SOURCE_BYTES = 6_000_000;
const MAX_SOURCE_FRAMES = SOURCE_RATE_HZ * 60;
const FILTER_TAPS = 63;
const FILTER_DELAY = 31;

function invalidWav() {
  return new TypeError("Replay requires a complete PCM16 mono 48 kHz WAV in exact 50 ms chunks (50 ms–60 s, at most 6 MB).");
}

function matchesTag(bytes, offset, tag) {
  for (let index = 0; index < 4; index += 1) {
    if (bytes[offset + index] !== tag.charCodeAt(index)) return false;
  }
  return true;
}

function parseWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || !matchesTag(bytes, 0, "RIFF") || !matchesTag(bytes, 8, "WAVE")
    || view.getUint32(4, true) !== bytes.length - 8) throw invalidWav();
  let formatSeen = false;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw invalidWav();
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length % 2);
    if (end > bytes.length || paddedEnd > bytes.length) throw invalidWav();
    if (matchesTag(bytes, offset, "fmt ")) {
      if (formatSeen || (length !== 16 && length !== 18)) throw invalidWav();
      formatSeen = true;
      if (view.getUint16(start, true) !== 1
        || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== SOURCE_RATE_HZ
        || view.getUint32(start + 8, true) !== SOURCE_RATE_HZ * 2
        || view.getUint16(start + 12, true) !== 2
        || view.getUint16(start + 14, true) !== 16
        || (length === 18 && view.getUint16(start + 16, true) !== 0)) throw invalidWav();
    } else if (matchesTag(bytes, offset, "data")) {
      if (dataOffset !== -1) throw invalidWav();
      dataOffset = start;
      dataLength = length;
    }
    // Unknown metadata is bounded by the input byte limit and never exported.
    offset = paddedEnd;
  }
  const sourceFrames = dataLength / 2;
  if (!formatSeen || dataOffset === -1 || dataLength % 2 !== 0
    || sourceFrames < SOURCE_CHUNK_FRAMES || sourceFrames > MAX_SOURCE_FRAMES
    || sourceFrames % SOURCE_CHUNK_FRAMES !== 0) throw invalidWav();
  return { view, dataOffset, sourceFrames };
}

function convert(samples, targetRateHz) {
  const step = SOURCE_RATE_HZ / targetRateHz;
  const cutoff = 0.45 / step;
  const coefficients = new Float64Array(FILTER_TAPS);
  let sum = 0;
  for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
    const distance = tap - FILTER_DELAY;
    const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
    coefficients[tap] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * tap / (FILTER_TAPS - 1)));
    sum += coefficients[tap];
  }
  for (let tap = 0; tap < FILTER_TAPS; tap += 1) coefficients[tap] /= sum;

  const output = new ArrayBuffer((samples.length / step) * 2);
  const outputView = new DataView(output);
  for (let sourceIndex = 0, outputIndex = 0; sourceIndex < samples.length; sourceIndex += step, outputIndex += 1) {
    let filtered = 0;
    // One continuous causal convolution: silence before frame zero, no reset at
    // a 50 ms boundary, and no appended filter tail or time-offset correction.
    for (let tap = 0; tap < FILTER_TAPS && tap <= sourceIndex; tap += 1) {
      filtered += samples[sourceIndex - tap] * coefficients[tap];
    }
    outputView.setInt16(outputIndex * 2, Math.max(-32_768, Math.min(32_767, Math.round(filtered))), true);
  }
  return output;
}

/** Local-only replay source. No file identifiers, transcripts, or audio enter metadata. */
export async function createReplaySource(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength > MAX_SOURCE_BYTES || arrayBuffer.byteLength < 12) {
    throw invalidWav();
  }
  // Copy synchronously, before the first await. Caller mutation/detachment after
  // invocation cannot change either the fingerprint or the replay samples.
  let bytes;
  try {
    bytes = new Uint8Array(arrayBuffer).slice();
  } catch {
    throw invalidWav();
  }
  const { view, dataOffset, sourceFrames } = parseWav(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const sourceSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const samples = new Int16Array(sourceFrames);
  for (let index = 0; index < sourceFrames; index += 1) samples[index] = view.getInt16(dataOffset + index * 2, true);

  // Prepare both complete streams before replay timing begins. frameAt only
  // copies a bounded 50 ms slice; FIR work cannot delay an individual deadline.
  const streams = new Map([[16_000, convert(samples, 16_000)], [24_000, convert(samples, 24_000)]]);
  const chunkCount = sourceFrames / SOURCE_CHUNK_FRAMES;
  const metadata = Object.freeze({
    schema: 1,
    sourceSha256,
    sourceRateHz: SOURCE_RATE_HZ,
    sourceFrames,
    durationMs: sourceFrames / (SOURCE_RATE_HZ / 1_000),
    chunkMs: 50,
    chunkCount,
    conversion: "fir63-hamming-causal-v1",
    filterDelaySourceFrames: FILTER_DELAY,
  });
  return Object.freeze({
    metadata,
    frameAt(targetRateHz, index) {
      if (!streams.has(targetRateHz) || !Number.isSafeInteger(index) || index < 0 || index >= chunkCount) {
        throw new RangeError("Invalid replay rate or chunk index.");
      }
      const bytesPerChunk = (targetRateHz / 20) * 2;
      return streams.get(targetRateHz).slice(index * bytesPerChunk, (index + 1) * bytesPerChunk);
    },
  });
}
