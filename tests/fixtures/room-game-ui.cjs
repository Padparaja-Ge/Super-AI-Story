const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),directory=process.env.SAS_GAME_UI_QA_DIR;
assert.ok(directory);app.commandLine.appendSwitch('mute-audio');app.setPath('userData',path.join(directory,'profile'));app.on('window-all-closed',()=>{});
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
  const run=code=>window.webContents.executeJavaScript(code),url=`http://127.0.0.1:${started.port}/play?code=${started.code}`;
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
  for(const [name,value]of Object.entries(proof))assert.equal(value,true,name);proof.success=true;
 }catch(error){proof.success=false;proof.error=error.stack;process.exitCode=1;}
 finally{if(window&&!window.isDestroyed())window.destroy();await room?.stop();await fs.writeFile(path.join(directory,'game-ui-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));app.exit(proof.success?0:1);}
});
