// Presentation-only description of engine rolls for the 3D dice layer.
// The adventure engine (server) is the only source of results: this module
// never produces random numbers, it only reads `event.calculation`.

export const VISUAL_DICE_SIDES=Object.freeze([4,6,8,10,12,20,100]);
export const ROLL_EVENT_KINDS=Object.freeze(['check','attack','damage','grapple','escape','initiative-tie']);
const rollKinds=new Set(ROLL_EVENT_KINDS);
const criticalKinds=new Set(['check','attack','grapple','escape']);
const int=value=>Number.isInteger(value)?value:null;

/** "2d6", "d8", "1д20" → {count,sides}; null when not a plain dice term. */
export function parseDiceExpression(expression){
 const match=/^\s*(\d*)\s*[dд]\s*(\d+)\s*$/i.exec(String(expression||''));if(!match)return null;
 const count=match[1]?Number(match[1]):1,sides=Number(match[2]);
 return count>=1&&count<=100&&sides>=2&&sides<=1000?{count,sides}:null;
}

/** Physical dice (model + face label) that must show `value` on a die with `sides`. */
export function physicalFaces(sides,value){
 if(!int(value)||value<1||value>sides)throw new Error(`Invalid d${sides} result: ${value}`);
 if(sides===100){const v=value%100,tens=Math.floor(v/10),units=v%10;return [{model:'d10t',label:tens?`${tens}0`:'00'},{model:'d10',label:String(units)}];}
 if(sides===10)return [{model:'d10',label:String(value%10)}];
 if(VISUAL_DICE_SIDES.includes(sides))return [{model:'d'+sides,label:String(value)}];
 return [];
}
export const hasPhysicalDie=sides=>VISUAL_DICE_SIDES.includes(sides);

/** Value read from physical faces (inverse of physicalFaces, used by tests and QA). */
export function valueFromFaces(sides,faces){
 if(sides===100){const tens=faces[0].label==='00'?0:Number(faces[0].label),units=Number(faces[1].label),v=tens+units;return v===0?100:v;}
 if(sides===10){const v=Number(faces[0].label);return v===0?10:v;}
 return Number(faces[0].label);
}

function dieList(sides,rolls,kept){
 let keptIndex=kept==null?-1:rolls.indexOf(kept);
 return rolls.map((value,i)=>({sides,value,kept:kept==null||i===keptIndex}));
}

/**
 * Turns an engine log entry into a visual roll, or null when the entry carries
 * no dice. `critical` is copied from the engine: house rules that disable
 * criticals for a category already produce `critical:null` there.
 */
export function visualRollFromEvent(event){
 const c=event?.calculation;if(!c||!rollKinds.has(c.kind))return null;
 const base={id:'roll:'+event.id,eventId:event.id,kind:c.kind,actorId:c.actorId||'',targetId:c.targetId||'',attackId:c.attackId||'',title:c.skill||c.checkType||c.attribute||'',mode:c.mode||'',text:String(event.text||''),dc:int(c.dc),outcome:c.outcome||null,success:typeof c.success==='boolean'?c.success:typeof c.hit==='boolean'?c.hit:null,critical:null,naturalCritical:c.naturalCritical||null,cinematic:null};
 let dice=[],modifier=0,total=null;
 if(c.kind==='damage'){
  const parsed=parseDiceExpression(c.expression),rolls=Array.isArray(c.rolls)?c.rolls.filter(Number.isInteger):[];if(!parsed||!rolls.length)return null;
  dice=dieList(parsed.sides,rolls,null);modifier=Number(c.bonus)||0;total=(int(c.diceTotal)??rolls.reduce((a,b)=>a+b,0))+modifier;
  return {...base,dice,modifier,total,applied:int(c.applied),damageType:c.damageType||'',raw:int(c.raw)};
 }
 if(c.kind==='initiative-tie'){if(!int(c.roll))return null;dice=dieList(20,[c.roll],null);modifier=Number(c.initiative)||0;return {...base,dice,modifier,total:c.roll+modifier};}
 const sides=int(c.die)||20,rolls=(Array.isArray(c.rolls)?c.rolls:[]).filter(Number.isInteger);if(!rolls.length)return null;
 dice=dieList(sides,rolls,int(c.roll)??rolls[0]);
 modifier=(Number(c.modifier)||0)+(Number(c.bonus)||0);total=int(c.total);
 const critical=criticalKinds.has(c.kind)&&sides===20&&(c.critical==='success'||c.critical==='failure')?c.critical:null;
 return {...base,dice,modifier,total,critical,cinematic:critical==='success'?'divine-blessing':critical==='failure'?'deaths-judgment':null};
}

/** New visual rolls since the ids in `seen` (Set). Mutates `seen`. */
export function collectNewRolls(log,seen){
 const out=[];for(const event of Array.isArray(log)?log:[]){if(!event?.id||seen.has(event.id))continue;seen.add(event.id);const roll=visualRollFromEvent(event);if(roll)out.push(roll);}
 return out;
}

// ---------------------------------------------------------------------------
// Symmetry remap. A die's collision hull is invariant under its rotation group,
// so the visual mesh may be rotated by any group element without changing the
// simulated motion. We pick the element that carries the requested face onto
// the face the simulation landed on.
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const l=Math.hypot(a[0],a[1],a[2]);return [a[0]/l,a[1]/l,a[2]/l];};
function frame(a,b){const x=norm(a),z=norm(cross(x,b)),y=cross(z,x);return [x,y,z];}
// Rotation matrix (row-major 3x3) R with R·Fa[i] = Fb[i].
function between(fa,fb){const m=[[0,0,0],[0,0,0],[0,0,0]];for(let r=0;r<3;r++)for(let c=0;c<3;c++)for(let k=0;k<3;k++)m[r][c]+=fb[k][r]*fa[k][c];return m;}
export const applyMatrix=(m,v)=>[dot(m[0],v),dot(m[1],v),dot(m[2],v)];

/**
 * axes: unit vectors (one per readable face/vertex). Returns a row-major 3x3
 * rotation that maps axes[from] to axes[to] and the axis set onto itself.
 */
export function symmetryRotation(axes,from,to,tolerance=2e-3){
 if(from===to)return [[1,0,0],[0,1,0],[0,0,1]];
 const a=axes[from],b=axes[to];
 const ref=axes.map((v,i)=>({i,d:dot(v,a)})).filter(x=>x.i!==from&&x.d<0.999).sort((p,q)=>q.d-p.d)[0];
 if(!ref)throw new Error('Degenerate die axes.');
 const fa=frame(a,axes[ref.i]);
 for(let j=0;j<axes.length;j++){
  if(j===to||Math.abs(dot(axes[j],b)-ref.d)>tolerance)continue;
  const m=between(fa,frame(b,axes[j]));
  if(axes.every(v=>{const w=applyMatrix(m,v);return axes.some(u=>dot(u,w)>1-tolerance);}))return m;
 }
 throw new Error('No symmetry maps the requested face onto the landed face.');
}
