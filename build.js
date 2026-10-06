'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');

const template = fs.readFileSync(path.join(SRC, 'template.html'), 'utf8');
const interB64 = fs.readFileSync(path.join(SRC, 'fonts', 'inter-latin.woff2.b64.txt'), 'utf8').trim();
const outfitB64 = fs.readFileSync(path.join(SRC, 'fonts', 'outfit-latin.woff2.b64.txt'), 'utf8').trim();
const fontsCss = fs.readFileSync(path.join(SRC, 'fonts.css'), 'utf8')
  .replace('/*__INTER_FONT_B64__*/', () => interB64)
  .replace('/*__OUTFIT_FONT_B64__*/', () => outfitB64);
const styles = fontsCss + '\n' + fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

const scripts = ['engine.js', 'db.js', 'app.js']
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8'))
  .join('\n\n');

// Use function replacers: a string replacement would interpret "$&", "$1",
// etc. inside styles/scripts (app.js is full of ${...} template literals).
const output = template
  .replace('/*__STYLES__*/', () => styles)
  .replace('/*__SCRIPTS__*/', () => scripts);

fs.writeFileSync(path.join(__dirname, 'index.html'), output);
console.log('Built index.html (%d bytes)', output.length);
