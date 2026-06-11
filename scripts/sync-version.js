// Runs on `npm version <bump>`: copies the new package.json version into the
// hardcoded constant in index.js so the deployed file stays self-contained.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const indexPath = path.join(root, 'index.js');

const src = fs.readFileSync(indexPath, 'utf8');
const updated = src.replace(/(\{ name: 'context-index', version: ')[^']*(' \})/, `$1${version}$2`);

if (updated === src && !src.includes(`version: '${version}'`)) {
  console.error('sync-version: could not find the version constant in index.js');
  process.exit(1);
}

fs.writeFileSync(indexPath, updated);
console.log(`sync-version: index.js -> ${version}`);
