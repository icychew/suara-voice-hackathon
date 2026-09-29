// Explicit two-session synthetic PCM comparison. Never import/run automatically.
// All event times are LOCAL WEBSOCKET RECEIPTS, not provider acoustic boundaries
// or audible interruptions. No browser, playback or hardware microphone is used.
// CLI: --run (or --validate) --private-config ABS_PATH --fixtures ABS_PATH --expected-reservations 4
// Deliberately not named --env-file: the Node launcher can interpret that flag.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFromEnvironment } from "../server/voice-facade.mjs";
import { createFramePacer, PacingError, validGapSendSpan } from "./pause-frame-pacer.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:8789";
const TEST_CODE = "synthetic-local-pause-canary-only-20260906";
const FRAME_BYTES = 2_400;
const ZERO = Buffer.alloc(FRAME_BYTES).toString("base64");
const DAY = 86_400_000;
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const check = (condition, code) => { if (!condition) refuse(code); };
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const regular = (s) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1;

async function protectedRead(file, maximum) {
  check(typeof file === "string" && isAbsolute(file), "invalid_path");
  file = resolve(file);
  const rel = relative(ROOT, file);
  check(rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel), "unsafe_path");
  check(!/(?:^|[\\/])OneDrive(?: - [^\\/]+)?(?:[\\/]|$)/iu.test(file), "unsafe_path");
  if (process.platform === "win32") check(!parse(file).root.startsWith("\\\\") && !file.slice(parse(file).root.length).includes(":"), "unsafe_path");
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const entry = await fs.lstat(directory);
    check(entry.isDirectory() && !entry.isSymbolicLink(), "unsafe_path");
    if (directory === dirname(directory)) break;
  }
  const before = await fs.lstat(file);
  check(regular(before) && before.size <= maximum, "unsafe_file");
  if (process.platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($sid,'S-1-5-18','S-1-5-32-544'); foreach($target in @($env:SUARA_PAUSE_ACL_FILE,(Split-Path -LiteralPath $env:SUARA_PAUSE_ACL_FILE))){$acl=Get-Acl -LiteralPath $target; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'unsafe'}; foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){throw 'unsafe'}}}; [Console]::Write('protected')";
    const childEnv = { ...process.env, SUARA_PAUSE_ACL_FILE: file };
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
    try {
      const shell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: childEnv, windowsHide: true, timeout: 5_000, maxBuffer: 1_024, stdio: "pipe",
      });
      check(output.toString("utf8") === "protected", "unsafe_permissions");
    } catch { refuse("unsafe_permissions"); }
  } else {
    const parent = await fs.lstat(dirname(file));
    check(!(before.mode & 0o077) && before.uid === process.getuid() && !(parent.mode & 0o022), "unsafe_permissions");
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    check(regular(opened) && before.dev === opened.dev && before.ino === opened.ino && before.ctimeMs === opened.ctimeMs, "file_changed");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat(); const current = await fs.lstat(file);
    check(length <= maximum && length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs &&
      after.ctimeMs === opened.ctimeMs && regular(current) && current.dev === opened.dev && current.ino === opened.ino &&
      current.ctimeMs === opened.ctimeMs, "file_changed");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

async function reservationCount(file) {
  const ledger = JSON.parse((await protectedRead(file, 180_000)).toString("utf8"));
  check(ledger && Object.keys(ledger).sort().join(",") === "timestamps,version" && ledger.version === 1 &&
    Array.isArray(ledger.timestamps) && ledger.timestamps.length <= 10_000 && ledger.timestamps.every((stamp, i, all) =>
      Number.isSafeInteger(stamp) && stamp >= 0 && (i === 0 || stamp >= all[i - 1])), "quota_invalid");
  return ledger.timestamps.filter((stamp) => stamp > Date.now() - DAY).length;
}

async function currentSessionBuilder() {
  const path = join(ROOT, "src", "voice", "voiceClient.js");
  let source = await fs.readFile(path, "utf8");
  const assetImport = 'import processorUrl from "./pcm-processor.js?url&no-inline";';
  const copyImport = 'from "./copy.js"';
  check(source.split(assetImport).length === 2 && source.split(copyImport).length === 2, "source_contract_changed");
  source = source.replace(assetImport, 'const processorUrl = "";').replace(copyImport,
    `from ${JSON.stringify(pathToFileURL(join(ROOT, "src", "voice", "copy.js")).href)}`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return module.buildSessionUpdate;
}

async function waitUntil(target, signal) {
  while (performance.now() < target) {
    if (signal?.aborted) refuse("deadline");
    await new Promise((done) => setTimeout(done, Math.min(25, Math.max(1, Math.ceil(target - performance.now())))));
  }
  if (signal?.aborted) refuse("deadline");
}
async function waitFor(predicate, signal, milliseconds) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) {
    check(!signal?.aborted && performance.now() < deadline, "deadline");
    await waitUntil(performance.now() + 10, signal);
  }
}
async function jsonResponse(response) {
  check(response.status === 200 && response.body?.getReader, "token_exchange_failed");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; check(size <= 8_192, "token_exchange_failed");
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
function resolvedCommon(config) {
  const turn = config?.input?.turn_detection;
  const finite = (value, maximum) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
  return {
    vadThreshold: finite(turn?.vad_threshold, 1), interruptionDelayMs: finite(turn?.interruption_delay, 1_000),
    transcriptionMode: ["min_latency", "balanced", "max_accuracy"].includes(config?.input?.transcription_mode) ? config.input.transcription_mode : null,
    interruptResponse: typeof turn?.interrupt_response === "boolean" ? turn.interrupt_response : null,
    voice: config?.output?.voice === "alba" ? "alba" : null,
  };
}
function commonPresence(config) {
  const turn = config?.input?.turn_detection || {};
  return { vadThreshold: Object.hasOwn(turn, "vad_threshold"), interruptionDelayMs: Object.hasOwn(turn, "interruption_delay"),
    transcriptionMode: Object.hasOwn(config?.input || {}, "transcription_mode"), interruptResponse: Object.hasOwn(turn, "interrupt_response"),
    voice: Object.hasOwn(config?.output || {}, "voice") };
}

async function runSession(mode, clauses, buildSessionUpdate, pairSignal) {
  const origin = performance.now();
  const sessionController = new AbortController();
  const timeout = setTimeout(() => sessionController.abort(), 70_000); // leaves 5 s for end acknowledgement
  const signal = AbortSignal.any([pairSignal, sessionController.signal]);
  const record = { mode, status: "inconclusive", error: null, cleanEnd: false, configurationValid: false,
    common: null, commonPresence: null, comparisonMetadataComplete: false,
    baselineThresholdsOmitted: false, firstSpeechBeforeGap: false,
    anchors: false, anchorChecks: { firstClause: false, secondClause: false }, fixtureDelivered: false, zeroFrames: 100, sourceGapMs: 5_000,
    gapStartMs: null, gapEndMs: null, firstSpeechMs: null, gapSpeechStopsMs: [], gapReplyStartsMs: [], gapAudioFirstMs: null,
    actualGapSendSpanMs: null, gapSendSpanValid: false, preGapReplyStartsMs: [], replyActiveAtGapEntry: false,
    pacingPolicy: "anchored_50ms_min40ms_late100ms", minInterFrameSpacingMs: null,
    gapAudioChunks: 0, inputFrames: 0, maxPacingLagMs: 0, repliesCompleted: 0, repliesInterrupted: 0,
    userFinals: 0, replyAudioChunks: 0, providerErrors: 0, ready: 0, endSent: 0, ended: 0,
  };
  const time = () => Math.round(performance.now() - origin);
  let socket; let phase = "greeting"; let fault = null; let lastReplyDone = -1; let replyActive = false;
  let bodyEndedAt = Infinity; let gapStartAt = null;
  const pacer = createFramePacer({ signal });
  const userTurns = [];
  const anchors = () => {
    const value = userTurns.join(" ").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ");
    record.anchorChecks = { firstClause: /\byoung\b/.test(value) && /\bremember\b/.test(value),
      secondClause: /\byellow bridge\b/.test(value) && /\briver\b/.test(value) };
    return record.anchorChecks.firstClause && record.anchorChecks.secondClause;
  };
  const healthy = () => { if (fault) refuse(fault); check(!signal.aborted, "deadline"); };
  async function frame(audio, nextPhase = phase) {
    healthy();
    const payload = JSON.stringify({ type: "input.audio", audio });
    return pacer.send(({ sentAtMs }) => {
      healthy(); check(socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 256_000, "transport_failed");
      if (nextPhase !== phase) {
        if (nextPhase === "gap") {
          record.firstSpeechBeforeGap = record.firstSpeechMs !== null;
          record.replyActiveAtGapEntry = replyActive;
          gapStartAt = sentAtMs; record.gapStartMs = Math.round(sentAtMs - origin);
        } else if (nextPhase === "clause_b") {
          record.gapEndMs = Math.round(sentAtMs - origin);
          record.actualGapSendSpanMs = Math.round((sentAtMs - gapStartAt) * 1000) / 1000;
          record.gapSendSpanValid = validGapSendSpan(sentAtMs - gapStartAt);
          check(record.gapSendSpanValid, "gap_send_span_invalid");
        }
        phase = nextPhase;
      }
      socket.send(payload);
      record.inputFrames++;
    });
  }
  try {
    const local = await jsonResponse(await fetch(`${ORIGIN}/api/session`, {
      headers: { Accept: "application/json", "X-Suara-Access-Code": TEST_CODE }, cache: "no-store", redirect: "error", signal,
    }));
    check(typeof local.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(local.token), "token_exchange_failed");
    const provider = await jsonResponse(await fetch(`${ORIGIN}/api/voice/token`, {
      method: "POST", headers: { Accept: "application/json", Origin: ORIGIN, Authorization: `Bearer ${local.token}` },
      cache: "no-store", redirect: "error", signal,
    }));
    local.token = "";
    check(typeof provider.token === "string" && provider.token.length >= 8, "token_exchange_failed");
    const url = new URL("wss://agents.assemblyai.com/v1/ws"); url.searchParams.set("token", provider.token);
    socket = new WebSocket(url); provider.token = ""; url.search = "";
    const update = buildSessionUpdate(mode);
    if (mode === "baseline") {
      check(!Object.hasOwn(update.session.input, "turn_detection"), "configuration_mismatch");
      record.baselineThresholdsOmitted = true;
    }
    socket.addEventListener("open", () => {
      try { socket.send(JSON.stringify(update)); } catch { fault = "transport_failed"; }
    });
    socket.addEventListener("error", () => { fault = "transport_failed"; });
    socket.addEventListener("close", () => { if (!record.ended && !record.endSent) fault = "transport_failed"; });
    socket.addEventListener("message", (event) => {
      try {
        check(typeof event.data === "string" && event.data.length <= 1_048_576, "provider_payload_invalid");
        const message = JSON.parse(event.data);
        switch (message.type) {
          case "session.ready": {
            record.ready++; record.common = resolvedCommon(message.config); record.commonPresence = commonPresence(message.config);
            record.comparisonMetadataComplete = Object.values(record.common).every((value) => value !== null) && Object.values(record.commonPresence).every(Boolean);
            const turn = message.config?.input?.turn_detection;
            record.configurationValid = record.ready === 1 &&
              message.config?.input?.format?.encoding === "audio/pcm" && message.config?.output?.format?.encoding === "audio/pcm" &&
              (mode === "baseline" || (turn?.min_silence === 1200 && turn?.max_silence === 6000 && turn?.interrupt_response === true));
            if (!record.configurationValid) fault = "configuration_mismatch";
            break;
          }
          case "input.speech.started": if (phase !== "greeting" && record.firstSpeechMs === null) record.firstSpeechMs = time(); break;
          case "input.speech.stopped":
            if (phase === "gap") { if (record.gapSpeechStopsMs.length >= 20) fault = "event_overflow"; else record.gapSpeechStopsMs.push(time()); }
            break;
          case "reply.started":
            replyActive = true;
            if (phase === "clause_a") { if (record.preGapReplyStartsMs.length >= 20) fault = "event_overflow"; else record.preGapReplyStartsMs.push(time()); }
            if (phase === "gap") { if (record.gapReplyStartsMs.length >= 20) fault = "event_overflow"; else record.gapReplyStartsMs.push(time()); }
            break;
          case "reply.audio":
            record.replyAudioChunks++;
            if (phase === "gap") { record.gapAudioChunks++; if (record.gapAudioFirstMs === null) record.gapAudioFirstMs = time(); }
            break;
          case "reply.done":
            replyActive = false;
            if (message.status === "completed") { record.repliesCompleted++; lastReplyDone = performance.now(); }
            else if (message.status === "interrupted") record.repliesInterrupted++;
            else fault = "provider_reply_failed";
            break;
          case "transcript.user":
            record.userFinals++;
            check(typeof message.text === "string" && message.text.length <= 20_000 && userTurns.length < 30, "provider_payload_invalid");
            userTurns.push(message.text); break;
          case "session.ended": record.ended++; break;
          case "session.error": case "error": record.providerErrors++; fault = "provider_error"; break;
          default: break;
        }
      } catch (error) { fault = error instanceof Refusal ? error.code : "provider_payload_invalid"; }
    });
    await waitFor(() => { healthy(); return record.ready === 1 && record.repliesCompleted >= 1; }, signal, 25_000);
    await waitUntil(performance.now() + 200, signal);
    healthy();
    check(record.repliesCompleted === 1 && record.repliesInterrupted === 0 && !replyActive, "greeting_not_settled");
    for (let offset = 0; offset < clauses[0].length; offset += FRAME_BYTES) await frame(clauses[0].subarray(offset, offset + FRAME_BYTES).toString("base64"), "clause_a");
    for (let i = 0; i < 100; i++) await frame(ZERO, "gap");
    // Continuation is fixed, even if the provider has generated a reply in the gap.
    let finalFrame;
    for (let offset = 0; offset < clauses[1].length; offset += FRAME_BYTES) finalFrame = await frame(clauses[1].subarray(offset, offset + FRAME_BYTES).toString("base64"), "clause_b");
    record.fixtureDelivered = true; bodyEndedAt = finalFrame.sentAtMs + 50;
    const tailDeadline = performance.now() + 20_000;
    while (!(anchors() && lastReplyDone > bodyEndedAt)) {
      check(performance.now() < tailDeadline, "post_continuation_timeout");
      await frame(ZERO, "tail");
    }
    record.anchors = anchors();
    record.status = record.firstSpeechBeforeGap ? "completed" : "inconclusive";
    if (!record.firstSpeechBeforeGap) record.error = "speech_not_detected_before_gap";
    if (record.preGapReplyStartsMs.length || record.replyActiveAtGapEntry) { record.status = "inconclusive"; record.error = "pre_gap_reply"; }
  } catch (error) {
    record.error = error instanceof Refusal || error instanceof PacingError ? error.code : "session_failed";
  } finally {
    clearTimeout(timeout); phase = "ending";
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "session.end" })); record.endSent++;
        await waitFor(() => record.ended > 0, null, 5_000);
      }
    } catch {}
    record.cleanEnd = record.endSent === 1 && record.ended === 1;
    if (!record.cleanEnd) { record.status = "inconclusive"; record.error = record.error || "unclean_end"; }
    if (fault) { record.status = "inconclusive"; record.error = fault; }
    try { if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Synthetic comparison complete"); } catch {}
    record.anchors = anchors();
    const pacing = pacer.snapshot();
    record.maxPacingLagMs = Math.round(pacing.maxLatenessMs * 1000) / 1000;
    record.minInterFrameSpacingMs = pacing.minSpacingMs === null ? null : Math.round(pacing.minSpacingMs * 1000) / 1000;
    userTurns.fill(""); userTurns.length = 0;
  }
  return record;
}

export async function runCli(args) {
  let facade; let clauses; let pairTimer; let final;
  try {
    check(args.length === 7 && ["--run", "--validate"].includes(args[0]) && args[1] === "--private-config" &&
      args[3] === "--fixtures" && args[5] === "--expected-reservations" && args[6] === "4", "usage");
    const envBytes = await protectedRead(args[2], 65_536);
    const envText = new TextDecoder("utf-8", { fatal: true }).decode(envBytes);
    const names = [...envText.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((match) => match[1]);
    check(names.length === new Set(names).size && !/^\s*export\s/m.test(envText), "configuration_invalid");
    const env = parseEnv(envText); envBytes.fill(0);
    check(env.NODE_ENV === "development" && env.SUARA_DAILY_TOKEN_LIMIT === "6" && env.SUARA_TOKEN_RATE_LIMIT === "2" &&
      env.SUARA_GLOBAL_TOKEN_RATE_LIMIT === "6" && env.SUARA_SESSION_RATE_LIMIT === "6" && !!env.ASSEMBLYAI_API_KEY, "limits_or_configuration_changed");
    const fixture = JSON.parse((await protectedRead(args[4], 4_000_000)).toString("utf8"));
    check(fixture && Object.keys(fixture).sort().join(",") === "clauses,sampleRate" && fixture.sampleRate === 24_000 &&
      Array.isArray(fixture.clauses) && fixture.clauses.length === 2, "fixture_invalid");
    clauses = fixture.clauses.map((encoded) => {
      check(typeof encoded === "string" && encoded.length <= 1_920_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), "fixture_invalid");
      const bytes = Buffer.from(encoded, "base64");
      check(bytes.toString("base64") === encoded && bytes.length >= FRAME_BYTES && bytes.length <= 960_000 && bytes.length % FRAME_BYTES === 0, "fixture_invalid");
      return bytes;
    });
    fixture.clauses.fill("");
    const buildSessionUpdate = await currentSessionBuilder();
    check(await reservationCount(env.SUARA_QUOTA_FILE) === 4, "quota_checkpoint_changed");
    if (args[0] === "--validate") {
      emit({ status: "validated", reservations: 4, dailyLimit: 6, clauseFrames: clauses.map((bytes) => bytes.length / FRAME_BYTES), zeroFrames: 100, sourceGapMs: 5000, providerCalls: 0 });
      return 0;
    }
    const runtimeEnv = { ...env, SUARA_PORT: "8789", SUARA_LISTEN_HOST: "127.0.0.1", SUARA_PUBLIC_ORIGIN: ORIGIN,
      SUARA_ALLOWED_HOSTS: "127.0.0.1:8789", SUARA_DIST_ROOT: join(ROOT, "dist"), SUARA_JUDGE_ACCESS_CODE: TEST_CODE };
    facade = await startFromEnvironment(runtimeEnv);
    check(await reservationCount(env.SUARA_QUOTA_FILE) === 4, "quota_checkpoint_changed");
    const pairController = new AbortController(); pairTimer = setTimeout(() => pairController.abort(), 175_000);
    const runs = [];
    for (const mode of ["baseline", "patient"]) {
      check(await reservationCount(env.SUARA_QUOTA_FILE) === 4 + runs.length, "quota_checkpoint_changed");
      emit({ status: "run_started", mode });
      const record = await runSession(mode, clauses, buildSessionUpdate, pairController.signal);
      runs.push(record);
      emit({ status: "run_finished", mode, outcome: record.status, cleanEnd: record.cleanEnd, error: record.error });
      if (!record.cleanEnd || record.status !== "completed") break;
    }
    const gapSpansMatched = runs.length === 2 && runs.every((run) => Number.isFinite(run.actualGapSendSpanMs)) &&
      Math.abs(runs[0].actualGapSendSpanMs - runs[1].actualGapSendSpanMs) <= 100;
    const comparable = gapSpansMatched && runs.every((run) => run.status === "completed" && run.cleanEnd && run.configurationValid && run.comparisonMetadataComplete &&
      run.fixtureDelivered && run.anchors && run.firstSpeechBeforeGap && run.gapSendSpanValid && validGapSendSpan(run.actualGapSendSpanMs)) &&
      Object.keys(runs[0].common).every((key) => runs[0].common[key] === runs[1].common[key]);
    final = { status: comparable ? "observational_pair_complete" : "inconclusive", reason: comparable ? "single_fixed_order_pair_no_superiority_inference" : "incomplete_or_mismatched_pair",
      evidence: "synthetic_pcm_local_websocket_receipts", sourceGapMs: 5000, playbackUsed: false, hardwareMicrophoneUsed: false,
      heardInterruptionMeasured: false, gapSpansMatched, runs, reservationsAfter: await reservationCount(env.SUARA_QUOTA_FILE) };
  } catch (error) {
    final = { status: "refused_or_inconclusive", error: error instanceof Refusal ? error.code : "operation_failed" };
  } finally {
    clearTimeout(pairTimer);
    clauses?.forEach((bytes) => bytes.fill(0));
    if (final) final.facadeClosed = false;
    if (facade) {
      try { await facade.close(); if (final) final.facadeClosed = true; }
      catch { final = { ...final, status: "inconclusive", error: "facade_cleanup_failed", facadeClosed: false }; }
    }
  }
  emit(final);
  return final.status === "observational_pair_complete" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
