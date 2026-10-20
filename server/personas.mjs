import crypto from 'node:crypto';
import {safeAvatar} from '../shared/avatar.mjs';
import {validateSRP} from '../shared/srp.mjs';
export function importPersona(input){
  const p=input?.persona||input?.data||input;
  if(!p||typeof p.name!=='string'||!p.name.trim())throw new Error('В JSON персоны отсутствует имя.');
  const result={id:crypto.randomUUID(),avatar:safeAvatar(p.avatar)};
  for(const key of ['name','description','appearance','personality'])result[key]=String(p[key]||'').slice(0,key==='name'?100:12000);
  if(p.kind==='srp')Object.assign(result,validateSRP(p));
  return result;
}
