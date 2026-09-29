// Playwright CLI run-code callback TEMPLATE; do not run this source unchanged.
// Coordinator replaces the single fixture placeholder in a private generated copy.
// Three fictional raw PCM16-LE mono 48 kHz answers: yellow bridge/river,
// coconut rice/grandmother, kindness/neighbors. No credentials belong here.
// Fresh browser must be launched with --mute-audio, WITHOUT fake-media flags.
// Use the normal local build, no request routes, tracing, screenshots or HAR.
// This tests synthetic input through native browser DSP and a real provider;
// it does not test hardware microphone, audible output, human pauses or real judge codes.
async (page) => {
  const fixtures = __SUARA_PCM_FIXTURES__;
  const base = "http://127.0.0.1:8789";
  const result = {
    status: "FAIL", error: null, browserErrors: 0, sessionRequests: 0, tokenRequests: 0,
    failedLocalResponses: 0, beforeConsentInert: false, native48kCapture: false,
    patientConfigurationConfirmed: false, threeAnswersSent: false, fourRepliesDrained: false,
    providerEnded: false, previewMatchesFinalTurns: false, sourceFocus: false,
    sourceDetailChecks: [false, false, false], questionTextsPresent: false, questionOrderConfirmed: false,
    closingChecks: { thanks: false, review: false, finish: false },
    resetCleared: false, inputStoppedAfterEnd: false, cleanupCompleted: false,
    blankPage: false, hardwareMicrophoneUsed: false, audiblePlaybackVerified: false,
    realJudgeCodeTested: false, counts: null,
  };
  let stage = "fixture_validation";
  let deadline = 0;
  let armed = false;
  const fail = () => { throw new Error("canary_check_failed"); };
  const check = (condition) => { if (!condition) fail(); };
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) fail();
    return value;
  };
  const onPageError = () => { result.browserErrors++; };
  const onConsole = (message) => { if (message.type() === "error") result.browserErrors++; };
  const onRequest = (request) => {
    if (request.url() === `${base}/api/session`) result.sessionRequests++;
    if (request.url() === `${base}/api/voice/token`) result.tokenRequests++;
  };
  const onResponse = (response) => {
    if ([`${base}/api/session`, `${base}/api/voice/token`].includes(response.url()) && response.status() >= 400) {
      result.failedLocalResponses++;
    }
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    check(Array.isArray(fixtures) && fixtures.length === 3 && fixtures.every((value) =>
      typeof value === "string" && value.length >= 25_600 && value.length <= 2_560_000 &&
      value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)));
    stage = "browser_setup";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((pcmFixtures) => {
      if (location.origin !== "http://127.0.0.1:8789" || location.pathname !== "/voice/") return;
      const NativeContext = window.AudioContext;
      const NativeSocket = window.WebSocket;
      const q = window.suaraLiveCanary = {
        getUserMediaCalls: 0, socketCount: 0, ready: 0, updates: 0, readyTiming: false,
        inputFrames: 0, inputBytes: 0, badFrameSizes: 0, inputBeforeReady: 0, inputAfterEnd: 0,
        repliesStarted: 0, repliesCompleted: 0, repliesInterrupted: 0,
        audioChunks: 0, speechStarts: 0, speechStops: 0, userFinals: 0, agentFinals: 0,
        providerErrors: 0, providerEnded: 0, endSent: 0, framesAtEnd: null,
        workletsLoaded: 0, appContexts: [], appRates: [], appSources: new Set(),
        playbackStarts: 0, playbackEnds: 0, playbackStops: 0,
        answersStarted: 0, answersEnded: 0, generator: null, stream: null,
        generatorSources: new Set(), socket: null, sockets: new Set(), lastActivity: 0,
        lastReplyDone: 0, lastAnswerEnd: 0, deadlineTimer: null,
        expired: false, internalError: false, cleaning: false, captureSubstitutionInstalled: false,
      };
      const touch = () => { q.lastActivity = performance.now(); };
      const instrumentContext = (context) => {
        q.appContexts.push(context); q.appRates.push(context.sampleRate);
        const addModule = context.audioWorklet.addModule.bind(context.audioWorklet);
        context.audioWorklet.addModule = async (...args) => {
          const value = await addModule(...args);
          q.workletsLoaded++;
          return value;
        };
        const createSource = context.createBufferSource.bind(context);
        context.createBufferSource = (...args) => {
          const source = createSource(...args);
          const start = source.start.bind(source);
          const stop = source.stop.bind(source);
          source.start = (...startArgs) => {
            const value = start(...startArgs);
            q.appSources.add(source); q.playbackStarts++; touch();
            return value;
          };
          source.stop = (...stopArgs) => {
            const value = stop(...stopArgs);
            if (q.appSources.has(source)) q.playbackStops++;
            return value;
          };
          source.addEventListener("ended", () => {
            if (q.appSources.delete(source)) { q.playbackEnds++; touch(); }
          });
          return source;
        };
        return context;
      };
      // Constructors still allocate native objects; all operations are delegated.
      window.AudioContext = new Proxy(NativeContext, {
        construct(Target, args, NewTarget) { return instrumentContext(Reflect.construct(Target, args, NewTarget)); },
      });
      window.WebSocket = new Proxy(NativeSocket, {
        construct(Target, args, NewTarget) {
          const socket = Reflect.construct(Target, args, NewTarget);
          q.socket = socket; q.sockets.add(socket); q.socketCount++;
          const send = socket.send.bind(socket);
          socket.send = (payload) => {
            // Read/count only; do not modify, retain or log protocol payloads.
            try {
              const message = JSON.parse(payload);
              if (message.type === "session.update") q.updates++;
              if (message.type === "input.audio") {
                const bytes = atob(message.audio).length;
                q.inputFrames++; q.inputBytes += bytes;
                if (bytes !== 2400) q.badFrameSizes++;
                if (!q.ready) q.inputBeforeReady++;
                if (q.endSent) q.inputAfterEnd++;
              }
              if (message.type === "session.end") {
                q.endSent++; q.framesAtEnd = q.inputFrames;
              }
            } catch { q.internalError = true; }
            return send(payload);
          };
          socket.addEventListener("message", (event) => {
            try {
              const message = JSON.parse(event.data);
              switch (message.type) {
                case "session.ready": {
                  q.ready++;
                  const timing = message.config?.input?.turn_detection;
                  q.readyTiming = timing?.min_silence === 1200 && timing?.max_silence === 6000 && timing?.interrupt_response === true;
                  break;
                }
                case "input.speech.started": q.speechStarts++; break;
                case "input.speech.stopped": q.speechStops++; break;
                case "reply.started": q.repliesStarted++; touch(); break;
                case "reply.audio": q.audioChunks++; touch(); break;
                case "reply.done":
                  if (message.status === "completed") { q.repliesCompleted++; q.lastReplyDone = performance.now(); }
                  else if (message.status === "interrupted") q.repliesInterrupted++;
                  else q.internalError = true;
                  touch();
                  break;
                case "transcript.user": q.userFinals++; break;
                case "transcript.agent": q.agentFinals++; break;
                case "session.ended": q.providerEnded++; clearTimeout(q.deadlineTimer); break;
                case "session.error": case "error": q.providerErrors++; break;
                default: break;
              }
            } catch { q.internalError = true; }
          });
          return socket;
        },
      });
      // This is the only substituted browser capability. Never call real getUserMedia.
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          q.getUserMediaCalls++;
          if (q.getUserMediaCalls !== 1) throw new Error("synthetic_capture_single_attempt");
          // Deliberately use the saved native constructor: generator is not playback.
          q.generator = new NativeContext({ sampleRate: 48_000 });
          await q.generator.resume();
          const destination = q.generator.createMediaStreamDestination();
          q.stream = destination.stream;
          q.destination = destination;
          // No connection is ever made to generator.destination (speakers).
          return q.stream;
        },
      });
      q.captureSubstitutionInstalled = true;
      q.arm = () => {
        q.deadlineTimer = setTimeout(() => {
          q.expired = true;
          const finish = document.querySelector(".session-controls button:not(:disabled)");
          finish?.click();
          void q.cleanup();
        }, 120_000);
      };
      q.feed = async (index) => {
        if (q.cleaning || q.expired || index !== q.answersStarted || q.answersStarted !== q.answersEnded ||
            q.repliesCompleted !== index + 1 || q.repliesStarted !== index + 1 ||
            q.appSources.size !== 0 || q.playbackStarts < index + 1 ||
            performance.now() - q.lastActivity < 150 || q.lastReplyDone <= q.lastAnswerEnd ||
            q.generator?.sampleRate !== 48_000 || q.generator?.state !== "running") {
          q.internalError = true;
          throw new Error("synthetic_feed_gate");
        }
        const binary = atob(pcmFixtures[index]);
        if (binary.length % 2 !== 0 || binary.length < 19_200 || binary.length > 1_920_000) {
          q.internalError = true; throw new Error("synthetic_pcm_shape");
        }
        const samples = new Float32Array(binary.length / 2);
        for (let i = 0; i < samples.length; i++) {
          const raw = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
          samples[i] = (raw >= 32768 ? raw - 65536 : raw) / 32768;
        }
        const buffer = q.generator.createBuffer(1, samples.length, 48_000);
        buffer.copyToChannel(samples, 0);
        const source = q.generator.createBufferSource();
        source.buffer = buffer;
        source.connect(q.destination);
        q.generatorSources.add(source);
        source.addEventListener("ended", () => {
          source.disconnect(); q.generatorSources.delete(source);
          q.answersEnded++; q.lastAnswerEnd = performance.now();
        });
        q.answersStarted++;
        source.start();
      };
      q.cleanup = async () => {
        if (q.cleaning) return;
        q.cleaning = true;
        clearTimeout(q.deadlineTimer);
        for (const source of q.generatorSources) { try { source.stop(); } catch {} }
        q.stream?.getTracks().forEach((track) => track.stop());
        const closing = [...q.appContexts, q.generator].filter(Boolean).map(async (context) => {
          try { if (context.state !== "closed") await context.close(); } catch {}
        });
        for (const socket of q.sockets) {
          if (socket.readyState === NativeSocket.OPEN) {
            try { if (!q.endSent || q.sockets.size > 1) socket.send(JSON.stringify({ type: "session.end" })); } catch {}
            try { socket.close(1000, "Synthetic canary complete"); } catch {}
          } else if (socket.readyState === NativeSocket.CONNECTING) {
            try { socket.close(); } catch {}
          }
        }
        await Promise.race([Promise.all(closing), new Promise((resolve) => setTimeout(resolve, 1_500))]);
        pcmFixtures.fill("");
      };
      q.counts = () => ({
        captureCalls: q.getUserMediaCalls, sockets: q.socketCount, ready: q.ready,
        sessionUpdates: q.updates, inputFrames: q.inputFrames, inputBytes: q.inputBytes,
        badFrameSizes: q.badFrameSizes, inputBeforeReady: q.inputBeforeReady, inputAfterEnd: q.inputAfterEnd,
        workletsLoaded: q.workletsLoaded, appContextCount: q.appContexts.length,
        appSampleRate: q.appRates.length === 1 ? q.appRates[0] : 0,
        generatorSampleRate: q.generator?.sampleRate || 0, repliesStarted: q.repliesStarted,
        repliesCompleted: q.repliesCompleted, repliesInterrupted: q.repliesInterrupted,
        audioChunks: q.audioChunks, playbackStarts: q.playbackStarts, playbackEnds: q.playbackEnds,
        playbackStops: q.playbackStops, speechStarts: q.speechStarts, speechStops: q.speechStops,
        userFinalEvents: q.userFinals, agentFinalEvents: q.agentFinals,
        answersStarted: q.answersStarted, answersEnded: q.answersEnded,
        endSent: q.endSent, providerEnded: q.providerEnded, providerErrors: q.providerErrors,
      });
    }, fixtures);
    await page.goto(`${base}/voice/?lang=en`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.locator("#setup-title").waitFor({ timeout: 10_000 });
    stage = "consent_gate";
    check(await page.getByRole("button", { name: "Start three-question interview", exact: true }).isDisabled());
    await page.locator("#voice-access-code").fill("synthetic-local-browser-canary-only-20260905");
    check(await page.getByRole("button", { name: "Start three-question interview", exact: true }).isDisabled());
    result.beforeConsentInert = await page.evaluate(() => {
      const q = window.suaraLiveCanary;
      return q.captureSubstitutionInstalled && q.getUserMediaCalls === 0 && q.socketCount === 0 && q.appContexts.length === 0 && q.inputFrames === 0;
    });
    check(result.beforeConsentInert && result.sessionRequests === 0 && result.tokenRequests === 0);
    check(await page.locator('input[name="voice-mode"][value="patient"]').isChecked());
    await page.locator(".consent-card label").click();
    deadline = Date.now() + 120_000; armed = true;
    await page.evaluate(() => window.suaraLiveCanary.arm());
    await page.getByRole("button", { name: "Start three-question interview", exact: true }).click({ timeout: 5_000 });
    stage = "ready_and_native_capture";
    await page.waitForFunction(() => {
      const q = window.suaraLiveCanary;
      return q.ready > 0 || q.providerErrors > 0 || q.internalError || q.expired || !!document.querySelector(".voice-error");
    }, null, { timeout: Math.min(remaining(), 25_000) });
    const ready = await page.evaluate(() => {
      const q = window.suaraLiveCanary;
      return { valid: q.ready === 1 && !q.providerErrors && !q.internalError && !q.expired,
        timing: q.readyTiming, native: q.appRates.length === 1 && q.appRates[0] === 48_000 &&
          q.generator?.sampleRate === 48_000 && q.workletsLoaded === 1 && q.getUserMediaCalls === 1 };
    });
    result.native48kCapture = ready.native;
    result.patientConfigurationConfirmed = ready.timing;
    check(ready.valid && ready.native && ready.timing);
    for (let reply = 1; reply <= 4; reply++) {
      stage = "reply_completion_or_playback_drain";
      await page.waitForFunction((expected) => {
        const q = window.suaraLiveCanary;
        return q.expired || q.providerErrors || q.internalError || q.repliesInterrupted || !!document.querySelector(".voice-error") ||
          (q.repliesCompleted === expected && q.repliesStarted === expected && q.appSources.size === 0 &&
            q.playbackStarts >= expected && q.lastReplyDone > q.lastAnswerEnd &&
            q.answersEnded === expected - 1 && performance.now() - q.lastActivity >= 150);
      }, reply, { timeout: remaining() });
      check(await page.evaluate((expected) => {
        const q = window.suaraLiveCanary;
        return !q.expired && !q.providerErrors && !q.internalError && !q.repliesInterrupted &&
          q.repliesCompleted === expected && q.repliesStarted === expected && q.appSources.size === 0;
      }, reply));
      if (reply < 4) {
        stage = "synthetic_answer_feed";
        await page.evaluate((index) => window.suaraLiveCanary.feed(index), reply - 1);
      }
    }
    result.threeAnswersSent = true;
    result.fourRepliesDrained = true;
    stage = "normal_finish";
    await page.getByRole("button", { name: "Finish interview", exact: true }).click({ timeout: Math.min(5_000, remaining()) });
    await page.waitForFunction(() => window.suaraLiveCanary.providerEnded === 1, null, { timeout: Math.min(5_000, remaining()) });
    await page.locator(".session-state--ended").waitFor({ timeout: Math.min(5_000, remaining()) });
    result.providerEnded = true;
    stage = "preview_exact_source";
    result.previewMatchesFinalTurns = await page.evaluate(() => {
      const turns = [...document.querySelectorAll(".turn--user:not(.turn--partial)")];
      const excerpts = [...document.querySelectorAll(".memoir-excerpts blockquote")];
      return turns.length === 3 && excerpts.length === 3 && excerpts.every((excerpt, index) =>
        excerpt.querySelector("p")?.textContent === `“${turns[index].querySelector("p")?.textContent}”` &&
        excerpt.querySelector("a")?.getAttribute("href") === `#${turns[index].id}`);
    });
    check(result.previewMatchesFinalTurns);
    stage = "interview_content_receipts";
    const receipts = await page.evaluate(() => {
      const normalize = (text) => text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/gu, " ").trim();
      const user = normalize([...document.querySelectorAll(".turn--user:not(.turn--partial) > p")].map((node) => node.textContent).join(" "));
      const agentTurns = [...document.querySelectorAll(".turn--agent:not(.turn--partial) > p")].map((node) => normalize(node.textContent));
      const agent = agentTurns.join(" ");
      // Exact source strings from src/voice/copy.js SESSION_QUESTIONS, punctuation-normalized.
      const questions = [
        "What is one place from your early life that still feels vivid to you?",
        "What family food or tradition means the most to you, and who did you share it with?",
        "What memory or lesson would you most want your family to carry forward?",
      ];
      const positions = questions.map((question) => agent.indexOf(normalize(question)));
      const closing = agentTurns.at(-1) || "";
      return {
        sourceDetailChecks: [
          /\byellow\s+bridge\b/u.test(user) && /\briver\b/u.test(user),
          /\bcoconut\s+rice\b/u.test(user) && /\b(?:grandmother|grandma)\b/u.test(user),
          /\bkind(?:ness)?\b/u.test(user) && /\bneighbou?rs?\b/u.test(user),
        ],
        questionTextsPresent: positions.every((index) => index >= 0),
        questionOrderConfirmed: positions.every((index, i) => index >= 0 && (i === 0 || index > positions[i - 1])),
        closingChecks: { thanks: /\bthank/u.test(closing), review: /\breview\b/u.test(closing), finish: /\bfinish\b.*\binterview\b/u.test(closing) },
      };
    });
    result.sourceDetailChecks = receipts.sourceDetailChecks;
    result.questionTextsPresent = receipts.questionTextsPresent;
    result.questionOrderConfirmed = receipts.questionOrderConfirmed;
    result.closingChecks = receipts.closingChecks;
    check(receipts.sourceDetailChecks.every(Boolean) && receipts.questionTextsPresent && receipts.questionOrderConfirmed &&
      receipts.closingChecks.thanks && receipts.closingChecks.review && receipts.closingChecks.finish);
    result.sourceFocus = true;
    for (let index = 0; index < 3; index++) {
      await page.locator(".memoir-excerpts a").nth(index).click({ timeout: 3_000 });
      result.sourceFocus = result.sourceFocus && await page.evaluate((i) =>
        document.activeElement.id === `evidence-U${String(i + 1).padStart(2, "0")}`, index);
    }
    check(result.sourceFocus);
    stage = "post_end_input";
    await page.waitForTimeout(300);
    result.inputStoppedAfterEnd = await page.evaluate(() => {
      const q = window.suaraLiveCanary;
      return q.framesAtEnd === q.inputFrames && q.inputAfterEnd === 0 &&
        q.stream.getTracks().every((track) => track.readyState === "ended");
    });
    check(result.inputStoppedAfterEnd);
    stage = "reset";
    await page.locator(".reset-panel .primary-action").click({ timeout: 3_000 });
    await page.getByRole("button", { name: "Clear this page and start fresh", exact: true }).click({ timeout: 3_000 });
    result.resetCleared = await page.evaluate(() =>
      document.querySelectorAll(".turn, .memoir-excerpts blockquote").length === 0 &&
      document.querySelector("#voice-access-code")?.value === "" &&
      document.querySelector(".consent-card input")?.checked === false);
    check(result.resetCleared);
    stage = "final_counts";
    result.counts = await page.evaluate(() => window.suaraLiveCanary.counts());
    check(result.counts.inputFrames > 0 && result.counts.badFrameSizes === 0 &&
      result.counts.inputBeforeReady === 0 && result.counts.inputAfterEnd === 0 &&
      result.counts.endSent === 1 && result.counts.providerErrors === 0 &&
      result.counts.playbackStops === 0 && result.sessionRequests === 1 && result.tokenRequests === 1 &&
      result.failedLocalResponses === 0 && result.browserErrors === 0);
    result.status = "PASS";
  } catch {
    result.error = stage;
  } finally {
    // Never expose a live transcript in CLI's automatic post-command snapshot.
    // Do not read exception messages, raw events, console text, IDs or socket URLs.
    try {
      if (armed && await page.locator(".session-controls button:not(:disabled)").count()) {
        await page.locator(".session-controls button:not(:disabled)").click({ timeout: 1_000 });
      }
    } catch {}
    try {
      const cleanup = await page.evaluate(async () => {
        const q = window.suaraLiveCanary;
        if (!q) return { counts: null, completed: true };
        const counts = q.counts();
        await q.cleanup();
        return { counts, completed: [...q.appContexts, q.generator].filter(Boolean).every((context) => context.state === "closed") &&
          (!q.stream || q.stream.getTracks().every((track) => track.readyState === "ended")) };
      });
      result.counts = result.counts || cleanup.counts;
      result.cleanupCompleted = cleanup.completed;
    } catch { result.cleanupCompleted = false; }
    if (Array.isArray(fixtures)) fixtures.fill("");
    try {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 });
      result.blankPage = page.url() === "about:blank";
    } catch { result.blankPage = false; }
    page.off("pageerror", onPageError); page.off("console", onConsole);
    page.off("request", onRequest); page.off("response", onResponse);
    if (!result.cleanupCompleted || !result.blankPage) { result.status = "FAIL"; result.error = "cleanup"; }
  }
  return result;
}
