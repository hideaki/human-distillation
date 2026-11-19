// Flow tests: the real page, driven the way a reader drives it, against the
// stand-in for Claude (dev-runtime.js). Open /test on the preview server.
//
// The page under test runs in the frame below the report. Each test loads it
// afresh with storage it chose itself: empty, or a saved state that an earlier
// step produced by really clicking through the page (see `fixture`).
//
// A test fails when an expectation fails, and also when the page reports an
// uncaught error, an unhandled rejection or a console.error (probe.js).
//
// Results: in the page, and in window.__results for reading from outside.

(() => {
  'use strict';

  const KEY = 'human-distillation-live-v1';
  const params = new URLSearchParams(location.search);
  const TARGET = params.get('page') === 'built' ? '/built-under-test' : '/under-test';
  const ONLY = (params.get('only') || '').toLowerCase();
  // How long a person holds a mouse button down. Long enough for the page to
  // redraw under the pointer, which is how a click gets lost.
  const HOLD = 70;

  const frame = document.getElementById('app');
  let win = null, doc = null, loads = 0;
  let pageErrors = []; // from documents this test has already left
  let notes = []; // things worth saying if the test goes on to fail
  let scrolls = []; // every scroll the page under test has heard of: { t, on }

  // ---------- expectations ----------

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const show = v => { const s = typeof v === 'string' ? JSON.stringify(v) : String(v); return s.length > 240 ? s.slice(0, 239) + '…' : s; };
  function fail(msg) { throw new Error(msg); }
  function ok(v, what) { if (!v) fail(what); return v; }
  function eq(got, want, what) { if (got !== want) fail(`${what}: expected ${show(want)}, got ${show(got)}`); }
  function same(got, want, what) { const a = JSON.stringify(got), b = JSON.stringify(want); if (a !== b) fail(`${what}: expected ${show(b)}, got ${show(a)}`); }
  function has(text, part, what) { if (!String(text).includes(part)) fail(`${what}: expected to find ${show(part)} in ${show(String(text))}`); }
  function lacks(text, part, what) { if (String(text).includes(part)) fail(`${what}: did not expect ${show(part)}`); }

  // Poll until fn() returns something truthy. Never a fixed sleep: the stand-in
  // writes at its own pace and the browser may slow timers down.
  async function until(fn, what, ms = 8000) {
    const t0 = performance.now();
    let last = null;
    for (;;) {
      try { const v = fn(); if (v) return v; last = null; } catch (e) { last = e; }
      if (performance.now() - t0 > ms) fail(`Waited ${Math.round(ms / 1000)}s for ${what}` + (last ? ` (${last.message})` : ''));
      await sleep(40);
    }
  }

  // ---------- the page ----------

  const $ = (s, r) => (r || doc).querySelector(s);
  const $$ = (s, r) => [...(r || doc).querySelectorAll(s)];
  const txt = e => (e ? e.textContent : '');
  const store = () => JSON.parse(localStorage.getItem(KEY));
  const conv = () => { const s = store(); return s.convs[s.current]; };
  const node = id => conv().nodes[id];
  const cols = () => conv().cols;
  const lastCol = () => { const c = cols(); return c[c.length - 1]; };
  const lastStart = () => lastCol().start;
  const ids = () => new Set(Object.keys(conv().nodes));
  const pathLength = id => { let n = 0; for (let x = node(id); x; x = node(x.parent)) n++; return n; };
  const calls = () => win.__calls;
  const lastCall = () => calls()[calls().length - 1];
  const pane = start => $(`#panes .pane[data-start="${start}"]`);
  const answerText = id => $(`#panes .text[data-node="${id}"]`);
  const mainText = () => answerText('root');
  const pop = () => $('#pop.show');
  const toastText = () => ($('#toast').classList.contains('show') ? txt($('#toast')) : '');
  const button = (root, label) => $$('button', root).find(b => txt(b).includes(label));
  const chip = (start, label) => $$('.composer .chips .chip', pane(start)).find(b => txt(b) === label);
  const chipLabels = start => $$('.composer .chips .chip', pane(start)).map(txt);
  const name = e => (e ? `<${(e.tagName || 'node').toLowerCase()}${e.id ? '#' + e.id : ''}${e.classList && e.classList.length ? '.' + [...e.classList].join('.') : ''}> ${show(txt(e).trim().slice(0, 50))}` : 'nothing');

  function navigate(url) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => (url === 'about:blank' ? res() : rej(new Error('The page did not load: ' + url))), url === 'about:blank' ? 1500 : 30000);
      frame.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
      frame.src = url;
    });
  }

  function keepErrors() {
    try { if (win && win.__errors) pageErrors = pageErrors.concat(win.__errors.splice(0)); } catch (e) { /* the frame has gone */ }
  }

  // Load the page. o.seed: what storage holds (default: nothing, which shows
  // the worked example). o.keep: leave storage as it is, as a reload does.
  // o.raw: how many formulas are expected to stay as source.
  async function load(o = {}) {
    keepErrors();
    // Leave the old page first, so nothing in it can write to storage again.
    await navigate('about:blank');
    if (!o.keep) {
      localStorage.removeItem(KEY);
      if (o.seed) localStorage.setItem(KEY, o.seed);
    }
    frame.style.width = (o.width || 1440) + 'px';
    frame.style.height = (o.height || 900) + 'px';
    // o.query goes to the stand-in: which connectors the viewer lacks.
    await navigate(`${TARGET}?load=${++loads}${o.query ? '&' + o.query : ''}`);
    win = frame.contentWindow;
    doc = win.document;
    ok(win.__errors && win.__calls, 'The probe did not load with the page');
    await until(() => $('#notice') && !$('#notice').hidden && $('#panes .pane, #panes .spine'), 'the page to start', 20000);
    scrolls = [];
    doc.addEventListener('scroll', ev => scrolls.push({ t: performance.now(), on: ev.target === doc ? 'the page' : name(ev.target) }), true);
    await drawn(o.raw || 0);
    await calm();
  }
  const reload = o => load({ ...o, keep: true });

  // Formulas are typeset when MathJax arrives, which is after the first
  // drawing. Wait until none is left as source, apart from the `raw` that
  // are meant to stay so.
  async function drawn(raw = 0) {
    let steady = 0;
    await until(() => { steady = $$('.math.raw').length === raw ? steady + 1 : 0; return steady >= 3; },
      `the formulas to be typeset${raw ? ` (all but ${raw})` : ''}; still as source: ${$$('.math.raw').map(h => h.getAttribute('aria-label')).join(' | ')}`, 40000);
  }

  // The answer to a turn has finished, one way or another.
  async function answered(id, ms = 120000) {
    await until(() => { const n = node(id); return n && n.phase !== 'pending' && n.phase !== 'streaming'; }, `the answer to turn ${id} to finish`, ms);
    return node(id);
  }
  async function fresh(before, what) {
    return until(() => Object.keys(conv().nodes).find(k => !before.has(k)), what || 'a new turn to be made', 6000);
  }

  // ---------- the pointer ----------

  // The innermost element at a point, looking inside diagrams and formulas.
  function deepAt(x, y) {
    let e = doc.elementFromPoint(x, y);
    for (let i = 0; e && e.shadowRoot && i < 4; i++) {
      const inner = e.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  }
  const up = n => n.parentNode || n.host || null;
  const inside = (n, target) => { for (; n; n = up(n)) if (n === target) return true; return false; };
  const onSymbol = hit => { for (let n = hit; n; n = up(n)) if (n.classList && n.classList.contains('sym')) return true; return false; };
  const offSymbol = hit => !onSymbol(hit);

  // The page closes its menus when anything scrolls, and it hears of a scroll
  // one frame after it happened. So before pointing at something, let the
  // page come to rest: web fonts in (they shift the text when they arrive),
  // and one frame drawn, which delivers any scroll that is still on its way.
  // (A page that is not on screen draws no frames at all; then do not wait long.)
  const frameDrawn = () => new Promise(res => { const t = setTimeout(res, 120); win.requestAnimationFrame(() => { clearTimeout(t); res(); }); });
  async function calm() {
    if (doc.fonts && doc.fonts.status === 'loading') await Promise.race([doc.fonts.ready, sleep(3000)]);
    await frameDrawn();
  }

  async function bring(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await frameDrawn();
    await frameDrawn();
  }

  // A point where a real pointer would land on `el`: on screen, and with
  // nothing else on top of it. `accept` narrows it further.
  async function spot(el, what, accept) {
    ok(el, `${what} is not on the page`);
    const look = () => {
      let rects = [...el.getClientRects()].filter(q => q.width > 1 && q.height > 1).slice(0, 4);
      if (!rects.length) rects = [el.getBoundingClientRect()];
      for (const r of rects) {
        for (const fy of [0.5, 0.3, 0.7]) {
          for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85, 0.4, 0.6, 0.05, 0.95, 0.2, 0.8]) {
            const x = r.left + r.width * fx, y = r.top + r.height * fy;
            const hit = deepAt(x, y);
            if (hit && inside(hit, el) && (!accept || accept(hit))) return { x, y, hit };
          }
        }
      }
      return null;
    };
    let at = look();
    if (!at) {
      ok(el.isConnected, `${what} is no longer on the page`);
      await bring(el);
      at = await until(look, 'it', 4000).catch(() => null);
    }
    if (!at) {
      const r = el.getBoundingClientRect();
      fail(`${what} cannot be reached with the pointer. At its place is ${name(deepAt(r.left + r.width / 2, r.top + r.height / 2))}`);
    }
    return at;
  }

  function mouse(target, event, at, more) {
    target.dispatchEvent(new win.MouseEvent(event, { bubbles: true, cancelable: true, composed: true, view: win, button: 0, clientX: at.x, clientY: at.y, ...more }));
  }

  // A click as a browser delivers it: press, hold a moment, release on
  // whatever is under the pointer by then. The click itself goes to what the
  // press and the release have in common, and a browser sends none at all if
  // what was pressed has left the page in between. That is how a click on a
  // button gets lost when the page redraws the button while it is held down.
  async function click(el, what, accept) {
    what = what || name(el);
    ok(el, `${what} is not on the page`);
    await calm();
    const at = await spot(el, what, accept);
    ok(!el.disabled, `${what} is disabled`);
    const down = at.hit, pressed = performance.now();
    win.getSelection().removeAllRanges();
    mouse(down, 'mousedown', at);
    await sleep(HOLD);
    const gone = !down.isConnected;
    const rel = deepAt(at.x, at.y);
    if (rel) mouse(rel, 'mouseup', at);
    if (gone) { notes.push(`The page replaced ${what} while the mouse button was held down, so a browser sends no click for it.`); return; }
    if (!rel || !down.isConnected) return; // the release itself did the work and redrew the page
    let target = rel;
    while (target && !inside(down, target)) target = up(target);
    if (target && !inside(target, el)) {
      const moved = scrolls.filter(s => s.t >= pressed).map(s => s.on);
      notes.push(`By the time the mouse button was released on ${what}, ${name(rel)} was under the pointer instead, so the click went to ${name(target)}.`
        + (moved.length ? ` While it was held down, this scrolled: ${moved.join(', ')}.` : ''));
    }
    if (target && target.dispatchEvent) mouse(target, 'click', at);
  }

  async function hover(el, what) {
    await calm();
    const at = await spot(el, what || name(el));
    mouse(at.hit, 'mouseover', at);
    return at;
  }

  function type(el, text) {
    el.focus();
    el.value = text;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  }
  function key(el, k, more) {
    el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true, ...more }));
  }

  // Drag across `text` inside an answer and let go at its end.
  function rangeOf(host, start, end) {
    const w = doc.createTreeWalker(host, win.NodeFilter.SHOW_TEXT);
    const r = doc.createRange();
    let pos = 0, n, began = false;
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length;
      if (!began && start < pos + len) { r.setStart(n, start - pos); began = true; }
      if (began && end <= pos + len) { r.setEnd(n, end - pos); return r; }
      pos += len;
    }
    return fail('The text to select is not in the answer');
  }
  async function drag(getHost, text) {
    const from = getHost().textContent.indexOf(text);
    ok(from >= 0, `The answer does not contain ${show(text)}`);
    await calm();
    await spot(rangeOf(getHost(), from, from + 1).startContainer.parentElement, 'the text to select');
    const range = rangeOf(getHost(), from, from + text.length);
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const rects = [...range.getClientRects()].filter(q => q.width > 0);
    const r = rects[rects.length - 1];
    const at = { x: r.right - 2, y: r.top + r.height / 2 };
    mouse(deepAt(at.x, at.y) || getHost(), 'mouseup', at);
    return { start: from, end: from + text.length };
  }

  // ---------- parts of an answer ----------

  const sentence = (host, starts) => $$('.sent', host).find(s => s.textContent.startsWith(starts));
  const display = host => $('.math.display', host); // the formula on a line of its own
  const formulaOf = (host, tex) => $$('.math', host).find(h => h.getAttribute('aria-label') === tex);
  const syms = (mathHost, tex) => [...mathHost.shadowRoot.querySelectorAll('g.sym')].filter(g => g.getAttribute('data-tex') === tex);
  const figure = host => $('.figure', host);
  const figParts = host => [...figure(host).shadowRoot.querySelectorAll('.part')];
  const figPart = (host, part) => figParts(host).find(p => p.dataset.part === part);

  // A symbol can be pointed at once its box has been added, a moment after
  // the formula is first on screen.
  const symbol = (getMath, tex) => until(() => {
    const g = syms(getMath(), tex)[0];
    return g && g.querySelector('rect.bg') && g;
  }, `the symbol ${tex} to be ready to point at`, 10000);

  async function menu() { return until(pop, 'the ask menu to open', 5000); }

  // Press "Explain further" in the open menu; wait for the thread's answer.
  async function explain() {
    await menu();
    const before = ids();
    await click($('#pop button.primary'), '"Explain further"');
    const id = await fresh(before, 'the thread to be made');
    await until(() => pane(id), 'the thread to open beside the answer');
    await answered(id);
    return id;
  }

  async function askFirst(q, o = {}) {
    await click($('#newconv'), '"New"');
    const box = await until(() => $('#msg-new'), 'an empty conversation');
    type(box, q);
    key(box, 'Enter');
    await until(() => $('#panes .turn[data-node="root"]'), 'the question to appear');
    if (o.wait === false) return;
    await answered('root');
    await drawn(o.raw || 0);
  }

  async function sendIn(start, text) {
    const before = ids();
    type($('.composer .msg', pane(start)), text);
    await click($('.composer .send', pane(start)), '"Send"');
    return fresh(before, 'the typed question to be asked');
  }

  function clipboard(refuse) {
    const grab = { text: null };
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: t => (refuse ? Promise.reject(new Error('refused')) : (grab.text = t, Promise.resolve())) },
    });
    return grab;
  }

  function noSideways(what) {
    const de = doc.documentElement;
    ok(de.scrollWidth <= de.clientWidth, `${what}: the page is ${de.scrollWidth}px wide in a ${de.clientWidth}px window`);
    win.scrollTo(300, 0);
    eq(win.scrollX, 0, `${what}: the page scrolled sideways`);
  }

  // ---------- saved states ----------
  // Made once by clicking through the page, then reused as the starting
  // storage of other tests. Much faster than asking the same first question
  // sixty times, and every test still starts from storage it knows.

  const FIRST = 'What is a regression test?';
  const SENT = 'A real answer would open with the point itself.';
  const FORMULA = '$$L = \\alpha \\, T^2 \\, \\mathrm{KL}(p \\,\\|\\, q) + (1 - \\alpha) \\, \\mathrm{CE}(y, q)$$';
  const NEXT = ['What would a real answer look like?', 'Show the same thing with #long', 'What happens on an #error?'];
  const SIDE_REPLY = 'Placeholder answer about the part you pointed at.';

  // The five kinds of thread. `open` makes one from the first answer.
  const KINDS = {
    main: { label: 'Main thread', box: 'Ask a follow-up…' },
    passage: {
      label: 'Passage', box: 'Ask more about this passage…', about: SENT,
      open: async () => { await click(sentence(mainText(), 'A real answer would open'), 'a sentence'); return explain(); },
      mark: id => $(`mark[data-node="${id}"]`, mainText()),
    },
    formula: {
      label: 'Formula', box: 'Ask more about this formula…', about: FORMULA,
      open: async () => { await click(display(mainText()), 'the formula', offSymbol); return explain(); },
      mark: () => display(mainText()),
      accept: offSymbol,
    },
    symbol: {
      label: 'Symbol', box: 'Ask more about this symbol…', about: 'the symbol $\\alpha$ in ' + FORMULA,
      open: async () => { await click(await symbol(() => display(mainText()), '\\alpha'), 'the symbol α'); return explain(); },
      mark: () => syms(display(mainText()), '\\alpha')[0],
    },
    part: {
      label: 'Diagram part', box: 'Ask more about this part of the diagram…', about: 'Question',
      open: async () => { await click(figPart(mainText(), 'n:question'), 'the box "Question"'); return explain(); },
      mark: () => figPart(mainText(), 'n:question'),
    },
  };

  const fixtures = {};
  function fixture(kind) {
    if (!fixtures[kind]) {
      fixtures[kind] = (async () => {
        if (kind === 'main') {
          await load();
          await askFirst(FIRST);
        } else {
          await load({ seed: await fixture('main') });
          await KINDS[kind].open();
        }
        keepErrors();
        if (pageErrors.length) fail('the page reported ' + pageErrors.map(e => `${e.kind}: ${e.message}`).join(' | '));
        return localStorage.getItem(KEY);
      })().catch(e => { throw new Error(`Could not set up a ${KINDS[kind].label.toLowerCase()}: ${e.message}`); });
    }
    return fixtures[kind];
  }
  // Start a test from the first answer, with a thread of this kind open.
  async function given(kind, o) { await load({ ...o, seed: await fixture(kind) }); }

  // ---------- the tests ----------

  const tests = [];
  const test = (group, title, fn, cell) => tests.push({ group, title, fn, cell });

  // ----- starting -----

  test('Start', 'empty storage shows the worked example, drawn in full', async () => {
    await load();
    eq(txt($('#notice')), 'Local preview. Answers here are placeholders from a stand-in, not from Claude.', 'The notice');
    const t = mainText();
    has(txt($('.turn[data-node="root"] .bubble')), 'How does knowledge distillation work?', 'The question');
    ok($$('.math', t).length >= 6 && !$('.math.raw', t), 'The formulas of the example are typeset');
    eq(figParts(t).length, 10, 'The boxes and links of the diagram');
    ok($('mark[data-node="n1"].open', t), 'The passage that has a thread is marked');
    ok($$('.gloss', t).length >= 6, 'Terms are underlined');
    eq(txt($('#counts')), '1 open · 0 queued · 0 resolved', 'The map counts');
    eq(calls().length, 0, 'Requests to Claude before anything is asked');
    noSideways('The example');
  });

  test('Start', 'asking a first question: thinking, writing, then the finished answer', async () => {
    await load();
    await click($('#newconv'), '"New"');
    const box = await until(() => $('#msg-new'), 'an empty conversation');
    eq(box.placeholder, 'Ask anything…', 'The message box');
    eq(chipLabels('new').length, 3, 'Starter questions');
    eq(txt($('#counts')), 'Nothing asked yet', 'The map');
    type(box, FIRST);
    key(box, 'Enter', { shiftKey: true });
    ok(!$('#panes .turn'), 'Shift+Enter does not send');
    key(box, 'Enter');
    await until(() => $('#panes .turn[data-node="root"]'), 'the question to appear');
    eq(txt($('.turn[data-node="root"] .bubble')), FIRST, 'The question bubble');
    has(txt($('.turn[data-node="root"] .working')), 'Thinking…', 'While waiting');
    ok($('.composer .send', pane('root')).disabled, 'Send is off while the answer is written');
    await until(() => $('.text.streaming[data-node="root"]'), 'the answer to start arriving', 20000);
    has(txt($('.turn[data-node="root"] .working')), 'Writing…', 'While writing');
    lacks(txt($('.text.streaming')), '@@@', 'The text while it is written');
    const n = await answered('root');
    await drawn();
    eq(n.phase, 'done', 'The turn');
    const t = mainText();
    ok(!t.classList.contains('streaming') && !$('.turn[data-node="root"] .working'), 'The answer is finished');
    has(txt(t), `You asked: “${FIRST}”.`, 'The answer');
    lacks(txt(t), 'term:', 'The answer');
    ok($$('.sent', t).length >= 8, 'Each sentence can be pointed at');
    eq($$('.math', t).length, 2, 'Formulas');
    ok(display(t) && display(t).shadowRoot.querySelector('svg'), 'The formula on its own line is drawn');
    eq(figParts(t).filter(p => p.classList.contains('node')).length, 5, 'Boxes in the diagram');
    eq(figParts(t).filter(p => p.classList.contains('edge')).length, 4, 'Links in the diagram');
    has(txt($('pre code', t)), 'for step in range(3):', 'The code block');
    same($$('.gloss', t).map(txt).sort(), ['inline code', 'stand-in runtime'], 'Underlined terms');
    same(chipLabels('root'), NEXT, 'Follow-up chips');
    ok(!$('.composer .send', pane('root')).disabled, 'Send is on again');
    eq(txt($('#convs .conv.on .lab')), FIRST, 'The conversation title');
    eq(txt($('#counts')), 'One thread so far', 'The map');
    // What was sent: the rules, then the question, and nothing else.
    eq(calls().length, 1, 'Requests to Claude');
    same(lastCall().turns.map(x => x.role), ['user', 'user'], 'The turns sent');
    has(lastCall().turns[0].content, 'You are the explainer inside a study app', 'The first turn sent');
    eq(lastCall().prompt, FIRST, 'The question sent');
    // Offsets count the source of a formula and nothing of a diagram.
    has(txt(t), FORMULA, 'The text of the answer');
    lacks(txt(t), 'sent to', 'The text of the answer');
  });

  // ----- passages -----

  test('Passages', 'clicking a sentence opens the menu, and "Explain further" opens a thread beside it', async () => {
    await given('main');
    const s = sentence(mainText(), 'It would then give');
    const text = txt(s);
    await click(s, 'a sentence');
    await menu();
    eq($('#pop-q').placeholder, 'Ask about this part…', 'The question box');
    same($$('#pop button').map(txt), ['Explain further', 'Later'], 'The menu');
    eq(calls().length, 0, 'Nothing is asked until a choice is made');
    const before = ids();
    await click($('#pop button.primary'), '"Explain further"');
    const id = await fresh(before);
    const p = await until(() => pane(id), 'the thread beside the answer');
    ok(p.classList.contains('beside') && !pop(), 'A column opens and the menu closes');
    eq(txt($('header .from', p)), `“${text}”`, 'The heading of the thread');
    eq(txt($('.bubble', p)), 'Explain further', 'The question shown');
    const n = await answered(id);
    eq(n.phase, 'done', 'The turn');
    same([n.q, n.verb, n.parent, n.status], ['Explain further', 'explain', 'root', 'open'], 'The turn');
    same(Object.keys(n.anchor).sort(), ['end', 'start', 'text'], 'The anchor of a passage');
    eq(n.anchor.text, text, 'The passage');
    eq(txt(mainText()).slice(n.anchor.start, n.anchor.end), text, 'The offsets point at the passage');
    has(n.prompt, `About this part of your answer:\n"${text}"\n\nExplain this part further.`, 'The question sent');
    const marks = $$(`mark[data-node="${id}"]`, mainText());
    eq(marks.map(txt).join(''), text, 'The marked passage');
    ok(marks[0].classList.contains('open') && marks[0].classList.contains('active'), 'The passage is marked as open and on screen');
    has(txt(answerText(id)), SIDE_REPLY, 'The answer in the thread');
    eq($('.composer .msg', pane(id)).placeholder, 'Ask more about this passage…', 'The message box of the thread');
    eq(txt($('#counts')), '1 open · 0 queued · 0 resolved', 'The map counts');
    eq($$('#tree .row').length, 2, 'Rows in the map');
    // The thread is sent with the turns above it and nothing else.
    same(lastCall().turns.map(x => x.role), ['user', 'user', 'assistant', 'user'], 'The turns sent');
    eq(lastCall().effort, 'low', 'A one-click question is asked at low effort');
  });

  test('Passages', 'dragging across words asks about just those words, with a typed question', async () => {
    await given('main');
    const o = await drag(mainText, 'few short sentences');
    await menu();
    ok(win.getSelection().isCollapsed, 'The selection is replaced by the highlight');
    const before = ids();
    type($('#pop-q'), 'Why short ones?');
    key($('#pop-q'), 'Enter');
    const id = await fresh(before);
    await until(() => pane(id), 'the thread');
    const n = await answered(id);
    same([n.q, n.verb || null, n.anchor.text, n.anchor.start, n.anchor.end], ['Why short ones?', null, 'few short sentences', o.start, o.end], 'The turn');
    eq(n.prompt, 'About this part of your answer:\n"few short sentences"\n\nWhy short ones?', 'The question sent');
    eq(txt($('header .from', pane(id))), '“few short sentences”', 'The heading');
    eq($$(`mark[data-node="${id}"]`, mainText()).map(txt).join(''), 'few short sentences', 'The marked words');
  });

  test('Passages', 'a word or two is taken as a term', async () => {
    await given('main');
    await drag(mainText, 'short list');
    const id = await explain();
    eq(node(id).q, 'What does “short list” mean here?', 'The question shown');
    has(node(id).prompt, 'About this term in your answer: "short list"', 'The question sent');
  });

  test('Passages', 'a selection that runs through a formula carries the formula along', async () => {
    await given('main');
    const want = 'words and a formula such as $p_i = \\frac{\\exp(z_i / T)}{\\sum_j \\exp(z_j / T)}$';
    await drag(mainText, want);
    await menu();
    ok($('li .math', mainText()).classList.contains('pending'), 'The formula is highlighted with the words');
    const id = await explain();
    eq(node(id).anchor.text, want, 'The passage');
    eq(txt(mainText()).slice(node(id).anchor.start, node(id).anchor.end), want, 'The offsets');
    const f = $('li .math', mainText());
    ok(f.classList.contains('marked') && f.classList.contains('open'), 'The formula is marked with the passage');
    ok($('header .from .math', pane(id)) && !$('header .from .math.raw', pane(id)), 'The heading shows the formula typeset');
  });

  test('Passages', '"Later" queues the question, and "Next open question" brings it up', async () => {
    await given('main');
    await click(sentence(mainText(), 'It would then give'), 'a sentence');
    await menu();
    const before = ids();
    await click($('#pop button.later'), '"Later"');
    const id = await fresh(before);
    has(toastText(), 'Queued.', 'The toast');
    ok(!pane(id) && cols().length === 1 && !pop(), 'No thread opens');
    eq(node(id).status, 'queued', 'The turn');
    ok($(`mark[data-node="${id}"].queued`, mainText()), 'The passage is marked as queued');
    has(txt($('#tree .row.queued')), 'writing…', 'The row in the map');
    await answered(id);
    await until(() => toastText().includes('A question you queued has its answer'), 'the toast that says it is ready');
    has(txt($('#tree .row.queued .state')), 'ready', 'The row in the map');
    ok($(`mark[data-node="${id}"].queued.ready`, mainText()), 'The mark shows the answer is ready');
    eq(txt($('#counts')), '0 open · 1 queued · 0 resolved', 'The map counts');
    ok(!$('#next').hidden, '"Next open question" is offered');
    has(txt($('#next')), 'Next open question →', 'The button');
    await click($('#next'), '"Next open question"');
    await until(() => pane(id), 'the queued thread to open');
    eq(node(id).status, 'open', 'The turn');
    has(txt(answerText(id)), SIDE_REPLY, 'Its answer');
    ok($('#next').hidden, 'Nothing else is waiting');
  });

  test('Passages', '"Later" with a typed question queues that question', async () => {
    await given('main');
    await click(sentence(mainText(), 'It would then give'), 'a sentence');
    await menu();
    const before = ids();
    type($('#pop-q'), 'Which sentences?');
    await click($('#pop button.later'), '"Later"');
    const id = await fresh(before);
    same([node(id).q, node(id).status], ['Which sentences?', 'queued'], 'The turn');
    eq($(`mark[data-node="${id}"]`, mainText()).title, 'Queued: Which sentences?', 'The tooltip on the passage');
    await answered(id);
  });

  test('Passages', 'the menu closes on a click elsewhere and on Escape; Enter asks', async () => {
    await given('main');
    const s = () => sentence(mainText(), 'It would then give');
    await click(s(), 'a sentence');
    await menu();
    ok(win.CSS.highlights.has('pending'), 'The passage is highlighted while the menu is open');
    await click($('.brand'), 'somewhere else');
    ok(!pop() && !win.CSS.highlights.has('pending'), 'A click elsewhere closes the menu');
    await click(s(), 'a sentence');
    await menu();
    key($('#pop-q'), 'Escape');
    ok(!pop(), 'Escape closes the menu');
    eq(ids().size, 1, 'Turns');
    eq(calls().length, 0, 'Requests to Claude');
    await click(s(), 'a sentence');
    await menu();
    ok(doc.activeElement === $('#pop-q'), 'The cursor is in the question box');
    const before = ids();
    key($('#pop-q'), 'Enter');
    const id = await fresh(before);
    eq(node(id).q, 'Explain further', 'Enter with the box empty');
    await answered(id);
  });

  test('Passages', 'closing a thread keeps it on the passage; a click there reopens it; a new question continues it', async () => {
    await given('passage');
    const id = lastStart();
    await click($('header .acts .icon', pane(id)), 'the close button');
    await until(() => !pane(id), 'the thread to close');
    eq(cols().length, 1, 'Columns');
    const m = $(`mark[data-node="${id}"]`, mainText());
    ok(m.classList.contains('open') && !m.classList.contains('active'), 'The passage stays marked, no longer as on screen');
    await click(m, 'the marked passage');
    await until(() => pane(id), 'the thread to reopen');
    ok(!pop(), 'No menu on a passage that has a thread');
    eq(ids().size, 2, 'Turns');
    // Dragging over the same passage and typing continues that thread.
    await click($('header .acts .icon', pane(id)), 'the close button');
    await until(() => !pane(id), 'the thread to close');
    await drag(mainText, SENT);
    await menu();
    const before = ids();
    type($('#pop-q'), 'And why first?');
    key($('#pop-q'), 'Enter');
    const next = await fresh(before);
    await until(() => pane(id), 'the thread to reopen');
    same([node(next).parent, node(next).q, lastCol().start, lastCol().leaf], [id, 'And why first?', id, next], 'The new turn continues the thread');
    eq(node(next).prompt, `About this part of your answer:\n"${SENT}"\n\nAnd why first?`, 'The question sent');
    await answered(next);
    same(lastCall().turns.map(x => x.role), ['user', 'user', 'assistant', 'user', 'assistant', 'user'], 'The turns sent');
  });

  test('Passages', 'a thread inside a thread; a second thread does not see the first', async () => {
    await given('passage');
    const a = lastStart();
    await click(sentence(answerText(a), 'It would not see any other branch'), 'a sentence in the thread');
    const b = await explain();
    same([node(b).parent, cols().length], [a, 3], 'A third column');
    same(lastCall().turns.map(x => x.role), ['user', 'user', 'assistant', 'user', 'assistant', 'user'], 'The turns sent for the inner thread');
    // Only as many columns as fit are shown in full; earlier ones are strips.
    const fit = Math.max(1, Math.min(3, Math.floor(($('#panes').clientWidth - 18) / 400)));
    eq($$('#panes .pane').length, Math.min(3, fit), 'Columns shown in full');
    eq($$('#panes .spine').length, 3 - Math.min(3, fit), 'Columns shown as strips');
    if ($('#panes .spine')) {
      await click($('#panes .spine'), 'the strip of the main thread');
      await until(() => !pane(b) && pane('root'), 'the main thread to come back');
      eq(cols().length, 1, 'Columns');
    }
    // Another passage of the first answer: its thread is sent without thread a.
    await click(sentence(mainText(), 'It would then give'), 'another sentence');
    await explain();
    same(lastCall().turns.map(x => x.role), ['user', 'user', 'assistant', 'user'], 'The turns sent for a second thread');
    lacks(lastCall().turns.map(x => x.content).join('\n'), SENT + '"', 'The turns sent for a second thread');
  });

  // ----- formulas -----

  test('Formulas', '#math: every kind of formula is typeset, and what cannot be drawn stays as source', async () => {
    await load();
    await askFirst('Show me every kind #math', { raw: 2 });
    const t = mainText();
    same($$('.math.raw', t).map(h => h.getAttribute('aria-label')), ['\\frac{a}{', '\\notacommand{x}'], 'Formulas left as source');
    $$('.math.raw', t).forEach(h => eq(txt(h.shadowRoot.querySelector('code')), h.getAttribute('aria-label'), 'What a broken formula shows'));
    const drawnAs = (tex, block) => {
      const h = ok(formulaOf(t, tex), `The formula ${tex} is in the answer`);
      ok(!h.classList.contains('raw') && h.shadowRoot.querySelector('svg'), `The formula ${tex} is typeset`);
      eq(h.classList.contains('display'), block, `The formula ${tex} stands on its own line`);
    };
    drawnAs('x^2', false);
    drawnAs('a^2 + b^2 = c^2', false); // \( ... \)
    drawnAs('\\int_0^1 x \\, dx = \\tfrac{1}{2}', false); // $$ ... $$ in the middle of a sentence
    drawnAs('\\begin{aligned} (a + b)^2 &= a^2 + 2ab + b^2 \\\\ (a - b)^2 &= a^2 - 2ab + b^2 \\end{aligned}', true); // \[ ... \] over lines
    drawnAs('\\boldsymbol{\\beta}', false); // a part of MathJax fetched on demand
    drawnAs('\\cancel{x}', false); // and another
    drawnAs('\\text{損失} = 0', false);
    ok($$('.math.display', t).some(h => h.getAttribute('aria-label').startsWith('\\underbrace') && !h.classList.contains('raw')), 'The long formula is typeset');
    ok($('strong .math', t) && $('strong .math', t).getAttribute('aria-label') === 'x^2', 'A formula inside bold text');
    has(txt(t), 'it costs $5 today and $10 tomorrow, or $7 with a coupon', 'Money is left as text');
    ok($$('code', t).some(c => txt(c) === '$not_math$'), 'Code that holds dollar signs stays code');
    noSideways('An answer with a very long formula');
    const body = $('.body', pane('root'));
    ok(body.scrollWidth <= body.clientWidth + 1, `The long formula does not widen the column (${body.scrollWidth}px in ${body.clientWidth}px)`);
  });

  test('Formulas', 'clicking a formula asks about the formula', async () => {
    await given('main');
    await click(display(mainText()), 'the formula', offSymbol);
    await menu();
    eq($('#pop-q').placeholder, 'Ask about this formula…', 'The question box');
    ok(display(mainText()).classList.contains('pending'), 'The formula is highlighted while the menu is open');
    const id = await explain();
    const n = node(id);
    same(Object.keys(n.anchor).sort(), ['end', 'math', 'start', 'text'], 'The anchor of a formula');
    eq(n.anchor.text, FORMULA, 'The formula, as source');
    eq(txt(mainText()).slice(n.anchor.start, n.anchor.end), FORMULA, 'The offsets point at the formula');
    has(n.prompt, `About this formula in your answer: ${FORMULA}\n\nExplain this formula`, 'The question sent');
    const head = $('header .from', pane(id));
    ok($('.math', head) && !$('.math.raw', head), 'The heading shows the formula typeset');
    eq(txt(head), FORMULA, 'The heading has no quote marks around a formula');
    const f = display(mainText());
    ok(['marked', 'open', 'active'].every(c => f.classList.contains(c)), 'The formula is marked as open and on screen');
    eq($('.composer .msg', pane(id)).placeholder, 'Ask more about this formula…', 'The message box of the thread');
    // The map shows the formula typeset too.
    ok($('#tree .row.open .math') && !$('#tree .math.raw'), 'The row in the map');
  });

  test('Formulas', 'a typed question about a formula, and a formula inside a sentence', async () => {
    await given('main');
    const inline = () => $('li .math', mainText());
    await click(inline(), 'the formula in the list', offSymbol);
    await menu();
    const before = ids();
    type($('#pop-q'), 'Why divide by T?');
    key($('#pop-q'), 'Enter');
    const id = await fresh(before);
    const n = await answered(id);
    eq(n.anchor.text, '$p_i = \\frac{\\exp(z_i / T)}{\\sum_j \\exp(z_j / T)}$', 'The formula');
    eq(n.prompt, `About this formula in your answer: ${n.anchor.text}\n\nWhy divide by T?`, 'The question sent');
    ok(n.anchor.math === true && !n.anchor.sym, 'The anchor');
    ok(!$(`mark[data-node="${id}"]`), 'The sentence around the formula is not marked');
  });

  test('Formulas', 'hovering a symbol lights it; clicking it asks about that symbol', async () => {
    await given('main');
    const math = () => display(mainText());
    const g = await symbol(math, '\\alpha');
    eq(syms(math(), '\\alpha').length, 2, 'Places where α appears');
    same([...new Set([...math().shadowRoot.querySelectorAll('g.sym')].map(x => x.getAttribute('data-tex')))].sort(),
      ['L', 'T', '\\alpha', '\\mathrm{CE}', '\\mathrm{KL}', 'p', 'q', 'y'], 'The symbols of the formula');
    const at = await hover(g, 'the symbol α');
    ok(g.classList.contains('hot'), 'The symbol under the pointer is lit');
    mouse(at.hit, 'mouseover', at);
    await click(g, 'the symbol α');
    await menu();
    eq($('#pop-q').placeholder, 'Ask about this symbol…', 'The question box');
    ok(syms(math(), '\\alpha').every(x => x.classList.contains('pending')), 'Every α is highlighted while the menu is open');
    ok(!math().classList.contains('pending'), 'The formula as a whole is not');
    const id = await explain();
    const n = node(id);
    same(Object.keys(n.anchor).sort(), ['end', 'math', 'start', 'sym', 'text'], 'The anchor of a symbol');
    same([n.anchor.sym, n.anchor.text, n.q], ['\\alpha', FORMULA, 'Explain further'], 'The turn');
    eq(txt(mainText()).slice(n.anchor.start, n.anchor.end), FORMULA, 'The offsets point at the formula');
    has(n.prompt, `About the symbol $\\alpha$ in this formula from your answer: ${FORMULA}\n\nWhat does this symbol stand for here`, 'The question sent');
    const head = $('header .from', pane(id));
    eq(txt(head), '$\\alpha$ in ' + FORMULA, 'The heading names the symbol and its formula');
    eq($$('.math:not(.raw)', head).length, 2, 'Both are typeset in the heading');
    await until(() => syms(math(), '\\alpha').every(x => x.classList.contains('open') && x.classList.contains('active')), 'every α to be marked as open');
    ok(!math().classList.contains('marked'), 'The formula as a whole is not marked');
    eq($('.composer .msg', pane(id)).placeholder, 'Ask more about this symbol…', 'The message box of the thread');
    has(txt($('#tree .row.open')), '$\\alpha$', 'The row in the map');
  });

  test('Formulas', 'a symbol with a subscript, inside a sentence; the formula itself can still be asked about', async () => {
    await given('main');
    const math = () => $('li .math', mainText());
    await click(await symbol(math, 'p_i'), 'the symbol p_i');
    const id = await explain();
    same([node(id).anchor.sym, node(id).anchor.text], ['p_i', '$p_i = \\frac{\\exp(z_i / T)}{\\sum_j \\exp(z_j / T)}$'], 'The anchor');
    // The same formula, pointed at as a whole, is a different thread.
    await click(math(), 'the formula', offSymbol);
    const whole = await explain();
    ok(whole !== id && !node(whole).anchor.sym, 'A second thread, on the formula');
    eq(node(whole).anchor.start, node(id).anchor.start, 'Both are anchored at the formula');
    // And pointing at the symbol again opens its own thread, with no menu.
    await click(await symbol(math, 'p_i'), 'the symbol p_i');
    await until(() => pane(id), 'the symbol thread to open');
    ok(!pop(), 'No menu');
  });

  // ----- diagrams -----

  test('Diagrams', 'clicking a box asks about that box', async () => {
    await given('main');
    const part = () => figPart(mainText(), 'n:stand-in runtime');
    await click(part(), 'the box "Stand-in runtime"');
    await menu();
    eq($('#pop-q').placeholder, 'Ask about this part of the diagram…', 'The question box');
    ok(part().classList.contains('pending'), 'The box is highlighted while the menu is open');
    const id = await explain();
    const n = node(id);
    same(Object.keys(n.anchor).sort(), ['end', 'fig', 'part', 'start', 'text'], 'The anchor of a diagram part');
    same([n.anchor.fig, n.anchor.part, n.anchor.text], [0, 'n:stand-in runtime', 'Stand-in runtime'], 'The anchor');
    eq(n.anchor.start, n.anchor.end, 'A diagram takes up no text');
    has(n.prompt, 'About this part of your diagram: "Stand-in runtime"\n\nExplain this part further', 'The question sent');
    eq(txt($('header .from', pane(id))), '“Stand-in runtime”', 'The heading');
    ok(part().classList.contains('open') && part().classList.contains('active'), 'The box is marked as open');
    eq($('.composer .msg', pane(id)).placeholder, 'Ask more about this part of the diagram…', 'The message box of the thread');
  });

  test('Diagrams', 'clicking a link asks about that link; the keyboard works too', async () => {
    await given('main');
    const link = () => figPart(mainText(), 'e:question>stand-in runtime|sent to');
    await click(link(), 'the link "sent to"');
    await menu();
    const before = ids();
    type($('#pop-q'), 'Sent how?');
    key($('#pop-q'), 'Enter');
    const id = await fresh(before);
    const n = await answered(id);
    same([n.anchor.part, n.anchor.text, n.q], ['e:question>stand-in runtime|sent to', 'Question → Stand-in runtime (sent to)', 'Sent how?'], 'The turn');
    eq(n.prompt, 'About this part of your diagram: "Question → Stand-in runtime (sent to)"\n\nSent how?', 'The question sent');
    ok(link().classList.contains('open'), 'The link is marked as open');
    // Enter on a box that has the keyboard focus opens the menu.
    const box = figPart(mainText(), 'n:page');
    eq(box.getAttribute('role'), 'button', 'A box is a button for assistive technology');
    const turns = ids().size;
    key(box, 'Enter');
    eq(ids().size, turns, 'Enter on a box opens the menu and asks nothing yet');
    await menu();
    eq($('#pop-q').placeholder, 'Ask about this part of the diagram…', 'The menu from the keyboard');
    ok(box.classList.contains('pending'), 'The box is highlighted while the menu is open');
    // From there, Enter in the empty question box is "Explain further".
    key($('#pop-q'), 'Enter');
    const viaKeys = await until(() => Object.values(conv().nodes).find(x => x.anchor && x.anchor.part === 'n:page'), 'the thread on the box');
    eq(viaKeys.q, 'Explain further', 'The question asked from the keyboard');
    await answered(viaKeys.id);
  });

  test('Diagrams', '"Show this as a diagram" draws one in the thread, and its parts can be asked about', async () => {
    await given('passage');
    const id = lastStart();
    ok(chipLabels(id).includes('Show this as a diagram'), 'The chip is offered when the answer has no diagram');
    const before = ids();
    await click(chip(id, 'Show this as a diagram'), 'the chip');
    const d = await fresh(before);
    await answered(d);
    same([node(d).q, node(d).parent], ['Show this as a diagram', id], 'The turn');
    has(node(d).prompt, 'Show what you just explained as a diagram', 'The question sent');
    eq(figParts(answerText(d)).filter(p => p.classList.contains('node')).length, 3, 'Boxes in the new diagram');
    ok(!chipLabels(id).includes('Show this as a diagram'), 'The chip is gone once there is a diagram');
    await click(figPart(answerText(d), 'n:b'), 'the box "B"');
    const inner = await explain();
    same([node(inner).parent, node(inner).anchor.part], [d, 'n:b'], 'A thread on the box');
  });

  // ----- terms -----

  const gloss = term => $$('.gloss', mainText()).find(g => txt(g) === term);

  test('Terms', 'hovering a dotted term shows its definition, and lingering records it', async () => {
    await given('main');
    const at = await hover(gloss('stand-in runtime'), 'the term');
    await until(() => $('#gloss.show'), 'the definition to appear', 3000);
    eq(txt($('#gloss .t')), 'stand-in runtime', 'The term');
    eq(txt($('#gloss .d')), 'A local replacement for Claude that returns canned text, used for testing the page.', 'The definition');
    same($$('#gloss button').map(txt), ['Explain more →', 'I know this'], 'What can be done with it');
    await until(() => txt($('#terms')).includes('Looked up in this conversation'), 'the term to be recorded', 4000);
    eq(conv().looked['stand-in runtime'], 'stand-in runtime', 'What was looked up');
    mouse(at.hit, 'mouseout', at);
    await until(() => !$('#gloss.show'), 'the definition to go away', 3000);
  });

  test('Terms', '"I know this" stops the term being defined, and it can be taken back', async () => {
    await given('main');
    await click(gloss('stand-in runtime'), 'the term');
    await until(() => $('#gloss.show'), 'the definition to appear');
    await click(button($('#gloss'), 'I know this'), '"I know this"');
    await until(() => !gloss('stand-in runtime'), 'the underline to go');
    has(toastText(), '“stand-in runtime” will no longer be defined.', 'The toast');
    ok(gloss('inline code'), 'Other terms stay underlined');
    eq(store().prefs.known['stand-in runtime'], 'stand-in runtime', 'What is kept');
    has(txt($('#terms')), 'Marked known, no longer defined', 'The Terms list');
    // Claude is told, with the next question.
    const id = await sendIn('root', 'One more question');
    has(lastCall().turns[0].content, 'They already know these, so never list them: stand-in runtime.', 'The rules sent to Claude');
    await answered(id);
    await drawn();
    ok(!$$('.gloss', answerText(id)).some(g => txt(g) === 'stand-in runtime'), 'The new answer does not underline it');
    await click($$('#terms button.chip').find(b => txt(b).startsWith('stand-in runtime')), 'the term in the Terms list');
    await until(() => gloss('stand-in runtime'), 'the underline to come back');
    ok(!store().prefs.known['stand-in runtime'], 'What is kept');
  });

  test('Terms', '"Explain more" opens a thread on the term', async () => {
    await given('main');
    await click(gloss('inline code'), 'the term');
    await until(() => $('#gloss.show'), 'the definition to appear');
    const before = ids();
    await click(button($('#gloss'), 'Explain more'), '"Explain more"');
    const id = await fresh(before);
    await until(() => pane(id), 'the thread');
    const n = await answered(id);
    same([n.q, n.anchor.text], ['What does “inline code” mean here?', 'inline code'], 'The turn');
    eq(txt(mainText()).slice(n.anchor.start, n.anchor.end), 'inline code', 'The offsets');
    has(n.prompt, 'About this term in your answer: "inline code"', 'The question sent');
    ok(!$('#gloss.show'), 'The definition closes');
    eq(conv().looked['inline code'], 'inline code', 'What was looked up');
  });

  // A term is defined once and used again in the answers that follow. Those
  // answers show it dotted too, with the definition it was given.

  const glossIn = (id, term) => $$('.gloss', answerText(id)).find(g => txt(g).toLowerCase() === term);
  // Click a dotted term; what the definition box then says: [term, definition].
  async function definition(g, what) {
    const term = txt(ok(g, `${what} is dotted`)).toLowerCase();
    await click(g, what);
    await until(() => $('#gloss.show') && txt($('#gloss .t')).toLowerCase() === term, `the definition of ${what} to appear`);
    return [txt($('#gloss .t')), txt($('#gloss .d'))];
  }

  test('Terms', 'a term defined in an earlier answer stays dotted in the answers below it, three levels down', async () => {
    await given('passage');
    const a = lastStart();
    const fromFirst = 'A local replacement for Claude that returns canned text, used for testing the page.';
    lacks(node(a).raw.split('@@@')[1], 'stand-in runtime', 'The trailer of the side answer');
    same(await definition(glossIn(a, 'stand-in runtime'), '"stand-in runtime" in the side answer'), ['stand-in runtime', fromFirst], 'A term only the first answer defined');
    // A definition of its own wins over one it could borrow, in both places.
    same(await definition(glossIn(a, 'inline code'), '"inline code" in the side answer'), ['inline code', 'Code set inside a sentence, as this side answer defines it.'], 'A term the side answer defines itself');
    same(await definition(glossIn('root', 'inline code'), '"inline code" in the first answer'), ['inline code', 'A short piece of code set inside a sentence.'], 'The same term in the first answer');
    same(await definition(glossIn(a, 'passage'), '"passage" in the side answer'), ['passage', 'The sentence or phrase you pointed at.'], 'A term of its own');
    // A thread inside the thread: the third level.
    await click(sentence(answerText(a), 'It would not see any other branch'), 'a sentence in the thread');
    const b = await explain();
    eq(pathLength(b), 3, 'Levels down to the inner answer');
    same(await definition(glossIn(b, 'stand-in runtime'), '"stand-in runtime" three levels down'), ['stand-in runtime', fromFirst], 'Three levels down');
    eq(conv().looked['stand-in runtime'], 'stand-in runtime', 'What was looked up');
    // Claude is told that it need not repeat a definition, and that every answer gets the section.
    has(lastCall().turns[0].content, 'After every answer, however short, add a line containing only @@@', 'The rules sent to Claude');
    has(lastCall().turns[0].content, 'a formula, a symbol or a part of a diagram', 'The rules sent to Claude');
    has(lastCall().turns[0].content, 'so list only the terms that are new in this answer', 'The rules sent to Claude');
    // "I know this" takes the dots away everywhere, not only where it was pressed.
    await click(button($('#gloss'), 'I know this'), '"I know this"');
    await until(() => !$$('#panes .gloss').some(g => txt(g) === 'stand-in runtime'), 'the dots to go from every answer on screen');
    ok(glossIn(b, 'passage') && glossIn(a, 'inline code'), 'Other terms stay dotted');
    if ($('#panes .spine')) await click($('#panes .spine'), 'the strip of the main thread');
    await until(() => pane('root'), 'the main thread');
    ok(!glossIn('root', 'stand-in runtime') && glossIn('root', 'inline code'), 'The first answer no longer dots it either');
  });

  test('Terms', 'which definition a borrowed term gets: its own, then the answers above it, then the rest; longer terms first', async () => {
    const rootText = 'The KL of two distributions is small. Softmax comes first, then the temperature.';
    const at = s => ({ start: rootText.indexOf(s), end: rootText.indexOf(s) + s.length, text: s });
    const turn = (id, seq, anchor, text, terms) => ({
      id, seq, parent: id === 'root' ? null : 'root', anchor, q: id === 'root' ? 'What is KL?' : 'Explain further', prompt: 'Question ' + id,
      raw: text + '\n\n@@@\n' + terms.map(([t, d]) => `term: ${t} = ${d}`).join('\n'), phase: 'done', status: 'open', ready: true,
    });
    const made = {
      id: 'made', title: 'What is KL?', created: 1, updated: 2, seq: 3, tips: {}, looked: {}, teach: {},
      cols: [{ start: 'root', leaf: 'root' }, { start: 'n1', leaf: 'n1' }],
      nodes: {
        root: turn('root', 0, null, rootText, [['KL', "The first answer's KL."], ['softmax', "The first answer's softmax."]]),
        // On screen beside the first answer. It defines one term and uses four.
        n1: turn('n1', 1, at('The KL of two distributions is small.'), 'Here KL divergence matters more than plain KL does. The softmax and the temperature shape it.',
          [['temperature', "This answer's own temperature."]]),
        // Another thread, not on screen and not above n1.
        n2: turn('n2', 2, at('Softmax comes first, then the temperature.'), 'Another thread.',
          [['KL divergence', "The other thread's KL divergence."], ['softmax', "The other thread's softmax."], ['temperature', "The other thread's temperature."]]),
      },
    };
    await load({ seed: JSON.stringify({ v: 1, current: 'made', convs: { made }, prefs: {} }) });
    same($$('.gloss', answerText('n1')).map(txt), ['KL divergence', 'KL', 'softmax', 'temperature'], 'Dotted in the side answer');
    same(await definition(glossIn('n1', 'kl divergence'), '"KL divergence"'), ['KL divergence', "The other thread's KL divergence."], 'The longer term is found whole, from a thread elsewhere');
    same(await definition(glossIn('n1', 'kl'), '"KL"'), ['KL', "The first answer's KL."], 'The shorter term, where it stands alone');
    same(await definition(glossIn('n1', 'softmax'), '"softmax"'), ['softmax', "The first answer's softmax."], 'The answer above comes before a thread elsewhere');
    same(await definition(glossIn('n1', 'temperature'), '"temperature"'), ['temperature', "This answer's own temperature."], 'Its own definition comes before any other');
    // The first answer borrows too, from the answers after it, in the order they were asked.
    same($$('.gloss', mainText()).map(txt), ['KL', 'Softmax', 'temperature'], 'Dotted in the first answer');
    same(await definition(glossIn('root', 'temperature'), '"temperature" in the first answer'), ['temperature', "This answer's own temperature."], 'Borrowed from the earlier of two later answers');
    same(await definition(glossIn('root', 'softmax'), '"Softmax" in the first answer'), ['softmax', "The first answer's softmax."], 'Its own definition');
    eq(calls().length, 0, 'Requests to Claude');
  });

  // ----- carrying on -----

  test('Branches', '"Continue from here" folds what came after; a new question starts a branch; the stubs switch', async () => {
    await given('main');
    const second = await sendIn('root', 'A second question');
    await answered(second);
    await drawn();
    const tools = () => $('.turn[data-node="root"] .tools');
    await click(button(tools(), 'Continue from here'), '"Continue from here"');
    has(toastText(), 'Continuing from here.', 'The toast');
    eq(cols()[0].leaf, 'root', 'The thread now ends at the first answer');
    eq($$('.turn', pane('root')).length, 1, 'Turns shown');
    eq(txt($('.stub', tools())), '↳ A second question · 1 message', 'The folded branch');
    eq($('.composer .msg', pane('root')).placeholder, 'Continue from this point…', 'The message box');
    const third = await sendIn('root', 'A third question');
    await answered(third);
    await drawn();
    eq(node(third).parent, 'root', 'The new question branches from the first answer');
    same(lastCall().turns.map(x => x.content).slice(1), [FIRST, node('root').raw, 'A third question'], 'The turns sent leave the other branch out');
    same($$('.turn', pane('root')).map(e => e.dataset.node), ['root', third], 'Turns shown');
    eq(txt($('.stub', tools())), '↳ A second question · 1 message', 'The other branch stays as a stub');
    eq($$('#tree .row').length, 3, 'Rows in the map');
    await click($('.stub', tools()), 'the stub');
    await until(() => $(`.turn[data-node="${second}"]`, pane('root')), 'the other branch to show');
    eq(cols()[0].leaf, second, 'The thread now ends in the other branch');
    eq(txt($('.stub', tools())), '↳ A third question · 1 message', 'The stub now points the other way');
    // The map goes to either branch too.
    await click($$('#tree .row').find(r => txt(r).includes('A third question')), 'the row in the map');
    await until(() => $(`.turn[data-node="${third}"]`, pane('root')), 'the branch to show');
    ok($$('#tree .row').find(r => txt(r).includes('A third question')).classList.contains('current'), 'The row is marked as the current one');
  });

  test('Map', 'the map lists every thread and opens the one that is clicked', async () => {
    await given('passage');
    const id = lastStart();
    eq($$('#tree .row').length, 2, 'Rows');
    const row = () => $$('#tree .row')[1];
    ok(row().classList.contains('open') && row().classList.contains('inpath'), 'The thread on screen is marked');
    has(txt(row()), '“A real answer would open with the point itsel…”', 'The label');
    ok($('#next').hidden, 'Nothing is waiting while the thread is on screen');
    await click($('header .acts .icon', pane(id)), 'the close button');
    await until(() => !pane(id), 'the thread to close');
    ok(!$('#next').hidden && !row().classList.contains('inpath'), 'The closed thread is offered as the next open question');
    await click(row(), 'the row');
    await until(() => pane(id), 'the thread to open');
    await click($('header .acts .icon', pane(id)), 'the close button');
    await until(() => !pane(id), 'the thread to close');
    await click($('#next'), '"Next open question"');
    await until(() => pane(id), 'the thread to open');
  });

  test('Write-up', 'the write-up stitches every branch, and copies as Markdown', async () => {
    await given('passage');
    const id = lastStart();
    await click(sentence(mainText(), 'It would then give'), 'another sentence');
    await menu();
    const before = ids();
    await click($('#pop button.later'), '"Later"');
    await answered(await fresh(before));
    const grab = clipboard();
    await click($('#writeup'), '"Write it up"');
    const sheet = await until(() => $('#modal.show .sheet'), 'the write-up');
    await drawn();
    eq(txt($('h1', sheet)), FIRST, 'The title');
    ok(figure(sheet).shadowRoot.querySelector('svg'), 'The diagram is drawn');
    eq($$('.math', sheet).length, 2, 'Formulas');
    eq($$('.dbranch', sheet).length, 2, 'Side threads');
    lacks(txt(sheet), '@@@', 'The write-up');
    ok(!$('.gloss, mark', sheet), 'The write-up has no underlines or marks');
    const open = $$('ul.open li', sheet).map(txt);
    eq(open.length, 2, 'Listed as still open');
    eq(open[0], `Explain further “${SENT}”`, 'The first open thread');
    ok(/^Explain further “It would then give the reasoning .+…”$/.test(open[1]), 'The second open thread, with its long passage shortened: ' + open[1]);
    await click(button(sheet, 'Copy as Markdown'), '"Copy as Markdown"');
    const md = await until(() => grab.text, 'the Markdown');
    await until(() => toastText() === 'Copied.', 'the toast');
    ok(md.startsWith(`# ${FIRST}\n\nPlaceholder answer, written by the local stand-in`), 'The Markdown starts with the question and the answer');
    has(md, '```mermaid\nflowchart TD\n  n0["Question"]\n  n1["Stand-in runtime"]', 'The diagram becomes Mermaid');
    has(md, '  n0 -->|"sent to"| n1', 'A labelled link');
    lacks(md, '```graph', 'The Markdown');
    has(md, '\n' + FORMULA + '\n', 'A formula stays LaTeX');
    has(md, 'such as $p_i = \\frac{\\exp(z_i / T)}{\\sum_j \\exp(z_j / T)}$', 'A formula in a sentence stays LaTeX');
    has(md, '```\nfor step in range(3):\n    print(step)\n```', 'Code stays code');
    has(md, `> On “${SENT}”: **Explain further**\n>\n> ${SIDE_REPLY}`, 'A side thread becomes a quote');
    lacks(md, '@@@', 'The Markdown');
    lacks(md, 'term:', 'The Markdown');
    await click(button(sheet, 'Close'), '"Close"');
    ok(!$('#modal.show'), 'The write-up closes');
    ok(pane(id), 'The conversation is as it was');
    // A view that refuses the clipboard: the text is selected instead.
    clipboard(true);
    await click($('#writeup'), '"Write it up"');
    await until(() => $('#modal.show .sheet'), 'the write-up');
    await click(button($('#modal .sheet'), 'Copy as Markdown'), '"Copy as Markdown"');
    await until(() => toastText() === 'Selected. Copy it with your keyboard.', 'the toast');
    has(win.getSelection().toString(), 'Placeholder answer', 'The selection');
    key(doc.body, 'Escape');
    ok(!$('#modal.show'), 'Escape closes the write-up');
  });

  test('Write-up', 'nothing to write up before a question is asked', async () => {
    await load();
    await click($('#newconv'), '"New"');
    await until(() => $('#msg-new'), 'an empty conversation');
    await click($('#writeup'), '"Write it up"');
    eq(toastText(), 'Ask something first.', 'The toast');
    ok(!$('#modal.show'), 'No write-up opens');
  });

  // ----- reload -----

  test('Reload', 'a reload restores the conversation, the marks and the columns', async () => {
    await given('passage');
    const a = lastStart();
    // A formula thread, resolved; a symbol thread, left open on screen; a
    // queued question; and a term marked as known.
    await click(display(mainText()), 'the formula', offSymbol);
    const b = await explain();
    await click(button(pane(b), 'Got it'), '"Got it"');
    await until(() => node(b).takeaway, 'the takeaway', 20000);
    await click(await symbol(() => display(mainText()), '\\alpha'), 'the symbol α');
    const c = await explain();
    await click(sentence(mainText(), 'It can also contain'), 'a sentence');
    await menu();
    const before = ids();
    await click($('#pop button.later'), '"Later"');
    const d = await fresh(before);
    await answered(d);
    await click(gloss('inline code'), 'the term');
    await until(() => $('#gloss.show'), 'the definition');
    await click(button($('#gloss'), 'I know this'), '"I know this"');
    await until(() => !gloss('inline code'), 'the underline to go');
    const look = () => ({
      columns: $$('#panes .pane, #panes .spine').map(e => e.dataset.start || 'strip'),
      turns: $$('#panes .turn').map(e => e.dataset.node),
      a: [...$(`mark[data-node="${a}"]`, mainText()).classList].filter(x => x !== 'ready').sort(),
      formula: [...display(mainText()).classList].sort(),
      alpha: syms(display(mainText()), '\\alpha').map(g => [...g.classList].sort().join(' ')),
      d: [...$(`mark[data-node="${d}"]`, mainText()).classList].sort(),
      glosses: $$('.gloss', mainText()).map(txt),
      counts: txt($('#counts')),
      rows: $$('#tree .row').map(r => r.className + ' | ' + txt(r)),
      title: txt($('#convs .conv.on .lab')),
      terms: txt($('#terms')),
      next: txt($('#next')),
    });
    await until(() => syms(display(mainText()), '\\alpha').every(g => g.classList.contains('active') && g.querySelector('rect.bg')), 'the symbols to be marked');
    const was = look(), kept = conv();
    same(was.columns, ['root', c], 'Columns before the reload');
    eq(was.counts, '2 open · 1 queued · 1 resolved', 'The map counts before the reload');
    await reload();
    await until(() => syms(display(mainText()), '\\alpha').every(g => g.classList.contains('active') && g.querySelector('rect.bg')), 'the symbols to be marked again');
    same(look(), was, 'What is on screen after the reload');
    const now = conv();
    same(now.cols, kept.cols, 'The columns kept');
    same(Object.values(now.nodes).map(n => [n.id, n.parent, n.status, n.phase, n.anchor, n.raw.length, n.takeaway || '']),
      Object.values(kept.nodes).map(n => [n.id, n.parent, n.status, n.phase, n.anchor, n.raw.length, n.takeaway || '']), 'The turns kept');
    eq(calls().length, 0, 'Nothing is asked again');
    // And the restored page works: the resolved formula opens its thread.
    await click(display(mainText()), 'the formula', offSymbol);
    await until(() => pane(b), 'the resolved thread to open');
    has(txt($('.banner', pane(b))), 'Placeholder takeaway', 'Its takeaway');
  });

  test('Reload', 'an answer cut off by a reload says so and can be asked again', async () => {
    await load();
    await askFirst('Take your time #slow', { wait: false });
    await until(() => $('.turn[data-node="root"] .working'), 'the wait to start');
    await reload();
    same([node('root').phase, node('root').err && node('root').err.code], ['error', 'interrupted'], 'The turn after the reload');
    const ai = $('.turn[data-node="root"] .ai');
    has(txt($('.errbox', ai)), 'The page was closed before this answer was written.', 'What the reader is told');
    await click(button(ai, 'Try again'), '"Try again"');
    await until(() => $('.turn[data-node="root"] .working'), 'the answer to be asked for again');
    eq(calls().length, 1, 'Requests to Claude');
    await click(button($('.turn[data-node="root"] .working'), 'Stop'), '"Stop"');
    await answered('root');
  });

  // ----- when things go wrong -----

  test('Awkward paths', '#error: a failure part-way keeps what was written and offers "Try again"', async () => {
    await load();
    await askFirst('Break part-way #error', { wait: false });
    const n = await answered('root');
    same([n.phase, n.err.code], ['error', 'upstream_error'], 'The turn');
    const ai = () => $('.turn[data-node="root"] .ai');
    has(txt($('.errbox', ai())), 'The connection to Claude failed part-way. Try again.', 'What the reader is told');
    has(txt(mainText()), 'Placeholder answer, written by the local stand-in', 'What had been written is kept');
    ok(!$('.working', ai()) && !mainText().classList.contains('streaming'), 'Nothing is left waiting');
    ok(!$('.composer .send', pane('root')).disabled, 'Another question can be typed');
    await click(button(ai(), 'Try again'), '"Try again"');
    await until(() => $('.working', ai()), 'the answer to be asked for again');
    eq(calls().length, 2, 'Requests to Claude');
    await until(() => $('.errbox', ai()), 'the second failure', 30000);
  });

  test('Awkward paths', '#refuse: a refusal is explained and can be retried', async () => {
    await load();
    await askFirst('Do not answer #refuse', { wait: false });
    const n = await answered('root');
    same([n.phase, n.err.code, n.raw], ['error', 'refused', ''], 'The turn');
    const ai = $('.turn[data-node="root"] .ai');
    has(txt($('.errbox', ai)), 'Claude declined to answer this. Rephrase the question and try again.', 'What the reader is told');
    ok(button(ai, 'Try again') && !mainText(), '"Try again" is offered and no text is shown');
    same(chipLabels('root'), [], 'Follow-up chips');
  });

  test('Awkward paths', '#deny: when the viewer did not allow Claude, the page says so and stops offering', async () => {
    await load();
    await askFirst('Not allowed #deny', { wait: false });
    const n = await answered('root');
    same([n.phase, n.err.code], ['error', 'not_granted'], 'The turn');
    const ai = $('.turn[data-node="root"] .ai');
    has(txt($('.errbox', ai)), 'Claude was not allowed for this visit. Reload the page and choose Allow.', 'What the reader is told');
    ok(!button(ai, 'Try again'), 'No "Try again" for something a retry cannot fix');
    await until(() => txt($('#notice')).startsWith('Claude was not allowed for this visit'), 'the notice at the top');
  });

  test('Awkward paths', 'Stop on #slow, before anything is written', async () => {
    await load();
    await askFirst('Take your time #slow', { wait: false });
    const w = await until(() => $('.turn[data-node="root"] .working'), 'the wait to start');
    has(txt(w), 'Thinking…', 'While waiting');
    await click(button(w, 'Stop'), '"Stop"');
    const n = await answered('root', 4000);
    same([n.phase, n.raw], ['stopped', ''], 'The turn');
    const ai = $('.turn[data-node="root"] .ai');
    has(txt($('.fine', ai)), 'Stopped before anything was written.', 'What the reader is told');
    ok(button(ai, 'Try again'), '"Try again" is offered');
    ok(!$('.composer .send', pane('root')).disabled, 'Another question can be typed');
  });

  test('Awkward paths', 'Stop while the answer is being written keeps what there is', async () => {
    await load();
    await askFirst('Go on at length #long', { wait: false });
    await until(() => txt($('.text.streaming[data-node="root"]')).length > 150, 'some of the answer to arrive', 20000);
    await click(button($('.turn[data-node="root"] .working'), 'Stop'), '"Stop"');
    const n = await answered('root', 4000);
    eq(n.phase, 'stopped', 'The turn');
    ok(n.raw.length > 100 && n.raw.length < 1500, `What was written is kept (${n.raw.length} characters)`);
    const ai = $('.turn[data-node="root"] .ai');
    has(txt($('.fine', ai)), 'Stopped part-way.', 'What the reader is told');
    await drawn($$('.math.raw').length); // whatever was cut mid-formula stays as it is
    // What is there can be pointed at like any answer.
    await click(sentence(mainText(), 'Placeholder answer'), 'a sentence of the stopped answer');
    await menu();
  });

  test('Awkward paths', 'a question typed while an answer is being written waits its turn', async () => {
    await load();
    await askFirst('Take your time #slow', { wait: false });
    await until(() => $('.turn[data-node="root"] .working'), 'the wait to start');
    type($('.composer .msg', pane('root')), 'An impatient follow-up');
    key($('.composer .msg', pane('root')), 'Enter');
    await sleep(120);
    eq(ids().size, 1, 'Turns');
    eq($('.composer .msg', pane('root')).value, 'An impatient follow-up', 'What was typed is kept');
    await click(button($('.turn[data-node="root"] .working'), 'Stop'), '"Stop"');
    await answered('root', 4000);
  });

  // ----- Notion and conversations -----

  test('Notion', 'with "Look in my Notion" ticked, the stand-in searches, reads a page, and the sources are shown', async () => {
    await given('main');
    const cb = () => $('.composer .toggle input', pane('root'));
    ok(cb(), 'The "Look in my Notion" box is offered');
    await click(cb(), 'the "Look in my Notion" box');
    ok(cb().checked && store().prefs.notion === true, 'The choice is kept');
    const id = await sendIn('root', 'Find the roadmap in my notion');
    await until(() => $(`.turn[data-node="${id}"] .sources`), 'the search to show while it runs', 10000);
    const n = await answered(id);
    await drawn();
    ok(n.notion && lastCall().tools, 'The question was sent with the Notion tools');
    const box = $(`.turn[data-node="${id}"] .sources`);
    has(txt(box), 'Searched “Find the roadmap in”, 2 found', 'The search');
    const link = $('a.src', box);
    same([txt(link), link.href, link.target], ['Placeholder page 1', 'https://www.notion.so/placeholder-1', '_blank'], 'The page that was read');
    has(txt(answerText(id)), 'From Notion the stand-in read: “Placeholder page 1 about Find the roadmap in”', 'The answer');
    same(n.sources.map(s => [s.kind, s.state]), [['search', 'done'], ['page', 'done']], 'The sources kept with the answer');
    // The page handed to Claude says what it is called and where it is, so the answer can link to it.
    const cited = $('a', answerText(id));
    same([txt(cited), cited.href, cited.target], ['Placeholder page 1', 'https://www.notion.so/placeholder-1', '_blank'], 'The page named in the answer, as a link');
    has(lastCall().turns[0].content, '- Say where each point comes from.', 'Claude is asked to name its sources');
  });

  test('Notion', 'a long page is read in parts, and the source says so when some were left unread', async () => {
    await given('main');
    await click($('.composer .toggle input', pane('root')), 'the "Look in my Notion" box');
    const page = id => $(`.turn[data-node="${id}"] .sources a.src`);

    const all = await sendIn('root', 'Read the handover in my notion #parts');
    let n = await answered(all);
    await drawn();
    const whole = n.sources[1];
    ok(whole.of > 1 && whole.parts.length === whole.of, `Every part was read (${JSON.stringify(whole.parts)} of ${whole.of})`);
    has(txt(answerText(all)), `(${whole.of} of ${whole.of} parts, `, 'The answer');
    eq(txt(page(all)), 'Placeholder long page', 'The source, with every part read');
    eq($$(`.turn[data-node="${all}"] .sources .src`).length, 2, 'One search and one page, however many parts');

    const some = await sendIn(all, 'Only the start of it in my notion #skim');
    n = await answered(some);
    await drawn();
    same(n.sources[1].parts, [1], 'The parts read');
    eq(txt(page(some)), `Placeholder long page (part 1 of ${whole.of})`, 'The source, with parts left unread');

    const next = await sendIn(some, 'And what follows from that?');
    await answered(next);
    const sent = lastCall().turns.map(x => x.content).join('\n');
    has(sent, `[This page is long and comes in ${whole.of} parts. All of them were read for this answer`, 'What the next question carries of the first page');
    has(sent, `Only part 1 of ${whole.of} was read for this answer`, 'What it carries of the second');
    has(sent, 'part 1: Placeholder long page; Section 1: 定常作業 1', 'The list of what each part holds');
  });

  test('Notion', 'a question asked by pointing looks in Notion only in a thread that has read a page there', async () => {
    await given('main');
    await click($('.composer .toggle input', pane('root')), 'the "Look in my Notion" box');

    await click(sentence(mainText(), 'A real answer would open'), 'a sentence of an answer that read nothing');
    const plain = await explain();
    ok(!node(plain).notion && !lastCall().tools, 'Pointing at an answer that read nothing in Notion asks without the Notion tools');

    const read = await sendIn('root', 'Find the roadmap in my notion');
    await answered(read);
    await drawn();
    await click(sentence(answerText(read), 'From Notion the stand-in read'), 'a sentence of the answer that read a page');
    const side = await explain();
    ok(node(side).notion && lastCall().tools, 'Pointing at an answer that read a page asks with the Notion tools');
    const sent = lastCall().turns.map(x => x.content).join('\n');
    has(sent, '[For this question this page of my Notion was read and shown to you.', 'The pointed question is told what was read');
    has(sent, 'read it again with notion_fetch.]\n--- 1. “Placeholder page 1” (https://www.notion.so/placeholder-1): read whole\n# Placeholder page 1', 'It is told it may read again, and gets the page');
    eq($$(`.turn[data-node="${side}"] .sources a.src`).length, 1, 'The page the side thread read itself is shown under its answer');
  });

  // ----- The web -----

  const lookBox = (what, start) => $(`.composer .toggle input[data-pref="${what}"]`, pane(start || 'root'));
  const sourceRows = id => $$(`.turn[data-node="${id}"] .sources`);

  test('Web', 'with "Search the web" ticked, the stand-in searches, reads a page, and the sources are shown', async () => {
    await given('main');
    ok(lookBox('web'), 'The "Search the web" box is offered');
    await click(lookBox('web'), 'the "Search the web" box');
    ok(lookBox('web').checked && store().prefs.web === true && !lookBox('notion').checked && !store().prefs.notion, 'The choice is kept, and the Notion box is left alone');
    const id = await sendIn('root', 'What is new in distillation #web');
    await until(() => sourceRows(id).length, 'the search to show while it runs', 10000);
    const n = await answered(id);
    await drawn();
    ok(n.web && !n.notion && lastCall().tools, 'The question was sent with the web tools');
    same(sourceRows(id).map(r => txt($('.k', r))), ['Web'], 'One row of sources, for the web');
    has(txt(sourceRows(id)[0]), 'Searched “What is new in”, 3 found', 'The search');
    const link = $('a.src', sourceRows(id)[0]);
    same([txt(link), link.href, link.target], ['Placeholder web page 1', 'https://example.org/placeholder-1', '_blank'], 'The page that was read');
    has(txt(answerText(id)), 'From the web the stand-in read: “Placeholder web page 1”', 'The answer');
    same(n.sources.map(s => [s.kind, s.from, s.state]), [['search', 'web', 'done'], ['page', 'web', 'done']], 'The sources kept with the answer');
    ok($$('a', answerText(id)).some(a => a.href === 'https://example.org/placeholder-1' && txt(a) === 'Placeholder web page 1'), 'The page named in the answer, as a link');
    const told = lastCall().turns[0].content;
    has(told, '- You can search the web with web_search', 'Claude is told it may search');
    has(told, '- Say where each point from the web comes from.', 'and asked to name its sources');
    ok(!told.includes('Notion'), 'and told nothing about Notion');

    const next = await sendIn(id, 'And what follows from that?');
    await answered(next);
    const sent = lastCall().turns.map(x => x.content).join('\n');
    has(sent, '[For this question this web page was read and shown to you.', 'The next question is told what was read');
    has(sent, '--- 1. “Placeholder web page 1” (https://example.org/placeholder-1): read whole\n# Placeholder web page 1', 'and gets the page');
    has(sent, '--- Search for “What is new in”:\n[Placeholder web page 1 about What is new in](https://example.org/placeholder-1)', 'and what the search found, by name and address');
  });

  test('Web', 'Notion and the web together have a row of sources each, and a long web page is read in parts', async () => {
    await given('main');
    await click(lookBox('notion'), 'the "Look in my Notion" box');
    await click(lookBox('web'), 'the "Search the web" box');
    ok(lookBox('notion').checked && lookBox('web').checked, 'Both boxes are ticked');
    const id = await sendIn('root', 'Compare my notion notes with the #web');
    const n = await answered(id);
    await drawn();
    ok(n.web && n.notion, 'The question may look in both');
    same(sourceRows(id).map(r => [txt($('.k', r)), $$('.src', r).length]), [['Notion', 2], ['Web', 2]], 'A search and a page in each row');
    has(txt(answerText(id)), 'From Notion the stand-in read:', 'The answer, from Notion');
    has(txt(answerText(id)), 'From the web the stand-in read:', 'The answer, from the web');

    const long = await sendIn(id, 'Only the start of the long one #web #skim');
    const m = await answered(long);
    await drawn();
    const page = m.sources[1];
    ok(page.from === 'web' && page.of > 1, `The long web page comes in parts (${page.of})`);
    same(page.parts, [1], 'The parts read');
    eq(txt($('a.src', sourceRows(long)[0])), `Placeholder long web page (part 1 of ${page.of})`, 'The source, with parts left unread');
  });

  test('Web', 'an address in the question is read without a search, and one that nobody gave is refused', async () => {
    await given('main');
    await click(lookBox('web'), 'the "Search the web" box');
    const typed = await sendIn('root', 'Read https://example.org/placeholder-2 for me');
    let n = await answered(typed);
    await drawn();
    same(n.sources.map(s => [s.kind, s.from, s.state, s.url]), [['page', 'web', 'done', 'https://example.org/placeholder-2']], 'The page was read, with no search');

    const forged = await sendIn(typed, 'Now carry it elsewhere #web #forged');
    n = await answered(forged);
    await drawn();
    has(txt(answerText(forged)), 'This address was not given by the person, by a search result or by a page you read, so it is not read.', 'Claude is told why');
    ok(!n.sources, 'Nothing was fetched, and no source is shown');
    eq(sourceRows(forged).length, 0, 'No row of sources');
  });

  test('Web', 'a question asked by pointing uses the web only in a thread that has used it', async () => {
    await given('main');
    await click(lookBox('web'), 'the "Search the web" box');

    await click(sentence(mainText(), 'A real answer would open'), 'a sentence of an answer that used nothing');
    const plain = await explain();
    ok(!node(plain).web && !lastCall().tools, 'Pointing at an answer that did not use the web asks without the web tools');

    const read = await sendIn('root', 'Find the latest #web');
    await answered(read);
    await drawn();
    await click(sentence(answerText(read), 'From the web the stand-in read'), 'a sentence of the answer that read a web page');
    const side = await explain();
    ok(node(side).web && !node(side).notion && lastCall().tools, 'Pointing at an answer that read a web page asks with the web tools');
    has(lastCall().turns.map(x => x.content).join('\n'), 'read it again with web_fetch.]\n--- 1. “Placeholder web page 1” (https://example.org/placeholder-1): read whole', 'It is told it may read again, and gets the page');
  });

  test('Web', 'a connector the viewer has not added is not offered, and the message box says how to add it', async () => {
    await given('main', { query: 'missing=web' });
    const off = what => $(`.composer .toggle.off[data-missing="${what}"]`, pane('root'));
    ok(lookBox('notion') && !lookBox('web'), 'Notion is offered, the web is not');
    eq(txt(off('web')), 'Search the webnot connected', 'In its place: what it is, and that it is not connected');
    await click(off('web'), '"Search the web", not connected');
    has(toastText(), 'add the Parallel Search connector in Claude\'s settings', 'Pressing it says what to add');

    await given('main', { query: 'missing=notion,web' });
    ok(!lookBox('notion') && !lookBox('web') && off('notion') && off('web'), 'With neither connector, neither box');
    const id = await sendIn('root', 'A question all the same #web');
    const n = await answered(id);
    ok(!n.web && !n.notion && !lastCall().tools && !n.sources, 'A question is answered without them');

    await given('main');
    ok(lookBox('notion') && lookBox('web') && !off('notion') && !off('web'), 'With both connectors, both boxes and no notice');
  });

  test('Web', 'a connector that turns out to be missing when called is reported once, and then no longer offered', async () => {
    await given('main', { query: 'gone=web' });
    await click(lookBox('web'), 'the "Search the web" box');
    const first = await sendIn('root', 'What is new #web');
    let n = await answered(first);
    await drawn();
    ok(n.web && lastCall().tools, 'The first question was sent with the web tools');
    has(txt(answerText(first)), 'Web search is not connected for this person. Tell them to add the Parallel Search connector', 'Claude is told, so that it can say so');
    has(txt(sourceRows(first)[0]), 'failed: Web search is not connected', 'The search shows as failed');
    await until(() => !lookBox('web') && $('.composer .toggle.off[data-missing="web"]', pane('root')), 'the box to give way to the notice');
    const second = await sendIn(first, 'And again #web');
    n = await answered(second);
    ok(!n.web && !lastCall().tools, 'The next question is asked without them');
  });

  test('Conversations', 'new, switch and delete', async () => {
    await load();
    await askFirst('A first topic');
    const rows = () => $$('#convs .conv');
    same(rows().map(r => txt($('.lab', r))), ['A first topic', 'How does knowledge distillation work?'], 'The list, newest first');
    await click($('.open', rows()[1]), 'the example in the list');
    await until(() => store().current === 'example' && txt($('.bubble')).includes('knowledge distillation'), 'the example to open');
    await drawn();
    await click($('.del', rows()[0]), 'the delete button');
    has(txt(rows()[0]), 'Delete this conversation?', 'The row asks first');
    await click(button(rows()[0], 'Keep'), '"Keep"');
    eq(rows().length, 2, 'Conversations');
    await click($('.del', rows()[0]), 'the delete button');
    await click(button(rows()[0], 'Delete'), '"Delete"');
    await until(() => rows().length === 1, 'the conversation to go');
    same(Object.keys(store().convs), ['example'], 'What is kept');
  });

  // ----- the width of the window -----

  const topOf = e => e.getBoundingClientRect().top;
  const widthOf = e => e.getBoundingClientRect().width;
  const near = (got, want, what) => ok(Math.abs(got - want) <= 2, `${what}: expected about ${Math.round(want)}px, got ${Math.round(got)}px`);

  test('Width', 'one thread fills the window; a line of text stops at 800px, a diagram may be wider', async () => {
    await given('main');
    const room = $('#panes').clientWidth;
    ok(room > 1000, `The test needs a wide window (${room}px for the threads)`);
    near(widthOf(pane('root')), room - 32, 'The thread');
    const line = widthOf($('p', mainText()));
    ok(line <= 800 && line > 760, `A line of text is about 800px (${Math.round(line)}px)`);
    ok(widthOf(figure(mainText())) > line + 100, `The diagram has more room than the text (${Math.round(widthOf(figure(mainText())))}px)`);
    ok(widthOf(display(mainText())) > line + 100, 'So has a formula on a line of its own');
    const box = $('.composer .msg', pane('root')).getBoundingClientRect(), text = $('p', mainText()).getBoundingClientRect();
    ok(box.left >= text.left - 12 && box.right <= text.right + 12, 'The message box lines up with the text');
    const body = $('.body', pane('root'));
    ok(body.scrollWidth <= body.clientWidth + 1, 'Nothing makes the thread scroll sideways');
    // Two threads share the width.
    await click(sentence(mainText(), 'A real answer would open'), 'a sentence');
    const id = await explain();
    near(widthOf(pane('root')), widthOf(pane(id)), 'The two threads');
    near(widthOf(pane('root')) + widthOf(pane(id)), room - 32 - 14, 'The two threads together');
    noSideways('With two threads');
  });

  test('Width', 'the sentence asked about stays at the same height when its thread opens and closes', async () => {
    await load();
    await askFirst('Tell me more #long');
    const body = () => $('.body', pane('root'));
    // A sentence low in the view, with a good deal of text above it to wrap
    // again. Nothing is scrolled to get to it: a scroll closes the menu, and
    // a page that is not on screen hears of its scrolls late.
    const low = $$('.sent', mainText()).filter(e => topOf(e) - topOf(body()) < body().clientHeight - 120).pop();
    ok(low && topOf(low) - topOf(body()) > 250, 'There is a sentence well down the first view');
    const starts = txt(low).slice(0, 30);
    const s = () => sentence(mainText(), starts);
    await click(s(), 'a sentence well down the answer');
    await menu();
    const at = topOf(s()) - topOf(body()), wide = widthOf(mainText());
    const id = await explain();
    const mark = () => $(`mark[data-node="${id}"]`, mainText());
    ok(widthOf(mainText()) < wide - 100, `The answer is narrower with a thread beside it (${Math.round(widthOf(mainText()))}px, from ${Math.round(wide)}px)`);
    near(topOf(mark()) - topOf(body()), at, 'Where the sentence is, with its thread open');
    await click($('header button[aria-label="Close this thread"]', pane(id)), 'the × of the thread');
    await until(() => !pane(id), 'the thread to close');
    near(widthOf(mainText()), wide, 'The answer is as wide as before');
    near(topOf(mark()) - topOf(body()), at, 'Where the sentence is, with its thread closed');
    // "Got it" closes the thread too.
    await click(mark(), 'the sentence');
    await until(() => pane(id), 'the thread to open again');
    near(topOf(mark()) - topOf(body()), at, 'Where the sentence is, with its thread open again');
    await click(button(pane(id), 'Got it'), '"Got it"');
    await until(() => !pane(id), 'the thread to fold away');
    near(topOf(mark()) - topOf(body()), at, 'Where the sentence is, with its thread resolved');
  });

  test('Width', 'the paragraph at the top of the view stays there when the window changes width', async () => {
    await load();
    await askFirst('Tell me more #long');
    const body = () => $('.body', pane('root'));
    // The last paragraph that the thread can be scrolled to the top of.
    const room = body().scrollHeight - body().clientHeight;
    const k = $$('p', mainText()).map(e => topOf(e) - topOf(body()) - 10 <= room).lastIndexOf(true);
    ok(k > 1, `The answer is long enough to scroll (paragraph ${k})`);
    const para = () => $$('p', mainText())[k];
    body().scrollTop += topOf(para()) - topOf(body()) - 10;
    // The page notes where a thread is when it hears of a scroll. A page that
    // is not on screen hears of it late, so tell it here as well.
    body().dispatchEvent(new win.Event('scroll'));
    await calm();
    near(topOf(para()) - topOf(body()), 10, 'Where the paragraph is to begin with');
    const wide = widthOf(mainText()), old = para();
    frame.style.width = '1000px';
    win.dispatchEvent(new win.Event('resize')); // as for the scroll above
    // The text wraps again at once; the page puts the place back a moment
    // later, when it draws the threads again.
    await until(() => !old.isConnected && widthOf(mainText()) < wide - 50, 'the page to draw the thread again at the new width');
    near(topOf(para()) - topOf(body()), 10, 'Where the paragraph is in the narrower window');
  });

  // ----- a phone -----

  test('Phone', '375px wide: nothing makes the page scroll sideways', async () => {
    await load({ width: 375, height: 720 });
    eq(win.innerWidth, 375, 'The width of the window');
    noSideways('The example');
    // The rail is a drawer.
    ok($('.side').getBoundingClientRect().right <= 0, 'The rail is off screen');
    await click($('#menu'), 'the menu button');
    await until(() => $('.side').getBoundingClientRect().left >= 0, 'the drawer to slide in');
    noSideways('With the drawer open');
    await click($('#newconv'), '"New"');
    const box = await until(() => $('#msg-new'), 'an empty conversation');
    ok(!doc.body.classList.contains('side-open'), 'The drawer closes');
    type(box, 'Everything at once #math #long');
    await click($('.composer .send', pane('new')), '"Send"');
    await answered('root');
    await drawn(2);
    noSideways('A long answer with wide formulas');
    const body = $('.body', pane('root'));
    ok(body.scrollWidth <= body.clientWidth + 1, `Nothing in the answer is wider than the column (${body.scrollWidth}px in ${body.clientWidth}px)`);
    ok(pane('root').getBoundingClientRect().right <= 375, 'The column fits the window');
    // Asking about a sentence: the menu fits, and the thread takes the screen.
    await click(sentence(mainText(), 'A real answer would open'), 'a sentence');
    const m = (await menu()).getBoundingClientRect();
    ok(m.left >= 0 && m.right <= 375, `The menu fits the window (${Math.round(m.left)} to ${Math.round(m.right)})`);
    const id = await explain();
    noSideways('With a thread open');
    eq($$('#panes .pane').length, 1, 'Columns shown in full');
    ok($('#panes .spine') && pane(id), 'The main thread becomes a strip beside the new one');
    ok(pane(id).getBoundingClientRect().right <= 375, 'The thread fits the window');
    // A formula thread, whose heading holds the formula.
    await click($('#panes .spine'), 'the strip');
    await until(() => pane('root'), 'the main thread');
    await click(display(mainText()), 'the formula', offSymbol);
    await explain();
    noSideways('With a formula thread open');
    await click($('#writeup'), '"Write it up"');
    await until(() => $('#modal.show .sheet'), 'the write-up');
    await drawn(2);
    noSideways('The write-up');
    ok($('#modal .sheet').getBoundingClientRect().right <= 375, 'The write-up fits the window');
    ok($('#modal').scrollWidth <= $('#modal').clientWidth + 1, 'The write-up does not scroll sideways');
  });

  // ----- every action, in every kind of thread -----
  // A bug shipped because "Check" was only ever tried in the main thread.
  // Each action that every thread offers is run here in each kind of thread.

  const ACTIONS = {
    send: {
      label: 'Typed message',
      run: async kind => {
        await given(kind);
        const id = lastStart(), leaf = lastCol().leaf;
        eq($('.composer .msg', pane(id)).placeholder, KINDS[kind].box, 'The message box');
        const q = 'And what comes after that?';
        const next = await sendIn(id, q);
        same([node(next).parent, node(next).q, node(next).prompt, node(next).anchor], [leaf, q, q, null], 'The new turn');
        ok($(`.turn[data-node="${next}"]`, pane(id)), 'The new turn is in the thread it was typed in');
        eq($('.composer .msg', pane(id)).value, '', 'The message box is cleared');
        const n = await answered(next);
        await drawn();
        eq(n.phase, 'done', 'The turn');
        has(txt(answerText(next)), `You asked: “${q}”.`, 'The answer');
        same([lastCol().start, lastCol().leaf, cols().length], [id, next, kind === 'main' ? 1 : 2], 'The columns');
        eq(lastCall().prompt, q, 'The question sent');
        eq(lastCall().turns.length, kind === 'main' ? 4 : 6, 'The turns sent');
        if (kind !== 'main') ok(KINDS[kind].mark(id).classList.contains('active'), 'The thread stays attached to what was pointed at');
      },
    },
    chips: {
      label: 'Follow-up chips',
      run: async kind => {
        await given(kind);
        const id = lastStart();
        if (kind === 'main') {
          same(chipLabels(id), NEXT, 'The chips');
        } else {
          same(chipLabels(id), ['Show me an example', 'Say it more simply', 'Why is this true?', 'Give me a second example', 'How does this connect to the main question?', 'Show this as a diagram'], 'The chips');
          // A one-click question about what was pointed at.
          const had = ids();
          await click(chip(id, 'Show me an example'), 'the chip "Show me an example"');
          const v = await fresh(had);
          same([node(v).q, node(v).verb, node(v).parent], ['Show me an example', 'example', id], 'The new turn');
          eq(node(v).prompt, `Still about the part I pointed at ("${KINDS[kind].about}"): Give me one concrete example of this.`, 'The question sent');
          await answered(v);
          has(txt(answerText(v)), SIDE_REPLY, 'The answer');
          ok(!chipLabels(id).includes('Show me an example'), 'A question already asked is not offered again');
        }
        // A question Claude suggested.
        const q = kind === 'main' ? NEXT[0] : 'Give me a second example';
        const leaf = lastCol().leaf, before = ids();
        await click(chip(id, q), `the chip "${q}"`);
        const next = await fresh(before);
        same([node(next).q, node(next).prompt, node(next).parent], [q, q, leaf], 'The new turn');
        ok($(`.turn[data-node="${next}"]`, pane(id)), 'The new turn is in the same thread');
        eq((await answered(next)).phase, 'done', 'The turn');
        await drawn();
      },
    },
    check: {
      label: 'Check (Explain it back)',
      run: async kind => {
        await given(kind);
        const id = lastStart(), leaf = lastCol().leaf, turns = ids().size;
        const box = () => $('.composer .msg', pane(id));
        const sendBtn = () => $('.composer .send', pane(id));
        const link = () => button($('.composer .opts', pane(id)), 'Explain it back');
        const explaining = () => $('.composer.back', pane(id));
        eq($$('.composer > *', pane(id)).length, $('.composer', pane(id)).childNodes.length, 'Nothing stray is written into the message box area');
        // The message box itself changes over, and keeps what is typed in it.
        type(box(), 'Too short');
        await click(link(), '"Explain it back"');
        await until(explaining, 'the box to change over');
        same([box().value, box().placeholder, txt(sendBtn())], ['Too short', 'In your own words…', 'Check'], 'The box for an explanation');
        has(txt($('.backbar .tag', pane(id))), 'Explaining it back', 'The tag on the box');
        has(txt($('.backbar .hint', pane(id))), kind === 'main' ? 'Write the whole idea in a few sentences.' : 'Write what this thread told you.', 'The hint');
        ok(!link() && !chipLabels(id).length, 'No question is offered while an explanation is written');
        await click(sendBtn(), '"Check"');
        has(toastText(), 'Write a sentence or two first.', 'With too little written');
        eq(calls().length, 0, 'Requests to Claude');
        // Esc goes back to asking; so does the × on the tag.
        key(box(), 'Escape');
        await until(() => !explaining(), 'the box to change back');
        same([box().value, box().placeholder, txt(sendBtn())], ['Too short', KINDS[kind].box, 'Send'], 'The box for a question');
        await click(link(), '"Explain it back"');
        await until(explaining, 'the box to change over');
        await click($('.backbar .tag button', pane(id)), 'the × on the tag');
        await until(() => !explaining() && link(), 'the box to change back');
        await click(link(), '"Explain it back"');
        await until(explaining, 'the box to change over');
        // Enter breaks the line there; it takes Ctrl or ⌘ with it to send.
        const mine = 'A regression test checks that what worked before still works.';
        type(box(), mine);
        key(box(), 'Enter');
        await sleep(200);
        same([calls().length, ids().size, box().value], [0, turns, mine], 'After Enter alone');
        const before = ids();
        key(box(), 'Enter', { ctrlKey: true });
        const next = await fresh(before, 'the explanation to become a turn');
        // It is a turn of the thread, kept like any other.
        same([node(next).parent, node(next).q, node(next).back, node(next).anchor], [leaf, mine, true, null], 'The new turn');
        has(node(next).prompt, kind === 'main' ? 'I will now explain this whole conversation back in my own words'
          : `I will now explain the side thread about "${KINDS[kind].about}" back in my own words`, 'The request names what is explained');
        has(node(next).prompt, 'My explanation:\n' + mine, 'The request carries the explanation');
        const t = ok($(`.turn[data-node="${next}"]`, pane(id)), 'The explanation is in the thread it was written in');
        same([txt($('.user.back .tagline', t)), txt($('.bubble', t))], ['Explained back', mine], 'How the explanation is shown');
        ok(!explaining(), 'The box is for questions again');
        eq(box().value, '', 'The message box is cleared');
        const n = await answered(next);
        await drawn();
        eq(n.phase, 'done', 'The turn');
        same($$('strong', answerText(next)).map(txt), ['Right:', 'Off or missing:', 'Check yourself:'], 'The three parts of the check');
        eq(lastCall().prompt, node(next).prompt, 'The question sent');
        eq(lastCall().turns.length, kind === 'main' ? 4 : 6, 'The turns sent');
        same([lastCol().start, lastCol().leaf], [id, next], 'The column');
        ok(chipLabels(id).includes('What did I leave out?'), 'The questions Claude suggests after the check are offered');
        ok(!chipLabels(id).includes('Show this as a diagram'), 'A check is not offered as a diagram');
        has(txt($('#tree')), 'Explained back: ' + mine.slice(0, 20), 'The map');
        // The question the check ends on can be answered: the check travels with the reply.
        const reply = await sendIn(id, 'Yes, I think I could.');
        eq(node(reply).parent, next, 'The reply follows the check');
        await answered(reply);
        eq(lastCall().turns.length, (kind === 'main' ? 4 : 6) + 2, 'The turns sent with the reply');
        has(lastCall().turns.map(x => x.content).join('\n'), '**Check yourself:**', 'The turns sent with the reply');
        // And a sentence of the check can be asked about, as in any answer.
        await drawn();
        await click(sentence(answerText(next), 'Off or missing:'), 'a sentence of the check');
        const side = await explain();
        same([node(side).parent, node(side).anchor.text.slice(0, 15)], [next, 'Off or missing:'], 'The thread on the check');
        // It is in the write-up as the reader's own words.
        await click($('#writeup'), '"Write it up"');
        const sheet = await until(() => $('#modal.show .sheet'), 'the write-up');
        ok($$('.dmine', sheet).some(e => txt(e) === mine), 'The explanation is in the write-up');
      },
    },
    gotit: {
      label: 'Got it, and Reopen',
      run: async kind => {
        await given(kind);
        if (kind === 'main') {
          ok(!$('header', pane('root')) && !button(pane('root'), 'Got it'), 'The main thread has no "Got it"');
          return 'not offered here';
        }
        const id = lastStart();
        await click(button(pane(id), 'Got it'), '"Got it"');
        await until(() => !pane(id), 'the thread to fold away');
        has(toastText(), 'Resolved.', 'The toast');
        same([node(id).status, cols().length], ['resolved', 1], 'The thread');
        const n = await until(() => node(id).takeaway && node(id), 'the one-line takeaway', 20000);
        eq(n.takeaway, 'Placeholder takeaway: the side thread settled the part you pointed at.', 'The takeaway');
        const call = lastCall();
        has(call.prompt, `what I should take away from the side thread about "${KINDS[kind].about}"`, 'The request names what the thread was about');
        eq(call.tier, 'quick', 'The takeaway is asked of the fast model');
        const mark = () => KINDS[kind].mark(id);
        await until(() => mark().classList.contains('resolved') && !mark().classList.contains('active'), 'what was pointed at to show as resolved');
        eq(txt($('#counts')), '0 open · 0 queued · 1 resolved', 'The map counts');
        await until(() => txt($('#tree .row.resolved .take')) === n.takeaway, 'the takeaway to show in the map');
        ok($('#next').hidden, 'A resolved thread is not an open question');
        // Pointing at it again opens the folded thread, with no menu.
        await click(kind === 'symbol' ? await symbol(() => display(mainText()), '\\alpha') : mark(), 'what was pointed at', KINDS[kind].accept);
        await until(() => pane(id), 'the thread to open again');
        ok(!pop(), 'No menu');
        has(txt($('.banner', pane(id))), '✓ Resolved', 'The banner');
        has(txt($('.banner', pane(id))), n.takeaway, 'The banner');
        ok(!button(pane(id), 'Got it'), 'No "Got it" on a resolved thread');
        await click(button($('.banner', pane(id)), 'Reopen'), '"Reopen"');
        await until(() => pane(id) && !$('.banner', pane(id)) && button(pane(id), 'Got it'), 'the thread to be open again');
        eq(node(id).status, 'open', 'The thread');
        ok(mark().classList.contains('open'), 'What was pointed at shows as open again');
        return null;
      },
    },
    writeup: {
      label: 'Write-up',
      run: async kind => {
        await given(kind);
        const id = lastStart();
        const grab = clipboard();
        await click($('#writeup'), '"Write it up"');
        const sheet = await until(() => $('#modal.show .sheet'), 'the write-up');
        await drawn();
        eq(txt($('h1', sheet)), FIRST, 'The title');
        has(txt(sheet), 'Placeholder answer, written by the local stand-in', 'The first answer');
        const side = $$('.dbranch', sheet);
        if (kind === 'main') {
          eq(side.length, 0, 'Side threads');
          ok(!$('ul.open', sheet), 'Nothing is listed as still open');
        } else {
          eq(side.length, 1, 'Side threads');
          const head = $('.danchor', side[0]);
          eq(txt(head), { passage: `“${SENT}”`, formula: FORMULA, symbol: '$\\alpha$ in ' + FORMULA, part: '“Question”' }[kind], 'What the thread is about');
          eq($$('.math:not(.raw)', head).length, { passage: 0, formula: 1, symbol: 2, part: 0 }[kind], 'Formulas typeset in that heading');
          eq(txt($('.dq', side[0])), 'Explain further', 'The question');
          has(txt(side[0]), SIDE_REPLY, 'The answer in the thread');
          // It sits right under the part of the answer it came from.
          const above = side[0].previousElementSibling;
          if (kind === 'passage') has(txt(above), SENT, 'What is above the thread');
          else if (kind === 'part') ok(above.classList.contains('figure'), 'The thread sits under the diagram');
          else ok($('.math.display', above), 'The thread sits under the formula');
          eq($$('ul.open li', sheet).length, 1, 'Listed as still open');
          has(txt($('ul.open li', sheet)), 'Explain further', 'Listed as still open');
        }
        await click(button(sheet, 'Copy as Markdown'), '"Copy as Markdown"');
        const md = await until(() => grab.text, 'the Markdown');
        ok(md.startsWith(`# ${FIRST}\n\n`), 'The Markdown starts with the question');
        has(md, '```mermaid\nflowchart TD', 'The diagram becomes Mermaid');
        has(md, '\n' + FORMULA + '\n', 'The formula stays LaTeX');
        lacks(md, '```graph', 'The Markdown');
        if (kind !== 'main') has(md, `> On “${KINDS[kind].about}”: **Explain further**\n>\n> ${SIDE_REPLY}`, 'The side thread in the Markdown');
        await click(button(sheet, 'Close'), '"Close"');
        ok(!$('#modal.show') && pane(id), 'The write-up closes and the thread is still there');
      },
    },
  };

  for (const kind of Object.keys(KINDS)) {
    test('Grid', `setting up: ${KINDS[kind].label.toLowerCase()}`, async () => {
      const state = JSON.parse(await fixture(kind));
      const c = state.convs[state.current];
      if (kind === 'main') { same(c.cols, [{ start: 'root', leaf: 'root' }], 'The columns'); return; }
      const n = c.nodes[c.cols[1].start];
      same([c.cols.length, n.parent, n.phase, n.status], [2, 'root', 'done', 'open'], 'The thread');
      same([!!n.anchor.math, n.anchor.sym || null, n.anchor.part || null], {
        passage: [false, null, null], formula: [true, null, null], symbol: [true, '\\alpha', null], part: [false, null, 'n:question'],
      }[kind], 'What the thread is attached to');
    });
  }
  for (const action of Object.keys(ACTIONS)) {
    for (const kind of Object.keys(KINDS)) {
      test('Grid', `${ACTIONS[action].label} in a ${KINDS[kind].label.toLowerCase()}`.replace('a main thread', 'the main thread'), () => ACTIONS[action].run(kind), { action, kind });
    }
  }

  // ---------- running and reporting ----------

  const results = window.__results = {
    done: false, page: TARGET, only: ONLY || null, total: 0, passed: 0, failed: 0, running: null, seconds: 0,
    tests: [], // { name, ok, ms, error }
    grid: {}, // "<action> / <kind>": "pass" | "fail" | "not offered here"
    // A few lines that say it all, for reading from outside the page.
    text() {
      const lines = [`${this.done ? (this.failed ? 'FAILED' : 'PASSED') : 'RUNNING'}: ${this.passed} passed, ${this.failed} failed, of ${this.total} (${this.seconds}s, ${this.page})`];
      this.tests.filter(t => !t.ok).forEach(t => lines.push(`FAIL ${t.name}\n     ${t.error}`));
      return lines.join('\n');
    },
  };

  const listEl = document.getElementById('list'), gridEl = document.getElementById('grid'), sumEl = document.getElementById('summary');
  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function drawGrid() {
    gridEl.textContent = '';
    const head = make('tr');
    head.append(make('th', '', ''), ...Object.values(KINDS).map(k => make('th', '', k.label)));
    gridEl.append(head);
    for (const [a, action] of Object.entries(ACTIONS)) {
      const tr = make('tr');
      tr.append(make('th', '', action.label));
      for (const k of Object.keys(KINDS)) {
        const v = results.grid[`${a} / ${k}`];
        tr.append(make('td', !v ? 'wait' : v === 'pass' ? 'pass' : v === 'fail' ? 'fail' : 'na', !v ? '·' : v === 'pass' ? '✓ pass' : v === 'fail' ? '✗ FAIL' : v));
      }
      gridEl.append(tr);
    }
  }

  function summarize() {
    const left = results.total - results.passed - results.failed;
    sumEl.textContent = results.done
      ? `${results.failed ? 'FAILED' : 'PASSED'}: ${results.passed} passed, ${results.failed} failed, of ${results.total}, in ${results.seconds}s`
      : `Running… ${results.passed} passed, ${results.failed} failed, ${left} to go`;
    sumEl.className = results.failed ? 'fail' : results.done ? 'pass' : '';
    document.title = (results.done ? (results.failed ? 'FAILED ' : 'PASSED ') : '… ') + `${results.passed}/${results.total} flow tests`;
  }

  async function run() {
    const mine = tests.filter(t => !ONLY || `${t.group}: ${t.title}`.toLowerCase().includes(ONLY));
    results.total = mine.length;
    const rows = mine.map(t => { const li = make('li', 'wait', `${t.group}: ${t.title}`); listEl.append(li); return li; });
    drawGrid();
    summarize();
    const t0 = performance.now();
    for (const [i, t] of mine.entries()) {
      const title = `${t.group}: ${t.title}`;
      results.running = title;
      rows[i].textContent = title + ' …';
      pageErrors = [];
      notes = [];
      const began = performance.now();
      let error = null, note = null;
      try {
        note = await t.fn();
      } catch (e) {
        error = (e && e.message) || String(e);
        if (notes.length) error += '\n' + notes.join('\n');
      }
      keepErrors();
      if (pageErrors.length) error = (error ? error + '\n' : '') + 'The page reported: ' + pageErrors.map(e => `${e.kind}: ${e.message}`).join(' | ');
      const ms = Math.round(performance.now() - began);
      results.tests.push({ name: title, ok: !error, ms, error });
      if (error) results.failed++; else results.passed++;
      if (t.cell) results.grid[`${t.cell.action} / ${t.cell.kind}`] = error ? 'fail' : note || 'pass';
      rows[i].className = error ? 'fail' : 'pass';
      rows[i].textContent = (error ? '✗ ' : '✓ ') + title + ' ';
      rows[i].append(make('small', '', `${(ms / 1000).toFixed(1)}s`));
      if (error) rows[i].append(make('pre', '', error));
      results.seconds = Math.round((performance.now() - t0) / 1000);
      drawGrid();
      summarize();
    }
    results.running = null;
    results.done = true;
    summarize();
  }

  addEventListener('error', ev => { sumEl.textContent = 'The test runner itself failed: ' + ev.message; sumEl.className = 'fail'; });
  run();
})();
