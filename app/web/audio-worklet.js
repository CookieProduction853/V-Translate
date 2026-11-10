// Downsample the selected tab's audio to mono 16 kHz without sending any audio off this machine.
class TabAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.chunkSamples = 96000;
    this.samples = new Int16Array(this.chunkSamples);
    this.index = 0;
    this.previewStep = 20000;
    this.total = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'start') {
        const seconds = Math.max(3, Math.min(12, Number(event.data.chunkSeconds) || 6));
        this.chunkSamples = Math.round(seconds * 16000);
        this.samples = new Int16Array(this.chunkSamples);
        this.index = this.total = this.phase = this.sum = this.count = 0;
        this.active = true;
      } else if (event.data === 'stop') this.active = false;
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.sum += sample / channels.length;
      this.count++;
      this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.samples[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
        this.sum = 0;
        this.count = 0;
        if (this.index % this.previewStep === 0 && this.samples.length - this.index >= 12000) {
          const samples = this.samples.slice(0, this.index);
          this.port.postMessage({ preview: true, samples: samples.buffer, start: this.total / 16000 }, [samples.buffer]);
        }
        if (this.index === this.samples.length) {
          const start = this.total / 16000;
          this.total += this.samples.length;
          this.port.postMessage({ samples: this.samples.buffer, start, end: this.total / 16000 }, [this.samples.buffer]);
          this.samples = new Int16Array(this.chunkSamples);
          this.index = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tab-audio', TabAudioProcessor);
