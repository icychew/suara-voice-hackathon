# Synthetic narration provenance

Generated 29 September 2026 from Suara's existing fictional three-excerpt
scripts. No family recording, cloned voice, or identifiable narrator was used.

| Sample | Microsoft preset voice | Duration |
| --- | --- | --- |
| Bahasa Malaysia | ms-MY-YasminNeural | 14.874 s |
| English | en-US-JennyNeural | 11.202 s |
| Mandarin | zh-CN-XiaoxiaoNeural | 10.218 s |

Build tool: edge-tts 7.2.8, a client for Microsoft Edge online speech, followed
by FFmpeg conversion to 24 kHz mono PCM WAV. Speech rate: -8%; 350 ms gaps
between excerpts. These are standard synthesized voices; they are not
recordings of Malaysian participants. The English voice is a US preset.

The exact scripts, segment boundaries, lengths and SHA-256 hashes are in
`src/showcase/audio-manifest.json`. The committed WAV files are in
`public/assets/synthetic/`. No runtime TTS call or credential is required.
The source text is supplied before synthesis; this is not ASR output or
forced alignment. Regeneration is optional and requires an installed Python
environment containing edge-tts and FFmpeg on PATH:

    node scripts/generate-showcase-audio.mjs <absolute-python-executable>

Voice-provider service terms govern the generated voice assets; the repository
MIT license does not relicense the provider's voice models. No ownership of the
voice models or endorsement by Microsoft is asserted.

Tool source: https://github.com/rany2/edge-tts

