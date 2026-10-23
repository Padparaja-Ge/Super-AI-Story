const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),directory=process.env.SAS_GAME_UI_QA_DIR;
assert.ok(directory);app.commandLine.appendSwitch('mute-audio');app.setPath('userData',path.join(directory,'profile'));app.on('window-all-closed',()=>{});
// Test failures belong in the captured log, never in Electron's native error
// dialog (which may play a Windows notification even for hidden windows).
process.on('uncaughtException',error=>{console.error(error.stack||error);app.exit(1);});
process.on('unhandledRejection',error=>{console.error(error?.stack||error);app.exit(1);});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await pause(40);}throw Error('Web game UI timeout');}
app.whenReady().then(async()=>{
 let room,window;const proof={};
 try{
  const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
  const {createMultiplayer}=await load('server/multiplayer.mjs'),{sanitizeState}=await load('server/store.mjs'),{defaultAbilities}=await load('shared/srp.mjs'),{createAdventureGame,adventureActor}=await load('server/adventure-engine.mjs');
  let state=sanitizeState(JSON.parse(await fs.readFile(path.join(root,'shared/seed.json'),'utf8')));
  const host={id:'host-sheet',name:'Бог',kind:'srp',className:'Воин',abilities:defaultAbilities()},guest={...host,id:'guest-sheet',name:'Лира'};
  state.personas.push(host);const game=createAdventureGame('dnd');game.actors=[adventureActor('host',host,game.rules)];game.order=['host'];game.phase='players';
  game.map={id:'map',width:8,height:8,tiles:Array(64).fill(0),doors:[],start:[{x:0,y:0},{x:2,y:2}]};
  state.multiplayer={id:'game-ui-room',name:'Таверна',mode:'dnd',personas:{host},messages:[],memory:[],summary:'',memorySettings:{autoSummary:false,vectorMemory:false},scene:{autoUpdate:false},tactical:game,storybook:{id:'book',name:'Караван',world:'Город',start:'Таверна',goal:'Найти караван',details:'',players:'2-4'}};
  room=createMultiplayer({dataDir:directory,getState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s);},getSecret:()=>'',tasks:{busy:()=>true}});const started=await room.start({port:0,personaId:host.id});
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true}});window.webContents.setAudioMuted(true);
  const run=code=>window.webContents.executeJavaScript(`{${code}\n}`),url=`http://127.0.0.1:${started.port}/play?code=${started.code}`;
  await window.loadURL(url);await run(`localStorage.setItem('sas-guest-personas',${JSON.stringify(JSON.stringify([guest]))})`);await window.loadURL(url);
  await run(`document.getElementById('name').value='GuestAccount';document.getElementById('persona').value='guest-sheet';document.getElementById('connect').click()`);
  await until(()=>run("document.getElementById('room').style.display==='block'&&!!document.querySelector('[data-game-section=initiative]')"));
  await run("document.querySelector('#game-panels [data-panel=turn]').click();for(const n of document.querySelectorAll('details[data-game-section]'))n.open=true;document.getElementById('content').value='Мой несохранённый ход';const s=document.querySelector('#game-ledger select');s.value='arcana';s.dispatchEvent(new Event('change'));window.initialCanvas=document.querySelector('#game-board canvas');");
  await room.mediaCommand({action:'settings',iceServers:[],loop:false});await pause(150);proof.canvasPreserved=await run("initialCanvas===document.querySelector('#game-board canvas')");
  state.multiplayer.tactical.round=2;state.multiplayer.tactical.actors[0].hp--;room.notify();
  await until(()=>run("document.getElementById('turn').textContent.includes('Раунд 2')"));
  proof.panelsPreserved=await run("['party','initiative','story'].every(key=>document.querySelector('[data-game-section='+key+']')?.open)");
  proof.selectionPreserved=await run("document.querySelector('#game-ledger select').value==='arcana'");proof.draftPreserved=await run("document.getElementById('content').value==='Мой несохранённый ход'");
  window.setContentSize(390,800);await pause(100);proof.mobileUsable=await run("document.getElementById('game-layout').dataset.panel==='turn'&&getComputedStyle(document.getElementById('game-ledger')).display!=='none'&&document.documentElement.scrollWidth<=innerWidth+1");
  const hero=state.multiplayer.tactical.actors.find(a=>a.id!=='host'),qaRoom={id:'check-ui-proof',tactical:structuredClone(state.multiplayer.tactical)};qaRoom.tactical.order=[hero.id,'host'];qaRoom.tactical.turn=0;qaRoom.tactical.phase='players';qaRoom.tactical.challenges=[{id:'own',name:'Скидка',actorId:hero.id,ability:'charisma',checkType:'persuasion',dc:15,intent:'Прошу снизить цену',actionId:'trade-1'},{id:'foreign',name:'Чужое задание',actorId:'host',ability:'strength',checkType:'athletics',dc:7},{id:'impossible',name:'Сдвинуть гору',ability:'strength',checkType:'athletics',dc:1000,impossible:true,impossibleReason:'Гора превышает возможности героя',actionId:'mountain-1'},{id:'closed',name:'Закрытое задание',active:false,ability:'strength',checkType:'athletics',dc:10}];
  await run(`(async()=>{window.checkUiRoom=${JSON.stringify(qaRoom)};window.checkUiActions=[];window.checkUiHero=${JSON.stringify(hero.id)};const gameModule=await import('/room-game.js');window.drawCheckUi=(self=checkUiHero,disabled=false)=>gameModule.renderGame(checkUiRoom,self,(type,body)=>checkUiActions.push({type,...body}),'qa-code',disabled);drawCheckUi();document.querySelector('#game-panels [data-panel=turn]').click();})()`);
  proof.challengeIsolation=await run("JSON.stringify(Array.from(document.querySelector('[data-adventure-checks] select').options,o=>o.value))===JSON.stringify(['own','impossible'])&&document.querySelector('[data-adventure-checks]').textContent.includes('сложность 15')");
  await run("const b=document.querySelector('[data-game-action=roll-challenge]');b.click();b.click();");proof.singleRoll=await run("checkUiActions.length===1&&checkUiActions[0].challengeId==='own'&&checkUiActions[0].action==='check'");
  await run(`checkUiRoom.tactical.log.push({id:'result',text:'Лира: критический провал, натуральная 1.',calculation:{kind:'check',actorId:checkUiHero,challengeId:'own',actionId:'trade-1',roll:1,total:1,critical:'failure',success:false}});drawCheckUi();`);proof.completedRoll=await run("document.querySelector('[data-game-action=roll-challenge]').disabled&&document.querySelector('[data-adventure-checks]').textContent.includes('критический провал')");
  await run("checkUiRoom.tactical.challenges[0].results={[checkUiHero]:checkUiRoom.tactical.log.at(-1)};checkUiRoom.tactical.log=[];checkUiRoom.tactical.eventArchive=[];drawCheckUi();");proof.resultSurvivesLogTruncation=await run("document.querySelector('[data-game-action=roll-challenge]').disabled&&document.querySelector('[data-adventure-checks]').textContent.includes('критический провал')");
  await run("const s=document.querySelector('[data-adventure-checks] select');s.value='impossible';s.dispatchEvent(new Event('change'));");proof.impossibleVisible=await run("document.querySelector('[data-adventure-checks]').textContent.includes('Гора превышает возможности героя')&&document.querySelector('[data-adventure-checks]').textContent.includes('натуральная 20')");
  await run("document.querySelector('[data-game-section=prepare-check]').open=true;const skill=document.querySelector('[data-game-section=prepare-check] select');skill.value='athletics';skill.dispatchEvent(new Event('change'));const intent=document.getElementById('game-check-intent');intent.value='Пытаюсь сдвинуть валун с дороги';intent.dispatchEvent(new Event('input'));intent.focus();intent.setSelectionRange(4,7);checkUiRoom.tactical.round++;drawCheckUi();");proof.intentPreserved=await run("document.activeElement.id==='game-check-intent'&&document.activeElement.value==='Пытаюсь сдвинуть валун с дороги'&&document.activeElement.selectionStart===4&&document.querySelector('[data-game-section=prepare-check]').open&&document.querySelector('[data-game-section=prepare-check] select').value==='athletics'");
  await run("document.querySelector('[data-game-action=prepare-check]').click();");proof.intentPayload=await run("checkUiActions.at(-1).action==='prepareCheck'&&checkUiActions.at(-1).checkType==='athletics'&&checkUiActions.at(-1).intent==='Пытаюсь сдвинуть валун с дороги'&&!('dc' in checkUiActions.at(-1))");
  await run("document.querySelector('[data-game-section=free-check] button').click()");proof.freeCheckExplicit=await run("checkUiActions.at(-1).action==='check'&&checkUiActions.at(-1).freeCheck===true&&!checkUiActions.at(-1).challengeId");
  await run("checkUiRoom.tactical.actors.find(a=>a.id===checkUiHero).online=false;drawCheckUi('host');Array.from(document.querySelectorAll('#game-ledger button')).find(b=>b.textContent==='Пропустить отсутствующего').click();");proof.offlineHostSkip=await run("checkUiActions.at(-1).action==='end'&&checkUiActions.at(-1).actorId===checkUiHero&&document.getElementById('game-ledger').textContent.includes('Незавершённый ход сохранён')");
  for(const [name,value]of Object.entries(proof))assert.equal(value,true,name);proof.success=true;
 }catch(error){proof.success=false;proof.error=error.stack;process.exitCode=1;}
 finally{if(window&&!window.isDestroyed())window.destroy();await room?.stop();await fs.writeFile(path.join(directory,'game-ui-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));app.exit(proof.success?0:1);}
});
