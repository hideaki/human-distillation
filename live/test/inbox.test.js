// Inbox tests: how a document sent to the page from another conversation
// with Claude is read, and when the page hears of one. No browser, no
// dependencies.   Run:  node --test live/test/inbox.test.js
//
// llm.js is run whole. Where a test needs the store, a small stand-in for the
// runtime gives it one (`db`) and says who is looking (`user`).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { llm } = require('./extract.js');

const LLM = llm();
const NOTE = k => `(The app added this note. This conversation began in another chat with you and was sent to this app: ${k === 1 ? 'the answer that follows was' : `the ${k} answers that follow were`} written there. Answer what is asked after ${k === 1 ? 'it' : 'them'} by the instructions above, with the @@@ section.`;

test('an answer with its question is one turn, and Claude is told where it came from', () => {
  assert.deepEqual(LLM.fromInbox({ question: 'Why is the sky blue?', answer: 'Because of **scattering**.\r\n', from: 'chat' }), {
    title: 'Why is the sky blue?',
    from: 'chat',
    turns: [{ q: 'Why is the sky blue?', noq: false, prompt: 'Why is the sky blue?\n\n' + NOTE(1) + ')', raw: 'Because of **scattering**.' }],
  });
});

test('an answer alone: the turn says that no question came, and the answer\'s first line names it', () => {
  const g = LLM.fromInbox({ answer: '## Rayleigh *scattering*\n\nShort waves scatter more.' });
  assert.equal(g.title, 'Rayleigh scattering');
  assert.deepEqual(g.turns, [{
    q: 'Sent without its question', noq: true,
    prompt: '(The question this answered was not sent along.)\n\n' + NOTE(1) + ')',
    raw: '## Rayleigh *scattering*\n\nShort waves scatter more.',
  }]);
  // `text` is read as the answer too, and a title that was sent wins.
  assert.equal(LLM.fromInbox({ text: 'Plain.', title: '  The   sky ' }).title, 'The sky');
  assert.equal(LLM.fromInbox({ text: 'Plain.' }).turns[0].raw, 'Plain.');
});

test('earlier turns come first, oldest first, and only the first carries the note', () => {
  const g = LLM.fromInbox({
    earlier: [{ question: 'What is light?', answer: 'A wave.' }, { question: 'No answer here' }, 'not a turn', { answer: 'An answer with no question.' }],
    question: 'And colour?',
    answer: 'Its wavelength.',
  });
  assert.deepEqual(g.turns.map(t => [t.q, t.noq, t.raw]), [
    ['What is light?', false, 'A wave.'],
    ['Sent without its question', true, 'An answer with no question.'],
    ['And colour?', false, 'Its wavelength.'],
  ]);
  assert.equal(g.turns[0].prompt, 'What is light?\n\n' + NOTE(3) + ')');
  assert.equal(g.turns[1].prompt, '(The question this answered was not sent along.)');
  assert.equal(g.turns[2].prompt, 'And colour?');
  assert.equal(g.title, 'What is light?', 'named by its first question');
});

test('a summary of what came before travels in the first turn, and is not a turn', () => {
  const g = LLM.fromInbox({ context: 'We had covered waves.', question: 'And colour?', answer: 'Its wavelength.' });
  assert.equal(g.turns.length, 1);
  assert.equal(g.turns[0].q, 'And colour?');
  assert.equal(g.turns[0].prompt, 'And colour?\n\n' + NOTE(1) + ' What had been said before, in summary:\nWe had covered waves.)');
});

test('a document with no answer in it is not a conversation', () => {
  for (const data of [null, undefined, 'text', 7, [], {}, { answer: '' }, { answer: '   \n' }, { answer: 12 }, { question: 'Only a question' }, { earlier: [{ question: 'a', answer: 'b' }] }]) {
    assert.equal(LLM.fromInbox(data), null, JSON.stringify(data));
  }
});

test('a long title is cut', () => {
  const g = LLM.fromInbox({ question: 'Why '.repeat(60), answer: 'x' });
  assert.ok(g.title.length <= 90 && g.title.endsWith('…'), g.title);
  assert.equal(g.turns[0].q, ('Why '.repeat(60)).trim(), 'the question itself is whole');
});

// ---------- the store ----------

// A window whose runtime has a store with these documents. `owner` is what
// it answers when asked whether the viewer owns this copy.
function withStore(docs, owner) {
  const heard = [];
  const deleted = [];
  const db = {
    collection: path => ({
      onSnapshot(next) { heard.push({ path, next }); next({ docs: docs.map(([id, data]) => ({ id, exists: true, data: () => data })) }); return () => {}; },
      doc: id => ({ async delete() { deleted.push(path + '/' + id); } }),
    }),
  };
  const caps = { db, user: owner === undefined ? null : { isOwner: async () => owner } };
  return { win: { claude: { use: async name => caps[name] || null } }, heard, deleted };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('the page hears of the documents in the collection "inbox", and may delete one', async () => {
  const { win, heard, deleted } = withStore([['a', { answer: 'One.' }], ['b', { answer: 'Two.' }]], true);
  const LLM2 = llm(win);
  const got = [];
  let told = 0;
  LLM2.onChange(() => { told++; });
  LLM2.inbox(docs => got.push(docs));
  await settle();
  assert.deepEqual(heard.map(h => h.path), ['inbox']);
  assert.deepEqual(got, [[{ id: 'a', data: { answer: 'One.' } }, { id: 'b', data: { answer: 'Two.' } }]]);
  assert.equal(LLM2.rt.inbox, true, 'the owner is told that answers can be sent here');
  await LLM2.discard('a');
  assert.deepEqual(deleted, ['inbox/a']);
});

test('a visitor to someone else\'s copy is not told that answers can be sent there', async () => {
  const LLM2 = llm(withStore([], false).win);
  LLM2.inbox(() => {});
  await settle();
  assert.equal(LLM2.rt.inbox, false);
  // Where the runtime does not say who is looking, the inbox is taken to be theirs.
  const LLM3 = llm(withStore([], undefined).win);
  LLM3.inbox(() => {});
  await settle();
  assert.equal(LLM3.rt.inbox, true);
});

test('a copy of the page published without the store has no inbox', async () => {
  const none = llm({ claude: { use: async () => null } });
  let called = 0;
  none.inbox(() => { called++; });
  await settle();
  await none.discard('a');
  assert.deepEqual([called, none.rt.inbox], [0, false]);
  // And with no runtime at all.
  const bare = llm();
  bare.inbox(() => { called++; });
  await settle();
  assert.deepEqual([called, bare.rt.inbox], [0, false]);
});
