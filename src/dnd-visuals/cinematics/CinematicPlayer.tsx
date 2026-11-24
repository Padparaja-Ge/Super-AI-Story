// CinematicManager scenes: DIVINE BLESSING (critical success) and DEATH'S
// JUDGMENT (critical failure). Pre-rendered Blender video + realtime in-app
// layers (title, flash, cracks, 3D glass shards, shake) + synthesized score.
// Pure presentation: it never calls the game API, so replays are side-effect free.
import {useEffect,useRef,useState} from 'react';
import {t} from '../../i18n';
import type {DiceCinematic} from '../../../shared/dice-visual.mjs';
import {SoundBus,scoreDivineBlessing,scoreDeathsJudgment} from '../audio';
import {GlassShatter,fracture} from './glassShatter';

export interface CinematicSpec{duration:number;titleAt:number;titleOut:number;fadeOutAt:number;strikeAt?:number;impact?:{x:number;y:number};sources:{src:string;type:string}[]}
const BASE='/dnd-visuals/cinematics/';
const FALLBACK:Record<DiceCinematic,CinematicSpec>={
 'divine-blessing':{duration:4.6,titleAt:1.4,titleOut:3.9,fadeOutAt:4.0,sources:[]},
 'deaths-judgment':{duration:4.6,titleAt:2.1,titleOut:3.9,fadeOutAt:4.0,strikeAt:1.1,impact:{x:0,y:0},sources:[]},
};
type Manifest=Partial<Record<DiceCinematic,CinematicSpec>>;
let manifest:Promise<Manifest>|null=null;
export function loadCinematicManifest():Promise<Manifest>{
 return manifest??=fetch(BASE+'cinematics.json').then(r=>r.ok?r.json() as Promise<Manifest>:{}).catch(()=>({}));
}
/** Warm the decoder cache so the first critical does not stall on network/disk. */
// Chromium has no <link rel=preload as=video>; a low-priority fetch warms the HTTP cache instead.
let warmed=false;
export function preloadCinematics(){if(warmed)return;warmed=true;void loadCinematicManifest().then(m=>{for(const spec of Object.values(m)){const s=spec?.sources?.find(s=>canPlay(s.type));if(s)void fetch(BASE+s.src,{priority:'low'} as RequestInit).then(r=>r.arrayBuffer()).catch(()=>{});}});}
function canPlay(type:string){try{return !!document.createElement('video').canPlayType(type);}catch{return false;}}

export function CinematicPlayer({kind,volume,pixelRatio,shards=true,onDone}:{kind:DiceCinematic;volume:number;pixelRatio:number;shards?:boolean;onDone:()=>void}){
 const [spec,setSpec]=useState<CinematicSpec|null>(null),[phase,setPhase]=useState<'in'|'play'|'title'|'out'>('in'),[struck,setStruck]=useState(false),[videoFailed,setVideoFailed]=useState(false);
 const video=useRef<HTMLVideoElement>(null),glass=useRef<HTMLCanvasElement>(null),root=useRef<HTMLDivElement>(null),done=useRef(false);
 const doneCallback=useRef(onDone);
 const finish=useRef<(()=>void)|null>(null);
 const skip=()=>{
  if(finish.current)finish.current();
  else if(!done.current){done.current=true;doneCallback.current();}
 };
 useEffect(()=>{doneCallback.current=onDone;},[onDone]);
 useEffect(()=>{let live=true;done.current=false;setPhase('in');setStruck(false);setVideoFailed(false);void loadCinematicManifest().then(m=>{if(!live)return;const s=m[kind];setSpec(s&&s.sources?.some(x=>canPlay(x.type))?s:FALLBACK[kind]);});return()=>{live=false;};},[kind]);
 useEffect(()=>{
  if(!spec)return;
  const useVideo=spec.sources.length>0&&!videoFailed,bus=SoundBus.create(volume,.32),shatter=kind==='deaths-judgment'&&glass.current?new GlassShatter(glass.current,Math.min(pixelRatio,1.5)):null;
  let raf=0,start=performance.now(),started=false,struckNow=false,titled=false,out=false;
  const timers:number[]=[];
  const end=()=>{if(done.current)return;done.current=true;doneCallback.current();};
  const fadeOut=(fast=false)=>{if(out)return;out=true;setPhase('out');bus?.stop(fast?.2:.6);timers.push(window.setTimeout(end,fast?260:520));};
  finish.current=()=>fadeOut(true);
  const now=()=>useVideo&&video.current&&!video.current.paused?video.current.currentTime:(performance.now()-start)/1000;
  const begin=()=>{if(started)return;started=true;start=performance.now();setPhase('play');if(bus)(kind==='divine-blessing'?scoreDivineBlessing(bus,bus.ac.currentTime+.02):scoreDeathsJudgment(bus,bus.ac.currentTime+.02,spec.strikeAt??2.6));};
  const tick=()=>{
   const time=now();
   if(!titled&&time>=spec.titleAt){titled=true;setPhase('title');}
   if(!struckNow&&spec.strikeAt!=null&&time>=spec.strikeAt){struckNow=true;setStruck(true);
    timers.push(window.setTimeout(()=>shatter?.shatter(useVideo?video.current:null,spec.impact||{x:0,y:0},{shards}),140));}
   if(titled&&time>=spec.titleOut&&root.current)root.current.dataset.titleOut='1';
   if(time>=spec.fadeOutAt)fadeOut();
   if(!out)raf=requestAnimationFrame(tick);
  };
  const v=video.current;
  const onPlaying=()=>{begin();};const onError=()=>{setVideoFailed(true);};
  if(useVideo&&v){
   v.muted=true;v.currentTime=0;
   v.addEventListener('playing',onPlaying,{once:true});v.addEventListener('error',onError,{once:true});
   v.play().catch(()=>setVideoFailed(true));
   timers.push(window.setTimeout(()=>{if(!started)begin();},900));  // decoder stalled: run the layers anyway
  }else begin();
  raf=requestAnimationFrame(tick);
  timers.push(window.setTimeout(()=>fadeOut(),(spec.duration+2.5)*1000));     // hard safety net
  const onResize=()=>shatter?.resize();window.addEventListener('resize',onResize);
  return()=>{finish.current=null;cancelAnimationFrame(raf);for(const id of timers)clearTimeout(id);window.removeEventListener('resize',onResize);bus?.stop(.15);shatter?.dispose();
   if(v){v.removeEventListener('playing',onPlaying);v.removeEventListener('error',onError);v.pause();v.removeAttribute('src');for(const s of [...v.querySelectorAll('source')])s.removeAttribute('src');try{v.load();}catch{}}};
 },[spec,videoFailed]);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'||e.key===' '){e.preventDefault();skip();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 const success=kind==='divine-blessing',cracks=struck?fracture(16/9,spec?.impact||{x:0,y:0}).cracks:[];
 const useVideo=!!spec&&spec.sources.length>0&&!videoFailed;
 return <div ref={root} className={`dnd-cine ${success?'is-success':'is-failure'} phase-${phase} ${struck?'is-struck':''} ${useVideo?'has-video':'no-video'}`} role="dialog" aria-label={success?t('Критический успех'):t('Критический провал')} onClick={skip}>
  {useVideo&&<video ref={video} className="dnd-cine-video" playsInline muted preload="auto">{spec!.sources.filter(s=>canPlay(s.type)).map(s=><source key={s.src} src={BASE+s.src} type={s.type}/>)}</video>}
  {!useVideo&&<div className="dnd-cine-fallback" aria-hidden="true"/>}
  <div className="dnd-cine-vignette" aria-hidden="true"/>
  {struck&&<svg className="dnd-cine-cracks" viewBox="-1.7778 -1 3.5556 2" preserveAspectRatio="xMidYMid slice" aria-hidden="true">{cracks.map((c,i)=><path key={i} d={c.d} pathLength={1} style={{animationDelay:c.delay+'s',strokeWidth:c.width}}/>)}</svg>}
  <canvas ref={glass} className="dnd-cine-glass" aria-hidden="true"/>
  <div className="dnd-cine-flash" aria-hidden="true"/>
  <div className="dnd-cine-title" aria-live="assertive"><span className="dnd-cine-natural">{success?t('НАТУРАЛЬНАЯ 20'):t('НАТУРАЛЬНАЯ 1')}</span><span className="dnd-cine-rule"/><span className="dnd-cine-verdict">{success?t('КРИТИЧЕСКИЙ УСПЕХ'):t('КРИТИЧЕСКИЙ ПРОВАЛ')}</span></div>
  <button type="button" className="dnd-cine-skip" onClick={e=>{e.stopPropagation();skip();}}>{t('Пропустить')} <kbd>Esc</kbd></button>
 </div>;
}
