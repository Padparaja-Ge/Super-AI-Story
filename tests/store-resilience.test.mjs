import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../server/store.mjs';
import { createApp, startServer } from '../server/index.mjs';
import { createTasks } from '../server/tasks.mjs';

const locked = code => Object.assign(new Error('Test destination is locked'), { code });
async function fixture(t, asyncRename, { retryDelays = [2, 4] } = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sas-store-lock-'));
  let armed = false;
  const io = {
    ...fs,
    renameSync(from, to) { if (armed) throw locked('EPERM'); return fs.renameSync(from, to); },
    promises: { ...fs.promises, async rename(from, to) { if (armed) return asyncRename(from, to); return fs.promises.rename(from, to); } },
  };
  const store = createStore(directory, { io, retryDelays });
  t.after(async () => { armed = false; await store.flush(); await fs.promises.rm(directory, { recursive: true, force: true }); });
  return { directory, store, io, arm: () => { armed = true; }, unlock: () => { armed = false; }, filename: path.join(directory, 'state.json') };
}

test('Transient replacement locks keep the newest revision and do not block the event loop', async t => {
  let attempts = 0;
  const f = await fixture(t, async (from, to) => { if (++attempts < 3) throw locked('EBUSY'); await fs.promises.rename(from, to); });
  const before = f.store.getState().revision;
  f.arm();
  const one = f.store.getState(); one.settings.userName = 'First'; f.store.saveState(one);
  const two = f.store.getState(); two.settings.userName = 'Latest'; f.store.saveState(two);
  const three = f.store.getState(); three.chats[0].summary = 'Newest partial generation'; f.store.saveState(three);
  let responsive = false; setImmediate(() => { responsive = true; });
  await f.store.flush();
  const disk = JSON.parse(await fs.promises.readFile(f.filename, 'utf8'));
  assert.equal(responsive, true);
  assert.equal(disk.revision, before + 3);
  assert.equal(disk.settings.userName, 'Latest');
  assert.equal(disk.chats[0].summary, 'Newest partial generation');
  assert.equal(f.store.getState().revision, disk.revision);
  assert.deepEqual((await fs.promises.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('Persistent lock reports failure, preserves the old disk file and a recoverable latest copy', async t => {
  const f = await fixture(t, async () => { throw locked('EPERM'); });
  const before = await fs.promises.readFile(f.filename, 'utf8');
  f.arm();
  const one = f.store.getState(); one.settings.userName = 'First unsaved'; f.store.saveState(one);
  const two = f.store.getState(); two.settings.userName = 'Latest unsaved'; f.store.saveState(two);
  await assert.rejects(f.store.flush(), error => error.code === 'STATE_SAVE_FAILED' && error.status === 500);
  assert.equal(await fs.promises.readFile(f.filename, 'utf8'), before);
  assert.equal(f.store.getState().settings.userName, 'Latest unsaved');
  const temporary = (await fs.promises.readdir(f.directory)).filter(name => name.endsWith('.tmp'));
  assert.ok(temporary.length);
  const copies = await Promise.all(temporary.map(name => fs.promises.readFile(path.join(f.directory, name), 'utf8').then(JSON.parse)));
  assert.ok(copies.some(copy => copy.settings.userName === 'Latest unsaved'));
  assert.throws(() => f.store.saveState(f.store.getState()), /Не удалось сохранить данные/);
  f.unlock(); await f.store.flush();
  assert.equal(JSON.parse(await fs.promises.readFile(f.filename, 'utf8')).settings.userName, 'Latest unsaved');
  assert.deepEqual((await fs.promises.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('A partial temporary write is never mistaken for a complete save or renamed', async t => {
  const f = await fixture(t, async (from, to) => fs.promises.rename(from, to));
  const before = await fs.promises.readFile(f.filename, 'utf8'), revision = f.store.getState().revision;
  f.io.writeFileSync = filename => { fs.writeFileSync(filename, '{"partial":'); throw locked('EPERM'); };
  const next = f.store.getState(); next.settings.userName = 'Must not commit';
  assert.throws(() => f.store.saveState(next), error => error.code === 'STATE_SAVE_FAILED');
  await f.store.flush();
  assert.equal(f.store.getState().revision, revision);
  assert.equal(await fs.promises.readFile(f.filename, 'utf8'), before);
  assert.deepEqual((await fs.promises.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('A revision arriving during failure-copy preparation remains the newest recoverable revision', async t => {
  const f = await fixture(t, async () => { throw locked('EPERM'); }, { retryDelays: [] });
  const oldDisk = await fs.promises.readFile(f.filename, 'utf8');
  let release, preparing;
  const gate = new Promise(resolve => { release = resolve; });
  const preparationStarted = new Promise(resolve => { preparing = resolve; });
  const originalWrite = f.io.promises.writeFile;
  f.io.promises.writeFile = async (filename, content, options) => {
    if (JSON.parse(content).settings.userName === 'Copy in progress') { preparing(); await gate; }
    await originalWrite(filename, content, options);
  };
  f.arm();
  const first = f.store.getState(); first.settings.userName = 'First locked'; f.store.saveState(first);
  const second = f.store.getState(); second.settings.userName = 'Copy in progress'; f.store.saveState(second);
  const failedFlush = f.store.flush();
  failedFlush.catch(() => {});
  await preparationStarted;
  const late = f.store.getState(); late.settings.userName = 'Arrived while copying'; f.store.saveState(late);
  const latestRevision = f.store.getState().revision;
  release();
  await assert.rejects(failedFlush, error => error.code === 'STATE_SAVE_FAILED');
  assert.equal(await fs.promises.readFile(f.filename, 'utf8'), oldDisk);
  assert.equal(f.store.getState().revision, latestRevision);
  const copies = await Promise.all((await fs.promises.readdir(f.directory)).filter(name => name.endsWith('.tmp')).map(name => fs.promises.readFile(path.join(f.directory, name), 'utf8').then(JSON.parse)));
  assert.ok(copies.some(copy => copy.revision === latestRevision && copy.settings.userName === 'Arrived while copying'));
  f.unlock(); await f.store.flush();
  const persisted = JSON.parse(await fs.promises.readFile(f.filename, 'utf8'));
  assert.equal(persisted.revision, latestRevision);
  assert.equal(persisted.settings.userName, 'Arrived while copying');
  assert.deepEqual((await fs.promises.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
});

test('JSON mutation responses wait for durable save and persistent errors return HTTP 500', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let permanentlyLocked = false;
  const f = await fixture(t, async (from, to) => { await gate; if (permanentlyLocked) throw locked('EPERM'); return fs.promises.rename(from, to); });
  const app = createApp({ dataDir: f.directory, store: f.store });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { f.unlock(); await app.locals.runtime.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const url = `http://127.0.0.1:${server.address().port}/api/state`;
  const put = state => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-SAS-Client': 'test' }, body: JSON.stringify(state) });
  f.arm();
  const next = f.store.getState(); next.settings.userName = 'Durable response';
  let replied = false;
  const responsePromise = put(next).then(response => { replied = true; return response; });
  await delay(20);
  assert.equal(replied, false);
  release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.userName, 'Durable response');
  const before = await fs.promises.readFile(f.filename, 'utf8');
  permanentlyLocked = true;
  const failed = f.store.getState(); failed.settings.userName = 'Cannot claim success';
  const rejected = await put(failed);
  assert.equal(rejected.status, 500);
  assert.match((await rejected.json()).error, /Не удалось сохранить данные/);
  assert.equal(await fs.promises.readFile(f.filename, 'utf8'), before);
});

test('Generation task remains running until durable flush and cannot finish successfully on permanent error', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let permanentlyLocked = false;
  const f = await fixture(t, async (from, to) => { await gate; if (permanentlyLocked) throw locked('EPERM'); await fs.promises.rename(from, to); });
  const tasks = createTasks({ flush: f.store.flush }); f.arm();
  const task = tasks.run({ kind: 'fanfic' }, () => { const state = f.store.getState(); state.chats[0].summary = 'Saved generated prose'; f.store.saveState(state); return 'result'; });
  await delay(10);
  assert.equal(task.job.status, 'running');
  release(); await task.promise;
  assert.equal(task.job.status, 'done');
  permanentlyLocked = true;
  const failed = tasks.run({ kind: 'fanfic' }, () => { f.store.saveState(f.store.getState()); return 'must not report success'; });
  await assert.rejects(failed.promise, /Не удалось сохранить данные/);
  assert.equal(failed.job.status, 'error');
});

test('Server close awaits final flush and releases the listener even when flushing fails', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sas-store-close-'));
  const runtime = await startServer({ dataDir: directory, port: 0 });
  t.after(async () => { await runtime.close().catch(() => {}); await fs.promises.rm(directory, { recursive: true, force: true }); });
  const originalFlush = runtime.app.locals.runtime.store.flush;
  let release, closed = false;
  const gate = new Promise(resolve => { release = resolve; });
  runtime.app.locals.runtime.store.flush = async () => { await gate; await originalFlush(); throw locked('EPERM'); };
  const closing = runtime.close().finally(() => { closed = true; });
  closing.catch(() => {});
  await delay(10);
  assert.equal(closed, false);
  release();
  await assert.rejects(closing, error => error.code === 'EPERM');
  assert.equal(runtime.server.listening, false);
});
