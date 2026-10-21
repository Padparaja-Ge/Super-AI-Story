import {safeAvatar} from '../shared/avatar.mjs';
import {validateSRP} from '../shared/srp.mjs';
import { rewriteDraft } from './services/rewriteService.js';
import { emptyScene } from '../shared/defaults.mjs';
import {isGameRoom,gamePersonaName} from './room-identities.mjs';

export function publicPersona(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim()) throw new Error('Выберите персону.');
  return { ...(value.kind==='srp'?validateSRP(value):{}),avatar:safeAvatar(value.avatar), id: String(value.id || 'guest').slice(0,100), name: value.name.trim().slice(0,40), description: String(value.description||'').slice(0,6000), appearance: String(value.appearance||'').slice(0,3000), personality: String(value.personality||'').slice(0,3000) };
}
export async function rewriteRoomDraft(state, payload, getSecret, signal) {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text || text.length > 8000) throw new Error('Введите черновик до 8000 символов.');
  const persona = publicPersona(payload.persona);
  const room = payload.room || {};
  const messages = (Array.isArray(room.messages) ? room.messages : []).slice(-4).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: `${String(isGameRoom(room)&&m.role==='user'?gamePersonaName(room,m):m.name||'').slice(0,40)}: ${String(m.content||'').slice(-2000)}` }));
  const scene = emptyScene(); for (const key of ['location','time','weather']) scene[key] = String(room.scene?.[key]||'').slice(0,500);
  const character = { id:'room-narrator',name:String(room.character?.name || room.name || 'Ведущий').slice(0,100) };
  const chat = { id:'guest-draft',characterId:character.id,personaId:persona.id,connectionId:payload.connectionId || state.activeConnectionId,messages,scene };
  return rewriteDraft({ ...state,characters:[character],personas:[persona],chats:[chat] },chat,text,getSecret,signal);
}
