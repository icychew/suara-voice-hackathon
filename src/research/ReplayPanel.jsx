import { useCallback, useEffect, useRef, useState } from "react";
import { createReplaySource } from "./replaySource.js";
import { ReplayRun } from "./replayRun.js";

const MAX_FILE_BYTES = 6_000_000;
const MAX_REPORT_BYTES = 750_000;
const MAX_REPORTS = 6;
const MODES = Object.freeze({
  baseline: "Managed baseline · provider defaults",
  patient: "Managed patient · 1.2–6 second request",
  streaming: "Experimental streaming · local browser voice",
});
const PHASES = Object.freeze({
  idle: "Ready for setup",
  connecting: "Connecting to the provider",
  greeting: "Waiting for greeting playback to finish",
  replaying: "Sending the source and identical silence tail",
  ending: "Waiting for a clean provider end",
  complete: "Transport run complete · interpretation still limited",
  failed: "Run inconclusive · do not treat it as a successful comparison",
});
const NOOP = () => {};
const initialProgress = () => ({ phase: "idle", framesSent: 0, totalFrames: 0 });
const validCode = (code) => /^[!-~]{16,128}$/.test(code.trim());
const boundedCount = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;

function checkedReport(report) {
  // Reports are accepted only from our run, never imported from a file. Check
  // the envelope and size again before retaining or offering a local download.
  if (report?.schema !== 1 || report.protocol !== "public-fixed-three-replay-v1" ||
      report.interpretation !== "transport_observations_only" || !Object.hasOwn(MODES, report.mode) ||
      !["complete", "inconclusive"].includes(report.status) ||
      typeof report.inputComplete !== "boolean" || typeof report.cleanEnd !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(report.source?.sourceSha256 || "") ||
      !Array.isArray(report.events) || report.events.length > 4096 ||
      (report.replay !== null && (!Array.isArray(report.replay?.sendObservations) || report.replay.sendObservations.length > 1400))) {
    throw new Error("Report unavailable.");
  }
  const json = JSON.stringify(report);
  if (new TextEncoder().encode(json).byteLength > MAX_REPORT_BYTES) throw new Error("Report unavailable.");
  return JSON.parse(json);
}

export default function ReplayPanel({ onActiveChange = NOOP } = {}) {
  const [mode, setMode] = useState("baseline");
  const [accessCode, setAccessCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState(initialProgress);
  const [reports, setReports] = useState([]);
  const [notice, setNotice] = useState("");
  const sourceRef = useRef(null);
  const runRef = useRef(null);
  const fileRef = useRef(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const activeCallbackRef = useRef(onActiveChange);
  const downloadRefs = useRef(new Map());

  useEffect(() => { activeCallbackRef.current = onActiveChange; }, [onActiveChange]);

  const releaseMemory = useCallback(() => {
    generationRef.current += 1;
    const run = runRef.current;
    runRef.current = null;
    run?.dispose();
    sourceRef.current = null;
    if (fileRef.current) fileRef.current.value = "";
    for (const [url, timer] of downloadRefs.current) {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    downloadRefs.current.clear();
  }, []);

  const clearAll = useCallback(() => {
    releaseMemory();
    if (!mountedRef.current) return;
    setMode("baseline");
    setAccessCode("");
    setConsent(false);
    setMetadata(null);
    setLoading(false);
    setActive(false);
    setProgress(initialProgress());
    setReports([]);
    setNotice("");
    activeCallbackRef.current(false);
  }, [releaseMemory]);

  useEffect(() => {
    mountedRef.current = true;
    window.addEventListener("pagehide", clearAll);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", clearAll);
      releaseMemory();
    };
  }, [clearAll, releaseMemory]);

  function changedSetup() {
    setConsent(false);
    setProgress(initialProgress());
    setNotice("");
  }

  async function loadSource(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = ""; // Do not retain a filename in this panel.
    if (runRef.current) return;
    const generation = ++generationRef.current;
    sourceRef.current = null;
    setMetadata(null);
    setLoading(false);
    changedSetup();
    if (!file) return;
    // Reject oversized files before reading any bytes into an ArrayBuffer.
    if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
      setNotice("Choose a WAV no larger than 6 MB. No audio was sent.");
      return;
    }
    setLoading(true);
    try {
      const bytes = await file.arrayBuffer();
      if (!mountedRef.current || generation !== generationRef.current) return;
      const source = await createReplaySource(bytes);
      if (!mountedRef.current || generation !== generationRef.current) return;
      sourceRef.current = source;
      const meta = source.metadata;
      setMetadata({ sourceSha256: meta.sourceSha256, durationMs: meta.durationMs,
        sourceRateHz: meta.sourceRateHz, sourceFrames: meta.sourceFrames, chunkCount: meta.chunkCount });
      setNotice("Practice source validated in memory. Nothing has been sent to the provider.");
    } catch {
      if (!mountedRef.current || generation !== generationRef.current) return;
      sourceRef.current = null;
      setMetadata(null);
      setNotice("This source could not be loaded. Use mono, 48 kHz, PCM16 WAV: 50 ms–60 seconds, in exact 50 ms increments. No audio was sent.");
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }

  async function startRun(event) {
    event.preventDefault();
    if (runRef.current || loading || !sourceRef.current || !consent || !validCode(accessCode) || reports.length >= MAX_REPORTS) return;
    const generation = ++generationRef.current;
    const code = accessCode.trim();
    setAccessCode("");
    setConsent(false);
    setNotice("");
    setProgress({ phase: "connecting", framesSent: 0, totalFrames: 0 });
    setActive(true);
    activeCallbackRef.current(true);
    let run;
    try {
      run = new ReplayRun({ mode, source: sourceRef.current, accessCode: code, consent: true,
        onUpdate: (update) => {
          if (!mountedRef.current || generation !== generationRef.current || runRef.current !== run) return;
          // The runner emits frame progress every ten 50 ms chunks (2 Hz).
          // Callback details and provider-controlled error strings are not kept.
          if (!Object.hasOwn(PHASES, update?.phase)) return;
          setProgress({ phase: update.phase, framesSent: boundedCount(update.framesSent, 1400),
            totalFrames: boundedCount(update.totalFrames, 1400) });
        },
      });
      runRef.current = run;
      const report = checkedReport(await run.start());
      if (!mountedRef.current || generation !== generationRef.current || runRef.current !== run) return;
      setReports((current) => current.length < MAX_REPORTS ? [...current, report] : current);
      setProgress({ phase: report.status === "complete" ? "complete" : "failed",
        framesSent: boundedCount(report.replay?.framesSent, 1400), totalFrames: metadata.chunkCount + 200 });
      setNotice(report.status === "complete"
        ? "One transport report retained. This is not proof of heard audio, pause intent or patient benefit. Re-enter the access code and consent before another arm."
        : "An inconclusive report was retained. Check the approved setup before explicitly starting another run; nothing is retried automatically.");
    } catch {
      if (mountedRef.current && generation === generationRef.current) {
        setProgress({ phase: "failed", framesSent: 0, totalFrames: 0 });
        setNotice("The run or its report could not be completed safely. No successful comparison is recorded.");
      }
    } finally {
      run?.dispose();
      if (runRef.current === run) runRef.current = null;
      if (mountedRef.current && generation === generationRef.current) {
        setActive(false);
        activeCallbackRef.current(false);
      }
    }
  }

  function stopRun() {
    // Do not wait for React rendering to cancel transport and output.
    runRef.current?.stop();
    setNotice("Stop requested. Audio transmission and output are being cancelled; this run cannot establish a successful comparison.");
  }

  function downloadReports() {
    if (runRef.current || reports.length === 0 || reports.length > MAX_REPORTS) return;
    try {
      const safeReports = reports.map(checkedReport);
      const json = JSON.stringify({ schema: 1, purpose: "local_transport_diagnostics", reports: safeReports });
      if (new TextEncoder().encode(json).byteLength > MAX_REPORT_BYTES * MAX_REPORTS + 256) throw new Error("Export unavailable.");
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "suara-replay-diagnostics.json";
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      const timer = window.setTimeout(() => { URL.revokeObjectURL(url); downloadRefs.current.delete(url); }, 1000);
      downloadRefs.current.set(url, timer);
      setNotice("Diagnostic JSON downloaded. It contains source fingerprints and timings, not audio or transcript text. Review it before sharing; fingerprints are not anonymous.");
    } catch {
      setNotice("The diagnostic export could not be validated. No report was offered for download.");
    }
  }

  return <section className="operator-tools replay-panel" aria-labelledby="replay-title">
    <h2 id="replay-title">Same-source replay · local operator only</h2>
    <p>Replay one consented, fictional or practice recording through one selected path. This uses real provider services and real output audio, but never requests microphone access. Loading a file alone makes no provider request.</p>
    <p className="operator-tools__notice">Use no real-family, sensitive or unconsented recording. Keep speakers low or wear headphones. Provider processing can incur charges and provider-side recording may apply.</p>
    <form onSubmit={startRun}>
      <fieldset disabled={active}>
        <legend>1. Prepare a practice source</legend>
        <label htmlFor="replay-file">Local WAV · maximum 6 MB
          <input ref={fileRef} id="replay-file" type="file" accept=".wav,audio/wav" aria-describedby="replay-format" onChange={loadSource} />
        </label>
        <p id="replay-format">Mono PCM16, 48 kHz; 50 ms–60 seconds in exact 50 ms increments. The same 10-second silent tail is appended in every arm. Source bytes stay in this tab until cleared or this panel is left.</p>
        {loading ? <p role="status">Validating the source locally…</p> : null}
        {metadata ? <dl className="replay-panel__source">
          <dt>Validated source</dt><dd>{metadata.durationMs / 1000} seconds · {metadata.sourceRateHz} Hz · {metadata.sourceFrames} samples · {metadata.chunkCount} source chunks</dd>
          <dt>Source SHA-256 fingerprint</dt><dd>{metadata.sourceSha256}</dd>
        </dl> : <p>No validated source loaded.</p>}
        <label htmlFor="replay-mode">2. Choose exactly one path
          <select id="replay-mode" value={mode} onChange={(event) => { setMode(event.target.value); changedSetup(); }}>
            {Object.entries(MODES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label htmlFor="replay-access">Private access code · required again for every run
          <input id="replay-access" type="password" value={accessCode} autoComplete="off" autoCapitalize="none"
            spellCheck={false} maxLength={128} onChange={(event) => { setAccessCode(event.target.value); changedSetup(); }} />
        </label>
        <label className="replay-panel__consent" htmlFor="replay-consent">
          <input id="replay-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          I confirm this is consented fictional or practice audio, and explicitly authorize this one selected run to send it to AssemblyAI, including provider processing, possible recording and charges. I understand output audio will play.
        </label>
      </fieldset>
      <div className="operator-tools__actions">
        <button type="submit" disabled={active || loading || !metadata || !validCode(accessCode) || !consent || reports.length >= MAX_REPORTS}>Start one replay</button>
        <button type="button" disabled={!active} onClick={stopRun}>Stop replay now</button>
        <button type="button" onClick={clearAll}>Clear source, reports and access</button>
      </div>
    </form>
    <div className="replay-panel__progress" aria-live="polite" aria-atomic="true">
      <p>{PHASES[progress.phase]}</p>
      {progress.totalFrames ? <p>{progress.framesSent} / {progress.totalFrames} PCM chunks submitted locally, including silence tail. Submission is not confirmed provider consumption.</p> : null}
    </div>
    {notice ? <p role="status">{notice}</p> : null}
    <h3>Finished-run diagnostics · {reports.length}/{MAX_REPORTS} in memory</h3>
    <p>Reports contain no audio, transcript, credentials or filename. A source hash is a fingerprint, not anonymization. Downloading is explicit; Clear cannot delete an already downloaded file or a provider recording.</p>
    {reports.length ? <ol className="replay-panel__reports">
      {reports.map((report, index) => <li key={index}>
        <strong>Run {index + 1} · {MODES[report.mode]}</strong>
        <dl><dt>Diagnostic status</dt><dd>{report.status === "complete" ? "Transport complete" : "Inconclusive"}</dd>
          <dt>Complete input / clean provider end</dt><dd>{report.inputComplete ? "Yes" : "No"} / {report.cleanEnd ? "Yes" : "No"}</dd>
          <dt>Chunks submitted / final user turns received</dt><dd>{boundedCount(report.replay?.framesSent, 1400)} / {boundedCount(report.userFinals, 100000)}</dd>
          <dt>Error recorded</dt><dd>{report.error === null ? "No" : "Yes · inconclusive, inspect the bounded diagnostic report"}</dd>
        </dl>
      </li>)}
    </ol> : <p>No finished reports yet. Start never launches the other paths automatically.</p>}
    {reports.length >= MAX_REPORTS ? <p className="operator-tools__notice">Report limit reached. Download if needed, then clear this panel before another run.</p> : null}
    <div className="operator-tools__actions"><button type="button" disabled={active || reports.length === 0} onClick={downloadReports}>Download diagnostic JSON</button></div>
    <details className="replay-panel__limits"><summary>What these runs do—and do not—compare</summary>
      <ul>
        <li>All paths use the fixed three-question plan. AI bank selection is off. Each click starts only the chosen path with the same source and 10-second silence tail.</li>
        <li>The public patient path requests 1200/6000 ms. It is not the archive benchmark’s max-only 6000 ms control.</li>
        <li>Managed generated replies and streaming browser-local question output differ. This cross-stack comparison cannot isolate a calibration effect.</li>
        <li>Local callback times and submitted-frame cursors are transport observations, not source-pause joins, audible onset, independent intent labels or proof that a person heard a reply.</li>
        <li>These short practice runs do not complete the 20-minute interview protocol or establish older-adult benefit. A complete diagnostic report is not a successful causal benchmark.</li>
      </ul>
    </details>
  </section>;
}
