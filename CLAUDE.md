# Human Distillation

A prototype of a chat for understanding complex ideas with Claude. It looks
like an ordinary chat, and any part of an answer can be asked about on its
own: a sentence, a few highlighted words, a formula, a symbol in a formula, a
box or link of a diagram. The side question opens beside the answer, so the
conversation is a tree and every branch is kept.

The why, the user's design decisions and their preferences are in the
project's memory notes, which load with every session on the author's
machine and are not in the repository. This file is about the code.
`README.md` is the account for a reader who comes to the repository: keep it
in step when a feature is added or the way to publish changes.

## Where things are

    live/                 the app (everything below is about this)
      page.html           the page, in the form Claude publishes (no <html>/<body>)
      styles.css
      llm.js              all that talks to Claude: the instructions, the prompts,
                          the calls, LLM.parse for what comes back, and the
                          inbox (answers sent in from another chat)
      app.js              the rest, in one closure
      dev-runtime.js      a stand-in for Claude, for local work only
      dev.py              the local preview server
      build.py            writes live/dist/human-distillation.html, the one
                          file that is published (git-ignored)
      test/, TESTING.md   the regression tests
    README.md, LICENSE    for readers of the repository (MIT)
    docs/                 the README's two screenshots, taken from the worked
                          example in the local preview. Retake them when the
                          page's look changes. Also `demo.gif` and `demo.mp4`,
                          recorded on the live artifact with Claude's own
                          answers: frames from the Chrome extension's
                          recorder, cut with ffmpeg (Claude's bar cropped,
                          the other conversations covered, captions added,
                          each scene opened with a pause). The last two
                          scenes are a later take in a smaller window, and
                          a little larger. The README's caption keeps to
                          one line and leaves these details to this file.
    index.html, app.js, content.js, styles.css (in the root)
                          the first mock, with canned content. Superseded; leave it.

## Run, test, publish

- Preview: `python3 live/dev.py`, or the `live` configuration in
  `.claude/launch.json`. Port 4174. `/` is the page with the stand-in, `/built`
  the built file, `/test` the flow tests.
- The stand-in answers with placeholder text. Words in a question steer it:
  `#math`, `#slow`, `#long`, `#error`, `#refuse`, `#deny`, "notion" and `#web`
  (with `#parts` or `#skim` for a long page, read whole or only its start).
  `?missing=web` or `?missing=notion` in the page's address plays a viewer
  who has not added that connector. For the inbox: `?send=sample` has a
  sample answer arrive, `claude.deliver({...})` in the console sends any
  other, `?missing=db` is a copy published without the store, and `?visitor`
  a viewer who is not the owner.
- Tests: `npm test` runs the parsing tests, the Notion tests, the web tests,
  the inbox tests and the static check. The flow
  tests run in the Browser pane at `/test`. `live/TESTING.md` explains all
  three, including the grid (every per-thread action in every kind of thread).
- Publish: the app lives as two Claude artifacts in the author's Claude
  account: one for experiments, and a copy for sharing, which is the one the
  README's "Try it now" line points to. Be sure which is meant before
  publishing. Their links are in the memory note about the artifact, and the
  experimental one's is kept out of this file, which is public. Order:
  `npm test`, then
  `python3 live/build.py`, then the flow tests on `/test?page=built`, then
  publish `live/dist/human-distillation.html` to that URL. From a new
  conversation, read the artifact first and pass the URL, or a second artifact
  is created. Leave `capabilities` out so the stored ones are kept (`sample`,
  and `mcp` for Notion's `notion-search` and `notion-fetch` and for Parallel
  Search's `web_search` and `web_fetch`). To add a connector, state the whole
  set: a stated set replaces the stored one. The inbox needs `db` with the
  rule `{path: "inbox", read: "owner", write: "owner"}`, as the README's
  publish step gives it. An artifact published before the inbox has no `db`
  stored, so its first publish with the inbox states the whole set. Never
  declare `db` without that rule: the default lets everyone the page is
  shared with read what was sent to it.
- Nothing is published without a full pass of the tests.

## How the app talks to Claude

The published page runs inside Claude and uses the runtime Claude gives it:
`claude.use("sample")` asks Claude on the viewer's own account, and
`claude.use("mcp")` calls the viewer's Notion connector. That is how the app
uses the user's existing connections with no sign-in of its own.

- Claude keeps nothing between calls. Every question is sent with the turns
  on the path that leads to it, and with the instructions in `rules()` as the
  first turn (there is no system prompt).
- The instructions state today's date from the viewer's clock (`dateWords`).
  Without it Claude takes the year its knowledge ends for the present.
- An answer is prose, then optionally one fenced `graph` block, then a line
  `@@@` followed by `term: <term> = <definition>` and `next: <question>` lines.
  Formulas are LaTeX: `$...$` in a sentence, `$$...$$` on a line of its own.
- The model is chosen by tier (Fast, Balanced, Deep), not by name.
- A question asked with a button is worded by the page in English and
  reaches Claude as the person's turn. Each ends with `WORDED`, which says
  the app wrote it and asks for the language of the answer it is about, and
  `rules()` explains the mark. Without it a Japanese thread is often
  answered in English. A typed question is not marked. Add `WORDED` to any
  new prompt the page words.
- Claude reads Notion through two functions the page lends it for one
  question, `notion_search` and `notion_fetch`. The page makes the connector
  call itself and hands the result back, and what it hands back may be 32 KB
  at most. So a longer page goes in numbered parts (`partsOf`): the first
  result says how many there are and what each holds, and Claude asks for the
  others with `part`. One answer reads 180 KB of pages at most, less in a long
  thread. Every result opens with the page's title and URL, and `rules()` asks
  for a link to the page at the end of each paragraph that draws on it. The answer keeps which parts were read (`parts`, `of` on the
  source).
- Claude does not remember what it read. Each later question is told every
  page the answers above it read and how much of each (`refs`, `howMuch`;
  it would otherwise take a cut repeat for a cut reading), with their text as
  far as 60 KB
  per answer goes, shared between that answer's pages (`settle`): short pages
  whole, long ones cut. When the thread is too long to send, the oldest
  answers' pages are cut down to their names. A question asked by pointing or
  with one click gets the Notion functions only if it was typed or its thread
  has read a page already (`notionFor`), so that it can read again.
- The web works the same way, through the viewer's Parallel Search connector
  (`WEB` in `llm.js`): `web_search` and `web_fetch` are lent for a question
  when "Search the web" is ticked. A web page is read in parts and carried on
  like a Notion page (its source has `from: 'web'`; a Notion source has no
  `from`). A search hands Claude excerpts; later questions get only what it
  found, by title and address (`found`, `searched`).
- `web_fetch` reads only an address that the person, a search result or a
  page already read has named (`mayRead`). An address Claude put together
  could carry what it read in the person's Notion out to another site. Keep
  this check when changing the tools.
- The inbox: `claude.use("db")` is a store Claude keeps for the artifact,
  which a Claude session of the owner can write to from outside (the
  `ArtifactData` tool here, the same from an ordinary chat). A chat's Claude
  writes one document to the collection `inbox`; the comment at the top of
  `page.html` is its instructions, found when it reads the artifact.
  `LLM.inbox` listens, `LLM.fromInbox` turns a document into turns, and
  `takeDocs` in `app.js` makes the conversation. Its turns have `given: true`
  and were never asked of Claude here; the first one's `prompt` ends with a
  note that says so and asks for the `@@@` section from then on, since the
  sent answers have none. `store.taken` keeps a document from being opened
  twice in one browser. The document stays in the store until its
  conversation is deleted.
- Only the artifact's owner can use the inbox: the rule says so, and the
  store refuses a write from an outside visitor whatever the rule. So it
  works on a person's own copy and never on a copy they were given a link
  to. `rt.inbox` is false for a viewer who is not the owner (`isOwner()`
  needs no declared capability).
- A connector the viewer has not added: `connectors()` asks the runtime for
  the list at load (listing never prompts) and `rt.missing` records what is
  absent. That lookup is then not lent to Claude, and the message box shows
  it as "not connected" in place of its tick box. A call refused as
  `server_not_connected` does the same from then on (`lacks`).

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
- Text: `blocks` reads paragraphs, lists, code, formulas, diagrams, and also
  tables and rules. Claude is told to write no headings and no tables here;
  those two exist for answers that were sent in. A heading becomes a bold
  paragraph.

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

- Git: commit finished, checked work. A feature goes on its own branch and
  is merged into `main` when the user says so. The repository is public on
  GitHub (`origin`, github.com/hideaki/human-distillation): push only when
  the user asks, each time, and only `main`.
- Nothing private goes into a tracked file or a commit message: no key, no
  address of the user's, nothing read in their Notion. Fixtures and the
  stand-in use made-up pages.
- The live page acts on the user's Claude account. Pressing its permission
  prompts, or running a real question on it, needs the user's go-ahead each
  time. What is seen of the user's Notion there is private.
- What has and has not been seen working on the live page is tracked in the
  memory note about the artifact. Keep it current after each publish.
