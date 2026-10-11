import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDiff } from '../src/diff';
import { previewRows } from '../src/preview';
import { colorSegments, syntaxLanguage, syntaxLines } from '../src/panel/syntax';

const highlighter = import('lowlight').then(({ common, createLowlight }) => createLowlight(common));

test('selected diff lines retain multiline comment context from outside the excerpt', async () => {
  const source = ['/*', ...Array.from({ length: 7 }, (_, i) => `comment line ${i}`), '*/', 'const price = 60;'].join('\n');
  const tokens = syntaxLines((await highlighter).highlight('typescript', source), [8, 10]);
  assert.deepEqual(Object.keys(tokens), ['8', '10'], 'only requested lines are returned');
  assert.ok(tokens[8]!.every(token => token.classes.includes('hljs-comment')));
  assert.equal(tokens[8]!.map(token => token.text).join(''), 'comment line 6');
  assert.ok(tokens[10]!.some(token => token.text === 'const' && token.classes.includes('hljs-keyword')));
  assert.ok(tokens[10]!.some(token => token.text === '60' && token.classes.includes('hljs-number')));
});

test('syntax colors intersect character changes on both sides without changing source', async () => {
  const old = 'const threshold = 100;\n', current = 'const threshold = 60;\n';
  const row = previewRows(old, current, computeDiff(old, current).hunks, 0)[0]!;
  for (const [source, line, number, changed] of [[old, row.old!, '100', '10'], [current, row.current!, '60', '6']] as const) {
    const tokens = syntaxLines((await highlighter).highlight('typescript', source), [1])[1];
    const colored = colorSegments(line.segments, tokens);
    assert.equal(colored.map(segment => segment.text).join(''), source.trimEnd());
    assert.equal(colored.filter(segment => segment.changed).map(segment => segment.text).join(''), changed);
    assert.equal(colored.filter(segment => segment.classes.includes('hljs-number')).map(segment => segment.text).join(''), number);
    assert.ok(colored.filter(segment => segment.changed).every(segment => segment.classes.includes('hljs-number')));
    assert.ok(colored.some(segment => segment.text === 'const' && !segment.changed && segment.classes.includes('hljs-keyword')));
  }
});

test('markup-looking strings and Unicode remain literal source text in syntax spans', async () => {
  const source = 'const html = "<img src=x onerror=alert(1)> 👋";';
  const tokens = syntaxLines((await highlighter).highlight('javascript', source), [1])[1];
  const colored = colorSegments([{ text: source }], tokens);
  assert.equal(colored.map(segment => segment.text).join(''), source);
  assert.ok(colored.some(segment => segment.text.includes('<img') && segment.classes.includes('hljs-string')));
  assert.ok(colored.every(segment => segment.classes.every(name => /^[a-zA-Z_][\w-]*$/.test(name))));
});

test('long-line syntax output is bounded and still matches clipped previews and later lines', async () => {
  const source = `const value = "${'x'.repeat(1984)}👋${'y'.repeat(2000)}";\nconst next = 12;\n`;
  const tokens = syntaxLines((await highlighter).highlight('typescript', source), [1, 2]);
  assert.ok(tokens[1]!.reduce((length, token) => length + token.text.length, 0) <= 2000);
  const rows = previewRows('', source, computeDiff('', source).hunks, 0);
  const line = rows[0]!.current!;
  const colored = colorSegments(line.segments, tokens[1]);
  assert.equal(colored.map(segment => segment.text).join(''), line.segments.map(segment => segment.text).join(''));
  assert.equal(tokens[2]!.map(token => token.text).join(''), 'const next = 12;');
  assert.ok(tokens[2]!.some(token => token.text === '12' && token.classes.includes('hljs-number')));
});

test('language aliases support React and shell files, and mismatched tokens fall back to plain text', async () => {
  const syntax = await highlighter;
  for (const id of ['typescriptreact', 'javascriptreact', 'shellscript', 'vue']) {
    assert.ok(syntax.registered(syntaxLanguage(id)), id);
  }
  assert.equal(syntax.registered(syntaxLanguage('unknown-language')), false);
  assert.deepEqual(colorSegments([{ text: 'new', changed: true }], [{ text: 'old', classes: ['hljs-string'] }]),
    [{ text: 'new', changed: true, classes: [] }]);
});
