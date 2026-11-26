// Stops the background daemon started by bin/launch.js.

import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../src/config.js';

const file = path.join(defaultDataDir(), 'runtime.json');
let runtime;
try {
  runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  console.log('Paste 没有在运行');
  process.exit(0);
}

try {
  process.kill(runtime.pid, 'SIGTERM');
  console.log(`已停止 Paste (pid ${runtime.pid})`);
} catch {
  console.log('Paste 没有在运行');
}
