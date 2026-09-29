import { useCallback, useEffect, useRef, useState } from "react";
import VoiceDemoApp from "../voice/VoiceDemoApp.jsx";
import { TimingTrace, summarizeTiming, compareTiming, exportTiming } from "./timing.js";
import ReplayPanel from "./ReplayPanel.jsx";
import "./operator.css";

const ACTIVE = new Set(["connecting", "listening", "thinking", "speaking", "ending"]);
const FIXTURES = {
  "english-food-v1": "English · a fictional family meal",
  "mandarin-food-v1": "Mandarin · a fictional family meal",
  "code-switch-food-v1": "English + Mandarin · fictional food story",
};

function downloadTimings(traces) {
  const blob = new Blob([exportTiming(traces)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "suara-timing-canary.json";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function ManualOperatorApp({ onActiveChange }) {
  const [optIn, setOptIn] = useState(false);
  const [fixture, setFixture] = useState("english-food-v1");
  const [status, setStatus] = useState("idle");
  const [snapshot, setSnapshot] = useState(null);
  const [saved, setSaved] = useState([]);
  const [sameConditions, setSameConditions] = useState(false);
  const [notice, setNotice] = useState("");
  const traceRef = useRef(null);
  const savedTraceRef = useRef(null);
  const active = ACTIVE.has(status);
  const onStatusChange = useCallback((value) => {
    setStatus(value);
    onActiveChange(ACTIVE.has(value));
  }, [onActiveChange]);
  const summary = snapshot ? summarizeTiming(snapshot) : null;

  const clearAll = useCallback(() => {
    traceRef.current = null;
    savedTraceRef.current = null;
    setSnapshot(null);
    setSaved([]);
    setSameConditions(false);
    setOptIn(false);
    setNotice("");
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", clearAll);
    return () => window.removeEventListener("pagehide", clearAll);
  }, [clearAll]);

  const onRunStart = ({ mode }) => {
    traceRef.current = optIn ? new TimingTrace({ consent: true, mode, fixture }) : null;
    savedTraceRef.current = null;
    setSnapshot(null);
    setNotice("");
  };
  const onTiming = useCallback((event) => {
    const trace = traceRef.current;
    if (!trace) return;
    trace.record(event);
    setSnapshot(trace.snapshot());
  }, []);
  const resetCurrent = useCallback(() => {
    traceRef.current = null;
    savedTraceRef.current = null;
    setSnapshot(null);
    setOptIn(false);
    setNotice("");
  }, []);
  const mark = (kind) => {
    traceRef.current?.mark(kind);
    setSnapshot(traceRef.current?.snapshot() || null);
  };
  const changeOutcome = (value) => {
    traceRef.current?.setOutcome(value);
    setSnapshot(traceRef.current?.snapshot() || null);
  };
  const keepTrace = () => {
    if (!traceRef.current || active || saved.length >= 2 || savedTraceRef.current === traceRef.current) return;
    if (saved.some((item) => item.mode === traceRef.current.snapshot().mode)) {
      setNotice("A snapshot for this pace is already kept. Download the current run separately, or clear all timings to begin a new pair.");
      return;
    }
    setSaved((current) => [...current, traceRef.current.snapshot()]);
    setSameConditions(false);
    savedTraceRef.current = traceRef.current;
    setNotice("Timing snapshot kept in this tab. Conversation text was not copied.");
  };
  const baseline = saved.find((trace) => trace.mode === "baseline");
  const patient = saved.find((trace) => trace.mode === "patient");
  const comparison = baseline && patient ? compareTiming(baseline, patient, { sameConditionsConfirmed: sameConditions }) : null;
  const exportTraces = (traces) => {
    try { downloadTimings(traces); setNotice(`${traces.length} timing snapshot(s) downloaded. This contains no speech or transcript text.`); }
    catch { setNotice("Timing export failed validation. Clear the timings and repeat the canary."); }
  };

  const setupExtras = <aside className="operator-tools" aria-labelledby="operator-title">
    <h3 id="operator-title">Operator canary · local build only</h3>
    <p>This English-language engineering panel is separate from the BM/EN/中文 interview. It measures browser events, not human intent or speech accuracy.</p>
    <label htmlFor="timing-opt-in"><input id="timing-opt-in" type="checkbox" checked={optIn} disabled={status !== "idle"}
      onChange={(event) => setOptIn(event.target.checked)} />
      I choose to collect content-free timings for this fictional, consented test.</label>
    <p>No audio, transcript, provider IDs, credentials, device IDs or wall-clock times enter the trace. Nothing is sent by this panel. The normal AssemblyAI session is still recorded by the provider.</p>
    <label htmlFor="canary-fixture">Fixed test case
      <select id="canary-fixture" value={fixture} disabled={status !== "idle"} onChange={(event) => setFixture(event.target.value)}>
        {Object.entries(FIXTURES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <details><summary>How to run the first comparison</summary>
      <ol>
        <li>Use only fictional speech. Choose Adaptive pace for the first run; keep the same headset, browser, network and script for Patient pace.</li>
        <li>Wait for the greeting to finish. Say the selected fixed sentence. At “…” press Mark intended pause, wait five seconds, then press Mark resuming as you continue.</li>
        <li>English: “A place I remember is … a small table, where we shared nasi lemak every Sunday.”</li>
        <li>Mandarin: “我记得的一个地方是……一张小桌，每逢星期天大家都围坐在旁边一起吃椰浆饭。”</li>
        <li>Code-switch: “A place I remember is … 一张小桌，我们每个星期天一起吃椰浆饭。”</li>
        <li>Continue at your planned cue even if the agent speaks. Mark your actual observation, including uncertainty or an invalid attempt. This is a manual canary, not a population benchmark.</li>
        <li>Finish, explicitly keep the timing snapshot, then Start fresh and repeat in the other mode. Reverse the order for later repetitions to reduce order effects.</li>
      </ol>
    </details>
    <p className="operator-tools__notice">Start fresh clears the current trace and conversation. Explicitly kept, content-free timing snapshots remain until Clear all timings or leaving this page. Export is manual.</p>
  </aside>;

  const sessionExtras = <aside className="operator-tools" aria-labelledby="timing-title">
    <h3 id="timing-title">Canary timing observations</h3>
    {!snapshot ? <p>Opt in before starting to collect a trace. The normal interview collects no timing history.</p> : <>
      <div className="operator-tools__summary"><dl>
        <dt>Mode / events received</dt><dd>{snapshot.mode} / {summary.eventCount}</dd>
        <dt>Received speech-stop → reply-generation intervals</dt>
        <dd>{summary.postDetectionReplyGapsMs.length ? summary.postDetectionReplyGapsMs.map((value) => `${value} ms`).join(", ") : "Not observed"}</dd>
        <dt>Quick speech-resumption patterns</dt><dd>{summary.resumeAfterPlaybackCount} · diagnostic only, not an interruption score</dd>
      </dl></div>
      <p>Speech-stop is a provider decision received later. These intervals are not silence held. Scheduled playback is an estimate, not proof that a person heard speech.</p>
      <fieldset disabled={!active || status === "connecting" || status === "ending"}>
        <legend>Mark what you intend or hear</legend>
        <div className="operator-tools__actions">
          <button type="button" onClick={() => mark("pause_start")}>Mark intended pause</button>
          <button type="button" onClick={() => mark("resume")}>Mark resuming</button>
          <button type="button" onClick={() => mark("completed_turn")}>Mark thought complete</button>
          <button type="button" onClick={() => mark("heard_reply")}>Mark reply heard</button>
        </div>
      </fieldset>
      <label htmlFor="observed-outcome">Your observation (not automatically inferred)
        <select id="observed-outcome" value={summary.manualOutcome || "uncertain"} disabled={savedTraceRef.current === traceRef.current} onChange={(event) => changeOutcome(event.target.value)}>
          <option value="uncertain">Uncertain / not assessed</option>
          <option value="held">Stayed quiet through my intended pause</option>
          <option value="spoke_during_intended_pause">Spoke during my intended pause</option>
          <option value="invalid">Invalid attempt — do not use as a result</option>
        </select>
      </label>
      {summary.truncated ? <p role="alert">Trace limit reached. This incomplete trace cannot support a comparison.</p> : null}
      <div className="operator-tools__actions"><button type="button" disabled={active || saved.length >= 2 || savedTraceRef.current === traceRef.current} onClick={keepTrace}>Keep timing snapshot</button></div>
    </>}
    <p>{saved.length}/2 timing snapshots explicitly kept in this tab.</p>
    {saved.length ? <p>Kept observations are frozen. Download current run exports only the run shown above; Download kept snapshots exports only the explicitly kept copies. Clear all timings to start a new pair.</p> : null}
    {saved.length === 2 ? <>
      <label><input type="checkbox" checked={sameConditions} onChange={(event) => setSameConditions(event.target.checked)} />I used the same fictional case, equipment and conditions.</label>
      <p>{comparison?.comparable ? "Pair ready for manual review. Two runs do not establish superiority or older-adult benefit." : `Not comparable: ${comparison?.reason || "one run in each mode is required"}.`}</p>
    </> : null}
    <div className="operator-tools__actions">
      <button type="button" disabled={active || !snapshot} onClick={() => exportTraces([snapshot])}>Download current run</button>
      <button type="button" disabled={active || !saved.length} onClick={() => exportTraces(saved)}>Download kept snapshots</button>
      <button type="button" disabled={active} onClick={clearAll}>Clear all timings</button>
    </div>
    {notice ? <p role="status">{notice}</p> : null}
  </aside>;

  return <VoiceDemoApp onTiming={optIn ? onTiming : null} onRunStart={onRunStart}
    onSessionReset={resetCurrent} onStatusChange={onStatusChange} setupExtras={setupExtras} sessionExtras={sessionExtras} />;
}

export default function OperatorVoiceApp() {
  const [view, setView] = useState("manual");
  const [busy, setBusy] = useState(false);
  return <>
    <nav className="operator-tools operator-switcher" aria-label="Local operator workflow">
      <div className="operator-tools__actions">
        <button type="button" disabled={busy} aria-pressed={view === "manual"} onClick={() => setView("manual")}>Manual canary</button>
        <button type="button" disabled={busy} aria-pressed={view === "replay"} onClick={() => setView("replay")}>Matched audio replay</button>
      </div>
      <p>Local-only tools. Switching workflows clears the previous workflow’s in-memory data. Stop the current session first.</p>
    </nav>
    {view === "manual" ? <ManualOperatorApp onActiveChange={setBusy} /> : <ReplayPanel onActiveChange={setBusy} />}
  </>;
}
