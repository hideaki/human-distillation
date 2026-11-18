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
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const quote = s => '“' + clip(s, 46) + '”';

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
    if (n.anchor) return quote(n.anchor.text);
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
      'In a confident teacher those small probabilities are so close to zero that they barely affect training. To bring them out, both models divide their logits by a temperature T before the softmax. A higher T flattens the distribution, so the differences among unlikely answers become visible.',
      '',
      'The student is trained on a weighted sum of two losses. One is the KL divergence between the softened teacher and student distributions, multiplied by T². The other is ordinary cross-entropy against the true labels. Once trained, the student runs at T = 1 like any other model.',
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
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const f = fence(l);
      if (f) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(f[1])) buf.push(lines[i++]);
        i++;
        out.push({ type: 'code', text: buf.join('\n') });
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
      const buf = [];
      while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !item(lines[i])) buf.push(lines[i++].trim());
      const p = buf.join(' ');
      const h = /^#{1,6}\s+(.*)$/.exec(p);
      out.push({ type: 'p', text: h ? '**' + h[1].replace(/\*\*/g, '') + '**' : p.replace(/^>\s?/, '') });
    }
    return out;
  }

  // Inline markup -> runs of text with a style each.
  function runs(s) {
    const out = [];
    const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|(?<![\w*])\*([^*\s](?:[^*]*?[^*\s])?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ t: s.slice(last, m.index) });
      if (m[2] != null) out.push({ t: m[2], kind: 'code' });
      else if (m[3] != null) out.push({ t: m[3], kind: 'strong' });
      else if (m[4] != null) out.push({ t: m[4], kind: 'em' });
      else out.push({ t: m[5], kind: 'a', href: m[6] });
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ t: s.slice(last) });
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
    const piece = (from, to) => rs.filter(r => r.b > from && r.a < to).map(r => {
      const t = plain.slice(Math.max(r.a, from), Math.min(r.b, to));
      if (r.kind === 'a') return el('a', { href: r.href, target: '_blank', rel: 'noopener noreferrer' }, t);
      return r.kind ? el(r.kind, {}, t) : document.createTextNode(t);
    });
    if (!clickable) { host.append(...piece(0, plain.length)); return; }
    let at = 0;
    sentenceSpans(plain, rs.filter(r => r.kind === 'code').map(r => [r.a, r.b])).forEach(([a, b]) => {
      if (a > at) host.append(...piece(at, a));
      host.append(el('span.sent', {}, piece(a, b)));
      at = b;
    });
    if (at < plain.length) host.append(...piece(at, plain.length));
  }

  function renderBlocks(host, text, clickable) {
    blocks(text).forEach(b => {
      if (b.type === 'code') {
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

  function wrapRange(container, start, end, make) {
    const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const hits = [];
    let pos = 0, n;
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length;
      const s = Math.max(start, pos), e = Math.min(end, pos + len);
      if (s < e) hits.push([n, s - pos, e - pos]);
      pos += len;
      if (pos >= end) break;
    }
    return hits.map(([node, s, e]) => {
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

  const findExisting = p => anchoredKids(p.nodeId).find(n => iou(n.anchor, p) >= 0.8);

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
    $('.ai', t).replaceWith(answer(N(id), ci, path, path.indexOf(id)));
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
      const term = typed ? null : p.term || (words(p.text) <= 3 ? p.text : null);
      n = newNode({
        parent: p.nodeId,
        anchor: { start: p.start, end: p.end, text: p.text },
        q: typed || (term ? `What does “${term}” mean here?` : VERBS.explain.q),
        verb: typed ? null : 'explain',
        prompt: typed ? LLM.askPrompt(p.text, typed) : term ? LLM.termPrompt(term) : LLM.passagePrompt(p.text, 'explain'),
        status: later ? 'queued' : 'open',
        ready: false,
      });
      runNode(n.id);
    } else if (typed) {
      // The passage already has a thread: the question continues it.
      const end = N(tipOf(n.id));
      if (busy(end)) { toast('That thread is still being answered. Ask again in a moment.'); return; }
      const m = newNode({ parent: end.id, q: typed, prompt: LLM.askPrompt(n.anchor.text, typed) });
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
      prompt: `In one sentence of at most 25 words, state what I should take away from the side thread about "${clip(start.anchor.text, 200)}". Write only that sentence.`,
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
    const about = start.anchor ? `the side thread about "${clip(start.anchor.text, 200)}"` : 'this whole conversation';
    const mine = () => conv === state && ui.teachResult[id] === res;
    LLM.side({
      history,
      prompt: `I will now explain ${about} back in my own words, so that you can check my understanding. Compare it with what you told me above. Reply in three short parts, each on its own line and starting with its label: "Right:" for what I have right, "Off or missing:" for what is wrong or missing (or "nothing important"), and "Check yourself:" for one question that tests my weakest point. Be specific and brief.\n\nMy explanation:\n${text.trim()}`,
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
    const empty = Object.values(store.convs).find(c => !c.nodes.root);
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
    }, label(n));
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
        el('div.from', { title: start.anchor.text }, '“' + start.anchor.text + '”'),
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
        el('span', {}, start.takeaway || ''),
        el('button.linkbtn', { on: { click: () => { start.status = 'open'; render(); } } }, 'Reopen')));
    }
    path.forEach((id, i) => body.append(turn(N(id), ci, path, i)));
    p.append(body, composer(col, ci, path));
    return p;
  }

  function turn(n, ci, path, i) {
    return el('div.turn', { 'data-node': n.id },
      el('div.user', {}, el('div.bubble', {}, n.q)),
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
        el('button.linkbtn', { on: { click: () => stop(n.id) } }, 'Stop')));
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

  // An answer's text, with its glossed terms and the passages that have threads.
  function buildText(n, plain) {
    const parsed = LLM.parse(n.raw);
    const t = el('div.text');
    renderBlocks(t, parsed.text, !plain);
    if (plain) { t.classList.add('static'); return t; }
    t.dataset.node = n.id;
    if (busy(n)) { t.classList.add('streaming'); return t; }

    const full = t.textContent, used = [];
    parsed.terms.forEach((term, i) => {
      if (prefs.known[term.term.toLowerCase()]) return;
      const hit = findTerm(full, term.term, used);
      if (!hit) return;
      used.push(hit);
      wrapRange(t, hit[0], hit[1], () => el('span.gloss', { 'data-term': String(i) }));
    });

    const starts = new Set(state.cols.map(c => c.start));
    anchoredKids(n.id).forEach(k => {
      const cls = k.status + (starts.has(k.id) ? ' active' : '') + (k.status === 'queued' && !busy(k) ? ' ready' : '');
      const title = k.status === 'resolved' ? (k.takeaway || 'Resolved') : k.status === 'queued' ? 'Queued: ' + k.q : k.q;
      const made = wrapRange(t, k.anchor.start, k.anchor.end, () => el('mark', { class: cls, 'data-node': k.id, title }));
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
        run: () => addTurn(ci, { q: VERBS[v].q, verb: v, prompt: LLM.followPrompt(start.anchor.text, v) }),
      }));
    }
    const taken = new Set(typedKids(leaf.id).map(k => k.q));
    LLM.parse(leaf.raw).next.filter(q => !taken.has(q)).slice(0, start.anchor ? 2 : 3)
      .forEach(q => out.push({ label: q, run: () => send(ci, q) }));
    return out;
  }

  // The parts of a message box that change while an answer is being written.
  function composerParts(col, ci, path) {
    const key = col ? col.start : 'new';
    const working = !!col && busy(N(col.leaf));
    const blocked = working || offline();

    const row = el('div.chips');
    if (!working) {
      chips(col, ci, path).forEach(c => row.append(el('button.chip', { type: 'button', disabled: offline(), on: { click: c.run } }, c.label)));
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
      placeholder: !col ? 'Ask anything…' : !atEnd ? 'Continue from this point…' : start.anchor ? 'Ask more about this passage…' : 'Ask a follow-up…',
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
      b.append('Next open question →', el('small', {}, label(N(nx))));
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
    el('span.lab', {}, label(n), n.anchor && n.status === 'resolved' && n.takeaway && el('span.take', {}, n.takeaway)),
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

  function openPopFor(c, start, end) {
    hideGloss();
    const p = { ci: colIndex(c), nodeId: c.dataset.node, start, end, text: c.textContent.slice(start, end) };
    if (offline()) {
      // Nothing new can be asked here; a passage that already has a thread still opens it.
      const existing = findExisting(p);
      if (existing) { openBeside(p.ci, existing.id); render(); } else toast('Open this page inside Claude to ask about a passage.');
      return;
    }
    const range = offsetsToRange(c, start, end);
    setHL('pending', range);
    ui.pending = p;

    // One button for the common case, and a box for anything more specific.
    const pop = $('#pop');
    pop.textContent = '';
    const box = el('input', { type: 'text', id: 'pop-q', placeholder: 'Ask about this part…', 'aria-label': 'Your question about this part', autocomplete: 'off' });
    const go = later => ask(p, box.value, later);
    box.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); go(false); }
    });
    pop.append(
      el('button.primary', { title: 'Enter, with the box empty', on: { click: () => ask(p, '', false) } }, VERBS.explain.q),
      box,
      el('button.later', { title: 'Ask in the background and keep reading. Uses your question if you typed one.', on: { click: () => go(true) } }, 'Later'));
    place(pop, range.getBoundingClientRect(), false);
    // Ready to type on a desktop; on a touch screen wait for a tap, so the keyboard stays down.
    if (!matchMedia('(hover: none)').matches) box.focus({ preventScroll: true });
  }

  function closePop() {
    if (!ui.pending) return;
    ui.pending = null;
    clearHL('pending');
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
    return n ? LLM.parse(n.raw).terms[+g.dataset.term] : null;
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
      el('div.d', {}, T.gloss),
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
      el('h1', {}, N('root').q),
      el('div.note', {}, 'Every branch of the conversation, stitched together in reading order. Side threads are set in under the passage they came from.'));
    stitch('root', sheet);
    const open = Object.values(state.nodes).filter(n => n.anchor && n.status !== 'resolved');
    if (open.length) {
      sheet.append(el('h2', {}, 'Still open'),
        el('ul.open', {}, open.map(n => el('li', {}, n.q + ' ', el('i', {}, '“' + clip(n.anchor.text, 70) + '”')))));
    }
    m.append(sheet);
    m.classList.add('show');
    m.scrollTop = 0;
  }

  function stitch(id, host) {
    const n = N(id);
    if (n.parent) {
      if (n.anchor) host.append(el('div.danchor', {}, '“' + clip(n.anchor.text, 120) + '”'));
      host.append(el('div.dq', {}, n.q));
    }
    if (n.raw) {
      const t = buildText(n, true);
      const parts = [...t.children];
      const spans = parts.map(p => offs(t, p));
      const ks = anchoredKids(id).filter(k => k.raw);
      parts.forEach((p, pi) => {
        host.append(el('div.text.static', {}, p));
        ks.filter(k => k.anchor.start >= spans[pi].start && k.anchor.start < spans[pi].end).forEach(k => {
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
      out.push(pad + (n.anchor ? `On “${clip(n.anchor.text, 120)}”: ` : '') + '**' + n.q.replace(/\s+/g, ' ') + '**', pad.trimEnd());
    }
    if (n.raw) LLM.parse(n.raw).text.split('\n').forEach(l => out.push((pad + l).trimEnd()));
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
      const c = textHost(r.startContainer);
      if (!c || c !== textHost(r.endContainer)) return;
      let { start, end } = rangeOffsets(c, r);
      const full = c.textContent;
      while (start < end && /\s/.test(full[start])) start++;
      while (end > start && /\s/.test(full[end - 1])) end--;
      if (end - start < 2) return;
      if (HAS_HL) sel.removeAllRanges();
      openPopFor(c, start, end);
      return;
    }

    let t = ev.target.nodeType === 1 ? ev.target : ev.target.parentElement;
    const c = textHost(t);
    if (!c || t.closest('a')) return;
    // A click in the gap between two lines lands on the paragraph, not on a
    // sentence; resolve it to the nearest text instead of ignoring it.
    if (!t.closest('.sent') && document.caretRangeFromPoint) {
      const cr = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      const near = cr && (cr.startContainer.nodeType === 1 ? cr.startContainer : cr.startContainer.parentElement);
      if (near && c.contains(near) && near.closest('.sent')) t = near;
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
    if (!ui.pending || /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
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
