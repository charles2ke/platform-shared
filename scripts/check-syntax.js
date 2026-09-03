import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'examples', 'tests', 'scripts'];
const files = [];

function collect(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collect(path);
    } else if (path.endsWith('.js')) {
      files.push(path);
    }
  }
}

roots.forEach(collect);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
