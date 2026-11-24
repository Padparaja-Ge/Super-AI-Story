// DnDVisualSettings: per-device presentation preferences. They never touch the
// game state, so they live in localStorage (graphics quality depends on the
// machine, not on the campaign). Every read is guarded: storage may be blocked.
import {useSyncExternalStore} from 'react';

export type DiceQuality='low'|'medium'|'high'|'ultra';
export interface DnDVisualSettings{
 dice3d:boolean;
 cinematics:boolean;
 volume:number;          // 0..1, dice + cinematic effects
 quality:DiceQuality;
 reduceMotion:'system'|'on'|'off';
 autoSkipCinematics:boolean;
 resultHold:number;      // seconds the result card stays after the dice settle
}
export const defaultVisualSettings:DnDVisualSettings={dice3d:true,cinematics:true,volume:.7,quality:'high',reduceMotion:'system',autoSkipCinematics:false,resultHold:2.2};
const KEY='sas.dnd.visuals.v1';
const listeners=new Set<()=>void>();
let cache:DnDVisualSettings|null=null;

function sanitize(raw:any):DnDVisualSettings{
 const v={...defaultVisualSettings};if(!raw||typeof raw!=='object')return v;
 if(typeof raw.dice3d==='boolean')v.dice3d=raw.dice3d;
 if(typeof raw.cinematics==='boolean')v.cinematics=raw.cinematics;
 if(Number.isFinite(raw.volume))v.volume=Math.min(1,Math.max(0,raw.volume));
 if(['low','medium','high','ultra'].includes(raw.quality))v.quality=raw.quality;
 if(['system','on','off'].includes(raw.reduceMotion))v.reduceMotion=raw.reduceMotion;
 if(typeof raw.autoSkipCinematics==='boolean')v.autoSkipCinematics=raw.autoSkipCinematics;
 if(Number.isFinite(raw.resultHold))v.resultHold=Math.min(8,Math.max(.8,raw.resultHold));
 return v;
}
export function getVisualSettings():DnDVisualSettings{
 if(cache)return cache;
 try{cache=sanitize(JSON.parse(localStorage.getItem(KEY)||'null'));}catch{cache={...defaultVisualSettings};}
 return cache;
}
export function setVisualSettings(patch:Partial<DnDVisualSettings>){
 cache=sanitize({...getVisualSettings(),...patch});
 try{localStorage.setItem(KEY,JSON.stringify(cache));}catch{/* storage blocked: keep in memory */}
 for(const l of listeners)l();
}
function subscribe(l:()=>void){listeners.add(l);return()=>{listeners.delete(l);};}
export function useVisualSettings(){return useSyncExternalStore(subscribe,getVisualSettings,getVisualSettings);}

export function prefersReducedMotion(s:DnDVisualSettings=getVisualSettings()){
 if(s.reduceMotion!=='system')return s.reduceMotion==='on';
 try{return window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch{return false;}
}

export interface QualityProfile{pixelRatio:number;shadows:number;transmission:boolean;bloom:boolean;antialias:boolean;maxDice:number;particles:number;envSize:number}
export function qualityProfile(q:DiceQuality):QualityProfile{
 const dpr=typeof window!=='undefined'?window.devicePixelRatio||1:1;
 switch(q){
  case 'low':return {pixelRatio:1,shadows:0,transmission:false,bloom:false,antialias:false,maxDice:6,particles:120,envSize:64};
  case 'medium':return {pixelRatio:Math.min(dpr,1.25),shadows:1024,transmission:true,bloom:false,antialias:true,maxDice:10,particles:400,envSize:128};
  case 'ultra':return {pixelRatio:Math.min(dpr,2),shadows:4096,transmission:true,bloom:true,antialias:true,maxDice:20,particles:2400,envSize:512};
  default:return {pixelRatio:Math.min(dpr,1.5),shadows:2048,transmission:true,bloom:true,antialias:true,maxDice:14,particles:1200,envSize:256};
 }
}
