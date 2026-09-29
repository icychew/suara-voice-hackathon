// Additional viewport/reflow check for the production preview; no microphone.
async (page) => {
  const results = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const locale of ["en", "ms", "zh"]) {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`http://127.0.0.1:5181/voice/?lang=${locale}`);
    await page.locator("#setup-title").waitFor();
    const check = await page.evaluate(() => ({
      locale: document.documentElement.lang,
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      smallControls: [...document.querySelectorAll(".voice-locale button")].filter((el) => el.getBoundingClientRect().width < 44 || el.getBoundingClientRect().height < 44).length,
      skipTop: document.querySelector(".voice-skip").getBoundingClientRect().bottom,
    }));
    if (check.scrollWidth > check.width || check.smallControls > 0 || check.skipTop > 0) throw new Error(JSON.stringify(check));
    await page.screenshot({ path: `output/playwright/voice-${locale}-320-hero.png` });
    await page.locator(".hero-action").click();
    await page.screenshot({ path: `output/playwright/voice-${locale}-320-setup.png` });
    results.push(check);
  }
  return { result: "PASS", cases: results };
}
