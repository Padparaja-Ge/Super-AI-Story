import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
test('Windows launchers contain only ASCII and CRLF; package includes shared runtime check', () => {
  for (const file of ['Start-SAS.cmd', 'Start-SAS-Web.cmd', 'Start-SAS-Web-Shell.cmd', 'scripts/check-node.cmd']) {
    const data = fs.readFileSync(path.join(root, file));
    assert.ok(data.every(byte => byte < 128), file);
    assert.doesNotMatch(data.toString(), /(?<!\r)\n/, file);
  }
  assert.match(fs.readFileSync(path.join(root, 'scripts/package-web.mjs'), 'utf8'), /scripts\/check-node.cmd/);
});
test('All Windows source launchers show official download link when Node is absent', { skip: process.platform !== 'win32' }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const file of ['Start-SAS.cmd', 'Start-SAS-Web.cmd', 'Start-SAS-Web-Shell.cmd']) {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file], { cwd: root, env, windowsHide: true, encoding: 'utf8', input: '\r\n', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /https:\/\/nodejs.org\/en\/download/);
    assert.doesNotMatch(result.stdout + result.stderr, /not recognized|cannot find the path/i);
  }
});
