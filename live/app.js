// Human Distillation: an ordinary chat in which any message can be branched
// from, with Claude answering.
//
// The conversation is a tree of turns (a question and its answer). Every
// branch is the same kind of thing: a thread you can keep typing into.
//   - Typing extends the thread you are in.
//   - "Continue from here" on an earlier message starts a new branch there
//     and folds the later messages into a stub.
//   - Pointing at a passage starts a branch attached to that passage, shown
//     beside the message so the passage stays in view.
// A question is sent with exactly the turns that lead to it and nothing else.
// llm.js holds the prompts and the calls to Claude.

(() => {
  'use strict';

  const KEY = 'human-distillation-live-v1';
  const VERBS = LLM.VERBS;
  const HAS_HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
  const $ = (s, r = document) => r.querySelector(s);

  // el('div.a.b', { title, on: { click } }, ...children)
  function el(tag, attrs, ...kids) {
    const [name, ...cls] = tag.split('.');
    const e = document.createElement(name || 'div');
    if (cls.length) e.className = cls.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [evn, fn] of Object.entries(v)) e.addEventListener(evn, fn);
      else if (k === 'class') e.className += (e.className ? ' ' : '') + v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid);
    return e;
  }

  const words = s => s.trim().split(/\s+/).length;
  // Shorten to about n characters, without cutting a formula in half.
  function clip(s, n) {
    if (s.length <= n) return s;
    let cut = n - 1;
    for (const m of s.matchAll(MATH_RE)) {
      const a = m.index, b = a + m[0].length;
      if (a >= cut) break;
      if (b > cut) { cut = a > 0 ? a : b; break; }
    }
    return s.slice(0, cut).trimEnd() + (cut < s.length ? '…' : '');
  }
  const quote = s => '“' + clip(s, 46) + '”';
  const formulaOnly = s => /^\s*(\$\$?[^$]+\$\$?|\\\([^]+\\\)|\\\[[^]+\\\])\s*$/.test(s);

  // ---------- state ----------
  // store: every conversation kept in this browser, and the reader's settings.
  // state: the open conversation. Its nodes are the tree of turns; its cols
  // are the threads on screen, left to right. cols[0] starts at the root; each
  // later column starts at a turn attached to a passage in the column before.

  let store, state, prefs;
  const ui = { pending: null, teachOpen: {}, teachResult: {}, focus: null, focusInput: null, glossPinned: false, confirmDel: null };
  const live = {}; // answers being written: "<conversation>/<turn>" -> { ctl, sources }

  const N = id => state.nodes[id];
  const bySeq = (a, b) => a.seq - b.seq;
  const kidsOf = id => Object.values(state.nodes).filter(n => n.parent === id);
  const typedKids = id => kidsOf(id).filter(n => !n.anchor).sort(bySeq);
  const anchoredKids = id => kidsOf(id).filter(n => n.anchor).sort((a, b) => a.anchor.start - b.anchor.start);
  const busy = n => n.phase === 'pending' || n.phase === 'streaming';
  const liveKey = (conv, id) => conv.id + '/' + id;
  const offline = () => LLM.rt.state === 'none';

  function blankConv() {
    const now = Date.now();
    return {
      id: 'c' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      title: '', created: now, updated: now,
      seq: 1, cols: [], tips: {}, looked: {}, teach: {}, nodes: {},
    };
  }

  function newNode(props) {
    const seq = state.seq++;
    const n = { id: 'n' + seq, seq, anchor: null, status: 'open', ready: true, raw: '', phase: 'pending', ...props };
    state.nodes[n.id] = n;
    state.updated = Date.now();
    return n;
  }

  function pathTo(id) {
    const out = [];
    for (let n = N(id); n; n = N(n.parent)) out.unshift(n.id);
    return out;
  }

  // The turns a column shows: from its start down to its leaf.
  function colPath(col) {
    const out = [];
    for (let n = N(col.leaf); n; n = N(n.parent)) {
      out.unshift(n.id);
      if (n.id === col.start) break;
    }
    return out;
  }

  // The end of a thread: keep following the most recent typed reply.
  function tip(id) {
    for (let cur = id; ;) {
      const ks = typedKids(cur);
      if (!ks.length) return cur;
      cur = ks[ks.length - 1].id;
    }
  }

  // Where the reader last was in the thread that starts at `start`.
  function tipOf(start) {
    const t = state.tips[start];
    return t && N(t) && pathTo(t).includes(start) ? t : tip(start);
  }

  function setLeaf(ci, id) {
    state.cols[ci].leaf = id;
    state.tips[state.cols[ci].start] = id;
  }

  // Drop columns whose attachment point is no longer on screen.
  function normalize() {
    if (!N('root')) { state.cols = []; return; }
    let cols = state.cols;
    if (!cols.length || cols[0].start !== 'root' || !N(cols[0].leaf)) cols = [{ start: 'root', leaf: tipOf('root') }];
    for (let i = 1; i < cols.length; i++) {
      const c = cols[i];
      const ok = N(c.start) && N(c.leaf) && colPath(c)[0] === c.start
        && colPath(cols[i - 1]).includes(N(c.start).parent);
      if (!ok) { cols = cols.slice(0, i); break; }
    }
    state.cols = cols;
  }

  const shown = () => new Set(state.cols.flatMap(colPath));

  function label(n) {
    if (!n.parent) return clip(n.q, 90);
    if (n.anchor) return n.anchor.sym ? '$' + n.anchor.sym + '$' : n.anchor.math || formulaOnly(n.anchor.text) ? clip(n.anchor.text, 46) : quote(n.anchor.text);
    return clip(n.q, 52);
  }

  // ---------- storage ----------

  const recent = () => Object.values(store.convs).sort((a, b) => b.updated - a.updated);

  function loadStore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { s = null; }
    if (!s || s.v !== 1 || !s.convs || typeof s.convs !== 'object') s = { v: 1, current: null, convs: {}, prefs: {} };
    s.prefs = { level: 1, tier: 'default', notion: false, known: {}, ...(s.prefs || {}) };
    if (!s.prefs.known || typeof s.prefs.known !== 'object') s.prefs.known = {};
    Object.values(s.convs).forEach(c => {
      c.nodes = c.nodes || {};
      c.cols = Array.isArray(c.cols) ? c.cols : [];
      c.tips = c.tips || {};
      c.looked = c.looked || {};
      c.teach = c.teach || {};
      Object.values(c.nodes).forEach(n => {
        // An answer that was still being written when the page closed.
        if (busy(n)) {
          n.phase = n.raw ? 'stopped' : 'error';
          if (!n.raw) n.err = { code: 'interrupted' };
        }
        n.ready = true;
      });
    });
    if (!Object.keys(s.convs).length) {
      const ex = exampleConv();
      s.convs[ex.id] = ex;
      s.current = ex.id;
    }
    if (!s.convs[s.current]) s.current = Object.values(s.convs).sort((a, b) => b.updated - a.updated)[0].id;
    return s;
  }

  let saveWarned = false, saveT = null;
  function save() {
    clearTimeout(saveT);
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch (e) {
      if (!saveWarned) { saveWarned = true; toast('This browser is not saving the conversation. It will be lost when the page closes.'); }
    }
  }
  function saveSoon() { clearTimeout(saveT); saveT = setTimeout(save, 500); }

  // A worked example, so the first view shows what the page does without
  // spending anything. It is an ordinary conversation and can be continued.
  function exampleConv() {
    const c = blankConv();
    c.id = 'example';
    c.example = true;
    c.title = 'How does knowledge distillation work?';
    const root = [
      'Knowledge distillation trains a small model, the student, to imitate a large one, the teacher. Instead of learning only from the correct answers, the student learns to match the teacher\'s whole output distribution: the probability it gives to every possible answer.',
      '',
      'This works because the teacher\'s wrong answers carry information. Shown a photo of a dog, a good teacher might say 95% dog, 4.7% wolf and 0.01% car. That wolf is hundreds of times more likely than car says something about what dogs look like, and a hard label of just "dog" throws it away. Hinton called this hidden signal dark knowledge.',
      '',
      'In a confident teacher those small probabilities are so close to zero that they barely affect training. To bring them out, both models divide their logits $z_i$ by a temperature $T$ before the softmax:',
      '',
      '$$p_i = \\frac{\\exp(z_i / T)}{\\sum_j \\exp(z_j / T)}$$',
      '',
      'A higher $T$ flattens the distribution, so the differences among unlikely answers become visible.',
      '',
      'The student is trained on a weighted sum of two losses. One is the KL divergence between the softened teacher and student distributions, multiplied by $T^2$. The other is ordinary cross-entropy against the true labels:',
      '',
      '$$L = \\alpha \\, T^2 \\, \\mathrm{KL}\\left(p^{\\text{teacher}} \\,\\|\\, p^{\\text{student}}\\right) + (1 - \\alpha) \\, \\mathrm{CE}\\left(y, p^{\\text{student}}_{T=1}\\right)$$',
      '',
      'Once trained, the student runs at $T = 1$ like any other model.',
      '',
      '```graph',
      'Training example -> Teacher : shown to',
      'Training example -> Student : shown to',
      'Teacher -> Soft targets : softened by T',
      'Soft targets -> Student : KL loss',
      'True labels -> Student : cross-entropy loss',
      '```',
      '',
      LLM.SEP,
      'term: output distribution = The probabilities a model gives to each possible answer. They add up to 1.',
      'term: hard label = A training target that names only the correct class: 100% on it and 0% on everything else.',
      'term: dark knowledge = Hinton\'s name for what a model knows beyond its top answer: how it ranks the wrong ones.',
      'term: logits = The raw scores a network gives each class, before they are turned into probabilities.',
      'term: temperature = A number T that the logits are divided by. T = 1 changes nothing; a larger T evens the probabilities out.',
      'term: softmax = The function that turns raw scores into probabilities: exponentiate each score, then divide by the total.',
      'term: KL divergence = A measure of how far one probability distribution is from another. It is zero only when they match.',
      'term: cross-entropy = A loss that is small when the model puts high probability on the correct answer.',
      'next: How do I choose the temperature?',
      'next: Why not just train the small model on the labels?',
      'next: Does the student need the same architecture as the teacher?',
    ].join('\n');
    c.nodes.root = { id: 'root', seq: 0, parent: null, anchor: null, q: c.title, prompt: c.title, raw: root, phase: 'done', status: 'open', ready: true };

    const passage = 'This works because the teacher\'s wrong answers carry information.';
    const probe = el('div');
    renderBlocks(probe, LLM.parse(root).text, true);
    const at = probe.textContent.indexOf(passage);
    if (at >= 0) {
      const why = [
        'A wrong answer is not only wrong: its probability says how close it came. When the teacher gives wolf 4.7% and car 0.01%, it is telling the student that dogs and wolves share features that cars do not.',
        '',
        'A hard label carries none of that, so a student trained on labels alone has to rediscover those similarities from scratch. Matching the whole distribution hands them over directly, which is why a distilled student usually beats the same network trained on the labels.',
        '',
        LLM.SEP,
        'next: Does this still help when the teacher is wrong?',
      ].join('\n');
      c.nodes.n1 = {
        id: 'n1', seq: 1, parent: 'root', anchor: { start: at, end: at + passage.length, text: passage },
        q: VERBS.why.q, verb: 'why', prompt: LLM.passagePrompt(passage, 'why'),
        raw: why, phase: 'done', status: 'open', ready: true,
      };
      c.seq = 2;
    }
    c.cols = [{ start: 'root', leaf: 'root' }];
    return c;
  }

  // ---------- text: what Claude wrote, as page elements ----------
  // Deliberately small: paragraphs, lists, code, and a little inline markup.
  // Each sentence becomes its own element so that it can be pointed at.

  function blocks(text) {
    const out = [];
    const lines = text.replace(/\r/g, '').split('\n');
    const item = l => /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
    const fence = l => /^\s*(```|~~~)/.exec(l);
    const mopen = l => /^\s*(\$\$|\\\[)/.exec(l);
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const mo = mopen(l);
      if (mo) {
        // A formula set on its own: $$ ... $$ or \[ ... \], on one line or several.
        const close = mo[1] === '$$' ? '$$' : '\\]';
        const rows = [];
        let rest = l.trim().slice(mo[1].length), j = i, closed = false, tail = '';
        for (;;) {
          const k = rest.indexOf(close);
          if (k >= 0) { rows.push(rest.slice(0, k)); tail = rest.slice(k + close.length).trim(); closed = true; break; }
          rows.push(rest);
          if (++j >= lines.length || !lines[j].trim()) break;
          rest = lines[j];
        }
        const tex = rows.join('\n').trim();
        if (closed && tex) {
          out.push({ type: 'math', tex, closed: true });
          i = j + 1;
          // Words after the formula on the same line start the next paragraph.
          tail = tail.replace(/^[\s.,;:!?。、]+/, '');
          if (tail) lines.splice(i, 0, tail);
          continue;
        }
        if (!closed && j >= lines.length) { out.push({ type: 'math', tex, closed: false, raw: lines.slice(i).join(' ') }); break; }
        // Otherwise it was not a formula after all: read it as text.
      }
      const f = fence(l);
      if (f) {
        const lang = l.trim().slice(f[1].length).trim().toLowerCase();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(f[1])) body.push(lines[i++]);
        const closed = i < lines.length;
        i++;
        out.push({ type: lang === 'graph' ? 'graph' : 'code', text: body.join('\n'), closed });
        continue;
      }
      if (item(l)) {
        const ordered = /^\s*\d/.test(l), items = [];
        while (i < lines.length) {
          const m = item(lines[i]);
          if (m) { items.push(m[1]); i++; }
          else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && !fence(lines[i])) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
          else break;
        }
        out.push({ type: ordered ? 'ol' : 'ul', items });
        continue;
      }
      const buf = [lines[i++].trim()];
      while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !item(lines[i]) && !mopen(lines[i])) buf.push(lines[i++].trim());
      const p = buf.join(' ');
      const h = /^#{1,6}\s+(.*)$/.exec(p);
      out.push({ type: 'p', text: h ? '**' + h[1].replace(/\*\*/g, '') + '**' : p.replace(/^>\s?/, '') });
    }
    return out;
  }

  // A formula inside a line: $...$, \(...\), and $$...$$ or \[...\] when it
  // sits in the middle of a sentence. A dollar sign that is money is left
  // alone: an opening $ must touch what follows it, a closing $ must touch
  // what precedes it and may not be followed by a digit. \$ is a plain dollar.
  const MATH_SRC = String.raw`\\\$|\$\$(?<dd>[^$]+?)\$\$|\\\[(?<br>[^]+?)\\\]|\\\((?<pa>[^]+?)\\\)|(?<![\\$\w])\$(?![\s$])(?<d>(?:\\[^]|[^$\\])+?)(?<![\s\\])\$(?!\d)`;
  const MATH_RE = new RegExp(MATH_SRC, 'g');
  const ATOM_RE = new RegExp('(?<tk>`+)(?<code>[^`]+?)\\k<tk>|' + MATH_SRC, 'g');

  // Split a string into plain text, code and formulas.
  function pieces(s, re) {
    const out = [];
    let last = 0;
    for (const m of s.matchAll(re)) {
      if (m.index > last) out.push({ t: s.slice(last, m.index) });
      const g = m.groups;
      if (g.code != null) out.push({ t: g.code, kind: 'code' });
      else if (m[0] === '\\$') out.push({ t: '$' });
      else out.push({ t: m[0], kind: 'math', tex: (g.dd ?? g.br ?? g.pa ?? g.d).trim(), mode: g.dd != null || g.br != null ? 'inline-display' : 'inline' });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push({ t: s.slice(last) });
    return out;
  }

  // Inline markup -> runs of text with a style each. Code and formulas are
  // set aside first, so nothing inside them is read as markup; `within` is
  // the style around one of them (a formula inside bold text, say).
  function runs(s) {
    const held = [];
    const flat = pieces(s, ATOM_RE).map(p => (p.kind ? '' + (held.push(p) - 1) + '' : p.t)).join('');
    const out = [];
    const add = (t, kind, href) => t.split(/(\d+)/).forEach(bit => {
      if (!bit) return;
      const kept = /^(\d+)$/.exec(bit);
      if (kept) out.push({ ...held[+kept[1]], within: kind, href });
      else out.push({ t: bit, kind, href });
    });
    const re = /\*\*([^*]+?)\*\*|(?<![\w*])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(flat))) {
      if (m.index > last) add(flat.slice(last, m.index));
      if (m[1] != null) add(m[1], 'strong');
      else if (m[2] != null) add(m[2], 'em');
      else add(m[3], 'a', m[4]);
      last = re.lastIndex;
    }
    if (last < flat.length) add(flat.slice(last));
    return out;
  }

  const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;
  const ABBR = /\b(?:e\.g|i\.e|vs|cf|approx|fig|eq|dr|mr|mrs|ms|prof)\.\s*$/i;

  // [start, end) of each sentence in `plain`, without the space after it.
  function sentenceSpans(plain, locked) {
    let cuts = [];
    if (SEG) {
      for (const s of SEG.segment(plain)) cuts.push(s.index + s.segment.length);
    } else {
      const re = /[.!?。！？]+["”’)\]]*\s+/g;
      let m;
      while ((m = re.exec(plain))) cuts.push(m.index + m[0].length);
    }
    // Never cut after an abbreviation or inside code.
    cuts = cuts.filter(c => c < plain.length && !ABBR.test(plain.slice(0, c)) && !locked.some(([a, b]) => c > a && c < b));
    cuts.push(plain.length);
    const out = [];
    let from = 0;
    cuts.forEach(c => {
      const raw = plain.slice(from, c);
      const body = raw.trim();
      if (body) {
        const lead = raw.length - raw.trimStart().length;
        out.push([from + lead, from + lead + body.length]);
      }
      from = c;
    });
    return out;
  }

  function fillInline(host, src, clickable) {
    const rs = runs(src);
    let pos = 0;
    rs.forEach(r => { r.a = pos; pos += r.t.length; r.b = pos; });
    const plain = rs.map(r => r.t).join('');
    const whole = r => r.kind === 'code' || r.kind === 'math';
    const piece = (from, to) => rs.filter(r => r.b > from && r.a < to).map(r => {
      const t = plain.slice(Math.max(r.a, from), Math.min(r.b, to));
      const inner = r.kind === 'math' ? mathEl(r.t, r.tex, r.mode) : r.kind === 'code' ? el('code', {}, t) : t;
      const wrap = whole(r) ? r.within : r.kind;
      if (wrap === 'a') return el('a', { href: r.href, target: '_blank', rel: 'noopener noreferrer' }, inner);
      return wrap ? el(wrap, {}, inner) : typeof inner === 'string' ? document.createTextNode(inner) : inner;
    });
    if (!clickable) { host.append(...piece(0, plain.length)); return; }
    let at = 0;
    sentenceSpans(plain, rs.filter(whole).map(r => [r.a, r.b])).forEach(([a, b]) => {
      if (a > at) host.append(...piece(at, a));
      host.append(el('span.sent', {}, piece(a, b)));
      at = b;
    });
    if (at < plain.length) host.append(...piece(at, plain.length));
  }

  function renderBlocks(host, text, clickable, streaming) {
    let figs = 0;
    blocks(text).forEach(b => {
      if (b.type === 'graph') {
        // Drawn once the block is complete, so it does not jump about while it is written.
        host.append(!b.closed && streaming ? el('div.drawing', {}, 'Drawing a diagram…') : figure(b.text, figs++, clickable));
      } else if (b.type === 'math') {
        // An unfinished formula: wait for the rest while it is being written.
        if (b.closed) host.append(mathEl('$$' + b.tex + '$$', b.tex, 'block'));
        else host.append(streaming ? el('div.drawing', {}, 'Writing a formula…') : el('p', {}, b.raw));
      } else if (b.type === 'code') {
        host.append(el('pre', {}, el('code', {}, b.text)));
      } else if (b.type === 'p') {
        const p = el('p');
        fillInline(p, b.text, clickable);
        host.append(p);
      } else {
        host.append(el(b.type, {}, b.items.map(it => {
          const li = el('li');
          fillInline(li, it, clickable);
          return li;
        })));
      }
    });
  }

  // ---------- formulas ----------
  // Claude writes formulas in LaTeX. MathJax turns each into an SVG, drawn
  // inside a shadow root. The element itself holds the LaTeX source as text
  // that is never shown, so a formula counts as part of the answer's text:
  // it has offsets like any passage, and a quoted sentence carries it along.

  const math = { ready: false, wait: false, css: '', cache: new Map(), tries: {} };
  const MATH_CSS = `
    :host { -webkit-user-select: none; user-select: none; }
    mjx-container { margin: 0 !important; }
    rect.bg { fill: transparent; stroke: none; }
    g.sym.hot > rect.bg, g.sym.pending > rect.bg, g.sym.open > rect.bg { fill: var(--hl-on); }
    g.sym.queued > rect.bg { fill: var(--queued); stroke: var(--queued-line); stroke-width: 24; }
    g.sym.resolved > rect.bg { stroke: var(--done-line); stroke-width: 30; }
    code { font: 0.84em/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  `;

  // MathJax reads this when its script arrives, which is after this file.
  if (!window.MathJax) {
    window.MathJax = {
      startup: {
        typeset: false,
        ready() { MathJax.startup.defaultReady(); MathJax.startup.promise.then(mathReady, () => {}); },
      },
      options: { enableMenu: false, enableAssistiveMml: false },
      // Without "noundefined" an unknown command is an error, and the formula is shown as its source.
      tex: { packages: { '[-]': ['noundefined'] } },
      svg: { fontCache: 'none' },
    };
  }

  const redrawMath = sel => document.querySelectorAll(sel).forEach(drawMath);

  function mathReady() {
    try { math.css = MathJax.svgStylesheet().textContent; } catch (e) { math.css = ''; }
    math.ready = true;
    redrawMath('.math');
  }

  // The drawing of one formula, or { bad } when the LaTeX cannot be read, or
  // null while MathJax (or a part of it the formula needs) is still loading.
  function typeset(tex, mode) {
    if (!math.ready || math.wait) return null;
    const key = mode + '\n' + tex;
    if (math.cache.has(key)) return math.cache.get(key);
    let hit;
    try {
      const src = mode === 'inline-display' ? '\\displaystyle ' + tex : tex;
      const node = MathJax.tex2svg(src, { display: mode === 'block' });
      hit = node.querySelector('[data-mjx-error]') ? { bad: true } : { node, syms: 0 };
      if (hit.node) { try { hit.syms = markSyms(node, src, mode === 'block'); } catch (e) { hit.syms = 0; } }
    } catch (e) {
      math.tries[key] = (math.tries[key] || 0) + 1;
      if (e && e.retry && math.tries[key] < 4) {
        // MathJax is fetching a part this formula needs. Nothing else may be
        // typeset until it has arrived, or MathJax loses track of that part.
        math.wait = true;
        const done = () => { math.wait = false; redrawMath('.math.raw'); };
        e.retry.then(done, () => { math.cache.set(key, { bad: true }); done(); });
        return null;
      }
      hit = { bad: true };
    }
    math.cache.set(key, hit);
    return hit;
  }

  function drawMath(host) {
    const root = host.shadowRoot;
    const hit = typeset(host._tex, host._mode);
    const drawn = !!(hit && hit.node);
    host.classList.toggle('raw', !drawn);
    root.textContent = '';
    root.append(el('style', {}, MATH_CSS + math.css), drawn ? hit.node.cloneNode(true) : el('code', {}, host._tex));
    host._hit = drawn ? hit : null;
    host._hot = null;
    if (drawn && hit.syms) {
      applyMarks(host);
      if (!hit.boxed) { boxQueue.add(host); clearTimeout(boxT); boxT = setTimeout(boxSyms, 0); }
    }
  }

  // ----- the symbols inside a formula -----
  // MathJax's drawing has one <g> per node of the formula but does not say
  // what LaTeX each came from. So the formula is also converted to MathML,
  // the two trees are walked together, and each <g> that is a symbol (a name
  // such as T, with any subscript, superscript or accent it carries) is
  // tagged with LaTeX rebuilt from its MathML. Where the trees do not line
  // up, that part of the formula simply has no symbols to click.

  const SCRIPTED = new Set(['msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover']);
  const BIGOP = /^[∑∏∐∫∬∭∮⋃⋂⨁⨂⨀⋁⋀]$|^[A-Za-z]{2,}$/;
  const FN = /^(exp|log|ln|lg|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|arcsin|arccos|arctan|max|min|sup|inf|lim|det|dim|ker|deg|gcd|arg|Pr|hom)$/;
  const ACCENT = { '^': '\\hat', 'ˆ': '\\hat', '¯': '\\bar', '‾': '\\overline', '―': '\\overline', '~': '\\tilde', '˜': '\\tilde', '→': '\\vec', '⃗': '\\vec', '˙': '\\dot', '¨': '\\ddot', 'ˇ': '\\check', '˘': '\\breve' };
  const VARIANT = { normal: '\\mathrm', bold: '\\mathbf', 'bold-italic': '\\boldsymbol', 'double-struck': '\\mathbb', script: '\\mathcal', '-tex-calligraphic': '\\mathcal', fraktur: '\\mathfrak', 'sans-serif': '\\mathsf', monospace: '\\mathtt' };
  const CHAR_TEX = {};
  ('α alpha β beta γ gamma δ delta ϵ epsilon ε varepsilon ζ zeta η eta θ theta ϑ vartheta ι iota κ kappa λ lambda μ mu ν nu ξ xi π pi ϖ varpi ρ rho ϱ varrho '
    + 'σ sigma ς varsigma τ tau υ upsilon ϕ phi φ varphi χ chi ψ psi ω omega Γ Gamma Δ Delta Θ Theta Λ Lambda Ξ Xi Π Pi Σ Sigma Υ Upsilon Φ Phi Ψ Psi Ω Omega '
    + 'ℓ ell ∂ partial ∇ nabla ∞ infty ∑ sum ∏ prod ∫ int ∮ oint ⋃ bigcup ⋂ bigcap ⋅ cdot × times ± pm ≤ le ≥ ge ≠ ne ≈ approx ∼ sim ≡ equiv ∝ propto '
    + '∈ in ∉ notin ⊂ subset ⊆ subseteq ∪ cup ∩ cap → to ← gets ↦ mapsto ⇒ Rightarrow ⇔ Leftrightarrow ∀ forall ∃ exists ¬ neg ∧ land ∨ lor ′ prime ⊤ top ⊥ bot '
    + '⟨ langle ⟩ rangle ⌊ lfloor ⌋ rfloor ⌈ lceil ⌉ rceil … dots ⋯ cdots ∘ circ ⊙ odot ⊗ otimes ⊕ oplus ∥ parallel ‖ Vert ℏ hbar ∅ emptyset ⋆ star † dagger')
    .split(' ').forEach((c, i, a) => { if (i % 2 === 0) CHAR_TEX[c] = '\\' + a[i + 1]; });
  Object.assign(CHAR_TEX, { '−': '-', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '#': '\\#', '\\': '\\backslash', '\u2061': '', '\u2062': '', '\u2063': '', '\u2064': '' });

  const one = m => { while (m && /^(mrow|mstyle)$/.test(m.localName) && m.children.length === 1) m = m.children[0]; return m; };
  const okBase = b => { b = one(b); return !!b && (b.localName === 'mi' || (b.localName === 'mo' && BIGOP.test(b.textContent)) || (SCRIPTED.has(b.localName) && okBase(b.children[0]))); };
  // A plain power (T^2) is not part of the symbol's name: there the symbol is T.
  const power = m => m.localName === 'msup' && one(m.children[1]).localName === 'mn';
  const isSym = m => (m.localName === 'mi' ? /\S/.test(m.textContent.replace(/[\u2061-\u2064]/g, '')) : SCRIPTED.has(m.localName) && !power(m) && okBase(m.children[0]));
  // A script that is only letters, digits and signs belongs to its symbol;
  // one with structure of its own (x^2 inside an exponent) can be pointed into.
  const simple = m => !m.querySelector('msub, msup, msubsup, munder, mover, munderover, mfrac, msqrt, mroot, mtable') && !/^(mfrac|msqrt|mroot|mtable)$/.test(m.localName) && !SCRIPTED.has(m.localName);

  // LaTeX for a MathML node: close enough to draw again and to quote to Claude.
  function mmlTex(m) {
    const kids = [...m.children], t = m.textContent;
    const row = list => list.map(mmlTex).filter(Boolean).join(' ');
    const grp = n => '{' + mmlTex(n) + '}';
    const arg = n => { const x = mmlTex(n); return /^[A-Za-z0-9]$/.test(x) ? x : '{' + x + '}'; };
    const base = n => { const x = mmlTex(n), c = one(n); return /^(mrow|mstyle|mfrac)$/.test(c.localName) && c.children.length > 1 ? '{' + x + '}' : x; };
    switch (m.localName) {
      case 'mi': {
        if (t in CHAR_TEX) return CHAR_TEX[t];
        const v = m.getAttribute('mathvariant');
        if ([...t].length > 1) return FN.test(t) && !v ? '\\' + t : (VARIANT[v] || '\\mathrm') + '{' + t + '}';
        return VARIANT[v] && /^[A-Za-z0-9]$/.test(t) ? VARIANT[v] + '{' + t + '}' : t;
      }
      case 'mn': return t;
      case 'mo': return t in CHAR_TEX ? CHAR_TEX[t] : /^[A-Za-z]{2,}$/.test(t) ? (FN.test(t) ? '\\' + t : '\\operatorname{' + t + '}') : t;
      case 'mtext': return '\\text{' + t + '}';
      case 'mspace': case 'mphantom': case 'none': return '';
      case 'msub': case 'munder': return base(kids[0]) + '_' + arg(kids[1]);
      case 'msup': return base(kids[0]) + '^' + arg(kids[1]);
      case 'msubsup': case 'munderover': return base(kids[0]) + '_' + arg(kids[1]) + '^' + arg(kids[2]);
      case 'mover': {
        const a = kids[1].localName === 'mo' && ACCENT[kids[1].textContent];
        return a ? a + grp(kids[0]) : base(kids[0]) + '^' + arg(kids[1]);
      }
      case 'mfrac': return '\\frac' + grp(kids[0]) + grp(kids[1]);
      case 'msqrt': return '\\sqrt{' + row(kids) + '}';
      case 'mroot': return '\\sqrt[' + mmlTex(kids[1]) + ']' + grp(kids[0]);
      default: return kids.length ? row(kids) : t;
    }
  }

  // The <g> elements for the children of the node that `g` draws.
  function gKids(g) {
    const out = [];
    (function walk(e) { for (const c of e.children) { if (c.hasAttribute('data-mml-node')) out.push(c); else walk(c); } })(g);
    return out;
  }

  // Pair MathML children with drawn ones, in order, by kind. The drawing may
  // hold extras (the sign of a square root); anything else unmatched fails.
  function align(mk, gk) {
    const out = [];
    let j = 0;
    for (const m of mk) {
      const fits = g => { const k = g.getAttribute('data-mml-node'); return k === m.localName || (m.localName === 'mrow' && k === 'TeXAtom'); };
      while (j < gk.length && !fits(gk[j])) j++;
      if (j >= gk.length) return null;
      out.push(gk[j++]);
    }
    return out;
  }

  // Tag the symbols in a freshly drawn formula. Returns how many there are.
  function markSyms(node, src, display) {
    const mml = new DOMParser().parseFromString(MathJax.tex2mml(src, { display }), 'application/xml').documentElement;
    const drawing = node.querySelector('g[data-mml-node="math"]');
    if (!drawing || mml.localName !== 'math') return 0;
    // A formula that is one symbol has nothing smaller to point at.
    let top = mml;
    while (top.children.length === 1 && /^(math|mrow|mstyle)$/.test(top.localName)) top = top.children[0];
    if (isSym(top)) return 0;
    let n = 0;
    (function walk(m, g) {
      const mk = [...m.children], gk = align(mk, gKids(g));
      const sym = isSym(m);
      if (sym) { g.classList.add('sym'); g.setAttribute('data-tex', mmlTex(m)); n++; }
      if (!gk) return;
      if (sym && SCRIPTED.has(m.localName)) {
        // The base is the symbol itself, and so is a simple script.
        mk.slice(1).forEach((c, i) => { if (!simple(c)) walk(c, gk[i + 1]); });
        return;
      }
      mk.forEach((c, i) => walk(c, gk[i]));
    })(mml, drawing);
    return n;
  }

  // A clear box behind each symbol: something to hover and click that is
  // larger than the strokes of a letter, and the place a highlight shows.
  // Measured once per formula, on the first copy that is on screen, then
  // kept in the stored drawing so later copies come with their boxes.
  const boxQueue = new Set();
  let boxT = null;
  function boxSyms() {
    const hosts = [...boxQueue];
    boxQueue.clear();
    hosts.forEach(host => {
      const hit = host._hit;
      if (!hit || hit.boxed || !host.isConnected) return;
      const mine = [...host.shadowRoot.querySelectorAll('g.sym')], kept = [...hit.node.querySelectorAll('g.sym')];
      const boxes = mine.map(g => { try { return g.getBBox(); } catch (e) { return null; } });
      if (mine.length !== kept.length || boxes.some(b => !b || !b.width || !b.height)) return; // not laid out yet
      boxes.forEach((b, i) => {
        const r = svg('rect', { class: 'bg', x: Math.round(b.x - 40), y: Math.round(b.y - 60), width: Math.round(b.width + 80), height: Math.round(b.height + 120), rx: 90 });
        kept[i].insertBefore(r.cloneNode(), kept[i].firstChild);
        mine[i].insertBefore(r, mine[i].firstChild);
      });
      hit.boxed = true;
      // Other copies drawn before the boxes were known.
      document.querySelectorAll('.math').forEach(h => { if (h !== host && h._hit === hit && !h.shadowRoot.querySelector('rect.bg')) drawMath(h); });
    });
  }

  const symsOf = (host, tex) => [...host.shadowRoot.querySelectorAll('g.sym')].filter(g => g.getAttribute('data-tex') === tex);

  // Show the threads attached to symbols of this formula. host._marks is
  // kept, because the drawing is replaced whenever it is drawn again.
  function applyMarks(host) {
    (host._marks || []).forEach(mk => symsOf(host, mk.tex).forEach(g => g.classList.add(...mk.cls)));
  }

  const canPoint = host => !!host.closest('#panes .text[data-node]:not(.streaming)');

  function hotSym(host, g) {
    if (g === host._hot) return;
    if (host._hot) host._hot.classList.remove('hot');
    host._hot = g && canPoint(host) ? g : null;
    if (host._hot) host._hot.classList.add('hot');
  }

  // One formula. `src` is the LaTeX with its delimiters, as Claude wrote it.
  function mathEl(src, tex, mode) {
    const host = el(mode === 'block' ? 'div.math.display' : 'span.math', { role: 'img', 'aria-label': tex }, src);
    host._tex = tex;
    host._mode = mode;
    const root = host.attachShadow({ mode: 'open' });
    root.addEventListener('mouseover', ev => hotSym(host, ev.target.closest ? ev.target.closest('g.sym') : null));
    host.addEventListener('mouseleave', () => hotSym(host, null));
    drawMath(host);
    return host;
  }

  // Text that may hold formulas, for labels, questions and quotes.
  function rich(s) {
    s = String(s == null ? '' : s);
    if (!/[$\\]/.test(s)) return [s];
    return pieces(s, MATH_RE).map(p => (p.kind === 'math' ? mathEl(p.t, p.tex, 'inline') : p.t));
  }

  // A quoted passage, for a heading. A formula on its own needs no quote marks.
  const quoted = s => (formulaOnly(s) ? rich(s) : ['“', rich(s), '”']);

  // What a thread is attached to, for a heading: a passage, a formula, or a
  // symbol and the formula it is in.
  const anchorKids = (a, n) => (a.sym ? [rich('$' + a.sym + '$'), el('span.in', {}, ' in '), rich(clip(a.text, n))] : quoted(clip(a.text, n)));
  // The same, in words for Claude.
  const about = a => (a.sym ? `the symbol $${a.sym}$ in ${a.text}` : a.text);

  // The formulas that lie, at least partly, in [start, end) of an answer.
  function mathIn(c, start, end) {
    return [...c.querySelectorAll('.math')].filter(h => { const o = offs(c, h); return o.start < end && o.end > start; });
  }

  // The box around everything in `things` (ranges and elements) that is drawn.
  function bounds(things) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    things.forEach(x => [...x.getClientRects()].forEach(q => {
      if (!q.width && !q.height) return;
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    }));
    return l === Infinity ? things[0].getBoundingClientRect() : new DOMRect(l, t, r - l, b - t);
  }

  // ---------- diagrams ----------
  // Claude writes a diagram as a list of relations, one per line:
  //     Teacher -> Soft targets : produces
  // The page lays it out and draws it, so every box and link is an element
  // that can be pointed at. It is drawn inside a shadow root, which keeps its
  // labels out of the answer's text and so out of the passage offsets.

  const ARROW = /\s*(<-+>|-+>|--+|→|↔)\s*/;

  function parseGraph(spec) {
    const nodes = [], edges = [], ids = new Map();
    const node = raw => {
      const text = raw.trim().replace(/^["'[(]+|["'\])]+$/g, '').replace(/\s+/g, ' ');
      if (!text) return -1;
      const key = text.toLowerCase();
      if (!ids.has(key)) { ids.set(key, nodes.length); nodes.push({ label: text }); }
      return ids.get(key);
    };
    spec.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('%%') || /^(graph|flowchart|direction)\b/i.test(line)) return;
      const parts = line.split(ARROW); // [name, arrow, name, arrow, name, ...]
      if (parts.length < 3) { node(line); return; }
      let said = '';
      const m = /^(.+?)\s*:\s+(.+)$/.exec(parts[parts.length - 1]);
      if (m) { parts[parts.length - 1] = m[1]; said = m[2].trim(); }
      for (let k = 0; k + 2 < parts.length; k += 2) {
        const from = node(parts[k]), to = node(parts[k + 2]), arrow = parts[k + 1];
        if (from < 0 || to < 0 || from === to) continue;
        edges.push({ from, to, label: k + 3 === parts.length ? said : '', both: /^<|↔/.test(arrow), plain: /^-+$/.test(arrow) });
      }
    });
    return { nodes: nodes.slice(0, 16), edges: edges.filter(e => e.from < 16 && e.to < 16).slice(0, 28) };
  }

  const edgeText = (g, e) => g.nodes[e.from].label + (e.both ? ' ↔ ' : e.plain ? ' — ' : ' → ') + g.nodes[e.to].label + (e.label ? ' (' + e.label + ')' : '');
  const nodePart = n => 'n:' + n.label.toLowerCase();
  const edgePart = (g, e) => 'e:' + g.nodes[e.from].label.toLowerCase() + '>' + g.nodes[e.to].label.toLowerCase() + '|' + e.label.toLowerCase();

  const meter = document.createElement('canvas').getContext('2d');
  const UI_FONT = 'Inter, -apple-system, "Segoe UI", "Hiragino Sans", system-ui, sans-serif';
  function textW(t, font) { meter.font = font; return meter.measureText(t).width; }

  function wrapLabel(text, max) {
    const out = [];
    let cur = '';
    // Words where there are spaces; otherwise (Japanese, Chinese) a few characters at a time.
    const bits = /\s/.test(text) ? text.split(' ') : text.match(/.{1,10}/gu) || [text];
    const glue = /\s/.test(text) ? ' ' : '';
    bits.forEach(b => {
      if (cur && (cur + glue + b).length > max) { out.push(cur); cur = b; } else cur = cur ? cur + glue + b : b;
    });
    if (cur) out.push(cur);
    return out;
  }

  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) e.setAttribute(k, v);
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid);
    return e;
  }

  const FIG_CSS = `
    :host { display: block; }
    svg { display: block; max-width: 100%; height: auto; margin: 0 auto; font-family: ${UI_FONT}; }
    .node rect { fill: var(--chip); stroke: var(--line); }
    .node text { fill: var(--ink); font-size: 13px; font-weight: 500; }
    .edge .line { fill: none; stroke: var(--faint); stroke-width: 1.4; }
    .edge .tip { fill: var(--faint); }
    .edge .hit { fill: none; stroke: transparent; stroke-width: 14; }
    .edge .lab rect { fill: var(--pane); }
    .edge .lab text { fill: var(--muted); font-size: 11.5px; }
    .can .part { cursor: pointer; outline: none; }
    .can .node:hover rect, .can .node:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
    .can .edge:hover .line, .can .edge:focus-visible .line { stroke: var(--accent); stroke-width: 2; }
    .can .edge:hover .tip, .can .edge:focus-visible .tip { fill: var(--accent); }
    .can .edge:hover .lab text, .can .edge:focus-visible .lab text { fill: var(--accent); }
    .node.open rect { fill: var(--hl); stroke: var(--hl-on); }
    .node.open.active rect, .node.pending rect { fill: var(--hl-on); stroke: var(--hl-on); }
    .node.queued rect { fill: var(--queued); stroke: var(--queued-line); }
    .node.resolved rect { stroke: var(--done-line); stroke-width: 2; }
    .edge.open .line, .edge.pending .line { stroke: var(--hl-on); stroke-width: 3; }
    .edge.open .tip, .edge.pending .tip { fill: var(--hl-on); }
    .edge.queued .line { stroke: var(--queued-line); stroke-width: 2.5; }
    .edge.queued .tip { fill: var(--queued-line); }
    .edge.resolved .line { stroke: var(--done-line); stroke-width: 2; }
    .edge.resolved .tip { fill: var(--done-line); }
    ul { margin: 0; padding: 10px 12px 10px 28px; border: 1px dashed var(--faint); border-radius: 8px; font: 14px/1.5 ${UI_FONT}; color: var(--ink); }
  `;

  // One diagram. With `clickable`, each box and link opens the ask menu.
  function figure(spec, index, clickable) {
    const host = el('div.figure', { 'data-fig': String(index) });
    const root = host.attachShadow({ mode: 'open' });
    root.append(el('style', {}, FIG_CSS));
    const g = parseGraph(spec);
    if (!g.nodes.length) return host;

    if (typeof dagre === 'undefined') {
      // The layout library did not load: still show the relations, as a list.
      root.append(el('ul', {}, g.edges.length ? g.edges.map(e => el('li', {}, edgeText(g, e))) : g.nodes.map(n => el('li', {}, n.label))));
      return host;
    }

    const lay = new dagre.graphlib.Graph({ multigraph: true });
    lay.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 46, marginx: 6, marginy: 6 });
    lay.setDefaultEdgeLabel(() => ({}));
    g.nodes.forEach((n, i) => {
      n.lines = wrapLabel(n.label, 18);
      n.w = Math.ceil(Math.max(...n.lines.map(t => textW(t, '500 13px ' + UI_FONT)))) + 26;
      n.h = n.lines.length * 17 + 16;
      lay.setNode('n' + i, { width: n.w, height: n.h });
    });
    g.edges.forEach((e, i) => {
      e.lw = e.label ? Math.ceil(textW(e.label, '11.5px ' + UI_FONT)) + 10 : 0;
      lay.setEdge('n' + e.from, 'n' + e.to, { width: e.lw, height: e.label ? 18 : 0, labelpos: 'c' }, 'e' + i);
    });
    try { dagre.layout(lay); } catch (err) { root.append(el('ul', {}, g.edges.map(e => el('li', {}, edgeText(g, e))))); return host; }

    const size = lay.graph();
    const W = Math.ceil(size.width), H = Math.ceil(size.height);
    const out = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Diagram: ' + g.edges.map(e => edgeText(g, e)).join('; '), class: clickable ? 'can' : '' });
    const r1 = v => Math.round(v * 10) / 10;
    const head = (a, b) => { // an arrowhead at b, coming from a
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
      return svg('polygon', { class: 'tip', points: [[b.x, b.y], [b.x - ux * 8 - uy * 4, b.y - uy * 8 + ux * 4], [b.x - ux * 8 + uy * 4, b.y - uy * 8 - ux * 4]].map(q => r1(q[0]) + ',' + r1(q[1])).join(' ') });
    };
    const wire = (part, text) => {
      const e = svg('g', { class: 'part', 'data-part': part });
      if (clickable) {
        e.setAttribute('tabindex', '0');
        e.setAttribute('role', 'button');
        e.setAttribute('aria-label', 'Ask about ' + text);
        e.addEventListener('click', () => askPart(host, part, text, e));
        e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); askPart(host, part, text, e); } });
      }
      return e;
    };

    g.edges.forEach((e, i) => {
      const pos = lay.edge({ v: 'n' + e.from, w: 'n' + e.to, name: 'e' + i });
      const pts = pos.points;
      let d = `M${r1(pts[0].x)},${r1(pts[0].y)}`;
      for (let k = 1; k < pts.length - 1; k++) {
        const last = k === pts.length - 2, nx = last ? pts[k + 1].x : (pts[k].x + pts[k + 1].x) / 2, ny = last ? pts[k + 1].y : (pts[k].y + pts[k + 1].y) / 2;
        d += `Q${r1(pts[k].x)},${r1(pts[k].y)} ${r1(nx)},${r1(ny)}`;
      }
      if (pts.length === 2) d += `L${r1(pts[1].x)},${r1(pts[1].y)}`;
      const ge = wire(edgePart(g, e), edgeText(g, e));
      ge.classList.add('edge');
      ge.append(svg('path', { class: 'line', d }), svg('path', { class: 'hit', d }));
      if (!e.plain) ge.append(head(pts[pts.length - 2], pts[pts.length - 1]));
      if (e.both) ge.append(head(pts[1], pts[0]));
      if (e.label && pos.x != null) {
        ge.append(svg('g', { class: 'lab' },
          svg('rect', { x: r1(pos.x - e.lw / 2), y: r1(pos.y - 9), width: e.lw, height: 18, rx: 4 }),
          svg('text', { x: r1(pos.x), y: r1(pos.y + 4), 'text-anchor': 'middle' }, e.label)));
      }
      out.append(ge);
    });
    g.nodes.forEach((n, i) => {
      const pos = lay.node('n' + i);
      const gn = wire(nodePart(n), n.label);
      gn.classList.add('node');
      gn.append(svg('rect', { x: r1(pos.x - n.w / 2), y: r1(pos.y - n.h / 2), width: n.w, height: n.h, rx: 8 }));
      n.lines.forEach((t, k) => gn.append(svg('text', { x: r1(pos.x), y: r1(pos.y - (n.lines.length - 1) * 8.5 + k * 17 + 4.5), 'text-anchor': 'middle' }, t)));
      out.append(gn);
    });
    root.append(out);
    return host;
  }

  // The same relations as a Mermaid flowchart, for the Markdown export.
  function toMermaid(spec) {
    const g = parseGraph(spec), q = t => '"' + t.replace(/"/g, "'") + '"';
    return ['```mermaid', 'flowchart TD',
      ...g.nodes.map((n, i) => `  n${i}[${q(n.label)}]`),
      ...g.edges.map(e => `  n${e.from} ${e.both ? '<-->' : e.plain ? '---' : '-->'}${e.label ? '|' + q(e.label) + '|' : ''} n${e.to}`),
      '```'].join('\n');
  }

  // ---------- offsets ----------
  // A passage is stored as character offsets into an answer's text, so it
  // survives re-rendering and can be any selection, not only a whole sentence.

  function offs(container, node) {
    const r = document.createRange();
    r.selectNodeContents(container);
    r.setEndBefore(node);
    const start = r.toString().length;
    return { start, end: start + node.textContent.length };
  }

  function rangeOffsets(container, range) {
    const r = document.createRange();
    r.selectNodeContents(container);
    r.setEnd(range.startContainer, range.startOffset);
    const start = r.toString().length;
    return { start, end: start + range.toString().length };
  }

  function offsetsToRange(container, start, end) {
    const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    r.selectNodeContents(container);
    let pos = 0, n, started = false;
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length;
      if (!started && start < pos + len) { r.setStart(n, start - pos); started = true; }
      if (started && end <= pos + len) { r.setEnd(n, end - pos); break; }
      pos += len;
    }
    return r;
  }

  // Wrap the text in [start, end) with elements from make(). A formula in the
  // range cannot be wrapped (its text is not what is shown), so it is handed
  // to onMath instead and returned in place, in reading order.
  function wrapRange(container, start, end, make, onMath) {
    const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const hits = [];
    let pos = 0, n;
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length;
      const s = Math.max(start, pos), e = Math.min(end, pos + len);
      if (s < e) hits.push([n, s - pos, e - pos, n.parentElement.closest('.math')]);
      pos += len;
      if (pos >= end) break;
    }
    return hits.map(([node, s, e, host]) => {
      if (host) { if (onMath) onMath(host); return host; }
      let t = node;
      if (e < t.nodeValue.length) t.splitText(e);
      if (s > 0) t = t.splitText(s);
      const m = make();
      t.parentNode.insertBefore(m, t);
      m.append(t);
      return m;
    });
  }

  function iou(a, b) {
    const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    return inter / ((a.end - a.start) + (b.end - b.start) - inter);
  }

  const findExisting = p => anchoredKids(p.nodeId).find(n => (p.part
    ? n.anchor.part === p.part && n.anchor.fig === p.fig
    : p.sym ? n.anchor.sym === p.sym && n.anchor.start === p.start
      : !n.anchor.part && !n.anchor.sym && iou(n.anchor, p) >= 0.8));

  function setHL(name, range) { if (HAS_HL) CSS.highlights.set(name, new Highlight(range)); }
  function clearHL(name) { if (HAS_HL) CSS.highlights.delete(name); }

  // Where a term first appears in an answer, as a whole word.
  function findTerm(full, term, used) {
    const low = full.toLowerCase(), t = term.toLowerCase();
    const wordy = c => /[a-z0-9]/i.test(c || '');
    for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) {
      let end = i + t.length;
      if (wordy(t[0]) && wordy(full[i - 1])) continue;
      if (wordy(t[t.length - 1]) && wordy(full[end])) {
        if (low[end] === 's' && !wordy(full[end + 1])) end++; else continue; // a plural
      }
      if (used.some(([a, b]) => i < b && end > a)) continue;
      return [i, end];
    }
    return null;
  }

  // ---------- asking Claude ----------

  // Ask for the answer to a turn, with the turns above it as the context.
  function runNode(id) {
    const conv = state, n = conv.nodes[id];
    if (!n) return;
    const key = liveKey(conv, id);
    if (live[key]) live[key].ctl.abort();
    const ctl = new AbortController();
    const job = live[key] = { ctl, sources: [] };
    Object.assign(n, { raw: '', phase: 'pending', err: null, truncated: false, sources: null });
    const history = [];
    for (let p = conv.nodes[n.parent]; p; p = conv.nodes[p.parent]) history.unshift({ prompt: p.prompt, raw: p.raw, sources: p.sources });
    const mine = () => live[key] === job;

    LLM.ask({
      history,
      prompt: n.prompt,
      level: prefs.level,
      known: Object.keys(prefs.known),
      notion: !!n.notion,
      tier: prefs.tier,
      effort: n.verb ? 'low' : null, // one-click questions about a passage should come back quickly
      signal: ctl.signal,
      onText: raw => { if (mine()) { n.raw = raw; n.phase = 'streaming'; paint(conv, id); } },
      onTool: list => { if (mine()) { job.sources = list; paint(conv, id); } },
    }).then(res => {
      if (!mine()) return;
      Object.assign(n, { raw: res.raw, phase: 'done', truncated: res.truncated, sources: res.sources.length ? res.sources : null });
    }, e => {
      if (!mine()) return;
      const code = (e && e.code) || 'upstream_error';
      n.raw = code === 'refused' ? '' : (e && e.text) || n.raw || '';
      if (code === 'cancelled') n.phase = 'stopped';
      else { n.phase = 'error'; n.err = { code }; }
    }).finally(() => {
      if (!mine()) return;
      delete live[key];
      n.ready = true;
      conv.updated = Date.now();
      save();
      if (conv !== state) return;
      paint(conv, id);
      renderTree();
      renderTerms();
      syncComposers();
      document.querySelectorAll(`mark[data-node="${id}"]`).forEach(m => m.classList.add('ready'));
      if (n.status === 'queued' && n.phase === 'done') toast('A question you queued has its answer. It is waiting in the map.');
    });
  }

  function stop(id) {
    const job = live[liveKey(state, id)];
    if (job) job.ctl.abort();
  }

  // Redraw one answer in place while it is being written.
  function paint(conv, id) {
    if (conv !== state) return;
    const t = $(`#panes .turn[data-node="${id}"]`);
    if (!t) return;
    const ci = state.cols.findIndex(c => colPath(c).includes(id));
    if (ci < 0) return;
    const path = colPath(state.cols[ci]);
    const old = $('.ai', t), fresh = answer(N(id), ci, path, path.indexOf(id));
    const row = $(':scope > .working', old), next = $(':scope > .working', fresh);
    if (!row || !next) { old.replaceWith(fresh); return; }
    // Still being written: put the new text in and leave the row that holds
    // "Stop" where it is. A browser sends no click for a button that left the
    // page while the mouse was held down on it, so a row rebuilt with every
    // piece of text could hardly be pressed.
    [...old.children].forEach(c => { if (c !== row) c.remove(); });
    [...fresh.children].forEach(c => { if (c !== next) old.insertBefore(c, row); });
    $('span:not(.dots)', row).textContent = $('span:not(.dots)', next).textContent;
  }

  // ---------- actions ----------

  // The first question of a conversation.
  function startConv(text) {
    state.title = clip(text.replace(/\s+/g, ' '), 90);
    state.nodes.root = {
      id: 'root', seq: 0, parent: null, anchor: null, q: text, prompt: text,
      raw: '', phase: 'pending', status: 'open', ready: true, notion: wantNotion(),
    };
    state.cols = [{ start: 'root', leaf: 'root' }];
    state.updated = Date.now();
    ui.focus = { start: 'root', node: 'root' };
    ui.focusInput = 'root';
    runNode('root');
    render();
  }

  const wantNotion = () => !!(prefs.notion && LLM.rt.notion);

  // Point at a passage and ask about it: a branch attached to that passage.
  // `question` is what the reader typed, or '' for "Explain further".
  function ask(p, question, later) {
    const typed = (question || '').trim();
    let n = findExisting(p), created = false, focusId = null;
    if (!n) {
      created = true;
      // A word or two is usually a term, so the button asks what it means.
      const term = typed || p.part || p.math ? null : p.term || (words(p.text) <= 3 ? p.text : null);
      n = newNode({
        parent: p.nodeId,
        anchor: p.part ? { start: p.start, end: p.end, text: p.text, fig: p.fig, part: p.part }
          : p.sym ? { start: p.start, end: p.end, text: p.text, math: true, sym: p.sym }
            : p.math ? { start: p.start, end: p.end, text: p.text, math: true } : { start: p.start, end: p.end, text: p.text },
        q: typed || (term ? `What does “${term}” mean here?` : VERBS.explain.q),
        verb: typed ? null : 'explain',
        prompt: p.part ? LLM.partPrompt(p.text, typed) : p.sym ? LLM.symbolPrompt(p.sym, p.text, typed) : p.math ? LLM.formulaPrompt(p.text, typed)
          : typed ? LLM.askPrompt(p.text, typed) : term ? LLM.termPrompt(term) : LLM.passagePrompt(p.text, 'explain'),
        status: later ? 'queued' : 'open',
        ready: false,
      });
      runNode(n.id);
    } else if (typed) {
      // The passage already has a thread: the question continues it.
      const end = N(tipOf(n.id));
      if (busy(end)) { toast('That thread is still being answered. Ask again in a moment.'); return; }
      const m = newNode({ parent: end.id, q: typed, prompt: n.anchor.part ? LLM.partPrompt(n.anchor.text, typed) : n.anchor.sym ? LLM.symbolPrompt(n.anchor.sym, n.anchor.text, typed) : n.anchor.math ? LLM.formulaPrompt(n.anchor.text, typed) : LLM.askPrompt(n.anchor.text, typed) });
      state.tips[n.id] = m.id;
      focusId = m.id;
      if (n.status === 'resolved') n.status = 'open';
      runNode(m.id);
    }
    if (p.term) state.looked[p.term.toLowerCase()] = p.term;

    if (later) {
      toast(created ? 'Queued. Keep reading; the answer will be waiting in the map.'
        : typed ? 'Asked in the thread on that passage. The answer will be waiting there.' : 'That passage already has a thread.');
    } else {
      openBeside(p.ci, n.id, focusId);
    }
    render();
  }

  function openBeside(ci, id, focusId) {
    const n = N(id);
    if (n.status === 'queued') n.status = 'open';
    state.cols = state.cols.slice(0, ci + 1).concat({ start: id, leaf: tipOf(id) });
    ui.focus = { start: id, node: focusId || id, fresh: !focusId };
  }

  // Add a turn to the end of whatever column `ci` is showing.
  function addTurn(ci, props) {
    const col = state.cols[ci];
    if (busy(N(col.leaf))) return;
    const n = newNode({ parent: col.leaf, ...props });
    setLeaf(ci, n.id);
    const start = N(col.start);
    if (start.status === 'resolved') start.status = 'open';
    ui.focus = { start: col.start, node: n.id };
    ui.focusInput = col.start;
    runNode(n.id);
    render();
  }

  const send = (ci, text) => addTurn(ci, { q: text, prompt: text, notion: wantNotion() });

  // Go back to an earlier message; what came after it becomes a stub there.
  function continueFrom(ci, id) {
    setLeaf(ci, id);
    ui.focus = { start: state.cols[ci].start, node: id, end: true };
    ui.focusInput = state.cols[ci].start;
    render();
    toast('Continuing from here. The later messages are folded under this one.');
  }

  function switchTo(ci, kid) {
    setLeaf(ci, tip(kid));
    ui.focus = { start: state.cols[ci].start, node: kid };
    render();
  }

  // Put a turn on screen, wherever it is in the tree.
  function reveal(id) {
    const segs = [];
    pathTo(id).forEach(nid => {
      if (!segs.length || N(nid).anchor) segs.push([nid]); else segs[segs.length - 1].push(nid);
    });
    state.cols = segs.map((seg, i) => {
      const want = seg[seg.length - 1];
      const old = state.cols[i];
      if (old && old.start === seg[0] && colPath(old).includes(want)) return old;
      const leaf = i === segs.length - 1 && N(seg[0]).anchor && seg.length === 1 ? tipOf(seg[0]) : tip(want);
      state.tips[seg[0]] = leaf;
      return { start: seg[0], leaf };
    });
    const start = N(state.cols[state.cols.length - 1].start);
    if (start.status === 'queued') start.status = 'open';
    ui.focus = { start: start.id, node: id };
    document.body.classList.remove('side-open');
    render();
  }

  function resolve(ci) {
    const start = N(state.cols[ci].start);
    const end = tipOf(start.id);
    start.status = 'resolved';
    state.cols = state.cols.slice(0, ci);
    render();
    toast('Resolved. Click the underlined passage to reopen it.');
    if (!start.takeaway && !offline()) summarize(state, start, end);
  }

  // One line to remember a resolved side thread by.
  function summarize(conv, start, end) {
    const history = [];
    for (let p = conv.nodes[end]; p; p = conv.nodes[p.parent]) if (p.raw) history.unshift({ prompt: p.prompt, raw: p.raw });
    LLM.side({
      history,
      prompt: `In one sentence of at most 25 words, state what I should take away from the side thread about "${clip(about(start.anchor), 240)}". Write only that sentence.`,
      level: prefs.level, tier: 'quick',
    }).then(text => {
      start.takeaway = clip(text.replace(/\s+/g, ' ').trim(), 240);
      save();
      if (conv === state) { renderTree(); document.querySelectorAll(`mark[data-node="${start.id}"]`).forEach(m => { m.title = start.takeaway; }); }
    }, () => {});
  }

  // "Explain it back": the reader writes the idea, Claude checks it against
  // the thread.
  function check(start, text) {
    const id = start.id, conv = state;
    if (text.trim().length < 12) { ui.teachResult[id] = { note: 'Write a sentence or two first.' }; paintTeach(id); return; }
    const res = ui.teachResult[id] = { busy: true, text: '' };
    const history = pathTo(tipOf(id)).map(x => conv.nodes[x]).filter(h => h.raw).map(h => ({ prompt: h.prompt, raw: h.raw, sources: h.sources }));
    const subject = start.anchor ? `the side thread about "${clip(about(start.anchor), 240)}"` : 'this whole conversation';
    const mine = () => conv === state && ui.teachResult[id] === res;
    LLM.side({
      history,
      prompt: `I will now explain ${subject} back in my own words, so that you can check my understanding. Compare it with what you told me above. Reply in three short parts, each on its own line and starting with its label: "Right:" for what I have right, "Off or missing:" for what is wrong or missing (or "nothing important"), and "Check yourself:" for one question that tests my weakest point. Be specific and brief.\n\nMy explanation:\n${text.trim()}`,
      level: prefs.level, tier: prefs.tier, effort: 'low',
      onText: t => { res.text = t; if (mine()) paintTeach(id); },
    }).then(t => { res.text = t; }, e => { res.err = LLM.errorText(e && e.code); })
      .finally(() => { res.busy = false; if (mine()) paintTeach(id); });
    paintTeach(id);
  }

  // ---------- conversations ----------

  function openConv(id) {
    if (!store.convs[id]) return;
    store.current = id;
    state = store.convs[id];
    ui.teachOpen = {};
    ui.teachResult = {};
    ui.confirmDel = null;
    document.body.classList.remove('side-open');
    render();
  }

  function newConversation() {
    const empty = Object.values(store.convs).find(x => !x.nodes.root);
    const c = empty || blankConv();
    c.updated = Date.now();
    store.convs[c.id] = c;
    ui.focusInput = 'new';
    openConv(c.id);
  }

  function deleteConv(id) {
    Object.keys(live).filter(k => k.startsWith(id + '/')).forEach(k => { live[k].ctl.abort(); delete live[k]; });
    delete store.convs[id];
    ui.confirmDel = null;
    if (!Object.keys(store.convs).length) { const c = blankConv(); store.convs[c.id] = c; }
    if (store.current === id) openConv(recent()[0].id); else render();
  }

  // ---------- rendering ----------

  function render() {
    normalize();
    renderHeader();
    renderNotice();
    renderConvs();
    renderTree();
    renderTerms();
    renderPanes();
    save();
  }

  function renderHeader() {
    document.querySelectorAll('#reader button').forEach(b => b.classList.toggle('on', +b.dataset.level === prefs.level));
    const tiers = LLM.rt.limits && LLM.rt.limits.modelTiers;
    document.querySelectorAll('#tier button').forEach(b => {
      b.classList.toggle('on', b.dataset.tier === prefs.tier);
      b.hidden = !!tiers && !tiers.includes(b.dataset.tier);
    });
  }

  function renderNotice() {
    const rt = LLM.rt;
    const msg = rt.state === 'none'
      ? 'Claude is not reachable from this view, so new questions cannot be answered here. Open this page inside Claude to ask. What you already have can still be read.'
      : rt.denied ? 'Claude was not allowed for this visit, so new questions cannot be answered. Reload the page and choose Allow.'
        : rt.standIn ? 'Local preview. Answers here are placeholders from a stand-in, not from Claude.' : '';
    const n = $('#notice');
    n.hidden = !msg;
    n.textContent = msg;
  }

  function renderConvs() {
    const host = $('#convs');
    host.textContent = '';
    recent().forEach(c => {
      const row = el('div.conv', { class: c.id === state.id ? 'on' : '' });
      if (ui.confirmDel === c.id) {
        row.append(
          el('span.lab', {}, 'Delete this conversation?'),
          el('button.linkbtn', { on: { click: () => deleteConv(c.id) } }, 'Delete'),
          el('button.linkbtn', { on: { click: () => { ui.confirmDel = null; renderConvs(); } } }, 'Keep'));
      } else {
        row.append(
          el('button.open', { title: c.title || 'New conversation', on: { click: () => openConv(c.id) } },
            el('span.lab', {}, c.title || 'New conversation'), c.example && el('span.tag', {}, 'Example')),
          el('button.icon.del', {
            title: 'Delete this conversation', 'aria-label': 'Delete this conversation',
            on: { click: () => { ui.confirmDel = c.id; renderConvs(); } },
          }, '×'));
      }
      host.append(row);
    });
  }

  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 168) + 'px';
  }

  function renderPanes() {
    closePop();
    hideGloss();
    const host = $('#panes');
    const scrolls = {}, drafts = {};
    const act = document.activeElement;
    const kept = act && host.contains(act) && /^(msg|teach)-/.test(act.id || '')
      ? { id: act.id, a: act.selectionStart, b: act.selectionEnd } : null;
    host.querySelectorAll('.pane').forEach(p => {
      scrolls[p.dataset.start] = $('.body', p).scrollTop;
      drafts[p.dataset.start] = $('.composer .msg', p).value;
    });
    host.textContent = '';

    if (!state.cols.length) {
      host.append(emptyPane());
    } else {
      // Show as many threads as fit; earlier ones collapse to a strip.
      const fit = Math.max(1, Math.min(3, Math.floor((host.clientWidth - 18) / 400)));
      const firstFull = Math.max(0, state.cols.length - fit);
      state.cols.forEach((col, i) => host.append(i < firstFull ? spine(col, i) : pane(col, i)));
    }

    host.querySelectorAll('.pane').forEach(p => {
      const key = p.dataset.start, body = $('.body', p), msg = $('.composer .msg', p);
      if (drafts[key]) msg.value = drafts[key];
      grow(msg);
      // Room under the last turn, so a new question can sit at the top of the
      // view while its answer is written below it.
      const lastTurn = body.querySelector('.turn:last-child');
      if (lastTurn) lastTurn.style.minHeight = Math.max(0, body.clientHeight - 44) + 'px';
      if (ui.focus && ui.focus.start === key) {
        const t = body.querySelector(`.turn[data-node="${ui.focus.node}"]`);
        if (ui.focus.end) body.scrollTop = t ? Math.max(0, t.offsetTop + t.offsetHeight - body.clientHeight + 24) : body.scrollHeight;
        else body.scrollTop = t && t.previousElementSibling ? t.offsetTop - 12 : 0;
      } else if (scrolls[key] != null) {
        body.scrollTop = scrolls[key];
      }
      if (ui.focusInput === key) msg.focus({ preventScroll: true });
    });
    if (kept && !ui.focusInput) {
      const e = document.getElementById(kept.id);
      if (e) { e.focus({ preventScroll: true }); try { e.setSelectionRange(kept.a, kept.b); } catch (err) { /* not a text field */ } }
    }
    ui.focus = null;
    ui.focusInput = null;
    host.scrollLeft = host.scrollWidth;
  }

  function spine(col, i) {
    const n = N(col.start);
    return el('button.spine', {
      title: 'Back to: ' + label(n),
      on: { click: () => { state.cols = state.cols.slice(0, i + 1); render(); } },
    }, rich(label(n)));
  }

  function emptyPane() {
    const p = el('section.pane.main.empty', { 'data-start': 'new' });
    p.append(
      el('div.body', {}, el('div.intro', {},
        el('h1', {}, 'What do you want to understand?'),
        el('p', {}, 'Ask as you would in any chat. When part of an answer loses you, click that sentence, or highlight a few words, and ask about just that part.'),
        el('p', {}, 'The side question opens beside the answer and the main thread stays where it was, so you can go as deep as you need and still find your way back.'))),
      composer(null, -1, []));
    return p;
  }

  function pane(col, ci) {
    const start = N(col.start);
    const path = colPath(col);
    const p = el('section.pane', { 'data-start': col.start, class: ci === 0 ? 'main' : 'beside' });
    if (ui.focus && ui.focus.start === col.start && ui.focus.fresh) p.classList.add('fresh');

    if (start.anchor) {
      p.append(el('header', {},
        el('div.from', { title: start.anchor.text }, anchorKids(start.anchor, 4000)),
        el('div.acts', {},
          start.status !== 'resolved' && el('button.btn', {
            title: 'Mark this understood and fold it to one line',
            on: { click: () => resolve(ci) },
          }, 'Got it'),
          el('button.icon', {
            title: 'Close this thread (it stays attached to the passage)', 'aria-label': 'Close this thread',
            on: { click: () => { state.cols = state.cols.slice(0, ci); render(); } },
          }, '×'))));
    }

    const body = el('div.body');
    if (start.status === 'resolved') {
      body.append(el('div.banner', {},
        el('b', {}, '✓ Resolved'),
        el('span', {}, rich(start.takeaway || '')),
        el('button.linkbtn', { on: { click: () => { start.status = 'open'; render(); } } }, 'Reopen')));
    }
    path.forEach((id, i) => body.append(turn(N(id), ci, path, i)));
    p.append(body, composer(col, ci, path));
    return p;
  }

  function turn(n, ci, path, i) {
    return el('div.turn', { 'data-node': n.id },
      el('div.user', {}, el('div.bubble', {}, rich(n.q))),
      answer(n, ci, path, i));
  }

  // The answer to one turn, in whatever state it is in.
  function answer(n, ci, path, i) {
    const isLeaf = i === path.length - 1;
    const ai = el('div.ai');
    const job = live[liveKey(state, n.id)];
    const working = busy(n);

    if (working && job && job.sources.length) ai.append(sources(job.sources));
    if (n.raw) ai.append(buildText(n));
    if (working) {
      ai.append(el('div.working', { role: 'status' },
        el('span.dots', { 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
        el('span', {}, n.raw ? 'Writing…' : 'Thinking…'),
        // Stops on the press as well as on the click: the row moves down as
        // lines are added above it, and a button that has slid from under the
        // pointer before the mouse is let go gets no click.
        el('button.linkbtn', { on: { mousedown: ev => { if (ev.button === 0) stop(n.id); }, click: () => stop(n.id) } }, 'Stop')));
      return ai;
    }

    const again = !kidsOf(n.id).length && el('button.linkbtn', { on: { click: () => { runNode(n.id); render(); } } }, 'Try again');
    if (n.phase === 'error') {
      const code = n.err && n.err.code;
      ai.append(el('div.errbox', {}, el('span', {}, LLM.errorText(code)), !LLM.isFinal(code) && again));
    } else if (n.phase === 'stopped') {
      ai.append(el('div.fine', {}, n.raw ? 'Stopped part-way. ' : 'Stopped before anything was written. ', again));
    }
    if (n.truncated) ai.append(el('div.fine', {}, 'This answer reached the length limit and stops early. Ask for the rest, or for less at a time.'));
    if (n.sources && n.sources.length) ai.append(sources(n.sources));

    // Other branches that leave from this message, and the way back to it.
    const others = typedKids(n.id).filter(k => k.id !== path[i + 1]);
    if (!isLeaf || others.length) {
      const tools = el('div.tools');
      if (!isLeaf) {
        tools.append(el('button.linkbtn', {
          title: 'Branch off here. The messages below are kept and folded under this one.',
          on: { click: () => continueFrom(ci, n.id) },
        }, '↩ Continue from here'));
      }
      others.forEach(k => {
        const len = colPath({ start: k.id, leaf: tip(k.id) }).length;
        tools.append(el('button.stub', { title: 'Switch to this branch', on: { click: () => switchTo(ci, k.id) } },
          '↳ ' + clip(k.q, 40), el('small', {}, ` · ${len} ${len === 1 ? 'message' : 'messages'}`)));
      });
      ai.append(tools);
    }
    return ai;
  }

  // What was looked up in Notion for an answer.
  function sources(list) {
    const box = el('div.sources', {}, el('span.k', {}, 'Notion'));
    list.forEach(s => {
      const failed = s.state === 'error' && clip(s.error || 'no reason given', 90);
      if (s.kind === 'search') {
        box.append(el('span.src', { class: s.state },
          s.state === 'running' ? `Searching “${clip(s.query, 40)}”…`
            : failed ? `Search for “${clip(s.query, 30)}” failed: ${failed}`
              : `Searched “${clip(s.query, 40)}”, ${s.hits} found`));
      } else if (s.state === 'running') {
        box.append(el('span.src.running', {}, 'Reading a page…'));
      } else if (failed) {
        box.append(el('span.src.error', {}, 'Could not read a page: ' + failed));
      } else {
        const name = clip(s.title || 'Notion page', 60);
        box.append(/^https:\/\//.test(s.url || '')
          ? el('a.src', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, name)
          : el('span.src', {}, name));
      }
    });
    return box;
  }

  // The terms an answer shows a definition for. Its own come first, in the
  // order Claude gave them. Then come the terms other answers of this
  // conversation have defined: Claude defines a term once, and goes on using
  // it in the answers below, which would otherwise show it undefined. For
  // those, the answers this one follows from count first, the nearest first,
  // then every other answer in the order it was asked. The first definition
  // of a term wins. The borrowed ones are tried longest first, so that
  // "KL divergence" is found before the "KL" inside it.
  function termsFor(n) {
    const own = LLM.parse(n.raw).terms, borrowed = [];
    const seen = new Set(own.map(t => t.term.toLowerCase()));
    const take = m => {
      if (m === n || !m.raw) return;
      LLM.parse(m.raw).terms.forEach(t => {
        const key = t.term.toLowerCase();
        if (!seen.has(key)) { seen.add(key); borrowed.push(t); }
      });
    };
    for (let p = N(n.parent); p; p = N(p.parent)) take(p);
    Object.values(state.nodes).sort(bySeq).forEach(take);
    borrowed.sort((a, b) => b.term.length - a.term.length);
    return [...own, ...borrowed];
  }

  // An answer's text, with its glossed terms and the passages that have threads.
  function buildText(n, plain) {
    const parsed = LLM.parse(n.raw);
    const t = el('div.text');
    renderBlocks(t, parsed.text, !plain, busy(n));
    if (plain) { t.classList.add('static'); return t; }
    t.dataset.node = n.id;
    if (busy(n)) { t.classList.add('streaming'); return t; }

    // A term is never matched inside a formula's source.
    const full = t.textContent, used = [...t.querySelectorAll('.math')].map(h => { const o = offs(t, h); return [o.start, o.end]; });
    termsFor(n).forEach(term => {
      const key = term.term.toLowerCase();
      if (prefs.known[key]) return;
      const hit = findTerm(full, term.term, used);
      if (!hit) return;
      used.push(hit);
      // Marked with the term itself, not its place in the list: the list
      // grows as other answers arrive, and this text is not drawn again then.
      wrapRange(t, hit[0], hit[1], () => el('span.gloss', { 'data-term': key }));
    });

    const starts = new Set(state.cols.map(c => c.start));
    anchoredKids(n.id).forEach(k => {
      const cls = k.status + (starts.has(k.id) ? ' active' : '') + (k.status === 'queued' && !busy(k) ? ' ready' : '');
      const title = k.status === 'resolved' ? (k.takeaway || 'Resolved') : k.status === 'queued' ? 'Queued: ' + k.q : k.q;
      if (k.anchor.part) {
        // A thread on a box or link of a diagram: mark that part.
        const fig = t.querySelector(`.figure[data-fig="${k.anchor.fig}"]`);
        const part = fig && [...fig.shadowRoot.querySelectorAll('.part')].find(e => e.dataset.part === k.anchor.part);
        if (part) part.classList.add(...cls.split(' '));
        return;
      }
      if (k.anchor.sym) {
        // A thread on one symbol: mark that symbol wherever the formula has it.
        const host = [...t.querySelectorAll('.math')].find(h => offs(t, h).start === k.anchor.start);
        if (host) { (host._marks = host._marks || []).push({ tex: k.anchor.sym, cls: cls.split(' ') }); applyMarks(host); }
        return;
      }
      const made = wrapRange(t, k.anchor.start, k.anchor.end, () => el('mark', { class: cls, 'data-node': k.id, title }),
        h => { h.classList.add('marked', ...cls.split(' ')); h.title = title; });
      if (made.length) made[made.length - 1].classList.add('last');
    });
    return t;
  }

  // ---------- the message box ----------

  const STARTERS = [
    'How does knowledge distillation work?',
    'Why is public-key encryption secure?',
    'What does a Fourier transform actually do?',
  ];

  // Follow-ups offered as chips: for a passage thread the one-click questions
  // not asked yet, then the next questions Claude suggested.
  function chips(col, ci, path) {
    if (!col) return STARTERS.map(q => ({ label: q, run: () => startConv(q) }));
    const start = N(col.start), leaf = N(col.leaf);
    const out = [];
    if (leaf.phase !== 'done' && !leaf.raw) return out;
    if (start.anchor) {
      const asked = new Set(path.map(id => N(id).verb));
      Object.keys(VERBS).filter(v => v !== 'explain' && !asked.has(v)).slice(0, 3).forEach(v => out.push({
        label: VERBS[v].q,
        run: () => addTurn(ci, { q: VERBS[v].q, verb: v, prompt: LLM.followPrompt(about(start.anchor), v) }),
      }));
    }
    const taken = new Set(typedKids(leaf.id).map(k => k.q));
    LLM.parse(leaf.raw).next.filter(q => !taken.has(q)).slice(0, start.anchor ? 2 : 3)
      .forEach(q => out.push({ label: q, run: () => send(ci, q) }));
    if (leaf.phase === 'done' && !/^\s*```graph/m.test(leaf.raw)) {
      out.push({ label: 'Show this as a diagram', run: () => addTurn(ci, { q: 'Show this as a diagram', prompt: LLM.DRAW }) });
    }
    return out;
  }

  // The parts of a message box that change while an answer is being written.
  function composerParts(col, ci, path) {
    const key = col ? col.start : 'new';
    const working = !!col && busy(N(col.leaf));
    const blocked = working || offline();

    const row = el('div.chips');
    if (!working) {
      chips(col, ci, path).forEach(c => row.append(el('button.chip', { type: 'button', disabled: offline(), on: { click: c.run } }, rich(c.label))));
    }

    const opts = el('div.opts');
    if (LLM.rt.notion) {
      const cb = el('input', { type: 'checkbox', id: 'notion-' + key });
      cb.checked = !!prefs.notion;
      cb.addEventListener('change', () => {
        prefs.notion = cb.checked;
        save();
        document.querySelectorAll('.opts input[type="checkbox"]').forEach(x => { x.checked = cb.checked; });
      });
      opts.append(el('label.toggle', {
        title: 'Let Claude search and read your Notion for the questions you type, through the connection you already have in Claude',
      }, cb, el('span', {}, 'Look in my Notion')));
    }
    opts.append(el('span.grow'));
    if (col && path.some(id => N(id).raw)) {
      opts.append(el('button.linkbtn.teachbtn', {
        type: 'button',
        title: 'Write the idea in your own words and have Claude check it',
        on: { click: () => { ui.teachOpen[key] = !ui.teachOpen[key]; renderPanes(); } },
      }, ui.teachOpen[key] ? 'Hide' : 'Explain it back'));
    }
    return { row, opts, blocked };
  }

  function composer(col, ci, path) {
    const key = col ? col.start : 'new';
    const start = col && N(col.start);
    const atEnd = !col || !typedKids(col.leaf).length;
    const parts = composerParts(col, ci, path);
    const f = el('footer.composer');
    if (col && ui.teachOpen[key]) f.append(teach(start));

    const msg = el('textarea.msg', {
      id: 'msg-' + key, rows: '1', 'aria-label': 'Your question',
      placeholder: !col ? 'Ask anything…' : !atEnd ? 'Continue from this point…' : start.anchor ? (start.anchor.part ? 'Ask more about this part of the diagram…' : start.anchor.sym ? 'Ask more about this symbol…' : start.anchor.math ? 'Ask more about this formula…' : 'Ask more about this passage…') : 'Ask a follow-up…',
    });
    const form = el('form', {}, msg, el('button.btn.primary.send', { type: 'submit', disabled: parts.blocked }, 'Send'));
    const submit = () => {
      const now = col ? busy(N(col.leaf)) : false;
      const v = msg.value.trim();
      if (!v || now || offline()) return;
      msg.value = '';
      if (col) send(ci, v); else startConv(v);
    };
    form.addEventListener('submit', ev => { ev.preventDefault(); submit(); });
    msg.addEventListener('keydown', ev => {
      // Enter sends, Shift+Enter breaks the line; never while an input method is composing.
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); submit(); }
    });
    msg.addEventListener('input', () => grow(msg));
    f.append(parts.row, form, parts.opts);
    return f;
  }

  // Refresh the changing parts of every message box without touching what is
  // being typed in them.
  function syncComposers() {
    document.querySelectorAll('#panes .pane').forEach(p => {
      const key = p.dataset.start;
      const ci = state.cols.findIndex(c => c.start === key);
      if (key !== 'new' && ci < 0) return;
      const col = ci >= 0 ? state.cols[ci] : null;
      const parts = composerParts(col, ci, col ? colPath(col) : []);
      $('.composer .chips', p).replaceWith(parts.row);
      $('.composer .opts', p).replaceWith(parts.opts);
      $('.composer .send', p).disabled = parts.blocked;
    });
  }

  function teach(start) {
    const id = start.id;
    const ta = el('textarea', { id: 'teach-' + id, placeholder: 'In your own words…', 'aria-label': 'Your explanation' });
    ta.value = state.teach[id] || '';
    ta.addEventListener('input', () => { state.teach[id] = ta.value; saveSoon(); });
    const out = el('div.result', { 'data-teach': id });
    const btn = el('button.btn.check', { type: 'button', on: { click: () => check(start, ta.value) } }, 'Check');
    const box = el('div.teach', { 'data-teach-box': id },
      el('div.hint', {}, start.parent
        ? 'Write what this thread told you. Claude compares it with the thread and points at the gaps.'
        : 'Write the whole idea in a few sentences. Claude compares it with the conversation and points at the gaps.'),
      ta, el('div.acts', {}, btn), out);
    fillTeach(box, ui.teachResult[id]);
    return box;
  }

  function fillTeach(box, res) {
    const out = $('.result', box);
    out.textContent = '';
    $('.check', box).disabled = !!(res && res.busy) || offline();
    if (!res) return;
    if (res.note) { out.append(el('div.fine', {}, res.note)); return; }
    if (res.text) {
      // Each labelled part on its own line, with the label set off.
      const t = el('div.text.static');
      renderBlocks(t, res.text.replace(/\n+/g, '\n\n').replace(/^(Right|Off or missing|Check yourself):/gm, '**$1:**'), false);
      out.append(t);
    }
    if (res.busy) out.append(el('div.working', { role: 'status' }, el('span.dots', { 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), el('span', {}, res.text ? 'Writing…' : 'Reading your explanation…')));
    if (res.err) out.append(el('div.errbox', {}, res.err));
  }

  function paintTeach(id) {
    const box = $(`#panes .teach[data-teach-box="${id}"]`);
    if (box) fillTeach(box, ui.teachResult[id]);
  }

  // ---------- sidebar ----------

  function renderTree() {
    const tree = $('#tree');
    tree.textContent = '';
    const b = $('#next');
    if (!N('root')) {
      $('#counts').textContent = 'Nothing asked yet';
      b.hidden = true;
      return;
    }
    const threads = Object.values(state.nodes).filter(n => n.anchor);
    const count = s => threads.filter(n => n.status === s).length;
    const forks = Object.values(state.nodes).filter(n => typedKids(n.id).length > 1).length;
    $('#counts').textContent = threads.length || forks
      ? `${count('open')} open · ${count('queued')} queued · ${count('resolved')} resolved`
      : 'One thread so far';
    const on = shown();
    const last = state.cols.length ? state.cols[state.cols.length - 1].leaf : null;
    tree.append(el('ul', {}, chain('root', on, last)));

    const nx = nextNode(on);
    b.hidden = !nx;
    if (nx) {
      b.textContent = '';
      b.append('Next open question →', el('small', {}, rich(label(N(nx)))));
      b.onclick = () => reveal(nx);
    }
  }

  // A turn and the single reply that continues it sit at the same level;
  // passage threads and forks are indented under the turn they leave from.
  function chain(id, on, last) {
    const n = N(id);
    const dot = !n.anchor ? el('span.dot.typed')
      : n.status === 'resolved' ? el('span.dot.resolved', {}, '✓')
        : el('span', { class: 'dot ' + n.status + (busy(n) ? ' wait' : '') });
    const row = el('button', {
      class: 'row ' + (n.anchor ? n.status : 'typed') + (on.has(id) ? ' inpath' : '') + (id === last ? ' current' : ''),
      on: { click: () => reveal(id) },
    },
    dot,
    el('span.lab', {}, rich(label(n)), n.anchor && n.status === 'resolved' && n.takeaway && el('span.take', {}, rich(n.takeaway))),
    busy(n) ? el('span.state', {}, 'writing…') : n.status === 'queued' && el('span.state', {}, 'ready'));

    const li = el('li', {}, row);
    const typed = typedKids(id);
    const under = [...anchoredKids(id), ...(typed.length > 1 ? typed : [])];
    under.forEach(k => li.append(el('ul', {}, chain(k.id, on, last))));
    return typed.length === 1 ? [li, ...chain(typed[0].id, on, last)] : [li];
  }

  // "Where was I?": the first queued question in reading order, otherwise
  // the first open passage thread that is not on screen.
  function nextNode(on) {
    const order = [];
    (function walk(id) {
      order.push(id);
      [...anchoredKids(id), ...typedKids(id)].forEach(k => walk(k.id));
    })('root');
    return order.find(id => N(id).status === 'queued')
      || order.find(id => N(id).anchor && N(id).status === 'open' && !on.has(id));
  }

  function renderTerms() {
    const host = $('#terms');
    host.textContent = '';
    const looked = Object.keys(state.looked).filter(k => !prefs.known[k]);
    const known = Object.keys(prefs.known);
    if (!looked.length && !known.length) {
      host.append('Nothing yet. Dotted words in an answer have a one-line definition. Mark one as known and Claude stops defining it.');
      return;
    }
    if (looked.length) {
      host.append(el('div.grp', {}, 'Looked up in this conversation',
        el('div.chips', {}, looked.map(k => el('span.chip', {}, state.looked[k] === true ? k : state.looked[k])))));
    }
    if (known.length) {
      host.append(el('div.grp', {}, 'Marked known, no longer defined',
        el('div.chips', {}, known.map(k => el('button.chip', {
          title: 'Define this again',
          on: { click: () => { delete prefs.known[k]; render(); } },
        }, prefs.known[k] === true ? k : prefs.known[k], ' ×')))));
    }
  }

  // ---------- the "ask" popover ----------

  const colIndex = c => state.cols.findIndex(col => col.start === c.closest('.pane').dataset.start);

  // `formula` is set when the reader clicked a formula, which is then the passage.
  // and `sym` when what they clicked in it was one symbol.
  function openPopFor(c, start, end, formula, sym) {
    hideGloss();
    const p = { ci: colIndex(c), nodeId: c.dataset.node, start, end, text: c.textContent.slice(start, end), math: !!formula };
    if (sym) p.sym = sym.getAttribute('data-tex');
    // A formula that already has a thread opens it, as a highlighted passage does.
    const existing = (formula || offline()) && findExisting(p);
    if (existing) { openBeside(p.ci, existing.id); render(); return; }
    if (offline()) { toast('Open this page inside Claude to ask about a passage.'); return; }
    if (sym) {
      ui.pendingMath = symsOf(formula, p.sym);
      ui.pendingMath.forEach(g => g.classList.add('pending'));
      showPop(p, bounds([sym]));
      return;
    }
    const range = offsetsToRange(c, start, end);
    setHL('pending', range);
    // The highlight cannot reach into a formula, so formulas are marked directly.
    ui.pendingMath = mathIn(c, start, end);
    ui.pendingMath.forEach(h => h.classList.add('pending'));
    showPop(p, bounds([range, ...ui.pendingMath]));
  }

  // Ask about a box or a link in a diagram.
  function askPart(host, part, text, target) {
    const c = host.closest('#panes .text[data-node]:not(.streaming)');
    if (!c) return;
    const at = offs(c, host).start;
    const p = { ci: colIndex(c), nodeId: c.dataset.node, start: at, end: at, text, fig: +host.dataset.fig, part };
    const existing = findExisting(p);
    if (existing) { openBeside(p.ci, existing.id); render(); return; }
    if (offline()) { toast('Open this page inside Claude to ask about a part of the diagram.'); return; }
    hideGloss();
    closePop();
    target.classList.add('pending');
    ui.pendingEl = target;
    showPop(p, target.getBoundingClientRect());
  }

  function showPop(p, rect) {
    ui.pending = p;

    // One button for the common case, and a box for anything more specific.
    const pop = $('#pop');
    pop.textContent = '';
    const box = el('input', { type: 'text', id: 'pop-q', placeholder: p.part ? 'Ask about this part of the diagram…' : p.sym ? 'Ask about this symbol…' : p.math ? 'Ask about this formula…' : 'Ask about this part…', 'aria-label': 'Your question about this part', autocomplete: 'off' });
    const go = later => ask(p, box.value, later);
    box.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); go(false); }
    });
    pop.append(
      el('button.primary', { title: 'Enter, with the box empty', on: { click: () => ask(p, '', false) } }, VERBS.explain.q),
      box,
      el('button.later', { title: 'Ask in the background and keep reading. Uses your question if you typed one.', on: { click: () => go(true) } }, 'Later'));
    place(pop, rect, false);
    // Ready to type on a desktop; on a touch screen wait for a tap, so the keyboard stays down.
    if (!matchMedia('(hover: none)').matches) box.focus({ preventScroll: true });
  }

  function closePop() {
    if (!ui.pending) return;
    ui.pending = null;
    clearHL('pending');
    if (ui.pendingEl) { ui.pendingEl.classList.remove('pending'); ui.pendingEl = null; }
    if (ui.pendingMath) { ui.pendingMath.forEach(h => h.classList.remove('pending')); ui.pendingMath = null; }
    $('#pop').classList.remove('show');
  }

  function place(pop, rect, below) {
    pop.classList.add('show');
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const x = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8));
    let y = below ? rect.bottom + 8 : rect.top - h - 8;
    if (y < 8) y = rect.bottom + 8;
    if (y + h > innerHeight - 8) y = Math.max(8, rect.top - h - 8);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
  }

  // ---------- glosses ----------

  let glossEl = null, glossShowT = null, glossHideT = null, glossDwellT = null;

  function termOf(g) {
    const c = g.closest('.text[data-node]');
    const n = c && N(c.dataset.node);
    return n ? termsFor(n).find(t => t.term.toLowerCase() === g.dataset.term) || null : null;
  }

  function showGloss(g, pinned) {
    clearTimeout(glossHideT);
    const T = termOf(g);
    if (!T) return;
    const k = T.term.toLowerCase();
    glossEl = g;
    ui.glossPinned = !!pinned;
    const pop = $('#gloss');
    pop.textContent = '';
    pop.append(
      el('div.t', {}, T.term),
      el('div.d', {}, rich(T.gloss)),
      el('div.acts', {},
        !offline() && el('button.linkbtn', { on: { click: () => glossMore(g, T) } }, 'Explain more →'),
        el('button.linkbtn', { on: { click: () => { prefs.known[k] = T.term; render(); toast(`“${T.term}” will no longer be defined.`); } } }, 'I know this')));
    place(pop, g.getClientRects()[0] || g.getBoundingClientRect(), true);
    // Lingering on a definition counts as looking the term up.
    clearTimeout(glossDwellT);
    const note = () => { if (!state.looked[k]) { state.looked[k] = T.term; renderTerms(); save(); } };
    if (pinned) note(); else glossDwellT = setTimeout(note, 900);
  }

  function hideGloss() {
    clearTimeout(glossShowT);
    clearTimeout(glossHideT);
    clearTimeout(glossDwellT);
    glossEl = null;
    ui.glossPinned = false;
    $('#gloss').classList.remove('show');
  }

  function glossMore(g, T) {
    const c = g.closest('.text');
    const o = offs(c, g);
    const p = { ci: colIndex(c), nodeId: c.dataset.node, start: o.start, end: o.end, text: g.textContent, term: T.term };
    hideGloss();
    ask(p, '', false);
  }

  // ---------- write-up ----------

  function writeup() {
    if (!N('root')) { toast('Ask something first.'); return; }
    const m = $('#modal');
    m.textContent = '';
    const copy = el('button.btn', {
      title: 'Copy the write-up as Markdown, for pasting into a document',
      on: {
        click: () => {
          const text = '# ' + N('root').q.replace(/\s+/g, ' ') + '\n\n' + outline('root', 0).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
          // Some views refuse the clipboard; then select the text for a manual copy.
          let done;
          try { done = navigator.clipboard.writeText(text); } catch (e) { done = Promise.reject(e); }
          done.then(
            () => toast('Copied.'),
            () => { getSelection().selectAllChildren(sheet); toast('Selected. Copy it with your keyboard.'); });
        },
      },
    }, 'Copy as Markdown');
    const sheet = el('div.sheet', {},
      el('div.bar2', {}, el('div.kicker', {}, 'Write-up'), copy, el('button.btn', { on: { click: closeModal } }, 'Close')),
      el('h1', {}, rich(N('root').q)),
      el('div.note', {}, 'Every branch of the conversation, stitched together in reading order. Side threads are set in under the passage they came from.'));
    stitch('root', sheet);
    const open = Object.values(state.nodes).filter(n => n.anchor && n.status !== 'resolved');
    if (open.length) {
      sheet.append(el('h2', {}, 'Still open'),
        el('ul.open', {}, open.map(n => el('li', {}, rich(n.q), ' ', el('i', {}, anchorKids(n.anchor, 70))))));
    }
    m.append(sheet);
    m.classList.add('show');
    m.scrollTop = 0;
  }

  function stitch(id, host) {
    const n = N(id);
    if (n.parent) {
      if (n.anchor) host.append(el('div.danchor', {}, anchorKids(n.anchor, 120)));
      host.append(el('div.dq', {}, rich(n.q)));
    }
    if (n.raw) {
      const t = buildText(n, true);
      const parts = [...t.children];
      const spans = parts.map(p => offs(t, p));
      const ks = anchoredKids(id).filter(k => k.raw);
      parts.forEach((p, pi) => {
        const fig = p.classList.contains('figure');
        host.append(fig ? p : el('div.text.static', {}, p));
        ks.filter(k => (fig ? k.anchor.part && k.anchor.fig === +p.dataset.fig
          : !k.anchor.part && k.anchor.start >= spans[pi].start && k.anchor.start < spans[pi].end)).forEach(k => {
          const b = el('div.dbranch');
          stitch(k.id, b);
          host.append(b);
        });
      });
    } else {
      host.append(el('div.fine', {}, 'No answer yet.'));
    }
    const typed = typedKids(id);
    if (typed.length === 1) stitch(typed[0].id, host);
    else typed.forEach(k => { const b = el('div.dbranch.fork'); stitch(k.id, b); host.append(b); });
  }

  // The same write-up as Markdown: side threads and forks become nested quotes.
  function outline(id, depth) {
    const n = N(id), pad = '> '.repeat(depth), out = [];
    if (n.parent) {
      out.push(pad + (n.anchor ? `On “${clip(about(n.anchor), 160)}”: ` : '') + '**' + n.q.replace(/\s+/g, ' ') + '**', pad.trimEnd());
    }
    if (n.raw) LLM.parse(n.raw).text.replace(/```graph\n([\s\S]*?)```/g, (m, spec) => toMermaid(spec)).split('\n').forEach(l => out.push((pad + l).trimEnd()));
    out.push('');
    anchoredKids(id).filter(k => k.raw).forEach(k => out.push(...outline(k.id, depth + 1)));
    const typed = typedKids(id);
    typed.forEach(k => out.push(...outline(k.id, typed.length === 1 ? depth : depth + 1)));
    return out;
  }

  function closeModal() { $('#modal').classList.remove('show'); }

  // ---------- toast ----------

  let toastT = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------- events ----------

  // An answer that can be pointed at: on screen and finished.
  const textHost = node => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement);
    return e && e.closest('#panes .text[data-node]:not(.streaming)');
  };

  document.addEventListener('mousedown', ev => {
    if (ui.pending && !$('#pop').contains(ev.target)) closePop();
    if (glossEl && !$('#gloss').contains(ev.target) && !glossEl.contains(ev.target)) hideGloss();
  });

  // Pointing is the question: a click selects a sentence, a drag selects any span.
  document.addEventListener('mouseup', ev => {
    if (ev.button !== 0) return;
    if ($('#pop').contains(ev.target) || $('#gloss').contains(ev.target)) return;

    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const within = textHost(r.startContainer);
      if (!within || within !== textHost(r.endContainer)) return;
      let { start, end } = rangeOffsets(within, r);
      const full = within.textContent;
      while (start < end && /\s/.test(full[start])) start++;
      while (end > start && /\s/.test(full[end - 1])) end--;
      if (end - start < 2) return;
      if (HAS_HL) sel.removeAllRanges();
      openPopFor(within, start, end);
      return;
    }

    let t = ev.target.nodeType === 1 ? ev.target : ev.target.parentElement;
    const c = textHost(t);
    if (!c || t.closest('a') || t.closest('.figure')) return;
    // A click in the gap between two lines lands on the paragraph, not on a
    // sentence; resolve it to the nearest text instead of ignoring it.
    if (!t.closest('.sent') && document.caretRangeFromPoint) {
      const cr = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      const near = cr && (cr.startContainer.nodeType === 1 ? cr.startContainer : cr.startContainer.parentElement);
      if (near && c.contains(near) && near.closest('.sent')) t = near;
    }
    // A formula is a passage of its own, even inside a highlighted sentence,
    // and a symbol in it is a smaller one.
    const f = t.closest('.math');
    if (f) {
      const o = offs(c, f);
      // The click may be on one symbol inside it; the path leads through the drawing.
      const sym = ev.composedPath().find(x => x.nodeType === 1 && x.classList.contains('sym') && f.shadowRoot.contains(x));
      openPopFor(c, o.start, o.end, f, sym);
      return;
    }
    const g = t.closest('.gloss');
    if (g) { showGloss(g, true); return; }
    const m = t.closest('mark[data-node]');
    if (m) { openBeside(colIndex(c), m.dataset.node); render(); return; }
    const s = t.closest('.sent');
    if (s) { const o = offs(c, s); openPopFor(c, o.start, o.end); }
  });

  const panes = $('#panes');
  panes.addEventListener('mouseover', ev => {
    const g = ev.target.closest('.gloss');
    if (!g || ui.pending) return;
    if (g === glossEl) { clearTimeout(glossHideT); return; }
    if (ui.glossPinned) return;
    clearTimeout(glossShowT);
    glossShowT = setTimeout(() => showGloss(g, false), 220);
  });
  panes.addEventListener('mouseout', ev => {
    if (!ev.target.closest('.gloss')) return;
    clearTimeout(glossShowT);
    if (!ui.glossPinned) glossHideT = setTimeout(hideGloss, 260);
  });
  $('#gloss').addEventListener('mouseenter', () => clearTimeout(glossHideT));
  $('#gloss').addEventListener('mouseleave', () => { if (!ui.glossPinned) glossHideT = setTimeout(hideGloss, 260); });

  document.addEventListener('scroll', ev => {
    if (ev.target === $('#modal') || (ev.target.closest && ev.target.closest('.composer, #pop'))) return;
    closePop();
    if (glossEl) hideGloss();
  }, true);

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closePop(); hideGloss(); closeModal(); document.body.classList.remove('side-open'); return; }
    // Not for a key that something else has already acted on: Enter on a box
    // of a diagram opens the menu, and must not also choose from it.
    if (!ui.pending || ev.defaultPrevented || /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
    if (ev.key === 'Enter') { ev.preventDefault(); ask(ui.pending, '', false); }
  });

  document.querySelectorAll('#reader button').forEach(b =>
    b.addEventListener('click', () => { prefs.level = +b.dataset.level; renderHeader(); save(); }));
  document.querySelectorAll('#tier button').forEach(b =>
    b.addEventListener('click', () => { prefs.tier = b.dataset.tier; renderHeader(); save(); }));
  $('#writeup').addEventListener('click', writeup);
  $('#newconv').addEventListener('click', newConversation);
  $('#menu').addEventListener('click', () => document.body.classList.toggle('side-open'));
  $('#scrim').addEventListener('click', () => document.body.classList.remove('side-open'));
  $('#modal').addEventListener('mousedown', ev => { if (ev.target === $('#modal')) closeModal(); });

  let resizeT = null;
  // Not while the ask menu is open: on a phone the keyboard opening is a resize.
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!ui.pending) renderPanes(); }, 120); });

  // ---------- start ----------

  store = loadStore();
  prefs = store.prefs;
  state = store.convs[store.current];

  // When the runtime answers, or stops offering something, update the parts
  // that depend on it without disturbing what is being typed.
  const soft = () => { renderHeader(); renderNotice(); syncComposers(); };
  LLM.onChange(soft);
  render();
  LLM.ready.then(soft);
})();
