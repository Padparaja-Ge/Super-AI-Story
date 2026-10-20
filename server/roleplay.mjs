import {samplingDefaults} from '../shared/local-options.mjs';
// This adapter is specific to older instruction-only templates. It does not
// infer model quality from MoE architecture and never changes saved messages.
export const focusedRoleplay=(connection,settings)=>connection.id==='sas-local'&&connection.promptFormat==='alpaca'&&settings.localRpAdaptive!==false;
export function uniqueSentences(text){
 const seen=new Set(),parts=[];
 for(const {segment} of new Intl.Segmenter('ru',{granularity:'sentence'}).segment(String(text||''))){const key=segment.trim().replace(/\s+/gu,' ');if(!key||seen.has(key))continue;seen.add(key);parts.push(segment.trim());}
 return parts.join(' ');
}
export function roleplayMessages(messages,{characterName='Персонаж',playerName='Игрок',maxTokens=600,sourceExcerpts=[],archive=[]}={}){
 const lastUser=messages.findLastIndex(m=>m.role==='user');
 const originals=sourceExcerpts.length?sourceExcerpts.map(e=>{const m=archive.find(v=>v.id===e.messageId),speaker=m?.role==='assistant'?characterName:m?.role==='user'?playerName:'Архив';return `[Ход ${e.index+1}; ${speaker}]: ${e.text}`;}).join('\n\n'):messages.filter(m=>m.role==='system'&&m.content.startsWith('Исходные события ЭТОЙ истории')).map(m=>m.content).join('\n\n');
 const instructions=messages.filter(m=>m.role==='system'&&!m.content.startsWith('Исходные события ЭТОЙ истории')).map(m=>m.content).join('\n\n');
 const history=messages.filter((m,i)=>m.role!=='system'&&i!==lastUser).map(m=>(m.role==='assistant'?characterName:playerName)+': '+uniqueSentences(m.content)).join('\n\n');
 const latest=lastUser>=0?uniqueSentences(messages[lastUser].content):'Продолжи сцену за персонажа, не решая за игрока.';
 return [{role:'user',content:[
  `Write ONLY the next reply of ${characterName}. Player ${playerName} is a separate person controlled by the user. Never speak or act as ${playerName}.`,
  'Описание роли, мира и подтверждённая память:\n'+instructions,
  history&&'Прошлый диалог (справка, уже произошёл):\n'+history,
  originals&&'Точные реплики из прошлого этой истории (важнее пересказа в сводках). Факты из собственных прошлых реплик известны персонажу; он может напомнить их игроку сейчас:\n'+originals,
  `Задание: сейчас ответь за ${characterName} на последний пост ${playerName}. На вопросы ответь репликой ${characterName}, строго по подтверждённой памяти; если факта нет, не выдумывай. Не копируй пост игрока, не приписывай ему реплики, мысли и решения. Сохраняй кто кому что передал. Не связывай отдельные факты новым обменом, условием или сроком: долг, пароль, спасение и обещание могут быть разными событиями. Выдай только новый художественный ответ на языке последнего поста игрока. Для русского поста используй русский текст кириллицей, без перехода на английский и транслитерации. Не добавляй заголовки и объяснения. Не пересказывай маршрут и дни из старого диалога вместо ответа. Ответь на ВСЕ текущие вопросы сейчас: не откладывай ответ до возвращения игрока и не завершай встречу за него. Сначала короткие конкретные ответы по источникам, потом реакция персонажа. Не заменяй срок выплаты утверждением, что долг уже оплачен. Заверши ответ в пределах ${Math.max(120,Math.min(600,Math.floor(maxTokens*.55)))} слов.`,
  `Последний пост игрока ${playerName}:\n${latest}\n\nСледующий ответ ${characterName} (только персонаж):`,
 ].filter(Boolean).join('\n\n')}];
}
export function roleplaySampling(connection,settings){
 if(!focusedRoleplay(connection,settings))return undefined;
 const current=connection.sampling||{};
 const proposed={repeatPenalty:1.03,repeatLastN:128,dryMultiplier:.5,dryPenaltyLastN:256,dryAllowedLength:4};
 return Object.fromEntries(Object.entries(proposed).filter(([key])=>current[key]===undefined||current[key]===samplingDefaults[key]));
}

// A bounded guard for instruction templates which may repeat despite samplers.
// It examines only generated text; player posts and stored archives are untouched.
export function repeatedReply(text){
 if(text.length<240)return false;
 const counts=new Map();
 for(const {segment} of new Intl.Segmenter('ru',{granularity:'sentence'}).segment(text)){
  const key=segment.trim().replace(/\s+/gu,' ');if(key.length<40)continue;
  const count=(counts.get(key)||0)+1;counts.set(key,count);if(count>=4)return true;
 }
 return /(.{60,250}?)(?:\s*\1){3}/su.test(text.slice(-1800));
}
