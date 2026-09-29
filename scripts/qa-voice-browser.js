// Run against the local production preview with Playwright CLI run-code --filename.
// This harness replaces microphone/audio/WebSocket and intercepts both HTTP routes.
// It proves browser UI integration with synthetic events, NOT live speech quality.
async (page) => {
  const base = "http://127.0.0.1:5181";
  const evidenceRoot = "C:/Users/haoya/AppData/Local/SuaraBrowserReview/memory-review-2026-09-14";
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security|violates|Uncaught/i.test(message.text())) errors.push(message.text());
  });
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const rawUrl = request.url();
    assert(rawUrl.startsWith(`${base}/`), "Unexpected nonlocal request");
    const pathname = rawUrl.slice(base.length).split(/[?#]/)[0];
    if (pathname === "/api/session") {
      requests.push(pathname);
      const good = request.headers()["x-suara-access-code"] === "synthetic-qc-access-2026";
      await route.fulfill({ status: good ? 200 : 401, contentType: "application/json",
        body: JSON.stringify(good ? { token: "synthetic-local-bearer" } : { error: "access_code_required" }) });
    } else if (pathname === "/api/voice/token") {
      requests.push(pathname);
      assert(request.method() === "POST" && !request.postData(), "Token POST must be empty");
      assert(request.headers().authorization === "Bearer synthetic-local-bearer", "Bearer must match");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "synthetic-provider-token" }) });
    } else await route.continue();
  });
  await page.addInitScript(() => {
    const qc = window.voiceQC = { captureCount: 0, stopped: false, sent: [] };
    class Node extends EventTarget {
      connect(node) { return node; }
      disconnect() {}
    }
    class Context extends Node {
      constructor() {
        super(); this.state = "suspended"; this.sampleRate = 48000;
        this.destination = new Node(); this.audioWorklet = { addModule: async () => {} };
      }
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; }
      createMediaStreamSource() { return new Node(); }
      createGain() { const node = new Node(); node.gain = { value: 1 }; return node; }
    }
    class Worklet extends Node { constructor() { super(); this.port = {}; } }
    window.AudioContext = Context;
    window.AudioWorkletNode = Worklet;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      qc.captureCount += 1;
      const track = new Node(); track.stop = () => { qc.stopped = true; };
      return { getTracks: () => [track] };
    } });
    class Socket extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor() {
        super(); this.readyState = 0; this.bufferedAmount = 0; qc.socket = this;
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0);
      }
      incoming(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
      send(payload) {
        const message = JSON.parse(payload); qc.sent.push(message.type);
        if (message.type === "session.update") queueMicrotask(() => this.incoming({ type: "session.ready", config: message.session }));
        if (message.type === "session.end") queueMicrotask(() => this.incoming({ type: "session.ended" }));
      }
      close() { this.readyState = 3; }
    }
    window.WebSocket = Socket;
  });

  for (const locale of ["en", "ms", "zh"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/voice/?lang=${locale}`);
    await page.locator("#setup-title").waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale} mobile overflow`);
    assert(await page.locator(".primary-action").isDisabled(), `${locale}: no consent must block start`);
    await page.locator("#voice-access-code").fill("synthetic-wrong-code");
    assert(await page.locator(".primary-action").isDisabled(), `${locale}: code alone must not start`);
    assert(await page.evaluate(() => window.voiceQC.captureCount === 0), "No capture before consent");
    await page.locator(".consent-card label").click();
    await page.locator(".primary-action").click();
    await page.locator(".voice-error").waitFor();
    assert(await page.evaluate(() => window.voiceQC.stopped && !window.voiceQC.socket), "Access failure must clean up without opening provider socket");
    await page.locator(".reset-panel .primary-action").click();
    assert(await page.locator("#voice-access-code").inputValue() === "", "Reset clears access code");
    await page.locator("#voice-access-code").fill("synthetic-qc-access-2026");
    await page.locator(".consent-card label").click();
    await page.locator(".primary-action").click();
    await page.locator(".session-state--listening").waitFor();
    assert(await page.locator(".resolved-config").count() === 1, "Resolved timing should be shown");
    assert(await page.evaluate(() => document.activeElement.classList.contains("conversation-panel")), "Starting moves keyboard focus to conversation");
    const stopBox = await page.locator(".session-controls button").boundingBox();
    assert(stopBox.y >= 68 && stopBox.y + stopBox.height <= 844, `${locale}: stop control must be visible after start`);
    await page.evaluate(() => {
      const socket = window.voiceQC.socket;
      socket.incoming({ type: "transcript.user", item_id: "u1", text: "Synthetic fixture: grandma cooked nasi lemak." });
      socket.incoming({ type: "transcript.agent", reply_id: "r1", text: "Synthetic question about family food." });
      socket.incoming({ type: "transcript.user", item_id: "u1", text: "Synthetic fixture: 外婆的椰浆饭。" });
      socket.incoming({ type: "transcript.user", item_id: "u2", text: "Synthetic fixture: we shared it every Sunday." });
    });
    await page.locator("#evidence-U02").waitFor();
    assert((await page.locator(".turn").allTextContents())[0].includes("外婆的椰浆饭"), "Corrections must not reorder evidence");
    assert(await page.locator(".memoir-excerpts").count() === 0, "No preview during live conversation");
    await page.locator(".session-controls button").click();
    await page.locator(".session-state--ended").waitFor();
    assert(await page.locator(".memory-review-card").count() === 2, "Only final user words enter review");
    assert(await page.locator(".memoir-excerpts blockquote").count() === 0, "Unreviewed words must not enter the keepsake");
    const reviewCards = page.locator(".memory-review-card");
    await reviewCards.nth(0).locator(".memory-review-card__actions button").nth(1).click();
    await reviewCards.nth(1).locator("textarea").fill("Human-corrected synthetic fixture: shared every Sunday.");
    assert(await reviewCards.nth(1).locator(".memory-review-card__actions button").nth(0).getAttribute("aria-pressed") === "true",
      "A correction must reset review to waiting");
    await reviewCards.nth(1).locator(".memory-review-card__actions button").nth(1).click();
    assert(await page.locator(".memoir-excerpts blockquote").count() === 2, "Reviewed user words enter the keepsake");
    assert((await page.locator(".memoir-excerpts blockquote").nth(1).textContent()).includes("Human-corrected"),
      "Reviewed correction should be visible");
    assert(!(await page.locator(".memoir-excerpts").textContent()).includes("Synthetic question"), "Agent text excluded from evidence");
    await page.evaluate(() => {
      window.voiceQC.socket.incoming({ type: "transcript.user", item_id: "late", text: "SHOULD NOT APPEAR" });
      window.voiceQC.socket.incoming({ type: "session.ready", config: {} });
    });
    assert(await page.locator(".turn").count() === 3, "Late post-end events ignored");
    await page.locator(".memoir-excerpts a").first().click();
    assert(await page.evaluate(() => document.activeElement.id === "evidence-U01"), "Source link focuses exact evidence");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator(".download-memory").click(),
    ]);
    assert(download.suggestedFilename() === "suara-reviewed-memory.md", "Download filename must be stable");
    assert(await page.locator(".download-status.is-requested").count() === 1,
      "UI must describe a download request, not claim an observed save");
    await page.screenshot({ path: `${evidenceRoot}/voice-${locale}-mobile-review.png`, fullPage: true });
    await page.locator(".conversation-panel").screenshot({ path: `${evidenceRoot}/voice-${locale}-mobile-conversation.png` });
    await page.locator(".reset-panel .primary-action").click();
    assert(await page.evaluate(() => document.activeElement.classList.contains("secondary-action")), "Reset confirmation focuses keep option");
    await page.locator(".reset-panel .secondary-action").click();
    assert(await page.locator(".memoir-excerpts blockquote").count() === 2, "Cancel preserves review");
    await page.waitForFunction(() => document.activeElement.classList.contains("primary-action"));
    await page.locator(".reset-panel .primary-action").click();
    await page.locator(".reset-panel .primary-action").click();
    assert(await page.locator(".turn").count() === 0, "Confirmed reset clears transcript");
    assert(await page.locator("#voice-access-code").inputValue() === "", "Confirmed reset clears code");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/voice/?lang=${locale}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale} desktop overflow`);
    await page.screenshot({ path: `${evidenceRoot}/voice-${locale}-desktop.png` });
  }

  // Error preserves authoritative evidence; pagehide clears even a bfcache page.
  await page.goto(`${base}/voice/?lang=en`);
  await page.locator("#voice-access-code").fill("synthetic-qc-access-2026");
  await page.locator(".consent-card label").click();
  await page.locator(".primary-action").click();
  await page.locator(".session-state--listening").waitFor();
  await page.evaluate(() => {
    window.voiceQC.socket.incoming({ type: "transcript.user", item_id: "retained", text: "Synthetic fixture retained after a network error." });
    window.voiceQC.socket.incoming({ type: "error" });
  });
  await page.locator(".voice-error").waitFor();
  assert(await page.locator(".memory-review-card").count() === 1, "Error should preserve reviewable final words");
  assert(await page.locator(".memoir-excerpts blockquote").count() === 0, "Error evidence remains unreviewed");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.locator(".session-state--idle").waitFor();
  assert(await page.locator(".turn").count() === 0, "Pagehide clears transcript");
  assert(await page.locator("#voice-access-code").inputValue() === "", "Pagehide clears code");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  return { result: "PASS", locales: ["en", "ms", "zh"], widths: [390, 1440], requests: requests.length, errors, realMicrophone: false, realProvider: false };
}
