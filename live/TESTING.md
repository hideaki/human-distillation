# Testing

Five layers. The first four need nothing installed.

| Layer | What it checks | How to run it |
| --- | --- | --- |
| Parsing tests | How the text Claude writes is read: paragraphs, lists, code, diagrams, formulas, money, the `@@@` trailer | `npm test` |
| Notion tests | How a Notion page is handed to Claude: a long one in parts, what one answer may read, what travels to the next question | `npm test` |
| Web tests | How the web is searched and read for Claude, which addresses may be read, and what happens when a connector is not there | `npm test` |
| Static check | A name that hides an outer name, a name used before it is defined | `npm test` (needs an ESLint, see below) |
| Flow tests | The real page, clicked through against the stand-in for Claude | open `/test` in the Browser pane |

**Before every publish:** run `npm test`, then run the flow tests and read
their result, then build and run them once more against the built file
(`/test?page=built`). The flow tests cannot run from the command line, so
nothing reminds you: a publish without them is unchecked.

## One command for everything headless

```bash
npm test
```

This is `node live/test/run.js`. It runs the parsing tests, the Notion tests,
the web tests, then the static check, and prints a summary. It exits with an
error if any fails.

## Parsing tests

```bash
node --test live/test/parse.test.js
```

`live/test/parse.test.js`, run by Node's own test runner. It covers the pure
functions of `app.js` (`blocks`, `runs`, `pieces`, `clip`, `parseGraph`,
`toMermaid`, `sentenceSpans`, `findTerm`) and `LLM.parse` in `llm.js`.

`app.js` starts the page as it loads, so it cannot be loaded in Node.
`live/test/extract.js` lifts the named functions out of its source text and
evaluates them alone. The app has no export that exists only for tests. If a
function is renamed, the test stops with a message that names it; update the
list at the top of `parse.test.js`.

## Notion tests

```bash
node --test live/test/notion.test.js
```

`live/test/notion.test.js` runs `llm.js` whole against a small stand-in for
the runtime: its `sample` plays Claude by calling the page's `notion_fetch` as
each test says, and its `mcp` returns the pages the test gives it. It checks
that a long page comes in parts that each fit a tool result and together are
the whole page, the list of what each part holds, the limit on what one answer
reads, and what is kept with the answer for later questions.

## Web tests

```bash
node --test live/test/web.test.js
```

`live/test/web.test.js` runs `llm.js` whole in the same way. Its `mcp` answers
as the Parallel Search connector does (the shapes are the ones the real
connector returned on 2026-11-19). It checks what a search and a page hand to
Claude, that a long web page comes in parts, that `web_fetch` reads only an
address the person, a search result or a page gave, what travels to the next
question, and that a connector the viewer has not added is neither offered
nor called.

## Static check

ESLint with two rules, set in `live/test/eslintrc.json`:

- `no-shadow`: a name that hides a name from an outer scope.
- `no-use-before-define`: a name used, in its own scope, before its definition.

Either rule reports the bug that this suite was started for: inside `check()`
a local `const about` hid the `about()` helper that the same line called.

`run.js` uses the ESLint in `node_modules` if there is one, otherwise one on
the `PATH`, and says "SKIPPED" if it finds none. This machine has ESLint 7.17
installed globally, and that is what has been used so far; nothing was added to
the project. To pin a version for the project instead:

```bash
npm install --save-dev eslint@8
```

The rules are written in the older "eslintrc" form, which ESLint 7, 8 and 9
all read (`run.js` sets `ESLINT_USE_FLAT_CONFIG=false` for 9). ESLint 10 does
not read that form.

## Flow tests

Start the preview server (`python3 live/dev.py`, or the `live` configuration
in `.claude/launch.json`) and open:

    http://localhost:4174/test

The page loads the real app in a frame, with `dev-runtime.js` standing in for
Claude, and drives it: it presses the mouse on sentences, formulas, symbols and
diagram parts, types into the boxes, and reads the result from the page and
from storage. A full run takes about three minutes. It needs the network, for
MathJax and the diagram layout library.

Reading the result:

- In the page: a summary line, the grid, and one line per test, with the
  reason under each failure.
- From outside (the Browser pane's JavaScript tool): `window.__results.done`,
  `window.__results.text()` for the summary and every failure,
  `window.__results.grid` and `window.__results.tests`. The tab's title also
  starts with `PASSED` or `FAILED` when the run ends.

Options, as query parameters:

- `/test?only=formula` runs the tests whose name contains those words.
- `/test?page=built` drives the single file that gets published. Run
  `python3 live/build.py` first.

A test can load the page for a viewer who lacks a connector:
`given('main', { query: 'missing=web' })`. The stand-in reads this from the
address of the page (`missing=` for a connector that is not listed, `gone=`
for one that is listed but refuses calls; `web`, `notion`, or both with a
comma).

The Browser pane does not have to be showing. The tests poll instead of
sleeping, and transitions are switched off in the page under test (see
`probe.js`), because a page that is not on screen draws no frames. A hidden
run is slower, about four minutes. Do not show or hide the pane in the middle
of a run: the page closes its menus when it hears of a scroll, and a hidden
page hears of its scrolls only when it is shown again. If a test fails and its
message says a menu closed because something scrolled, run that test again
with `?only=`.

### What a test may rely on

- Every test loads the page afresh. Storage is either empty (the page then
  shows its worked example) or a saved state that the suite produced earlier
  in the same run by really clicking through the page: the first question
  answered, and one such state per kind of thread. `given('passage')` in
  `flow.js` loads one. This keeps the run short; no test depends on what
  another test left behind.
- A test fails on a failed expectation, and also on any uncaught error,
  unhandled rejection, `console.error` or script that fails to load in the
  page. `live/test/probe.js` records these. It is added only to the
  `/under-test` pages of `dev.py`, never to the published page.
- `probe.js` also records each request made to Claude (`window.__calls`), so a
  test can check which turns were sent and what the question said.
- A click is delivered as a browser delivers it: press, hold for 70 ms,
  release on whatever is under the pointer by then. If the page replaced the
  pressed element in between, no click is sent, as in a real browser.

### The grid

A bug shipped because "Check" was only ever tried in the main thread. So each
action that every thread offers is run once in each kind of thread:

| | Main thread | Passage | Formula | Symbol | Diagram part |
| --- | --- | --- | --- | --- | --- |
| Typed message | ✓ | ✓ | ✓ | ✓ | ✓ |
| Follow-up chips | ✓ | ✓ | ✓ | ✓ | ✓ |
| Check (Explain it back) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Got it, and Reopen | not offered | ✓ | ✓ | ✓ | ✓ |
| Write-up | ✓ | ✓ | ✓ | ✓ | ✓ |

The main thread has no "Got it"; its cell checks that the button is absent.
The "Check" cell writes an explanation in the message box, sends it, and then
treats the check as the ordinary turn it is: it answers it, asks about a
sentence of it, and looks for it in the map and the write-up.

**When you add an action that every thread has, add it to `ACTIONS` in
`flow.js`. When you add a kind of thread, add it to `KINDS`.** The loop at the
end of the grid section then runs every pair.

## Files

    live/test/parse.test.js   the parsing tests
    live/test/notion.test.js  the Notion tests
    live/test/web.test.js     the web tests
    live/test/extract.js      gets the app's pure functions into Node
    live/test/eslintrc.json   the two rules of the static check
    live/test/run.js          the one command (npm test)
    live/test/flow.html       the page served at /test
    live/test/flow.js         the flow tests and their small harness
    live/test/probe.js        records errors and requests in the page under test
