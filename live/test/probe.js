// Loaded only by the flow tests (the /under-test pages of dev.py), after the
// stand-in for Claude and before the page's own scripts. It changes nothing
// the page does; it only keeps a record the tests can read:
//
//   window.__errors   every uncaught error, unhandled rejection, console.error
//                     and script that failed to load. A test fails if any appear.
//   window.__calls    every request the page made to Claude: the turns it
//                     sent, and the options that matter.
//
// It also switches off transitions and animations, as the page's own rule for
// "reduce motion" does. A page that is not on screen draws no frames, so a
// drawer that slides in would never arrive, and the tests would depend on
// whether anyone is looking at them.

(() => {
  'use strict';

  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
  document.head.append(still);

  const errors = window.__errors = [];
  const note = (kind, message) => errors.push({ kind, message: String(message).slice(0, 600) });

  addEventListener('error', ev => {
    if (ev.target && ev.target !== window) {
      // A script that did not load (MathJax, the layout library). Fonts and
      // images are left out: without them the page looks different, not wrong.
      if (ev.target.tagName === 'SCRIPT') note('load', 'script ' + ev.target.src);
      return;
    }
    const where = ev.filename ? ` (${ev.filename.split('/').pop().split('?')[0]}:${ev.lineno})` : '';
    note('error', ev.message + where);
  }, true);

  addEventListener('unhandledrejection', ev => {
    const r = ev.reason;
    note('unhandled rejection', r && (r.stack || r.message) ? (r.message || r.stack) : JSON.stringify(r));
  });

  const original = console.error;
  console.error = (...args) => {
    note('console.error', args.map(a => (a && a.message) || String(a)).join(' '));
    original.apply(console, args);
  };

  const calls = window.__calls = [];
  const runtime = window.claude;
  if (!runtime) return;
  window.claude = {
    ...runtime,
    use: async name => {
      const cap = await runtime.use(name);
      if (name !== 'sample' || !cap) return cap;
      const sample = (input, opts) => {
        const turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input.map(t => ({ role: t.role, content: t.content }));
        calls.push({ turns, prompt: turns[turns.length - 1].content, tier: (opts && opts.modelTier) || null, effort: (opts && opts.effort) || null, tools: !!(opts && opts.tools) });
        return cap(input, opts);
      };
      sample.json = cap.json;
      sample.limits = cap.limits;
      return sample;
    },
  };
})();
