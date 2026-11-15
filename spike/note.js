// Écrit une note de résultat dans RL_OUT : node spike/note.js <fichier> <texte...> (ajoute une ligne).
const fs = require('node:fs');
const { out } = require('./lib');
const [file, ...text] = process.argv.slice(2);
fs.mkdirSync(out(), { recursive: true });
fs.appendFileSync(out(file), `${text.join(' ')}\n`);
console.log(`noté dans ${file}`);
