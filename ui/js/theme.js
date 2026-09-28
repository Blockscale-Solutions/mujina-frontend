/** Blocking-capable theme apply — also imported as module from app. */
(function () {
  var KEY = 'mujina-theme';

  function preferred() {
    try {
      var stored = localStorage.getItem(KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch (_) {}
    return 'system';
  }

  function resolve(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function apply(choice) {
    var resolved = resolve(choice);
    document.documentElement.setAttribute('data-theme', resolved);
    document.querySelectorAll('[data-theme-toggle]').forEach(function (root) {
      root.querySelectorAll('button[data-theme-value]').forEach(function (btn) {
        var v = btn.getAttribute('data-theme-value');
        var on = v === choice || (choice === 'system' && v === 'system');
        // Pressed tracks stored choice, not resolved.
        btn.setAttribute('aria-pressed', v === choice ? 'true' : 'false');
      });
    });
  }

  function set(theme) {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return;
    try { localStorage.setItem(KEY, theme); } catch (_) {}
    apply(theme);
  }

  apply(preferred());

  function wire() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (root) {
      if (root.getAttribute('data-theme-wired') === '1') return;
      root.setAttribute('data-theme-wired', '1');
      root.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-theme-value]');
        if (!btn || !root.contains(btn)) return;
        set(btn.getAttribute('data-theme-value'));
      });
    });
    apply(preferred());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  if (window.matchMedia) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (preferred() === 'system') apply('system');
      });
    } catch (_) {}
  }

  window.MujinaTheme = { get: preferred, set: set, resolve: resolve };
})();
