import {normalizeOptions} from '../shared/local-options.mjs';

export function moeRecommendation(info,device,context,options={}){
  const settings=normalizeOptions(options),cacheBytes=t=>({f16:2,bf16:2,q8_0:34/32,q4_0:18/32,q4_1:20/32,q5_0:22/32,q5_1:24/32,iq4_nl:18/32})[t];
  const dimensions=[info.layers,info.kvHeads,info.keyLength,info.valueLength];
  const uncertain=info.splitCount!==1?'Модель состоит из нескольких GGUF; нужен суммарный размер всех частей.':info.kvLoraRank>0?'Архитектура MLA требует отдельного расчёта KV-кэша.':info.hasRecurrentState?'Гибридная архитектура имеет дополнительное состояние, не учтённое этой оценкой.':info.layerwiseAttention?'Параметры attention различаются по слоям.':dimensions.some(n=>!Number.isFinite(n)||n<=0)?'В GGUF недостаточно метаданных для оценки KV-кэша.':!device?.backend?'Устройство ещё не определено.':'';
  const kvBytes=settings.kvOffload==='off'?0:info.layers*context*info.kvHeads*(info.keyLength*cacheBytes(settings.cacheTypeK)+info.valueLength*cacheBytes(settings.cacheTypeV));
  const reserveBytes=settings.fitTarget*1048576,availableBytes=Math.max(0,(device?.freeMiB||0)*1048576-reserveBytes-kvBytes);
  const perLayer=info.layers?info.expertBytes/info.layers:0,layerBytes=info.expertLayerBytes?.length===info.layers&&info.expertLayerBytes.reduce((a,b)=>a+b,0)===info.expertBytes?info.expertLayerBytes:Array(info.layers).fill(perLayer);
  let cpuMoeLayers=0,ramBytes=0;
  while(cpuMoeLayers<info.layers&&(device?.backend==='cpu'||info.size-ramBytes>availableBytes))ramBytes+=layerBytes[cpuMoeLayers++];
  const applicable=info.isMoe&&info.expertBytes>0&&!uncertain;
  return {cpuMoeLayers,kvBytes,reserveBytes,availableBytes,estimatedGpuBytes:device?.backend==='cpu'?0:Math.max(0,info.size-ramBytes)+kvBytes,estimatedRamBytes:device?.backend==='cpu'?info.size:ramBytes,applicable,reason:uncertain?uncertain+' Автонастройка SAS не переопределяет размещение экспертов; доступны ручные параметры и подбор llama.cpp.':!info.isMoe?'Dense-модель: автонастройка экспертов не применяется.':!info.expertBytes?'Экспертные тензоры не распознаны; используйте ручную настройку.':device?.backend==='cpu'?'Веса вычисляются на CPU.':cpuMoeLayers?'Часть экспертных весов переносится в RAM; остальные веса остаются на GPU.':'Экспертные веса помещаются в свободную VRAM.',fits:applicable?(device?.backend==='cpu'||info.nonExpertBytes<=availableBytes):null,estimate:'approximate'};
}

export function resolveRuntimeOptions(settings,info,device,context){
  let options=normalizeOptions(settings.localRuntime);
  if(!info.isMoe)options={...options,cpuMoeLayers:0,expertUsedCount:0};
  const recommendation=moeRecommendation(info,device,context,options);
  const autoApplied=settings.moeAuto!==false&&recommendation.applicable;
  if(autoApplied)options={...options,cpuMoeLayers:recommendation.cpuMoeLayers};
  return {options,recommendation,autoApplied};
}
