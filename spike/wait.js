// Attente sans `sleep` (absent sous Windows) : node spike/wait.js <secondes>, au plus 99.
const s = Math.min(Number(process.argv[2]) || 1, 99);
setTimeout(() => console.log(`attendu ${s} s`), s * 1000);
