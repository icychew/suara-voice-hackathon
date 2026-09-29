import { useEffect, useRef, useState } from 'react';
import audioManifest from './audio-manifest.json';

export default function FixturePlayer({ copy, laneKey, showSegments = true }) {
  const media = audioManifest.lanes[laneKey];
  const audioRef = useRef(null);
  const [time, setTime] = useState(0);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const active = media.segments.find(segment => time >= segment.start && time < segment.end);
  useEffect(() => {
    const audio = audioRef.current;
    return () => { audio?.pause(); };
  }, []);
  const seek = async start => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    audio.currentTime = start;
    try { await audio.play(); } catch { setPlaying(false); }
  };
  return <div className="showcase-player">
    <audio aria-label={copy.playerLabel} controls preload="metadata" ref={audioRef} src={media.src}
      onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onLoadedMetadata={() => setFailed(false)} onError={() => setFailed(true)} />
    <div className="showcase-player__settings">
      <label>{copy.playbackSpeed} <select defaultValue="1" onChange={event => { if (audioRef.current) audioRef.current.playbackRate = Number(event.target.value); }}>
        <option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option>
      </select></label>
      <span>{copy.syntheticVoice} · {media.duration.toFixed(1)} s</span>
    </div>
    {failed ? <p role="alert">{copy.audioError} <button type="button" onClick={() => { setFailed(false); audioRef.current?.load(); }}>{copy.retryAudio}</button></p> : null}
    {showSegments ? <div className="showcase-player__transcript" aria-label={copy.audioTranscriptLabel}>
      {media.segments.map(segment => <button type="button" key={segment.id} disabled={failed}
        aria-label={`${copy.playFrom} ${segment.id}`} aria-current={active?.id === segment.id && playing ? 'true' : undefined}
        onClick={() => seek(segment.start)}>
        <span>{segment.id} · {segment.start.toFixed(1)}s</span><span>{segment.text}</span>
      </button>)}
    </div> : null}
  </div>;
}
