// DicePhysics: Rapier rigid-body pre-simulation.
// The throw is simulated to rest *before* anything is shown, then played back
// frame by frame. The motion is therefore real physics, while the face that
// ends up on top is chosen by the engine result through a symmetry remap of
// the visual mesh (see shared/dice-visual.mjs). Nothing here decides a value.
import type RAPIERType from '@dimforge/rapier3d-compat';

let rapier:Promise<typeof RAPIERType>|null=null;
export function loadRapier(){
 return rapier??=import('@dimforge/rapier3d-compat').then(async mod=>{const R=(mod as any).default||mod;await R.init();return R as typeof RAPIERType;});
}

export interface PhysicsDie{hull:Float32Array;radius:number;axes:number[][]}
export interface Arena{halfWidth:number;halfDepth:number}
export interface ThrowTrack{
 hz:number;frameCount:number;
 frames:Float32Array[];          // per die: [x,y,z,qx,qy,qz,qw] * frameCount
 landedAxis:number[];            // per die: index into axes that ends up on top
 settledFrame:number;
 contacts:{frame:number;die:number;strength:number;withDie:boolean}[];
 attempts:number;clean:boolean;
}

function mulberry32(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function randomQuat(rand:()=>number){const u1=rand(),u2=rand()*Math.PI*2,u3=rand()*Math.PI*2,a=Math.sqrt(1-u1),b=Math.sqrt(u1);return {x:a*Math.sin(u2),y:a*Math.cos(u2),z:b*Math.sin(u3),w:b*Math.cos(u3)};}
function rotate(q:{x:number;y:number;z:number;w:number},v:number[]){
 const {x,y,z,w}=q,ix=w*v[0]+y*v[2]-z*v[1],iy=w*v[1]+z*v[0]-x*v[2],iz=w*v[2]+x*v[1]-y*v[0],iw=-x*v[0]-y*v[1]-z*v[2];
 return [ix*w+iw*-x+iy*-z-iz*-y,iy*w+iw*-y+iz*-x-ix*-z,iz*w+iw*-z+ix*-y-iy*-x];
}
export function topAxis(q:{x:number;y:number;z:number;w:number},axes:number[][]){
 let best=-1,bestDot=-2;for(let i=0;i<axes.length;i++){const d=rotate(q,axes[i])[1];if(d>bestDot){bestDot=d;best=i;}}return {index:best,dot:bestDot};
}

export async function simulateThrow(dice:PhysicsDie[],arena:Arena,{seed=(Math.random()*2**31)|0,maxSeconds=7,maxAttempts=8}={}):Promise<ThrowTrack>{
 const R=await loadRapier();
 let best:ThrowTrack|null=null;
 for(let attempt=1;attempt<=maxAttempts;attempt++){
  const track=runOnce(R,dice,arena,seed+attempt*7919,maxSeconds);track.attempts=attempt;
  if(track.clean)return track;
  if(!best)best=track;
 }
 return best!;
}

function runOnce(R:typeof RAPIERType,dice:PhysicsDie[],arena:Arena,seed:number,maxSeconds:number):ThrowTrack{
 const rand=mulberry32(seed),hz=60,sub=2,world=new R.World({x:0,y:-48,z:0}),events=new R.EventQueue(true);
 world.timestep=1/(hz*sub);
 try{
  const {halfWidth:W,halfDepth:D}=arena,wall=0.5,H=8;
  const fixed=(hx:number,hy:number,hz2:number,x:number,y:number,z:number,friction=.55,rest=.3)=>world.createCollider(R.ColliderDesc.cuboid(hx,hy,hz2).setTranslation(x,y,z).setFriction(friction).setRestitution(rest));
  fixed(W+2,wall,D+2,0,-wall,0,.6,.28);
  fixed(wall,H,D+2,-W-wall,H,0,.2,.45);fixed(wall,H,D+2,W+wall,H,0,.2,.45);
  fixed(W+2,H,wall,0,H,-D-wall,.2,.45);fixed(W+2,H,wall,0,H,D+wall,.2,.45);
  const fromLeft=rand()<.5,dir=fromLeft?1:-1,bodies:RAPIERType.RigidBody[]=[],colliderDie=new Map<number,number>();
  dice.forEach((die,i)=>{
   const spread=Math.min(D*.75,0.9+dice.length*.25);
   const x=-dir*(W-1.6-rand()*1.2),y=3.2+rand()*2.2+i*.35,z=(rand()*2-1)*spread;
   const desc=R.RigidBodyDesc.dynamic().setTranslation(x,y,z).setRotation(randomQuat(rand))
    .setLinvel(dir*(9+rand()*6),-(1+rand()*3),(rand()*2-1)*3-z*.6)
    .setAngvel({x:(rand()*2-1)*24,y:(rand()*2-1)*18,z:(rand()*2-1)*24})
    .setLinearDamping(.12).setAngularDamping(.35).setCcdEnabled(true).setCanSleep(true);
   const body=world.createRigidBody(desc);
   const cd=R.ColliderDesc.convexHull(die.hull);if(!cd)throw new Error('Convex hull failed for die '+i);
   cd.setDensity(1).setFriction(.42).setRestitution(.32).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(40);
   const collider=world.createCollider(cd,body);colliderDie.set(collider.handle,i);bodies.push(body);
  });
  const frames=dice.map(()=>[] as number[]),contacts:ThrowTrack['contacts']=[],lastContact=dice.map(()=>-99);
  let frame=0,quiet=0,settledFrame=-1;const maxFrames=Math.round(maxSeconds*hz);
  const record=()=>bodies.forEach((b,i)=>{const t=b.translation(),r=b.rotation();frames[i].push(t.x,t.y,t.z,r.x,r.y,r.z,r.w);});
  record();
  while(frame<maxFrames){
   for(let s=0;s<sub;s++){
    world.step(events);
    events.drainContactForceEvents(ev=>{
     const a=colliderDie.get(ev.collider1()),b=colliderDie.get(ev.collider2()),die=a??b;if(die===undefined)return;
     if(frame-lastContact[die]<3)return;lastContact[die]=frame;
     contacts.push({frame,die,strength:Math.min(1,Math.log10(1+ev.totalForceMagnitude())/4.2),withDie:a!==undefined&&b!==undefined});
    });
   }
   frame++;record();
   const moving=bodies.some(b=>{if(b.isSleeping())return false;const v=b.linvel(),w=b.angvel();return Math.hypot(v.x,v.y,v.z)>.06||Math.hypot(w.x,w.y,w.z)>.12;});
   quiet=moving?0:quiet+1;
   if(quiet>=12){settledFrame=frame-12;break;}
  }
  const landed=bodies.map((b,i)=>topAxis(b.rotation(),dice[i].axes));
  const clean=settledFrame>0&&landed.every(l=>l.dot>.985)&&bodies.every(b=>{const t=b.translation();return Math.abs(t.x)<W-.3&&Math.abs(t.z)<D-.3;});
  return {hz,frameCount:frame+1,frames:frames.map(f=>Float32Array.from(f)),landedAxis:landed.map(l=>l.index),settledFrame:settledFrame>0?settledFrame:frame,contacts,attempts:1,clean};
 }finally{events.free();world.free();}
}
