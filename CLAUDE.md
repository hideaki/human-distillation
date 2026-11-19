# Human Distillation

A prototype of a chat for understanding complex ideas with Claude. It looks
like an ordinary chat, and any part of an answer can be asked about on its
own: a sentence, a few highlighted words, a formula, a symbol in a formula, a
box or link of a diagram. The side question opens beside the answer, so the
conversation is a tree and every branch is kept.

The why, the user's design decisions and their preferences are in the
project's memory notes, which load with every session. This file is about the
code.

## Where things are

    live/                 the app (everything below is about this)
      page.html           the page, in the form Claude publishes (no <html>/<body>)
      styles.css
      llm.js              all that talks to Claude: the instructions, the prompts,
                          the calls, and LLM.parse for what comes back
      app.js              the rest, in one closure
      dev-runtime.js      a stand-in for Claude, for local work only
      dev.py              the local preview server
      build.py            writes live/dist/human-distillation.html, the one
                          file that is published (git-ignored)
      test/, TESTING.md   the regression tests
    index.html, app.js, content.js, styles.css (in the root)
                          the first mock, with canned content. Superseded; leave it.

## Run, test, publish

- Preview: `python3 live/dev.py`, or the `live` configuration in
  `.claude/launch.json`. Port 4174. `/` is the page with the stand-in, `/built`
  the built file, `/test` the flow tests.
- The stand-in answers with placeholder text. Words in a question steer it:
  `#math`, `#slow`, `#long`, `#error`, `#refuse`, `#deny`, and "notion"
  (with `#parts` or `#skim` for a long page, read whole or only its start).
- Tests: `npm test` runs the parsing tests, the Notion tests and the static
  check. The flow
  tests run in the Browser pane at `/test`. `live/TESTING.md` explains all
  three, including the grid (every per-thread action in every kind of thread).
- Publish: the app lives as a private Claude artifact at
  https://claude.ai/artifact/Pdf2MH97soMq4YZjWTjQS5. Order: `npm test`, then
  `python3 live/build.py`, then the flow tests on `/test?page=built`, then
  publish `live/dist/human-distillation.html` to that URL. From a new
  conversation, read the artifact first and pass the URL, or a second artifact
  is created. Leave `capabilities` out so the stored ones are kept (`sample`,
  and `mcp` for Notion's `notion-search` and `notion-fetch`).
- Nothing is published without a full pass of the tests.

## How the app talks to Claude

The published page runs inside Claude and uses the runtime Claude gives it:
`claude.use("sample")` asks Claude on the viewer's own account, and
`claude.use("mcp")` calls the viewer's Notion connector. That is how the app
uses the user's existing connections with no sign-in of its own.

- Claude keeps nothing between calls. Every question is sent with the turns
  on the path that leads to it, and with the instructions in `rules()` as the
  first turn (there is no system prompt).
- An answer is prose, then optionally one fenced `graph` block, then a line
  `@@@` followed by `term: <term> = <definition>` and `next: <question>` lines.
  Formulas are LaTeX: `$...$` in a sentence, `$$...$$` on a line of its own.
- The model is chosen by tier (Fast, Balanced, Deep), not by name.
- Claude reads Notion through two functions the page lends it for one
  question, `notion_search` and `notion_fetch`. The page makes the connector
  call itself and hands the result back, and what it hands back may be 32 KB
  at most. So a longer page goes in numbered parts (`partsOf`): the first
  result says how many there are and what each holds, and Claude asks for the
  others with `part`. One answer reads 180 KB of pages at most, less in a long
  thread. The answer keeps which parts were read (`parts`, `of` on the
  source).
- Claude does not remember what it read. Each later question is told every
  page the answers above it read (`refs`), with their text as far as 60 KB
  per answer goes, shared between that answer's pages (`settle`): short pages
  whole, long ones cut. When the thread is too long to send, the oldest
  answers' pages are cut down to their names. A question asked by pointing or
  with one click gets the Notion functions only if it was typed or its thread
  has read a page already (`notionFor`), so that it can read again.

## How the page is put together

- Data: `store` holds every conversation in `localStorage` under
  `human-distillation-live-v1`. A conversation is a tree of `nodes` (one per
  question and its answer), plus `cols`, the threads on screen left to right.
- A side thread is a node with an `anchor`. Four shapes:
  `{start, end, text}` a passage; `{..., math: true}` a formula;
  `{..., math: true, sym}` a symbol in a formula; `{..., fig, part}` a part of
  a diagram. `start` and `end` are character offsets into the answer's
  rendered `textContent`.
- "Explain it back" is a turn like any other, with `back: true`. Its `q` is
  the reader's explanation and its `prompt` wraps that in the request to check
  it (`LLM.backPrompt`). The message box itself changes over to take it
  (`ui.back`, per thread); there is no second box.
- The threads on screen share the width of the window. A line of text stops
  at `--measure` (800px); the rest is margin (`--gut`, from the pane's width
  as a container), which diagrams and display formulas may use. A pane that
  changes width wraps its text again, so `renderPanes` puts a place in the
  text back where it was (see "keeping the place" in `app.js`).
- Diagrams and formulas are drawn inside shadow roots, so their drawn text
  stays out of those offsets. A formula's element also holds its LaTeX source
  as hidden text, so a formula does count in the offsets and travels with a
  quoted sentence. A diagram does not.
- Diagrams: Claude writes relations (`A -> B : label`), `parseGraph` reads
  them, dagre lays them out, the page draws the SVG.
- Formulas: MathJax 3.2.2 (`tex-svg`, from cdnjs, the last script in
  `page.html`, configured in `app.js`) draws each as SVG. Results are cached
  and cloned. Symbols are found by walking MathJax's drawing and its MathML
  side by side (`markSyms`), and their LaTeX is rebuilt from the MathML
  (`mmlTex`).
- Definitions: an answer shows its own terms and those defined by other
  answers of the same conversation (`termsFor`).

## Things that have bitten

- MathJax arrives after the first render. Until then, and for LaTeX it cannot
  read, a formula shows its source and has the class `raw`.
- MathJax fetches some packages on demand (`\boldsymbol`, `\cancel`). Nothing
  else may be typeset while one loads, or MathJax loses track of it; `math.wait`
  enforces this. Do not call `MathJax.tex2svg` around it.
- The published page may load scripts only from a few CDNs (cdnjs, jsdelivr,
  unpkg) and stylesheets only from Google Fonts. Everything else must be
  inline. This is why formulas are SVG: no font files and no stylesheet.
- No `alert`, `confirm` or `prompt` in the published page.
- The ask menu opens on `mouseup` and closes on `mousedown` outside it or on
  any scroll.
- A local with the name of an outer helper once broke "Check" in every side
  thread. The static check reports this kind; run it.
- This machine's shell is bash 3.2. A heredoc that contains backticks or `$(`
  is refused: put longer scripts in a file.
- In the Browser pane, screenshots can lag and the viewport size resets
  between turns. Read the DOM in preference to a screenshot.
- A page that is not on screen (the Browser pane hidden) gets no `resize`
  event and hears of its scrolls late. The page notes where each thread is on
  `scroll`, so a flow test that scrolls and then needs that note sends the
  event itself.

## Working rules here

- Git: local only, no remote. Commit finished, checked work. A feature goes
  on its own branch and is merged into `main` when the user says so. Never
  push.
- The live page acts on the user's Claude account. Pressing its permission
  prompts, or running a real question on it, needs the user's go-ahead each
  time. What is seen of the user's Notion there is private.
- What has and has not been seen working on the live page is tracked in the
  memory note about the artifact. Keep it current after each publish.
