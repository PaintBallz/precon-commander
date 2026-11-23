// Writes docs/state-machines.md from server/lifecycle.js. Run: npm run states
import fs from 'node:fs';
import { machinesMarkdown } from '../server/lifecycle.js';
fs.writeFileSync(new URL('../docs/state-machines.md', import.meta.url), machinesMarkdown());
console.log('Wrote docs/state-machines.md');
