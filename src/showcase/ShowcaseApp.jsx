import { useEffect, useState } from "react";
import { normalizeInterfaceLocale, readInterfaceLocale, withInterfaceLocale } from "../locale.js";
import { INITIAL_REVIEW_STATES, LANE_FIXTURES, SHOWCASE_CONTRACT } from "./fixture.js";
import { getIntegrityMetrics, getReviewSummary } from "./integrity.js";
import { SHOWCASE_COPY, SHOWCASE_LOCALES } from "./copy.js";
import FixturePlayer from "./FixturePlayer.jsx";
import { createSyntheticReviewExport } from "./export.js";

const REVIEW_STATES = ["approved", "followup", "excluded"];
const DOCUMENT_LOCALES = ["en", "ms", "zh"];
const SEGMENT_IDS = LANE_FIXTURES.ms.segments.map((segment) => segment.id);
const INITIAL_SELECTED_EVIDENCE = SEGMENT_IDS.filter((id) => INITIAL_REVIEW_STATES[id] === "approved");

function Icon({ name, size = 20 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (name === "check") return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
  if (name === "lock") return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
  if (name === "shield") return <svg {...common}><path d="M12 3 5.5 5.5v5.8c0 4.2 2.7 7.6 6.5 9.2 3.8-1.6 6.5-5 6.5-9.2V5.5L12 3Z" /><path d="m9 12 2 2 4-4" /></svg>;
  if (name === "globe") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg>;
  if (name === "audio") return <svg {...common}><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" /></svg>;
  if (name === "reset") return <svg {...common}><path d="M4 4v6h6" /><path d="M5.5 15a7.5 7.5 0 1 0 .7-7.7L4 10" /></svg>;
  if (name === "arrow") return <svg {...common}><path d="M5 12h14M14 7l5 5-5 5" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>;
}

function FragmentLink({ children, targetId }) {
  const focusTarget = (event) => {
    const target = document.getElementById(targetId);
    if (!target) return;

    event.preventDefault();
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = targetId;
    window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    target.focus({ preventScroll: true });
    target.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
  };

  return <a href={`#${targetId}`} onClick={focusTarget}>{children}</a>;
}

function StatusMark({ done, active, number }) {
  return (
    <span className={`showcase-step__mark${done ? " is-done" : ""}${active ? " is-active" : ""}`}>
      {done ? <Icon name="check" size={16} /> : number}
    </span>
  );
}

function ProgressRail({ copy, step, maxStep, onNavigate }) {
  return (
    <aside className="showcase-progress" aria-label={copy.progress}>
      <p className="showcase-progress__label">{copy.progress}</p>
      <ol>
        {copy.stages.map((label, index) => {
          const reachable = index <= maxStep;
          const done = index < step || (step === 7 && index === 7);
          return (
            <li key={copy.stageIds[index]}>
              <button
                aria-current={step === index ? "step" : undefined}
                className={step === index ? "is-active" : ""}
                disabled={!reachable}
                onClick={() => onNavigate(index)}
                type="button"
              >
                <StatusMark active={step === index} done={done} number={index + 1} />
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function SafetyRail({ copy, selectedCount, lane }) {
  return (
    <aside className="showcase-safety" aria-label={copy.privacyTitle}>
      <section>
        <div className="showcase-rail-title"><span className="icon-disc"><Icon name="shield" /></span><h2>{copy.privacyTitle}</h2></div>
        <ul>{copy.privacyItems.map((item) => <li key={item}><Icon name="check" size={16} />{item}</li>)}</ul>
      </section>
      <section className="showcase-rail-facts">
        <dl>
          <div><dt>{copy.modeLabel}</dt><dd>{SHOWCASE_CONTRACT.schema}</dd></div>
          <div><dt>{copy.routeLabel}</dt><dd>{lane.route}</dd></div>
          <div><dt>{copy.evidenceLabel}</dt><dd>{copy.evidenceCount.replace("{count}", selectedCount)}</dd></div>
          <div><dt>{copy.releaseLabel}</dt><dd className="is-blocked">{SHOWCASE_CONTRACT.releaseState}</dd></div>
        </dl>
      </section>
    </aside>
  );
}

function StageHeading({ copy, step, title, body }) {
  return (
    <header className="showcase-stage-heading">
      <p>{copy.stageIds[step]}</p>
      <h1>{title}</h1>
      <span>{body}</span>
    </header>
  );
}

function ConsentStage({ copy }) {
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={0} title={copy.consentTitle} body={copy.consentBody} />
      <div className="showcase-principles">
        {copy.consentItems.map(([title, body]) => (
          <article key={title}><span className="icon-disc"><Icon name="check" /></span><div><h2>{title}</h2><p>{body}</p></div></article>
        ))}
      </div>
      <div className="showcase-boundary-note"><Icon name="lock" /><p><strong>{copy.releaseBlocked}</strong><span>{copy.releaseBody}</span></p></div>
    </div>
  );
}

function AudioStage({ copy, laneKey, onLane }) {
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={1} title={copy.audioTitle} body={copy.audioBody} />
      <section className="showcase-audio-card">
        <div className="showcase-audio-card__top"><span className="icon-disc"><Icon name="audio" /></span><div><h2>{copy.audioName}</h2><p>{copy.audioMeta}</p></div></div>
        <div className="showcase-audio-status" role="note"><strong>{copy.audioAvailability}</strong><span>{copy.audioTranscriptNote}</span></div>
        <div className="showcase-choice-row" aria-label={copy.sampleLanguage}>
          {Object.entries(LANE_FIXTURES).map(([key, lane]) => <button type="button" key={key} aria-pressed={laneKey === key} onClick={() => onLane(key)}>{lane.name}</button>)}
        </div>
        <FixturePlayer copy={copy} laneKey={laneKey} key={laneKey} />
        <ul>{copy.audioFacts.map((item) => <li key={item}><Icon name="check" size={17} />{item}</li>)}</ul>
      </section>
    </div>
  );
}

function RouteStage({ copy, laneKey, onLane }) {
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={2} title={copy.routeTitle} body={copy.routeBody} />
      <div className="showcase-route-grid">
        {Object.entries(LANE_FIXTURES).map(([key, lane]) => (
          <button aria-pressed={laneKey === key} className={laneKey === key ? "is-selected" : ""} key={key} onClick={() => onLane(key)} type="button">
            <span className="showcase-route-grid__radio"><span /></span>
            <strong>{lane.name}</strong><small>{lane.route} · {lane.script}</small>
          </button>
        ))}
      </div>
      <div className="showcase-route-note"><Icon name="shield" /><div><strong>{LANE_FIXTURES[laneKey].model}</strong><p>{copy.routeNote}</p></div></div>
    </div>
  );
}

function SegmentCard({ segment, badge, tone = "candidate", children, selected, onSelect }) {
  return (
    <article className={`showcase-segment showcase-segment--${tone}${selected ? " is-selected" : ""}`} onClick={onSelect}>
      <div className="showcase-segment__meta"><span>{segment.id}</span><span>{segment.time}</span><span>{segment.language}</span></div>
      <blockquote>{segment.text}</blockquote>
      <div className="showcase-segment__footer"><span className={`showcase-badge showcase-badge--${tone}`}>{badge}</span>{children}</div>
    </article>
  );
}

function CandidateStage({ copy, lane, laneKey }) {
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={3} title={copy.candidateTitle} body={copy.candidateBody} />
      <FixturePlayer copy={copy} laneKey={laneKey} key={laneKey} />
      <div className="showcase-segment-list">
        {lane.segments.map((segment) => <SegmentCard badge={copy.candidateLabel} key={segment.id} segment={segment} />)}
      </div>
    </div>
  );
}

function ReviewStage({ copy, lane, laneKey, reviewStates, onReview }) {
  const { allResolved, approvedCount, resolvedCount, segmentCount } = getReviewSummary(
    reviewStates,
    lane.segments.map((segment) => segment.id),
  );
  const reviewStatus = !allResolved ? copy.reviewHint : approvedCount === 0 ? copy.reviewNeedApproved : copy.completed;
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={4} title={copy.reviewTitle} body={copy.reviewBody} />
      <FixturePlayer copy={copy} laneKey={laneKey} key={laneKey} />
      <div className="showcase-review-summary"><strong>{copy.reviewedCount.replace("{count}", resolvedCount).replace("{total}", segmentCount)}</strong><div><span style={{ width: `${resolvedCount / segmentCount * 100}%` }} /></div><p>{reviewStatus}</p></div>
      <div className="showcase-segment-list">
        {lane.segments.map((segment) => {
          const state = reviewStates[segment.id];
          return (
            <SegmentCard badge={copy[state]} key={segment.id} segment={segment} tone={state === "approved" ? "approved" : state === "excluded" ? "excluded" : "followup"}>
              <div className="showcase-review-controls" aria-label={`${segment.id} review state`}>
                {REVIEW_STATES.map((option) => <button aria-pressed={state === option} key={option} onClick={(event) => { event.stopPropagation(); onReview(segment.id, option); }} type="button">{copy[option]}</button>)}
              </div>
            </SegmentCard>
          );
        })}
      </div>
    </div>
  );
}

function StoryStage({ copy, lane, reviewStates, selectedEvidence, onToggleEvidence }) {
  const selected = lane.segments.filter((segment) => selectedEvidence.includes(segment.id));
  const approvedSegments = lane.segments.filter((segment) => reviewStates[segment.id] === "approved");
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={5} title={copy.storyTitle} body={copy.storyBody} />
      <div className="showcase-story-grid">
        <section className="showcase-evidence-picker"><h2>{copy.evidence}</h2>{approvedSegments.map((segment) => {
          const active = selectedEvidence.includes(segment.id);
          return <button aria-pressed={active} className={active ? "is-selected" : ""} id={`evidence-${segment.id}`} key={segment.id} onClick={() => onToggleEvidence(segment.id)} type="button"><span><Icon name={active ? "check" : "shield"} size={17} /></span><div><strong>{segment.id} · {segment.time}</strong><p>{segment.text}</p></div><small>{active ? copy.selected : copy.omitted}</small></button>;
        })}</section>
        <article className="showcase-story-preview"><p className="showcase-document-label">{copy.groundedPreview}</p><h2>{copy.groundedPreview}</h2><p>{copy.storyIntro}</p>{selected.map((segment) => <blockquote key={segment.id}>“{segment.text}” <FragmentLink targetId={`evidence-${segment.id}`}>[{segment.id}]</FragmentLink></blockquote>)}{selected.length === 0 ? <p className="showcase-empty">—</p> : null}</article>
      </div>
    </div>
  );
}

function ReviewDownload({ text, filename, label }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [text]);
  return <a className="showcase-export" href={url || undefined} download={filename} aria-disabled={!url}>{label}</a>;
}

function MemoirStage({ copy, lane, reviewStates, selectedEvidence, documentLocale, onDocumentLocale, template, onTemplate }) {
  const documentCopy = SHOWCASE_COPY[documentLocale];
  const selected = lane.segments.filter((segment) => selectedEvidence.includes(segment.id));
  const exportText = createSyntheticReviewExport({ lane, reviewStates, selectedEvidence, title: documentCopy.memoirTitles[template] });
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={6} title={copy.memoirTitle} body={copy.memoirBody} />
      <div className="showcase-memoir-grid">
        <section className="showcase-memoir-controls">
          <div><h2>{copy.documentLanguage}</h2><div className="showcase-choice-row">{DOCUMENT_LOCALES.map((locale) => <button aria-pressed={documentLocale === locale} className={documentLocale === locale ? "is-selected" : ""} key={locale} onClick={() => onDocumentLocale(locale)} type="button">{SHOWCASE_LOCALES.find((item) => item.id === locale).label}</button>)}</div></div>
          <div><h2>{copy.documentStyle}</h2><div className="showcase-choice-stack">{copy.styles.map((label, index) => <button aria-pressed={template === index} className={template === index ? "is-selected" : ""} key={label} onClick={() => onTemplate(index)} type="button">{label}<Icon name={template === index ? "check" : "shield"} size={17} /></button>)}</div></div>
          <p className="showcase-source-note"><Icon name="shield" size={18} />{copy.sourceNote}</p>
          <ReviewDownload text={exportText} filename={`suara-synthetic-review-${lane.route}.md`} label={copy.downloadDraft} />
          <p className="showcase-source-note">{copy.downloadNote}</p>
        </section>
        <article className="showcase-memoir-paper">
          <p>{copy.phase}</p><h2>{documentCopy.memoirTitles[template]}</h2><em>{documentCopy.dedication}</em>
          {selected.map((segment) => <section id={`memoir-${segment.id}`} key={segment.id} tabIndex="-1"><h3>{segment.id}</h3><blockquote>“{segment.text}” <FragmentLink targetId={`memoir-${segment.id}`}>[{segment.id}]</FragmentLink></blockquote></section>)}
          <footer>{copy.evidenceCount.replace("{count}", selected.length)} · {SHOWCASE_CONTRACT.releaseState}</footer>
        </article>
      </div>
    </div>
  );
}

function IntegrityStage({ copy, lane, reviewStates, selectedEvidence }) {
  const metrics = getIntegrityMetrics({
    contract: SHOWCASE_CONTRACT,
    reviewStates,
    segmentIds: lane.segments.map((segment) => segment.id),
    selectedEvidence,
  });
  return (
    <div className="showcase-stage-body">
      <StageHeading copy={copy} step={7} title={copy.integrityTitle} body={copy.integrityBody} />
      <div className="showcase-integrity-strip">
        <div><span className="icon-disc"><Icon name="check" /></span><strong>{copy.runComplete}</strong></div>
        <div><span className="icon-disc"><Icon name="shield" /></span><strong>{copy.syntheticMode}</strong></div>
        <div><span className="icon-disc"><Icon name="globe" /></span><strong>{copy.noNetwork}</strong></div>
      </div>
      <div className="showcase-integrity-grid">
        <section className="showcase-run-list"><h2>{copy.progress}</h2>{copy.stages.map((stage, index) => <div key={stage}><span>{index + 1}</span><strong>{stage}</strong><Icon name="check" size={17} /></div>)}</section>
        <section className="showcase-evaluation"><h2>{copy.matrix}</h2><strong>{metrics.passedCheckCount} / {metrics.checkCount}</strong><dl><div><dt>{copy.precision}</dt><dd>{metrics.precision.toFixed(2)}</dd></div><div><dt>{copy.recall}</dt><dd>{metrics.recall.toFixed(2)}</dd></div><div><dt>{copy.evidenceLabel}</dt><dd>{metrics.validSelectedCount} / {metrics.approvedCount}</dd></div></dl></section>
        <section className="showcase-release-card"><Icon name="lock" size={32} /><h2>{copy.releaseBlocked}</h2><p>{copy.releaseBody}</p></section>
      </div>
    </div>
  );
}

export default function ShowcaseApp() {
  const [locale, setLocale] = useState(() => readInterfaceLocale(window.location.search));
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [laneKey, setLaneKey] = useState(() => readInterfaceLocale(window.location.search));
  const [reviewStates, setReviewStates] = useState({ ...INITIAL_REVIEW_STATES });
  const [selectedEvidence, setSelectedEvidence] = useState([...INITIAL_SELECTED_EVIDENCE]);
  const [documentLocale, setDocumentLocale] = useState("en");
  const [template, setTemplate] = useState(0);
  const copy = SHOWCASE_COPY[locale];
  const lane = LANE_FIXTURES[laneKey];
  const segmentIds = lane.segments.map((segment) => segment.id);
  const { allResolved, approvedCount, approvedIds } = getReviewSummary(reviewStates, segmentIds);
  const reviewReady = allResolved && approvedCount > 0;
  const evidenceReady = selectedEvidence.length > 0 && selectedEvidence.every((id) => approvedIds.includes(id));
  const canContinue = (step !== 4 || reviewReady) && (step !== 5 || evidenceReady);
  const primaryLabels = [copy.consentAction, copy.audioAction, copy.routeAction, copy.candidateAction, copy.reviewAction, copy.storyAction, copy.memoirAction];

  useEffect(() => {
    document.documentElement.lang = SHOWCASE_LOCALES.find((item) => item.id === locale).htmlLang;
  }, [locale]);

  const chooseLane = (nextLane) => {
    if (nextLane === laneKey) return;
    setLaneKey(nextLane);
    setReviewStates({ ...INITIAL_REVIEW_STATES });
    setSelectedEvidence([...INITIAL_SELECTED_EVIDENCE]);
    setMaxStep((current) => Math.min(current, 2));
  };

  const reviewSegment = (id, state) => {
    setReviewStates((current) => ({ ...current, [id]: state }));
    setMaxStep((current) => Math.min(current, 4));
    if (state !== "approved") {
      setSelectedEvidence((current) => current.filter((item) => item !== id));
    }
  };

  const toggleEvidence = (id) => {
    if (!approvedIds.includes(id)) return;
    const nextEvidence = selectedEvidence.includes(id)
      ? selectedEvidence.filter((item) => item !== id)
      : [...selectedEvidence, id];
    setSelectedEvidence(nextEvidence);
    if (nextEvidence.length === 0) setMaxStep((current) => Math.min(current, 5));
  };

  let stageContent;
  if (step === 0) stageContent = <ConsentStage copy={copy} />;
  else if (step === 1) stageContent = <AudioStage copy={copy} laneKey={laneKey} onLane={chooseLane} />;
  else if (step === 2) stageContent = <RouteStage copy={copy} laneKey={laneKey} onLane={chooseLane} />;
  else if (step === 3) stageContent = <CandidateStage copy={copy} lane={lane} laneKey={laneKey} />;
  else if (step === 4) stageContent = <ReviewStage copy={copy} lane={lane} laneKey={laneKey} reviewStates={reviewStates} onReview={reviewSegment} />;
  else if (step === 5) stageContent = <StoryStage copy={copy} lane={lane} reviewStates={reviewStates} selectedEvidence={selectedEvidence} onToggleEvidence={toggleEvidence} />;
  else if (step === 6) stageContent = <MemoirStage copy={copy} documentLocale={documentLocale} lane={lane} reviewStates={reviewStates} onDocumentLocale={setDocumentLocale} onTemplate={setTemplate} selectedEvidence={selectedEvidence} template={template} />;
  else stageContent = <IntegrityStage copy={copy} lane={lane} reviewStates={reviewStates} selectedEvidence={selectedEvidence} />;

  const chooseLocale = (nextLocale) => {
    const safeLocale = normalizeInterfaceLocale(nextLocale);
    setLocale(safeLocale);
    window.history.replaceState(null, "", withInterfaceLocale(window.location.href, safeLocale));
  };

  const advance = () => {
    if (!canContinue || step >= 7) return;
    const next = step + 1;
    setStep(next);
    setMaxStep((current) => Math.max(current, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const restart = () => {
    setStep(0);
    setMaxStep(0);
    setLaneKey(locale);
    setReviewStates({ ...INITIAL_REVIEW_STATES });
    setSelectedEvidence([...INITIAL_SELECTED_EVIDENCE]);
    setDocumentLocale("en");
    setTemplate(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="showcase-app">
      <a className="skip-link" href="#prototype-main" onClick={() => document.getElementById("prototype-main")?.focus()}>{copy.skip}</a>
      <header className="showcase-header">
        <a className="wordmark" href={withInterfaceLocale("/", locale)} aria-label={copy.home}><span className="wordmark__pulse" aria-hidden="true" />Suara</a>
        <div className="showcase-header__actions">
          <div className="locale-switcher" role="group" aria-label={copy.localeLabel}>{SHOWCASE_LOCALES.map((item) => <button aria-pressed={locale === item.id} className={locale === item.id ? "is-active" : ""} key={item.id} onClick={() => chooseLocale(item.id)} type="button">{item.label}</button>)}</div>
          <span className="showcase-mode"><Icon name="shield" size={17} />{copy.browserMode}</span>
          <button className="showcase-restart" onClick={restart} type="button"><Icon name="reset" size={17} />{copy.restart}</button>
        </div>
      </header>
      <aside className="showcase-warning" aria-label={copy.safety}><Icon name="lock" size={18} /><span>{copy.safety}</span></aside>
      <div className="showcase-mobile-progress"><div><strong>{copy.stepOf.replace("{current}", step + 1)}</strong><span>{copy.stages[step]}</span></div><progress max="8" value={step + 1}>{step + 1} / 8</progress></div>
      <div className="showcase-layout">
        <ProgressRail copy={copy} maxStep={maxStep} onNavigate={setStep} step={step} />
        <main className="showcase-main" id="prototype-main" tabIndex={-1}>{stageContent}</main>
        <SafetyRail copy={copy} lane={lane} selectedCount={selectedEvidence.length} />
      </div>
      <footer className="showcase-action-bar">
        <p>{copy.footer}</p>
        <div>
          {step > 0 && step < 7 ? <button className="showcase-secondary" onClick={() => setStep((current) => current - 1)} type="button">{copy.back}</button> : null}
          {step < 7 ? <button className="showcase-primary" disabled={!canContinue} onClick={advance} type="button">{primaryLabels[step] || copy.next}<Icon name="arrow" size={18} /></button> : <button className="showcase-primary" onClick={restart} type="button"><Icon name="reset" size={18} />{copy.restart}</button>}
        </div>
      </footer>
    </div>
  );
}
