import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const data = await mkdtemp(tmpdir() + '/number-mahjong-browser-');
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0', NM_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/localhost:(\d+)/);
      if (match) resolve(match[1]);
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Server exited: ' + code)));
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/time`)).status, 200);
  const smoke = spawn(process.execPath, ['tests/browser-test.mjs', `http://127.0.0.1:${port}`], { cwd: root, env: { ...process.env, PORT: port }, stdio: 'inherit' });
  const [code] = await once(smoke, 'exit');
  assert.equal(code, 0, 'Browser smoke failed');
} finally {
  if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  await rm(data, { recursive: true, force: true });
}
