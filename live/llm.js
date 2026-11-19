// Everything that talks to Claude lives here: the prompts, the calls, and the
// reading of what comes back.
//
// The page reaches Claude through the runtime Claude gives a page it hosts:
//   claude.use("sample")   ask Claude, on the viewer's own account
//   claude.use("mcp")      call the viewer's connectors (Notion) through the
//                          connection they already have in Claude
// dev-runtime.js implements the same two calls with placeholders for local
// work. A local backend could be plugged in the same way.

const LLM = (() => {
  'use strict';

  const SEP = '@@@';
  const enc = new TextEncoder();
  const bytes = s => enc.encode(s).length;
  // The first n characters at most, never cut through the middle of one.
  const clip = (s, n) => {
    if (s.length <= n) return s;
    const half = s.charCodeAt(n - 2);
    return s.slice(0, half >= 0xD800 && half <= 0xDBFF ? n - 2 : n - 1).trimEnd() + '…';
  };

  // The one-click questions about a passage. `q` is what the reader sees,
  // `ask` is what Claude is asked.
  const VERBS = {
    explain: { short: 'Explain', q: 'Explain further', ask: 'Explain this part further. Work out what is most likely unclear about it for this reader, and explain that in plainer terms, with a concrete example if one helps.' },
    example: { short: 'Example', q: 'Show me an example', ask: 'Give me one concrete example of this.' },
    simpler: { short: 'Simpler', q: 'Say it more simply', ask: 'Say this more simply, as you would to someone outside the field.' },
    why: { short: 'Why?', q: 'Why is this true?', ask: 'Why is this true?' },
  };

  const passagePrompt = (text, verb) => `About this part of your answer:\n"${text}"\n\n${VERBS[verb].ask}`;
  const askPrompt = (text, question) => `About this part of your answer:\n"${text}"\n\n${question}`;
  const partPrompt = (text, question) => `About this part of your diagram: "${text}"\n\n${question || 'Explain this part further: what it is, and how it relates to what it is connected to.'}`;
  const formulaPrompt = (text, question) => `About this formula in your answer: ${text}\n\n${question || 'Explain this formula: what each symbol stands for, and what the formula as a whole says, in plain words. Work through a small example with numbers if that helps.'}`;
  const symbolPrompt = (sym, formula, question) => `About the symbol $${sym}$ in this formula from your answer: ${formula}\n\n${question || 'What does this symbol stand for here, and what does it do in the formula? Answer in a few plain sentences.'}`;
  const DRAW = 'Show what you just explained as a diagram, with a sentence or two around it.';
  const termPrompt = term => `About this term in your answer: "${term}"\n\nWhat does it mean here, and why does it matter for this topic?`;
  const followPrompt = (text, verb) => `Still about the part I pointed at ("${clip(text, 200)}"): ${VERBS[verb].ask}`;
  // "Explain it back": the reader's own account of a thread, to be checked.
  const backPrompt = (subject, text) => `I will now explain ${subject} back in my own words, so that you can check my understanding. Compare it with what you told me above. Reply in three short paragraphs, each starting with its label in bold: "**Right:**" for what I have right, "**Off or missing:**" for what is wrong or missing (or "nothing important"), and "**Check yourself:**" for one question that tests my weakest point, which I may answer in my next message. Be specific and brief, with no diagram.\n\nMy explanation:\n${text}`;
  const PLAIN = `\n\n(For this reply only: plain text, with no ${SEP} section.)`;

  // ---------- runtime ----------

  // state: 'starting' until the runtime has answered, then 'ready' or 'none'.
  const rt = { state: 'starting', sample: null, mcp: null, limits: null, standIn: false, notion: false, denied: false };
  let changed = () => {};

  const ready = (async () => {
    const c = window.claude;
    if (!c || typeof c.use !== 'function') { rt.state = 'none'; return rt; }
    const use = name => Promise.resolve().then(() => c.use(name)).catch(() => null);
    const [sample, mcp] = await Promise.all([use('sample'), use('mcp')]);
    rt.sample = sample;
    rt.mcp = mcp;
    rt.standIn = !!c.standIn;
    if (sample && typeof sample.limits === 'function') {
      rt.limits = await Promise.resolve().then(() => sample.limits()).catch(() => null);
    }
    // Notion lookups are page functions Claude may call, so they need both
    // the connector bridge and tool support in this view.
    rt.notion = !!(sample && mcp && (!rt.limits || rt.limits.tools));
    rt.state = sample ? 'ready' : 'none';
    return rt;
  })();

  function tierFor(t) {
    if (t !== 'quick' && t !== 'complex') return null;
    const ok = rt.limits && rt.limits.modelTiers;
    return !ok || ok.includes(t) ? t : null;
  }

  // ---------- what Claude is told ----------

  function rules(o) {
    const known = (o.known || []).slice(0, 80);
    const reader = o.level === 2
      ? 'someone who knows the basics of the field. Skip the fundamentals and spend the words on what is specific to this topic.'
      : 'someone new to the subject. Assume a general education but no background in this field, and prefer a concrete example to an abstract statement.';
    const lines = [
      'You are the explainer inside a study app called Human Distillation. One person is using it to understand an idea properly, by asking you questions.',
      '',
      'How the app works, so you know what your answers are for:',
      '- The conversation is a tree. The person can go back to any earlier message and continue from there, so what you see here is exactly the path that leads to the current question and nothing else.',
      '- They can point at any sentence or phrase in one of your answers and ask about just that part. Such a question arrives with the part quoted, and its answer opens beside the original message.',
      '- Terms you list at the end of an answer get a dotted underline, and hovering shows your one-line definition.',
      '',
      'How to answer:',
      '- Answer the question that was asked, directly, in the first sentence or two. Then give the reasoning that makes it make sense.',
      `- Write for this reader: ${reader}`,
      '- Keep it short enough to read in one go, usually two to four short paragraphs. They will ask for more where they need it, so do not try to cover everything.',
      '- One idea per sentence where you can. Any sentence may be pointed at on its own, so each should make sense when quoted alone.',
      '- Plain prose. Use a short list only for things that really are a list, and a code block only for code. No headings and no tables.',
      '- Write every formula, equation and mathematical symbol in LaTeX, and the app typesets it. Inside a sentence put it between single dollar signs, like $p_i = \\frac{e^{z_i/T}}{\\sum_j e^{z_j/T}}$. Give a formula that matters a line of its own, between double dollar signs, with a blank line before and after. Never put a formula in backticks or a code block, and never write one in plain text. The person can click a formula, or a single symbol in it, to ask about it, so say what its symbols stand for in the text around it. Write a dollar sign that means money as \\$.',
      '- Use a diagram whenever the answer is about several things and how they relate: a process, a pipeline, a chain of causes, the parts of a system. Do this without being asked, and leave it out when prose alone is clear. Write it as a fenced block that opens with ```graph and holds one relation per line in the form "From -> To : label" (the label is optional, "--" draws a link with no arrow). Use short names of one to four words in plain text with no LaTeX, spell a thing the same way every time it appears, and keep to nine things or fewer. The app draws it, and the person can click any box or link to ask about it. Put it where it helps the text, at most one per answer, and still explain in prose.',
      '- When the question quotes a part of your earlier answer, answer about that part only, in a few sentences, without repeating the answer it came from.',
      '- If you are not sure of something, say so in the sentence where it matters.',
      '- Reply in the language the person writes in.',
    ];
    if (o.notion) {
      lines.push('- You can look in this person\'s Notion with notion_search and notion_fetch. Use them when the question is about their own notes, documents, projects or team, or when they ask you to. Call them without announcing it, read what you need, then write the answer and name the pages it draws on. A long page comes in numbered parts: read the parts the question needs before you answer, and if you leave any unread, say which. For general knowledge, answer without them.');
    }
    lines.push(
      '',
      `After every answer, however short, add a line containing only ${SEP} and then the lines below. This holds just as much for an answer about a quoted part, a formula, a symbol or a part of a diagram.`,
      `- for each term in your answer that this reader may not know, one line of the form "term: <the term exactly as it appears in your answer> = <a one-sentence plain definition>". At most ${o.level === 2 ? 4 : 6}; none is fine. A term you defined earlier in this conversation keeps its definition in the app, so list only the terms that are new in this answer.${known.length ? ' They already know these, so never list them: ' + known.join(', ') + '.' : ''}`,
      '- up to three lines of the form "next: <a question this person would naturally ask next>", each under twelve words.',
      'Write nothing after those lines.');
    return lines.join('\n');
  }

  // What an earlier answer read in Notion travels with its question, so that
  // later questions on the same path can draw on it. Every page it read is
  // named, with the start of its text. `brief` names the pages and leaves the
  // text out. `notion` says whether the question now asked may read again.
  function refs(sources, notion, brief) {
    const pages = (sources || []).filter(s => s.kind === 'page' && s.state === 'done');
    if (!pages.length) return '';
    const name = s => `“${s.title || 'Notion page'}”${s.url ? ' (' + s.url + ')' : ''}: ${howMuch(s)}`;
    const which = pages.length === 1 ? 'this page of my Notion was' : `these ${pages.length} pages of my Notion were`;
    const again = notion
      ? 'If you need more of a page than is repeated here, read it again with notion_fetch.'
      : 'If a question needs something that is not repeated here, say that this part of the page is not in front of you now, and that I can ask again with "Look in my Notion" ticked. Do not say that the page was not read.';
    if (brief) return `\n\n[For this question ${which} read and shown to you: ${pages.map(name).join('; ')}. To save space their text is not repeated here. ${again}]`;
    return `\n\n[For this question ${which} read and shown to you. Each line below that starts with "---" names a page and says how much of it was read then. To save space the text of a long page is repeated only in part, with a note where the repeat stops. Where it stops says nothing about how much was read: go by the line. ${again}]\n`
      + pages.map((s, i) => `--- ${i + 1}. ${name(s)}\n${s.text || '[Not repeated here.]'}`).join('\n');
  }

  // How much of a page an answer read, from what is kept with that answer.
  // Claude cannot tell this from the text repeated to it, which is cut to
  // save space wherever the page is long.
  function howMuch(s) {
    if (s.of > 1 && s.parts) return s.parts.length === s.of ? `read whole, in ${s.of} parts` : `only ${partSpan(s.parts)} of ${s.of} read`;
    // An answer from before long pages were read in parts may have had its
    // page cut short on reading, and nothing kept with it says whether it was.
    if (!s.whole && (!s.text || /\n\[The rest of this page was left out\.\]$/.test(s.text))) return 'read, but how far is not recorded';
    return 'read whole';
  }

  // Claude keeps nothing between calls: every question is sent with the turns
  // that lead to it. If that grows past the limit, trim from the oldest end:
  // first the looked-up pages are cut down to their names, then whole turns go.
  function turnsFor(o) {
    const cap = ((rt.limits && rt.limits.maxPromptBytes) || 262144) - 6000;
    const hist = (o.history || []).filter(h => h.prompt);
    for (let brief = 0, drop = 0; ;) {
      const turns = [{ role: 'user', content: rules(o) }];
      if (drop) turns.push({ role: 'user', content: '(The earliest messages of this conversation were left out to save space.)' });
      hist.forEach((h, i) => {
        if (i < drop) return;
        turns.push({ role: 'user', content: h.prompt + refs(h.sources, o.notion, i < brief) });
        if (h.raw) turns.push({ role: 'assistant', content: h.raw });
      });
      turns.push({ role: 'user', content: o.prompt });
      if (turns.reduce((a, t) => a + bytes(t.content), 0) <= cap) return turns;
      if (brief < hist.length) brief++;
      else if (drop < hist.length - 1) drop++;
      else return turns;
    }
  }

  // ---------- Notion, through the viewer's own connector ----------

  // What a page function hands back to Claude may be 32 KB once JSON-encoded.
  // RESULT stays under that. A page longer than RESULT is read in parts: PART
  // is the text of one, which leaves room for the notes around it, of which
  // OUTLINE is the list of what each part holds. CARRY is how much of the
  // pages one answer read travels on with it for later questions, shared
  // between those pages.
  const RESULT = 30000, PART = 25000, OUTLINE = 3000, CARRY = 60000;
  // The most page text one answer may read, in bytes. Every round sends all
  // of it to Claude again, on top of the turns of the thread.
  const READ = 180000, READ_LEAST = 60000;

  const jsonSize = x => bytes(JSON.stringify(x));

  // A string no longer than `max` bytes once JSON-encoded, which is how tool
  // results are measured.
  function capJson(s, max, note) {
    if (jsonSize(s) <= max) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (jsonSize(s.slice(0, mid)) <= max) lo = mid; else hi = mid - 1;
    }
    const half = s.charCodeAt(lo - 1);
    if (half >= 0xD800 && half <= 0xDBFF) lo--; // not through the middle of a character
    return s.slice(0, lo) + (note || '');
  }

  // A page as the parts Claude reads it in: whole lines, as many as fit in
  // each. A page that fits in one result is one part.
  function partsOf(text) {
    if (jsonSize(text) <= RESULT) return [text];
    const size = s => jsonSize(s) - 2;
    const lines = text.split('\n');
    const parts = [];
    let cur = '', used = 0;
    lines.forEach((l, i) => {
      let line = i < lines.length - 1 ? l + '\n' : l;
      let n = size(line);
      if (cur && used + n > PART) { parts.push(cur); cur = ''; used = 0; }
      while (n > PART) { // a single line longer than a part
        const head = capJson(line, PART + 2);
        parts.push(head);
        line = line.slice(head.length);
        n = size(line);
      }
      cur += line;
      used += n;
    });
    if (cur) parts.push(cur);
    return parts;
  }

  // One line per part saying what it holds: its headings or, where it has
  // none, how it starts. This is how Claude picks the parts a question needs.
  function outlineOf(parts) {
    let code = false;
    const lines = parts.map((p, i) => {
      const heads = [];
      let first = '';
      p.split('\n').forEach(l => {
        if (/^\s*(```|~~~)/.test(l)) { code = !code; return; }
        const m = !code && /^\s*#{1,6}\s+(.+?)\s*$/.exec(l);
        if (m) heads.push(clip(m[1].replace(/\s*\{[^{}]*\}$/, ''), 50));
        else if (!first && l.trim() && !/^\s*</.test(l)) first = clip(l.trim(), 60);
      });
      const what = heads.length ? heads.slice(0, 6).join('; ') + (heads.length > 6 ? `; and ${heads.length - 6} more headings` : '')
        : first ? `no headings, starts “${first}”` : 'no headings';
      return `part ${i + 1}: ${what}`;
    });
    return capJson(lines.join('\n'), OUTLINE, '…');
  }

  // [1, 2, 3, 5] -> "parts 1–3, 5"
  function partSpan(ks) {
    const runs = [];
    ks.forEach(k => {
      const last = runs[runs.length - 1];
      if (last && last[1] === k - 1) last[1] = k; else runs.push([k, k]);
    });
    return (ks.length === 1 ? 'part ' : 'parts ') + runs.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ');
  }

  function resultText(r) {
    const p = r && r.payload;
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      if (typeof p.text === 'string') return p.text;
      return JSON.stringify(p);
    }
    return ((r && r.content) || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  }

  function pageMeta(r, text, id) {
    const p = r && r.payload && typeof r.payload === 'object' ? r.payload : {};
    let title = typeof p.title === 'string' ? p.title : '';
    let url = typeof p.url === 'string' ? p.url : '';
    if (!title) {
      const m = /\btitle="([^"]+)"/.exec(text) || /"title"\s*:\s*"([^"]+)"/.exec(text) || /^#\s+(.+)$/m.exec(text);
      if (m) title = m[1];
    }
    if (!url && /^https?:\/\//.test(id)) url = id;
    return { title: title || 'Notion page', url };
  }

  // What Claude is told when a Notion call fails. It carries on without it.
  function mcpMessage(e) {
    const code = e && e.code;
    if (code === 'server_not_connected') return 'Notion is not connected for this person. Tell them to add the Notion connector in Claude\'s settings, and answer without it.';
    if (code === 'needs_reauth') return 'The Notion connection has expired. Tell them to reconnect Notion in Claude\'s settings, and answer without it.';
    if (code === 'not_in_manifest' || code === 'not_granted' || code === 'approval_required' || code === 'consent_required') return 'The person has not allowed this page to use Notion. Answer without it and say so.';
    if (code === 'blocked_by_policy') return 'Their organization does not allow this Notion tool here. Answer without it and say so.';
    if (code === 'tool_error') return 'Notion returned an error: ' + clip(String((e && e.message) || ''), 300);
    if (code === 'cancelled') return 'Cancelled.';
    return 'Notion could not be reached just now (' + (code || 'unknown') + '). Answer without it and say so.';
  }

  // `room` is how many bytes of pages this answer may read.
  function notionTools(sources, note, room) {
    // The pages read for this answer. A page is fetched once, however many
    // of its parts are asked for, so that the parts stay those of one text.
    const pages = new Map(); // id -> { src, got: its parts, parts, read: part -> text, busy, told }
    let spent = 0;

    // What travels on with the answer for later questions: the text of every
    // page read, as far as CARRY goes. The pages share it. One that needs
    // less than its share leaves the rest to the longer ones, so short pages
    // go whole and long ones are cut. A page in parts also says which parts
    // were read and what the others hold.
    const settle = () => {
      const list = [...pages.values()].filter(p => p.read.size).map(p => {
        const ks = [...p.read.keys()].sort((a, b) => a - b), n = p.parts.length;
        const text = ks.map((k, i) => (i && ks[i - 1] !== k - 1 ? '\n[…]\n' : '') + p.read.get(k)).join('');
        const which = ks.length === n ? 'All of them were' : `Only ${partSpan(ks)} of ${n} ${ks.length === 1 ? 'was' : 'were'}`;
        const head = n === 1 ? '' : `[This page is long and comes in ${n} parts. ${which} read for this answer.]\n[What each part holds:\n${outlineOf(p.parts)}]\n`;
        return { p, head, text, want: bytes(head) + jsonSize(text) - 2 };
      }).sort((a, b) => a.want - b.want);
      let left = CARRY;
      list.forEach((x, i) => {
        const got = Math.min(x.want, Math.floor(left / (list.length - i)));
        left -= got;
        const whole = x.p.read.size === x.p.parts.length;
        x.p.src.text = x.head + capJson(x.text, Math.max(0, got - bytes(x.head)) + 2, whole
          ? '\n[Only this much is repeated here. The page was read to its end.]'
          : '\n[Only this much is repeated here. The parts that were read go on beyond this.]');
      });
    };

    const call = async (tool, input, signal) => {
      try { return await rt.mcp.callTool('Notion', tool, input, signal ? { signal } : undefined); }
      catch (e) { throw new Error(mcpMessage(e)); }
    };
    const track = async (src, run) => {
      sources.push(src);
      note();
      try { const out = await run(); src.state = 'done'; note(); return out; }
      catch (e) { src.state = 'error'; src.error = e.message; note(); throw e; }
    };
    const tools = [
      {
        name: 'notion_search',
        description: 'Search this person\'s Notion workspace by keywords. Returns matching pages with title, URL, location and a short highlight. Use it to find a page before reading it with notion_fetch.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Short, specific keywords' } }, required: ['query'] },
        async execute(input, ctx) {
          const query = String((input && input.query) || '').trim();
          if (!query) throw new Error('A query is required.');
          const src = { kind: 'search', query, state: 'running', hits: 0 };
          return track(src, async () => {
            const r = await call('notion-search', { query, page_size: 8, max_highlight_length: 300 }, ctx && ctx.signal);
            const p = r && r.payload;
            if (!p || !Array.isArray(p.results)) return capJson(resultText(r), 30000, '\n[cut]');
            const results = p.results.map(h => ({ title: h.title, url: h.url, type: h.type, where: h.path, last_edited: h.timestamp, highlight: h.highlight }));
            src.hits = results.length;
            while (results.length > 1 && bytes(JSON.stringify({ results })) > 30000) results.pop();
            return { results };
          });
        },
      },
      {
        name: 'notion_fetch',
        description: 'Read one Notion page or database, given its URL or ID (from notion_search, or from the person\'s message). Returns the page content as Markdown. A long page comes in numbered parts: the first call returns part 1 and says how many parts there are and what each holds, and "part" reads another one. Several parts may be asked for at once.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The Notion page URL or ID' },
            part: { type: 'integer', description: 'Which part of a long page to read. Leave out for the first part.' },
          },
          required: ['id'],
        },
        async execute(input, ctx) {
          const id = String((input && input.id) || '').trim();
          if (!id) throw new Error('A page URL or ID is required.');
          const k = input && input.part != null ? Math.floor(Number(input.part)) : 1;
          let p = pages.get(id);
          if (!p) {
            p = { src: { kind: 'page', id, state: 'running', title: '', url: '', text: '' }, read: new Map(), busy: 0, told: false };
            p.got = call('notion-fetch', { id }, ctx && ctx.signal).then(r => {
              const text = resultText(r);
              Object.assign(p.src, pageMeta(r, text, id));
              p.parts = partsOf(text);
              return p.parts;
            });
            pages.set(id, p);
            sources.push(p.src);
          }
          const src = p.src;
          p.busy++;
          src.state = 'running';
          note();
          let parts;
          try {
            parts = await p.got;
          } catch (e) {
            // Let a second try at this page fetch it again.
            pages.delete(id);
            src.state = 'error';
            src.error = e.message;
            note();
            throw e;
          }
          const n = parts.length;
          try {
            if (!(k >= 1 && k <= n)) throw new Error(n > 1 ? `This page has parts 1 to ${n}.` : 'This page is short and has no parts. Leave "part" out.');
            const body = parts[k - 1];
            if (!p.read.has(k)) {
              if (spent && spent + bytes(body) > room) throw new Error('No more can be read for this one answer. Answer from what you have read, and tell the person which parts you did not read, so that they can ask about those next.');
              spent += bytes(body);
              p.read.set(k, body);
              // A page that came in parts says which of them were read.
              if (n > 1) Object.assign(src, { parts: [...p.read.keys()].sort((a, b) => a - b), of: n });
            }
            if (n === 1) return capJson(body, RESULT, '\n[The rest of this page was too long to include.]');
            const name = src.title ? ` of “${clip(src.title, 80)}”` : '';
            let head = `[Part ${k} of ${n}${name}.]\n`;
            if (!p.told) {
              p.told = true;
              head = `[Part ${k} of ${n}${name}. The page is too long to read at once, so it comes in parts. Before you answer, read the parts the question needs: call notion_fetch again with the same id and "part". You may ask for several parts at once. If you answer without having read every part, say which parts you did not read.]\n`
                + `[What each part holds:\n${outlineOf(parts)}]\n`;
            }
            return capJson(head + body, RESULT) + `\n[End of part ${k} of ${n}.]`;
          } catch (e) {
            if (!p.read.size) src.error = e.message;
            throw e;
          } finally {
            p.busy--;
            if (!p.busy) src.state = p.read.size ? 'done' : 'error';
            if (src.state === 'done') delete src.error;
            note();
          }
        },
      },
    ];
    return { tools, settle };
  }

  // What is kept with an answer: enough to show the sources, and to carry
  // the pages along the path.
  function keep(sources) {
    return sources.map(s => {
      if (s.kind === 'search') return { kind: 'search', query: s.query, hits: s.hits, state: s.state, error: s.error };
      const page = { kind: 'page', title: s.title, url: s.url, state: s.state, error: s.error, text: s.state === 'done' ? s.text : '' };
      // How much of it was read: certain parts of a long page, or all of it.
      if (s.of > 1) Object.assign(page, { parts: s.parts, of: s.of });
      else if (s.state === 'done') page.whole = true;
      return page;
    });
  }

  // ---------- asking ----------

  // o: { history: [{prompt, raw, sources}], prompt, level, known, notion,
  //      tier, effort, signal, onText(raw), onTool(sources) }
  async function ask(o) {
    await ready;
    if (!rt.sample) throw { code: 'no_runtime', message: 'Claude is not available in this view.' };
    const sources = [];
    const opts = { cache: false, onText: u => { if (o.onText) o.onText(u.text); } };
    if (o.signal) opts.signal = o.signal;
    const tier = tierFor(o.tier);
    if (tier) opts.modelTier = tier;
    if (o.effort) opts.effort = o.effort;
    let notion = !!(o.notion && rt.notion);
    const turns = turnsFor({ ...o, notion });
    let kit = null;
    if (notion) {
      // Pages may fill what the thread leaves of the largest prompt, within limits.
      const left = ((rt.limits && rt.limits.maxPromptBytes) || 262144) - turns.reduce((a, t) => a + bytes(t.content), 0);
      kit = notionTools(sources, () => { if (o.onTool) o.onTool(sources.slice()); }, Math.max(READ_LEAST, Math.min(READ, left)));
      opts.tools = kit.tools;
    }
    let res;
    try {
      res = await rt.sample(turns, opts);
    } catch (e) {
      const code = e && e.code;
      if (code === 'not_granted') { rt.denied = true; changed(); }
      if (code !== 'tools_unavailable' || !notion) throw e;
      // This view cannot run page tools: answer without Notion, and stop offering it.
      rt.notion = false;
      notion = false;
      changed();
      delete opts.tools;
      res = await rt.sample(turnsFor({ ...o, notion: false }), opts);
    }
    if (kit) kit.settle();
    return { raw: res.text, truncated: !!res.truncated, tier: res.modelTierApplied || null, sources: keep(sources) };
  }

  // A side request about a thread (its takeaway): plain text back, nothing
  // kept.
  async function side(o) {
    const res = await ask({ ...o, prompt: o.prompt + PLAIN, notion: false, onText: o.onText ? raw => o.onText(parse(raw).text) : null });
    return parse(res.raw).text;
  }

  // ---------- reading an answer ----------

  // raw -> { text, terms: [{term, gloss}], next: [question] }
  const memo = new Map();
  function parse(raw) {
    raw = String(raw || '');
    if (memo.has(raw)) return memo.get(raw);
    const lines = raw.split('\n');
    const meta = l => /^\s*[-*]?\s*(term|next)\s*:\s*(.+?)\s*$/i.exec(l);
    let cut = lines.findIndex(l => l.trim() === SEP);
    let tail = [];
    if (cut >= 0) {
      tail = lines.slice(cut + 1);
    } else {
      // No separator: still take a closing run of term/next lines, and while
      // the answer is being written hide a last line that is starting one.
      let end = lines.length;
      while (end > 0 && (!lines[end - 1].trim() || meta(lines[end - 1]))) end--;
      if (lines.slice(end).some(meta)) { cut = end; tail = lines.slice(end); }
      else {
        const last = lines[lines.length - 1].trim();
        cut = last && SEP.startsWith(last) ? lines.length - 1 : lines.length;
      }
    }
    const terms = [], next = [];
    tail.forEach(l => {
      const m = meta(l);
      if (!m) return;
      const body = m[2].replace(/^<(.*)>$/, '$1');
      if (m[1].toLowerCase() === 'next') { next.push(body.replace(/^["“<]+|["”>]+$/g, '')); return; }
      const wide = body.indexOf(' = ');
      const at = wide >= 0 ? wide : body.indexOf('=');
      if (at < 0) return;
      const term = body.slice(0, at).trim().replace(/^[*_`"“<]+|[*_`"”>]+$/g, '');
      const gloss = body.slice(at + (wide >= 0 ? 3 : 1)).trim().replace(/^<|>$/g, '');
      if (term && gloss && !terms.some(t => t.term.toLowerCase() === term.toLowerCase())) terms.push({ term, gloss: gloss.charAt(0).toUpperCase() + gloss.slice(1) });
    });
    const out = { text: lines.slice(0, cut).join('\n').replace(/\s+$/, ''), terms, next: next.slice(0, 3) };
    if (memo.size > 400) memo.clear();
    memo.set(raw, out);
    return out;
  }

  // ---------- errors, in the reader's words ----------

  const FINAL = new Set(['no_runtime', 'not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);

  function errorText(code) {
    switch (code) {
      case 'no_runtime': return 'Claude is not reachable from this view. Open this page inside Claude to get answers.';
      case 'not_granted': return 'Claude was not allowed for this visit. Reload the page and choose Allow.';
      case 'sampling_disabled':
      case 'not_declared':
      case 'capability_disabled':
      case 'capability_removed': return 'Claude is not available for this account or in this view.';
      case 'rate_limited': return 'Claude is busy, or you have reached a usage limit. Wait a little, then try again.';
      case 'session_expired': return 'Your Claude session has expired. Sign in again, then try again.';
      case 'refused': return 'Claude declined to answer this. Rephrase the question and try again.';
      case 'empty_completion': return 'Claude returned nothing. Try asking in a simpler way.';
      case 'prompt_too_large': return 'This thread has grown too long to send. Continue from an earlier message, or start a new conversation.';
      case 'interrupted': return 'The page was closed before this answer was written.';
      case 'invalid_request':
      case 'transform_error':
      case 'queue_overflow': return 'The request was malformed. This is a bug in the page, not something you did.';
      default: return 'The connection to Claude failed part-way. Try again.';
    }
  }

  return {
    SEP, VERBS, rt, ready,
    onChange(fn) { changed = fn; },
    ask, side, parse, partSpan,
    passagePrompt, askPrompt, partPrompt, formulaPrompt, symbolPrompt, termPrompt, followPrompt, backPrompt, DRAW,
    errorText, isFinal: code => FINAL.has(code),
  };
})();
