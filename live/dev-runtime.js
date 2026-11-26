// A local stand-in for the runtime Claude gives a page it hosts. It implements
// the two calls the app uses, claude.use("sample") and claude.use("mcp"), with
// placeholder answers, so the page can be worked on without Claude. Only the
// preview server (dev.py) loads this file; the published page never does.
//
// Words in a question that steer the stand-in, for trying the awkward paths:
//   #error    fail part-way         #refuse  decline to answer
//   #deny     behave as if the viewer did not allow Claude
//   #slow     think for five seconds
//   #long     write a much longer answer
//   #math     formulas of every kind, including ones that should not be drawn
//   notion    use the Notion tools, when the page offers them
//   #parts    with notion: the page read is a long one, and all its parts are read
//   #skim     with notion: the page read is a long one, and only its first part is read
//   #web      search the web and read the first result, when the page offers the web tools
//             (#parts and #skim work as with notion; an address in the question is read
//             without a search; #forged tries an address that nobody gave)
//
// In the address of the page, for the connectors:
//   ?missing=web      the viewer has not added the web connector (or: notion, or both
//                     with a comma). It is not listed, and a call to it is refused.
//   ?gone=web         it is listed, but a call to it is refused as not connected
//
// For the inbox (an answer sent to the page from another conversation):
//   claude.deliver(data, id)   in the console: plays that conversation's Claude
//                     writing a document to the inbox
//   ?send=sample      a sample document arrives a moment after the page loads
//   ?send=questions   one whose answer asks the reader four questions
//   #offer            in the thread of such a question: the reply proposes an answer
//                     ("What would you pick?" always does)
//   ?missing=db       the page was published without the store: no inbox
//   ?visitor          the viewer is not the owner of this copy: the inbox reads empty

(() => {
  'use strict';
  if (window.claude) return;

  const wait = (ms, signal) => new Promise((res, rej) => {
    if (signal && signal.aborted) { rej({ code: 'cancelled', message: 'stopped' }); return; }
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej({ code: 'cancelled', message: 'stopped' }); }, { once: true });
  });

  function reply(turns, notes) {
    const last = turns[turns.length - 1].content;
    const q = last.replace(/\s+/g, ' ').trim();
    const short = q.length > 90 ? q.slice(0, 89) + '…' : q;
    const depth = turns.filter(t => t.role === 'assistant').length;

    if (/no @@@ section/.test(last)) {
      return 'Placeholder takeaway: the side thread settled the part you pointed at.';
    }

    if (/^I will now explain .+ back in my own words/.test(q)) {
      return [
        '**Right:** you named the main idea, which is the part the placeholder can see.',
        '',
        '**Off or missing:** nothing can really be checked here, because this is the stand-in and not Claude.',
        '',
        '**Check yourself:** could you explain it to someone who has never heard of it?',
        '',
        '@@@',
        'next: What did I leave out?',
      ].join('\n');
    }

    // The sheet the page adds to a question, when the conversation has one.
    const sheet = /\(The app added this note\. The questions? your sent answer asks me[^]*\)\s*$/.exec(last);
    const settled = sheet ? (sheet[0].match(/^ {3}(My answer: |Left to you\.)/gm) || []).length : 0;
    if (/^Check my answers together/.test(q) || /^I have changed my answers/.test(q)) {
      return [
        `Placeholder check. The stand-in was shown ${settled} settled ${settled === 1 ? 'answer' : 'answers'} and cannot tell whether they fit together.`,
        '',
        /^I have changed/.test(q) ? 'A real check would say here which of its earlier points are now settled.' : 'A real check would name the answers that conflict, by their numbers.',
        '',
        '@@@',
        'next: Which answer should I change?',
      ].join('\n');
    }
    // A reply in the thread of a question the reader was asked.
    const about = /^About this question you asked me: "(.*?)"\s/.exec(q);
    const inAskThread = sheet && /This thread is about question \d+\./.test(sheet[0]);
    if (about || inAskThread) {
      const kind = /Why do you ask\?/.test(q) ? 'why' : /What would you pick\?/.test(q) ? 'pick' : /Help me answer it\./.test(q) ? 'help' : 'typed';
      const said = {
        why: 'Placeholder reason. A real answer would say what depends on your answer, and that it is inferring this from what was sent here.',
        pick: 'Placeholder choice. A real answer would name the choices it sees and the one it would take.',
        help: 'Placeholder help. A real answer would say what depends on your answer and what choices it sees, and then ask you one easy question about your own situation. What do you use it for?',
        typed: `Placeholder reply in the thread of a question. The stand-in was shown ${settled} settled ${settled === 1 ? 'answer' : 'answers'} on the sheet.`,
      }[kind];
      const out = [said, '', '@@@'];
      if (kind === 'pick' || /#offer/.test(q)) out.push('answer: Placeholder answer from the stand-in', 'why: The stand-in proposes this so that the button can be tried.');
      out.push('next: What would change your mind?');
      return out.join('\n');
    }

    const passage = /^About (this (part|term|formula)|the symbol)/.test(q) || /^Still about the part/.test(q);
    if (/^Show what you just explained as a diagram/.test(q)) {
      return ['Here is the placeholder as a diagram.', '', '```graph', 'A -> B : leads to', 'B -> C', 'A <-> C : compared with', '```', '', '@@@', 'next: What does B do?'].join('\n');
    }
    if (passage) {
      return [
        `Placeholder answer about the part you pointed at. A real answer would deal with that **one passage** and nothing else, in a few sentences.`,
        '',
        `It would lean on the ${depth} earlier answer${depth === 1 ? '' : 's'} on this path for context. It would not see any other branch.`,
        '',
        // Like Claude, it goes on using a term the first answer defined
        // (stand-in runtime) without defining it again, and gives one term
        // (inline code) a definition of its own.
        'It comes from the same stand-in runtime as the first answer, and it has no inline code in it.',
        '',
        '@@@',
        'term: passage = The sentence or phrase you pointed at.',
        'term: inline code = Code set inside a sentence, as this side answer defines it.',
        'next: Give me a second example',
        'next: How does this connect to the main question?',
      ].join('\n');
    }

    const body = [
      `Placeholder answer, written by the local stand-in and not by Claude. You asked: “${short}”.`,
      '',
      'A real answer would open with the point itself. It would then give the reasoning in a few short sentences, each of which can be clicked. Try a sentence here, or drag across a few words, e.g. this stand-in runtime.',
      '',
      'It can also contain a short list:',
      '- an item with `inline code` in it',
      '- an item with **strong** words and a formula such as $p_i = \\frac{\\exp(z_i / T)}{\\sum_j \\exp(z_j / T)}$',
      '',
      'A formula can also stand on a line of its own, and each one can be clicked:',
      '',
      '$$L = \\alpha \\, T^2 \\, \\mathrm{KL}(p \\,\\|\\, q) + (1 - \\alpha) \\, \\mathrm{CE}(y, q)$$',
      '',
      '```graph',
      'Question -> Stand-in runtime : sent to',
      'Stand-in runtime -> Placeholder answer : writes',
      'Placeholder answer -> Page : streamed to',
      'Page -> Diagram : draws',
      '```',
      '',
      '```',
      'for step in range(3):',
      '    print(step)',
      '```',
    ];
    if (/#math/.test(q)) {
      body.push('',
        'Money is not a formula: it costs $5 today and $10 tomorrow, or \\$7 with a coupon. Here **the bold part holds $x^2$ too**, and `$not_math$` stays code.',
        '',
        'Other delimiters: \\(a^2 + b^2 = c^2\\) inside a sentence, a displayed one mid-sentence $$\\int_0^1 x \\, dx = \\tfrac{1}{2}$$ and then several lines:',
        '',
        '\\[',
        '\\begin{aligned} (a + b)^2 &= a^2 + 2ab + b^2 \\\\ (a - b)^2 &= a^2 - 2ab + b^2 \\end{aligned}',
        '\\]',
        '',
        'A part of MathJax loaded on demand: $\\boldsymbol{\\beta}$ and $\\cancel{x}$. Broken LaTeX stays as text: $\\frac{a}{$. An unknown command: $\\notacommand{x}$. Japanese inside: $\\text{損失} = 0$.',
        '',
        '$$',
        '\\underbrace{\\sum_{i=1}^{n} \\left( y_i - \\hat{y}_i \\right)^2}_{\\text{squared error}} + \\lambda \\lVert w \\rVert_2^2 + \\frac{1}{2\\sigma^2} \\sum_{k=1}^{K} \\left( \\theta_k - \\mu_k \\right)^2 + \\log \\det \\Sigma + \\frac{n}{2} \\log 2\\pi',
        '$$');
    }
    // The page it read is named as a link, as Claude is asked to do.
    if (notes.length) body.push('', 'From Notion the stand-in read: ' + notes.join('; ') + '.' + (notes.cite ? ' Its source is ' + notes.cite + '.' : ''));
    if (notes.web.length) body.push('', 'From the web the stand-in read: ' + notes.web.join('; ') + '.' + (notes.web.cite ? ' Its source is ' + notes.web.cite + '.' : ''));
    if (/#long/.test(q)) {
      for (let i = 1; i <= 8; i++) body.push('', `Paragraph ${i} of a longer answer. It is here to see how the page behaves when an answer runs past the bottom of the view. Nothing in it is true or useful.`);
    }
    body.push(
      '',
      '@@@',
      'term: stand-in runtime = A local replacement for Claude that returns canned text, used for testing the page.',
      'term: inline code = A short piece of code set inside a sentence.',
      'next: What would a real answer look like?',
      'next: Show the same thing with #long',
      'next: What happens on an #error?');
    return body.join('\n');
  }

  async function sample(input, opts) {
    opts = opts || {};
    const turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input.slice();
    const signal = opts.signal;
    const last = turns[turns.length - 1].content;
    const quick = opts.modelTier === 'quick';

    if (/#deny/.test(last)) throw { code: 'not_granted', message: 'The viewer did not allow Claude.' };
    await wait(/#slow/.test(last) ? 5000 : quick ? 150 : 700, signal);
    if (/#refuse/.test(last)) throw { code: 'refused', message: 'Declined.' };

    // A tool round, as Claude would make before writing.
    const notes = [];
    notes.web = [];
    const tool = name => (opts.tools || []).find(t => t.name === name);
    const ctx = { signal: signal || new AbortController().signal };
    // A page comes back whole or as its first part. Read the rest in one
    // round, as Claude does, when asked to; say what was read.
    const readAll = async (fetch, args, all) => {
      const page = String(await fetch.execute(args, ctx));
      const count = Number((/^\[Part 1 of (\d+)/.exec(page) || [])[1] || 1);
      const named = /(?:Notion|Web) page “(.+?)” \((https:\/\/[^)\s]+)\)/.exec(page.split('\n')[0]);
      const rest = count > 1 && all
        ? await Promise.all(Array.from({ length: count - 1 }, (_, i) => fetch.execute({ ...args, part: i + 2 }, ctx)))
        : [];
      const size = [page, ...rest].reduce((a, t) => a + String(t).length, 0);
      return { cite: named ? `[${named[1]}](${named[2]})` : '', title: named ? named[1] : '', how: (count > 1 ? `${rest.length + 1} of ${count} parts, ` : '') + size + ' characters' };
    };
    const address = (/https?:\/\/[^\s"“”)]+/.exec(last) || [])[0];
    if (tool('web_search') && (/#web/.test(last) || address) && !/no @@@ section/.test(last)) {
      try {
        let url = address;
        if (/#forged/.test(last)) {
          url = 'https://collector.example/?carried=' + encodeURIComponent('what was read elsewhere');
        } else if (!url) {
          const words = last.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
          const found = await tool('web_search').execute({ objective: 'Find out about ' + words, queries: [words] }, ctx);
          url = found.results[/#parts|#skim/.test(last) ? 2 : 0].url;
        }
        const got = await readAll(tool('web_fetch'), { url }, /#parts/.test(last));
        notes.web.cite = got.cite;
        notes.web.push('“' + got.title + '” (' + got.how + ')');
      } catch (e) {
        notes.web.push('nothing, because a lookup failed (' + ((e && e.message) || 'unknown') + ')');
      }
      await wait(400, signal);
    }
    if (tool('notion_search') && /notion/i.test(last) && !/no @@@ section/.test(last)) {
      try {
        const found = await tool('notion_search').execute({ query: last.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ') }, ctx);
        const first = found && found.results && found.results[0];
        if (first) {
          const long = /#parts|#skim/.test(last);
          const id = /missing/i.test(last) ? 'missing-page' : long ? 'https://www.notion.so/placeholder-long' : first.url;
          const got = await readAll(tool('notion_fetch'), { id }, /#parts/.test(last));
          if (got.cite) notes.cite = got.cite;
          notes.push('“' + first.title + '” (' + got.how + ')');
        }
      } catch (e) {
        notes.push('nothing, because a lookup failed (' + ((e && e.message) || 'unknown') + ')');
      }
      await wait(400, signal);
    }

    const full = reply(turns, notes);
    const step = quick ? 60 : 24;
    let text = '';
    for (let i = 0; i < full.length; i += step) {
      await wait(45, signal).catch(e => { throw { ...e, text }; });
      const delta = full.slice(i, i + step);
      text += delta;
      if (opts.onText) opts.onText({ text, delta });
      if (/#error/.test(last) && i > 220) throw { code: 'upstream_error', message: 'Simulated failure.', text };
    }
    return { text: full, truncated: false, modelTierApplied: opts.modelTier || 'default' };
  }

  sample.json = async (input, opts) => JSON.parse((await sample(input, opts)).text);
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 8 }, modelTiers: ['default', 'complex', 'quick'] });

  // The connectors the viewer is taken to have (see the top of this file).
  const WEB = 'Parallel Search';
  const asked = new URLSearchParams(location.search);
  const without = what => (asked.get(what) || '').split(',').map(w => (w === 'web' ? WEB : w === 'notion' ? 'Notion' : w));
  const SERVERS = [
    { server: 'Notion', authStatus: 'connected', tools: [{ name: 'notion-search', description: '' }, { name: 'notion-fetch', description: '' }] },
    { server: WEB, authStatus: 'connected', tools: [{ name: 'web_search', description: '' }, { name: 'web_fetch', description: '' }] },
  ];
  // About 70 KB, much of it Japanese (three bytes a character): more than
  // one tool result may carry, so the page reads it in parts.
  const longText = title => {
    const section = i => `## Section ${i}: 定常作業 ${i}\n\n` + `これは長いページの代わりの文章です。 Filler sentence of section ${i}.\n\n`.repeat(60);
    return `# ${title}\n\n` + Array.from({ length: 12 }, (_, i) => section(i + 1)).join('');
  };

  function webTool(tool, input) {
    if (tool === 'web_search') {
      const about = (input.search_queries || []).join(', ');
      const hit = (slug, title) => ({ url: 'https://example.org/' + slug, title, publish_date: '2026-11-01', excerpts: ['An excerpt that mentions ' + about + '.', 'A second excerpt of the same page.'] });
      return { search_id: 'search_placeholder', results: [hit('placeholder-1', 'Placeholder web page 1 about ' + about), hit('placeholder-2', 'Placeholder web page 2'), hit('placeholder-long', 'Placeholder long web page')], session_id: input.session_id };
    }
    if (tool === 'web_fetch') {
      const url = input.urls[0];
      const page = /unreachable/.test(url) ? null
        : /placeholder-long/.test(url) ? { url, title: 'Placeholder long web page', excerpts: [], full_content: longText('Placeholder long web page') }
          : { url, title: 'Placeholder web page 1', excerpts: ['An excerpt.'], full_content: '# Placeholder web page 1\n\nThis stands in for the text of a web page. '.repeat(6) + '\n\nIt links to https://example.org/linked-from-the-page.' };
      return { extract_id: 'extract_placeholder', results: page ? [page] : [], errors: page ? [] : [{ url, error_type: 'connect_error', http_status_code: null, content: null }], session_id: input.session_id };
    }
    return null;
  }

  const mcp = {
    async listTools() {
      return { servers: SERVERS.filter(s => !without('missing').includes(s.server)) };
    },
    async callTool(server, tool, input) {
      await wait(500);
      if (!SERVERS.some(s => s.server === server) || without('missing').includes(server) || without('gone').includes(server)) throw { code: 'server_not_connected', server, message: 'No such connector.' };
      if (server === WEB) {
        const payload = webTool(tool, input);
        if (!payload) throw { code: 'not_in_manifest', server, message: 'This page does not declare that tool.' };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], payload };
      }
      if (tool === 'notion-search') {
        const payload = {
          type: 'workspace_search',
          results: [1, 2].map(i => ({
            id: 'placeholder-' + i,
            title: `Placeholder page ${i} about ${input.query}`,
            url: 'https://www.notion.so/placeholder-' + i,
            type: 'page',
            highlight: 'A highlight that mentions ' + input.query + '.',
            timestamp: '2026-11-01T09:00:00.000Z',
            path: 'Workspace / Notes',
          })),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], payload };
      }
      if (tool === 'notion-fetch') {
        if (/missing/.test(input.id)) throw { code: 'tool_error', server, message: 'Could not find a page with that ID.' };
        if (/placeholder-long/.test(input.id)) {
          const long = { title: 'Placeholder long page', url: 'https://www.notion.so/placeholder-long', text: longText('Placeholder long page') };
          return { content: [{ type: 'text', text: JSON.stringify(long) }], payload: long };
        }
        const payload = {
          title: 'Placeholder page 1',
          url: 'https://www.notion.so/placeholder-1',
          text: '# Placeholder page 1\n\nThis stands in for the content of a Notion page. '.repeat(6),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], payload };
      }
      throw { code: 'not_in_manifest', server, message: 'This page does not declare that tool.' };
    },
  };

  // The store Claude keeps for an artifact (claude.use("db")), with only what
  // the page uses of it: the collection "inbox", listened to, and a document
  // deleted. What it holds is kept in this browser, as the real store keeps
  // it between visits.
  const BOX = 'human-distillation-dev-inbox';
  const visitor = asked.has('visitor');
  const held = () => { try { return JSON.parse(localStorage.getItem(BOX)) || {}; } catch (e) { return {}; } };
  const listeners = new Set();
  const meta = { fromCache: false, hasPendingWrites: false };
  const snapshot = () => {
    const all = visitor ? {} : held();
    const docs = Object.keys(all).sort().map(id => ({ id, exists: true, data: () => all[id], metadata: meta }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
  };
  const hold = all => {
    localStorage.setItem(BOX, JSON.stringify(all));
    listeners.forEach(fn => fn(snapshot()));
  };
  const db = {
    collection(path) {
      if (path !== 'inbox') throw new TypeError('The stand-in store has only the collection "inbox".');
      return {
        path,
        onSnapshot(next) {
          listeners.add(next);
          setTimeout(() => { if (listeners.has(next)) next(snapshot()); }, 250);
          return () => listeners.delete(next);
        },
        doc: id => ({
          id,
          path: path + '/' + id,
          async delete() {
            if (visitor) throw { code: 'invalid_argument', message: 'Not yours to write.' };
            const all = held();
            delete all[id];
            hold(all);
          },
        }),
      };
    },
  };
  // What Claude does in the other conversation: write one document.
  function deliver(data, id) {
    const all = held();
    const key = id || 'doc-' + Date.now().toString(36);
    all[key] = data;
    hold(all);
    return key;
  }
  const SAMPLE = {
    from: 'chat',
    title: 'Why the standard error shrinks',
    context: 'We started from what a sample mean is: the average of $n$ independent draws from the same distribution. You then asked how much such an average varies from one sample to the next, and we named that spread the **standard error**.',
    question: 'Why does the standard error shrink with the square root of n?',
    answer: [
      '## The short answer',
      '',
      'Variances add, standard deviations do not. The variance of a sum of $n$ independent draws is $n\\sigma^2$, and dividing by $n$ scales a variance by $1/n^2$:',
      '',
      '$$\\mathrm{SE}(\\bar{X}) = \\sqrt{\\frac{n\\sigma^2}{n^2}} = \\frac{\\sigma}{\\sqrt{n}}$$',
      '',
      '---',
      '',
      '## In numbers',
      '',
      '| Draws $n$ | Standard error | Compared with one draw |',
      '|---:|:---:|---|',
      '| 1 | $\\sigma$ | the same |',
      '| 4 | $\\sigma / 2$ | half |',
      '| 100 | $\\sigma / 10$ | a tenth |',
      '',
      'Halving the error takes four times the data. This relies on the draws being independent.',
    ].join('\n'),
  };
  // An answer that asks the reader things, with the questions listed as the
  // sending chat is asked to list them. The second leans on its sentence,
  // and the quote of the third differs from the text in its markup. The
  // fourth the answer only points to: it has no quote, and it is worded
  // with the options and the recommendation given for it elsewhere.
  const QUESTIONS = {
    from: 'chat',
    title: 'A monthly export of the readings',
    context: 'You asked for a script that exports the sensor readings once a month, and we settled that it runs on the first of the month.',
    question: 'Can you write the export now?',
    answer: [
      'I can, and most of it is decided. Three things are not, and they change what I write.',
      '',
      'The file can be CSV or a spreadsheet with formulas in it. Does the file need to open in a spreadsheet? If it does, I will write the totals as formulas, so that they follow when someone edits a row.',
      '',
      'It also matters who reads it. A file that leaves your team should not carry the device ids. Will it?',
      '',
      'Last, the timestamps. The readings are stored in **UTC**, and I can leave them so or convert them. Which do you want: `UTC` or local time?',
      '',
      'One choice from the plan I wrote before also still waits for you: how long the files are kept.',
    ].join('\n'),
    questions: [
      { quote: 'Does the file need to open in a spreadsheet?', question: 'Does the exported file need to open in a spreadsheet?' },
      { quote: 'Will it?', question: 'Will the exported file be read by anyone outside your team?' },
      { quote: 'Which do you want: `UTC` or local time?', question: 'Should the timestamps in the export be in UTC or in local time?' },
      { question: 'How long should the exported files be kept? The options in the plan were three months, a year, or for good. I recommended a year. Three months is too short to compare a month with the same month of the year before. Keeping them for good costs little, about 40 MB a year, but then nobody clears out old files that carry device ids.' },
    ],
  };
  if (asked.get('send') === 'sample') setTimeout(() => deliver(SAMPLE, 'sample'), 1500);
  if (asked.get('send') === 'questions') setTimeout(() => deliver(QUESTIONS, 'questions'), 1500);

  const caps = {
    sample,
    mcp,
    db: without('missing').includes('db') ? null : db,
    // Who is looking: the page asks only whether it is the owner.
    user: { isOwner: async () => !visitor },
  };
  window.claude = {
    standIn: true,
    use: async name => caps[name] || null,
    deliver,
  };
})();
