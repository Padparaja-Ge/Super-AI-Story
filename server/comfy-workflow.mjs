import crypto from 'node:crypto';
import {comfyDefaults} from '../shared/defaults.mjs';
import {positivePrompt} from './services/imagePromptService.js';

export function prepareWorkflow(config, prompt, seed=crypto.randomInt(0,2**48-1)){
  const workflow=structuredClone(config.workflow);
  if(!workflow||Array.isArray(workflow)||workflow.nodes||!Object.keys(workflow).length)throw new Error('Импортируйте workflow в API-формате ComfyUI (Export API).');
  for(const n of Object.values(workflow))if(!n||typeof n.class_type!=='string'||!n.inputs||typeof n.inputs!=='object')throw new Error('Некорректный API workflow: нужны class_type и inputs у каждой ноды.');
  const positive=positivePrompt(config,prompt),negative=String(config.negative??comfyDefaults.negative);
  const width=Number(config.width??512),height=Number(config.height??512);
  if([width,height].some(n=>!Number.isInteger(n)||n<64||n>4096||n%8))throw new Error('Размер изображения: от 64 до 4096, кратный 8.');
  const link=v=>Array.isArray(v)&&v.length===2&&workflow[String(v[0])]&&Number.isInteger(v[1]);
  let positiveFound=false;
  const expand=value=>{
    if(typeof value==='string'){
      if(value.includes('{{prompt}}'))positiveFound=true;
      const replacements={'{{prompt}}':positive,'{{negative_prompt}}':negative,'{{model}}':config.model||'','{{seed}}':seed,'{{width}}':width,'{{height}}':height};
      if(Object.hasOwn(replacements,value))return replacements[value];
      for(const [key,v]of Object.entries(replacements))value=value.replaceAll(key,String(v));return value;
    }
    if(Array.isArray(value))return value.map(expand);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(v)]));return value;
  };
  const result=expand(workflow);
  const set=(id,input,value)=>{if(!result[id]||!Object.hasOwn(result[id].inputs,input))return false;result[id].inputs[input]=value;return true;};
  const upstream=(value,seen=new Set())=>{
    if(!link(value))return [];const id=String(value[0]);if(seen.has(id))return [];seen.add(id);
    return [id,...Object.values(workflow[id].inputs).flatMap(v=>upstream(v,seen))];
  };
  const textNodes=(value,seen=new Set())=>{
    if(!link(value))return [];const id=String(value[0]),node=workflow[id],key=id+':'+value[1];if(seen.has(key))return [];seen.add(key);
    if(/TextEncode|String|Text\b/i.test(node.class_type)){
      const entries=Object.entries(node.inputs).filter(([k])=>/^(text|text_g|text_l|string|value)$/.test(k));
      return [...(entries.some(([,v])=>typeof v==='string')?[id]:[]),...entries.flatMap(([,v])=>textNodes(v,seen))];
    }
    if(node.inputs.positive&&node.inputs.negative)return textNodes(node.inputs[value[1]===1?'negative':'positive'],seen);
    return Object.entries(node.inputs).filter(([k])=>!/^(model|clip|vae|image|mask|control_net|latent_image)$/.test(k)).flatMap(([,v])=>textNodes(v,seen));
  };
  const replaceText=(ids,text)=>{let found=false;for(const id of ids)for(const [key,value]of Object.entries(workflow[id].inputs))if(/^(text|text_g|text_l|string|value)$/.test(key)&&typeof value==='string'){set(id,key,text);found=true;}return found;};
  const positiveIds=new Set(),negativeIds=new Set(),models=new Set();
  for(const node of Object.values(workflow)){
    if(node.inputs.positive)for(const id of textNodes(node.inputs.positive))positiveIds.add(id);
    if(node.inputs.negative)for(const id of textNodes(node.inputs.negative))negativeIds.add(id);
    if(/Sampler|Guider/.test(node.class_type))for(const id of upstream(node.inputs.model))if('ckpt_name' in workflow[id].inputs)models.add(id);
  }
  // Old explicit mappings remain usable, but new imports need no IDs from the user.
  if(config.positiveNode&&result[config.positiveNode])positiveFound=set(config.positiveNode,config.positiveInput||'text',positive)||positiveFound;
  else if(positiveIds.size){if([...positiveIds].some(id=>negativeIds.has(id)))throw new Error('Workflow использует один текстовый вход для положительного и негативного промптов. Разделите их в ComfyUI.');positiveFound=replaceText(positiveIds,positive)||positiveFound;}
  else {
    const candidates=Object.entries(workflow).filter(([id,n])=>!negativeIds.has(id)&&/TextEncode/.test(n.class_type)&&!/negative|негатив/i.test(n._meta?.title||''));
    const titled=candidates.filter(([,n])=>/positive|положитель/i.test(n._meta?.title||''));
    if(titled.length||candidates.length===1)positiveFound=replaceText((titled.length?titled:candidates).map(([id])=>id),positive)||positiveFound;
  }
  if(!positiveFound)throw new Error('В workflow не найден положительный текстовый вход. Подключите CLIPTextEncode к positive или используйте {{prompt}} в нужной ноде.');
  if(config.negativeNode&&result[config.negativeNode])set(config.negativeNode,config.negativeInput||'text',negative);
  else {replaceText(negativeIds,negative);for(const [id,n]of Object.entries(workflow))if(/negative|негатив/i.test(n._meta?.title||''))replaceText([id],negative);}
  if(config.model){
    if(config.modelNode&&result[config.modelNode])set(config.modelNode,config.modelInput||'ckpt_name',config.model);
    else {if(!models.size)for(const [id,n]of Object.entries(workflow))if('ckpt_name' in n.inputs)models.add(id);
      if(!models.size&&!JSON.stringify(workflow).includes('{{model}}'))throw new Error('Workflow не содержит загрузчик checkpoint. Выберите совместимый workflow.');
      for(const id of models)set(id,'ckpt_name',config.model);
    }
  }
  if(config.seedNode)set(config.seedNode,config.seedInput||'seed',seed);
  for(const [id,n]of Object.entries(workflow)){
    if(/Sampler|Noise/.test(n.class_type))for(const input of ['seed','noise_seed'])if(typeof n.inputs[input]==='number')set(id,input,seed);
    if(/Empty.*Latent|EmptyImage|TextEncodeSDXL/.test(n.class_type))for(const [key,value]of Object.entries({width,height,target_width:width,target_height:height}))if(typeof n.inputs[key]==='number')set(id,key,value);
  }
  return result;
}
