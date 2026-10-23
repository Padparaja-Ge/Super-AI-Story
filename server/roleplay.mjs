import {samplingDefaults} from '../shared/local-options.mjs';
// This adapter is specific to older instruction-only templates. It does not
// infer model quality from MoE architecture and never changes saved messages.
export const focusedRoleplay=(connection,settings)=>connection.id==='sas-local'&&connection.promptFormat==='alpaca'&&settings.localRpAdaptive!==false;
export function uniqueSentences(text){
 const seen=new Set(),parts=[];
 for(const {segment} of new Intl.Segmenter('ru',{granularity:'sentence'}).segment(String(text||''))){const key=segment.trim().replace(/\s+/gu,' ');if(!key||seen.has(key))continue;seen.add(key);parts.push(segment.trim());}
 return parts.join(' ');
}
// A conservative writing hint, not a hard text crop. Russian prose consumes
// more tokens per word; a 120-word floor could not fit a 32/128-token reply and
// encouraged lengthy automatic continuations on CPU-offloaded models.
export function roleplayWordLimit(maxTokens,text=''){
 const letters=(String(text).match(/\p{L}/gu)||[]).length,cyrillic=(String(text).match(/[а-яё]/giu)||[]).length;
 const factor=letters&&cyrillic/letters>.2?.25:.5;
 return Math.max(1,Math.min(600,Math.floor(Math.max(1,Number(maxTokens)||600)*factor)));
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
  `Задание: сейчас ответь за ${characterName} на последний пост ${playerName}. На вопросы ответь репликой ${characterName}, строго по подтверждённой памяти; если факта нет, не выдумывай. Не копируй пост игрока, не приписывай ему реплики, мысли и решения. Сохраняй кто кому что передал. Не связывай отдельные факты новым обменом, условием или сроком: долг, пароль, спасение и обещание могут быть разными событиями. Выдай только новый художественный ответ на языке последнего поста игрока. Для русского поста используй русский текст кириллицей, без перехода на английский и транслитерации. Не добавляй заголовки и объяснения. Не пересказывай маршрут и дни из старого диалога вместо ответа. Ответь на ВСЕ текущие вопросы сейчас: не откладывай ответ до возвращения игрока и не завершай встречу за него. Сначала короткие конкретные ответы по источникам, потом реакция персонажа. Не заменяй срок выплаты утверждением, что долг уже оплачен. Заверши ответ в пределах ${roleplayWordLimit(maxTokens,latest)} слов. Закончи реплику естественной точкой и оставь следующий ход игроку.`,
  `Последний пост игрока ${playerName}:\n${latest}\n\nСледующий ответ ${characterName} (только персонаж):`,
 ].filter(Boolean).join('\n\n')}];
}
export function roleplaySampling(connection,settings){
 if(!focusedRoleplay(connection,settings))return undefined;
 const current=connection.sampling||{};
 const proposed={repeatPenalty:1.03,repeatLastN:128,dryMultiplier:.5,dryPenaltyLastN:256,dryAllowedLength:4};
 return Object.fromEntries(Object.entries(proposed).filter(([key])=>current[key]===undefined||current[key]===samplingDefaults[key]));
}
// Instruction-only merges sometimes append an out-of-role handoff after a
// completed reply. Stop at the complete template heading, not at ordinary
// dialogue or a standalone horizontal rule; keep it out of the next context.
export function roleplayStops(connection,settings){
 if(!focusedRoleplay(connection,settings))return undefined;
 return ['\n\n---\n\nВот ваш следующий ход:','\n\n---\n\nСледующий ход игрока:','\n\n---\n\nYour next turn:','\n\n---\n\nNext player turn:','\n\n### End of Turn:','\n\n### End of Response:'];
}
const handoffPrefixes=['end of turn:','end of response:','end of reply:','next player turn:','your next turn:','your turn:','вот ваш следующий ход:','ваш следующий ход:','следующий ход игрока:','игроку:'];
export function createRoleplayOutputFilter({lineStart=true}={}){
 let pending='',held='',stopped=false;
 const normalized=line=>line.trim().replace(/^#{1,6}[ \t]*/u,'').toLowerCase();
 function drain(final){
  let out='';
  while(pending&&!stopped){
   const newline=pending.indexOf('\n');
   if(!lineStart){if(newline<0){out+=pending;pending='';break;}out+=pending.slice(0,newline+1);pending=pending.slice(newline+1);lineStart=true;continue;}
   const line=newline<0?pending:pending.slice(0,newline),key=normalized(line);
   if(handoffPrefixes.some(prefix=>key.startsWith(prefix))||/^(?:end of (?:turn|response|reply))$/u.test(key)&&(/^[ \t]*#/u.test(line)||final||newline>=0)){stopped=true;pending='';held='';break;}
   if(newline>=0){
    if(!line.trim()||/^(?:---|___|\*\*\*)$/u.test(line.trim())){held+=pending.slice(0,newline+1);pending=pending.slice(newline+1);if(held.length>256){out+=held.slice(0,-256);held=held.slice(-256);}continue;}
    out+=held+pending.slice(0,newline+1);held='';pending=pending.slice(newline+1);continue;
   }
   if(!final&&(handoffPrefixes.some(prefix=>prefix.startsWith(key))||/^[ \t]*(?:#{1,6}[ \t]*|[-_*]{1,3})$/u.test(line))){if(!line.trim()&&pending.length>256){out+=pending.slice(0,-256);pending=pending.slice(-256);}break;}
   out+=held+pending;held='';pending='';lineStart=false;
  }
  if(final&&!stopped){out+=held+pending;held='';pending='';}
  return out;
 }
 return {push(text){if(stopped)return '';pending+=text;return drain(false);},flush(){return drain(true);},get stopped(){return stopped;}};
}

// A bounded guard for instruction templates which may repeat despite samplers.
// It examines only generated text; player posts and stored archives are untouched.
export function repeatedReply(text){
 text=String(text||'').slice(-16000);
 if(text.length<240)return false;
 const counts=new Map();
 for(const {segment} of new Intl.Segmenter('ru',{granularity:'sentence'}).segment(text)){
  const key=segment.trim().replace(/\s+/gu,' ');if(key.length<40)continue;
  const count=(counts.get(key)||0)+1;counts.set(key,count);if(count>=4)return true;
 }
 if(/(.{60,250}?)(?:\s*\1){3}/su.test(text.slice(-1800)))return true;
 // Degenerate model-name lists have no sentence punctuation and their period
 // is longer than the paragraph guard. Compare bounded complete line cycles.
 const lines=text.slice(-12000).split(/\r?\n/u).slice(0,-1).map(s=>s.trim()).filter(Boolean).slice(-240);
 for(let width=6;width<=Math.min(80,Math.floor(lines.length/3));width++){
  const block=lines.slice(-width);if(new Set(block).size<6||block.join('\n').length<100)continue;
  if(block.every((line,i)=>line===lines[lines.length-width*2+i]&&line===lines[lines.length-width*3+i]))return true;
 }
 return false;
}
