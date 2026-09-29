import audioManifest from './audio-manifest.json' with { type: 'json' };

function withAudio(lanes) {
  const timestamp = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
  return Object.fromEntries(Object.entries(lanes).map(([key,lane]) => [key, { ...lane,
    model: 'Prepared fictional transcript · recorded synthetic narration',
    segments: lane.segments.map(segment => {
      const timing = audioManifest.lanes[key].segments.find(item => item.id === segment.id);
      return { ...segment, time: `${timestamp(timing.start)}–${timestamp(timing.end)}`, start:timing.start, end:timing.end };
    }),
  }]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export const SHOWCASE_CONTRACT = deepFreeze({
  schema: "suara.public_showcase/0.1",
  fixtureVersion: "synthetic-malaysia-audio-v2",
  syntheticOnly: true,
  realDataUsed: false,
  realModelUsed: false,
  networkRequired: false,
  persistence: "memory_only",
  publishable: false,
  releaseState: "blocked_phase0",
});

export const LANE_FIXTURES = deepFreeze(withAudio({
  ms: {
    route: "ms-MY",
    name: "Bahasa Malaysia",
    model: "Mock transcript · faster-whisper route plan only",
    script: "Latn",
    segments: [
      { id: "E1", time: "00:00–00:08", language: "Bahasa Malaysia", text: "Saya dibesarkan di Klang." },
      { id: "E2", time: "00:08–00:15", language: "Bahasa Malaysia", text: "Kedai keluarga kami dibuka pada tahun 1978." },
      { id: "E3", time: "00:15–00:23", language: "Bahasa Malaysia", text: "Setiap Tahun Baharu, kami membuat kuih bersama-sama." },
    ],
  },
  en: {
    route: "en-MY",
    name: "Malaysian English",
    model: "Mock transcript · faster-whisper route plan only",
    script: "Latn",
    segments: [
      { id: "E1", time: "00:00–00:08", language: "English", text: "I grew up in Klang." },
      { id: "E2", time: "00:08–00:15", language: "English", text: "Our family shop opened in 1978." },
      { id: "E3", time: "00:15–00:23", language: "English", text: "Every New Year, we made rice cakes together." },
    ],
  },
  zh: {
    route: "zh-Hans-MY",
    name: "Malaysian Mandarin",
    model: "模拟转录 · 仅展示 Qwen3-ASR 路线计划",
    script: "Hans",
    segments: [
      { id: "E1", time: "00:00–00:08", language: "简体中文", text: "我在巴生长大。" },
      { id: "E2", time: "00:08–00:15", language: "简体中文", text: "我们家的商店在一九七八年开业。" },
      { id: "E3", time: "00:15–00:23", language: "简体中文", text: "每逢新年，我们一起做年糕。" },
    ],
  },
}));

export const INITIAL_REVIEW_STATES = deepFreeze({ E1: "approved", E2: "followup", E3: "approved" });
