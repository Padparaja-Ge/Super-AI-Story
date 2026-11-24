import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../server/index.mjs';
import { getConnection, streamCompletion } from '../server/llm.mjs';
import { parseShareInvitation } from '../server/model-share.mjs';

const data = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SAS-Client': 'test' }, body: JSON.stringify(body) });
const state = async (base) => (await fetch(base + '/api/state')).json();
function gpuStub() {
  let requests = 0;
  let active;
  let unblock;
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer owner-key');
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'owner-model' }] }));
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    let buffer = '';
    for await (const chunk of req) buffer += chunk;
    const body = JSON.parse(buffer);
    requests++;
    assert.equal(body.model, 'owner-model');
    if (body.messages.at(-1).content === 'hold') {
      active = res;
      const finished = new Promise(resolve => { unblock = resolve; });
      called();
      await finished;
    }
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ответ общей модели.' } }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  return { server, requests: () => requests, started,
    release() { unblock?.(); },
    active: () => active,
  };
}

test('Model sharing uses a separate API, session credentials, a bounded text stream and explicit revocation', {timeout: 15000}, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sas-model-share-'));
  const gpu = gpuStub();
  await new Promise(resolve => gpu.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gpu.release(); gpu.server.closeAllConnections(); await new Promise(resolve => gpu.server.close(resolve)); });
  const host = await startServer({ port: 0, dataDir: path.join(folder, 'host') });
  const guest = await startServer({ port: 0, dataDir: path.join(folder, 'guest') });
  t.after(async () => { await Promise.all([host.close(), guest.close()]); await fs.rm(folder, { recursive: true, force: true }); });
  const hostUrl = 'http://127.0.0.1:' + host.port, guestUrl = 'http://127.0.0.1:' + guest.port;
  const hostState = await state(hostUrl);
  const source = { id: 'owner-loopback', name: 'Owner', kind: 'openai', baseUrl: 'http://127.0.0.1:' + gpu.server.address().port + '/v1',
    model: 'owner-model', contextWindow: 2048, maxTokens: 384, temperature: .8 };
  hostState.connections.push(source);
  await host.app.locals.runtime.store.saveState(hostState);
  host.app.locals.runtime.secrets.set(source.id, 'owner-key');

  const missingGrant = await fetch(hostUrl + '/api/model-share/start', data({ connectionId: source.id, address: '0.0.0.0' }));
  assert.equal(missingGrant.status, 400);
  const opened = await fetch(hostUrl + '/api/model-share/start', data({ connectionId: source.id }));
  assert.equal(opened.status, 200);
  const publicStatus = await opened.json();
  assert.equal(publicStatus.state, 'running');
  assert.equal(publicStatus.guestAddress, '127.0.0.1');
  assert.equal(publicStatus.remaining, 60);
  const { invitation } = await (await fetch(hostUrl + '/api/model-share/invitation', data({}))).json();
  const { baseUrl, token } = parseShareInvitation(invitation);
  assert.notEqual(new URL(baseUrl).port, new URL(hostUrl).port);
  assert.equal(JSON.stringify(publicStatus).includes(token), false);
  const authenticated = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch(baseUrl + '/models')).status, 401);
  const mismatchedHost = await new Promise((resolve, reject) => {
    http.get(baseUrl + '/models', { headers: { ...authenticated, Host: 'example.invalid' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(mismatchedHost, 403);
  assert.equal((await fetch(baseUrl + '/models', { headers: { ...authenticated, Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(new URL('/api/state', baseUrl), { headers: authenticated })).status, 404);

  const joined = await fetch(guestUrl + '/api/model-share/join', data({ invitation }));
  assert.equal(joined.status, 200);
  const { connectionId } = await joined.json();
  const guestState = await state(guestUrl);
  assert.equal(guestState.activeConnectionId, connectionId);
  assert.equal(guestState.connections.find(item => item.id === connectionId).contextWindow, 2048);
  assert.equal(JSON.stringify(guestState).includes(token), false);
  const providerCheck = await fetch(guestUrl + '/api/connections/' + connectionId + '/test', data({}));
  assert.deepEqual(await providerCheck.json(), { ok: true, models: ['sas-shared-text'] });
  const rejoin = await fetch(guestUrl + '/api/model-share/join', data({ invitation }));
  assert.equal((await rejoin.json()).connectionId, connectionId);

  // Invoke the same ordinary OpenAI-style connection that SAS uses for all story modes.
  const connection = getConnection(guestState);
  const makeRequest = (content, extra = {}) => fetch(baseUrl + '/chat/completions', {
    ...data({ model: connection.model, messages: [{ role: 'user', content }], ...extra }),
    headers: { ...authenticated, 'Content-Type': 'application/json' },
  });
  const bad = await makeRequest([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]);
  assert.equal(bad.status, 400);
  const over = await makeRequest('a'.repeat(9000));
  assert.equal(over.status, 413);
  assert.equal(gpu.requests(), 0);

  let text = '';
  for await (const chunk of streamCompletion(connection, token, [{ role: 'user', content: 'Привет' }])) text += chunk;
  assert.equal(text, 'Ответ общей модели.');
  assert.equal(gpu.requests(), 1);

  const ongoing = makeRequest('hold', { stream: true });
  const canceled = assert.rejects(ongoing);
  await gpu.started;
  assert.equal((await makeRequest('too late')).status, 429);
  assert.equal((await fetch(hostUrl + '/api/model-share/stop', data({}))).status, 200);
  await canceled;
  assert.equal(gpu.requests(), 2);
  assert.ok(gpu.active());
  gpu.release();
  await assert.rejects(fetch(baseUrl + '/models', { headers: authenticated }));
  assert.equal((await fetch(hostUrl + '/api/model-share/invitation', data({}))).status, 409);
});

test('Invitations only declare a bounded local numeric IPv4 and a dedicated bearer key', () => {
  const make = settings => 'SAS-SHARE-1.' + Buffer.from(JSON.stringify(settings)).toString('base64url');
  const valid = { address: '26.24.12.9', port: 3213, token: 'x'.repeat(43) };
  assert.equal(parseShareInvitation(make(valid)).baseUrl, 'http://26.24.12.9:3213/v1');
  for (const change of [
    { address: '8.8.8.8' }, { address: '169.254.169.254' }, { address: 'localhost' },
    { address: '127.1' }, { port: 443 }, { token: 'token' },
  ]) assert.throws(() => parseShareInvitation(make({ ...valid, ...change })));
});
