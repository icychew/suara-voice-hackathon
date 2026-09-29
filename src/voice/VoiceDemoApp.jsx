import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COPY, LOCALES } from "./copy.js";
import { SESSION_LIMIT_MS, SuaraVoiceClient } from "./voiceClient.js";
import { SuaraStreamingClient } from "./streamingClient.js";
import { STREAMING_COPY, PERSONALISED_COPY, CAPABILITY_COPY } from "./streamingCopy.js";
import { fetchVoiceCapabilities } from "./capabilities.js";
import { readInterfaceLocale, withInterfaceLocale } from "../locale.js";
import { appendSpokenToken, createEvidenceIdLedger, upsertTurn } from "./transcript.js";
import { buildReviewedMemoryMarkdown, MAX_CORRECTION_CHARS, MAX_MEMORY_TITLE_CHARS,
  reconcileReviewMap, selectReviewedTurns, setReviewCorrection, setReviewStatus } from "./review.js";

const ACTIVE_STATUSES = new Set(["connecting", "listening", "thinking", "speaking", "ending"]);

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function MemoryMark() {
  return (
    <span className="memory-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function LocaleSwitcher({ copy, locale, onChange }) {
  return (
    <div className="voice-locale" role="group" aria-label={copy.localeLabel}>
      {LOCALES.map((item) => (
        <button
          aria-pressed={locale === item.id}
          className={locale === item.id ? "is-active" : ""}
          key={item.id}
          onClick={() => onChange(item.id)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function VoiceDisc({ status }) {
  const active = ACTIVE_STATUSES.has(status);
  return (
    <div className={`voice-disc voice-disc--${status}${active ? " is-active" : ""}`} aria-hidden="true">
      <span className="voice-disc__orbit" />
      <span className="voice-disc__core">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function VoiceDemoApp({ onTiming = null, onRunStart = null, onSessionReset = null,
  onStatusChange = null, setupExtras = null, sessionExtras = null } = {}) {
  const [locale, setLocale] = useState(() => readInterfaceLocale(window.location.search));
  const [mode, setMode] = useState("patient");
  const [consent, setConsent] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [status, setStatus] = useState("idle");
  const [errorKind, setErrorKind] = useState(null);
  const [turns, setTurns] = useState([]);
  const [reviewByKey, setReviewByKey] = useState({});
  const [memoryTitle, setMemoryTitle] = useState("");
  const [downloadState, setDownloadState] = useState("idle");
  const [userPartial, setUserPartial] = useState(null);
  const [agentPartial, setAgentPartial] = useState(null);
  const [remainingMs, setRemainingMs] = useState(SESSION_LIMIT_MS);
  const [endsAt, setEndsAt] = useState(null);
  const [resolvedMode, setResolvedMode] = useState(null);
  const [endReason, setEndReason] = useState(null);
  const [streamingControl, setStreamingControl] = useState(null);
  const [personalised, setPersonalised] = useState(false);
  const [questionSelection, setQuestionSelection] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [capabilityCheckState, setCapabilityCheckState] = useState("idle");
  const [capabilityError, setCapabilityError] = useState(null);
  const capabilityRequestRef = useRef(null);
  const evidenceLedgerRef = useRef(createEvidenceIdLedger());
  const clientRef = useRef(null);
  const conversationRef = useRef(null);
  const keepReviewRef = useRef(null);
  const resetButtonRef = useRef(null);
  const transcriptRef = useRef(null);
  const followTranscriptRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const streamingCopy = STREAMING_COPY[locale];
  const personalCopy = PERSONALISED_COPY[locale];
  const capabilityCopy = CAPABILITY_COPY[locale];
  const c = mode === "streaming" ? {
    ...COPY[locale], ...streamingCopy.overrides,
    ...(personalised ? personalCopy.overrides : {}),
    resolvedModes: { ...COPY[locale].resolvedModes, streaming: streamingCopy.ready },
    errorMessages: { ...COPY[locale].errorMessages, ...capabilityCopy.errors, speech: streamingCopy.speechError },
  } : COPY[locale];

  const userTurns = useMemo(
    () => turns.filter((turn) => turn.role === "user" && turn.text.trim()),
    [turns],
  );

  const handleVoiceEvent = useCallback((event) => {
    switch (event.type) {
      case "status":
        setStatus(event.status);
        break;
      case "ready":
        setEndsAt(event.endsAt);
        setRemainingMs(SESSION_LIMIT_MS);
        setResolvedMode(event.mode);
        break;
      case "streaming-control":
        setStreamingControl(event);
        break;
      case "question-selection":
        setQuestionSelection(event.source);
        break;
      case "capabilities":
        setCapabilities(event.capabilities);
        setCapabilityCheckState("checked");
        setCapabilityError(null);
        break;
      case "user-delta":
        setUserPartial({ key: `user-${event.itemId || "partial"}`, text: event.text });
        break;
      case "user-transcript": {
        const key = `user-${event.itemId || crypto.randomUUID()}`;
        setReviewByKey((current) => reconcileReviewMap(current, key, event.text));
        const sourceId = typeof event.text === "string" && event.text.trim()
          ? evidenceLedgerRef.current.ensure(key) : undefined;
        setTurns((current) => upsertTurn(current, { key, role: "user", sourceId, text: event.text }));
        setUserPartial(null);
        break;
      }
      case "agent-delta":
        setAgentPartial((current) => {
          const key = `agent-${event.replyId || event.itemId || "partial"}`;
          return {
            key,
            text: current?.key === key ? appendSpokenToken(current.text, event.delta) : event.delta,
          };
        });
        break;
      case "agent-transcript": {
        const key = `agent-${event.replyId || event.itemId || crypto.randomUUID()}`;
        setTurns((current) => upsertTurn(current, {
          key, role: "agent", text: event.text, interrupted: event.interrupted,
        }));
        setAgentPartial(null);
        break;
      }
      case "speech-started":
        setAgentPartial(null);
        break;
      case "interrupted":
        setAgentPartial(null);
        break;
      case "error":
        setErrorKind(event.kind || "generic");
        setStatus("error");
        setEndsAt(null);
        setResolvedMode(null);
        setEndReason(null);
        setUserPartial(null);
        setAgentPartial(null);
        break;
      case "ended":
        setStatus("ended");
        setEndReason(event.reason || "complete");
        setEndsAt(null);
        setUserPartial(null);
        setAgentPartial(null);
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    if (!endsAt || !ACTIVE_STATUSES.has(status)) return undefined;

    const updateClock = () => setRemainingMs(Math.max(0, endsAt - Date.now()));
    updateClock();
    const timer = window.setInterval(updateClock, 250);
    return () => window.clearInterval(timer);
  }, [endsAt, status]);

  useEffect(() => {
    const disposeCurrent = () => {
      capabilityRequestRef.current?.abort();
      capabilityRequestRef.current = null;
      const client = clientRef.current;
      clientRef.current = null;
      client?.dispose();
    };
    const endOnPageHide = () => {
      disposeCurrent();
      setTurns([]);
      setReviewByKey({});
      setMemoryTitle("");
      setDownloadState("idle");
      setUserPartial(null);
      setAgentPartial(null);
      setConsent(false);
      setAccessCode("");
      setConfirmReset(false);
      setErrorKind(null);
      setEndsAt(null);
      setResolvedMode(null);
      setEndReason(null);
      setStreamingControl(null);
      setQuestionSelection(null);
      setPersonalised(false);
      setCapabilities(null);
      setCapabilityCheckState("idle");
      setCapabilityError(null);
      setRemainingMs(SESSION_LIMIT_MS);
      setStatus("idle");
      evidenceLedgerRef.current.clear();
    };
    window.addEventListener("pagehide", endOnPageHide);
    return () => {
      window.removeEventListener("pagehide", endOnPageHide);
      disposeCurrent();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : locale;
  }, [locale]);

  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);

  const hasUnsavedWork = ACTIVE_STATUSES.has(status) || turns.length > 0
    || Boolean(userPartial?.text) || Boolean(agentPartial?.text);
  useEffect(() => {
    if (!hasUnsavedWork) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedWork]);

  useEffect(() => {
    if (status === "connecting") conversationRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (confirmReset) keepReviewRef.current?.focus();
  }, [confirmReset]);

  useEffect(() => {
    const panel = transcriptRef.current;
    if (panel && followTranscriptRef.current) panel.scrollTop = panel.scrollHeight;
  }, [turns, userPartial, agentPartial]);

  const chooseLocale = (nextLocale) => {
    setLocale(nextLocale);
    document.documentElement.lang = nextLocale === "zh" ? "zh-Hans" : nextLocale;
    window.history.replaceState(null, "", withInterfaceLocale("/voice/", nextLocale));
  };

  const startInterview = async () => {
    if (!consent || status !== "idle" || capabilityCheckState === "checking") return;
    if (mode === "streaming" && (!capabilities?.streaming || (personalised && !capabilities.aiQuestions))) return;
    if (!/^[!-~]{16,128}$/.test(accessCode.trim())) {
      setErrorKind("access");
      conversationRef.current?.focus();
      return;
    }

    setErrorKind(null);
    setTurns([]);
    setReviewByKey({});
    setMemoryTitle("");
    setDownloadState("idle");
    setUserPartial(null);
    setAgentPartial(null);
    setResolvedMode(null);
    setEndReason(null);
    setStreamingControl(null);
    setQuestionSelection(null);
    followTranscriptRef.current = true;
    setShowLatest(false);
    setStatus("connecting");
    onRunStart?.({ mode });

    const Client = mode === "streaming" ? SuaraStreamingClient : SuaraVoiceClient;
    const client = new Client({
      mode, personalised: mode === "streaming" && personalised, accessCode: accessCode.trim(), onTiming,
      onEvent: (event) => {
        if (clientRef.current === client) handleVoiceEvent(event);
      },
    });
    clientRef.current = client;

    try {
      await client.start();
    } catch (error) {
      if (clientRef.current !== client) return;
      setErrorKind(error?.kind || "generic");
      setStatus("error");
    }
  };

  const finishInterview = () => {
    void clientRef.current?.end("user");
  };

  const resetInterview = () => {
    capabilityRequestRef.current?.abort();
    capabilityRequestRef.current = null;
    setCapabilities(null);
    setCapabilityCheckState("idle");
    setCapabilityError(null);
    if (mode === "streaming") setMode("patient");
    const client = clientRef.current;
    clientRef.current = null;
    client?.dispose();
    setConsent(false);
    setAccessCode("");
    setConfirmReset(false);
    setStatus("idle");
    setErrorKind(null);
    setTurns([]);
    setReviewByKey({});
    setMemoryTitle("");
    setDownloadState("idle");
    setUserPartial(null);
    setAgentPartial(null);
    setEndsAt(null);
    setRemainingMs(SESSION_LIMIT_MS);
    setResolvedMode(null);
    setEndReason(null);
    setStreamingControl(null);
    setQuestionSelection(null);
    setPersonalised(false);
    evidenceLedgerRef.current.clear();
    onSessionReset?.();
    followTranscriptRef.current = true;
    setShowLatest(false);
    window.requestAnimationFrame(() => document.getElementById("setup-title")?.focus());
  };

  const isActive = ACTIVE_STATUSES.has(status);
  const optionalModeBlocked = mode === "streaming" && (!capabilities?.streaming || (personalised && !capabilities.aiQuestions));
  const controlsLocked = status !== "idle";
  const statusText = c.statuses[status] || c.statuses.idle;
  const statusHelp = isActive ? c.interruptTip
    : status === "ended" ? (c.endReasons[endReason] || c.endReasons.complete)
      : c.limit;
  const canReview = (status === "ended" || status === "error") && userTurns.length > 0;
  const reviewTurns = userTurns;
  const reviewedTurns = useMemo(
    () => selectReviewedTurns(reviewTurns, reviewByKey),
    [reviewByKey, reviewTurns],
  );
  const reviewCounts = useMemo(() => reviewTurns.reduce((counts, turn) => {
    const review = reviewByKey[turn.key];
    const status = review?.sourceText === turn.text ? review.status : "unreviewed";
    counts[status] += 1;
    return counts;
  }, { unreviewed: 0, reviewed: 0, excluded: 0 }), [reviewByKey, reviewTurns]);

  const chooseReviewStatus = (turn, nextStatus) => {
    setReviewByKey((current) => ({
      ...current,
      [turn.key]: setReviewStatus(current[turn.key], nextStatus, turn.text),
    }));
    setDownloadState("idle");
  };

  const changeCorrection = (turn, correction) => {
    setReviewByKey((current) => ({
      ...current,
      [turn.key]: setReviewCorrection(current[turn.key], correction, turn.text),
    }));
    setDownloadState("idle");
  };

  const downloadMemory = () => {
    if (!reviewedTurns.length) return;
    try {
      const markdown = buildReviewedMemoryMarkdown({
        title: memoryTitle,
        fallbackTitle: c.memoryTitleDefault,
        boundary: c.downloadBoundary,
        sourceLabel: c.source,
        correctedLabel: c.correctedLabel,
        originalLabel: c.originalTranscript,
        selections: reviewedTurns,
      });
      const url = window.URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "suara-reviewed-memory.md";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
      setDownloadState("requested");
    } catch {
      setDownloadState("error");
    }
  };

  const changeAccessCode = (value) => {
    capabilityRequestRef.current?.abort();
    capabilityRequestRef.current = null;
    setAccessCode(value);
    setCapabilities(null);
    setCapabilityCheckState("idle");
    setCapabilityError(null);
    setPersonalised(false);
    if (mode === "streaming") { setMode("patient"); setConsent(false); }
  };

  const checkOptionalModes = async () => {
    if (controlsLocked || capabilityRequestRef.current || !/^[!-~]{16,128}$/.test(accessCode.trim())) return;
    const controller = new AbortController();
    capabilityRequestRef.current = controller;
    setCapabilities(null);
    setCapabilityCheckState("checking");
    setCapabilityError(null);
    setPersonalised(false);
    if (mode === "streaming") { setMode("patient"); setConsent(false); }
    try {
      const result = await fetchVoiceCapabilities({ accessCode: accessCode.trim(), signal: controller.signal });
      if (capabilityRequestRef.current !== controller || controller.signal.aborted) return;
      setCapabilities(result);
      setCapabilityCheckState("checked");
    } catch (error) {
      if (capabilityRequestRef.current !== controller || controller.signal.aborted) return;
      setCapabilityError(error?.kind || "capabilities");
      setCapabilityCheckState("error");
    } finally {
      if (capabilityRequestRef.current === controller) capabilityRequestRef.current = null;
    }
  };

  return (
    <>
      <a className="voice-skip" href="#voice-session" onClick={() => document.getElementById("voice-session")?.focus()}>{c.skip}</a>

      <header className="voice-header">
        <a className="voice-wordmark" href={withInterfaceLocale("/", locale)} aria-label={c.homeLabel}>
          <MemoryMark />
          <span>Suara</span>
        </a>
        <div className="voice-header__actions">
          <a className="voice-home-link" href={withInterfaceLocale("/", locale)}>{c.home}</a>
          <LocaleSwitcher copy={c} locale={locale} onChange={chooseLocale} />
        </div>
      </header>

      <main>
        <section className="voice-hero voice-shell" aria-labelledby="voice-title">
          <div className="voice-hero__copy">
            <p className="voice-kicker">{c.eyebrow}</p>
            <h1 id="voice-title">{c.title}</h1>
            <p className="voice-hero__intro">{c.intro}</p>
            <a className="hero-action" href="#setup-title">{c.prepare} <span aria-hidden="true">↓</span></a>
            <div className="pilot-boundary">
              <span className="pilot-boundary__mark" aria-hidden="true">i</span>
              <div>
                <strong>{c.pilotTag}</strong>
                <p>{c.pilotNote}</p>
              </div>
            </div>
            <ul className="privacy-pills" aria-label={c.sessionBoundariesLabel}>
              {c.privacyPills.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
          <div className="voice-hero__object">
            <div className="memory-rings" aria-hidden="true">
              <span className="memory-rings__label">SUARA · 2026</span>
              <span className="memory-rings__center"><MemoryMark /></span>
            </div>
            <p aria-hidden="true">listen · remember · review</p>
          </div>
        </section>

        <section className={`voice-studio${status !== "idle" ? " is-started" : ""}`} id="voice-session" aria-labelledby="setup-title" tabIndex={-1}>
          <div className="voice-shell voice-studio__grid">
            <div className="setup-panel">
              <p className="voice-kicker">{c.setupEyebrow}</p>
              <h2 id="setup-title" tabIndex={-1}>{c.setupTitle}</h2>
              <p className="setup-panel__lead">{c.setupBody}</p>
              <p className="recording-hold" role="note">{c.recordingHold}</p>
              {setupExtras}

              <form onSubmit={(event) => { event.preventDefault(); startInterview(); }}>
              <fieldset className="mode-picker" disabled={controlsLocked}>
                <legend>{c.modeLegend}</legend>
                {[...Object.entries(c.modes), ...(!onTiming ? [["streaming", streamingCopy.mode]] : [])].map(([id, option]) => (
                  <label className={`mode-option${mode === id ? " is-selected" : ""}`} key={id}>
                    <input
                      checked={mode === id}
                      disabled={id === "streaming" && capabilities?.streaming !== true}
                      name="voice-mode"
                      onChange={() => { setMode(id); setConsent(false); setPersonalised(false); setQuestionSelection(null); setStreamingControl(null); setErrorKind(null); }}
                      type="radio"
                      value={id}
                    />
                    <span className="mode-option__radio" aria-hidden="true" />
                    <span className="mode-option__copy">
                      <span className="mode-option__title">
                        <strong>{option.name}</strong>
                        <small>{option.badge}</small>
                      </span>
                      <span>{option.detail}</span>
                      {id === "streaming" && capabilities?.streaming !== true ?
                        <span className="mode-availability">{capabilities ? capabilityCopy.unavailable : capabilityCopy.locked}</span> : null}
                    </span>
                  </label>
                ))}
              </fieldset>

              {mode === "streaming" ? <>
                <p className="streaming-notice" role="note">{streamingCopy.notice}</p>
                <div className="personalised-option">
                  <label>
                    <input type="checkbox" checked={personalised} disabled={controlsLocked || capabilities?.aiQuestions !== true}
                      aria-describedby="personalised-detail"
                      onChange={(event) => { setPersonalised(event.target.checked); setConsent(false); setQuestionSelection(null); }} />
                    <strong>{personalCopy.label}</strong>
                  </label>
                  <p id="personalised-detail">{personalCopy.detail}</p>
                  {capabilities?.aiQuestions !== true ? <p className="mode-availability">{capabilityCopy.unavailable}</p> : null}
                </div>
              </> : null}

              <div className="access-code">
                <label htmlFor="voice-access-code">{c.accessLabel}</label>
                <input id="voice-access-code" type="password" value={accessCode}
                  autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128}
                  disabled={controlsLocked} aria-describedby="voice-access-hint"
                  onChange={(event) => changeAccessCode(event.target.value)} />
                <p id="voice-access-hint">{c.accessHint}</p>
              </div>

              {!onTiming ? <div className="capability-check">
                <button className="secondary-action" type="button" onClick={checkOptionalModes}
                  disabled={controlsLocked || capabilityCheckState === "checking" || !/^[!-~]{16,128}$/.test(accessCode.trim())}>
                  {capabilityCheckState === "checking" ? capabilityCopy.checking : capabilityCopy.check}
                </button>
                <p role="status">{capabilityCheckState === "checking" ? capabilityCopy.checking : capabilityError
                  ? (capabilityCopy.errors[capabilityError] || capabilityCopy.errors.capabilities)
                  : capabilities ? (capabilities.aiQuestions ? capabilityCopy.all : capabilities.streaming ? capabilityCopy.streaming : capabilityCopy.disabled)
                  : capabilityCopy.idle}</p>
              </div> : null}

              <div className={`consent-card${consent ? " is-checked" : ""}`}>
                <label>
                  <input
                    aria-describedby="voice-consent-detail"
                    checked={consent}
                    disabled={controlsLocked}
                    onChange={(event) => setConsent(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="consent-card__box" aria-hidden="true">✓</span>
                  <strong>{c.consent}</strong>
                </label>
                <p id="voice-consent-detail">{c.consentDetail}</p>
              </div>

              <a className="synthetic-fallback" href={withInterfaceLocale("/prototype/", locale)}>
                {c.fallback} <span aria-hidden="true">↗</span>
              </a>

              {status === "idle" ? (
                <button
                  className="primary-action"
                  disabled={!consent || !accessCode.trim() || optionalModeBlocked || capabilityCheckState === "checking"}
                  type="submit"
                >
                  <span className="primary-action__dot" aria-hidden="true" />
                  {c.start}
                </button>
              ) : null}

              {status === "ended" || status === "error" ? (
                <div className="reset-panel">
                  {confirmReset ? (
                    <>
                      <p role="alert">{c.clearWarning}</p>
                      <button className="primary-action" onClick={resetInterview} type="button">{c.clearConfirm}</button>
                      <button className="secondary-action" ref={keepReviewRef} onClick={() => {
                        setConfirmReset(false);
                        window.requestAnimationFrame(() => resetButtonRef.current?.focus());
                      }} type="button">{c.keepReview}</button>
                    </>
                  ) : (
                    <button className="primary-action" ref={resetButtonRef} onClick={() => turns.length ? setConfirmReset(true) : resetInterview()} type="button">
                      <span aria-hidden="true">↺</span>{c.reset}
                    </button>
                  )}
                </div>
              ) : null}
              </form>
            </div>

            <div className="conversation-panel" ref={conversationRef} tabIndex={-1} aria-label={c.liveTitle}>
              <div className={`session-state session-state--${status}`}>
                <VoiceDisc status={status} />
                <div className="session-state__copy">
                  <span>{c.statusLabel}</span>
                  <strong aria-live="polite">{statusText}</strong>
                  <p>{statusHelp}</p>
                  {resolvedMode ? (
                    <small className="resolved-config" role="status">
                      <span aria-hidden="true">{resolvedMode === "streaming" ? "i" : "✓"}</span> {c.resolvedModes[resolvedMode]}
                    </small>
                  ) : null}
                  {mode === "streaming" && streamingControl?.lastRequested ? (
                    <p className="streaming-control" aria-label={streamingCopy.controlLabel}>
                      {streamingCopy.control
                        .replace("{min}", String(streamingControl.lastRequested.minimum))
                        .replace("{max}", String(streamingControl.lastRequested.maximum))
                        .replace("{count}", String(streamingControl.updatesQueued))}
                    </p>
                  ) : null}
                  {mode === "streaming" && personalised && questionSelection ? (
                    <p className="streaming-control" role="status">{personalCopy.selection[questionSelection]}</p>
                  ) : null}
                </div>
                <div className="session-clock">
                  <span>{c.timerLabel}</span>
                  <time dateTime={`PT${Math.ceil(remainingMs / 1000)}S`}>{formatTime(remainingMs)}</time>
                </div>
              </div>

              {isActive ? (
                <div className="session-controls">
                  <button className="secondary-action" disabled={status === "ending"}
                    onClick={finishInterview} type="button">
                    {status === "connecting" ? c.cancelConnection : c.finish}
                  </button>
                </div>
              ) : null}

              {canReview ? <a className="review-link" href="#preview-title">{c.reviewNow} ↓</a> : null}
              {sessionExtras}

              {errorKind ? (
                <div className="voice-error" role="alert">
                  <span aria-hidden="true">!</span>
                  <p>{c.errorMessages[errorKind] || c.errorMessages.generic}</p>
                </div>
              ) : null}

              <section className="transcript" aria-labelledby="live-title">
                <div className="panel-heading">
                  <div>
                    <p className="voice-kicker">{c.liveKicker}</p>
                    <h3 id="live-title">{c.liveTitle}</h3>
                  </div>
                  <span className="local-only"><i aria-hidden="true" /> {c.localOnly}</span>
                </div>

                <p className="sr-only" role="status">{turns.length ? c.transcriptUpdated.replace("{count}", turns.length) : ""}</p>
                <div className="transcript__body" ref={transcriptRef} tabIndex={0} aria-label={c.liveTitle}
                  onScroll={(event) => {
                    const panel = event.currentTarget;
                    followTranscriptRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 72;
                    setShowLatest(!followTranscriptRef.current);
                  }}>
                  {turns.length === 0 && !userPartial && !agentPartial ? (
                    <p className="transcript__empty">{c.liveEmpty}</p>
                  ) : null}

                  {turns.map((turn) => {
                    const sourceId = turn.role === "user" ? turn.sourceId : null;
                    return (
                      <article
                        className={`turn turn--${turn.role}`}
                        id={sourceId ? `evidence-${sourceId}` : undefined}
                        key={turn.key}
                        tabIndex={sourceId ? -1 : undefined}
                      >
                        <div className="turn__meta">
                          <strong>{turn.role === "user" ? c.userLabel : c.agentLabel}</strong>
                          {sourceId ? <span>{sourceId}</span> : null}
                          {turn.interrupted ? <span>{c.interruptedLabel}</span> : null}
                        </div>
                        <p>{turn.text}</p>
                      </article>
                    );
                  })}

                  {userPartial?.text ? (
                    <article className="turn turn--user turn--partial">
                      <div className="turn__meta"><strong>{c.userLabel}</strong><span>{c.partialLabel}</span></div>
                      <p>{userPartial.text}</p>
                    </article>
                  ) : null}

                  {agentPartial?.text ? (
                    <article className="turn turn--agent turn--partial">
                      <div className="turn__meta"><strong>{c.agentLabel}</strong></div>
                      <p>{agentPartial.text}</p>
                    </article>
                  ) : null}
                </div>
                {showLatest ? <button className="latest-action" type="button" onClick={() => {
                  followTranscriptRef.current = true;
                  if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
                  setShowLatest(false);
                }}>{c.latest} ↓</button> : null}
              </section>
            </div>
          </div>
        </section>

        <section className={`memoir-preview${canReview ? " is-ready" : ""}`} aria-labelledby="preview-title">
          <div className="voice-shell memoir-preview__grid">
            <div className="memoir-preview__intro">
              <p className="voice-kicker">{c.previewKicker}</p>
              <h2 id="preview-title" tabIndex={-1}>{c.previewTitle}</h2>
              <p>{c.previewIntro}</p>
            </div>
            <div className="memoir-page">
              {!canReview ? (
                <p className="memoir-page__empty">
                  {status === "ended" && userTurns.length === 0 ? c.previewEmptyEnded : c.previewEmpty}
                </p>
              ) : (
                <div className="memory-review-workspace">
                  <section className="memory-review" aria-labelledby="memory-review-title">
                    <div className="memory-review__heading">
                      <span className="memoir-page__status">{c.candidate}</span>
                      <h3 id="memory-review-title">{c.reviewHeading}</h3>
                      <p>{c.reviewBody}</p>
                      <p className="memory-review__progress" role="status">
                        {c.reviewProgress
                          .replace("{reviewed}", reviewCounts.reviewed)
                          .replace("{excluded}", reviewCounts.excluded)
                          .replace("{unreviewed}", reviewCounts.unreviewed)}
                      </p>
                    </div>
                    <div className="memory-review__list">
                      {reviewTurns.map((turn) => {
                        const review = reviewByKey[turn.key]?.sourceText === turn.text
                          ? reviewByKey[turn.key]
                          : { status: "unreviewed", correction: "" };
                        return (
                          <article className={`memory-review-card is-${review.status}`} key={turn.key}>
                            <div className="memory-review-card__meta">
                              <strong>{c.source} {turn.sourceId}</strong>
                              <span>{c.reviewStatuses[review.status]}</span>
                            </div>
                            <blockquote>“{turn.text}”</blockquote>
                            <div className="memory-review-card__actions" role="group"
                              aria-label={c.reviewDecisionLabel.replace("{source}", turn.sourceId)}>
                              {Object.entries(c.reviewStatuses).map(([decision, label]) => (
                                <button aria-pressed={review.status === decision} key={decision}
                                  onClick={() => chooseReviewStatus(turn, decision)} type="button">
                                  {label}
                                </button>
                              ))}
                            </div>
                            <label htmlFor={`memory-correction-${turn.sourceId}`}>{c.correctionLabel}</label>
                            <textarea id={`memory-correction-${turn.sourceId}`} maxLength={MAX_CORRECTION_CHARS}
                              onChange={(event) => changeCorrection(turn, event.target.value)}
                              placeholder={c.correctionPlaceholder} rows="3" value={review.correction} />
                            <small>{c.correctionNote}</small>
                          </article>
                        );
                      })}
                    </div>
                  </section>

                  <section className="memory-document" aria-labelledby="reviewed-preview-title">
                    <label htmlFor="memory-title">{c.memoryTitleLabel}</label>
                    <input id="memory-title" maxLength={MAX_MEMORY_TITLE_CHARS}
                      onChange={(event) => { setMemoryTitle(event.target.value); setDownloadState("idle"); }}
                      placeholder={c.memoryTitleDefault} type="text" value={memoryTitle} />
                    <h3 id="reviewed-preview-title">{c.previewLead}</h3>
                    <div className="memoir-excerpts">
                      {reviewedTurns.length ? reviewedTurns.map((turn) => (
                        <blockquote key={turn.key}>
                          <p>“{turn.text}”</p>
                          {turn.corrected ? <small>{c.correctedLabel}</small> : null}
                          <a href={`#evidence-${turn.sourceId}`}>{c.source} {turn.sourceId} ↑</a>
                        </blockquote>
                      )) : <p className="memoir-excerpts__empty">{c.noReviewedMemories}</p>}
                    </div>
                    <button className="download-memory" disabled={!reviewedTurns.length}
                      onClick={downloadMemory} type="button">{c.downloadMemory}</button>
                    <p className="download-boundary">{c.downloadNote}</p>
                    {downloadState !== "idle" ? (
                      <p className={`download-status is-${downloadState}`} role="status">
                        {downloadState === "requested" ? c.downloaded : c.downloadError}
                      </p>
                    ) : null}
                  </section>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="question-route voice-shell" aria-labelledby="questions-title">
          <div className="question-route__heading">
            <p className="voice-kicker">{c.questionsKicker}</p>
            <h2 id="questions-title">{c.questionsTitle}</h2>
          </div>
          <ol>
            {c.questions.map(([title, detail], index) => (
              <li key={title}>
                <span>0{index + 1}</span>
                <div><strong>{title}</strong><p>{detail}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="privacy-map" aria-labelledby="privacy-title">
          <div className="voice-shell">
            <div className="privacy-map__heading">
              <p className="voice-kicker">{c.privacyKicker}</p>
              <h2 id="privacy-title">{c.privacyTitle}</h2>
            </div>
            <div className="privacy-map__items">
              {c.privacyItems.map(([title, detail], index) => (
                <article key={title}>
                  <span aria-hidden="true">{index === 0 ? "→" : index === 1 ? "○" : "×"}</span>
                  <h3>{title}</h3>
                  <p>{detail}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="voice-footer">
        <div className="voice-shell">
          <a className="voice-wordmark voice-wordmark--footer" href={withInterfaceLocale("/", locale)}>
            <MemoryMark />
            <span>Suara</span>
          </a>
          <p>{c.footer}</p>
          <a aria-label={c.backTop} href="#voice-title">↑</a>
        </div>
      </footer>
    </>
  );
}

export default VoiceDemoApp;
