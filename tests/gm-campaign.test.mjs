import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {WebSocket} from 'ws';
import {gmProfiles, normalizeGmSettings} from '../shared/gm-profile.mjs';
import {startServer} from '../server/index.mjs';
import {campaignBundle} from '../server/room-backups.mjs';
import {defaultAbilities} from '../shared/srp.mjs';
import {gmProfileInstruction, validateGmSettings, confirmCampaignDeath, assertCampaignPlayable} from '../server/gm-campaign.mjs';

test('GM profiles retain the default and give distinct narrative advice without changing dice', () => {
  assert.deepEqual(normalizeGmSettings({profile:'invalid'}), {profile:'standard',deathPolicy:'classic'});
  assert.equal(gmProfileInstruction({}), '');
  assert.throws(() => validateGmSettings({profile:'invalid'}), /существующий стиль/);
  const variants = Object.keys(gmProfiles).slice(1).map(profile => gmProfileInstruction({gmSettings:{profile}}));
  assert.equal(new Set(variants).size, 3);
  assert.match(variants[0], /укрытие, путь, свидетель/);
  assert.match(variants[1], /без бонусных улик/);
  assert.match(variants[2], /реакцию вовлечённого NPC/);
  assert.match(variants[0], /критическом успехе в рискованной сцене/);
  assert.match(variants[1], /успешно искал подтверждённую улику/);
  assert.match(variants[2], /слова, решения и чувства оставь игроку/);
  for (const text of variants) {
    assert.match(text, /исход только к намерению, с которым связан бросок/);
    assert.match(text, /Старые броски из памяти описывают прошлое/);
    assert.match(text, /невозможное действие остаётся невозможным/);
    assert.match(text, /ресурсы, награды и состояние меняет только движок/);
  }
});

test('Death requires an eligible fallen hero, and the terminal policy ends the campaign', () => {
  const room = {tactical:{round:3}};
  const hero = {id:'hero', personaId:'hero-persona', name:'Рейн', hp:0, player:true};
  assert.throws(() => confirmCampaignDeath(room, hero), /обычное поражение/);
  room.gmSettings = {deathPolicy:'end'};
  assert.throws(() => confirmCampaignDeath(room, {...hero, hp:1}), /выведенного из боя/);
  confirmCampaignDeath(room, hero);
  assert.equal(hero.turnUnavailable, true);
  assert.equal(room.campaign.deaths[0].name,'Рейн');
  assert.deepEqual(room.campaign.deadPersonaIds,['hero-persona']);
  assert.equal(room.campaign.phase,'ended');
  assert.throws(() => confirmCampaignDeath(room, hero), /выведенного из боя/);
  assert.throws(() => assertCampaignPlayable(room), /Кампания завершена/);
});

test('D&D journal persists offers, alternatives, downtime and replacements without leaking private plans', async t => {
  const calls = [];
  let malformedPlan = false;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'sas-gm-campaign-'));
  const provider = http.createServer(async (req,res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const name = body.response_format?.json_schema?.name;
    const result = name === 'sas_quest_offer'
      ? {title:'Маяк', hook:'Смотритель просит передать письмо.', goal:'Доставить письмо хранителю.'}
      : malformedPlan ? {} : {objective:'Доставить письмо.', twists:['SECRET_CARETAKER'], alternatives:['Если пропущен маяк, встретить лодочника.'], npcTies:['Хранитель задолжал смотрителю.']};
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const packet = JSON.stringify({choices:[{delta:{content:JSON.stringify(result)},finish_reason:'stop'}]});
    res.end('data: '+packet+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  const runtime = await startServer({port:0,dataDir:dir});
  t.after(async () => {
    await runtime.close();
    await new Promise(resolve => {provider.close(resolve);provider.closeAllConnections();});
    await fs.rm(dir,{recursive:true,force:true});
  });
  const app = runtime.app.locals.runtime;
  const api = async (route,body={}) => {
    const response = await fetch('http://127.0.0.1:'+runtime.port+'/api/multiplayer/'+route,{
      method:route==='settings'?'PUT':'POST', headers:{'Content-Type':'application/json','X-SAS-Client':'test'}, body:JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  const state = app.store.getState(), connection = state.connections[0];
  connection.baseUrl = 'http://127.0.0.1:'+provider.address().port+'/v1';
  connection.model = 'test';
  const abilities = defaultAbilities(), hero = {id:'campaign-hero',name:'Рейн',kind:'srp',className:'Следопыт',level:1,abilities,spells:[],inventory:[]};
  const replacement = {...hero,id:'replacement-hero',name:'Тора'};
  const thirdHero = {...hero,id:'third-hero',name:'Элли'};
  state.personas.push(hero,replacement,thirdHero);
  state.storybooks.push({id:'campaign-book',kind:'adventure',name:'Берег',world:'Остров',start:'Порт',goal:'Восстановить маяк',details:'Давно пропали корабли.',playerCount:'2-4'});
  state.lorebooks.push({id:'campaign-lore',name:'Берег',enabled:true,entries:[{id:'lighthouse',name:'Маяк',
    content:'У маяка смотритель хранит письма. Свидетель лодочник помнит поздний рейс. MEMORY_GM_MARKER',enabled:true}]});
  app.store.saveState(state);
  const started = await api('start',{mode:'dnd',port:0,personaId:hero.id,newHistory:true,lobby:true,connectionId:connection.id,
    lorebookIds:['campaign-lore'],memorySettings:{vectorMemory:true,archiveMemory:true},adventure:{kind:'book',bookId:'campaign-book'},gmSettings:{profile:'mira-rostova',deathPolicy:'replace'}});
  assert.equal(started.room.gmSettings.profile,'mira-rostova');
  assert.equal(started.room.campaign.phase,'story');
  await assert.rejects(api('campaign',{action:'accept',questId:'missing'}),/не найдено/);
  assert.equal(calls.length,0);
  await api('campaign',{action:'downtime'});
  await assert.rejects(api('campaign',{action:'offer'}),/Завершите передышку/);
  assert.equal(calls.length,0);
  await api('campaign',{action:'resume'});
  const offered = await api('campaign',{action:'offer'});
  const {id} = offered.room.campaign.quests[0];
  assert.equal(offered.room.campaign.quests[0].status,'offered');
  assert.match(JSON.stringify(calls[0].messages),/Восстановить маяк/);
  assert.match(JSON.stringify(calls[0].messages),/MEMORY_GM_MARKER/);
  await assert.rejects(api('campaign',{action:'offer'}),/текущую зацепку/);
  assert.equal(calls.length,1);
  malformedPlan = true;
  await assert.rejects(api('campaign',{action:'accept',questId:id}), /дважды нарушила формат/);
  assert.equal(app.multiplayer.status().room.campaign.quests[0].status,'offered');
  malformedPlan = false;
  const active = await api('campaign',{action:'accept',questId:id});
  assert.equal(active.room.campaign.quests[0].status,'active');
  assert.equal(active.questPlans[0].twists[0],'SECRET_CARETAKER');
  assert.match(JSON.stringify(calls.at(-1).messages),/MEMORY_GM_MARKER/);
  assert.match(active.questPlans[0].alternatives[0],/лодочника/);
  assert.ok(!JSON.stringify(active.room).includes('SECRET_CARETAKER'));
  assert.match(app.multiplayer.context().priorityInstructions,/Мира Ростова[\s\S]*SECRET_CARETAKER/);
  const guest = new WebSocket('ws://127.0.0.1:'+started.port+'/ws');
  t.after(() => guest.terminate());
  await once(guest,'open');
  const received = once(guest,'message');
  guest.send(JSON.stringify({type:'join',code:started.code,name:'Связной',persona:{...hero,id:'guest-hero',name:'Связной'}}));
  const [snapshot] = await received;
  assert.ok(!String(snapshot).includes('SECRET_CARETAKER'));
  const progress = await api('campaign',{action:'progress',questId:id,note:'Лодочник согласился помочь.'});
  assert.deepEqual(progress.room.campaign.quests[0].progress,['Лодочник согласился помочь.']);
  await api('campaign',{action:'complete',questId:id});
  const other = await api('campaign',{action:'offer'});
  const pending = other.room.campaign.quests.find(quest => quest.status==='offered');
  const declined = await api('campaign',{action:'decline',questId:pending.id});
  assert.equal(declined.room.campaign.quests.at(-1).status,'declined');
  await assert.rejects(api('campaign',{action:'death',actorId:'host'}),/выведенного из боя/);
  const injured = app.store.getState();
  const injuredHero = injured.multiplayer.tactical.actors.find(actor=>actor.id==='host');
  injuredHero.hp = 0;
  injuredHero.level = 4;
  injuredHero.abilities.strength = 13;
  app.store.saveState(injured);
  await api('campaign',{action:'death',actorId:'host'});
  const savedAfterDeath = campaignBundle(app.store.getState());
  await api('settings',{rules:{hp:23}});
  assert.equal(app.store.getState().multiplayer.tactical.actors.find(actor=>actor.id==='host').hp,0);
  const recovered = await api('campaign',{action:'replace',actorId:'host',personaId:replacement.id});
  assert.equal(recovered.hostPersonaId,replacement.id);
  assert.deepEqual(recovered.room.campaign.deaths.map(({name})=>name),[hero.name]);
  assert.equal(app.store.getState().multiplayer.tactical.actors.find(actor=>actor.id==='host').name,replacement.name);
  await api('stop');
  await assert.rejects(api('start',{mode:'dnd',port:0,personaId:hero.id,lobby:true,connectionId:connection.id}),/Гибель этого героя уже подтверждена/);
  const reopened = await api('start',{mode:'dnd',port:0,personaId:replacement.id,lobby:true,connectionId:connection.id});
  assert.equal(reopened.room.campaign.quests[0].status,'completed');
  assert.equal(reopened.room.gmSettings.profile,'mira-rostova');
  assert.deepEqual(reopened.questPlans[0].twists,['SECRET_CARETAKER']);
  const secondInjury = app.store.getState();
  secondInjury.multiplayer.tactical.actors.find(actor=>actor.id==='host').hp = 0;
  app.store.saveState(secondInjury);
  const fallen = await api('campaign',{action:'death',actorId:'host'});
  assert.deepEqual(fallen.deadPersonaIds,[hero.id,replacement.id]);
  assert.equal('deadPersonaIds' in fallen.room.campaign,false);
  assert.deepEqual(fallen.room.campaign.deaths.map(entry=>Object.keys(entry).sort()),[['name','round'],['name','round']]);
  await assert.rejects(api('campaign',{action:'replace',actorId:'host',personaId:hero.id}),/Гибель этого героя уже подтверждена/);
  const continued = await api('campaign',{action:'replace',actorId:'host',personaId:thirdHero.id});
  assert.equal(continued.hostPersonaId,thirdHero.id);
  // Simulate importing the backup on another installation without the host sheet.
  await api('stop');
  const cleanStudio = app.store.getState();
  cleanStudio.personas = cleanStudio.personas.filter(persona => persona.id !== hero.id);
  app.store.saveState(cleanStudio);
  const restored = await api('restore',savedAfterDeath);
  const recoveredHost = app.store.getState().personas.find(persona=>persona.id===hero.id);
  assert.equal(recoveredHost?.name,hero.name);
  assert.equal(recoveredHost.level,4);
  assert.equal(recoveredHost.abilities.strength,13);
  await api('start',{mode:'dnd',port:0,personaId:hero.id,historyId:restored.room.id,connectionId:connection.id});
  const resumed = await api('campaign',{action:'replace',actorId:'host',personaId:replacement.id});
  assert.equal(resumed.hostPersonaId,replacement.id);
  assert.deepEqual(resumed.deadPersonaIds,[hero.id]);
  assert.equal(calls.length,5);
});
