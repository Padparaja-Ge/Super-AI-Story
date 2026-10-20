import crypto from 'node:crypto';

export function createTasks({ flush, record } = {}) {
  let current = null;
  const publicTask = () => current ? { ...current.job } : null;
  const busy = () => current?.job.status === 'running';
  const assertIdle = () => { if (busy()) throw Object.assign(new Error('Дождитесь текущей генерации или остановите её. Настройки временно заблокированы.'), { status: 409 }); };
  function run(meta, work) {
    assertIdle();
    const controller = new AbortController();
    const job = { id: crypto.randomUUID(), status: 'running', text: '', stage: 'Подготовка', warnings: [], ...meta };
    const task = { job, controller, promise: null }; current = task;
    const started=Date.now();record?.('task_start',{kind:job.kind||'generation'});
    task.promise = Promise.resolve().then(() => work(controller.signal, job)).then(async result => {
      await flush?.();
      job.result = result; job.status = controller.signal.aborted ? 'stopped' : 'done'; record?.('task_finish',{kind:job.kind||'generation',status:job.status,durationMs:Date.now()-started});return result;
    }).catch(error => { job.error = error.message; job.status = controller.signal.aborted ? 'stopped' : 'error';record?.('task_failed',{kind:job.kind||'generation',status:job.status,code:error.code||'TASK_FAILED',durationMs:Date.now()-started}); throw error; });
    task.promise.catch(() => {});
    return task;
  }
  async function stop(chatId) { if (busy() && (!chatId || current.job.chatId === chatId)) { current.controller.abort(); await current.promise.catch(() => {}); } }
  return { run, busy, assertIdle, publicTask, stop };
}
