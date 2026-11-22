// Parsing tests: how the text Claude writes is read. No browser, no
// dependencies.   Run:  node --test live/test/parse.test.js
//
// The functions come out of live/app.js by source text (see extract.js), so
// the app carries no export that exists only for tests.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromApp, llm } = require('./extract.js');

const app = fromApp([
  'MATH_SRC', 'MATH_RE', 'ATOM_RE', 'clip', 'formulaOnly',
  'cells', 'blocks', 'pieces', 'runs',
  'SEG', 'ABBR', 'sentenceSpans',
  'ARROW', 'parseGraph', 'edgeText', 'toMermaid',
  'findTerm', 'iou',
]);
const { cells, blocks, pieces, runs, clip, formulaOnly, parseGraph, edgeText, toMermaid, sentenceSpans, findTerm, iou, MATH_RE } = app;
const LLM = llm();

const types = bs => bs.map(b => b.type);
const maths = rs => rs.filter(r => r.kind === 'math');
const plain = rs => rs.map(r => r.t).join('');

// ---------- blocks ----------

test('blocks: lines join into paragraphs, blank lines separate them', () => {
  assert.deepEqual(blocks('one\ntwo\n\nthree\r\n\r\n\n'), [
    { type: 'p', text: 'one two' },
    { type: 'p', text: 'three' },
  ]);
  assert.deepEqual(blocks(''), []);
});

test('blocks: a heading becomes a bold paragraph and a quote loses its mark', () => {
  assert.deepEqual(blocks('## A **loud** title\n\n> quoted words'), [
    { type: 'p', text: '**A loud title**' },
    { type: 'p', text: 'quoted words' },
  ]);
});

test('blocks: bullet and numbered lists, with wrapped items', () => {
  assert.deepEqual(blocks('Intro:\n- first\n- second\n  carries on\n* third\n\n1. one\n2) two'), [
    { type: 'p', text: 'Intro:' },
    { type: 'ul', items: ['first', 'second carries on', 'third'] },
    { type: 'ol', items: ['one', 'two'] },
  ]);
});

test('blocks: a code block keeps its lines and says whether it was closed', () => {
  assert.deepEqual(blocks('```python\nfor x in y:\n    print(x)\n\n# $5\n```\nafter'), [
    { type: 'code', text: 'for x in y:\n    print(x)\n\n# $5', closed: true },
    { type: 'p', text: 'after' },
  ]);
  assert.deepEqual(blocks('~~~\na\n~~~'), [{ type: 'code', text: 'a', closed: true }]);
  assert.deepEqual(blocks('text\n```\nstill being wri'), [
    { type: 'p', text: 'text' },
    { type: 'code', text: 'still being wri', closed: false },
  ]);
});

test('blocks: a graph block is a diagram, closed or still being written', () => {
  assert.deepEqual(blocks('```graph\nA -> B : to\nB -> C\n```'), [{ type: 'graph', text: 'A -> B : to\nB -> C', closed: true }]);
  assert.deepEqual(blocks('``` Graph\nA -> B\n```'), [{ type: 'graph', text: 'A -> B', closed: true }]);
  assert.deepEqual(blocks('```graph\nA -> B\nB -'), [{ type: 'graph', text: 'A -> B\nB -', closed: false }]);
  // Any other language is code.
  assert.equal(blocks('```mermaid\nflowchart TD\n```')[0].type, 'code');
});

test('blocks: a display formula on one line, in both spellings', () => {
  assert.deepEqual(blocks('$$x^2 + y^2$$'), [{ type: 'math', tex: 'x^2 + y^2', closed: true }]);
  assert.deepEqual(blocks('  \\[ a = b \\]'), [{ type: 'math', tex: 'a = b', closed: true }]);
});

test('blocks: a display formula over several lines', () => {
  assert.deepEqual(blocks('$$\n\\sum_i x_i\n= 1\n$$'), [{ type: 'math', tex: '\\sum_i x_i\n= 1', closed: true }]);
  assert.deepEqual(blocks('\\[\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n\\]'), [
    { type: 'math', tex: '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}', closed: true },
  ]);
});

test('blocks: a formula ends the paragraph before it and starts one after it', () => {
  assert.deepEqual(blocks('Before it:\n$$a$$\nafter it'), [
    { type: 'p', text: 'Before it:' },
    { type: 'math', tex: 'a', closed: true },
    { type: 'p', text: 'after it' },
  ]);
});

test('blocks: words after a formula on the same line start the next paragraph', () => {
  assert.deepEqual(blocks('$$a = b$$ and then more\nof the sentence.'), [
    { type: 'math', tex: 'a = b', closed: true },
    { type: 'p', text: 'and then more of the sentence.' },
  ]);
  // Punctuation that only closes the sentence the formula ended is dropped.
  assert.deepEqual(blocks('$$a = b$$.'), [{ type: 'math', tex: 'a = b', closed: true }]);
  assert.deepEqual(blocks('$$a$$, where a is small'), [
    { type: 'math', tex: 'a', closed: true },
    { type: 'p', text: 'where a is small' },
  ]);
});

test('blocks: an unclosed formula at the end of the text is still being written', () => {
  assert.deepEqual(blocks('So:\n\n$$\\frac{a}{b'), [
    { type: 'p', text: 'So:' },
    { type: 'math', tex: '\\frac{a}{b', closed: false, raw: '$$\\frac{a}{b' },
  ]);
  assert.deepEqual(blocks('$$\na +\nb'), [{ type: 'math', tex: 'a +\nb', closed: false, raw: '$$ a + b' }]);
  assert.deepEqual(blocks('\\['), [{ type: 'math', tex: '', closed: false, raw: '\\[' }]);
});

test('blocks: an opening that is never closed before a blank line is read as text', () => {
  assert.deepEqual(blocks('$$ is how a formula opens\n\nNext paragraph.'), [
    { type: 'p', text: '$$ is how a formula opens' },
    { type: 'p', text: 'Next paragraph.' },
  ]);
  // An empty formula is not a formula either.
  assert.equal(blocks('$$$$\n\nmore')[0].type, 'p');
});

test('blocks: the order of a whole answer is kept', () => {
  const text = ['Opening.', '', '- a', '- b', '', '$$L = 1$$', '', '```graph', 'A -> B', '```', '', '```', 'code', '```', '', 'Closing.'].join('\n');
  assert.deepEqual(types(blocks(text)), ['p', 'ul', 'math', 'graph', 'code', 'p']);
});

// Tables and rules: Claude is asked for neither here, but an answer sent in
// from another conversation often has them.

test('blocks: a table, with the side each column is set to', () => {
  assert.deepEqual(blocks('| Draws | Error | Note |\n|---:|:---:|---|\n| 1 | big | the start |\n| 4 | half |\n\nAfter it.'), [
    { type: 'table', head: ['Draws', 'Error', 'Note'], align: ['right', 'center', ''], rows: [['1', 'big', 'the start'], ['4', 'half']] },
    { type: 'p', text: 'After it.' },
  ]);
  // Without the bars at the edges, and straight after a line of text.
  assert.deepEqual(blocks('Two columns:\na | b\n--- | ---\n1 | 2'), [
    { type: 'p', text: 'Two columns:' },
    { type: 'table', head: ['a', 'b'], align: ['', ''], rows: [['1', '2']] },
  ]);
});

test('blocks: a line with a bar in it is a table only above a line of dashes', () => {
  assert.deepEqual(types(blocks('The norm is written |x| here.\nAnd it goes on.')), ['p']);
  assert.deepEqual(types(blocks('a | b\n\n--- | ---')), ['p', 'p']);
});

test('cells: a bar inside code or a formula, or written \\|, does not end a cell', () => {
  assert.deepEqual(cells('| `a | b` | $|x|$ and $\\|v\\|$ | one \\| two |'), ['`a | b`', '$|x|$ and $\\|v\\|$', 'one | two']);
  assert.deepEqual(cells('a | | c'), ['a', '', 'c']);
});

test('blocks: a rule is a line of dashes, stars or underscores', () => {
  assert.deepEqual(types(blocks('Above.\n\n---\n\nBelow.\n\n* * *\n\n___')), ['p', 'hr', 'p', 'hr', 'hr']);
  // Straight under a line of text it still ends the paragraph.
  assert.deepEqual(blocks('Above.\n---\nBelow.'), [{ type: 'p', text: 'Above.' }, { type: 'hr' }, { type: 'p', text: 'Below.' }]);
  // A list item is not one, and neither are two dashes.
  assert.deepEqual(types(blocks('- item\n\n--')), ['ul', 'p']);
});

// ---------- runs and pieces ----------

test('runs: a formula inside a sentence', () => {
  assert.deepEqual(runs('Divide $z_i$ by $T$ first.'), [
    { t: 'Divide ', kind: undefined, href: undefined },
    { t: '$z_i$', kind: 'math', tex: 'z_i', mode: 'inline', within: undefined, href: undefined },
    { t: ' by ', kind: undefined, href: undefined },
    { t: '$T$', kind: 'math', tex: 'T', mode: 'inline', within: undefined, href: undefined },
    { t: ' first.', kind: undefined, href: undefined },
  ]);
});

test('runs: every run keeps its source text, so offsets into the answer hold', () => {
  const src = 'A $p_i = \\frac{1}{2}$ and `code` end';
  // Markup characters aside, the text of the runs is the text of the answer.
  assert.equal(plain(runs(src)), 'A $p_i = \\frac{1}{2}$ and code end');
});

test('runs: money is left alone', () => {
  for (const s of [
    'It costs $5 today and $10 tomorrow.',
    'Between $5 and $10, or $1,000.',
    'Pay $5/$10 a month.',
    'A lone $ sign, and another $ here.',
    'US$5 and US$10 are prices too.',
  ]) {
    assert.deepEqual(maths(runs(s)), [], s);
    assert.equal(plain(runs(s)), s, s);
  }
});

test('runs: \\$ is a plain dollar sign, never the edge of a formula', () => {
  const rs = runs('It is \\$7 with a coupon and \\$9 without, but $x$ is a formula.');
  assert.equal(plain(rs), 'It is $7 with a coupon and $9 without, but $x$ is a formula.');
  assert.deepEqual(maths(rs).map(r => r.tex), ['x']);
});

test('runs: a formula may hold an escaped dollar sign', () => {
  assert.deepEqual(maths(runs('The price $p = \\$5$ is fixed.')).map(r => r.tex), ['p = \\$5']);
});

test('runs: a formula inside bold text is a formula, marked as inside bold', () => {
  const rs = runs('Here **the bold part holds $x^2$ too** and more.');
  assert.deepEqual(rs.map(r => [r.t, r.kind, r.within]), [
    ['Here ', undefined, undefined],
    ['the bold part holds ', 'strong', undefined],
    ['$x^2$', 'math', 'strong'],
    [' too', 'strong', undefined],
    [' and more.', undefined, undefined],
  ]);
});

test('runs: code that contains dollars stays code', () => {
  const rs = runs('Use `$not_math$` and ``$a$ and $b$`` here, then $y$.');
  assert.deepEqual(rs.filter(r => r.kind === 'code').map(r => r.t), ['$not_math$', '$a$ and $b$']);
  assert.deepEqual(maths(rs).map(r => r.tex), ['y']);
});

test('runs: markup inside a formula or code is not read as markup', () => {
  const rs = runs('$a * b * c$ and `**not bold**` and *really* so.');
  assert.deepEqual(rs.map(r => [r.t, r.kind]), [
    ['$a * b * c$', 'math'], [' and ', undefined], ['**not bold**', 'code'], [' and ', undefined], ['really', 'em'], [' so.', undefined],
  ]);
});

test('runs: the other delimiters', () => {
  const rs = maths(runs('Inline \\(a^2 + b^2\\), displayed mid-sentence $$\\int_0^1 x$$ and \\[ z \\] too.'));
  assert.deepEqual(rs.map(r => [r.t, r.tex, r.mode]), [
    ['\\(a^2 + b^2\\)', 'a^2 + b^2', 'inline'],
    ['$$\\int_0^1 x$$', '\\int_0^1 x', 'inline-display'],
    ['\\[ z \\]', 'z', 'inline-display'],
  ]);
});

test('runs: emphasis, bold and links', () => {
  assert.deepEqual(runs('a **b** *c* [d](https://example.com/x) 2*3*4'), [
    { t: 'a ', kind: undefined, href: undefined },
    { t: 'b', kind: 'strong', href: undefined },
    { t: ' ', kind: undefined, href: undefined },
    { t: 'c', kind: 'em', href: undefined },
    { t: ' ', kind: undefined, href: undefined },
    { t: 'd', kind: 'a', href: 'https://example.com/x' },
    { t: ' 2*3*4', kind: undefined, href: undefined },
  ]);
  // Only http links become links.
  assert.equal(runs('[x](javascript:alert(1))').some(r => r.kind === 'a'), false);
});

test('pieces: text and formulas, for labels and quotes', () => {
  assert.deepEqual(pieces('the symbol $\\alpha$ in $$L = \\alpha T$$', MATH_RE), [
    { t: 'the symbol ' },
    { t: '$\\alpha$', kind: 'math', tex: '\\alpha', mode: 'inline' },
    { t: ' in ' },
    { t: '$$L = \\alpha T$$', kind: 'math', tex: 'L = \\alpha T', mode: 'inline-display' },
  ]);
  assert.deepEqual(pieces('no formulas, just $5', MATH_RE), [{ t: 'no formulas, just $5' }]);
});

test('formulaOnly: a passage that is one formula and nothing else', () => {
  assert.equal(formulaOnly('$$L = 1$$'), true);
  assert.equal(formulaOnly(' $x$ '), true);
  assert.equal(formulaOnly('\\(x\\)'), true);
  assert.equal(formulaOnly('where $x$ is small'), false);
  assert.equal(formulaOnly('plain words'), false);
});

// ---------- clip ----------

test('clip: short text is untouched, long text is cut with an ellipsis', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('exactly10!', 10), 'exactly10!');
  assert.equal(clip('plain text here', 8), 'plain t…');
  assert.equal(clip('one two three', 5), 'one…');
});

test('clip: never cuts a formula in half', () => {
  // The cut would fall inside the formula: stop before it.
  assert.equal(clip('abc $x^2 + y^2$ def ghi', 10), 'abc…');
  // The text starts with the formula: keep all of it.
  assert.equal(clip('$x^2 + y^2$ def ghi', 5), '$x^2 + y^2$…');
  assert.equal(clip('$$L = \\alpha T$$', 6), '$$L = \\alpha T$$');
  // The cut falls after the formula: the formula stays whole.
  assert.equal(clip('a $x$ and a long tail of words', 12), 'a $x$ and a…');
});

test('clip: at every length, what is left holds only whole formulas', () => {
  const s = 'Divide the logits $z_i$ by $T$, as in \\(p_i = e^{z_i/T}\\), then $$\\sum_j p_j = 1$$ holds and \\[ q = 2 \\] too.';
  const whole = new Set(pieces(s, MATH_RE).filter(p => p.kind).map(p => p.t));
  for (let n = 2; n <= s.length + 1; n++) {
    const out = clip(s, n).replace(/…$/, '');
    assert.ok(s.startsWith(out), `length ${n}: not the start of the text`);
    const rest = pieces(out, MATH_RE).map(p => (p.kind ? (whole.has(p.t) ? '' : '?') : p.t)).join('');
    assert.ok(!/[$?]|\\[([\])]/.test(rest), `length ${n}: half a formula is left in "${out}"`);
  }
});

// ---------- diagrams ----------

test('parseGraph: one relation per line, with an optional label', () => {
  assert.deepEqual(parseGraph('Teacher -> Soft targets : softened by T\nSoft targets -> Student'), {
    nodes: [{ label: 'Teacher' }, { label: 'Soft targets' }, { label: 'Student' }],
    edges: [
      { from: 0, to: 1, label: 'softened by T', both: false, plain: false },
      { from: 1, to: 2, label: '', both: false, plain: false },
    ],
  });
});

test('parseGraph: the kinds of link', () => {
  const g = parseGraph('A <-> B\nC -- D\nE --> F\nG → H\nI ↔ J\nK ---> L');
  assert.deepEqual(g.edges.map(e => [e.both, e.plain]), [[true, false], [false, true], [false, false], [false, false], [true, false], [false, false]]);
});

test('parseGraph: the same thing spelled twice is one box', () => {
  const g = parseGraph('Soft targets -> Student\nsoft  targets -> Teacher\n"Student" -> [Teacher]');
  assert.deepEqual(g.nodes.map(n => n.label), ['Soft targets', 'Student', 'Teacher']);
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [[0, 1], [0, 2], [1, 2]]);
});

test('parseGraph: a chain on one line, with the label on its last link', () => {
  const g = parseGraph('A -> B -> C : ends here');
  assert.deepEqual(g.edges, [
    { from: 0, to: 1, label: '', both: false, plain: false },
    { from: 1, to: 2, label: 'ends here', both: false, plain: false },
  ]);
});

test('parseGraph: what is skipped', () => {
  const g = parseGraph('graph TD\nflowchart LR\n%% a comment\n\nA -> A\nLone box\nA -> B');
  assert.deepEqual(g.nodes.map(n => n.label), ['A', 'Lone box', 'B']);
  assert.deepEqual(g.edges.map(e => [e.from, e.to]), [[0, 2]]);
});

test('parseGraph: a colon inside a name is not a label', () => {
  const g = parseGraph('Step 1:prepare -> Step 2 : then');
  assert.deepEqual(g.nodes.map(n => n.label), ['Step 1:prepare', 'Step 2']);
  assert.equal(g.edges[0].label, 'then');
});

test('parseGraph: a runaway diagram is capped', () => {
  const big = Array.from({ length: 40 }, (_, i) => `N${i} -> N${i + 1}`).join('\n');
  const g = parseGraph(big);
  assert.equal(g.nodes.length, 16);
  assert.ok(g.edges.length <= 28);
  assert.ok(g.edges.every(e => e.from < 16 && e.to < 16));
});

test('edgeText: a link in words', () => {
  const g = parseGraph('A -> B : makes\nB <-> C\nC -- D');
  assert.deepEqual(g.edges.map(e => edgeText(g, e)), ['A → B (makes)', 'B ↔ C', 'C — D']);
});

test('toMermaid: the same relations as a Mermaid flowchart', () => {
  assert.equal(toMermaid('Question -> Stand-in runtime : sent to\nStand-in runtime -- Page\nPage <-> Question : say "hi"'), [
    '```mermaid',
    'flowchart TD',
    '  n0["Question"]',
    '  n1["Stand-in runtime"]',
    '  n2["Page"]',
    '  n0 -->|"sent to"| n1',
    '  n1 --- n2',
    '  n2 <-->|"say \'hi\'"| n0',
    '```',
  ].join('\n'));
});

// ---------- sentences ----------

const sentences = (s, locked = []) => sentenceSpans(s, locked).map(([a, b]) => s.slice(a, b));

test('sentenceSpans: one span per sentence, without the space between', () => {
  const s = 'First one. Second one! Third one?  Fourth.';
  assert.deepEqual(sentences(s), ['First one.', 'Second one!', 'Third one?', 'Fourth.']);
  assert.deepEqual(sentenceSpans(s, [])[1], [11, 22]);
});

test('sentenceSpans: an abbreviation does not end a sentence', () => {
  assert.deepEqual(sentences('Drag across a few words, e.g. this one. Then ask.'), ['Drag across a few words, e.g. this one.', 'Then ask.']);
  assert.deepEqual(sentences('Compare A vs. B here. Done.'), ['Compare A vs. B here.', 'Done.']);
});

test('sentenceSpans: never cuts inside code or a formula', () => {
  const s = 'Call a. b now. Next.';
  // [5, 9) is a piece of code, "a. b", that holds a full stop.
  assert.deepEqual(sentences(s, [[5, 9]]), ['Call a. b now.', 'Next.']);
});

test('sentenceSpans: spans cover all the text and do not overlap', () => {
  const s = '  Leading space. Trailing space.  ';
  const spans = sentenceSpans(s, []);
  assert.deepEqual(spans.map(([a, b]) => s.slice(a, b)), ['Leading space.', 'Trailing space.']);
  spans.forEach(([a, b], i) => { assert.ok(a < b); if (i) assert.ok(a >= spans[i - 1][1]); });
  assert.deepEqual(sentenceSpans('', []), []);
  assert.deepEqual(sentences('no full stop'), ['no full stop']);
});

test('sentenceSpans: Japanese sentences', () => {
  assert.deepEqual(sentences('これは文です。これも文です。'), ['これは文です。', 'これも文です。']);
});

// ---------- terms ----------

test('findTerm: a whole word, whatever its case', () => {
  assert.deepEqual(findTerm('Concatenate the cat.', 'cat', []), [16, 19]);
  assert.deepEqual(findTerm('The Softmax function', 'softmax', []), [4, 11]);
  assert.equal(findTerm('concatenate', 'cat', []), null);
  assert.equal(findTerm('nothing here', 'logits', []), null);
});

test('findTerm: a plural counts', () => {
  assert.deepEqual(findTerm('Two hard labels.', 'hard label', []), [4, 15]);
  assert.equal(findTerm('It is labelsome.', 'label', []), null);
});

test('findTerm: skips text that is already taken', () => {
  const full = 'KL divergence, then KL divergence again.';
  assert.deepEqual(findTerm(full, 'KL divergence', []), [0, 13]);
  assert.deepEqual(findTerm(full, 'KL divergence', [[0, 13]]), [20, 33]);
  assert.equal(findTerm(full, 'KL divergence', [[0, 13], [22, 24]]), null);
});

test('findTerm: a term that starts or ends with a sign', () => {
  assert.deepEqual(findTerm('Run with (beta) on.', '(beta)', []), [9, 15]);
  assert.deepEqual(findTerm('温度を上げる。', '温度', []), [0, 2]);
});

test('iou: how much two passages overlap', () => {
  assert.equal(iou({ start: 0, end: 10 }, { start: 0, end: 10 }), 1);
  assert.equal(iou({ start: 0, end: 10 }, { start: 10, end: 20 }), 0);
  assert.equal(iou({ start: 0, end: 10 }, { start: 5, end: 15 }), 5 / 15);
});

// ---------- LLM.parse ----------

test('LLM.parse: the answer, its terms and its next questions', () => {
  const raw = [
    'The answer itself.',
    '',
    'A second paragraph.',
    '',
    '@@@',
    'term: stand-in runtime = a local replacement for Claude.',
    'term: inline code = A short piece of code set inside a sentence.',
    'next: What would a real answer look like?',
    'next: What happens on an error?',
  ].join('\n');
  assert.deepEqual(LLM.parse(raw), {
    text: 'The answer itself.\n\nA second paragraph.',
    terms: [
      { term: 'stand-in runtime', gloss: 'A local replacement for Claude.' },
      { term: 'inline code', gloss: 'A short piece of code set inside a sentence.' },
    ],
    next: ['What would a real answer look like?', 'What happens on an error?'],
  });
});

test('LLM.parse: an answer with no trailer', () => {
  assert.deepEqual(LLM.parse('Just an answer.\n'), { text: 'Just an answer.', terms: [], next: [] });
  assert.deepEqual(LLM.parse(''), { text: '', terms: [], next: [] });
  assert.deepEqual(LLM.parse(null), { text: '', terms: [], next: [] });
});

test('LLM.parse: forgiving about how the trailer lines are written', () => {
  const p = LLM.parse([
    'Body.',
    '@@@',
    '- term: **Dark knowledge** = what a model knows beyond its top answer',
    '* Term : `logits`=raw scores',
    'term: <softmax> = <turns scores into probabilities>',
    'term: dark knowledge = a repeat that is dropped',
    'term: no definition here',
    'NEXT: "Why does it help?"',
    'next: <What is T?>',
    'something else entirely',
  ].join('\n'));
  assert.deepEqual(p.terms, [
    { term: 'Dark knowledge', gloss: 'What a model knows beyond its top answer' },
    { term: 'logits', gloss: 'Raw scores' },
    { term: 'softmax', gloss: 'Turns scores into probabilities' },
  ]);
  assert.deepEqual(p.next, ['Why does it help?', 'What is T?']);
});

test('LLM.parse: a definition may itself contain an equals sign', () => {
  assert.deepEqual(LLM.parse('B.\n@@@\nterm: temperature = A number T. T = 1 changes nothing.').terms, [
    { term: 'temperature', gloss: 'A number T. T = 1 changes nothing.' },
  ]);
});

test('LLM.parse: at most three next questions', () => {
  assert.deepEqual(LLM.parse('B.\n@@@\nnext: 1?\nnext: 2?\nnext: 3?\nnext: 4?').next, ['1?', '2?', '3?']);
});

test('LLM.parse: while the answer is being written, a half-written trailer is hidden', () => {
  const full = 'The answer.\n\n@@@\nterm: logits = Raw scores.\nnext: Why?';
  // Whatever has arrived so far, the reader never sees a piece of the trailer.
  for (let n = 'The answer.'.length; n <= full.length; n++) {
    const p = LLM.parse(full.slice(0, n));
    assert.equal(p.text, 'The answer.', `after ${n} characters the text was ${JSON.stringify(p.text)}`);
  }
  assert.deepEqual(LLM.parse('The answer.\n\n@@@\nterm: logits = Raw sc').terms, [{ term: 'logits', gloss: 'Raw sc' }]);
  assert.deepEqual(LLM.parse('The answer.\n\n@@@\nterm: log').terms, []);
});

test('LLM.parse: an @ that is part of the answer is kept', () => {
  assert.equal(LLM.parse('Write to me\n@home').text, 'Write to me\n@home');
  assert.equal(LLM.parse('a\n@@@@').text, 'a\n@@@@');
});

test('LLM.parse: trailer lines with the separator left out are still read', () => {
  assert.deepEqual(LLM.parse('The answer.\n\nterm: logits = Raw scores.\nnext: Why?\n'), {
    text: 'The answer.',
    terms: [{ term: 'logits', gloss: 'Raw scores.' }],
    next: ['Why?'],
  });
  // But a line like that in the middle of an answer is part of the answer.
  assert.equal(LLM.parse('First.\nnext: is a word here\nLast.').text, 'First.\nnext: is a word here\nLast.');
});

test('LLM.parse: what follows the separator never shows, even if it is not a trailer', () => {
  assert.deepEqual(LLM.parse('The answer.\n@@@\nstray words'), { text: 'The answer.', terms: [], next: [] });
});

// ---------- the questions sent to Claude ----------

test('prompts: each kind of pointing names what was pointed at', () => {
  assert.match(LLM.passagePrompt('a sentence.', 'explain'), /^About this part of your answer:\n"a sentence\."\n\nExplain this part further/);
  assert.equal(LLM.askPrompt('a sentence.', 'Why?'), 'About this part of your answer:\n"a sentence."\n\nWhy?');
  assert.match(LLM.formulaPrompt('$$L = 1$$', ''), /^About this formula in your answer: \$\$L = 1\$\$\n\nExplain this formula/);
  assert.equal(LLM.formulaPrompt('$$L = 1$$', 'Why 1?'), 'About this formula in your answer: $$L = 1$$\n\nWhy 1?');
  assert.match(LLM.symbolPrompt('\\alpha', '$$L = \\alpha$$', ''), /^About the symbol \$\\alpha\$ in this formula from your answer: \$\$L = \\alpha\$\$\n\nWhat does this symbol stand for/);
  assert.match(LLM.partPrompt('A → B (makes)', ''), /^About this part of your diagram: "A → B \(makes\)"\n\nExplain this part further/);
  assert.match(LLM.termPrompt('logits'), /^About this term in your answer: "logits"/);
  assert.match(LLM.followPrompt('a sentence.', 'why'), /^Still about the part I pointed at \("a sentence\."\): Why is this true\?/);
});

// The page words a button's question in English. Claude would take that for
// the person's language, so each one says at its end that the app wrote it.
test('prompts: a question the app worded says so, and a typed one does not', () => {
  const worded = [
    LLM.passagePrompt('a sentence.', 'explain'), LLM.passagePrompt('a sentence.', 'why'),
    LLM.formulaPrompt('$$L = 1$$', ''), LLM.symbolPrompt('\\alpha', '$$L = \\alpha$$', ''), LLM.partPrompt('A', ''),
    LLM.termPrompt('logits'), LLM.followPrompt('a sentence.', 'example'), LLM.DRAW,
  ];
  for (const p of worded) assert.ok(p.endsWith(LLM.WORDED), p);
  const typed = [
    LLM.askPrompt('a sentence.', 'なぜ？'), LLM.formulaPrompt('$$L = 1$$', 'なぜ？'),
    LLM.symbolPrompt('\\alpha', '$$L = \\alpha$$', 'なぜ？'), LLM.partPrompt('A', 'なぜ？'),
    LLM.backPrompt('this whole conversation', 'それは X です。'),
  ];
  for (const p of typed) assert.ok(!p.includes(LLM.WORDED), p);
  assert.match(LLM.WORDED, /^\n\n\(.*language of the answer.*\)$/);
});

test('prompts: an explanation to be checked names what it explains, and comes last', () => {
  const p = LLM.backPrompt('this whole conversation', 'It is X.\nBecause Y.');
  assert.match(p, /^I will now explain this whole conversation back in my own words/);
  assert.match(p, /"\*\*Right:\*\*".*"\*\*Off or missing:\*\*".*"\*\*Check yourself:\*\*"/);
  assert.ok(p.endsWith('\n\nMy explanation:\nIt is X.\nBecause Y.'));
});

test('errors: every code has words for the reader, and the final ones are known', () => {
  for (const code of ['no_runtime', 'not_granted', 'refused', 'rate_limited', 'upstream_error', 'interrupted', undefined]) {
    assert.ok(LLM.errorText(code).length > 20, String(code));
  }
  assert.equal(LLM.isFinal('not_granted'), true);
  assert.equal(LLM.isFinal('refused'), false);
});
