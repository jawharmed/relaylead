// The documentation exists in English (docs/, README.md) and in French (docs/fr/, README.fr.md). These
// tests keep the two from drifting apart: each page has its twin, with the same `##` sections in the
// same order. Titles are translated, so the order is checked through what stays the same in both
// languages: the `code` spans of each title (commands, options, file names).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const fr = path.join(docs, 'fr');

// The `##` titles of a Markdown file, outside fenced code blocks.
function sections(file) {
  const titles = [];
  let fence = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      continue;
    }
    if (fence === null && /^## /.test(line)) titles.push(line.slice(3).trim());
  }
  return titles;
}

const codeSpans = (title) => title.match(/`[^`]+`/g) || [];

function pages(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
}

test('every English page of docs/ has its French twin in docs/fr/, and the reverse', () => {
  const english = pages(docs);
  assert.ok(english.length > 0, 'docs/ holds no page');
  assert.deepStrictEqual(pages(fr), english);
});

for (const page of pages(docs)) {
  test(`docs/${page} and docs/fr/${page} have the same ## sections, in the same order`, () => {
    const en = sections(path.join(docs, page));
    const other = sections(path.join(fr, page));
    assert.strictEqual(other.length, en.length, `## sections: ${en.length} in English, ${other.length} in French\n${en.join('\n')}\n---\n${other.join('\n')}`);
    en.forEach((title, index) => {
      assert.deepStrictEqual(codeSpans(other[index]), codeSpans(title), `section ${index + 1}: "${title}" / "${other[index]}"`);
    });
  });
}

test('README.md and README.fr.md have the same number of ## sections', () => {
  const en = sections(path.join(root, 'README.md'));
  const other = sections(path.join(root, 'README.fr.md'));
  assert.ok(en.length > 0, 'README.md has no ## section');
  assert.strictEqual(other.length, en.length, `${en.join('\n')}\n---\n${other.join('\n')}`);
});
