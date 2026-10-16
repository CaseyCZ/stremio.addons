const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtime = fs.readFileSync(path.join(root, 'addon.js'), 'utf8');
const configure = fs.readFileSync(path.join(root, 'public/configure.html'), 'utf8');
const failures = [];
if (!runtime.includes("require('./package.json').version")) failures.push('addon.js must read version from package.json');
if (/📦\s*Verze\s+\d+\.\d+\.\d+/.test(configure)) failures.push('configure.html contains a hard-coded version');
if (!configure.includes('id="versionBadge"') || !configure.includes('/health')) failures.push('configure.html must load version from /health');
if (failures.length) {
  console.error('Version linkage check failed:');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}
console.log(`Version linkage OK: ${pkg.name} v${pkg.version}`);
