// Big room ("Большая комната"): several AI characters share one scene with the
// players. Pure helpers shared by the server, the UI and tests.

export const BIG_ROOM_MODE='bigroom';
export const BIG_ROOM_MIN_CAST=2,BIG_ROOM_MAX_CAST=8,BIG_ROOM_MAX_CHAIN=6;
export const isBigRoom=room=>room?.mode===BIG_ROOM_MODE;

/** Validates the cast: 2..8 distinct existing character ids, order kept. */
export function normalizeCast(characters,ids){
 if(!Array.isArray(ids))throw new Error('Выберите персонажей большой комнаты.');
 const known=new Set((characters||[]).map(c=>c.id)),cast=[...new Set(ids.filter(id=>typeof id==='string'))];
 if(cast.some(id=>!known.has(id)))throw new Error('Персонаж большой комнаты не найден.');
 if(cast.length<BIG_ROOM_MIN_CAST)throw new Error(`В большой комнате нужно минимум ${BIG_ROOM_MIN_CAST} персонажа.`);
 if(cast.length>BIG_ROOM_MAX_CAST)throw new Error(`В большой комнате может быть не больше ${BIG_ROOM_MAX_CAST} персонажей.`);
 return cast;
}

/** Lorebooks for one speaker: the room's shared books plus the character's own. */
export function speakerLorebookIds(room,character){
 return [...new Set([...(room?.lorebookIds||[]),...(character?.lorebookIds||[])])];
}

const words=text=>String(text||'').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}\s-]/gu,' ').split(/\s+/).filter(Boolean);
/** True when a message addresses the character by full name or by its first name (>= 3 letters). */
export function mentions(text,name){
 const t=` ${words(text).join(' ')} `,full=words(name).join(' ');if(!full)return false;
 if(t.includes(` ${full} `))return true;
 const first=words(name)[0];if(!first||first.length<3)return false;
 // Russian vocatives/cases: compare a stem so "Ирис", "Ирису", "Ирисом" all match.
 const stem=first.length>4?first.slice(0,-1):first;
 return words(text).some(w=>w===first||w.length>=stem.length&&w.startsWith(stem)&&w.length<=first.length+3);
}

/**
 * Chooses who speaks next.
 * 1. An explicit request wins (host button).
 * 2. A character named in the latest player post (most recent mention first).
 * 3. Otherwise the cast member who has been silent the longest, never the last speaker
 *    when someone else is available, so characters keep talking to each other.
 */
export function pickSpeaker(cast,messages,characters,{requested}={}){
 if(!cast?.length)throw new Error('В комнате нет персонажей.');
 if(requested){if(!cast.includes(requested))throw new Error('Этот персонаж не участвует в комнате.');return requested;}
 const byId=new Map((characters||[]).map(c=>[c.id,c])),list=messages||[];
 const lastSpeaker=[...list].reverse().find(m=>m.role!=='user'&&m.characterId)?.characterId;
 const lastPlayer=[...list].reverse().find(m=>m.role==='user');
 const lastPlayerIndex=lastPlayer?list.lastIndexOf(lastPlayer):-1,answered=lastPlayerIndex>=0&&list.slice(lastPlayerIndex+1).some(m=>m.role!=='user');
 if(lastPlayer&&!answered){
  const named=cast.filter(id=>mentions(lastPlayer.content,byId.get(id)?.name));
  if(named.length)return named[0];
 }
 const spokeAt=new Map(cast.map(id=>[id,-1]));
 list.forEach((m,i)=>{if(m.role!=='user'&&spokeAt.has(m.characterId))spokeAt.set(m.characterId,i);});
 const candidates=cast.filter(id=>id!==lastSpeaker||cast.length===1);
 return candidates.reduce((best,id)=>spokeAt.get(id)<spokeAt.get(best)?id:best,candidates[0]);
}

/** One line per other cast member so the speaker knows who else is present. */
export function castBrief(cast,characters,speakerId){
 const byId=new Map((characters||[]).map(c=>[c.id,c]));
 return cast.filter(id=>id!==speakerId).map(id=>byId.get(id)).filter(Boolean)
  .map(c=>`- ${c.name}${c.subtitle?` (${c.subtitle})`:''}: ${String(c.description||c.personality||'').replace(/\s+/g,' ').slice(0,280)}`).join('\n');
}

/** Instructions that make the model write as exactly one character. */
export function bigRoomInstructions({speaker,others,players,story}){
 return [
  `[SAS_BIG_ROOM] Это общая сцена с несколькими персонажами и игроками. Сейчас ты пишешь ТОЛЬКО за персонажа «${speaker}»: его реплику, мысли вслух и действия от его лица.`,
  'Не пиши реплики и действия других персонажей и игроков, не решай за них. Можно обращаться к ним, реагировать на их слова и задавать вопросы.',
  'Реплики других участников в истории помечены их именами. Не повторяй уже сказанное, двигай сцену вперёд, сохраняй характер своего персонажа.',
  others?`Другие персонажи в сцене:\n${others}`:'',
  players?`Игроки (их персоны):\n${players}`:'',
  story?`Общая история комнаты (Story book) — направление сцены для всех персонажей:\n${story}`:'',
 ].filter(Boolean).join('\n');
}

/** History as seen by one speaker: its own lines stay "assistant", others become labelled user turns. */
export function speakerView(messages,speakerId){
 return messages.map(m=>m.role==='user'||!m.characterId||m.characterId===speakerId?m:{...m,role:'user',content:`${m.name||'Персонаж'}: ${m.content}`});
}
