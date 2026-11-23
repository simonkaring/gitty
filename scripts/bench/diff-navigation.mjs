// Called by split-diff.smoke.mjs --bench-navigation with its real component and large fixture.
export async function benchmarkNavigation(browser, fixture) {
  for (const layout of ['unified', 'split']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 }, reducedMotion: 'reduce' });
    await page.goto(`${fixture}?large&${layout}`);
    const view = page.locator('.native-diff[data-virtual]');
    await view.locator('[data-row]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await view.press('Home');
    const samples = await view.evaluate(async el => {
      const samples = [];
      for (let batch = 0; batch < 9; batch++) {
        await new Promise(requestAnimationFrame);
        const start = performance.now();
        for (let i = 0; i < 40; i++) {
          const down = i % 2 === 0;
          el.dispatchEvent(new KeyboardEvent('keydown', { key: down ? 'ArrowDown' : 'ArrowUp', bubbles: true, cancelable: true }));
          await Promise.resolve(); // Let the discrete React update commit.
          const active = document.getElementById(el.getAttribute('aria-activedescendant'));
          if (active?.closest('[data-row]')?.dataset.row !== (down ? '2' : '1')) throw new Error('Navigation did not commit');
        }
        if (batch >= 2) samples.push((performance.now() - start) / 40);
      }
      return samples;
    });
    const median = samples.toSorted((a, b) => a - b)[3];
    console.log(JSON.stringify({ layout, browser: browser.version(), unit: 'ms/key commit', median, samples }));
    await page.close();
  }
}
