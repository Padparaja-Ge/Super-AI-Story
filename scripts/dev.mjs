import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const children = new Set();
let stopping = false;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Порт ${port} уже занят. Закройте предыдущий запуск SAS или приложение на этом порту.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function launch(label, args, ipc = false) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, PORT: '3210', SAS_PORT: '3210', SAS_DATA_DIR: process.env.SAS_DATA_DIR || path.join(root, 'data') },
    windowsHide: true,
    shell: false,
    stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
  });
  children.add(child);
  child.once('error', error => {
    console.error(`${label}: ${error.message}`);
    void stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${label} завершён (${signal || code || 0}).`);
      void stop(code || 0);
    }
  });
  return child;
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 20_000;
  while (!stopping && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Сервер завершился до запуска интерфейса.');
    const ready = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = result => { socket.destroy(); resolve(result); };
      socket.setTimeout(300, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (ready) return;
    await delay(150);
  }
  throw new Error(`Сервер на порту ${port} не запустился за 20 секунд.`);
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  const active = [...children];
  for (const child of active) {
    if (child.connected) child.send({ type: 'sas:shutdown' }, () => {});
    else child.kill('SIGTERM');
  }
  const deadline = Date.now() + 4_000;
  while (children.size && Date.now() < deadline) await delay(100);
  for (const child of children) child.kill('SIGKILL');
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));
process.once('uncaughtException', error => { console.error(error); void stop(1); });

try {
  await access(vite);
  await requireFreePort(3210);
  await requireFreePort(5173);
  const backend = launch('SAS API', [path.join(root, 'server', 'index.mjs')], true);
  await waitForPort(3210, backend);
  if (!stopping) {
    launch('SAS UI', [vite, '--host', '127.0.0.1']);
    console.log('\nSAS: http://127.0.0.1:5173\nОстановка обоих процессов: Ctrl+C.\n');
  }
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Зависимости не установлены. Сначала выполните npm install.' : error.message);
  await stop(1);
}
