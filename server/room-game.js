import {editSheet} from './room-sheet.js';
import {checkSkills,pointsOf,abilityModifier,initiativeOf} from './equipment.mjs';
const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
const names={strength:'Сила',dexterity:'Ловкость',constitution:'Телосложение',intelligence:'Интеллект',wisdom:'Мудрость',charisma:'Харизма'};
let journal={query:'',round:'',count:80};
const initialSelection=()=>({check:'perception',freeCheck:'perception',skill:'',target:'',challenge:'',intent:'',checkTarget:''});
let roomScope='',panel='chat',ledgerTab='actions',selection=initialSelection();
let lastRenderKey='',expandedSections=new Map();
function renderNavigation(game,refresh){
 const navigation=document.getElementById('game-panels'),layout=document.getElementById('game-layout');
 navigation.hidden=!game;layout.dataset.panel=panel;
 for(const button of navigation.querySelectorAll('button')){
  button.classList.toggle('active',button.dataset.panel===panel);button.setAttribute('aria-pressed',String(button.dataset.panel===panel));
  button.onclick=()=>{panel=button.dataset.panel;if(panel==='log')ledgerTab='log';if(panel==='turn')ledgerTab='actions';refresh?.();};
 }
}
function renderJournal(parent,game,focus){
 const byId=new Map();[...(game.eventArchive||[]),...(game.log||[])].forEach((e,i)=>byId.set(e.id||'legacy-'+i,e));const all=[...byId.values()],ids=new Set(all.map(e=>e.id)),children=new Map();
 for(const e of all)if(e.calculation?.attackId&&ids.has(e.calculation.attackId))children.set(e.calculation.attackId,[...(children.get(e.calculation.attackId)||[]),e]);
 parent.append(el('h3','Журнал расчётов'));
 const search=el('label','Поиск по игроку, цели или действию'),input=el('input');input.id='game-journal-search';input.value=journal.query;input.placeholder='Имя, атака, урон…';search.append(input);
 const rounds=el('label','Раунд'),select=el('select');select.append(new Option('Все раунды',''));for(const n of [...new Set(all.map(e=>e.round).filter(Number.isFinite))].sort((a,b)=>b-a))select.append(new Option(String(n),String(n)));select.value=journal.round;rounds.append(select);
 const filters=el('div');filters.className='game-journal-filters';filters.append(search,rounds);const entries=el('div');entries.className='game-log';const more=el('button','Показать ещё');more.type='button';more.className='secondary';parent.append(filters,entries,more);
 const draw=()=>{const filtered=all.filter(e=>!e.calculation?.attackId||!ids.has(e.calculation.attackId)).filter(e=>(!journal.round||e.round===Number(journal.round))&&(!journal.query||[e,...(children.get(e.id)||[])].some(v=>v.text.toLowerCase().includes(journal.query.toLowerCase())))).reverse();entries.replaceChildren();
  for(const e of filtered.slice(0,journal.count)){const card=el('article');card.append(el('small','Раунд '+(e.round??'—')),el('p',e.text));for(const child of children.get(e.id)||[])card.append(el('p',child.text));entries.append(card);}if(!filtered.length)entries.append(el('p',all.length?'Нет записей по выбранным условиям.':'Здесь появятся броски, урон, эффекты и перемещения.'));more.hidden=filtered.length<=journal.count;
 };
 input.oninput=()=>{journal.query=input.value;journal.count=80;draw();};select.onchange=()=>{journal.round=select.value;journal.count=80;draw();};more.onclick=()=>{journal.count+=80;draw();};draw();if(focus){input.focus();input.setSelectionRange(...focus);}
}
export function renderGame(room,selfId,command,code,disabled){
 const layout=document.getElementById('game-layout'),ledger=document.getElementById('game-ledger'),board=document.getElementById('game-board'),game=room.tactical;
 const newRoom=roomScope!==room.id;
 if(newRoom){roomScope=room.id;panel='chat';ledgerTab='actions';selection=initialSelection();journal={query:'',round:'',count:80};lastRenderKey='';expandedSections=new Map();}
 layout.classList.toggle('tactical',!!game);ledger.hidden=board.hidden=!game;renderNavigation(game,()=>renderGame(room,selfId,command,code,disabled));if(!game)return;
 const renderKey=JSON.stringify([room.id,game,room.storybook,selfId,code,!!disabled,panel,ledgerTab,selection.challenge]);
 if(renderKey===lastRenderKey)return;
 lastRenderKey=renderKey;
 if(!newRoom)for(const section of ledger.querySelectorAll('details[data-game-section]'))expandedSections.set(section.dataset.gameSection,section.open);
 const section=key=>{const node=el('details');node.dataset.gameSection=key;node.open=expandedSections.get(key)||false;return node;};
 const actor=game.actors.find(a=>a.id===selfId),current=game.actors.find(a=>a.id===game.order[game.turn]),own=actor?.online!==false&&(game.version===2?game.phase==='players'&&current?.id===selfId:game.inCombat&&current?.id===selfId);
 const focus=document.activeElement?.id==='game-journal-search'?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:undefined;
 const intentFocus=document.activeElement?.id==='game-check-intent'?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:undefined;
 ledger.replaceChildren(el('h3',actor?.name||'Ваш ход'),el('p',game.version===2?'Раунд '+game.round+' · '+(game.phase==='gm'?'AI-ведущий':current?.name||'Ожидание'):game.inCombat?'Раунд '+game.round+' · '+(current?.name||'—'):'Вне боя'));
 if(actor){const stats=el('div');stats.className='game-resource-grid';for(const [label,value] of [['HP',actor.hp+'/'+actor.maxHp],['КД',actor.armor],['Ячейки',(actor.slots??actor.mana)+'/'+(actor.maxSlots??actor.maxMana)],['Медленное',actor.actions],['Быстрые',actor.fastActions??actor.bonusActions],['Движение',actor.move],['Инициатива',initiativeOf(actor).value]]){const box=el('span',label+' ');box.append(el('strong',String(value)));stats.append(box);}ledger.append(stats);}
 const party=section('party');party.className='game-party';party.append(el('summary','Все участники · '+game.actors.length));for(const item of game.actors){const card=el('div');card.className='actor-card';card.append(el('strong',item.name+(item.player?' · игрок':' · NPC')),el('p','HP '+item.hp+'/'+item.maxHp+' · КД '+item.armor+' · ячейки '+(item.slots??item.mana)+'/'+(item.maxSlots??item.maxMana)),el('small',(item.grappledBy?'В захвате · ':'')+(item.beam?'Удерживает луч':' ')));party.append(card);}ledger.append(party);const initiative=section('initiative');initiative.append(el('summary','Очередь инициативы'));for(const [index,id] of game.order.entries()){const a=game.actors.find(a=>a.id===id);if(a)initiative.append(el('p',(index+1)+'. '+a.name+(a.player?'':' · NPC')+' · '+(game.initiativeScores?.[id]?.value??initiativeOf(a).value)+(index===game.turn?' · текущий':index<game.turn?' · завершён':'')));}ledger.append(initiative);
 const tabs=el('nav');tabs.className='game-ledger-tabs';tabs.setAttribute('aria-label','Действия участника');for(const [id,label] of [['actions','Действия'],['inventory','Инвентарь'],['log','Расчёты']]){const button=el('button',label);button.type='button';button.classList.toggle('active',ledgerTab===id);button.setAttribute('aria-pressed',String(ledgerTab===id));button.onclick=()=>{ledgerTab=id;renderGame(room,selfId,command,code,disabled);};tabs.append(button);}ledger.append(tabs);
 const select=(label,options,key,where=ledger)=>{const wrap=el('label',label),input=el('select');for(const [id,name] of options)input.add(new Option(name,id));if(options.some(([id])=>id===selection[key]))input.value=selection[key];input.onchange=()=>{selection[key]=input.value;};selection[key]=input.value;wrap.append(input);where.append(wrap);return input;};
 const button=(label,action,blocked=false,where=ledger)=>{const control=el('button',label);control.type='button';control.disabled=disabled||blocked;control.onclick=()=>{if(!control.disabled)action();};where.append(control);return control;};
 if(current?.player&&current.online===false){const waiting=el('p','Ожидаем подключения '+current.name+'. Незавершённый ход сохранён.');waiting.setAttribute('role','status');ledger.append(waiting);if(selfId==='host')button('Пропустить отсутствующего',()=>command('game',{action:'end',actorId:current.id}));}
 if(actor&&ledgerTab==='actions'){
  const checks=el('div');checks.className='game-action-group';checks.dataset.adventureChecks='';checks.append(el('h4','Проверка действия'));ledger.append(checks);
  if(game.version===2){
   const options=[...checkSkills,...Object.entries(names).map(([key,name])=>[key,name,key])],label=type=>options.find(([id])=>id===type)?.[1]||type;
   const challenges=(game.challenges||[]).filter(c=>c.active!==false&&(!c.actorId||c.actorId===actor.id));
   if(challenges.length){
    const assigned=select('Назначенное задание',challenges.map(c=>[c.id,c.name+' · сложность '+c.dc]),'challenge',checks),challenge=challenges.find(c=>c.id===assigned.value),event=[...(game.eventArchive||[]),...(game.log||[])].findLast(e=>e.calculation?.kind==='check'&&e.calculation.challengeId===challenge.id&&e.calculation.actorId===actor.id)||challenge.results?.[actor.id],result=event?.calculation,alreadyRolled=!!result&&(result.actionId||'')===(challenge.actionId||'');
    assigned.onchange=()=>{selection.challenge=assigned.value;renderGame(room,selfId,command,code,disabled);};
    checks.append(el('p',label(challenge.checkType)+' · '+names[challenge.ability]+' · сложность '+challenge.dc+(challenge.targetId?' · цель: '+(game.actors.find(a=>a.id===challenge.targetId)?.name||challenge.targetId):'')));
    if(challenge.intent)checks.append(el('p','Намерение: '+challenge.intent));if(challenge.impossible)checks.append(el('p','Невозможно: '+challenge.impossibleReason+'. Даже натуральная 20 не меняет это ограничение.'));
    if(event){const status=el('p','Последняя попытка: '+event.text);status.setAttribute('role','status');checks.append(status);}
    const roll=button(alreadyRolled?'Проверка уже выполнена':'Бросить назначенную проверку',()=>{roll.disabled=true;command('game',{action:'check',challengeId:challenge.id});},!own||alreadyRolled,checks);roll.dataset.gameAction='roll-challenge';
    if(alreadyRolled)checks.append(el('p','Результат сохранён. Новую попытку назначает ведущий.'));
   }else checks.append(el('p','Для действия с последствиями сначала опишите намерение. Ведущий назначит сложность до броска.'));
   const prepare=section('prepare-check');prepare.append(el('summary','Подготовить проверку по намерению'));checks.append(prepare);
   const check=select('Навык или характеристика',options.map(([id,name,key])=>[id,name+' · '+abilityModifier(pointsOf(actor,key))]),'check',prepare);
   const field=el('label','Намерение'),intent=el('textarea');intent.id='game-check-intent';intent.rows=3;intent.maxLength=1200;intent.value=selection.intent;intent.placeholder='Например: прошу торговца снизить цену на меч';intent.oninput=()=>{selection.intent=intent.value;prepareButton.disabled=disabled||!own||!intent.value.trim();};field.append(intent);prepare.append(field);
   const checkTarget=select('К кому или чему относится проверка',[['','Окружение или задача без NPC'],...game.actors.filter(a=>a.id!==selfId).map(a=>[a.id,a.name])],'checkTarget',prepare);
   const prepareButton=button('Подготовить проверку',()=>{prepareButton.disabled=true;command('game',{action:'prepareCheck',checkType:check.value,intent:intent.value.trim(),...(checkTarget.value?{targetId:checkTarget.value}:{})});},!own||!selection.intent.trim(),prepare);prepareButton.dataset.gameAction='prepare-check';
   prepare.append(el('p','Это не бросок: сначала сложность и допустимость сохраняются в игровом столе. Затем выполните назначенную проверку выше.'));
   const free=section('free-check');free.append(el('summary','Свободная проверка · без привязки к действию'));checks.append(free);const ability=select('Навык свободной проверки',options.map(([id,name,key])=>[id,name+' · '+abilityModifier(pointsOf(actor,key))]),'freeCheck',free);free.append(el('p','Этот бросок не решает исход торга, атаки или другой сюжетной задачи. Для них нужна назначенная проверка.'));button('Бросить свободную проверку',()=>command('game',{action:'check',checkType:ability.value,freeCheck:true}),!own,free);
  }else{const ability=select('Характеристика',Object.entries(names),'check',checks);button('Бросить проверку',()=>command('game',{action:'check',ability:ability.value}),!own,checks);}
  const actions=el('div');actions.className='game-action-group';actions.append(el('h4','Одно медленное действие'));ledger.append(actions);
  const skills=game.version===2?actor.skills:game.rules.skills;
  const skill=select('Атака или магия',skills.map(item=>[item.id,item.name+(item.grade==='attack'?' · '+item.damage:'')+(item.kind==='magic'?' · '+item.slotCost+' яч.':'')]),'skill',actions);
  const target=select('Цель',game.actors.map(item=>[item.id,item.name]),'target',actions);
  button('Применить действие',()=>command('game',{action:'skill',skillId:skill.value,targetId:target.value}),!own||!actor.actions||!skills.length,actions);
  if(game.version===2){if(actor.grappledBy)button('Вырваться из захвата',()=>command('game',{action:'escape'}),!own||!actor.actions,actions);if(actor.beam)button('Удерживать луч',()=>command('game',{action:'channel'}),!own||!actor.actions,actions);if(!game.inCombat)button('Отдых · медленное действие',()=>command('game',{action:'rest'}),!own||!actor.actions,actions);}
  const finish=button('Завершить мой ход',()=>command('game',{action:'end'}),!own);finish.className='game-finish-turn';
  if(!own)ledger.append(el('p','Дождитесь своей очереди. Инвентарь и расчёты доступны для просмотра.'));
 }
 if(actor&&ledgerTab==='inventory'){
  if(game.version===2){
   const target=select('Цель лечения или артефакта',[[selfId,actor.name+' · на себя'],...game.actors.filter(item=>item.id!==selfId).map(item=>[item.id,item.name])],'target');
   ledger.append(el('p',game.inCombat?'Экипировка тратит '+(game.rules.equipFastCost??1)+' быстрых действий.':'Вне боя экипировку можно менять свободно.'));
   const inventory=el('div');inventory.className='game-inventory';ledger.append(inventory);
   for(const item of actor.inventory){const card=el('div');card.className='actor-card';card.append(el('strong',item.name+' ×'+item.quantity),el('p',(item.equipped?'Экипировано':item.artifact?.kind==='passive'?'Пассивный эффект':'В рюкзаке')+(item.weapon?' · '+item.weapon.damage:'')));inventory.append(card);
    if(item.weapon||item.armor||Object.keys(item.buffs||{}).length)button(item.equipped?'Снять':'Экипировать',()=>command('game',{action:'equip',itemId:item.id,equipped:!item.equipped}),!item.quantity||game.inCombat&&(!own||!actor.fastActions),card);
    if(item.consumable||item.artifact?.kind==='active')button('Использовать '+item.name,()=>command('game',{action:'useItem',itemId:item.id,targetId:item.consumable?.effect==='bandage'||item.artifact?.kind==='active'?target.value||selfId:selfId}),!own||!item.quantity||(item.consumable?.effect==='bandage'||item.artifact?.kind==='active'?!actor.actions:game.inCombat&&!actor.fastActions),card);
   }
   if(!actor.inventory.length)inventory.append(el('p','Рюкзак пуст. Предметы можно добавить в листе игрока.'));
   button('Лист игрока · инвентарь и магия',()=>editSheet(actor,data=>command('game',data)),game.inCombat);
   button('Экспорт листа игрока',()=>{const blob=new Blob([JSON.stringify({persona:{...actor,kind:'srp'}},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download='srp-player.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  }else ledger.append(el('p','Эта история использует старый игровой стол. Снаряжение задаётся в листе игрока.'));
 }
 if(ledgerTab==='log'){if(panel==='log')ledger.replaceChildren();renderJournal(ledger,game,focus);}
 if(room.storybook){const story=section('story');story.append(el('summary','Приключение · Story book · '+room.storybook.name));for(const [key,label] of [['world','Мир'],['start','Начало'],['goal','Цель'],['details','Дополнительно']]){story.append(el('strong',label),el('p',room.storybook[key]||''));}ledger.append(story);}
 if(intentFocus){const input=document.getElementById('game-check-intent');if(input){input.focus();input.setSelectionRange(...intentFocus);}}
 board.replaceChildren(el('h3',game.map?.title||'Карта ещё не создана'));const map=game.map;if(!map){board.append(el('p','Хост создаёт карту по контексту сцены. До этого можно продолжать историю в чате.'));return;}
 const canvas=el('canvas');canvas.width=map.width*24;canvas.height=map.height*24;canvas.setAttribute('aria-label','Карта боя. Нажмите клетку для перемещения.');board.append(canvas,el('p','Нажмите свободную клетку, чтобы переместиться, или дверь, чтобы открыть её.'));const ctx=canvas.getContext('2d');
 const draw=image=>{ctx.fillStyle='#a29279';ctx.fillRect(0,0,canvas.width,canvas.height);if(image)ctx.drawImage(image,0,0,canvas.width,canvas.height);ctx.fillStyle='#000000';map.tiles.forEach((wall,index)=>{if(wall)ctx.fillRect(index%map.width*24,Math.floor(index/map.width)*24,24,24);});for(const door of map.doors||[]){ctx.fillStyle=door.open?'#8aca98':'#b87538';ctx.fillRect(door.x*24,door.y*24,24,24);}ctx.strokeStyle='#2225';ctx.lineWidth=1;for(let x=0;x<=map.width;x++){ctx.beginPath();ctx.moveTo(x*24,0);ctx.lineTo(x*24,canvas.height);ctx.stroke();}for(let y=0;y<=map.height;y++){ctx.beginPath();ctx.moveTo(0,y*24);ctx.lineTo(canvas.width,y*24);ctx.stroke();}for(const item of game.actors){ctx.fillStyle=item.player?'#75c5ad':'#dc8d93';ctx.beginPath();ctx.arc(item.x*24+12,item.y*24+12,10,0,Math.PI*2);ctx.fill();ctx.fillStyle='#111';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.fillText(item.name.slice(0,1),item.x*24+12,item.y*24+16);}};
 draw();if(map.imageId){const image=new Image();image.onload=()=>{if(canvas.isConnected)draw(image);};image.src='/media/'+encodeURIComponent(map.imageId)+'/0?code='+encodeURIComponent(code);}
 canvas.onclick=event=>{if(disabled)return;const rect=canvas.getBoundingClientRect();const x=Math.floor((event.clientX-rect.left)/rect.width*map.width),y=Math.floor((event.clientY-rect.top)/rect.height*map.height),door=map.doors?.find(item=>item.x===x&&item.y===y&&!item.open);command('game',door?{action:'door',doorId:door.id}:{action:'move',x,y});};
}
