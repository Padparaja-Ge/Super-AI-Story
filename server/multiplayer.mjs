import {createRoomBackups,campaignBundle,restoreCampaign} from './room-backups.mjs';
import {correctRoom} from './room-corrections.mjs';
import {createRoomMedia} from './room-media.mjs';
import {roomAutosaveSettings} from '../shared/room-autosave.mjs';
import {returningPlayer,rememberPlayer} from './room-resume.mjs';
import {normalizeRoomModels,roomModelState} from './room-models.mjs';
import {beginInitiative,activateInitiative,advanceInitiative} from './initiative.mjs';
import {createAdventureGame,adventureActor,adventureAction,adventureRules,prepareActor,syncPlayers,resetRound,reachableCells,roundEvents} from './adventure-engine.mjs';
import {validateStorybook,quickAdventure,storyContext} from './storybooks.mjs';
import {storyDirector} from './story-director.mjs';
import {createGame,rulesFor,actorFromPersona,gameAction,logGame} from './tactical.mjs';
import {validateSRP,modifier} from '../shared/srp.mjs';
import {pointsOf,checkSkills,initiativeOf} from '../shared/equipment.mjs';
import {refreshEquipment} from './equipment-engine.mjs';
import {describeBattlemap,generateMap,populateMap,mapPNG} from './battlemap.mjs';
import {structuredCompletion} from './services/structuredCompletion.js';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { buildPrompt } from './prompt.mjs';
import { getConnection, streamCompletion } from './llm.mjs';
import { inferScene } from './language.mjs';
import { emptyScene } from '../shared/defaults.mjs';
import { RoomTurns } from './room-turns.mjs';
import {historySummaries,selectRoomHistory,deleteRoomHistory} from './room-history.mjs';
import { publicPersona } from './room-rewrite.mjs';
import {createRoomMemory,roomChat,roomMemoryDefaults,roundMessages,extractiveProtocol} from './room-memory.mjs';
import {fitNarrationPrompt,narrationContextHash,narrationReferencesHash,publicNarration,createNarrationContinuationJoiner} from './room-narration.mjs';
import {publicRegeneration,cleanNarration,narrationFormatInstruction,narrationStops} from './room-narration.mjs';
import {gameIdentityProjector} from './room-identities.mjs';

export function invitationUrls(port,code,interfaces=os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name,items])=>(items||[]).filter(i=>i.family==='IPv4').map(i=>({name,address:i.address,url:`http://${i.address}:${port}/play?code=${encodeURIComponent(code)}`})));
}
export function createMultiplayer({ getState, saveState, getSecret, dataDir, preparePrompt, tasks,embeddings,translationService,diagnostics,canAutoSave=()=>true }) {
  let hostPersona, server, wss, port=0, code='', name='', url='', hostName='', generation, metadataTimer;
  const translationWindows=new Map();
  const peers=new Map(), turns=new RoomTurns();
  const backups=createRoomBackups({dataDir,getState,canAutoSave});
  const persist=state=>{saveState(state);backups.checkpoint(state);};
  const roomStarted=()=>!roomData().lobby?.enabled||roomData().lobby?.phase==='playing';
  const assertStarted=()=>{if(!roomStarted())throw Object.assign(new Error('Комната ожидает в лобби. Хост должен начать игру.'),{status:409});};
  const lobbyState=()=>({enabled:!!roomData().lobby?.enabled,phase:roomData().lobby?.phase||'playing',players:[...peers.values()].filter(p=>p.authenticated).map(p=>({id:p.id,name:p.name,personaName:p.persona.name,avatar:p.persona.avatar,status:p.admitted===false?'pending':'approved',ready:!!p.ready}))});
  const roomData=()=>getState().multiplayer || {};
  const roomMemory=createRoomMemory({getState,saveState:persist,getSecret,embeddings});
  const isGame=room=>['dnd','custom'].includes((room||roomData()).mode);
  const actorContext=actors=>actors.map(a=>({id:a.id,name:a.name,player:a.player,online:a.online!==false,initiative:initiativeOf(a).value,hp:a.hp,maxHp:a.maxHp,armor:a.armor,slots:a.slots,actions:a.actions,fastActions:a.fastActions,move:a.move,x:a.x,y:a.y,grappledBy:a.grappledBy,beam:a.beam,skills:(a.skills||[]).map(s=>({id:s.id,name:s.name,grade:s.grade,action:s.action,range:s.range,slotCost:s.slotCost,damage:s.damage,description:s.description?.slice(0,200)}))}));
  const gameCharacter={id:'sas-gm',name:'AI Game Master',description:'Ты ведущий настольной ролевой игры. Описываешь мир, окружение и всех NPC, ведёшь сюжет по выбранным лорбукам и правилам. У игроков полная свобода решений. Не играй за игрока. Запросы проверок формулируй явно; не придумывай результаты бросков. Числа HP, позиции и результаты действий из состояния стола являются каноном.',systemPrompt:'Веди повествование как рассказчик и играй за всех NPC. Не являешься персонажем из одиночного чата.',blocks:[],lorebookIds:[]};
  const messages=()=>roomData().messages || [];
  const participants=()=>[{id:'host',name:hostName||'Хозяин',personaName:hostPersona?.name,avatar:hostPersona?.avatar,host:true,muted:false,weight:turns.weights.host||0},...[...peers.values()].filter(p=>p.authenticated&&p.admitted!==false).map(p=>({id:p.id,name:p.name,personaName:p.persona.name,avatar:p.persona.avatar,muted:p.muted,weight:turns.weights[p.id]||0}))];
  const actorIds=()=>[...participants().filter(p=>!p.muted).map(p=>p.id),'narrator'];
  const send=(socket,data)=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));};
  const broadcast=data=>{for(const [socket,peer] of peers)if(peer.authenticated&&peer.admitted!==false)send(socket,data);};
  const media=createRoomMedia({getRoom:()=>roomData(),saveRoom:value=>{const state=getState();state.multiplayer.media=value;persist(state);},broadcast,deliver:(id,data)=>{for(const [socket,peer]of peers)if(peer.authenticated&&peer.admitted!==false&&peer.id===id)send(socket,data);},participants,dataDir});
  const requireRoom=()=>{if(!server?.listening)throw new Error('Сначала откройте комнату.');};
  const metadata=()=>{
    const state=getState(),room=state.multiplayer||{},chat=state.chats.find(c=>c.id===room.chatId),character=state.characters.find(c=>c.id===chat?.characterId);
    return {room:{lobby:lobbyState(),media:media.publicState(),backupError:backups.error(),autosaveEnabled:canAutoSave()&&roomAutosaveSettings(room.autosaveSettings).enabled,autosaveSettings:roomAutosaveSettings(room.autosaveSettings),corrections:(room.corrections||[]).slice(-50),avatars:Object.fromEntries(Object.entries(room.personas||{}).map(([id,p])=>[id,p.avatar||'✧'])),id:room.id,name:name||room.name,connectionId:room.connectionId,aiSettings:room.aiSettings||{},mode:room.mode||'roleplay',tactical:room.tactical?{...room.tactical,eventArchive:undefined,eventCount:(room.tactical.eventArchive||room.tactical.log||[]).length}:undefined,storybook:room.storybook,gmError:room.gmError,narration:publicNarration(room,getState()),regeneration:publicRegeneration(room,state),memorySettings:{...roomMemoryDefaults,...room.memorySettings},memoryBlocks:roomMemory.validMemory(roomChat(room)).length,memoryProgress:room.memoryProgress,memoryWarning:room.memoryWarning,contextReport:room.contextReport,rulebooks:state.lorebooks.filter(b=>(room.rulebookIds||[]).includes(b.id)).map(b=>({id:b.id,name:b.name})),character:{id:isGame(room)?'':character?.id,name:isGame(room)?'AI Game Master':character?.name||'Ведущий'},scene:room.scene,lorebooks:state.lorebooks.filter(b=>(room.lorebookIds||[]).includes(b.id)).map(b=>({id:b.id,name:b.name}))},participants:participants(),turn:turns.status(actorIds()),generating:!!generation};
  };
  let lastMetadata='';
  const notify=()=>{if(!server?.listening)return;const data=metadata(),serialized=JSON.stringify(data);if(serialized!==lastMetadata){lastMetadata=serialized;broadcast({type:'participants',...data});for(const [socket,peer]of peers)if(peer.authenticated&&peer.admitted===false)send(socket,{type:'lobby-state',selfId:peer.id,admission:'pending',room:{id:roomData().id,name,mode:roomData().mode,lobby:lobbyState()}});}};
  const status=()=>({mediaSignals:media.signals('host'),histories:historySummaries(getState()),running:!!server?.listening,port,url,invitationUrls:server?.listening?invitationUrls(port,code).map(item=>({...item,url:item.url+'&room='+encodeURIComponent(roomData().id)})):[],code,name,...metadata(),hostPersonaId:hostPersona?.id,imageJobs:getState().images.filter(i=>i.roomId===roomData().id&&i.status!=='done').map(i=>({id:i.id,status:i.status,error:i.error})),chatId:roomData().chatId,lorebookIds:roomData().lorebookIds||[],messages:messages(),participants:server?.listening?participants():[]});
  const append=message=>{
    const state=getState();
    state.multiplayer={...state.multiplayer,name,messages:[...(state.multiplayer?.messages||[]),message]};
    const keep=new Set(['host',...Object.keys(state.multiplayer.playerSessions||{}),...state.multiplayer.messages.map(m=>m.userId),...participants().map(p=>p.id)]);
    state.multiplayer.personas=Object.fromEntries(Object.entries(state.multiplayer.personas||{}).filter(([id])=>keep.has(id)));
    persist(state);broadcast({type:'message',message});
  };
  const canWrite=id=>{
    requireRoom();assertStarted();
    if(tasks?.publicTask?.()?.status==='running')throw Object.assign(new Error('Сначала завершите текущую задачу перед новым ходом.'),{status:409});
    if(generation)throw Object.assign(new Error('Дождитесь окончания хода ведущего.'),{status:409});
    if(publicNarration(roomData(),getState())?.status==='incomplete')throw Object.assign(new Error('Сначала допишите или завершите незаконченный ответ ведущего.'),{status:409});
    const actor=participants().find(p=>p.id===id);
    if(!actor||actor.muted)throw Object.assign(new Error('Хост запретил вам писать.'),{status:403});
    if(isGame()&&roomData().tactical?.version===2){const g=roomData().tactical;if(g.phase!=='players'||g.order[g.turn]!==id)throw new Error('Ожидайте своего хода.');}else turns.assert(id,actorIds());
    return actor;
  };
  const playerMessage=(id,raw)=>{
    const actor=canWrite(id),content=typeof raw==='string'?raw.trim():'';
    if(!content||content.length>8000)throw new Error('Длина сообщения: от 1 до 8000 символов.');
    const message={id:crypto.randomUUID(),role:'user',userId:id,name:actor.name,personaName:actor.personaName,content,createdAt:new Date().toISOString()};
    append(message);if(!isGame())turns.complete(id,actorIds());notify();return {message};
  };
  const dice=(id,sides=20)=>{
    const actor=canWrite(id);sides=Number(sides);
    if(![4,6,8,10,12,20,100].includes(sides))throw new Error('Выберите d4, d6, d8, d10, d12, d20 или d100.');
    const value=crypto.randomInt(1,sides+1),message={id:crypto.randomUUID(),role:'user',kind:'dice',userId:id,name:actor.name,personaName:actor.personaName,content:`Бросок d${sides}: ${value}`,dice:{sides,value},createdAt:new Date().toISOString()};
    append(message);return {message};
  };
  function configure(options={}) {
    if(generation)throw new Error('Дождитесь окончания хода ведущего.');
    const state=getState(),room=state.multiplayer||{},chatId=isGame(room)?'':options.chatId??room.chatId??state.chats[0]?.id;
    if(options.connectionId!==undefined&&(typeof options.connectionId!=='string'||!state.connections.some(c=>c.id===options.connectionId)))throw new Error('Выберите существующее подключение ведущего.');
    if(publicNarration(room,getState())?.status==='incomplete'&&Object.keys(options).some(k=>!['connectionId','memorySettings'].includes(k)))throw Object.assign(new Error('Завершите незаконченный ответ перед изменением контекста комнаты.'),{status:409});
    const chat=isGame(room)?{id:'sas-gm',characterId:'sas-gm'}:state.chats.find(c=>c.id===chatId);if(!chat)throw new Error('Выберите персонажа ведущего.');
    const character=isGame(room)?gameCharacter:state.characters.find(c=>c.id===chat.characterId);if(!character)throw new Error('Карточка ведущего не найдена.');
    const ids=options.lorebookIds??(chatId===room.chatId?room.lorebookIds:undefined)??character.lorebookIds??[];
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!state.lorebooks.some(b=>b.id===id)))throw new Error('Выберите существующие лорбуки комнаты.');
    if(options.weights!==undefined)turns.configure(options.weights,actorIds());
    const rulebookIds=options.rulebookIds??room.rulebookIds??[];if(!Array.isArray(rulebookIds)||rulebookIds.some(id=>!state.lorebooks.some(b=>b.id===id)))throw new Error('Выберите существующие рулбуки.');
    if(isGame(room)&&options.rules){const g=room.tactical;if(g.inCombat)throw new Error('Завершите бой перед изменением правил.');g.rules=g.version===2?adventureRules(room.mode,options.rules):rulesFor(room.mode,options.rules);for(const a of g.actors){
      if(g.version===2){prepareActor(a,g.rules);const missingHp=a.maxHp-a.hp,missingSlots=a.maxSlots-a.slots;a.baseArmor=g.rules.armor;a.baseMaxHp=g.rules.hp;a.baseMaxSlots=g.rules.slots;refreshEquipment(a,g.rules);a.hp=Math.max(0,a.maxHp-missingHp);a.slots=Math.max(0,a.maxSlots-missingSlots);a.mana=a.slots;a.actions=g.rules.slowActions??1;a.fastActions=g.rules.fastActions;a.bonusActions=a.fastActions;a.move=g.rules.move;}
      else{const hp=Math.max(1,g.rules.hp+modifier(a.abilities.constitution));a.hp=Math.max(0,hp-(a.maxHp-a.hp));a.maxHp=hp;a.mana=Math.max(0,g.rules.mana-(a.maxMana-a.mana));a.maxMana=g.rules.mana;a.actions=g.rules.actions;a.bonusActions=g.rules.bonusActions;a.move=g.rules.move;a.armor=g.rules.armor+modifier(a.abilities.dexterity);}
    }}

    const aiSettings=options.aiSettings!==undefined?normalizeRoomModels(state,options.aiSettings):room.aiSettings||{};
    let memorySettings={...roomMemoryDefaults,...room.memorySettings};
    if(options.memorySettings){
      const m=options.memorySettings;if(typeof m!=='object'||Array.isArray(m))throw new Error('Неверные настройки памяти.');
      for(const key of ['autoSummary','vectorMemory'])if(m[key]!==undefined){if(typeof m[key]!=='boolean')throw new Error('Неверный переключатель памяти.');memorySettings[key]=m[key];}
      for(const [key,min,max] of [['summaryInterval',2,100],['memoryBudget',200,3000],['historyLimit',0,500],['loreBudget',0,12000]])if(m[key]!==undefined){if(!Number.isInteger(m[key])||m[key]<min||m[key]>max)throw new Error('Неверный лимит памяти.');memorySettings[key]=m[key];}
    }
    if(options.memorySettings?.memoryMode!==undefined){if(!['hybrid','summary','pinned','manual','full','off'].includes(options.memorySettings.memoryMode))throw new Error('Неверный режим памяти.');memorySettings.memoryMode=options.memorySettings.memoryMode;}
    state.multiplayer={...room,autosaveSettings:roomAutosaveSettings(options.autosaveSettings??room.autosaveSettings),aiSettings,memorySettings,connectionId:options.connectionId??room.connectionId,rulebookIds,chatId,lorebookIds:[...new Set(ids)],weights:{...turns.weights}};
    persist(state);notify();return status();
  }
  function context() {
    const state=getState(),room=state.multiplayer||{},chat=isGame(room)?{id:'sas-gm',characterId:'sas-gm',connectionId:room.connectionId,memorySettings:{historyLimit:40,loreBudget:2200,memoryMode:'hybrid'}}:state.chats.find(c=>c.id===room.chatId);
    if(!chat)throw new Error('Выберите персонажа ведущего.');
    const roomContext=roomChat(room,{...chat,personaId:'',lorebookIds:[...new Set(room.lorebookIds||[])],scene:room.scene||emptyScene()});
    const modelState=roomModelState(state,room);
    const promptState={...modelState,...(isGame(room)?{activePresetId:''}:{}),personas:[],characters:[...state.characters.map(c=>({...c,personaId:''})),...(isGame(room)?[gameCharacter]:[])],plugins:isGame(room)?[]:state.plugins,lorebooks:state.lorebooks.filter(b=>(room.lorebookIds||[]).includes(b.id)).map(b=>({...b,entries:b.entries.map(e=>({...e,name:`Лорбук «${b.name}» · ${e.name}`}))})),settings:{...modelState.settings,userName:'Участники комнаты',narrative:isGame(room)?{mode:'gamemaster',tense:'present',perspective:'third',length:'medium',instructions:''}:{...state.settings.narrative,mode:'gamemaster'}},chats:[roomContext]};
    const descriptions=Object.entries(room.personas||{}).map(([id,p])=>`${isGame(room)?p.name:(id==='host'?hostName:messages().find(m=>m.userId===id)?.name||p.name)+': '+p.name}. ${p.description||''} ${p.appearance||''} ${p.personality||''}`).join('\n');
    let priorityInstructions='';
    let extraInstructions='Ты ведущий совместной истории. Учитывай действия всех участников и не решай за игроков. Броски кубиков в истории — уже полученные результаты.\nПерсоны участников:\n'+descriptions;
    if(isGame(room)){
      const g=room.tactical,window=Number(getConnection(state,roomContext).contextWindow)||8192,limit=Math.min(5000,Math.max(1000,Math.floor(window*.7))),book=room.storybook;
      const outline=book?Object.fromEntries(Object.entries(book).map(([k,v])=>[k,typeof v==='string'?v.slice(0,Math.floor(limit/8)):v])):null;
      const table=g.actors.map(a=>({id:a.id,name:a.name,player:a.player,hp:a.hp,maxHp:a.maxHp,slots:a.slots,maxSlots:a.maxSlots,armor:a.armor,x:a.x,y:a.y,grappledBy:a.grappledBy||'',beam:a.beam,level:a.level,actions:a.actions,fastActions:a.fastActions,modifiers:Object.fromEntries(Object.keys(a.abilities).map(k=>[k,modifier(pointsOf(a,k))])),equipment:(a.inventory||[]).filter(i=>i.equipped||i.artifact?.kind==='passive').map(i=>({name:i.name,weapon:i.weapon,armor:i.armor,buffs:i.buffs})),ammo:(a.inventory||[]).filter(i=>i.ammoTag).map(i=>[i.name,i.quantity])}));
      const ruleEntries=state.lorebooks.filter(b=>(room.rulebookIds||[]).includes(b.id)).flatMap(b=>(b.entries||[]).filter(e=>e.enabled!==false&&e.content?.trim()).map(e=>`Рулбук «${b.name}» · ${e.name}: ${e.content}`));
      const ruleText=ruleEntries.join('\n\n').slice(0,Math.max(600,Math.floor(limit/3)));
      const allRoundEvents=roundEvents(g).map(e=>e.text).join('\n'),events=allRoundEvents.slice(-Math.floor(limit/2));
      const engineTable=table.map(a=>({id:a.id,name:a.name,player:a.player,hp:a.hp,maxHp:a.maxHp,slots:a.slots,armor:a.armor,x:a.x,y:a.y,grappledBy:a.grappledBy,beam:a.beam,actions:a.actions,fastActions:a.fastActions}));
      priorityInstructions='[SAS_GM_ROUND_CONTRACT] Ты AI ведущий D&D/НРИ. Отыгрывай NPC и последствия действий всех участников. Не выбирай решения игроков. Рулбуки задают правила, лорбуки — сведения о мире, Story book — цель приключения. Не считай броски и урон заново. Подтверждённые результаты движка и текущая таблица приоритетнее архивной памяти и любого художественного текста. Сохраняй имена, числа, пароли и условия из источников точно. Описывай видимые эффекты. Ответь на текущие вопросы прямыми репликами NPC; неизвестное не выдумывай. Заверши все предложения.\nОЧЕРЕДЬ ИНИЦИАТИВЫ: '+JSON.stringify(g.order?.slice(g.turn))+'; следующий участник: '+(g.actors.find(a=>a.id===g.order?.[g.turn])?.name||'конец раунда')+'; NPC, уже отыгранные движком: '+JSON.stringify(g.gmProcessed||[])+'; описывай только уже выполненные ходы, НЕ будущих участников.\nТЕКУЩИЙ РАУНД: '+g.round+'; фаза: '+g.phase+'; сцена: '+JSON.stringify(room.scene)+'\nТЕКУЩИЕ РЕСУРСЫ И ПОЗИЦИИ (движок уже всё посчитал): '+JSON.stringify(engineTable)+'\nПОДТВЕРЖДЁННЫЕ РЕЗУЛЬТАТЫ ЭТОГО РАУНДА:\n'+allRoundEvents+'\n'+storyDirector(room);
      extraInstructions='Ты AI ведущий. Описывай последствия уже рассчитанных действий и всех NPC; не выбирай действия за игроков и не придумывай броски, урон или изменения ресурсов. Текущая таблица движка — канон, она приоритетнее устаревших чисел в архиве. Расчёты уже показаны игрокам: в повествовании описывай попадания, промахи, ранения и эффекты без повторного подсчёта и перечисления HP, урона, ячеек и кубиков. Отвечай только на вопросы текущего раунда: старые вопросы из архива повторно не разыгрывай. Если игрок слушает или ждёт, не придумывай за него новые вопросы, жесты и решения. Числа, сроки, пароли и условия из источников неизменны; нельзя добавлять скидки, награды или новые условия.\n'+'\nРУЛБУКИ — ПРАВИЛА ИГРЫ, НЕ СОБЫТИЯ СЮЖЕТА. Движок рассчитывает числа; не подменяй его результаты правилами из художественного текста. ЛОРБУКИ описывают мир, персонажей и факты, но не переопределяют механику.\n'+ruleText+'\n'+storyContext(outline)+'\nТекущая сцена: '+JSON.stringify(room.scene)+'\nРаунд '+g.round+' · '+g.phase+'\nТЕКУЩИЕ ресурсы и позиции ПОСЛЕ действий: '+JSON.stringify(table)+'\nРасчёты ТОЛЬКО ЭТОГО раунда (уже выполнены):\n'+events+'\nПравила хоста: '+g.rules.instructions.slice(0,1500)+'\nПерсоны: '+descriptions.slice(0,Math.floor(limit/4));
    }
    return {state:promptState,chat:roomContext,extraInstructions,priorityInstructions,roomId:room.id};
  }
  function editMessage(id,content) {
    requireRoom();if(generation)throw new Error('Нельзя менять контекст во время хода ведущего.');
    if(typeof content!=='string'||!content.trim()||content.length>200000)throw new Error('Текст сообщения: от 1 до 200 000 символов.');
    const state=getState(),message=state.multiplayer?.messages?.find(m=>m.id===id);
    if(!message)throw new Error('Сообщение не найдено.');
    message.content=content.trim();message.editedAt=new Date().toISOString();if(state.multiplayer.narration?.messageId===id)state.multiplayer.narration.error='';persist(state);
    broadcast({type:'edit',message});return {message};
  }
  function moderate(id,action) {
    requireRoom();
    const entry=[...peers].find(([,p])=>p.authenticated&&p.id===id);if(!entry)throw new Error('Игрок не найден.');
    const [socket,peer]=entry;
    if(action==='kick'||action==='mute'||action==='unmute'){
      const state=getState(),g=state.multiplayer?.tactical,a=g?.actors?.find(a=>a.id===id),saved=state.multiplayer?.playerSessions?.[id];
      if(action==='kick'){if(saved)saved.revoked=true;if(a)a.online=false;send(socket,{type:'kicked',error:'Хост исключил вас из комнаты.'});peer.authenticated=false;socket.close(1008,'Removed by host');}
      else{peer.muted=action==='mute';if(saved)saved.muted=peer.muted;if(a)a.online=!peer.muted;}
      if(g?.version===2&&!generation&&publicNarration(state.multiplayer,state)?.status!=='incomplete')syncPlayers(g);
      persist(state);
    }
    else throw new Error('Неизвестное действие модерации.');
    notify();return status();
  }
  function publishImage(image) {
    if(image.kind==='battlemap'){const state=getState(),room=[state.multiplayer,...(state.multiplayerHistories||[])].find(r=>r?.id===image.roomId);if(room?.tactical?.map?.id===image.mapId){room.tactical.map.imageId=image.id;persist(state);notify();}return;}
    if(image.roomId!==roomData().id||image.status!=='done'||messages().some(m=>m.imageId===image.id))return;
    append({id:crypto.randomUUID(),role:'assistant',kind:'image',name:'Хост · ComfyUI',imageId:image.id,imageCount:image.files.length,content:'Изображение текущей сцены',createdAt:new Date().toISOString()});
  }
  async function start(options={},signal) {
    if(server?.listening)return status();
    const requestedPort=options.port===undefined?3211:Number(options.port);
    if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw new Error('Порт комнаты: от 1 до 65535.');
    hostPersona=getState().personas.find(p=>p.id===options.personaId);
    if(!hostPersona)throw new Error('Выберите персону хозяина перед открытием комнаты.');
    hostName=String(options.userName||getState().settings.userName||'Хозяин').trim().slice(0,40);
    const initial=getState();
    if((options.newHistory||options.historyId&&options.historyId!==initial.multiplayer?.id)&&initial.images.some(i=>i.roomId===initial.multiplayer?.id&&i.status==='queued'))throw new Error('Дождитесь завершения изображения текущей истории.');
    selectRoomHistory(initial,options);
    const pendingReopen=publicNarration(initial.multiplayer,initial)?.status==='incomplete',originalHostId=initial.multiplayer.personas?.host?.id||initial.multiplayer.tactical?.actors?.find(a=>a.id==='host')?.personaId;
    if(pendingReopen&&originalHostId&&originalHostId!==hostPersona.id)throw Object.assign(new Error('Сначала допишите ответ ведущего с прежней персоной хоста. Сменить персону можно после завершения раунда.'),{status:409});
    if(!['roleplay','dnd','custom'].includes(initial.multiplayer.mode||'roleplay'))throw new Error('Неизвестный режим игры.');
    if(isGame(initial.multiplayer)){
      validateSRP(hostPersona);const room=initial.multiplayer;
      if(options.adventure&&!room.storybook){const a=options.adventure;if(a.kind==='book'){const book=initial.storybooks.find(b=>b.id===a.bookId);room.storybook=validateStorybook(book);}else if(a.kind==='quick')room.storybook=await quickAdventure(initial,{...a,connectionId:options.connectionId},getSecret,signal);else throw new Error('Выберите начало приключения.');room.scene={...emptyScene(),location:room.storybook.start};}
      if(room.tactical?.version!==2){const old=room.tactical;room.tactical=createAdventureGame(room.mode,options.rules);if(old){room.legacyTactical=old;room.tactical.map=old.map;room.tactical.log=old.log||[];room.tactical.round=Math.max(1,old.round||1);room.tactical.actors=(old.actors||[]).filter(a=>!a.player);}} 
      const g=room.tactical;for(const a of g.actors)if(a.player&&a.id!=='host')a.online=false;let host=g.actors.find(a=>a.id==='host');
      if(!host||host.personaId!==hostPersona.id){g.actors=g.actors.filter(a=>a.id!=='host');const player=adventureActor('host',hostPersona,g.rules),oldHost=room.legacyTactical?.actors?.find(a=>a.id==='host');if(g.map)Object.assign(player,oldHost?{x:oldHost.x,y:oldHost.y}:g.map.start[0]);g.actors.unshift(player);}
      if(!pendingReopen)for(const a of g.actors)prepareActor(a,g.rules);if(!pendingReopen){if(!g.initiativeVersion){if(g.phase!=='gm')beginInitiative(g);}else syncPlayers(g);}if(room.storybook&&!room.messages.length)g.phase='gm';if(room.narration&&['writing','incomplete'].includes(room.narration.status)){room.narration.status='incomplete';room.narration.reason||='network';g.phase='gm';}else room.gmError='';g.gmProcessed||=[];
    }
    if(!isGame(initial.multiplayer)&&!initial.chats.some(c=>c.id===(options.chatId||initial.multiplayer.chatId||initial.chats[0]?.id)))throw new Error('Персонаж ведущего этой истории удалён. Выберите другого.');
    name=String(options.name||initial.multiplayer.name||'Наша история').trim().slice(0,100);
    initial.multiplayer.name=name;
    if(options.lobby!==undefined&&typeof options.lobby!=='boolean')throw new Error('Неверный переключатель лобби.');
    {const previous=initial.multiplayer.lobby||{},enabled=options.lobby??!!previous.enabled;initial.multiplayer.lobby={...previous,enabled,phase:enabled?'waiting':'playing',initialRosterPending:!!(options.newHistory&&enabled||previous.initialRosterPending),...(!enabled?{startedAt:previous.startedAt||new Date().toISOString()}:{})};}
    initial.multiplayer={...initial.multiplayer,id:initial.multiplayer?.id||crypto.randomUUID(),scene:{...emptyScene(),...initial.multiplayer?.scene},personas:{...initial.multiplayer?.personas,host:pendingReopen&&initial.multiplayer.personas?.host?initial.multiplayer.personas.host:publicPersona(hostPersona)}};
    if(pendingReopen&&initial.multiplayer.personas?.host)hostPersona={...hostPersona,...initial.multiplayer.personas.host};
    persist(initial);
    turns.configure(initial.multiplayer.weights||{},['host','narrator']);if(publicNarration(initial.multiplayer,initial)?.status!=='incomplete')configure(options);
    code=crypto.randomBytes(18).toString('base64url');
    const checkCode=value=>{const a=Buffer.from(String(value||'')),b=Buffer.from(code);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
    server=http.createServer((req,res)=>{
      const target=new URL(req.url,'http://sas.local'),pathname=target.pathname;
      if(req.method==='GET'&&pathname==='/room-info'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({sasRoom:1,id:roomData().id,name,mode:roomData().mode||'roleplay',lobby:!!roomData().lobby?.enabled}));return;}
      if(req.method==='POST'&&pathname==='/admit-auth'){
        if(!checkCode(target.searchParams.get('code'))||!isAdmittedRequest(req)){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Нужен допуск хоста.'}));return;}
        const cookie='SASRoom-'+crypto.createHash('sha256').update(roomData().id).digest('hex').slice(0,12);res.writeHead(204,{'Set-Cookie':cookie+'='+String(req.headers['x-sas-resume']||'')+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400','Cache-Control':'no-store'});res.end();return;
      }
      if(req.method==='POST'&&pathname==='/translate'){
        void (async()=>{
          if(!checkCode(target.searchParams.get('code'))||!isAdmittedRequest(req))throw Object.assign(new Error('Перевод доступен допущенным участникам.'),{status:403});
          if(!translationService)throw Object.assign(new Error('Переводчик недоступен.'),{status:503});
          const key=String(req.headers['x-sas-resume']||req.headers.cookie||'').slice(0,300),now=Date.now();for(const [id,window]of translationWindows)if(now-window.at>60000)translationWindows.delete(id);let window=translationWindows.get(key);if(!window){window={at:now,count:0};translationWindows.set(key,window);}if(++window.count>30)throw Object.assign(new Error('Слишком много запросов перевода.'),{status:429});
          let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw Object.assign(new Error('Запрос слишком большой.'),{status:400});}let body;try{body=JSON.parse(raw);}catch{throw Object.assign(new Error('Некорректный JSON запроса.'),{status:400});}
          const message=messages().find(m=>m.id===body.messageId);if(!message||!message.content?.trim())throw Object.assign(new Error('Сообщение комнаты не найдено.'),{status:404});
          const settings=getState().settings.translation||{},result=await translationService.translate(message.content,settings.sourceLanguage||'auto',body.targetLang||settings.displayLanguage||'ru',settings.provider||'yandex',{fallback:!!settings.translationFallback});
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({messageId:message.id,...result}));
        })().catch(error=>{if(!res.headersSent)res.writeHead(error.status||500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.message||'Перевод недоступен.'}));});return;
      }
      if(pathname.startsWith('/room-audio/')){void media.handleHttp(req,res,target,{authorized:checkCode(target.searchParams.get('code'))&&(!roomData().lobby?.enabled||isAdmittedRequest(req))}).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});return;}
      if(req.method==='GET'&&pathname==='/export'&&checkCode(target.searchParams.get('code'))&&(!roomData().lobby?.enabled||isAdmittedRequest(req))){
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="SAS-campaign.json"','Cache-Control':'no-store'});
        res.end(JSON.stringify({spec:'sas_room_chat_v1',room:{id:roomData().id,name:roomData().name,mode:roomData().mode},messages:messages()},null,2));return;
      }
      const mapLayer=pathname.match(/^\/map\/(layout|normal|depth)$/);if(req.method==='GET'&&mapLayer&&checkCode(target.searchParams.get('code'))&&(!roomData().lobby?.enabled||isAdmittedRequest(req))&&roomData().tactical?.map){res.writeHead(200,{'Content-Type':'image/png'});res.end(mapPNG(roomData().tactical.map,mapLayer[1]));return;}
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      if(req.method==='GET'&&['/srp.mjs','/rpg-rules.mjs','/equipment.mjs'].includes(pathname)){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(fs.readFileSync(new URL('../shared'+pathname,import.meta.url)));return;}
      if(req.method==='GET'&&['/room-media-runtime.js','/room-media-client.js','/room-recovery.js','/room-media.css'].includes(pathname)){
        const packaged=pathname==='/room-media-runtime.js'||pathname==='/room-media.css',file=packaged?(fs.existsSync(new URL('../public'+pathname,import.meta.url))?'../public':'../dist')+pathname:'.'+pathname;res.writeHead(200,{'Content-Type':pathname.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(new URL(file,import.meta.url)));return;
      }
      if(req.method==='GET'&&['/','/play','/room-client.js','/room-game.js','/room-sheet.js'].includes(pathname)){
        const js=pathname.endsWith('.js');
        res.writeHead(200,{'Content-Type':js?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; frame-ancestors 'none'"});
        res.end(fs.readFileSync(new URL(js?'.'+pathname:'./room-page.html',import.meta.url)));return;
      }
      const imageMatch=pathname.match(/^\/media\/([a-f0-9-]+)\/(\d+)$/);
      if(req.method==='GET'&&imageMatch&&checkCode(target.searchParams.get('code'))&&(!roomData().lobby?.enabled||isAdmittedRequest(req))&&(messages().some(m=>m.imageId===imageMatch[1])||roomData().tactical?.map?.imageId===imageMatch[1])){
        const image=getState().images.find(i=>i.id===imageMatch[1]&&i.roomId===roomData().id),file=image?.files?.[Number(imageMatch[2])];
        if(file&&/^[a-f0-9-]+\.(png|jpg|webp)$/.test(file)){
          const filename=path.join(dataDir,'images',file);
          if(fs.existsSync(filename)){res.setHeader('Content-Type',file.endsWith('.png')?'image/png':file.endsWith('.jpg')?'image/jpeg':'image/webp');res.setHeader('Cache-Control','private, max-age=3600');const stream=fs.createReadStream(filename);stream.on('error',()=>res.destroy());stream.pipe(res);return;}
        }
      }
      res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Метод недоступен участнику комнаты.'}));
    });
    wss=new WebSocketServer({noServer:true,maxPayload:256*1024});
    server.on('upgrade',(req,socket,head)=>{
      if(req.url!=='/ws'||peers.size>=40){socket.destroy();return;}
      if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host){socket.destroy();return;}}catch{socket.destroy();return;}}
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
    });
    wss.on('connection',socket=>{
      const peer={id:crypto.randomUUID(),authenticated:false,name:'',muted:false,window:Date.now(),count:0};peers.set(socket,peer);
      const timer=setTimeout(()=>{if(!peer.authenticated)socket.close(1008,'Invitation required');},10000);timer.unref();
      socket.on('error',()=>{});
      socket.on('message',raw=>{
        let data;
        try {
          data=JSON.parse(raw.toString());if(!data||typeof data!=='object')throw new Error('Некорректное сообщение.');
          if(Date.now()-peer.window>10000){peer.window=Date.now();peer.count=0;}
          if(data.type!=='voice'&&++peer.count>8)throw new Error('Слишком много сообщений. Подождите несколько секунд.');
          if(!peer.authenticated){
            if(data.type!=='join'||!checkCode(data.code)){send(socket,{type:'error',error:'Неверный код приглашения.'});socket.close(1008,'Invalid invitation');return;}
            peer.name=String(data.name||'').trim().slice(0,40);if(!peer.name)throw new Error('Введите имя участника.');
            if(!data.persona?.id)throw new Error('Перед входом обязательно выберите персону.');
            // Freeze the game roster until a partial round is completed. Existing
            // guests may keep reading; new guests can join after the host finishes.
            const state=getState(),returning=returningPlayer(state.multiplayer,data.resumeToken,data.persona.id);
            if(isGame()&&!returning&&!state.multiplayer.lobby?.enabled&&(generation||publicNarration(roomData(),getState())?.status==='incomplete'))throw Object.assign(new Error('Хост дописывает ответ ведущего. Подключитесь после завершения раунда.'),{status:409});
            let resumeToken;
            if(returning){
              peer.id=returning.actorId;peer.persona=returning.persona;peer.admitted=true;peer.ready=false;
              for(const [oldSocket,oldPeer] of peers)if(oldSocket!==socket&&oldPeer.authenticated&&oldPeer.id===peer.id){oldPeer.authenticated=false;oldSocket.close(1000,'Session resumed');}
              peer.muted=!!state.multiplayer.playerSessions?.[peer.id]?.muted;
              if(returning.actor)returning.actor.online=!peer.muted;
              resumeToken=data.resumeToken;
              if(isGame()&&state.multiplayer.tactical.version===2&&!generation&&publicNarration(state.multiplayer,state)?.status!=='incomplete')syncPlayers(state.multiplayer.tactical);
            }else{
              if(isGame())validateSRP(data.persona);
              peer.persona={...publicPersona(data.persona),id:peer.id};
              if(state.multiplayer.lobby?.enabled){
                peer.admitted=false;peer.ready=false;peer.originalPersonaId=data.persona.id;peer.authenticated=true;peer.roomId=state.multiplayer.id;clearTimeout(timer);
                send(socket,{type:'state',selfId:peer.id,admission:'pending',messages:[],participants:[],room:{id:state.multiplayer.id,name,mode:state.multiplayer.mode,lobby:lobbyState()}});notify();return;
              }
              peer.admitted=true;peer.ready=false;
              state.multiplayer.personas={...state.multiplayer.personas,[peer.id]:peer.persona};
              if(isGame()){const game=state.multiplayer.tactical,actor=game.version===2?adventureActor(peer.id,peer.persona,game.rules):actorFromPersona(peer.id,peer.persona,game.rules);if(game.map){const free=game.map.start.find(c=>!game.actors.some(a=>a.online!==false&&a.hp>0&&a.x===c.x&&a.y===c.y));if(!free)throw new Error('Стартовая область заполнена.');Object.assign(actor,free);}game.actors.push(actor);if(game.version===2)syncPlayers(game);else if(game.inCombat)game.order.push(actor.id);}
              resumeToken=rememberPlayer(state.multiplayer,peer.id,data.persona.id);
            }
            if(returning?.actor&&state.multiplayer.tactical?.map&&!generation&&!publicNarration(state.multiplayer,state)){const g=state.multiplayer.tactical,a=returning.actor;if(g.actors.some(other=>other.id!==a.id&&other.hp>0&&other.online!==false&&other.x===a.x&&other.y===a.y)){const free=g.map.start.find(c=>!g.actors.some(other=>other.id!==a.id&&other.hp>0&&other.online!==false&&other.x===c.x&&other.y===c.y));if(!free)throw new Error('На карте нет свободного места для возвращения.');Object.assign(a,free);}}
            persist(state);
            peer.authenticated=true;peer.roomId=state.multiplayer.id;clearTimeout(timer);
            send(socket,{type:'state',selfId:peer.id,admission:'approved',resumeToken,messages:messages().slice(-300),archiveCount:messages().length,...metadata()});notify();return;
          }
          if(data.type==='lobby-ready'){
            if(peer.admitted===false)throw Object.assign(new Error('Дождитесь допуска хоста.'),{status:403});
            if(typeof data.ready!=='boolean')throw new Error('Неверный статус готовности.');peer.ready=data.ready;notify();
          }else if(peer.admitted===false)throw Object.assign(new Error('Дождитесь допуска хоста в лобби.'),{status:403});
          else if(data.type==='voice')media.command(peer,data);
          else if(data.type==='message')playerMessage(peer.id,data.content);
          else if(data.type==='dice')dice(peer.id,data.sides);
          else if(data.type==='game')act(data,peer.id);
          else if(data.type==='leave'){socket.close(1000,'Left room');return;}
          else throw new Error('Это действие доступно только хосту.');
          send(socket,{type:'ack',requestId:String(data.requestId||'').slice(0,100)});
        }catch(error){send(socket,{type:'error',status:error.status||400,requestId:String(data?.requestId||'').slice(0,100),error:error.message||'Не удалось выполнить действие.'});}
      });
      socket.on('close',()=>{
        clearTimeout(timer);media.disconnected(peer);peers.delete(socket);
        if(peer.authenticated&&peer.admitted!==false&&isGame()&&roomData().id===peer.roomId&&![...peers.values()].some(p=>p.authenticated&&p.id===peer.id)){
          const s=getState(),g=s.multiplayer.tactical,actor=g.actors.find(a=>a.id===peer.id);if(actor)actor.online=false;
          if(g.version===2){if(!generation&&publicNarration(s.multiplayer,s)?.status!=='incomplete')syncPlayers(g);}else{g.order=g.order.filter(id=>id!==peer.id);g.turn=Math.min(g.turn,Math.max(0,g.order.length-1));}
          persist(s);
        }
        notify();
      });
    });
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,'0.0.0.0',resolve);});}
    catch(error){await stop();throw new Error(error.code==='EADDRINUSE'?'Порт комнаты занят.':`Не удалось открыть комнату: ${error.message}`);}
    port=server.address().port;
    const ips=Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal);
    const ip=ips.find(i=>/^192\.168\./.test(i.address))?.address||ips.find(i=>/^10\./.test(i.address))?.address||ips[0]?.address||'127.0.0.1';
    url=`http://${ip}:${port}/play?code=${encodeURIComponent(code)}&room=${encodeURIComponent(roomData().id)}`;
    metadataTimer=setInterval(()=>{notify();autoGM();},500);metadataTimer.unref();return status();
  }
  async function stop() {
    generation?.abort();clearInterval(metadataTimer);
    for(const [socket,peer]of peers){media.disconnected(peer);socket.terminate();}peers.clear();await media.close();await backups.flush();
    wss?.close();if(server?.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    server=undefined;wss=undefined;port=0;code='';url='';return status();
  }
  function requiredNarrationMessages(instructions,posts,connection){
    const available=(Number(connection.contextWindow)||8192)-Math.min(Number(connection.maxTokens)||1024,(Number(connection.contextWindow)||8192)/2);
    const capacity=Math.max(600,Math.floor(available*.42)*3),postsFit=posts.reduce((sum,m)=>sum+m.content.length,0)<=capacity;
    const perPost=Math.max(150,Math.floor(capacity/Math.max(1,posts.length)));
    const actors=roomData()?.tactical?.actors||[],players=actors.filter(a=>a.player).map(a=>a.name),npcs=actors.filter(a=>!a.player&&a.hp>0).map(a=>a.name);
    const ownership='[SAS_ROLE_OWNERSHIP] Игровые герои: '+players.join(', ')+'. Их новые действия и прямые реплики пишет только соответствующий игрок; ты не можешь дописать их ход. Живые NPC, которыми ты управляешь: '+(npcs.join(', ')||'на столе нет; можно описывать окружение и появление новых NPC')+'. Если герой ждёт, описывай то, что доступно ему без движения и без новой реплики от его имени.';
    return [{role:'system',content:instructions+'\n'+ownership},{role:'user',content:'[SAS_CURRENT_PLAYER_REQUESTS] Текущие действия и вопросы КАЖДОГО игрока (это запросы, не уже выполненные NPC события):\n'+posts.map(m=>{const name=m.personaName||m.name||'Герой',body=m.content.startsWith(name+': ')?m.content.slice(name.length+2):m.content;return `${name}: ${extractiveProtocol(body,postsFit?body.length:perPost)}`;}).join('\n\n')+'\nЗакончи повествование на русском. Ответь на текущие вопросы прямыми репликами NPC, сохрани точные имена, числа и условия из источников. Не перечисляй расчёты и ресурсы. Развей ситуацию конкретным ВНЕШНИМ событием или доступной зацепкой к цели Story book с учётом выбранного игроками пути. Новые действия, перемещения и реплики могут принадлежать только NPC, а не игрокам. Не заставляй игроков брать предметы или отвечать. Затем оставь следующие решения игрокам.\n'+ownership}];
  }
  async function regenerateNarration(messageId,signal){
    const initial=getState(),room=initial.multiplayer,allowed=publicRegeneration(room,initial),record=room.lastNarration;
    if(allowed?.messageId!==messageId||!allowed.canRegenerate||!record?.promptMessages?.length)throw Object.assign(new Error('Перегенерация доступна до новых сообщений и действий игроков. Уже выполненные ходы не переигрываются.'),{status:409});
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();generation=controller;notify();
    try{
      const {state,chat}=context(),connection=getConnection(state,chat),started=performance.now();let text='',reason='',firstTokenAt,lastTimings;
      for(let attempt=0;attempt<3;attempt++){
        const project=gameIdentityProjector(roomData()),fitted=await fitNarrationPrompt(connection,getSecret(connection.id),record.promptMessages.map(m=>({...m,content:project(m.content)})),{text:project(text),maxTokens:connection.maxTokens||record.maxTokens,priorityMessages:(record.priorityMessages||[]).map(m=>({...m,content:project(m.content)})),signal:controller.signal,adaptInstruction:isGame(),instruction:undefined});
        const joiner=text?createNarrationContinuationJoiner(text):undefined;reason='';const before=text.length;
        try{for await(const chunk of streamCompletion(connection,getSecret(connection.id),fitted.messages,{signal:controller.signal,adaptInstruction:isGame(),disableThinking:isGame(),stop:isGame()?narrationStops(roomData().tactical.round):undefined,onTimings:timings=>{lastTimings=timings;},onFinish:finish=>{reason=finish;},preset:{...state.presets?.find(p=>p.id===(chat.presetId||state.activePresetId)),maxTokens:fitted.maxTokens}})){if(chunk)firstTokenAt??=performance.now();text+=joiner?joiner.push(chunk):chunk;if(text.length>2000000)throw new Error('Ответ ведущего слишком длинный.');}}
        finally{if(joiner)text+=joiner.flush();}
        if(text.length===before)throw new Error('Модель не вернула новый вариант. Предыдущий ответ сохранён.');
        if(reason!=='length')break;
      }
      text=cleanNarration(text);if(!text||reason==='length')throw new Error('Новый вариант не завершён. Предыдущий ответ сохранён; увеличьте лимит ответа и повторите.');
      controller.signal.throwIfAborted();const fresh=getState();if(fresh.multiplayer?.id!==room.id||!publicRegeneration(fresh.multiplayer,fresh)?.canRegenerate)throw new Error('Контекст изменился. Предыдущий ответ сохранён.');
      const message=fresh.multiplayer.messages.find(m=>m.id===messageId);message.content=text;message.regeneratedAt=new Date().toISOString();delete message.translatedContent;delete message.originalContent;
      fresh.multiplayer.lastNarration.contextHash=narrationContextHash(fresh.multiplayer,messageId);fresh.multiplayer.contextReport={...fresh.multiplayer.contextReport,performance:{totalMs:Math.round(performance.now()-started),firstTokenMs:firstTokenAt?Math.round(firstTokenAt-started):null,...(lastTimings?{promptTokens:lastTimings.prompt_n,outputTokens:lastTimings.predicted_n,tokensPerSecond:lastTimings.predicted_per_second}:{})}};persist(fresh);broadcast({type:'edit',message});
      try{const refreshed=context(),scene=await inferScene(refreshed.state,{...refreshed.chat,scene:record.sceneBefore||refreshed.chat.scene},getSecret,controller.signal);if(scene){const latest=getState();if(latest.multiplayer?.id===room.id){latest.multiplayer.scene={...latest.multiplayer.scene,...scene};latest.multiplayer.lastNarration.contextHash=narrationContextHash(latest.multiplayer,messageId);persist(latest);}}}catch{}return {message,regenerated:true,incomplete:false};
    }finally{signal?.removeEventListener('abort',abort);if(generation===controller)generation=undefined;notify();}
  }
  async function generate({chatId,content,continueMessageId,acceptMessageId,regenerateMessageId,signal}={}) {
    assertStarted();
    requireRoom();if(generation)throw Object.assign(new Error('Ведущий уже пишет ответ.'),{status:409});
    if(regenerateMessageId){if(continueMessageId||acceptMessageId||content?.trim()||chatId)throw Object.assign(new Error('Выберите только перегенерацию ответа.'),{status:400});return regenerateNarration(regenerateMessageId,signal);}
    if(continueMessageId&&acceptMessageId)throw Object.assign(new Error('Выберите дописывание или завершение ответа.'),{status:400});
    const room=roomData(),pending=publicNarration(room,getState()),resumeId=continueMessageId||acceptMessageId,resume=!!resumeId;
    if(resume){
      if(typeof resumeId!=='string'||pending?.messageId!==resumeId||pending.status!=='incomplete')throw Object.assign(new Error('Незаконченный ответ этой комнаты не найден.'),{status:409});
      if(continueMessageId&&!pending.canContinue)throw Object.assign(new Error('Контекст раунда изменён. Сохраните отредактированный ответ как готовый; повторное выполнение ходов не требуется.'),{status:409});
      if(content?.trim()||chatId&&chatId!==room.chatId)throw Object.assign(new Error('Дописать можно только текущий ответ без новых действий игроков.'),{status:400});
    }else{
      if(pending?.status==='incomplete')throw Object.assign(new Error('Ответ ведущего не завершён. Нажмите «Дописать ответ».'),{status:409});
      if(chatId&&!isGame()&&chatId!==room.chatId)configure({chatId});
      if(content?.trim())playerMessage('host',content);
    }
    if(isGame()&&roomData().tactical.version===2){if(roomData().tactical.phase!=='gm')throw new Error('Сейчас очередь игрока. Завершите его ход.');}else if(!resume)turns.assert('narrator',actorIds());
    const controller=new AbortController();generation=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();notify();
    const id=resume?resumeId:crypto.randomUUID(),roomId=roomData().id,gameMode=isGame(roomData()),narratorName=gameMode?'AI Game Master':getState().characters.find(c=>c.id===getState().chats.find(ch=>ch.id===roomData().chatId)?.characterId)?.name||'Ведущий';
    const generationStarted=performance.now();let firstTokenAt,lastTimings;
    let text=resume?room.messages.find(m=>m.id===id).content:'',finishReason='',automatic=0,lastSave=0,sourcePrompt,promptMaxTokens,priorityMessages=[];
    const updateMessage=(incomplete,error='')=>{
      const fresh=getState();if(fresh.multiplayer?.id!==roomId)throw new Error('История комнаты изменилась.');
      fresh.multiplayer.messages||=[];const target=fresh.multiplayer.messages.find(m=>m.id===id),message={...(target||{id,role:'assistant',name:narratorName,createdAt:new Date().toISOString()}),content:text,interrupted:incomplete,continuationStatus:incomplete?'incomplete':'complete'};
      if(target)Object.assign(target,message);else fresh.multiplayer.messages.push(message);
      fresh.multiplayer.narration={...fresh.multiplayer.narration,messageId:id,status:incomplete?'incomplete':'complete',reason:finishReason==='length'?'length':controller.signal.aborted?'stopped':'network',error,automaticContinuations:automatic};
      persist(fresh);broadcast({type:target?'edit':'message',message});lastSave=Date.now();return message;
    };
    const finalize=()=>{
      const clean=cleanNarration(text);if(!clean)throw new Error('Модель вернула только служебный заголовок. Допишите ответ или повторите генерацию.');text=clean;
      const message=updateMessage(false),fresh=getState();
      if(gameMode&&fresh.multiplayer.tactical.version===2){
        // Keep offline sheets for secure resume; the initiative/pathfinding
        // engines ignore offline players and release their occupied cells.
        const connected=new Set([...peers.values()].filter(p=>p.authenticated&&p.admitted!==false&&!p.muted).map(p=>p.id)),game=fresh.multiplayer.tactical;
        for(const actor of game.actors)if(actor.player&&actor.id!=='host')actor.online=connected.has(actor.id);
        if(game.initiativeVersion&&game.gmPendingNext&&game.turn<game.order.length){game.gmPendingNext=false;activateInitiative(game);}else resetRound(game);game.gmProcessed=[];fresh.multiplayer.gmError='';
      }
      else turns.complete('narrator',actorIds());
      if(fresh.multiplayer.narration?.promptMessages?.length)fresh.multiplayer.lastNarration={messageId:id,promptMessages:fresh.multiplayer.narration.promptMessages,priorityMessages:fresh.multiplayer.narration.priorityMessages||[],maxTokens:fresh.multiplayer.narration.maxTokens,sceneBefore:fresh.multiplayer.narration.sceneBefore,contextHash:narrationContextHash(fresh.multiplayer,id),referencesHash:narrationReferencesHash(fresh,fresh.multiplayer)};
      // Retain only the most recent snapshot, privately, for text-only retries.
      delete fresh.multiplayer.narration;persist(fresh);return message;
    };
    try {
      const progress=stage=>{const s=getState();if(s.multiplayer?.id===roomId){s.multiplayer.memoryProgress=stage;persist(s);notify();}};
      let state,chat,connection;
      if(resume){
        ({state,chat}=context());connection=getConnection(state,chat);sourcePrompt=room.narration?.promptMessages;priorityMessages=room.narration?.priorityMessages||[];promptMaxTokens=Number(connection.maxTokens)||room.narration?.maxTokens;
        if(acceptMessageId)return {message:finalize(),accepted:true};
        if(pending.legacy){const current=context();priorityMessages=gameMode?requiredNarrationMessages(current.priorityInstructions,roundMessages(chat),connection):[];const prompt=preparePrompt?await preparePrompt(state,chat.id,'',{extensionMode:state.multiplayer?.mode==='roleplay'?'multiplayer-roleplay':state.multiplayer?.mode,extraInstructions:current.extraInstructions,compact:true,extraFirst:true,signal:controller.signal}):buildPrompt(state,chat.id,'',{extraInstructions:current.extraInstructions,compact:true,extraFirst:true});sourcePrompt=prompt.messages;promptMaxTokens=prompt.budget.maxTokens;const fresh=getState();fresh.multiplayer.narration={messageId:id,status:'incomplete',promptMessages:sourcePrompt,priorityMessages,maxTokens:promptMaxTokens,contextHash:narrationContextHash(fresh.multiplayer,id),referencesHash:narrationReferencesHash(fresh,fresh.multiplayer)};persist(fresh);}
        if(!Array.isArray(sourcePrompt)||!sourcePrompt.length)throw new Error('Сохранённый контекст дописывания отсутствует. Отредактируйте ответ и сохраните как готовый.');
      }else{
        try{await roomMemory.maintain(roomId,{signal:controller.signal,onProgress:progress});const s=getState();if(s.multiplayer?.id===roomId){s.multiplayer.memoryWarning='';persist(s);}}catch(error){controller.signal.throwIfAborted();const s=getState();if(s.multiplayer?.id===roomId){s.multiplayer.memoryWarning='Сводка памяти: '+error.message;persist(s);}}
        if(gameMode)await npcTurns(controller.signal);
        const current=context();({state,chat}=current);connection=getConnection(state,chat);
        if(!connection.model)throw new Error('Выберите модель в подключениях.');
        const recalled=await roomMemory.recall(state,chat,controller.signal);
        const round=gameMode?await roomMemory.compactRound(state,chat,{signal:controller.signal,onProgress:progress}):{messages:[],compressed:[]};
        // Current posts live once, in protected priorityMessages. References contain archive only.
        const historyMessages=gameMode?(recalled.text?[{role:'user',content:recalled.text}]:[]):undefined;
        const options={extensionMode:state.multiplayer?.mode==='roleplay'?'multiplayer-roleplay':state.multiplayer?.mode,extraInstructions:gameMode?current.extraInstructions:[recalled.text,current.extraInstructions].filter(Boolean).join('\n\n'),compact:true,extraFirst:true,preserveHistory:gameMode,signal:controller.signal,retrieval:recalled.retrieval,...(historyMessages?{historyMessages}:{})};
        const prompt=preparePrompt?await preparePrompt(state,chat.id,'',options):buildPrompt(state,chat.id,'',options);
        sourcePrompt=prompt.messages;sourcePrompt[0]={...sourcePrompt[0],content:sourcePrompt[0].content+'\n'+narrationFormatInstruction};promptMaxTokens=prompt.budget.maxTokens;priorityMessages=gameMode?requiredNarrationMessages(current.priorityInstructions+'\n'+narrationFormatInstruction,round.messages,connection):[];
        const report={...recalled.report,compressedPosts:round.compressed,playerPosts:(gameMode?round.messages:roundMessages(chat)).map(m=>({id:m.id,name:m.name||m.personaName})),warnings:[...recalled.warnings,...(prompt.warnings||[])],estimatedTokens:prompt.estimatedTokens,budget:prompt.budget,createdAt:new Date().toISOString()};
        const prepared=getState();prepared.multiplayer.contextReport=report;prepared.multiplayer.memoryProgress='Ведущий описывает последствия ходов';prepared.multiplayer.narration={messageId:id,status:'writing',promptMessages:sourcePrompt,priorityMessages,maxTokens:promptMaxTokens,sceneBefore:structuredClone(prepared.multiplayer.scene),contextHash:narrationContextHash(prepared.multiplayer,id),referencesHash:narrationReferencesHash(prepared,prepared.multiplayer),createdAt:new Date().toISOString()};persist(prepared);notify();
      }
      for(let attempt=0;attempt<3;attempt++){
        controller.signal.throwIfAborted();const continuing=resume||attempt>0;
        progress(continuing?'Ведущий дописывает незаконченный ответ':'Ведущий описывает последствия ходов');
        const project=gameIdentityProjector(roomData()),fitted=await fitNarrationPrompt(connection,getSecret(connection.id),sourcePrompt.map(m=>({...m,content:project(m.content)})),{text:continuing?project(text):'',maxTokens:promptMaxTokens,signal:controller.signal,adaptInstruction:gameMode,priorityMessages:priorityMessages.map(m=>({...m,content:project(m.content)}))});
        const measured=getState();measured.multiplayer.contextReport={...measured.multiplayer.contextReport,estimatedTokens:fitted.estimatedTokens,actualTokens:fitted.actualTokens,tokenizer:fitted.actualTokens===null?'estimate':'model',continuation:continuing};persist(measured);
        const before=text.length,joiner=continuing?createNarrationContinuationJoiner(text):undefined;finishReason='';
        const appendDelta=chunk=>{if(!chunk)return;firstTokenAt??=performance.now();text+=chunk;if(text.length>2000000)throw new Error('Ответ ведущего слишком длинный.');broadcast({type:'delta',id,text:chunk});if(Date.now()-lastSave>=500)updateMessage(true);};
        try{
          for await(const chunk of streamCompletion(connection,getSecret(connection.id),fitted.messages,{signal:controller.signal,adaptInstruction:gameMode,disableThinking:gameMode,stop:gameMode?narrationStops(roomData().tactical.round):undefined,onTimings:timings=>{lastTimings=timings;},onFinish:reason=>{finishReason=reason;},preset:{...state.presets?.find(p=>p.id===(chat.presetId||state.activePresetId)),maxTokens:fitted.maxTokens}}))appendDelta(joiner?joiner.push(chunk):chunk);
        }finally{appendDelta(joiner?.flush());}
        if(text.length===before)throw new Error('Модель не дописала ответ. Полученный текст сохранён; попробуйте дописать ещё раз или отредактируйте его вручную.');
        if(finishReason!=='length')break;
        updateMessage(true);
        if(attempt<2){automatic++;continue;}
      }
      if(finishReason==='length'){
        const warning='Ответ достиг лимита длины. Полученный текст сохранён; нажмите «Дописать ответ ведущего».';
        const message=updateMessage(true,warning),fresh=getState();fresh.multiplayer.gmError=warning;persist(fresh);return {message,incomplete:true,reason:'length'};
      }
      const message=finalize(),measured=getState();measured.multiplayer.contextReport={...measured.multiplayer.contextReport,performance:{totalMs:Math.round(performance.now()-generationStarted),firstTokenMs:firstTokenAt?Math.round(firstTokenAt-generationStarted):null,...(lastTimings?{promptTokens:lastTimings.prompt_n,outputTokens:lastTimings.predicted_n,tokensPerSecond:lastTimings.predicted_per_second,promptMs:lastTimings.prompt_ms,outputMs:lastTimings.predicted_ms}:{})}};persist(measured);
      try {chat.messages=chat.messages.filter(m=>m.id!==id);chat.messages.push(message);const scene=await inferScene(state,chat,getSecret,controller.signal);if(scene){const fresh=getState();if(fresh.multiplayer?.id===roomId){fresh.multiplayer.scene={...fresh.multiplayer.scene,...scene};if(fresh.multiplayer.lastNarration?.messageId===id)fresh.multiplayer.lastNarration.contextHash=narrationContextHash(fresh.multiplayer,id);persist(fresh);}}}catch{}
      return {message,incomplete:false};
    }catch(error){
      if(text){updateMessage(true,error.message);const fresh=getState();if(fresh.multiplayer?.id===roomId){fresh.multiplayer.gmError=error.message;persist(fresh);}}
      else {const fresh=getState();if(fresh.multiplayer?.id===roomId) {delete fresh.multiplayer.narration;persist(fresh);}}
      broadcast({type:'error',error:error.message});throw error;
    }finally{signal?.removeEventListener('abort',abort);if(generation===controller)generation=undefined;const s=getState();if(s.multiplayer?.id===roomId){s.multiplayer.memoryProgress='';persist(s);}notify();}
  }
  async function npcTurns(signal){
    if(roomData().tactical?.version===2)return adventureNpcTurns(signal);
    for(let count=0;count<8;count++){
      const room=roomData(),game=room.tactical,actor=game?.actors.find(a=>a.id===game.order[game.turn]);if(!game?.inCombat||!actor||actor.player)break;
      const {state,chat}=context(),floor=[];for(let y=Math.max(0,actor.y-actor.move);y<Math.min(game.map.height,actor.y+actor.move+1);y++)for(let x=Math.max(0,actor.x-actor.move);x<Math.min(game.map.width,actor.x+actor.move+1);x++)if(game.map.tiles[y*game.map.width+x]===0)floor.push([x,y]);
      const schema={type:'object',properties:{x:{type:'integer'},y:{type:'integer'},targetId:{type:'string'},skillId:{type:'string'}},required:['x','y','targetId','skillId'],additionalProperties:false};
      const decision=await structuredCompletion({state,chat:{...chat,connectionId:roomData().aiSettings?.npcConnectionId||chat.connectionId},getSecret,signal,schema,name:'npc_turn',maxTokens:200,adaptInstruction:true,instructions:'You control only this NPC for one turn. Return JSON: destination x,y (stay if no move), targetId and skillId from the given lists, empty strings to pass. Respect movement, obstacles and range. Do not control players.',context:{actor:actorContext([actor])[0],actors:actorContext(game.actors),rules:game.rules,walkable:floor,scene:chat.scene}});
      const fresh=getState(),g=fresh.multiplayer.tactical;try{if(decision.x!==actor.x||decision.y!==actor.y)gameAction(g,{action:'move',actorId:actor.id,x:decision.x,y:decision.y},'host',{host:true});if(decision.targetId&&decision.skillId)gameAction(g,{action:'skill',actorId:actor.id,targetId:decision.targetId,skillId:decision.skillId},'host',{host:true});}catch(e){logGame(g,actor.name+': '+e.message);}gameAction(g,{action:'end',actorId:actor.id},'host',{host:true});persist(fresh);notify();
    }
  }

  function autoGM(){
    if(!server?.listening||!roomStarted()||generation||tasks?.busy()||!isGame())return;const room=roomData();if(room.tactical?.inCombat&&!room.tactical.actors.some(a=>a.player&&a.hp>0&&a.online!==false))return;if(room.tactical?.version!==2||room.tactical.phase!=='gm'||room.gmError||publicNarration(room,getState())?.status==='incomplete')return;
    const promise=tasks?tasks.run({kind:'multiplayer',stage:'Ход AI-ведущего'},signal=>generate({signal})).promise:generate();
    void promise.catch(error=>{const state=getState();if(state.multiplayer?.id===room.id){state.multiplayer.gmError=error.message;persist(state);notify();}});
  }
  async function adventureNpcTurns(signal){
    const initial=roomData().tactical;if(!initial.inCombat)return;
    const candidates=initial.actors.filter(a=>!a.player&&a.hp>0).map(a=>a.id);
    for(let step=0;step<initial.actors.length;step++){
      const active=roomData().tactical;if(active.initiativeVersion)activateInitiative(active);const id=active.initiativeVersion?active.order[active.turn]:candidates[step];if(!id)break;
      signal?.throwIfAborted();const initialGame=roomData().tactical,initialActor=initialGame.actors.find(a=>a.id===id);if(initialGame.initiativeVersion){activateInitiative(initialGame);if(initialGame.order[initialGame.turn]!==id)continue;if(initialActor?.player)break;}if(!initialActor||initialActor.hp<=0)continue;if(initialGame.gmProcessed?.includes(id)){if(initialGame.initiativeVersion)advanceInitiative(initialGame);continue;}
      for(let attempt=0;attempt<(initialGame.rules.slowActions??1);attempt++){
        const game=roomData().tactical,actor=game.actors.find(a=>a.id===id);if(!actor||actor.hp<=0||actor.actions<=0)break;const actionsBefore=actor.actions;
      for(const a of game.actors)prepareActor(a,game.rules);const {state,chat}=context(),walkable=reachableCells(game,actor,actor.grappledBy?0:actor.move).map(([x,y])=>[x,y]);
      const schema={type:'object',properties:{x:{type:'integer'},y:{type:'integer'},action:{type:'string',enum:['skill','escape','channel','pass']},targetId:{type:'string'},skillId:{type:'string'}},required:['x','y','action','targetId','skillId'],additionalProperties:false};
      const decision=await structuredCompletion({state,chat:{...chat,connectionId:roomData().aiSettings?.npcConnectionId||chat.connectionId},getSecret,signal,schema,name:'npc_turn',maxTokens:250,adaptInstruction:true,instructions:'You control only this NPC. Choose one legal destination and one slow action. JSON only. Move only to a supplied reachable cell. Use only this actor skills and existing target IDs. Never decide player actions or roll dice; engine handles results. If grappled, choose escape or attack captor. If a beam is active, channel keeps it, another slow action breaks it. pass is allowed.',context:{actor:actorContext([actor])[0],actors:game.actors.filter(a=>a.online!==false).map(a=>({id:a.id,name:a.name,player:a.player,hp:a.hp,x:a.x,y:a.y,grappledBy:a.grappledBy})),walkable,scene:chat.scene,lastEvents:game.log.slice(-12)},parse:raw=>{const d=JSON.parse(raw.replace(/^```json\s*|\s*```$/g,''));if(!Number.isInteger(d.x)||!Number.isInteger(d.y)||!['skill','escape','channel','pass'].includes(d.action)||typeof d.targetId!=='string'||typeof d.skillId!=='string')throw new Error('Неверное действие NPC.');return d;}});
      const fresh=getState(),g=fresh.multiplayer.tactical;
      for(const request of [...(decision.x!==actor.x||decision.y!==actor.y?[{action:'move',x:decision.x,y:decision.y}]:[]),...(decision.action!=='pass'?[{action:decision.action,targetId:decision.targetId,skillId:decision.skillId}]:[])])try{adventureAction(g,{...request,actorId:id},'host',{host:true});}catch(e){logGame(g,actor.name+': действие отклонено — '+e.message);}
        persist(fresh);notify();if(decision.action==='pass'||g.actors.find(a=>a.id===id).actions>=actionsBefore)break;
      }
      const fresh=getState(),g=fresh.multiplayer.tactical;
      g.gmProcessed=[...(g.gmProcessed||[]),id];if(g.initiativeVersion){g.gmPendingNext=true;advanceInitiative(g);}persist(fresh);notify();
    }
  }

  function act(request,userId='host'){
    requireRoom();assertStarted();if(tasks?.publicTask?.()?.status==='running')throw Object.assign(new Error('Сначала завершите текущую задачу перед новым ходом.'),{status:409});if(!isGame())throw new Error('Тактические действия доступны в D&D/НРИ.');if(generation)throw new Error('Дождитесь ведущего.');if(publicNarration(roomData(),getState())?.status==='incomplete')throw Object.assign(new Error('Сначала завершите ответ ведущего.'),{status:409});const p=participants().find(p=>p.id===userId);if(!p||p.muted)throw new Error('Нет права на действия.');
    const state=getState(),g=state.multiplayer.tactical;(g.version===2?adventureAction:gameAction)(g,request,userId,{host:userId==='host'});if(g.version===2){syncPlayers(g);for(const actor of g.actors.filter(a=>a.player)){const update={level:actor.level,className:actor.className,abilities:actor.abilities,inventory:actor.inventory,spells:actor.spells};const p=actor.id==='host'?state.personas.find(p=>p.id===actor.personaId):state.multiplayer.personas?.[actor.id];if(p)Object.assign(p,update);if(actor.id==='host'&&hostPersona)Object.assign(hostPersona,update);}}persist(state);notify();return status();
  }
  async function makeMap({width,height,signal,onProgress=()=>{}}){
    requireRoom();if(!isGame())throw new Error('Карта доступна в D&D/НРИ.');if(roomData().tactical?.inCombat)throw new Error('Завершите текущий бой перед созданием новой карты.');if(publicNarration(roomData(),getState())?.status==='incomplete')throw Object.assign(new Error('Завершите ответ ведущего перед заменой карты.'),{status:409});const {state,chat,extraInstructions,roomId}=context();onProgress('Ведущий составляет план карты');const descriptor=await describeBattlemap(state,{...chat,connectionId:roomData().aiSettings?.mapConnectionId||chat.connectionId},getSecret,signal,extraInstructions);signal?.throwIfAborted();const map=generateMap({width,height,descriptor}),fresh=getState();if(fresh.multiplayer?.id!==roomId||!server?.listening)throw new Error('Комната закрыта.');fresh.multiplayer.tactical.map=map;populateMap(fresh.multiplayer.tactical,descriptor);const game=fresh.multiplayer.tactical;if(game.version===2){for(const actor of game.actors)prepareActor(actor,game.rules);beginInitiative(game);}persist(fresh);notify();return map;
  }
  const removeHistory=id=>{if(server?.listening||generation)throw new Error('Закройте комнату перед удалением истории.');const state=getState();if(state.images.some(i=>i.roomId===id&&i.status==='queued'))throw new Error('Дождитесь завершения изображения.');deleteRoomHistory(state,id);persist(state);return status();};
  function isAdmittedRequest(req){const cookie='SASRoom-'+crypto.createHash('sha256').update(roomData().id||'').digest('hex').slice(0,12),cookies=Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim().split('=')));const token=String(req.headers['x-sas-resume']||cookies[cookie]||'');if(!/^[A-Za-z0-9_-]{43}$/.test(token))return false;const hash=crypto.createHash('sha256').update(token).digest('hex');return Object.values(roomData().playerSessions||{}).some(p=>!p.revoked&&typeof p.tokenHash==='string'&&p.tokenHash.length===64&&crypto.timingSafeEqual(Buffer.from(p.tokenHash),Buffer.from(hash)));}
  function lobby(options={}){
    requireRoom();if(generation||tasks?.publicTask?.()?.status==='running'||publicNarration(roomData(),getState())?.status==='incomplete'&&options.action!=='start')throw Object.assign(new Error('Сначала завершите ответ ведущего или текущую задачу.'),{status:409});
    const state=getState(),room=state.multiplayer;room.lobby||={enabled:false,phase:'playing'};
    if(options.action==='configure'){
      if(typeof options.enabled!=='boolean')throw new Error('Неверный переключатель лобби.');if(!options.enabled&&[...peers.values()].some(p=>p.authenticated&&p.admitted===false))throw new Error('Сначала допустите или отклоните ожидающие заявки.');room.lobby={...room.lobby,enabled:options.enabled,phase:options.enabled?'waiting':'playing'};
    }else if(options.action==='pause'){room.lobby={...room.lobby,enabled:true,phase:'waiting'};for(const p of peers.values())p.ready=false;}
    else if(options.action==='start'){
      const guests=[...peers.values()].filter(p=>p.authenticated&&p.admitted!==false);if(guests.some(p=>!p.ready))throw Object.assign(new Error('Дождитесь готовности допущенных игроков.'),{status:409});
      // The first initiative snapshot was made before guests entered the lobby.
      // Resolve ties fairly with the complete roster, once, before play starts.
      if((room.lobby.initialRosterPending||!room.lobby.startedAt&&!room.messages?.length)&&room.tactical?.version===2&&room.tactical.round===1&&!room.storybook&&!publicNarration(room,state))beginInitiative(room.tactical);
      room.lobby.phase='playing';room.lobby.startedAt||=new Date().toISOString();delete room.lobby.initialRosterPending;
    }else if(options.action==='approve'||options.action==='reject'){
      const entry=[...peers].find(([,p])=>p.authenticated&&p.id===options.playerId&&p.admitted===false);if(!entry)throw new Error('Заявка игрока не найдена.');const [socket,p]=entry;
      if(options.action==='reject'){p.authenticated=false;send(socket,{type:'kicked',error:'Хост отклонил заявку в лобби.'});socket.close(1008,'Lobby request rejected');diagnostics?.record('room_lobby',{kind:'reject'});notify();return status();}
      if(room.lobby.phase!=='waiting')throw new Error('Приостановите игру в лобби перед допуском нового игрока.');
      let restoredActor;
      if(options.actorId){restoredActor=room.tactical?.actors.find(a=>a.id===options.actorId&&a.player&&a.id!=='host'&&a.online===false);if(!restoredActor||[...peers.values()].some(other=>other!==p&&other.authenticated&&other.admitted!==false&&other.id===restoredActor.id))throw new Error('Выберите свободного отключённого героя для восстановления.');}
      const admittedId=restoredActor?.id||p.id,admittedPersona=restoredActor?{...p.persona,...room.personas?.[admittedId],id:admittedId}:p.persona;
      room.personas={...room.personas,[admittedId]:admittedPersona};if(isGame(room)){const game=room.tactical,actor=restoredActor||adventureActor(admittedId,admittedPersona,game.rules);if(game.map&&(!restoredActor||game.actors.some(a=>a.id!==actor.id&&a.online!==false&&a.hp>0&&a.x===actor.x&&a.y===actor.y))){const free=game.map.start.find(c=>!game.actors.some(a=>a.id!==actor.id&&a.online!==false&&a.hp>0&&a.x===c.x&&a.y===c.y));if(!free)throw new Error('Стартовая область заполнена.');Object.assign(actor,free);}if(!restoredActor)game.actors.push(actor);else actor.online=!p.muted;syncPlayers(game);}p.id=admittedId;p.persona=admittedPersona;
      const token=rememberPlayer(room,p.id,p.originalPersonaId);p.admitted=true;p.ready=false;persist(state);send(socket,{type:'state',selfId:p.id,admission:'approved',resumeToken:token,messages:messages().slice(-300),archiveCount:messages().length,...metadata()});diagnostics?.record('room_lobby',{kind:'approve'});notify();return status();
    }else throw new Error('Неизвестное действие лобби.');
    persist(state);diagnostics?.record('room_lobby',{kind:options.action});notify();return status();
  }
  function correct(request){requireRoom();if(generation||tasks?.publicTask?.()?.status==='running'||publicNarration(roomData(),getState())?.status==='incomplete')throw Object.assign(new Error('Завершите текущий ответ или задачу перед исправлением.'),{status:409});const state=getState(),result=correctRoom(state.multiplayer,request);persist(state);if(result.message)broadcast({type:'edit',message:result.message});notify();return {...status(),correction:result.audit};}
  async function restoreBackup(input){if(server?.listening||generation)throw new Error('Закройте комнату перед восстановлением.');const bundle=input?.backupId?await backups.read(input.backupId):input;const state=getState();restoreCampaign(state,bundle);name=state.multiplayer.name;persist(state);await backups.flush();diagnostics?.record('room_restore',{kind:state.multiplayer.mode,count:state.multiplayer.messages.length});return status();}
  const summarizeMemory=async options=>{requireRoom();if(generation)throw new Error('Дождитесь ведущего.');return roomMemory.summarize(roomData().id,options);};
  return {start,stop,status,lobby,correct,backups:()=>backups.list(),backup:id=>id?backups.read(id):backups.manual(),restoreBackup,mediaCommand:body=>{requireRoom();return media.hostCommand(body);},voiceCommand:body=>{requireRoom();return media.command({id:'host',name:hostName},body);},audio:async(req,res,target)=>{if(!await media.handleHttp(req,res,target,{authorized:true})){res.writeHead(404);res.end();}},removeHistory,generate,configure,context,editMessage,moderate,publishImage,notify,act,makeMap,summarizeMemory,dice:(sides)=>dice('host',sides),hostMessage:content=>playerMessage('host',content)};
}
