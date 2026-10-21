// Account display names belong to the lobby. Only persona names identify
// player characters in game-master prompts, summaries and vector documents.
export const isGameRoom=room=>['dnd','custom'].includes(room.mode);
export function gamePersonaName(room,message){
 return message.personaName||room.personas?.[message.userId]?.name||room.tactical?.actors?.find(actor=>actor.id===message.userId)?.name||(!message.userId?message.name:'')||'Герой';
}
export function gameIdentityProjector(room){
 if(!isGameRoom(room))return value=>String(value||'');
 const aliases=new Map(),names=new Set([...Object.values(room.personas||{}),...(room.tactical?.actors||[])].map(p=>p.name));
 for(const message of room.messages||[]){
  if(message.role!=='user'||!message.name)continue;
  const name=gamePersonaName(room,message),old=aliases.get(message.name);
  if(name!==message.name&&!names.has(message.name))aliases.set(message.name,aliases.has(message.name)&&old!==name?null:name);
 }
 const choices=[...aliases].filter(([,name])=>name).sort((a,b)=>b[0].length-a[0].length).map(([alias])=>alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const pattern=choices.length?new RegExp('(^|[^\\p{L}\\p{N}_])('+choices.join('|')+')(?=$|[^\\p{L}\\p{N}_])','gu'):null;
 const project=value=>pattern?String(value||'').replace(pattern,(_match,prefix,alias)=>prefix+aliases.get(alias)):String(value||'');
 // Source offsets are translated along with renamed text, so existing memory
 // coverage remains valid even when several nicknames change length.
 project.source=value=>{
  const edits=[],original=String(value||''),content=pattern?original.replace(pattern,(match,prefix,alias,index)=>{
   const name=aliases.get(alias);edits.push({start:index+prefix.length,end:index+match.length,length:name.length});return prefix+name;
  }):original;
  const offset=position=>{let delta=0;for(const edit of edits){if(position>=edit.end)delta+=edit.length-(edit.end-edit.start);else if(position>edit.start)return edit.start+delta+Math.min(position-edit.start,edit.length);else break;}return position+delta;};
  return {content,offset};
 };
 return project;
}
export const gameIdentityText=(room,value)=>gameIdentityProjector(room)(value);
