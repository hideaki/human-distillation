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
      if (/^In one sentence/.test(q)) return 'Placeholder takeaway: the side thread settled the part you pointed at.';
      return [
        'Right: you named the main idea, which is the part the placeholder can see.',
        'Off or missing: nothing can really be checked here, because this is the stand-in and not Claude.',
        'Check yourself: could you explain it to someone who has never heard of it?',
      ].join('\n');
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
        '@@@',
        'term: passage = The sentence or phrase you pointed at.',
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
    if (notes.length) body.push('', 'From Notion the stand-in read: ' + notes.join('; ') + '.');
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
    if (opts.tools && /notion/i.test(last) && !/no @@@ section/.test(last)) {
      const tool = name => opts.tools.find(t => t.name === name);
      const ctx = { signal: signal || new AbortController().signal };
      try {
        const found = await tool('notion_search').execute({ query: last.replace(/#\w+/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ') }, ctx);
        const first = found && found.results && found.results[0];
        if (first) {
          const page = await tool('notion_fetch').execute({ id: /missing/i.test(last) ? 'missing-page' : first.url }, ctx);
          notes.push('“' + first.title + '” (' + String(page).length + ' characters)');
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

  const mcp = {
    async listTools() {
      return { servers: [{ server: 'Notion', authStatus: 'connected', tools: [{ name: 'notion-search', description: '' }, { name: 'notion-fetch', description: '' }] }] };
    },
    async callTool(server, tool, input) {
      await wait(500);
      if (server !== 'Notion') throw { code: 'server_not_connected', server, message: 'No such connector.' };
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

  window.claude = {
    standIn: true,
    use: async name => (name === 'sample' ? sample : name === 'mcp' ? mcp : null),
  };
})();
