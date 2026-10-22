// Check the embedded template, not a model's filename. A Gemma fine-tune may
// legitimately ship a different format; do not guess in that case.
export function chatTemplateProblem(info,template='gguf'){
 if(template==='gguf'||!/^gemma/iu.test(info?.architecture||''))return '';
 const native=info?.chatTemplate||'';
 if(!native.includes('<|turn>')&&!native.includes('<start_of_turn>'))return '';
 return `Для этой модели Gemma нужен шаблон из GGUF. Выбранный шаблон «${template}» меняет разметку ролей и может вызывать бессвязные ответы. Выберите «Из GGUF» и перезапустите модель. Сброс сэмплеров не меняет шаблон диалога.`;
}
