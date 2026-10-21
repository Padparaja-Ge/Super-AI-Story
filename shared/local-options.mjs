// Shared, validated settings. Only these flags can reach the built-in server.
export const runtimeFields=[
  {key:'chatTemplate',label:'Шаблон диалога',options:['gguf','llama3','mistral-v1','mistral-v3','chatml','command-r'],default:'gguf',hint:'По умолчанию из GGUF. Для старых слияний попробуйте шаблон, рекомендованный автором. Применяется после перезапуска.'},
  {key:'threads',label:'Потоки CPU · генерация',min:0,max:256,step:1,default:0,hint:'0 — выбор llama.cpp.'},
  {key:'threadsBatch',label:'Потоки CPU · обработка контекста',min:0,max:256,step:1,default:0},
  {key:'batchSize',label:'Логическая пачка токенов',min:32,max:32768,step:32,default:2048},
  {key:'ubatchSize',label:'Физическая пачка токенов',min:32,max:8192,step:32,default:512,hint:'Меньше — ниже расход памяти при обработке контекста.'},
  {key:'flashAttention',label:'Flash Attention',options:['auto','on','off'],default:'auto'},
  {key:'cacheTypeK',label:'KV-кэш · ключи',options:['f16','bf16','q8_0','q4_0','q4_1','q5_0','q5_1','iq4_nl'],default:'f16'},
  {key:'cacheTypeV',label:'KV-кэш · значения',options:['f16','bf16','q8_0','q4_0','q4_1','q5_0','q5_1','iq4_nl'],default:'f16'},
  {key:'loadMode',label:'MMAP · загрузка весов',options:['auto','mmap','none','mlock','mmap+mlock'],default:'auto',hint:'mmap — отображение файла в память; none — MMAP выключен. mlock удерживает веса в RAM.'},
  {key:'contextShift',label:'Context Shift · сдвиг контекста',options:['off','on'],default:'off',hint:'Разрешает llama.cpp сдвигать заполненный контекст при генерации. Блоки памяти SAS сохраняются отдельно.'},
  {key:'swaCache',label:'SWA · режим KV-кэша',options:['compact','full'],default:'compact',hint:'compact — штатный скользящий кэш; full — полный размер кэша, больше расход памяти. Это управление кэшем, а не отключение SWA-attention архитектуры модели.'},
  {key:'fit',label:'Подбор по свободной VRAM',options:['on','off'],default:'on'},
  {key:'fitTarget',label:'Резерв VRAM, МБ',min:256,max:32768,step:128,default:1024},
  {key:'opOffload',label:'Вычисления служебных операций',options:['on','off'],default:'on'},
  {key:'kvOffload',label:'KV-кэш на GPU',options:['on','off'],default:'on'},
  {key:'cachePrompt',label:'Повторное использование контекста',options:['on','off'],default:'on'},
  {key:'cacheReuse',label:'Минимум токенов для переноса KV-кэша',min:0,max:32768,step:1,default:0},
  {key:'numa',label:'NUMA · размещение потоков',options:['disabled','distribute','isolate'],default:'disabled'},
  {key:'cpuMoeLayers',label:'Слоёв с экспертами в RAM',min:0,max:999,step:1,default:0,hint:'Число первых слоёв, чьи экспертные веса вычисляются на CPU. Не число активных экспертов.'},
  {key:'cpuFfnLayers',label:'Dense FFN · слоёв в RAM',min:0,max:999,step:1,default:0},
  {key:'expertUsedCount',label:'Активных экспертов · переопределение',min:0,max:1024,step:1,default:0,hint:'0 — значение из GGUF. Меняет маршрутизацию модели, может ухудшить качество; автонастройка его не меняет.'},
  {key:'ropeScaling',label:'RoPE · расширение контекста',options:['model','none','linear','yarn'],default:'model'},
  {key:'ropeScale',label:'RoPE · коэффициент',min:0,max:64,step:.1,default:0,hint:'0 — значение из модели. Изменяйте только для подходящих моделей.'},
  {key:'yarnOrigCtx',label:'YaRN · исходный контекст',min:0,max:1048576,step:512,default:0},
];
export const samplingFields=[
  {key:'temperature',label:'Температура',min:0,max:5,step:.05,default:.8},
  {key:'maxTokens',label:'Максимум токенов ответа',min:32,max:131072,step:64,default:1024},
  {key:'topK',label:'Top K',min:0,max:1000,step:1,default:40},
  {key:'topP',label:'Top P',min:0,max:1,step:.01,default:.95},
  {key:'minP',label:'Min P',min:0,max:1,step:.01,default:.05},
  {key:'topNSigma',label:'Top N Sigma · nsigma',min:-1,max:100,step:.1,default:-1,hint:'-1 — выключено. Отбор токенов по отклонению логитов.'},
  {key:'adaptiveTarget',label:'Adaptive P · целевая вероятность',min:-1,max:1,step:.01,default:-1,hint:'-1 — выключено; 0–1 — целевая вероятность adaptive-p. Не включается автоматически.'},
  {key:'adaptiveDecay',label:'Adaptive P · затухание',min:0,max:.99,step:.01,default:.9},
  {key:'typicalP',label:'Typical P',min:0,max:1,step:.01,default:1},
  {key:'repeatPenalty',label:'Штраф повторений',min:0,max:3,step:.05,default:1},
  {key:'repeatLastN',label:'Окно повторений',min:-1,max:131072,step:1,default:64},
  {key:'presencePenalty',label:'Presence penalty',min:-2,max:2,step:.05,default:0},
  {key:'frequencyPenalty',label:'Frequency penalty',min:-2,max:2,step:.05,default:0},
  {key:'dryMultiplier',label:'DRY · сила подавления повторов',min:0,max:5,step:.05,default:0},
  {key:'dryBase',label:'DRY · база',min:1,max:4,step:.05,default:1.75},
  {key:'dryAllowedLength',label:'DRY · разрешённая длина повтора',min:0,max:256,step:1,default:2},
  {key:'dryPenaltyLastN',label:'DRY · окно',min:-1,max:131072,step:1,default:64},
  {key:'xtcProbability',label:'XTC · вероятность',min:0,max:1,step:.01,default:0},
  {key:'xtcThreshold',label:'XTC · порог',min:0,max:1,step:.01,default:.1},
  {key:'dynatempRange',label:'Динамическая температура · диапазон',min:0,max:5,step:.05,default:0},
  {key:'dynatempExponent',label:'Динамическая температура · степень',min:.1,max:10,step:.1,default:1},
  {key:'mirostat',label:'Mirostat',options:['0','1','2'],default:'0'},
  {key:'mirostatTau',label:'Mirostat · целевая энтропия',min:0,max:20,step:.1,default:5},
  {key:'mirostatEta',label:'Mirostat · скорость адаптации',min:.001,max:1,step:.01,default:.1},
  {key:'seed',label:'Seed · -1 случайный',min:-1,max:4294967295,step:1,default:-1},
];
export const runtimeDefaults=Object.fromEntries(runtimeFields.map(f=>[f.key,f.default]));
export const samplingDefaults=Object.fromEntries(samplingFields.map(f=>[f.key,f.default]));
export function normalizeOptions(input={},fields=runtimeFields){
  const output={};
  for(const field of fields){const value=input?.[field.key]??field.default;
    if(field.options){if(!field.options.includes(String(value)))throw new Error('Недопустимое значение: '+field.label);output[field.key]=String(value);}
    else{const n=Number(value);if(!Number.isFinite(n)||n<field.min||n>field.max||(field.step>=1&&!Number.isInteger(n)))throw new Error('Недопустимое значение: '+field.label);output[field.key]=n;}
  }
  return output;
}
export function samplingBody(input={}){
  const s=normalizeOptions(input,samplingFields),names={topK:'top_k',topP:'top_p',minP:'min_p',typicalP:'typical_p',repeatPenalty:'repeat_penalty',repeatLastN:'repeat_last_n',presencePenalty:'presence_penalty',frequencyPenalty:'frequency_penalty',dryMultiplier:'dry_multiplier',dryBase:'dry_base',dryAllowedLength:'dry_allowed_length',dryPenaltyLastN:'dry_penalty_last_n',xtcProbability:'xtc_probability',xtcThreshold:'xtc_threshold',dynatempRange:'dynatemp_range',dynatempExponent:'dynatemp_exponent',mirostat:'mirostat',mirostatTau:'mirostat_tau',mirostatEta:'mirostat_eta',seed:'seed'};
  return {...Object.fromEntries(Object.entries(names).map(([key,name])=>[name,Number(s[key])])),top_n_sigma:s.topNSigma,adaptive_target:s.adaptiveTarget,adaptive_decay:s.adaptiveDecay};
}
