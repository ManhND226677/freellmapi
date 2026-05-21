import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'vendor');
const lunaDir = join(vendorDir, 'luna-proxy');
const repoUrl = 'https://github.com/wholock2210/Luna-Proxy.git';
const shouldUpdate = process.argv.includes('--update');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    const rendered = [command, ...args].join(' ');
    throw new Error(`${rendered} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function hasCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

mkdirSync(vendorDir, { recursive: true });

if (!existsSync(join(lunaDir, '.git'))) {
  run('git', ['clone', repoUrl, lunaDir], root);
} else if (shouldUpdate) {
  run('git', ['pull', '--ff-only'], lunaDir);
}

if (!existsSync(join(lunaDir, 'node_modules'))) {
  run('npm', ['install'], lunaDir);
}

if (!hasCommand('bun')) {
  console.warn('[luna] Bun is required by Luna-Proxy dev scripts. Install Bun before running npm run luna:dev.');
}

console.log(`[luna] Ready at ${lunaDir}`);
