import {runtimeDefaults,samplingDefaults} from './local-options.mjs';
export const modelProfiles=[
 {id:'sainemo-q8-kv',name:'SAINEMO-reMIX · Q6_K · Q8 KV-кэш',match:/SAINEMO-reMIX.*Q6_K/i,contextSize:8192,moeAuto:false,runtime:{flashAttention:'on',cacheTypeK:'q8_0',cacheTypeV:'q8_0',fitTarget:1536},sampling:{temperature:.65,maxTokens:800,topK:40,topP:.95,minP:.05,repeatPenalty:1.05},note:'Вариант с меньшим расходом видеопамяти: Flash Attention и Q8 KV-кэш. Проверен на SAINEMO Q6_K / RTX 4070, контекст 8192. Применяйте при нехватке VRAM; параметры доступны для ручной правки.'},
 {id:'sainemo-dense',name:'SAINEMO-reMIX · Dense Q6_K',match:/SAINEMO-reMIX.*Q6_K/i,contextSize:8192,moeAuto:false,sampling:{temperature:.65,maxTokens:800,topK:40,topP:.95,minP:.05,repeatPenalty:1.05},note:'Исходная точка по прогону SAINEMO Q6_K на RTX 4070: RP, D&D и Story books. Скорость и объём контекста зависят от вашего устройства.'},
 {id:'multiverse-moe',name:'M-MOE-4X7B Dark MultiVerse · 24B',match:/M-MOE-4X7B.*(?:Dark|MultiVerse)/i,contextSize:8192,moeAuto:true,sampling:{temperature:.55,maxTokens:800,topK:40,topP:.9,minP:.05,repeatPenalty:1.05},note:'Рекомендуемые начальные настройки для ранее проверявшегося MoE. Размещение экспертов подбирается по вашей VRAM; число активных экспертов берётся из GGUF.'},
 {id:'careful',name:'Спокойная генерация · универсальный старт',match:/$a/,contextSize:8192,moeAuto:true,sampling:{temperature:.45,maxTokens:800,topK:40,topP:.9,minP:.05,repeatPenalty:1.05},note:'Осторожная отправная точка для других моделей. Не заменяет шаблон и рекомендации автора GGUF.'},
];
export function applyModelProfile(settings,id){
 const p=modelProfiles.find(p=>p.id===id);if(!p)throw Error('Неизвестный профиль модели.');
 return {...settings,contextSize:p.contextSize,gpuLayers:'auto',moeAuto:p.moeAuto,localRuntime:{...runtimeDefaults,...settings.localRuntime,chatTemplate:'gguf',expertUsedCount:0,cpuMoeLayers:0,cpuFfnLayers:0,ropeScaling:'model',ropeScale:0,...p.runtime},localSampling:{...samplingDefaults,...settings.localSampling,...p.sampling}};
}
