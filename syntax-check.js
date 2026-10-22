'use strict';
// Parses every server .js file without running it. Usage: npm run check
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let bad = 0;
for (const d of ['.', 'test']) for (const f of fs.readdirSync(path.join(root, d)).filter(x => x.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, d, f)], { stdio: 'pipe' }); console.log('OK  ', (d === '.' ? '' : d + '/') + f); }
  catch (e) { bad++; console.log('FAIL', d + '/' + f, String(e.stderr || e.message).split('\n')[0]); }
}
process.exit(bad ? 1 : 0);
