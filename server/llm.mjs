import {samplingBody} from '../shared/local-options.mjs';
export function getConnection(state, chat) {
  const connection = state.connections.find(item => item.id === (chat?.connectionId || state.activeConnectionId));
  if (!connection) throw new Error('Подключение не найдено. Добавьте его в настройках моделей.');
  if(connection.id==='sas-embedding')throw new Error('Embedding-модель используется только для векторизации. Выберите чат-модель.');
  if (!connection.baseUrl) throw new Error('Укажите адрес API подключения.');
  return connection.id==='sas-local'?{...connection,...state.settings?.localSampling,sampling:state.settings?.localSampling}:connection;
}

function endpoint(connection, suffix) {
  let url;
  try { url = new URL(connection.baseUrl); } catch { throw new Error('Неверный адрес API.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только HTTP(S) API без учётных данных в адресе.');
  return `${url.toString().replace(/\/$/, '')}/${suffix}`;
}

function headers(secret) { return { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }; }
// Alpaca templates put a response boundary after EACH user message and many
// older merges do not reliably honor the separate System stanza.
export function modelMessages(connection,messages){
  if(connection.id!=='sas-local')return messages;
  if(connection.promptFormat==='single-system'){
    const result=[];let leading=[],pending=[],started=false;
    for(const message of messages){
      if(message.role==='system'){(started?pending:leading).push(message.content);continue;}
      if(!started){if(leading.length)result.push({role:'system',content:leading.join('\n\n')});started=true;}
      const content=message.role==='user'&&pending.length?pending.join('\n\n')+'\n\n'+message.content:message.content;
      if(message.role==='user')pending=[];
      if(message.role==='user'&&result.at(-1)?.role==='user')result.at(-1).content+='\n\n'+content;else result.push({...message,content});
    }
    if(!started&&leading.length)result.push({role:'system',content:leading.join('\n\n')});
    if(pending.length){const content=pending.join('\n\n');if(result.at(-1)?.role==='user')result.at(-1).content+='\n\n'+content;else result.push({role:'user',content});}
    return result;
  }
  if(connection.promptFormat!=='alpaca')return messages;
  const result=[];let instructions=[];
  for(const message of messages){
    if(message.role==='system'){instructions.push(message.content);continue;}
    let content=message.content;
    if(message.role==='user'&&instructions.length){content=instructions.join('\n\n')+'\n\n'+content;instructions=[];}
    if(message.role==='user'&&result.at(-1)?.role==='user')result.at(-1).content+='\n\n'+content;
    else result.push({...message,content});
  }
  if(instructions.length){const content=instructions.join('\n\n');if(result.at(-1)?.role==='user')result.at(-1).content+='\n\n'+content;else result.push({role:'user',content});}
  return result;
}
// The native tokenizer includes the actual chat template. Character estimates
// differ substantially between multilingual GGUF vocabularies and older merges.
// Optional for external providers, which do not expose these llama.cpp routes.
export async function countCompletionTokens(connection,secret,messages,options={}){
  if(connection.id!=='sas-local')return null;
  const base=new URL(connection.baseUrl);base.pathname=base.pathname.replace(/\/v1\/?$/,'').replace(/\/$/,'');
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const fetcher=options.fetcher||fetch;
  const post=async(suffix,body)=>{
    const response=await fetcher(base.toString().replace(/\/$/,'')+suffix,{method:'POST',headers:headers(secret),body:JSON.stringify(body),signal});
    if(!response.ok)return null;return response.json();
  };
  try{
    const adapted=options.adaptInstruction?modelMessages(connection,messages):messages;
    const template=await post('/apply-template',{messages:adapted,add_generation_prompt:true,...(options.disableThinking?{chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'}:{})});
    if(typeof template?.prompt!=='string')return null;
    const result=await post('/tokenize',{content:template.prompt,add_special:true});
    return Array.isArray(result?.tokens)?result.tokens.length:null;
  }catch(error){if(options.signal?.aborted)options.signal.throwIfAborted();return null;}
}
async function responseError(response) {
  let detail = '';
  try { const text = await response.text(); const data = JSON.parse(text); detail = data.error?.message || data.message || ''; } catch { /* Avoid returning upstream HTML or sensitive request dumps. */ }
  return Object.assign(new Error(`API вернул HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 600)}` : '.'}`), {status:response.status});
}
function networkError(error) {
  if (error.name === 'AbortError') return new Error('Генерация остановлена.');
  if (error.name === 'TimeoutError') return new Error('API не ответил вовремя. Проверьте адрес и доступность модели.');
  if (error.message === 'fetch failed') return new Error(`Не удалось подключиться к API${error.cause?.code ? ` (${error.cause.code})` : ''}. Запустите локальный сервер модели или проверьте адрес.`);
  return error;
}

export async function listModels(connection, secret, options = {}) {
  try {
    const response = await fetch(endpoint(connection, 'models'), { headers: headers(secret), signal: options.signal || AbortSignal.timeout(15000) });
    if (!response.ok) throw await responseError(response);
    const data = await response.json();
    const models = (data.data || data.models || []).map(model => typeof model === 'string' ? model : model.id || model.name || model.model).filter(Boolean);
    return [...new Set(models)];
  } catch (error) { throw networkError(error); }
}

export async function* streamCompletion(connection, secret, messages, options = {}) {
  if (!String(connection.model || '').trim()) throw new Error('Модель не выбрана. Обновите список моделей в подключениях и выберите модель.');
  const preset = options.preset || {};
  const body = { model: connection.model, messages:options.adaptInstruction?modelMessages(connection,messages):messages, stream: true, temperature: Number(preset.temperature ?? connection.temperature ?? 0.8), max_tokens: Number(preset.maxTokens ?? connection.maxTokens ?? 1024) };
  if(connection.id==='sas-local'&&connection.sampling)Object.assign(body,samplingBody({...connection.sampling,...options.samplingOverrides}));
  if(options.responseFormat)body.response_format=options.responseFormat;
  if(options.stop?.length)body.stop=options.stop;
  if(options.adaptInstruction&&connection.id==='sas-local'&&connection.promptFormat==='alpaca')body.stop=[...new Set([...(body.stop||[]),'### Instruction:','### Response:','### System:'])];
  if(options.disableThinking&&connection.id==='sas-local'){body.chat_template_kwargs={enable_thinking:false};body.reasoning_effort='none';}
  if (preset.topP != null) body.top_p = Number(preset.topP);
  const timeoutSignal = AbortSignal.timeout(600000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetch(endpoint(connection, 'chat/completions'), { method: 'POST', headers: headers(secret), body: JSON.stringify(body), signal });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new Error('API вернул пустой поток.');
    if (response.headers.get('content-type')?.includes('application/json')) {
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || String(data.error));
      const content = data.choices?.[0]?.message?.content;
      if (data.choices?.[0]?.finish_reason) options.onFinish?.(data.choices[0].finish_reason);
      if (content) yield String(content);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let eventLines = [];
    let finished = false;
    const parse = lines => {
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') { if(data==='[DONE]')finished=true; return { done: data === '[DONE]' }; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new Error('API прислал некорректный JSON в потоке SSE.'); }
      if (parsed.error) throw new Error(parsed.error.message || String(parsed.error));
      if (parsed.choices?.[0]?.finish_reason) { finished=true; options.onFinish?.(parsed.choices[0].finish_reason); }
      const content = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text;
      return { text: typeof content === 'string' ? content : '' };
    };
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 2_000_000) throw new Error('Слишком большой блок данных от модели.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line) eventLines.push(line);
        else {
          const event = parse(eventLines); eventLines = [];
          if (event.done) return;
          if (event.text) yield event.text;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer) eventLines.push(buffer.replace(/\r$/, ''));
    if (eventLines.length) { const event = parse(eventLines); if (event.text) yield event.text; }
    if(!finished)throw Object.assign(new Error('Поток ответа прервался до подтверждения окончания. Полученный текст сохранён; повторите или продолжите генерацию.'),{code:'STREAM_INCOMPLETE'});
  } catch (error) { throw networkError(error); }
  finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}

export async function complete(connection, secret, messages, options = {}) {
  let output = '';
  for await (const chunk of streamCompletion(connection, secret, messages, options)) output += chunk;
  if (!output.trim()) throw new Error('Модель вернула пустой ответ. Проверьте выбранную модель и шаблон чата.');
  return output;
}
