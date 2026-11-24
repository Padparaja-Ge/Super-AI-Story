// Last cinematic + replay hook, kept outside the lazily loaded 3D layer so the
// settings panel stays in the main bundle without pulling Three.js in.
import type {VisualRoll} from '../../shared/dice-visual.mjs';
let handler:((roll:VisualRoll)=>void)|null=null,last:VisualRoll|null=null;const listeners=new Set<()=>void>();
export const lastCinematic=()=>last;
export function onLastCinematicChange(l:()=>void){listeners.add(l);return()=>{listeners.delete(l);};}
export function rememberCinematic(roll:VisualRoll){last=roll;for(const l of listeners)l();}
export function setReplayHandler(h:typeof handler){handler=h;}
/** Presentation only: replays never reach the game API. */
export function replayLastCinematic(){if(last&&handler)handler(last);}
