// Applies the last resolved theme before first paint; SettingsProvider writes it (see src/model/settings.tsx).
try {
  const boot = JSON.parse(localStorage.getItem('gitty:theme-boot') || 'null');
  if (boot && typeof boot.tokens === 'object') {
    const root = document.documentElement;
    root.dataset.theme = boot.mode;
    root.dataset.design = boot.design;
    root.style.colorScheme = boot.mode;
    for (const [key, value] of Object.entries(boot.tokens)) if (key.startsWith('--')) root.style.setProperty(key, String(value));
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', boot.tokens['--bg']);
  }
} catch {}
