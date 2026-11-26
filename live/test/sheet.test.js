// Sheet tests: the questions an answer sent to the page asks its reader. How
// the sender's list is read, where a question is found in the text, what
// Claude is told of the reader's answers, how a proposed answer is read, and
// the reply the reader takes back. No browser, no dependencies.
//   Run:  node --test live/test/sheet.test.js

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { llm, fromApp } = require('./extract.js');

const LLM = llm();
const { findQuote } = fromApp(['findQuote']);

const entry = (id, q, state, answer, why) => ({ id, q, state, answer: answer || '', why: why || '', from: '', quote: '', start: null, end: null });
const SHEET = {
  rev: 3, checked: 0, copied: 0, node: 'root',
  asks: [
    entry('q1', 'Does the file need to open in a spreadsheet?', 'answered', 'Yes'),
    entry('q2', 'Who will read it?', 'answered', 'My team\nonly', 'Two colleagues review it each month.'),
    entry('q3', 'Local time or UTC?', 'left'),
    entry('q4', 'Which columns come first?', 'open'),
  ],
};

// ---------- the sender's list ----------

test('a sent document may list the questions its answer asks', () => {
  const g = LLM.fromInbox({
    answer: 'It depends on who reads it. Do they have accounts?',
    questions: [
      { quote: ' Do they have accounts? ', question: 'Do the people you will share\nit with have accounts?' },
      { question: 'A question with no quote?' },
      { quote: 'A quote with no question' },
      'not an entry', null,
    ],
  });
  assert.deepEqual(g.asks, [
    { quote: 'Do they have accounts?', q: 'Do the people you will share it with have accounts?' },
    { quote: '', q: 'A question with no quote?' },
  ]);
});

test('a document that lists no question has no sheet', () => {
  assert.ok(!('asks' in LLM.fromInbox({ answer: 'An answer.' })));
  assert.ok(!('asks' in LLM.fromInbox({ answer: 'An answer.', questions: [] })));
  assert.ok(!('asks' in LLM.fromInbox({ answer: 'An answer.', questions: 'Which one?' })));
  assert.ok(!('asks' in LLM.fromInbox({ answer: 'An answer.', questions: [{ quote: 'only a quote' }] })));
});

// ---------- where a question stands in the text ----------

test('findQuote: the words as they are', () => {
  const full = 'It matters who reads it. Will it? Then the dates.';
  assert.deepEqual(findQuote(full, 'Will it?'), [25, 33]);
  assert.deepEqual(findQuote(full, '  Will it?\n'), [25, 33]);
  assert.equal(findQuote(full, 'Would it?'), null);
  assert.equal(findQuote(full, ''), null);
  assert.equal(findQuote(full, null), null);
});

test('findQuote: the sender copied the source, the page holds the drawn text', () => {
  // Bold and code lose their marks when drawn; a link loses its address.
  const full = 'Stored in UTC. Which do you want: UTC or local time? See the notes.';
  const hit = findQuote(full, 'Which do you want: `UTC` or **local time**?');
  assert.equal(full.slice(hit[0], hit[1]), 'Which do you want: UTC or local time?');
  const linked = findQuote('Have you read the handover page yet? No.', 'Have you read [the handover page](https://www.notion.so/handover) yet?');
  assert.deepEqual(linked, [0, 36]);
  // Spacing that differs, and a line break the sender kept.
  assert.deepEqual(findQuote('Is  it\nweekly?', 'Is it weekly?'), [0, 14]);
});

test('findQuote: Japanese, and the mark that closes the question', () => {
  const full = '保存先を決めます。月次で出力しますか？それとも週次ですか？';
  const hit = findQuote(full, '**月次**で出力しますか？');
  assert.equal(full.slice(hit[0], hit[1]), '月次で出力しますか？');
});

test('findQuote: too little to go by is not matched', () => {
  assert.equal(findQuote('a b c ?', '?'), null);
  assert.equal(findQuote('What now? x', 'x?'), null);
});

// ---------- what Claude is told ----------

test('the sheet as Claude is told it: every question with the answer so far', () => {
  assert.equal(LLM.sheetNote(SHEET, 'q2'), [
    '',
    '',
    '(The app added this note. The questions your sent answer asks me, and my answers so far:',
    '1. Does the file need to open in a spreadsheet?',
    '   My answer: Yes',
    '2. Who will read it?',
    '   My answer: My team only',
    '   Why: Two colleagues review it each month.',
    '3. Local time or UTC?',
    '   Left to you.',
    '4. Which columns come first?',
    '   Not answered yet.',
    'This thread is about question 2.)',
  ].join('\n'));
});

test('the sheet outside a question\'s thread names no question; one question is said in the singular; none is nothing', () => {
  assert.ok(!LLM.sheetNote(SHEET, null).includes('This thread is about'));
  assert.ok(!LLM.sheetNote(SHEET, 'gone').includes('This thread is about'));
  assert.equal(LLM.sheetNote({ asks: [SHEET.asks[3]] }, null),
    '\n\n(The app added this note. The question your sent answer asks me, and my answer so far:\n1. Which columns come first?\n   Not answered yet.)');
  assert.equal(LLM.sheetNote({ asks: [] }, null), '');
  assert.equal(LLM.sheetNote(null, null), '');
});

// What a question in the thread of `about` sends, given the conversation's sheet.
async function sent(extra) {
  const got = [];
  const sample = async turns => { got.push(turns); return { text: 'An answer.\n@@@\nnext: More?', truncated: false }; };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 8 } });
  const L = llm({ claude: { use: async name => (name === 'sample' ? sample : null) } });
  await L.ask({
    prompt: 'And then?',
    history: [{ prompt: 'Can you write the export?', raw: 'I can. Who will read it?' }, { prompt: 'Why do you ask?', raw: 'Because of the device ids.' }],
    ...extra,
  });
  return got[0];
}

test('the sheet goes with the turn being asked, and with no other', async () => {
  const turns = await sent({ sheet: SHEET, about: 'q2' });
  assert.deepEqual(turns.map(t => t.role), ['user', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(turns[5].content, 'And then?' + LLM.sheetNote(SHEET, 'q2'));
  assert.equal(turns[1].content, 'Can you write the export?');
  assert.equal(turns[3].content, 'Why do you ask?');
});

test('Claude is told what the sheet is, and when to propose an answer, only where that applies', async () => {
  const SHEET_LINE = 'The answer that was sent here asks this person questions.';
  const OFFER_LINE = 'This thread is about one question you asked the reader';
  const inThread = (await sent({ sheet: SHEET, about: 'q2' }))[0].content;
  assert.ok(inThread.includes(SHEET_LINE) && inThread.includes(OFFER_LINE));
  assert.ok(inThread.includes('"answer: <the answer, written so that it can be understood without this thread>" and "why: <one or two sentences of reason>"'));
  assert.ok(inThread.indexOf(OFFER_LINE) < inThread.indexOf('Write nothing after those lines.'), 'the lines of a proposal belong to the @@@ section');
  // Elsewhere in the same conversation: the sheet, but no proposals.
  const elsewhere = (await sent({ sheet: SHEET, about: null }))[0].content;
  assert.ok(elsewhere.includes(SHEET_LINE) && !elsewhere.includes(OFFER_LINE));
  // A conversation with no sheet is told nothing of either.
  const plain = await sent({});
  assert.ok(!plain[0].content.includes(SHEET_LINE) && !plain[0].content.includes(OFFER_LINE));
  assert.equal(plain[5].content, 'And then?');
});

test('the helps and the check are worded by the app, and say so', () => {
  for (const kind of ['why', 'pick', 'help']) {
    const p = LLM.helpPrompt('Who will read it?', kind);
    assert.ok(p.startsWith('About this question you asked me: "Who will read it?"\n\n' + LLM.HELPS[kind].ask), kind);
    assert.ok(p.endsWith(LLM.WORDED), kind);
  }
  assert.ok(LLM.HELPS.why.ask.includes('Where you are inferring this from what was sent here, say so.'));
  assert.deepEqual(Object.values(LLM.HELPS).map(h => h.q), ['Why do you ask?', 'What would you pick?', 'Help me answer']);
  assert.ok(LLM.CHECK.startsWith('Check my answers together') && LLM.CHECK.endsWith(LLM.WORDED));
  assert.ok(LLM.CHECK_AGAIN.startsWith('I have changed my answers.') && LLM.CHECK_AGAIN.endsWith(LLM.WORDED));
});

// ---------- a proposed answer ----------

test('LLM.parse: a proposed answer and its reason, under the separator', () => {
  const p = LLM.parse('I would take the first.\n\n@@@\nterm: CSV = Comma-separated values.\nanswer: <My team only>\nwhy: Two colleagues review it.\nnext: What else?');
  assert.deepEqual(p, {
    text: 'I would take the first.',
    terms: [{ term: 'CSV', gloss: 'Comma-separated values.' }],
    next: ['What else?'],
    offer: { text: 'My team only', why: 'Two colleagues review it.' },
  });
  assert.deepEqual(LLM.parse('A.\n@@@\nAnswer: Yes').offer, { text: 'Yes', why: '' });
  // One proposal a reply: the first wins.
  assert.deepEqual(LLM.parse('A.\n@@@\nanswer: One\nanswer: Two\nwhy: First\nwhy: Second').offer, { text: 'One', why: 'First' });
});

test('LLM.parse: no proposal without an answer line, and none above the separator', () => {
  assert.ok(!('offer' in LLM.parse('A.\n@@@\nwhy: A reason alone\nnext: More?')));
  // "Answer: 42" may end any answer: without the separator it is the answer's text.
  assert.deepEqual(LLM.parse('The working.\nAnswer: 42'), { text: 'The working.\nAnswer: 42', terms: [], next: [] });
  assert.deepEqual(LLM.parse('The working.\nanswer: 42\nnext: And then?'), { text: 'The working.\nanswer: 42', terms: [], next: ['And then?'] });
});

// ---------- the reply ----------

test('the reply for the chat that asked: each question with its answer, the reason in brackets, the open ones last', () => {
  assert.equal(LLM.replyText(SHEET), [
    '1. Does the file need to open in a spreadsheet?',
    '   Yes',
    '2. Who will read it?',
    '   My team only',
    '   (Two colleagues review it each month.)',
    '3. Local time or UTC?',
    '   Your call.',
    '',
    'Not answered yet:',
    '4. Which columns come first?',
    '',
  ].join('\n'));
});

test('the reply keeps the numbers the questions have, and says nothing of open ones when there are none', () => {
  const some = { asks: [entry('q1', 'First?', 'open'), entry('q2', 'Second?', 'answered', 'B')] };
  assert.equal(LLM.replyText(some), '2. Second?\n   B\n\nNot answered yet:\n1. First?\n');
  assert.equal(LLM.replyText({ asks: [entry('q1', 'Only?', 'left')] }), '1. Only?\n   Your call.\n');
  assert.equal(LLM.replyText({ asks: [entry('q1', 'Only?', 'open')] }), 'Not answered yet:\n1. Only?\n');
});
