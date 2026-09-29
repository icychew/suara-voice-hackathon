class SuaraPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions || {};
    this.inputSampleRate = processorOptions.inputSampleRate || sampleRate;
    this.targetSampleRate = processorOptions.targetSampleRate || 24_000;
    this.step = this.inputSampleRate / this.targetSampleRate;
    if (!Number.isFinite(this.step) || this.step <= 0) throw new Error("Invalid sample rate");
    this.inputCount = 0;
    this.outputCount = 0;
    this.previousSample = 0;
    this.frameSamples = processorOptions.frameSamples || 1_200;
    this.pending = new DataView(new ArrayBuffer(this.frameSamples * 2));
    this.pendingLength = 0;
    // Keep the device's native rate for browser echo cancellation. Before reducing
    // its rate, remove frequencies above the destination's Nyquist limit. The FIR
    // history and interpolation phase persist across render quanta.
    this.filter = null;
    if (this.step > 1) {
      const taps = 63;
      const cutoff = 0.45 / this.step;
      this.filter = new Float64Array(taps);
      this.history = new Float32Array(taps);
      this.historyIndex = 0;
      let sum = 0;
      for (let index = 0; index < taps; index += 1) {
        const distance = index - (taps - 1) / 2;
        const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        this.filter[index] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * index / (taps - 1)));
        sum += this.filter[index];
      }
      for (let index = 0; index < taps; index += 1) this.filter[index] /= sum;
    }
  }

  filterSample(sample) {
    if (!this.filter) return sample;
    this.history[this.historyIndex] = sample;
    let filtered = 0;
    for (let index = 0; index < this.filter.length; index += 1) {
      const historyIndex = (this.historyIndex - index + this.filter.length) % this.filter.length;
      filtered += this.filter[index] * this.history[historyIndex];
    }
    this.historyIndex = (this.historyIndex + 1) % this.filter.length;
    return filtered;
  }

  appendSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    this.pending.setInt16(this.pendingLength * 2, pcm, true);
    this.pendingLength += 1;
    if (this.pendingLength === this.frameSamples) {
      const frame = this.pending.buffer;
      this.pending = new DataView(new ArrayBuffer(this.frameSamples * 2));
      this.pendingLength = 0;
      this.port.postMessage(frame, [frame]);
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    for (let index = 0; index < input.length; index += 1) {
      const sample = this.filterSample(Number.isFinite(input[index]) ? input[index] : 0);
      // Wait for the next input sample instead of clamping interpolation to a
      // render block's last sample, which biased fractional positions at boundaries.
      while (this.outputCount * this.step <= this.inputCount) {
        const mix = this.outputCount * this.step - (this.inputCount - 1);
        this.appendSample(this.previousSample * (1 - mix) + sample * mix);
        this.outputCount += 1;
      }
      this.previousSample = sample;
      this.inputCount += 1;
    }
    return true;
  }
}

registerProcessor("suara-pcm-processor", SuaraPCMProcessor);
