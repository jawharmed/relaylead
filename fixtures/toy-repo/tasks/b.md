---
title: Greet in another language
depends: [a]
ask: Should greet also accept an optional language (en or fr)?
---

If the answer is yes: give `greet` an optional second parameter `lang`, `'en'` by default.
With `'fr'`, `greet('Ada', 'fr')` returns `Bonjour, Ada !`. Add tests for both languages.

Otherwise: only add a test for an empty name in `greet.test.js`.

In both cases, check that `npm test` passes.
