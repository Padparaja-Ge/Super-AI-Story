// DiceResultController: watches the authoritative engine log, queues new rolls
// and presents them (3D dice -> result card -> optional cinematic). It only
// reads game state; replays never call the API, so effects are never re-applied.
import {useCallback,useEffect,useRef,useState} from 'react';
import {t} from '../i18n';
import {collectNewRolls,hasPhysicalDie,type VisualRoll} from '../../shared/dice-visual.mjs';
import {checkSkills} from '../../shared/equipment.mjs';
import {abilityNames} from '../../shared/srp.mjs';
import {getVisualSettings,useVisualSettings,qualityProfile,prefersReducedMotion} from './settings';
import {SoundBus,diceClack,resultChime} from './audio';
import {CinematicPlayer,preloadCinematics} from './cinematics/CinematicPlayer';
import type {DiceStage} from './DiceStage';
import {rememberCinematic,setReplayHandler} from './replay';
import './dnd-visuals.css';

type Stage=DiceStage;
const kindLabel:Record<string,string>={attack:'Атака',damage:'Урон',check:'Проверка',grapple:'Захват',escape:'Освобождение','initiative-tie':'Инициатива'};
export function rollTitle(roll:VisualRoll){
 const extra=checkSkills.find(([key]:any)=>key===roll.title)?.[1]||(abilityNames as any)[roll.title]||roll.title;
 return [t(kindLabel[roll.kind]||'Бросок'),extra&&extra!==roll.kind?extra:''].filter(Boolean).join(' · ');
}
const sign=(n:number)=>n<0?' − '+Math.abs(n):' + '+n;


export function ResultCard({roll,onClose}:{roll:VisualRoll;onClose?:()=>void}){
 const tone=roll.critical==='success'?'crit-success':roll.critical==='failure'?'crit-failure':roll.success===true?'success':roll.success===false?'failure':'neutral';
 const verdict=roll.outcome==='impossible'?t('Невозможно'):roll.critical==='success'?t('Критический успех'):roll.critical==='failure'?t('Критический провал'):roll.kind==='attack'?(roll.success?t('Попадание'):t('Промах')):roll.kind==='damage'?(roll.applied!=null?t('Потеря HP ')+roll.applied:''):roll.success==null?'':roll.success?t('Успех'):t('Провал');
 const kept=roll.dice.filter(d=>d.kept),sum=kept.reduce((a,d)=>a+d.value,0);
 return <div className={'dnd-result-card '+tone} role="status" aria-live="polite" onClick={onClose}>
  <div className="dnd-result-head"><span>{rollTitle(roll)}</span>{roll.mode&&roll.mode!=='обычно'&&<em>{roll.mode}</em>}</div>
  <div className="dnd-result-dice">{roll.dice.map((d,i)=><span key={i} className={'dnd-chip '+(d.kept?'':'dropped')} title={'d'+d.sides}><small>d{d.sides}</small>{d.value}</span>)}</div>
  <div className="dnd-result-math"><span>{kept.length>1?kept.map(d=>d.value).join(' + ')+' = '+sum:sum}{roll.modifier?sign(roll.modifier):''}</span><strong>{roll.total??sum}</strong>{roll.dc!=null&&<span className="muted">{roll.kind==='attack'?t('против КД '):t('против сложности ')}{roll.dc}</span>}</div>
  {verdict&&<div className="dnd-result-verdict">{verdict}</div>}
 </div>;
}

interface Presenting{roll:VisualRoll;phase:'rolling'|'result'|'cinematic';queue:number}
export default DnDVisualLayer;
export function DnDVisualLayer({game,roomKey}:{game:any;roomKey:string}){
 const settings=useVisualSettings();
 const seen=useRef<Set<string>|null>(null),queue=useRef<VisualRoll[]>([]),busy=useRef(false),stageRef=useRef<Stage|null>(null),stageQuality=useRef('');
 const canvasRef=useRef<HTMLCanvasElement>(null),abort=useRef<AbortController|null>(null),cinematicDone=useRef<(()=>void)|null>(null),resultDone=useRef<(()=>void)|null>(null);
 const [show,setShow]=useState<Presenting|null>(null),[cinematic,setCinematic]=useState<VisualRoll|null>(null),[stageVisible,setStageVisible]=useState(false),[fallback2d,setFallback2d]=useState(false);
 const log=game?.log;

 // History present when the room opens is never animated.
 useEffect(()=>{seen.current=new Set([...(game?.eventArchive||[]),...(game?.log||[])].map((e:any)=>e?.id).filter(Boolean));queue.current=[];return()=>{queue.current=[];abort.current?.abort();cinematicDone.current?.();resultDone.current?.();};},[roomKey]);
 useEffect(()=>{if(getVisualSettings().cinematics)preloadCinematics();},[roomKey]);
 useEffect(()=>()=>{stageRef.current?.dispose();stageRef.current=null;},[]);

 const ensureStage=useCallback(async()=>{
  const s=getVisualSettings();if(!canvasRef.current)return null;
  if(stageRef.current&&stageQuality.current!==s.quality){stageRef.current.dispose();stageRef.current=null;}
  if(!stageRef.current){
   const canvas=canvasRef.current;if(!canvas)return null;
   const {DiceStage}=await import('./DiceStage');
   const stage=await DiceStage.create(canvas,qualityProfile(s.quality));
   if(canvas!==canvasRef.current||!canvas.isConnected){stage.dispose();return null;}
   stageRef.current=stage;stageQuality.current=s.quality;
   (window as any).__diceStageInfo=()=>stageRef.current?.info();   // QA hook (Animation/lab)
  }
  stageRef.current.resize();return stageRef.current;
 },[]);

 const waitResult=(seconds:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
  if(signal.aborted){resolve();return;}
  const id=window.setTimeout(done,seconds*1000);
  function done(){clearTimeout(id);resultDone.current=null;signal.removeEventListener('abort',done);resolve();}
  resultDone.current=done;signal.addEventListener('abort',done,{once:true});
 });
 const playCinematic=(roll:VisualRoll,signal:AbortSignal)=>new Promise<void>(resolve=>{
  if(signal.aborted){resolve();return;}
  const done=()=>{
   cinematicDone.current=null;signal.removeEventListener('abort',done);setCinematic(null);resolve();
  };
  cinematicDone.current=done;signal.addEventListener('abort',done,{once:true});setCinematic(roll);
 });

 const present=useCallback(async(roll:VisualRoll,replay=false)=>{
  const s=getVisualSettings(),reduced=prefersReducedMotion(s),ctrl=new AbortController();abort.current=ctrl;
  const wantCinematic=!!roll.cinematic&&s.cinematics&&!s.autoSkipCinematics&&!reduced;
  setShow({roll,phase:'rolling',queue:queue.current.length});
  let dice:any[]=[];
  const physical=s.dice3d&&roll.dice.some(d=>hasPhysicalDie(d.sides))&&!document.hidden;
  if(physical){
   try{
    const stage=await ensureStage();
    if(stage&&!ctrl.signal.aborted){setStageVisible(true);setFallback2d(false);
     const bus=SoundBus.create(s.volume,.12);
     ctrl.signal.addEventListener('abort',()=>bus?.stop(.05),{once:true});
     dice=await stage.play(roll,{signal:ctrl.signal,onContact:(st,withDie)=>diceClack(bus,st,withDie)},reduced||replay);
     if(!wantCinematic&&!ctrl.signal.aborted)resultChime(bus,roll.success);
     if(wantCinematic){const d20=dice.find(d=>d.kept&&d.sides===20)||dice.find(d=>d.sides===20);await stage.omen(roll.cinematic==='divine-blessing'?'success':'failure',d20,replay?1:1.5,ctrl.signal);}
     setTimeout(()=>bus?.stop(.3),1500);
    }
   }catch(error){console.warn('[dice] 3D presentation unavailable, using the result card only.',error);setFallback2d(true);}
  }
  if(roll.cinematic){rememberCinematic(roll);if(wantCinematic&&!ctrl.signal.aborted){setShow({roll,phase:'cinematic',queue:queue.current.length});await playCinematic(roll,ctrl.signal);}}
  if(ctrl.signal.aborted)return;
  setShow({roll,phase:'result',queue:queue.current.length});
  await waitResult(replay||ctrl.signal.aborted?Math.min(1.2,s.resultHold):s.resultHold,ctrl.signal);
  stageRef.current?.stopRendering();
 },[ensureStage]);

 const pump=useCallback(async()=>{
  if(busy.current)return;busy.current=true;
  try{while(queue.current.length){const roll=queue.current.shift()!;await present(roll);}}
  finally{busy.current=false;setShow(null);setStageVisible(false);stageRef.current?.clear();}
 },[present]);

 useEffect(()=>{
  if(!seen.current||!Array.isArray(log))return;
  const fresh=collectNewRolls(log,seen.current);if(!fresh.length)return;
  if(document.hidden){return;}              // background tab: the log keeps the record, no backlog of animations
  queue.current=[...queue.current,...fresh].slice(-6);
  setShow(current=>current?{...current,queue:queue.current.length}:current);
  void pump();
 },[log,pump]);

 useEffect(()=>{setReplayHandler(roll=>{if(busy.current)return;busy.current=true;void present(roll,true).finally(()=>{busy.current=false;setShow(null);setStageVisible(false);stageRef.current?.clear();void pump();});});return()=>setReplayHandler(null);},[present,pump]);
 // Settings change (quality) takes effect on the next roll; turning 3D off releases the GPU now.
 useEffect(()=>{if(!settings.dice3d&&stageRef.current&&!busy.current){stageRef.current.dispose();stageRef.current=null;}},[settings.dice3d]);
 useEffect(()=>{const r=()=>stageRef.current?.resize();window.addEventListener('resize',r);return()=>window.removeEventListener('resize',r);},[]);

 const skip=(all=false)=>{if(all)queue.current=[];if(cinematicDone.current){cinematicDone.current();return;}abort.current?.abort();resultDone.current?.();};
 useEffect(()=>{if(!show||cinematic)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();skip(e.shiftKey);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[show,cinematic]);

 const active=!!show;
 return <div className={'dnd-visual-layer'+(active?' is-active':'')+(stageVisible&&!fallback2d?' has-stage':'')} aria-hidden={!active}>
  <div className="dnd-dice-backdrop" onClick={()=>show?.phase==='result'&&skip()}/>
  <canvas ref={canvasRef} className="dnd-dice-canvas"/>
  {show&&show.phase==='result'&&<div className="dnd-result-anchor"><ResultCard roll={show.roll} onClose={()=>skip()}/></div>}
  {show&&show.phase==='rolling'&&<div className="dnd-roll-caption">{rollTitle(show.roll)}</div>}
  {show&&!cinematic&&<div className="dnd-dice-actions"><button type="button" onClick={()=>skip()}>{t('Пропустить')} <kbd>Esc</kbd></button>{show.queue>0&&<button type="button" onClick={()=>skip(true)}>{t('Пропустить все · ')}{show.queue+1}</button>}</div>}
  {cinematic?.cinematic&&<CinematicPlayer kind={cinematic.cinematic} volume={settings.volume} pixelRatio={qualityProfile(settings.quality).pixelRatio} shards={settings.quality!=='low'} onDone={()=>cinematicDone.current?.()}/>}
 </div>;
}
