---
title: Greet in another language
depends: [a]
ask: Should greet speak English only, or English and French?
---

If the answer is "English only": only add a test for an empty name in `greet.test.js`.

If the answer is "English and French": give `greet` an optional second parameter `lang`, `'en'` by
default. With `'fr'`, `greet('Ada', 'fr')` returns `Bonjour, Ada !`. Add tests for both languages.

In both cases, check that `npm test` passes.
