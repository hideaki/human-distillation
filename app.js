// UI mock: an ordinary chat in which any message can be branched from.
//
// The conversation is a tree of turns (a question and its answer). Every
// branch is the same kind of thing: a thread you can keep typing into.
//   - Typing extends the thread you are in.
//   - "Continue from here" on an earlier message starts a new branch there
//     and folds the later messages into a stub.
//   - Pointing at a passage starts a branch attached to that passage, shown
//     beside the message so the passage stays in view.
// Everything the "AI" says comes from content.js.

(() => {
  'use strict';

  const KEY = 'human-distillation-mock-v2';
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
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid);
    return e;
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const words = s => s.trim().split(/\s+/).length;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const quote = s => '“' + clip(s, 46) + '”';

  // ---------- state ----------
  // nodes: the tree of turns. cols: the threads on screen, left to right.
  // cols[0] starts at the root; each later column starts at a turn that is
  // attached to a passage in the column before it.

  function fresh() {
    return {
      seq: 1,
      level: 1,
      cols: [{ start: 'root', leaf: 'root' }],
      tips: {},
      known: {},
      looked: {},
      dismissed: {},
      teach: {},
      nodes: {
        root: {
          id: 'root', seq: 0, parent: null, anchor: null, q: TOPICS.root.label,
          topic: 'root', content: 'root', status: 'open', ready: true,
        },
      },
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (!s || !s.nodes || !s.nodes.root || !Array.isArray(s.cols)) return null;
      Object.values(s.nodes).forEach(n => { n.ready = true; });
      return s;
    } catch (e) {
      return null;
    }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ }
  }

  let state = load() || fresh();
  const ui = { pending: null, teachOpen: {}, teachResult: {}, focus: null, focusInput: null, T: 1, glossPinned: false };

  const N = id => state.nodes[id];
  const bySeq = (a, b) => a.seq - b.seq;
  const kidsOf = id => Object.values(state.nodes).filter(n => n.parent === id);
  const typedKids = id => kidsOf(id).filter(n => !n.anchor).sort(bySeq);
  const anchoredKids = id => kidsOf(id).filter(n => n.anchor).sort((a, b) => a.anchor.start - b.anchor.start);

  function newNode(props) {
    const seq = state.seq++;
    const n = { id: 'n' + seq, seq, anchor: null, status: 'open', ready: true, ...props };
    state.nodes[n.id] = n;
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
    if (!n.parent) return n.q;
    if (n.anchor) return n.topic && TOPICS[n.topic] ? TOPICS[n.topic].label : quote(n.anchor.text);
    return clip(n.q, 52);
  }

  const takeaway = n => (n.topic && TOPICS[n.topic] && TOPICS[n.topic].takeaway) || 'A one-line takeaway would be drafted here.';
  const answerFor = (topic, verb) => (topic && TOPICS[topic] && TOPICS[topic].answers && TOPICS[topic].answers[verb]) || null;

  // ---------- text and offsets ----------
  // A passage is stored as character offsets into an answer's text, so it
  // survives re-rendering and can be any selection, not only a whole sentence.

  function inline(s) {
    return esc(s)
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => `<span class="gloss" data-term="${b || a}">${a}</span>`)
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function buildText(cid) {
    const t = el('div.text');
    CONTENT[cid].paras.forEach(p => {
      const pe = el('p');
      p.forEach((s, i) => {
        const o = typeof s === 'string' ? { t: s } : s;
        if (i) pe.append(' ');
        const sp = el('span.sent', { html: inline(o.t) });
        if (o.topic) sp.dataset.topic = o.topic;
        pe.append(sp);
      });
      t.append(pe);
    });
    return t;
  }

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

  // Which canned answer, if any, does this selection correspond to?
  function matchTopic(c, p) {
    const cands = [];
    c.querySelectorAll('.sent[data-topic]').forEach(s => cands.push({ ...offs(c, s), topic: s.dataset.topic, tight: false }));
    c.querySelectorAll('.gloss').forEach(g => cands.push({ ...offs(c, g), topic: 'term:' + g.dataset.term, tight: true }));
    const text = c.textContent;
    ((CONTENT[N(c.dataset.node).content] || {}).anchors || []).forEach(a => {
      const i = text.indexOf(a.phrase);
      if (i >= 0) cands.push({ start: i, end: i + a.phrase.length, topic: a.topic, tight: true });
    });
    let best = null, score = 0;
    cands.forEach(k => { const s = iou(k, p); if (s > score) { best = k; score = s; } });
    if (best && score >= 0.5) return best.topic;
    const inside = cands
      .filter(k => k.tight && k.start <= p.start && k.end >= p.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    return inside ? inside.topic : null;
  }

  // Typed text has no model behind it; match it to a canned answer if we can.
  function matchTyped(text) {
    for (const [key, a] of Object.entries(ASKS)) if (a.match.test(text)) return { ask: key, content: a.content };
    const low = text.toLowerCase();
    for (const key of Object.keys(TERMS)) {
      const k = key.toLowerCase();
      if (low.includes(k) || (k.endsWith('s') && low.includes(k.slice(0, -1)))) {
        return { topic: 'term:' + key, content: 'term:' + key };
      }
    }
    return {};
  }

  const findExisting = p => anchoredKids(p.nodeId).find(n => iou(n.anchor, p) >= 0.8);

  function setHL(name, range) { if (HAS_HL) CSS.highlights.set(name, new Highlight(range)); }
  function clearHL(name) { if (HAS_HL) CSS.highlights.delete(name); }

  // ---------- actions ----------

  // Point at a passage and ask about it: a branch attached to that passage.
  function ask(p, verb, later) {
    let n = findExisting(p), created = false, focusId = null;
    if (!n) {
      created = true;
      n = newNode({
        parent: p.nodeId,
        anchor: { start: p.start, end: p.end, text: p.text },
        q: VERBS[verb].q, verb,
        topic: p.topic || null,
        content: answerFor(p.topic, verb),
        status: later ? 'queued' : 'open',
        ready: !later,
      });
    } else if (!later) {
      // Same passage, different question: it continues that thread.
      const thread = colPath({ start: n.id, leaf: tipOf(n.id) }).map(N);
      if (!thread.some(t => t.verb === verb)) {
        const m = newNode({ parent: thread[thread.length - 1].id, q: VERBS[verb].q, verb, topic: n.topic, content: answerFor(n.topic, verb) });
        state.tips[n.id] = m.id;
        focusId = m.id;
        if (n.status === 'resolved') n.status = 'open';
      }
    }
    if (n.topic && n.topic.startsWith('term:')) state.looked[n.topic.slice(5)] = true;
    else if (verb === 'what' && words(p.text) <= 3) state.looked[p.text.toLowerCase()] = true;

    if (later) {
      if (created) {
        toast('Queued. Keep reading; it will be waiting in the map.');
        setTimeout(() => markReady(n.id), 1500);
      } else {
        toast('That passage already has a thread.');
      }
    } else {
      openBeside(p.ci, n.id, focusId);
    }
    render();
  }

  function openBeside(ci, id, focusId) {
    const n = N(id);
    if (n.status === 'queued') n.status = 'open';
    n.ready = true;
    state.cols = state.cols.slice(0, ci + 1).concat({ start: id, leaf: tipOf(id) });
    ui.focus = { start: id, node: focusId || id, fresh: !focusId };
  }

  function markReady(id) {
    const n = N(id);
    if (!n || n.ready) return;
    n.ready = true;
    save();
    renderTree();
    document.querySelectorAll(`mark[data-node="${id}"]`).forEach(m => m.classList.add('ready'));
  }

  // Add a turn to the end of whatever column `ci` is showing.
  function addTurn(ci, props) {
    const col = state.cols[ci];
    const n = newNode({ parent: col.leaf, ...props });
    setLeaf(ci, n.id);
    const start = N(col.start);
    if (start.status === 'resolved') start.status = 'open';
    ui.focus = { start: col.start, node: n.id };
    ui.focusInput = col.start;
    render();
  }

  function send(ci, text) {
    const m = matchTyped(text);
    addTurn(ci, { q: text, ask: m.ask, topic: m.topic, content: m.content || null });
    if (m.topic && m.topic.startsWith('term:')) { state.looked[m.topic.slice(5)] = true; renderTerms(); save(); }
  }

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
    if (start.status === 'queued') { start.status = 'open'; start.ready = true; }
    ui.focus = { start: start.id, node: id };
    render();
  }

  function resolve(ci) {
    N(state.cols[ci].start).status = 'resolved';
    state.cols = state.cols.slice(0, ci);
    render();
    toast('Resolved. It is now one line in the map; click the underlined passage to reopen it.');
  }

  // ---------- rendering ----------

  function render() {
    normalize();
    document.querySelectorAll('#reader button').forEach(b => b.classList.toggle('on', +b.dataset.level === state.level));
    renderTree();
    renderTerms();
    renderPanes();
    save();
  }

  function renderPanes() {
    closePop();
    hideGloss();
    clearHL('suggest');
    const host = $('#panes');
    const scrolls = {}, drafts = {};
    host.querySelectorAll('.pane').forEach(p => {
      scrolls[p.dataset.start] = $('.body', p).scrollTop;
      drafts[p.dataset.start] = $('.composer input', p).value;
    });
    host.textContent = '';

    // Show as many threads as fit; earlier ones collapse to a strip.
    const fit = Math.max(1, Math.min(3, Math.floor((host.clientWidth - 18) / 400)));
    const firstFull = Math.max(0, state.cols.length - fit);
    state.cols.forEach((col, i) => host.append(i < firstFull ? spine(col, i) : pane(col, i)));

    host.querySelectorAll('.pane').forEach(p => {
      const key = p.dataset.start, body = $('.body', p);
      if (drafts[key]) $('.composer input', p).value = drafts[key];
      if (ui.focus && ui.focus.start === key) {
        const t = body.querySelector(`.turn[data-node="${ui.focus.node}"]`);
        if (ui.focus.end) body.scrollTop = body.scrollHeight;
        else body.scrollTop = t && t.previousElementSibling ? t.offsetTop - 12 : 0;
      } else if (scrolls[key] != null) {
        body.scrollTop = scrolls[key];
      }
      if (ui.focusInput === key) $('.composer input', p).focus({ preventScroll: true });
    });
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
            title: 'Mark this understood and collapse it to a one-line takeaway',
            on: { click: () => resolve(ci) },
          }, 'Got it'),
          el('button.icon', {
            title: 'Close this thread (it stays attached to the passage)',
            on: { click: () => { state.cols = state.cols.slice(0, ci); render(); } },
          }, '×'))));
    }

    const body = el('div.body');
    if (start.status === 'resolved') {
      body.append(el('div.banner', {},
        el('b', {}, '✓ Resolved'),
        el('span', {}, takeaway(start)),
        el('button.linkbtn', { on: { click: () => { start.status = 'open'; render(); } } }, 'Reopen')));
    }
    path.forEach((id, i) => body.append(turn(N(id), ci, path, i)));
    p.append(body, composer(col, ci, path));
    return p;
  }

  function turn(n, ci, path, i) {
    const isLeaf = i === path.length - 1;
    const t = el('div.turn', { 'data-node': n.id });
    t.append(el('div.user', {}, el('div.bubble', {}, n.q)));

    const ai = el('div.ai');
    if (n.content && CONTENT[n.content]) {
      const text = buildText(n.content);
      text.dataset.node = n.id;
      applyGloss(text);
      const starts = new Set(state.cols.map(c => c.start));
      anchoredKids(n.id).forEach(k => {
        const cls = k.status + (starts.has(k.id) ? ' active' : '') + (k.status === 'queued' && k.ready ? ' ready' : '');
        const title = k.status === 'resolved' ? takeaway(k) : k.status === 'queued' ? 'Queued: ' + k.q : label(k);
        const made = wrapRange(text, k.anchor.start, k.anchor.end, () => el('mark', { class: cls, 'data-node': k.id, title }));
        if (made.length) made[made.length - 1].classList.add('last');
      });
      ai.append(text);
      const w = CONTENT[n.content].widget;
      if (w) ai.append(WIDGETS[w]());
      const sg = suggestion(n, ci, text);
      if (sg) ai.append(sg);
    } else {
      ai.append(el('div.placeholder', {},
        el('strong', {}, 'No canned answer here. '),
        n.anchor
          ? `A real model would answer “${n.q}” about the highlighted passage, with the conversation that led to it as context.`
          : 'A real model would answer this, with the messages above it in this thread as context.'));
    }

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
    t.append(ai);
    return t;
  }

  // A term is glossed unless the reader said they know it, or it is basic
  // vocabulary for their level and they have never looked it up.
  function applyGloss(t) {
    t.querySelectorAll('.gloss').forEach(g => {
      const k = g.dataset.term, T = TERMS[k];
      const show = T && !state.known[k] && (T.level >= state.level || state.looked[k]);
      g.classList.toggle('off', !show);
    });
  }

  // Follow-ups with canned answers, offered as chips above the message box.
  function chips(col, ci, path) {
    const start = N(col.start), leaf = N(col.leaf);
    const out = [];
    if (start.anchor) {
      const asked = new Set(path.map(id => N(id).verb));
      Object.keys(VERBS).filter(v => !asked.has(v)).forEach(v => out.push({
        label: VERBS[v].q,
        run: () => addTurn(ci, { q: VERBS[v].q, verb: v, topic: start.topic, content: answerFor(start.topic, v) }),
      }));
    }
    const taken = new Set([...path, ...typedKids(leaf.id).map(k => k.id)].map(id => N(id).ask));
    const cand = [...((leaf.ask && ASKS[leaf.ask].next) || []), ...(ci === 0 ? STARTERS : [])];
    [...new Set(cand)].filter(k => !taken.has(k)).slice(0, 3).forEach(k => out.push({
      label: ASKS[k].q,
      run: () => addTurn(ci, { q: ASKS[k].q, ask: k, content: ASKS[k].content }),
    }));
    return out;
  }

  function composer(col, ci, path) {
    const start = N(col.start);
    const atEnd = !typedKids(col.leaf).length;
    const f = el('footer.composer');

    if (ui.teachOpen[col.start]) f.append(teach(start));

    const row = el('div.chips', {}, chips(col, ci, path).map(c => el('button.chip', { on: { click: c.run } }, c.label)));
    row.append(el('button.linkbtn.teachbtn', {
      title: 'Write the idea in your own words and see what you covered',
      on: { click: () => { ui.teachOpen[col.start] = !ui.teachOpen[col.start]; renderPanes(); } },
    }, ui.teachOpen[col.start] ? 'Hide' : 'Explain it back'));
    f.append(row);

    const inp = el('input', {
      type: 'text',
      placeholder: !atEnd ? 'Continue from this point…' : start.anchor ? 'Ask more about this passage…' : 'Ask a follow-up…',
    });
    const form = el('form', {}, inp, el('button.btn.primary', { type: 'submit' }, 'Send'));
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      if (inp.value.trim()) { const v = inp.value.trim(); inp.value = ''; send(ci, v); }
    });
    f.append(form);
    return f;
  }

  // A branch the reader did not ask for.
  function suggestion(n, ci, text) {
    const s = n.topic && SUGGEST[n.topic];
    if (!s || state.dismissed[n.id]) return null;
    const ks = anchoredKids(n.id);
    if (ks.filter(k => k.status !== 'queued').length < 2 || ks.some(k => k.topic === s.topic)) return null;
    const i = text.textContent.indexOf(s.phrase);
    if (i < 0) return null;
    const p = { ci, nodeId: n.id, start: i, end: i + s.phrase.length, text: s.phrase, topic: s.topic };
    const card = el('div.suggest', {},
      el('div.k', {}, 'Suggested'),
      el('div.ph', {}, '“' + s.phrase + '”'),
      el('div', {}, s.why),
      el('div.acts', {},
        el('button.btn.primary', { on: { click: () => ask(p, s.verb, false) } }, 'Open it'),
        el('button.btn.quiet', { on: { click: () => { state.dismissed[n.id] = true; render(); } } }, 'Not now')));
    card.addEventListener('mouseenter', () => setHL('suggest', offsetsToRange(text, p.start, p.end)));
    card.addEventListener('mouseleave', () => clearHL('suggest'));
    return card;
  }

  function teach(n) {
    const id = n.id;
    const ta = el('textarea', { placeholder: 'In your own words…' });
    ta.value = state.teach[id] || '';
    ta.addEventListener('input', () => { state.teach[id] = ta.value; save(); });
    const box = el('div.teach', {},
      el('div.hint', {}, n.parent
        ? 'Write what this thread told you, then check what you covered.'
        : 'Write the whole idea in a few sentences, then check what you covered.'),
      ta,
      el('div.acts', {}, el('button.btn', {
        on: { click: () => { ui.teachResult[id] = ta.value; renderPanes(); } },
      }, 'Check')));
    if (ui.teachResult[id] != null) box.append(teachResult(n, ui.teachResult[id]));
    return box;
  }

  function teachResult(n, text) {
    if (text.trim().length < 12) return el('div.fine', {}, 'Write a sentence or two first.');
    const pts = n.topic && TOPICS[n.topic] && TOPICS[n.topic].points;
    if (!pts) {
      return el('div.fine', {}, 'The mock has no key points for this thread. A real model would compare what you wrote with its own answer and point at the gaps.');
    }
    const ul = el('ul');
    pts.forEach(p => {
      const ok = p.all.every(re => re.test(text));
      ul.append(el('li', { class: ok ? 'ok' : 'miss' },
        el('span.m', {}, ok ? '✓' : '○'),
        el('span', {}, p.label + (ok ? '' : ' (missing)'))));
    });
    return el('div', {}, ul, el('div.fine', {}, 'Mock: keyword matching stands in for a model reading your answer.'));
  }

  // ---------- sidebar ----------

  function renderTree() {
    const threads = Object.values(state.nodes).filter(n => n.anchor);
    const count = s => threads.filter(n => n.status === s).length;
    const forks = Object.values(state.nodes).filter(n => typedKids(n.id).length > 1).length;
    $('#counts').textContent = threads.length || forks
      ? `${count('open')} open · ${count('queued')} queued · ${count('resolved')} resolved`
      : 'One thread so far';
    const on = shown();
    const last = state.cols[state.cols.length - 1].leaf;
    const tree = $('#tree');
    tree.textContent = '';
    tree.append(el('ul', {}, chain('root', on, last)));

    const nx = nextNode(on);
    const b = $('#next');
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
        : el('span', { class: 'dot ' + n.status + (n.status === 'queued' && !n.ready ? ' wait' : '') });
    const row = el('button', {
      class: 'row ' + (n.anchor ? n.status : 'typed') + (on.has(id) ? ' inpath' : '') + (id === last ? ' current' : ''),
      on: { click: () => reveal(id) },
    },
    dot,
    el('span.lab', {}, label(n), n.anchor && n.status === 'resolved' && el('span.take', {}, takeaway(n))),
    n.status === 'queued' && el('span.state', {}, n.ready ? 'ready' : 'writing…'));

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
    const looked = Object.keys(state.looked).filter(k => !state.known[k]);
    const known = Object.keys(state.known);
    if (!looked.length && !known.length) {
      host.append('Nothing yet. Terms you look up stay glossed; terms you mark as known stop being underlined.');
      return;
    }
    if (looked.length) {
      host.append(el('div.grp', {}, 'Looked up, so kept glossed',
        el('div.chips', {}, looked.map(k => el('span.chip', {}, k)))));
    }
    if (known.length) {
      host.append(el('div.grp', {}, 'Marked known, no longer glossed',
        el('div.chips', {}, known.map(k => el('button.chip', {
          title: 'Gloss this again',
          on: { click: () => { delete state.known[k]; render(); } },
        }, k, ' ×')))));
    }
  }

  // ---------- the "ask" popover ----------

  const colIndex = c => state.cols.findIndex(col => col.start === c.closest('.pane').dataset.start);

  function openPopFor(c, start, end) {
    hideGloss();
    const p = { ci: colIndex(c), nodeId: c.dataset.node, start, end, text: c.textContent.slice(start, end) };
    const existing = findExisting(p);
    p.topic = existing ? existing.topic : matchTopic(c, p);
    // The default verb is the model's guess at what kind of confusion this is.
    p.def = p.topic && TOPICS[p.topic] ? TOPICS[p.topic].def : (words(p.text) <= 3 ? 'what' : 'why');
    const range = offsetsToRange(c, start, end);
    setHL('pending', range);
    ui.pending = p;

    const pop = $('#pop');
    pop.textContent = '';
    [p.def, ...Object.keys(VERBS).filter(v => v !== p.def)].forEach((v, i) => {
      pop.append(el('button', {
        class: i === 0 ? 'primary' : '',
        title: i === 0 ? 'Enter' : VERBS[v].q,
        on: { click: () => ask(p, v, false) },
      }, i === 0 ? VERBS[v].q : VERBS[v].short));
    });
    pop.append(
      el('span.sep'),
      el('button.later', { title: 'Queue this question and keep reading (L)', on: { click: () => ask(p, p.def, true) } }, 'Later'));
    place(pop, range.getBoundingClientRect(), false);
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

  function showGloss(g, pinned) {
    clearTimeout(glossHideT);
    const k = g.dataset.term, T = TERMS[k];
    if (!T) return;
    glossEl = g;
    ui.glossPinned = !!pinned;
    const pop = $('#gloss');
    pop.textContent = '';
    pop.append(
      el('div.t', {}, k),
      el('div.d', {}, T.short),
      el('div.acts', {},
        el('button.linkbtn', { on: { click: () => glossMore(g) } }, 'Explain more →'),
        el('button.linkbtn', { on: { click: () => { state.known[k] = true; render(); toast(`“${k}” will no longer be glossed.`); } } }, 'I know this')));
    place(pop, g.getClientRects()[0] || g.getBoundingClientRect(), true);
    // Lingering on a gloss counts as looking the term up.
    clearTimeout(glossDwellT);
    const note = () => { if (!state.looked[k]) { state.looked[k] = true; renderTerms(); save(); } };
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

  function glossMore(g) {
    const c = g.closest('.text');
    const o = offs(c, g);
    const p = { ci: colIndex(c), nodeId: c.dataset.node, start: o.start, end: o.end, text: g.textContent, topic: 'term:' + g.dataset.term };
    hideGloss();
    ask(p, 'what', false);
  }

  // ---------- write-up ----------

  function writeup() {
    const m = $('#modal');
    m.textContent = '';
    const sheet = el('div.sheet', {},
      el('div.bar2', {}, el('div.kicker', {}, 'Write-up'), el('button.btn', { on: { click: closeModal } }, 'Close')),
      el('h1', {}, N('root').q),
      el('div.note', {}, 'Stitched from every branch of the conversation, in reading order. The real thing would have the model rewrite this into one continuous explanation at your level; the mock only nests the pieces.'));
    stitch('root', sheet);
    const open = Object.values(state.nodes).filter(n => n.anchor && n.status !== 'resolved');
    if (open.length) {
      sheet.append(el('h2', {}, 'Still open'),
        el('ul.open', {}, open.map(n => el('li', {}, label(n) + ' ', el('i', {}, '“' + clip(n.anchor.text, 70) + '”')))));
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
    if (n.content && CONTENT[n.content]) {
      const t = buildText(n.content);
      t.querySelectorAll('.gloss').forEach(g => g.classList.add('off'));
      const paras = [...t.children];
      const spans = paras.map(p => offs(t, p));
      const ks = anchoredKids(id).filter(k => k.status !== 'queued');
      paras.forEach((p, pi) => {
        host.append(el('div.text.static', {}, p));
        ks.filter(k => k.anchor.start >= spans[pi].start && k.anchor.start < spans[pi].end).forEach(k => {
          const b = el('div.dbranch');
          stitch(k.id, b);
          host.append(b);
        });
      });
    } else {
      host.append(el('div.placeholder', {}, 'No canned answer in the mock.'));
    }
    const typed = typedKids(id);
    if (typed.length === 1) stitch(typed[0].id, host);
    else typed.forEach(k => { const b = el('div.dbranch.fork'); stitch(k.id, b); host.append(b); });
  }

  function closeModal() { $('#modal').classList.remove('show'); }

  // ---------- widgets ----------

  const LOGITS = [['dog', 9], ['wolf', 6], ['car', 0]];

  function softmaxT(T) {
    const ex = LOGITS.map(([, z]) => Math.exp((z - 9) / T));
    const sum = ex.reduce((a, b) => a + b, 0);
    return ex.map(x => x / sum);
  }

  function pct(p) {
    const v = p * 100;
    return v >= 1 ? v.toFixed(1) + '%' : v >= 0.01 ? v.toFixed(2) + '%' : '<0.01%';
  }

  const WIDGETS = {
    tempTable() {
      return el('div.widget', {}, el('table', {},
        el('tr', {}, el('th', {}, 'T'), LOGITS.map(([name]) => el('th', {}, name))),
        [1, 3, 10].map(T => el('tr', {}, el('td', {}, String(T)), softmaxT(T).map(v => el('td', {}, pct(v)))))));
    },
    tempSlider() {
      const out = el('b');
      const inp = el('input', { type: 'range', min: '1', max: '10', step: '0.5', value: String(ui.T), 'aria-label': 'Temperature' });
      const rows = LOGITS.map(([name]) => {
        const fill = el('div.fill'), p = el('span.pct');
        return { fill, p, row: el('div.bar', {}, el('span', {}, name), el('div.track', {}, fill), p) };
      });
      const update = () => {
        ui.T = +inp.value;
        out.textContent = 'T = ' + ui.T.toFixed(1);
        softmaxT(ui.T).forEach((v, i) => {
          rows[i].fill.style.width = (v * 100) + '%';
          rows[i].p.textContent = pct(v);
        });
      };
      inp.addEventListener('input', update);
      update();
      return el('div.widget', {}, el('div.ctl', {}, out, inp), rows.map(r => r.row));
    },
  };

  // ---------- toast ----------

  let toastT = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- events ----------

  const textHost = node => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement);
    return e && e.closest('#panes .text[data-node]');
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
    const c = t && t.closest('#panes .text[data-node]');
    if (!c) return;
    // A click in the gap between two lines lands on the paragraph, not on a
    // sentence; resolve it to the nearest text instead of ignoring it.
    if (!t.closest('.sent') && document.caretRangeFromPoint) {
      const cr = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      const near = cr && (cr.startContainer.nodeType === 1 ? cr.startContainer : cr.startContainer.parentElement);
      if (near && c.contains(near) && near.closest('.sent')) t = near;
    }
    const g = t.closest('.gloss:not(.off)');
    if (g) { showGloss(g, true); return; }
    const m = t.closest('mark[data-node]');
    if (m) { openBeside(colIndex(c), m.dataset.node); render(); return; }
    const s = t.closest('.sent');
    if (s) { const o = offs(c, s); openPopFor(c, o.start, o.end); }
  });

  const panes = $('#panes');
  panes.addEventListener('mouseover', ev => {
    const g = ev.target.closest('.gloss:not(.off)');
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
    if (ev.target === $('#modal')) return;
    closePop();
    if (glossEl) hideGloss();
  }, true);

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closePop(); hideGloss(); closeModal(); return; }
    if (!ui.pending || /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
    if (ev.key === 'Enter') { ev.preventDefault(); ask(ui.pending, ui.pending.def, false); }
    else if (ev.key === 'l' || ev.key === 'L') { ev.preventDefault(); ask(ui.pending, ui.pending.def, true); }
  });

  document.querySelectorAll('#reader button').forEach(b =>
    b.addEventListener('click', () => { state.level = +b.dataset.level; render(); }));
  $('#writeup').addEventListener('click', writeup);
  $('#modal').addEventListener('mousedown', ev => { if (ev.target === $('#modal')) closeModal(); });
  $('#reset').addEventListener('click', () => {
    state = fresh();
    ui.teachOpen = {}; ui.teachResult = {}; ui.T = 1;
    render();
  });

  let resizeT = null;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderPanes, 120); });

  render();
})();
