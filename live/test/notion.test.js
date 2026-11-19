// Notion tests: how a page is handed to Claude, above all a long one, which
// goes in parts. No browser, no dependencies.
//   Run:  node --test live/test/notion.test.js
//
// llm.js is run whole against a small stand-in for the runtime: `sample`
// plays Claude by calling the page's tools as a script says, and `mcp`
// returns the pages the test gives it.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { llm } = require('./extract.js');

const bytes = s => new TextEncoder().encode(s).length;
const jsonSize = s => bytes(JSON.stringify(s));
const LIMIT = 32000; // what the runtime accepts from a page function, JSON-encoded

// pages: { id: text }. script(fetch, search) is what "Claude" does before it
// answers. Returns what ask() returned, and the calls made to Notion.
async function run(pages, script, extra) {
  const calls = [];
  const sent = [];
  const sample = async (turns, opts) => {
    sent.push(turns);
    const ctx = { signal: new AbortController().signal };
    const tool = name => input => opts.tools.find(t => t.name === name).execute(input, ctx);
    if (opts.tools) await script(tool('notion_fetch'), tool('notion_search'));
    return { text: 'An answer.\n@@@\nnext: More?', truncated: false };
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 8 } });
  const mcp = {
    async callTool(server, tool, input) {
      calls.push([tool, input.id || input.query]);
      if (!(input.id in pages)) throw { code: 'tool_error', message: 'Could not find a page with that ID.' };
      return { payload: { title: 'Handover', url: 'https://www.notion.so/handover', text: pages[input.id] } };
    },
  };
  const LLM = llm({ claude: { use: async name => (name === 'sample' ? sample : name === 'mcp' ? mcp : null) } });
  const seen = [];
  const res = await LLM.ask({ prompt: 'Summarise the page', history: [], notion: true, onTool: list => seen.push(list.map(s => s.state).join()), ...extra });
  return { res, calls, sent, seen, LLM };
}

// The page text inside one part, without the notes around it.
const body = part => part
  .replace(/^\[Part [^\n]*\]\n/, '')
  .replace(/^\[What each part holds:\n[\s\S]*?\]\n/, '')
  .replace(/\n\[End of part \d+ of \d+\.\]$/, '');

const section = (i, n) => `## ${i}. Section ${i}\n\n` + `節${i}の本文です。これは引継ぎ書の代わりの文章です。 Line of section ${i}.\n`.repeat(n);
const LONG = '# Handover\n\n' + [1, 2, 3, 4, 5, 6, 7, 8].map(i => section(i, 160)).join('\n');

test('a short page goes whole, with no talk of parts', async () => {
  const text = '# Short\n\nA few lines.\n';
  let got;
  const { res, calls } = await run({ a: text }, async fetch => { got = await fetch({ id: 'a' }); });
  assert.equal(got, text);
  assert.deepEqual(calls, [['notion-fetch', 'a']]);
  assert.deepEqual(res.sources, [{ kind: 'page', title: 'Handover', url: 'https://www.notion.so/handover', state: 'done', error: undefined, text, whole: true }]);
});

test('a long page comes in parts that fit a tool result and together are the whole page', async () => {
  assert.ok(jsonSize(LONG) > 3 * LIMIT, 'the test page is long');
  const got = [];
  const { calls, res } = await run({ a: LONG }, async fetch => {
    got.push(await fetch({ id: 'a' }));
    const n = Number(/^\[Part 1 of (\d+)/.exec(got[0])[1]);
    got.push(...await Promise.all(Array.from({ length: n - 1 }, (_, i) => fetch({ id: 'a', part: i + 2 }))));
  });
  assert.ok(got.length >= 4, `${got.length} parts`);
  got.forEach((p, i) => assert.ok(jsonSize(p) <= LIMIT, `part ${i + 1} is ${jsonSize(p)} bytes`));
  assert.equal(got.map(body).join(''), LONG);
  assert.deepEqual(calls, [['notion-fetch', 'a']], 'Notion is asked for the page once');
  got.forEach((p, i) => {
    assert.match(p, new RegExp(`^\\[Part ${i + 1} of ${got.length} of “Handover”\\.`));
    assert.ok(p.endsWith(`\n[End of part ${i + 1} of ${got.length}.]`));
    assert.equal(/What each part holds/.test(p), i === 0, 'only the first result lists the parts');
  });
  assert.match(got[0], /call notion_fetch again with the same id and "part"/);
  const [src] = res.sources;
  assert.deepEqual([src.parts, src.of, src.state], [got.map((_, i) => i + 1), got.length, 'done']);
  assert.match(src.text, /^\[This page is long and comes in \d+ parts\. All of them were read for this answer/);
});

test('the list of parts names the headings in each, and skips "#" lines inside code', async () => {
  const page = '# Top\n\n```\n# not a heading\n```\n\n' + section(1, 150) + '\n```bash\n# also not one\n' + 'echo ok\n'.repeat(4000) + '```\n\n## Last {toggle="true"}\n\nEnd.\n';
  let first;
  await run({ a: page }, async fetch => { first = await fetch({ id: 'a' }); });
  const list = /\[What each part holds:\n([\s\S]*?)\]\n/.exec(first)[1].split('\n');
  assert.equal(list[0], 'part 1: Top; 1. Section 1');
  assert.ok(list.some(l => /^part \d+: no headings, starts “echo ok”$/.test(l)), list.join(' | '));
  assert.match(list[list.length - 1], /^part \d+: Last$/);
  assert.ok(!/not a heading|also not one/.test(list.join('\n')));
});

test('a line longer than a part is cut between characters, never through one', async () => {
  const page = 'start\n' + '😀'.repeat(20000) + '\nend';
  const got = [];
  await run({ a: page }, async fetch => {
    got.push(await fetch({ id: 'a' }));
    const n = Number(/^\[Part 1 of (\d+)/.exec(got[0])[1]);
    for (let k = 2; k <= n; k++) got.push(await fetch({ id: 'a', part: k }));
  });
  assert.ok(got.length > 2);
  got.forEach(p => assert.doesNotThrow(() => encodeURIComponent(p), 'no half of a character'));
  assert.equal(got.map(body).join(''), page);
});

test('the source says which parts were read, and that travels to the next question', async () => {
  const { res, LLM, sent } = await run({ a: LONG }, async fetch => { await fetch({ id: 'a' }); await fetch({ id: 'a', part: 3 }); });
  const [src] = res.sources;
  assert.deepEqual([src.parts, src.state], [[1, 3], 'done']);
  assert.match(src.text, /^\[This page is long and comes in \d+ parts\. Only parts 1, 3 of \d+ were read for this answer\.\]\n\[What each part holds:\npart 1: Handover; 1\. Section 1/);
  // Two parts are within what one answer carries, so they travel whole, with
  // a mark where the part between them is missing.
  assert.ok(src.text.includes('\n[…]\n') && !src.text.includes('The rest is not repeated'));
  assert.ok(bytes(src.text) > 40000 && bytes(src.text) < 60000, `${bytes(src.text)} bytes carried`);
  assert.equal(LLM.partSpan([1, 2, 3, 5]), 'parts 1–3, 5');
  assert.equal(LLM.partSpan([2]), 'part 2');

  const history = [{ prompt: 'Summarise the page', raw: res.raw, sources: res.sources }];
  await LLM.ask({ prompt: 'And then?', history, notion: false });
  const off = sent[sent.length - 1][1].content;
  assert.ok(off.startsWith('Summarise the page\n\n[For this question this page of my Notion was read and shown to you. Each line below that starts with "---" names a page and says how much of it was read then. To save space the text of a long page is repeated only in part, with a note where the repeat stops. Where it stops says nothing about how much was read: go by the line. If a question needs something that is not repeated here, say that this part of the page is not in front of you now, and that I can ask again with "Look in my Notion" ticked. Do not say that the page was not read.]\n--- 1. “Handover” (https://www.notion.so/handover): only parts 1, 3 of '), off.slice(0, 700));
  assert.match(off, /: only parts 1, 3 of \d+ read\n\[This page is long and comes in/);

  // A question that may look in Notion is told to read again instead.
  await LLM.ask({ prompt: 'And then?', history, notion: true });
  const on = sent[sent.length - 1][1].content;
  assert.ok(on.includes('If you need more of a page than is repeated here, read it again with notion_fetch.]\n--- 1. ') && !on.includes('ticked'));
});

test('every page an answer read travels on: short ones whole, long ones sharing the rest', async () => {
  const pages = {};
  ['s1', 's2', 's3', 's4'].forEach((id, i) => { pages[id] = `# Short ${i}\n\n` + 'A short chapter.\n'.repeat(40); });
  ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].forEach((id, i) => { pages[id] = section(i + 1, 220); });
  Object.values(pages).forEach(t => assert.ok(jsonSize(t) <= 30000, 'each page fits one result'));
  const ids = Object.keys(pages).reverse(); // the long ones first: the order read must not matter
  const { res, LLM, sent } = await run(pages, async fetch => { for (const id of ids) await fetch({ id }); });
  assert.deepEqual(res.sources.map(s => [s.state, s.whole]), ids.map(() => ['done', true]));
  const CUT = '\n[Only this much is repeated here. The page was read to its end.]';
  const short = res.sources.slice(6), long = res.sources.slice(0, 6);
  assert.deepEqual(short.map(s => s.text), ['s4', 's3', 's2', 's1'].map(id => pages[id]), 'short pages travel whole');
  long.forEach((s, i) => {
    assert.ok(s.text.endsWith(CUT), 'a long page is cut, and says so');
    assert.ok(pages[ids[i]].startsWith(s.text.slice(0, -CUT.length)), 'what travels is the start of the page');
  });
  const sizes = long.map(s => bytes(s.text));
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 200, `long pages get the same share: ${sizes}`);
  const total = res.sources.reduce((a, s) => a + bytes(s.text), 0);
  assert.ok(total > 59000 && total <= 60000 + 6 * bytes(CUT), `${total} bytes carried in all`);

  // The next question is told that each page was read whole, cut or not.
  await LLM.ask({ prompt: 'Were they all read?', history: [{ prompt: 'Summarise', raw: res.raw, sources: res.sources }], notion: false });
  const lines = sent[sent.length - 1][1].content.split('\n').filter(l => l.startsWith('--- '));
  assert.deepEqual(lines, ids.map((_, i) => `--- ${i + 1}. “Handover” (https://www.notion.so/handover): read whole`));
});

test('a long page read to its last part is said to be read whole, and one read in part is not', async () => {
  const got = { whole: null, some: null };
  const { res: all } = await run({ a: LONG }, async fetch => {
    const n = Number(/^\[Part 1 of (\d+)/.exec(await fetch({ id: 'a' }))[1]);
    for (let k = 2; k <= n; k++) await fetch({ id: 'a', part: k });
  });
  const { res: part, LLM, sent } = await run({ a: LONG }, async fetch => { await fetch({ id: 'a' }); });
  got.whole = all.sources[0];
  got.some = part.sources[0];
  assert.ok(got.whole.text.endsWith('\n[Only this much is repeated here. The page was read to its end.]'));
  assert.ok(!got.some.text.includes('Only this much is repeated here'), 'one part is within what an answer carries');
  await LLM.ask({ prompt: 'Next', history: [{ prompt: 'A', raw: 'a', sources: all.sources }, { prompt: 'B', raw: 'b', sources: part.sources }], notion: false });
  const lines = sent[sent.length - 1].map(t => t.content).join('\n').split('\n').filter(l => l.startsWith('--- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /: read whole, in \d+ parts$/);
  assert.match(lines[1], /: only part 1 of \d+ read$/);
});

test('pages an older answer read are named even where their text is not kept', async () => {
  const sources = [
    { kind: 'search', query: 'handover', hits: 3, state: 'done' },
    { kind: 'page', title: 'Kept', url: 'https://www.notion.so/kept', state: 'done', text: 'The text of the first.' },
    { kind: 'page', title: 'Dropped', url: '', state: 'done', text: '' },
    { kind: 'page', title: 'Cut', url: '', state: 'done', text: 'Its start.\n[The rest of this page was left out.]' },
    { kind: 'page', title: 'Failed', url: '', state: 'error', error: 'No such page.', text: '' },
  ];
  const { sent } = await run({}, async () => {}, { history: [{ prompt: 'First', raw: 'An answer.', sources }], notion: false });
  const said = sent[0][1].content;
  assert.ok(said.startsWith('First\n\n[For this question these 3 pages of my Notion were read and shown to you. '));
  assert.ok(said.endsWith(']\n--- 1. “Kept” (https://www.notion.so/kept): read whole\nThe text of the first.\n--- 2. “Dropped”: read, but how far is not recorded\n[Not repeated here.]\n--- 3. “Cut”: read, but how far is not recorded\nIts start.\n[The rest of this page was left out.]'), said.slice(-300));
  assert.ok(!said.includes('Failed'));
});

test('when the thread is too long to send, the oldest pages are cut down to their names', async () => {
  const page = (title, n) => ({ kind: 'page', title, url: '', state: 'done', text: 'x'.repeat(n), parts: [1, 2], of: 5 });
  const history = [
    { prompt: 'First', raw: 'One.', sources: [page('Old', 150000)] },
    { prompt: 'Second', raw: 'Two.', sources: [page('New', 150000)] },
  ];
  const { sent } = await run({}, async () => {}, { history, notion: true });
  const turns = sent[0];
  assert.deepEqual(turns.map(t => t.role), ['user', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(turns[1].content, 'First\n\n[For this question this page of my Notion was read and shown to you: “Old”: only parts 1–2 of 5 read. To save space their text is not repeated here. If you need more of a page than is repeated here, read it again with notion_fetch.]');
  assert.ok(turns[3].content.includes('--- 1. “New”: only parts 1–2 of 5 read\nxxxx') && bytes(turns[3].content) > 150000);
});

test('reading a part twice costs nothing, and a part that does not exist is refused without spoiling the source', async () => {
  let again, wrong, none;
  const { res } = await run({ a: LONG, b: 'short' }, async fetch => {
    const first = await fetch({ id: 'a' });
    again = await fetch({ id: 'a', part: 1 });
    assert.equal(body(again), body(first));
    wrong = await fetch({ id: 'a', part: 99 }).catch(e => e.message);
    none = await fetch({ id: 'b', part: 2 }).catch(e => e.message);
  });
  assert.match(again, /^\[Part 1 of \d+ of “Handover”\.\]\n/, 'the list of parts is not sent twice');
  assert.match(wrong, /^This page has parts 1 to \d+\.$/);
  assert.equal(none, 'This page is short and has no parts. Leave "part" out.');
  assert.deepEqual(res.sources.map(s => [s.state, s.parts]), [['done', [1]], ['error', undefined]]);
});

test('one answer reads only so much, and says so to Claude', async () => {
  const huge = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(i => section(i, 300)).join('\n');
  const got = [];
  const { res } = await run({ a: huge }, async fetch => {
    const first = await fetch({ id: 'a' });
    const n = Number(/^\[Part 1 of (\d+)/.exec(first)[1]);
    assert.ok(n > 9, `${n} parts`);
    got.push(...await Promise.all(Array.from({ length: n - 1 }, (_, i) => fetch({ id: 'a', part: i + 2 }).catch(e => e.message))));
  });
  const refused = got.filter(g => /^No more can be read for this one answer\./.test(g));
  assert.ok(refused.length > 0 && refused.length < got.length, `${refused.length} of ${got.length} refused`);
  const read = res.sources[0].parts.length;
  assert.equal(read, 1 + got.length - refused.length);
  assert.ok(read * 25000 <= 180000 + 25000, `${read} parts read`);
});

test('a long thread leaves less room for pages, but never none', async () => {
  const history = [{ prompt: 'x'.repeat(200000), raw: 'y' }];
  const got = [];
  await run({ a: LONG }, async fetch => {
    for (let k = 1; k <= 3; k++) got.push(await fetch({ id: 'a', part: k }).catch(e => e.message));
  }, { history });
  assert.deepEqual(got.map(g => /^\[Part/.test(g)), [true, true, false]);
});

test('a page that cannot be read is an error, and a second try asks Notion again', async () => {
  const pages = {};
  let first, second;
  const { res, calls, seen } = await run(pages, async fetch => {
    first = await fetch({ id: 'a' }).catch(e => e.message);
    pages.a = 'now it is there';
    second = await fetch({ id: 'a' });
  });
  assert.equal(first, 'Notion returned an error: Could not find a page with that ID.');
  assert.equal(second, 'now it is there');
  assert.deepEqual(calls, [['notion-fetch', 'a'], ['notion-fetch', 'a']]);
  assert.deepEqual(res.sources.map(s => s.state), ['error', 'done']);
  assert.deepEqual(seen, ['running', 'error', 'error,running', 'error,done']);
});
