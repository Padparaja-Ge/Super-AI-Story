import crypto from 'node:crypto';
const fail=message=>Object.assign(new Error(message),{status:409});
export function returningPlayer(room,token,personaId){
 if(!token)return null;
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail('Неверный ключ возвращения в кампанию.');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const saved=Object.entries(room.playerSessions||{}).find(([,value])=>typeof value.tokenHash==='string'&&value.tokenHash.length===64&&crypto.timingSafeEqual(Buffer.from(value.tokenHash),Buffer.from(hash)));
 if(!saved||saved[1].revoked||saved[1].personaId!==personaId)throw fail('Ключ возвращения не соответствует этой кампании и персоне.');
 const [actorId]=saved,persona=room.personas?.[actorId],actor=room.tactical?.actors?.find(a=>a.id===actorId);
 if(!persona||room.tactical&&!actor)throw fail('Сохранённый участник кампании не найден. Обратитесь к хосту.');
 return {actorId,persona,actor};
}
export function rememberPlayer(room,actorId,personaId){
 const token=crypto.randomBytes(32).toString('base64url');
 room.playerSessions||={};room.playerSessions[actorId]={personaId,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),createdAt:new Date().toISOString()};return token;
}
