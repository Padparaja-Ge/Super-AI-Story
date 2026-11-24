import crypto from 'node:crypto';
import http from 'node:http';
import { isIPv4 } from 'node:net';
import { once } from 'node:events';
import express from 'express';
import { getConnection, listModels, sharedConnectionPrefix, streamCompletion } from './llm.mjs';
import { messageTokens } from './prompt.mjs';
import { networkInterfaces, normalizeIP } from './network.mjs';

const service = 'sas-text-share-beta';
const sharedModel = 'sas-shared-text';
const invitePrefix = 'SAS-SHARE-1.';
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const maxRequests = 60;
const maxRequestsPerMinute = 12;
const maxMessages = 256;
const maxBodyBytes = 512 * 1024;
const maxOutputChars = 32_768;
const maxRequestMs = 180_000;

const error = (status, message) => Object.assign(new Error(message), { status });
const report = (res, status, message) => res.status(status).json({ error: { message } });
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const keyDigest = value => crypto.createHash('sha256').update(value).digest();

function localShareAddress(value) {
  if (!isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  // RFC 1918, Tailscale/CGNAT, and the range used by Radmin VPN.
  return value === '127.0.0.1' || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a === 26;
}

function invitation(address, port, token) {
  return invitePrefix + Buffer.from(JSON.stringify({ address, port, token }), 'utf8').toString('base64url');
}

export function parseShareInvitation(raw) {
  if (typeof raw !== 'string' || raw.length > 512) throw error(400, 'Вставьте приглашение на генерацию.');
  const value = raw.trim();
  let settings;
  if (value.startsWith(invitePrefix) && /^[A-Za-z0-9_-]+$/.test(value.slice(invitePrefix.length))) {
    try { settings = JSON.parse(Buffer.from(value.slice(invitePrefix.length), 'base64url').toString('utf8')); }
    catch { /* Return the same message for malformed invitations. */ }
  }
  const { address, port, token } = settings || {};
  if (typeof address !== 'string' || !localShareAddress(address)
    || !Number.isInteger(port) || port < 1024 || port > 65535
    || typeof token !== 'string' || !keyPattern.test(token)) {
    throw error(400, 'Приглашение на генерацию недействительно.');
  }
  return { baseUrl: 'http://' + address + ':' + port + '/v1', token };
}

function localConnection(connection) {
  if (!connection || connection.id === 'sas-embedding' || connection.id.startsWith(sharedConnectionPrefix)
    || !String(connection.model || '').trim()) return false;
  try {
    const url = new URL(connection.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function parseRequest(body, caps) {
  if (!body || body.model !== sharedModel || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > maxMessages) {
    throw error(400, 'Для общей генерации укажите текстовый запрос с выбранной общей моделью.');
  }
  if (body.tools !== undefined || body.tool_choice !== undefined || body.functions !== undefined
    || body.grammar !== undefined || body.prompt !== undefined || body.n !== undefined && body.n !== 1) {
    throw error(400, 'Общая модель принимает только текстовые сообщения.');
  }
  const messages = body.messages.map(message => {
    if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string'
      || message.content.length > 128_000 || message.tool_calls !== undefined) {
      throw error(400, 'Общая модель принимает только текстовые сообщения.');
    }
    return { role: message.role, content: message.content };
  });
  const available = caps.contextWindow - messageTokens(messages) - 64;
  if (available < 32) throw error(413, 'Запрос не помещается в контекст общей модели. Сократите контекст у получателя.');
  const maxTokens = Math.min(available, Math.floor(bounded(body.max_tokens, caps.maxTokens, 1, caps.maxTokens)));
  let stop;
  if (body.stop !== undefined) {
    stop = typeof body.stop === 'string' ? [body.stop] : body.stop;
    if (!Array.isArray(stop) || stop.length > 8 || stop.some(item => typeof item !== 'string' || !item.length || item.length > 200)) {
      throw error(400, 'Недопустимые стоп-последовательности общей модели.');
    }
  }
  let responseFormat;
  if (body.response_format !== undefined) {
    if (!['json_object', 'json_schema', 'text'].includes(body.response_format?.type)) {
      throw error(415, 'Общая модель поддерживает текст и JSON.');
    }
    // Use plain JSON mode. SAS callers validate their reply against their own schema.
    if (body.response_format.type !== 'text') responseFormat = { type: 'json_object' };
  }
  return { messages, maxTokens, stop, responseFormat, stream: body.stream === true,
    temperature: bounded(body.temperature, .8, 0, 2), topP: bounded(body.top_p, .95, 0, 1) };
}

async function readDiscovery(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw error(502, 'Общая модель недоступна. Проверьте сеть и попросите новое приглашение.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, data = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) throw error(502, 'Не удалось прочитать данные общей модели.');
      data += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(data + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createModelShare({
  getState, saveState, getSecret = () => '', assertIdle = () => {}, hostBusy = () => false,
  addresses = networkInterfaces, models = listModels, generate = streamCompletion, fetcher = fetch,
} = {}) {
  const router = express.Router();
  const recipientSessions = new Map();
  let host = null, starting = null, stopping = null, closed = false;

  const interfaces = () => [{ address: '127.0.0.1', name: 'Loopback' }, ...addresses()
    .filter(item => !item.internal && localShareAddress(item.address))
    .filter((item, index, items) => items.findIndex(candidate => candidate.address === item.address) === index)
    .map(({ address, name }) => ({ address, name }))];

  function status() {
    const current = host;
    return {
      state: current ? 'running' : starting ? 'starting' : stopping ? 'stopping' : 'stopped',
      interfaces: interfaces(),
      connections: getState().connections.filter(localConnection).map(({ id, name, model }) => ({ id, name, model })),
      ...(current ? { address: current.address, port: current.port, guestAddress: current.guestAddress,
        model: current.connection.model, expiresAt: current.expiresAt, active: !!current.request, used: current.used,
        remaining: maxRequests - current.used, contextWindow: current.contextWindow, maxTokens: current.maxTokens } : {}),
    };
  }

  async function stop() {
    starting?.controller.abort();
    const current = host;
    if (!current) return stopping || starting?.promise?.catch(() => {});
    host = null;
    clearTimeout(current.timer);
    current.request?.abort();
    stopping = new Promise(resolve => {
      current.server.close(resolve);
      current.server.closeAllConnections();
    }).finally(() => { stopping = null; });
    await stopping;
  }

  function createEndpoint(session) {
    const publicApi = express();
    publicApi.disable('x-powered-by');
    publicApi.set('etag', false);
    publicApi.use((req, res, next) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.headers.origin) return report(res, 403, 'Прямые запросы из браузера отключены. Используйте подключение SAS.');
      if (normalizeIP(req.socket.remoteAddress) !== session.guestAddress) {
        return report(res, 403, 'Адрес получателя не разрешён.');
      }
      if (req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length !== 1
        || req.headers.host !== session.authority) return report(res, 403, 'Недопустимый адрес сервера.');
      if (Date.now() >= session.expiresAt) return report(res, 401, 'Срок действия приглашения истёк.');
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
      if (!token || !crypto.timingSafeEqual(keyDigest(token), session.digest)) {
        return report(res, 401, 'Приглашение не подходит или сеанс завершён.');
      }
      next();
    });

    publicApi.get('/v1/models', (_req, res) => res.json({
      object: 'list', data: [{ id: sharedModel, object: 'model', owned_by: 'sas' }],
      service, contextWindow: session.contextWindow, maxTokens: session.maxTokens,
    }));
    publicApi.post('/v1/chat/completions', (req, res, next) => {
      if (session.request || hostBusy()) return report(res, 429, 'Модель занята. Повторите запрос позже.');
      const cutoff = Date.now() - 60_000;
      session.requests = session.requests.filter(time => time > cutoff);
      if (session.used >= maxRequests) return report(res, 429, 'Лимит генераций по приглашению исчерпан.');
      if (session.requests.length >= maxRequestsPerMinute) return report(res, 429, 'Слишком много запросов. Повторите через минуту.');
      if (!req.is('application/json')) return report(res, 415, 'Требуется JSON с текстовыми сообщениями.');
      next();
    }, express.json({ limit: maxBodyBytes, inflate: false }), async (req, res) => {
      if (session.request || hostBusy()) return report(res, 429, 'Модель занята. Повторите запрос позже.');
      if (session.used >= maxRequests || session.requests.length >= maxRequestsPerMinute) {
        return report(res, 429, 'Достигнут лимит запросов к общей модели.');
      }
      if (Date.now() >= session.expiresAt) return report(res, 401, 'Срок действия приглашения истёк.');
      const request = parseRequest(req.body, session);
      const current = getState().connections.find(item => item.id === session.connection.id);
      if (!localConnection(current) || current.baseUrl !== session.connection.baseUrl || current.model !== session.connection.model) {
        return report(res, 409, 'Модель или её адрес изменились. Владелец должен открыть новый сеанс.');
      }

      session.used++;
      session.requests.push(Date.now());
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(maxRequestMs)]);
      session.request = controller;
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', cancel);
      let finishReason = 'stop', text = '', outputSize = 0;
      const id = 'chatcmpl-' + crypto.randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const sendChunk = async (delta, finish_reason = null) => {
        if (!res.headersSent) res.set('Content-Type', 'text/event-stream; charset=utf-8');
        const data = JSON.stringify({ id, object: 'chat.completion.chunk', created, model: sharedModel,
          choices: [{ index: 0, delta, finish_reason }] });
        if (!res.write('data: ' + data + '\n\n')) await once(res, 'drain', { signal });
      };
      try {
        const connection = getConnection(getState(), { connectionId: current.id });
        for await (const content of generate(connection, getSecret(current.id), request.messages, {
          signal, redirect: 'error', stop: request.stop, responseFormat: request.responseFormat, adaptInstruction: true, disableThinking: true,
          preset: { maxTokens: request.maxTokens, temperature: request.temperature, topP: request.topP },
          onFinish: reason => { if (['stop', 'length', 'content_filter'].includes(reason)) finishReason = reason; },
        })) {
          signal.throwIfAborted();
          outputSize += content.length;
          if (outputSize > maxOutputChars) throw error(502, 'Ответ общей модели слишком велик.');
          if (request.stream) await sendChunk({ content });
          else text += content;
        }
        signal.throwIfAborted();
        if (!outputSize) throw error(502, 'Общая модель вернула пустой ответ.');
        if (request.stream) {
          await sendChunk({}, finishReason);
          res.end('data: [DONE]\n\n');
        } else res.json({ id, object: 'chat.completion', created, model: sharedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }] });
      } catch (cause) {
        controller.abort();
        if (res.destroyed || res.writableEnded) return;
        const message = signal.reason?.name === 'TimeoutError'
          ? 'Общая модель не завершила ответ вовремя.'
          : 'Общая модель не завершила ответ. Проверьте её на компьютере владельца.';
        if (res.headersSent) res.end('data: ' + JSON.stringify({ error: { message } }) + '\n\n');
        else if (request.responseFormat && [400, 415, 422].includes(cause?.status)) {
          report(res, 415, 'Общая модель не поддерживает формат JSON.');
        } else report(res, 502, message);
      } finally {
        res.off('close', cancel);
        if (session.request === controller) session.request = null;
      }
    });
    publicApi.use((_req, res) => report(res, 404, 'Этот сеанс предоставляет только генерацию текста.'));
    publicApi.use((cause, _req, res, _next) => {
      if (res.headersSent) { res.end(); return; }
      if (cause.type === 'entity.too.large') return report(res, 413, 'Текстовый запрос слишком большой.');
      return report(res, cause.status || 400, cause.type ? 'Некорректный текстовый запрос.' : cause.message);
    });

    const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, publicApi);
    server.maxConnections = 8;
    server.maxRequestsPerSocket = 16;
    server.keepAliveTimeout = 2_000;
    server.setTimeout(maxRequestMs + 5_000, socket => socket.destroy());
    return server;
  }

  async function start({ connectionId, address = '127.0.0.1', guestAddress, minutes = 30 } = {}) {
    if (closed || host || starting || stopping) throw error(409, 'Сеанс общей генерации уже запущен или завершается.');
    const selected = getState().connections.find(item => item.id === connectionId);
    if (!localConnection(selected)) throw error(400, 'Выберите запущенную локальную текстовую модель владельца.');
    if (typeof address !== 'string' || !interfaces().some(item => item.address === address)) {
      throw error(400, 'Выберите локальный адрес компьютера владельца.');
    }
    const guest = address === '127.0.0.1' ? address : String(guestAddress || '').trim();
    if (!localShareAddress(guest) || address !== '127.0.0.1' && (guest === address || guest === '127.0.0.1')) {
      throw error(400, 'Укажите точный IPv4-адрес друга в вашей сети или VPN.');
    }
    if (![15, 30, 60, 120].includes(minutes)) throw error(400, 'Выберите допустимый срок сеанса общей генерации.');
    const controller = new AbortController();
    const preparation = { controller, promise: null };
    starting = preparation;
    preparation.promise = (async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      let visible;
      try { visible = await models(selected, getSecret(selected.id), { signal, redirect: 'error' }); }
      catch { throw error(502, 'Локальная модель не отвечает. Запустите и проверьте её в SAS.'); }
      controller.signal.throwIfAborted();
      if (!visible.includes(selected.model)) throw error(400, 'Выбранная модель не запущена на локальном сервере.');

      const token = crypto.randomBytes(32).toString('base64url');
      const contextWindow = Math.floor(bounded(selected.contextWindow, 8192, 512, 32768));
      const session = { connection: selected, address, guestAddress: guest, contextWindow,
        maxTokens: Math.floor(bounded(selected.maxTokens, 1024, 32, Math.min(4096, Math.floor(contextWindow / 3)))),
        token, digest: keyDigest(token), expiresAt: Date.now() + minutes * 60_000, requests: [], used: 0 };
      session.server = createEndpoint(session);
      try {
        await new Promise((resolve, reject) => {
          session.server.once('error', reject);
          session.server.listen(0, address, () => {
            session.server.off('error', reject);
            resolve();
          });
        });
        controller.signal.throwIfAborted();
      } catch (cause) {
        session.server.close();
        session.server.closeAllConnections();
        throw error(cause.name === 'AbortError' ? 409 : 502, 'Не удалось открыть сеанс на выбранном интерфейсе.');
      }
      session.port = session.server.address().port;
      session.authority = address + ':' + session.port;
      host = session;
      session.timer = setTimeout(() => { if (host === session) void stop(); }, session.expiresAt - Date.now());
      session.timer.unref();
    })();
    try { await preparation.promise; }
    finally { if (starting === preparation) starting = null; }
    return status();
  }

  async function join(raw) {
    assertIdle();
    const { baseUrl, token } = parseShareInvitation(raw);
    let discovery;
    try {
      const response = await fetcher(baseUrl + '/models', {
        headers: { Authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      discovery = await readDiscovery(response);
    } catch {
      throw error(502, 'Общая модель недоступна. Проверьте сеть и попросите новое приглашение.');
    }
    if (discovery.service !== service || discovery.data?.[0]?.id !== sharedModel
      || !Number.isInteger(discovery.contextWindow) || discovery.contextWindow < 512 || discovery.contextWindow > 32768
      || !Number.isInteger(discovery.maxTokens) || discovery.maxTokens < 1 || discovery.maxTokens > 4096) {
      throw error(502, 'Приглашение ведёт к несовместимому серверу.');
    }
    if (closed) throw error(409, 'SAS завершает работу.');
    assertIdle();
    const state = getState();
    let connection = state.connections.find(item => item.id.startsWith(sharedConnectionPrefix) && item.baseUrl === baseUrl);
    if (!connection) {
      connection = { id: sharedConnectionPrefix + crypto.randomUUID(), name: 'Общая модель SAS', kind: 'openai', baseUrl };
      state.connections.push(connection);
    }
    Object.assign(connection, { model: sharedModel, contextWindow: discovery.contextWindow, temperature: .8, maxTokens: discovery.maxTokens });
    state.activeConnectionId = connection.id;
    saveState(state);
    for (const id of recipientSessions.keys()) {
      if (!state.connections.some(item => item.id === id)) recipientSessions.delete(id);
    }
    recipientSessions.set(connection.id, { baseUrl, token });
    return { connectionId: connection.id };
  }

  function recipientKey(id) {
    if (typeof id !== 'string' || !id.startsWith(sharedConnectionPrefix)) return undefined;
    const binding = recipientSessions.get(id);
    if (!binding || getState().connections.find(item => item.id === id)?.baseUrl !== binding.baseUrl) return '';
    return binding.token;
  }

  router.get('/status', (_req, res) => res.json(status()));
  router.post('/start', async (req, res) => res.json(await start(req.body)));
  router.post('/stop', async (_req, res) => { await stop(); res.json(status()); });
  router.post('/invitation', (_req, res) => {
    if (!host || Date.now() >= host.expiresAt) throw error(409, 'Сначала откройте сеанс общей генерации.');
    res.json({ invitation: invitation(host.address, host.port, host.token) });
  });
  router.post('/join', async (req, res) => res.json(await join(req.body?.invitation)));
  return { router, start, stop, status, join, recipientKey,
    async close() { closed = true; recipientSessions.clear(); await stop(); },
  };
}
