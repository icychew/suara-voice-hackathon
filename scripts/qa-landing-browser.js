// Run against the normal local production preview with Playwright CLI run-code --filename.
// This checks discoverability and console health only; it does not call provider routes.
async (page) => {
  const base = "http://127.0.0.1:5181";
  const problems = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(`${message.type()}: ${message.text()}`);
  });

  for (const locale of ["en", "ms", "zh"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?lang=${locale}`);
    const primary = page.locator(".hero__actions .button");
    const secondary = page.locator(".hero__actions .text-link");
    assert(await primary.getAttribute("href") === `/voice/?lang=${locale}`, `${locale}: primary voice route`);
    assert(await secondary.getAttribute("href") === `/prototype/?lang=${locale}`, `${locale}: synthetic fallback route`);
    assert(await page.locator(".voice-entry-note").count() === 1, `${locale}: access boundary is visible`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale}: landing overflows`);
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/?lang=en`);
  await page.locator(".hero__actions .button").click();
  await page.locator("#voice-access-code").waitFor();
  assert(page.url() === `${base}/voice/?lang=en`, "Primary CTA must open the judge voice pilot");
  assert(await page.locator("form #voice-access-code").count() === 1, "Access code belongs to the start form");
  assert(await page.locator('button[type="submit"]').count() === 1, "Start action is keyboard-submittable");
  await page.waitForTimeout(100);
  assert(problems.length === 0, `Console problems: ${problems.join("; ")}`);
  return { result: "PASS", locales: ["en", "ms", "zh"], primary: "/voice/", fallback: "/prototype/", problems };
}
