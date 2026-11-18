// Gets the app's pure functions into Node without changing the app.
//
// app.js is one function that starts the page as it runs, so it cannot be
// loaded outside a browser. Its parsing functions touch nothing on the page,
// though, so they are lifted out by name from the source text and evaluated
// on their own. A name that can no longer be found is an error that says so.
//
// llm.js only needs a `window` to look at, so it is run whole.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIVE = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(LIVE, name), 'utf8');

// One top-level declaration of app.js, as source text. Inside the app's
// wrapper every top-level declaration is indented by two spaces, and that is
// what marks where one ends: a function at the line "  }", anything else at
// the first line indented by two spaces that ends in ";".
function declaration(lines, name) {
  const esc = name.replace(/[$]/g, '\\$&');
  const fn = new RegExp(`^  function ${esc}\\(`);
  const val = new RegExp(`^  (?:const|let) ${esc} = `);
  const from = lines.findIndex(l => fn.test(l) || val.test(l));
  if (from < 0) throw new Error(`live/app.js has no top-level "${name}" any more. Update the list in live/test/parse.test.js.`);
  const isFn = fn.test(lines[from]);
  for (let to = from; to < lines.length; to++) {
    const l = lines[to];
    const ends = isFn ? l === '  }' : /^ {2}\S.*;\s*(\/\/.*)?$/.test(l) || (to === from && /;\s*(\/\/.*)?$/.test(l));
    if (ends) return lines.slice(from, to + 1).join('\n');
  }
  throw new Error(`Could not find where "${name}" ends in live/app.js.`);
}

// { name: value } for the named declarations, in the order given (a constant
// must come after the ones it is built from).
function fromApp(names) {
  const lines = read('app.js').split('\n');
  const src = names.map(n => declaration(lines, n)).join('\n\n');
  const body = `'use strict';\n${src}\nreturn { ${names.join(', ')} };`;
  return new Function(body)();
}

// The LLM object of llm.js, as it is when no Claude is reachable.
function llm() {
  return new Function('window', 'TextEncoder', read('llm.js') + '\nreturn LLM;')({}, TextEncoder);
}

module.exports = { fromApp, llm, read };
