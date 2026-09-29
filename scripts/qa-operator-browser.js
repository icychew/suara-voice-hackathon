// Operator UI integration with synthetic transport only. Run in a fresh CLI session.
async (page) => {
  const base = "http://127.0.0.1:5182";
  const errors = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/*", async (route) => {
    const request = route.request();
    assert(request.url().startsWith(`${base}/`), "No external request permitted in synthetic UI test");
    if (/\/api\/session$/.test(request.url())) await route.fulfill({ status: 200, contentType: "application/json", body: '{"token":"SENTINEL_LOCAL_BEARER"}' });
    else if (/\/api\/voice\/token$/.test(request.url())) await route.fulfill({ status: 200, contentType: "application/json", body: '{"token":"SENTINEL_PROVIDER_TOKEN"}' });
    else await route.continue();
  });
  await page.addInitScript(() => {
    class Node extends EventTarget { connect(other) { return other; } disconnect() {} }
    class Audio extends Node {
      constructor() { super(); this.state = "suspended"; this.sampleRate = 48000; this.currentTime = 0;
        this.destination = new Node(); this.audioWorklet = { addModule: async () => {} }; }
      async resume() { this.state = "running"; }
      async close() { this.state = "closed"; }
      createMediaStreamSource() { return new Node(); }
      createGain() { const node = new Node(); node.gain = { value: 0 }; return node; }
      createBuffer(channels, length, rate) { return { copyToChannel() {}, duration: length / rate }; }
      createBufferSource() { const node = new Node(); node.start = () => {}; node.stop = () => {}; return node; }
    }
    window.AudioContext = Audio;
    window.AudioWorkletNode = class extends Node { constructor() { super(); this.port = {}; } };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const track = new Node(); track.stop = () => {}; return { getTracks: () => [track] };
    } });
    window.operatorQC = {};
    window.WebSocket = class extends EventTarget {
      static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; window.operatorQC.socket = this;
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }, 0); }
      incoming(event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
      send(payload) {
        const message = JSON.parse(payload);
        if (message.type === "session.update") {
          const config = { ...message.session, input: { ...message.session.input,
            transcription_mode: "balanced",
            turn_detection: { min_silence: null, max_silence: null, interrupt_response: true,
              vad_threshold: 0.5, interruption_delay: 100, ...message.session.input.turn_detection } } };
          queueMicrotask(() => this.incoming({ type: "session.ready", session_id: "SENTINEL_SESSION_ID", config }));
        }
        if (message.type === "session.end") queueMicrotask(() => this.incoming({ type: "session.ended" }));
      }
      close() { this.readyState = 3; }
    };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/voice/?lang=en`);
  await page.locator("#timing-opt-in").waitFor();
  assert(!await page.locator("#timing-opt-in").isChecked(), "Timing must default off");
  await page.locator("#voice-access-code").fill("synthetic-qc-access-2026");
  await page.locator(".consent-card label").click();
  await page.getByRole("button", { name: "Start three-question interview", exact: true }).click();
  await page.locator(".session-state--listening").waitFor();
  assert(await page.getByRole("button", { name: "Download current run", exact: true }).isDisabled(), "No trace or export without opt-in");
  assert(await page.getByRole("button", { name: "Download kept snapshots", exact: true }).isDisabled(), "No kept exports without opt-in");
  await page.getByRole("button", { name: "Finish interview", exact: true }).click();
  await page.locator(".session-state--ended").waitFor();
  await page.getByRole("button", { name: "Start fresh", exact: true }).click();

  for (const mode of ["baseline", "patient"]) {
    await page.locator("#timing-opt-in").check();
    await page.locator(`.mode-option:has(input[value="${mode}"])`).click();
    await page.locator("#voice-access-code").fill("synthetic-qc-access-2026");
    await page.locator(".consent-card label").click();
    await page.getByRole("button", { name: "Start three-question interview", exact: true }).click();
    await page.locator(".session-state--listening").waitFor();
    assert(await page.locator("#timing-opt-in").isDisabled(), "Opt-in fixed during session");
    await page.getByRole("button", { name: "Mark intended pause", exact: true }).click();
    await page.evaluate(() => {
      const socket = window.operatorQC.socket;
      socket.incoming({ type: "input.speech.stopped", item_id: "SENTINEL_ITEM_ID" });
      socket.incoming({ type: "reply.started", reply_id: "SENTINEL_REPLY_ID" });
      socket.incoming({ type: "reply.audio", data: "AAAAAA==" });
      socket.incoming({ type: "transcript.user", item_id: "SENTINEL_ITEM_ID", text: "SENTINEL_STORY_CONTENT" });
    });
    await page.getByRole("button", { name: "Mark reply heard", exact: true }).click();
    await page.getByRole("button", { name: "Mark resuming", exact: true }).click();
    await page.evaluate(() => window.operatorQC.socket.incoming({ type: "input.speech.started" }));
    await page.getByRole("button", { name: "Mark thought complete", exact: true }).click();
    await page.getByRole("button", { name: "Finish interview", exact: true }).click();
    await page.locator(".session-state--ended").waitFor();
    await page.locator("#observed-outcome").selectOption("spoke_during_intended_pause");
    if (mode === "patient") {
      const currentDownloadReady = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download current run", exact: true }).click();
      await (await currentDownloadReady).saveAs("output/playwright/operator-synthetic-current.json");
    }
    await page.getByRole("button", { name: "Keep timing snapshot", exact: true }).click();
    assert(await page.getByRole("button", { name: "Keep timing snapshot", exact: true }).isDisabled(), "No duplicate keep");
    assert(await page.locator("#observed-outcome").isDisabled(), "Kept outcome frozen");
    if (mode === "baseline") {
      await page.getByRole("button", { name: "Start fresh", exact: true }).click();
      await page.getByRole("button", { name: "Clear this page and start fresh", exact: true }).click();
      assert(!await page.locator("#timing-opt-in").isChecked(), "Reset revokes current timing opt-in");
      await page.getByText("1/2 timing snapshots explicitly kept in this tab.", { exact: true }).waitFor();
    }
  }
  await page.getByText("Not comparable: conditions_not_confirmed.", { exact: true }).waitFor();
  await page.getByLabel("I used the same fictional case, equipment and conditions.", { exact: true }).check();
  await page.getByText("Pair ready for manual review. Two runs do not establish superiority or older-adult benefit.", { exact: true }).waitFor();
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download kept snapshots", exact: true }).click();
  const download = await downloadReady;
  await download.saveAs("output/playwright/operator-synthetic-timing.json");
  await page.locator("#timing-title").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/operator-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile overflow");
  await page.locator("#timing-title").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/operator-mobile.png" });
  await page.getByRole("button", { name: "Clear all timings", exact: true }).click();
  await page.getByText("0/2 timing snapshots explicitly kept in this tab.", { exact: true }).waitFor();
  assert(await page.getByRole("button", { name: "Download current run", exact: true }).isDisabled(), "Clear prevents old current exports");
  assert(await page.getByRole("button", { name: "Download kept snapshots", exact: true }).isDisabled(), "Clear prevents old kept exports");
  assert(errors.length === 0, errors.join("; "));
  return { result: "PASS", realAudio: false, realProvider: false, pairedSyntheticTraces: 2, errors };
}
