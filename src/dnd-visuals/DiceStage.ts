// DiceRenderer: an imperative Three.js stage owned by the React overlay.
// One WebGL context per open adventure room; it renders only while a roll or
// an omen is on screen and releases every GPU resource in dispose().
import * as THREE from 'three';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import {physicalFaces,symmetryRotation,type VisualRoll} from '../../shared/dice-visual.mjs';
import {loadDiceSet,createDiceMaterials,type DiceSet,type DieTemplate,type DieModel,type DiceMaterials} from './diceModels';
import {simulateThrow,type ThrowTrack} from './dicePhysics';
import type {QualityProfile} from './settings';

export interface StageDie{template:DieTemplate;group:THREE.Group;visual:THREE.Group;resultNumerals:THREE.Mesh[];allNumerals:THREE.Mesh[];faceIndex:number;kept:boolean;value:number;sides:number;upLocal:THREE.Vector3}
export interface PlayHooks{onContact?(strength:number,withDie:boolean):void;signal?:AbortSignal}
export type OmenKind='success'|'failure';
const ease=(t:number)=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const clamp01=(v:number)=>Math.min(1,Math.max(0,v));

function makeSprite(kind:'glow'|'smoke'){
 const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d')!;
 const grd=g.createRadialGradient(64,64,0,64,64,64);
 if(kind==='glow'){grd.addColorStop(0,'rgba(255,255,255,1)');grd.addColorStop(.18,'rgba(255,236,190,.9)');grd.addColorStop(.5,'rgba(255,190,90,.25)');grd.addColorStop(1,'rgba(255,170,60,0)');}
 else{grd.addColorStop(0,'rgba(20,6,18,.85)');grd.addColorStop(.55,'rgba(12,4,12,.45)');grd.addColorStop(1,'rgba(0,0,0,0)');}
 g.fillStyle=grd;g.fillRect(0,0,128,128);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;
}
function tableTexture(){
 const S=1024,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d')!;
 const base=g.createRadialGradient(S/2,S/2,40,S/2,S/2,S*.62);base.addColorStop(0,'#13202a');base.addColorStop(.55,'#0b1219');base.addColorStop(1,'#05070b');
 g.fillStyle=base;g.fillRect(0,0,S,S);
 const img=g.getImageData(0,0,S,S);for(let i=0;i<img.data.length;i+=4){const n=(Math.random()-.5)*10;img.data[i]+=n;img.data[i+1]+=n;img.data[i+2]+=n;}g.putImageData(img,0,0);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;
}
function runeTexture(){
 const S=1024,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d')!,m=S/2;
 g.strokeStyle='#ffffff';g.lineCap='round';
 const ring=(r:number,w:number,a=1)=>{g.globalAlpha=a;g.lineWidth=w;g.beginPath();g.arc(m,m,r,0,Math.PI*2);g.stroke();};
 ring(470,3,.9);ring(452,1.5,.7);ring(330,2,.8);ring(318,1,.5);ring(120,2,.6);
 for(let i=0;i<48;i++){const a=i/48*Math.PI*2,r1=i%4===0?330:340,r2=i%4===0?452:440;g.globalAlpha=i%4===0?.9:.35;g.lineWidth=i%4===0?2:1;g.beginPath();g.moveTo(m+Math.cos(a)*r1,m+Math.sin(a)*r1);g.lineTo(m+Math.cos(a)*r2,m+Math.sin(a)*r2);g.stroke();}
 g.globalAlpha=.75;g.lineWidth=2;for(let k=0;k<2;k++){g.beginPath();for(let i=0;i<=3;i++){const a=(i/3)*Math.PI*2+k*Math.PI/3-Math.PI/2;const x=m+Math.cos(a)*318,y=m+Math.sin(a)*318;i?g.lineTo(x,y):g.moveTo(x,y);}g.stroke();}
 g.font='bold 34px serif';g.textAlign='center';g.textBaseline='middle';g.globalAlpha=.8;g.fillStyle='#ffffff';
 const glyphs='ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';for(let i=0;i<24;i++){const a=i/24*Math.PI*2;g.save();g.translate(m+Math.cos(a)*392,m+Math.sin(a)*392);g.rotate(a+Math.PI/2);g.fillText(glyphs[i],0,0);g.restore();}
 const t=new THREE.CanvasTexture(c);return t;
}

class Particles{
 readonly points:THREE.Points;private pos:Float32Array;private vel:Float32Array;private life:Float32Array;private geo:THREE.BufferGeometry;private mat:THREE.PointsMaterial;private tex:THREE.Texture;
 private spawnCenter=new THREE.Vector3();private active=false;private mode:OmenKind='success';
 constructor(private count:number){
  this.pos=new Float32Array(count*3);this.vel=new Float32Array(count*3);this.life=new Float32Array(count).fill(-1);
  this.geo=new THREE.BufferGeometry();this.geo.setAttribute('position',new THREE.BufferAttribute(this.pos,3));
  this.tex=makeSprite('glow');this.mat=new THREE.PointsMaterial({size:.16,map:this.tex,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,color:0xffd58a,sizeAttenuation:true});
  this.points=new THREE.Points(this.geo,this.mat);this.points.frustumCulled=false;this.points.visible=false;
 }
 start(mode:OmenKind,center:THREE.Vector3){
  this.mode=mode;this.spawnCenter.copy(center);this.active=true;this.points.visible=true;this.life.fill(-1);
  this.tex.dispose();this.tex=makeSprite(mode==='success'?'glow':'smoke');this.mat.map=this.tex;
  this.mat.blending=mode==='success'?THREE.AdditiveBlending:THREE.NormalBlending;this.mat.color.set(mode==='success'?0xffd58a:0xffffff);this.mat.size=mode==='success'?.16:1.1;this.mat.opacity=mode==='success'?1:.75;this.mat.needsUpdate=true;
 }
 stop(){this.active=false;this.points.visible=false;}
 update(dt:number,rate:number){
  if(!this.active)return;let spawn=rate*dt*this.count;
  for(let i=0;i<this.count;i++){
   const j=i*3;
   if(this.life[i]<0){if(spawn<1&&Math.random()>spawn)continue;spawn--;
    const a=Math.random()*Math.PI*2,r=this.mode==='success'?.8+Math.random()*2.2:1+Math.random()*2.6;
    this.pos[j]=this.spawnCenter.x+Math.cos(a)*r;this.pos[j+1]=this.mode==='success'?Math.random()*.4:Math.random()*.6;this.pos[j+2]=this.spawnCenter.z+Math.sin(a)*r;
    if(this.mode==='success'){this.vel[j]=-Math.sin(a)*.5;this.vel[j+1]=.7+Math.random()*1.6;this.vel[j+2]=Math.cos(a)*.5;}
    else{this.vel[j]=-Math.sin(a)*1.2-Math.cos(a)*.25;this.vel[j+1]=.12+Math.random()*.35;this.vel[j+2]=Math.cos(a)*1.2-Math.sin(a)*.25;}
    this.life[i]=0;continue;}
   this.life[i]+=dt;if(this.life[i]>2.6){this.life[i]=-1;this.pos[j+1]=-50;continue;}
   this.pos[j]+=this.vel[j]*dt;this.pos[j+1]+=this.vel[j+1]*dt;this.pos[j+2]+=this.vel[j+2]*dt;
  }
  (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate=true;
 }
 dispose(){this.geo.dispose();this.mat.dispose();this.tex.dispose();}
}

export class DiceStage{
 readonly renderer:THREE.WebGLRenderer;readonly scene=new THREE.Scene();readonly camera=new THREE.PerspectiveCamera(36,16/9,.1,200);
 private composer:EffectComposer|null=null;private bloom:UnrealBloomPass|null=null;private envRT:THREE.WebGLRenderTarget|null=null;
 private set!:DiceSet;private mats!:DiceMaterials;private cores=new Map<DieModel,THREE.BufferGeometry>();
 private disposables:{dispose():void}[]=[];private dice:StageDie[]=[];private raf=0;private last=0;private disposed=false;
 private tickers=new Set<(dt:number,now:number)=>boolean|void>();
 private key!:THREE.SpotLight;private rim!:THREE.DirectionalLight;private red!:THREE.PointLight;private candles:THREE.PointLight[]=[];private hemi!:THREE.HemisphereLight;
 private runes!:THREE.Mesh;private runeMat!:THREE.MeshBasicMaterial;private particles!:Particles;
 private camPos=new THREE.Vector3(0,11.5,9.6);private camTarget=new THREE.Vector3(0,0,.4);private camUp=new THREE.Vector3(0,1,0);
 arena={halfWidth:7,halfDepth:4.4};

 private constructor(readonly canvas:HTMLCanvasElement,readonly profile:QualityProfile){
  this.renderer=new THREE.WebGLRenderer({canvas,antialias:profile.antialias,alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:false});
  this.renderer.setPixelRatio(profile.pixelRatio);this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.22;
  this.renderer.shadowMap.enabled=profile.shadows>0;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  this.scene.background=new THREE.Color('#05070b');
 }
 static async create(canvas:HTMLCanvasElement,profile:QualityProfile){
  const stage=new DiceStage(canvas,profile);
  try{stage.set=await loadDiceSet();stage.build();return stage;}catch(e){stage.dispose();throw e;}
 }
 private build(){
  const {scene,profile}=this;
  this.mats=createDiceMaterials(profile);
  // Image-based lighting: a tiny dark "chapel" with a warm softbox and a teal window.
  const envScene=new THREE.Scene();envScene.background=new THREE.Color('#020306');
  const panel=(w:number,h:number,color:string,intensity:number,p:[number,number,number])=>{const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color:new THREE.Color(color).multiplyScalar(intensity),side:THREE.DoubleSide}));m.position.set(...p);m.lookAt(0,0,0);envScene.add(m);};
  panel(8,3,'#ffd9a0',6,[3,9,2]);panel(4,6,'#5fe0ff',2.2,[-9,3,-3]);panel(10,.6,'#ffffff',4,[0,6,-8]);panel(3,3,'#ff9f4a',2.5,[8,1,6]);
  const pm=new THREE.PMREMGenerator(this.renderer);this.envRT=pm.fromScene(envScene,.035);pm.dispose();
  envScene.traverse(o=>{const m=o as THREE.Mesh;if(m.isMesh){m.geometry.dispose();(m.material as THREE.Material).dispose();}});
  scene.environment=this.envRT.texture;scene.environmentIntensity=1;

  const tex=tableTexture();this.disposables.push(tex);
  const tableGeo=new THREE.PlaneGeometry(60,60),tableMat=new THREE.MeshStandardMaterial({map:tex,color:new THREE.Color('#5d6a78'),roughness:.93,metalness:0,envMapIntensity:.2});
  const table=new THREE.Mesh(tableGeo,tableMat);table.rotation.x=-Math.PI/2;table.receiveShadow=true;scene.add(table);this.disposables.push(tableGeo,tableMat);
  const rt=runeTexture();this.disposables.push(rt);
  this.runeMat=new THREE.MeshBasicMaterial({color:new THREE.Color('#e8b860'),alphaMap:rt,transparent:true,opacity:.055,depthWrite:false,blending:THREE.AdditiveBlending});
  const runeGeo=new THREE.PlaneGeometry(11,11);this.runes=new THREE.Mesh(runeGeo,this.runeMat);this.runes.rotation.x=-Math.PI/2;this.runes.position.y=.004;scene.add(this.runes);this.disposables.push(runeGeo,this.runeMat);

  this.hemi=new THREE.HemisphereLight('#8fb7d6','#0a0710',.6);scene.add(this.hemi);
  this.key=new THREE.SpotLight('#ffd7a1',1500,60,Math.PI/6.5,.75,1.6);this.key.position.set(-5,16,7);this.key.target.position.set(0,0,0);scene.add(this.key,this.key.target);
  if(profile.shadows){this.key.castShadow=true;this.key.shadow.mapSize.set(profile.shadows,profile.shadows);this.key.shadow.bias=-.0004;this.key.shadow.normalBias=.02;this.key.shadow.radius=4;}
  this.rim=new THREE.DirectionalLight('#58d7ff',2.4);this.rim.position.set(6,5,-9);scene.add(this.rim);
  this.red=new THREE.PointLight('#ff2340',0,18,1.6);this.red.position.set(0,3,-4);scene.add(this.red);
  for(const [x,z] of [[-8,-3],[8,-2.5]]){const c=new THREE.PointLight('#ff9a3c',14,16,1.8);c.position.set(x,2.6,z);scene.add(c);this.candles.push(c);}

  this.particles=new Particles(profile.particles);scene.add(this.particles.points);
  if(profile.bloom){
   this.composer=new EffectComposer(this.renderer);this.composer.addPass(new RenderPass(scene,this.camera));
   this.bloom=new UnrealBloomPass(new THREE.Vector2(256,256),.42,.55,.86);this.composer.addPass(this.bloom);this.composer.addPass(new OutputPass());
  }
  this.resize();this.resetCamera();
 }
 resize(){
  const w=Math.max(1,this.canvas.clientWidth),h=Math.max(1,this.canvas.clientHeight);
  this.renderer.setSize(w,h,false);this.composer?.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();
  const aspect=w/h;this.arena={halfWidth:Math.max(4.6,Math.min(9,4.4*aspect)),halfDepth:4.4};
  if(!this.raf)this.renderFrame();
 }
 resetCamera(){this.camPos.set(0,11.5,9.6);this.camTarget.set(0,0,.4);this.camUp.set(0,1,0);this.applyCamera();}
 private applyCamera(){this.camera.position.copy(this.camPos);this.camera.up.copy(this.camUp);this.camera.lookAt(this.camTarget);}
 private renderFrame(){if(this.disposed)return;if(this.composer)this.composer.render();else this.renderer.render(this.scene,this.camera);}
 private loop=(now:number)=>{
  if(this.disposed)return;// Clamp large gaps (tab switch) but keep real time on slow GPUs so throws do not crawl.
  const dt=Math.min(.1,this.last?(now-this.last)/1000:1/60);this.last=now;
  for(const c of this.candles)c.intensity=c.userData.base??=c.intensity,c.intensity=c.userData.base*(.85+Math.sin(now*.011+c.position.x)*.06+Math.random()*.09);
  for(const t of [...this.tickers])if(t(dt,now)===false)this.tickers.delete(t);
  this.particles.update(dt,this.particlesRate);
  this.applyCamera();this.renderFrame();
  this.raf=this.tickers.size||this.particlesRate||this.keepAlive?requestAnimationFrame(this.loop):0;if(!this.raf)this.last=0;
 };
 private particlesRate=0;private keepAlive=false;
 private run(t:(dt:number,now:number)=>boolean|void){this.tickers.add(t);if(!this.raf){this.last=0;this.raf=requestAnimationFrame(this.loop);}}
 private tween(seconds:number,fn:(k:number)=>void,signal?:AbortSignal){return new Promise<void>(resolve=>{let t=0;if(this.disposed||signal?.aborted||seconds<=0){fn(1);resolve();return;}this.run(dt=>{if(this.disposed||signal?.aborted){fn(1);resolve();return false;}t+=dt;const k=clamp01(t/seconds);fn(k);if(k>=1){resolve();return false;}});});}

 clear(){
  for(const d of this.dice){this.scene.remove(d.group);}
  this.dice=[];this.particles.stop();this.particlesRate=0;this.keepAlive=false;
  this.key.intensity=1500;this.key.color.set('#ffd7a1');this.red.intensity=0;this.rim.intensity=2.4;this.hemi.intensity=.6;this.runeMat.opacity=.055;this.runeMat.color.set('#e8b860');
  this.mats.goldGlow.emissiveIntensity=0;this.mats.crimson.emissiveIntensity=0;if(this.bloom)this.bloom.strength=.42;
  this.renderer.toneMappingExposure=1.22;this.resetCamera();
 }
 private coreFor(t:DieTemplate){let g=this.cores.get(t.kind);if(!g){g=t.body.clone();g.scale(.6,.6,.6);this.cores.set(t.kind,g);}return g;}
 private spawn(model:DieModel,label:string,meta:{kept:boolean;value:number;sides:number}):StageDie{
  const template=this.set.templates[model],faceIndex=template.faces.findIndex(f=>f.label===label);
  if(faceIndex<0)throw new Error(`${model} has no face ${label}`);
  const group=new THREE.Group(),visual=new THREE.Group();group.add(visual);
  const body=new THREE.Mesh(template.body,this.mats.resin);body.castShadow=true;visual.add(body);
  if(this.mats.core){const core=new THREE.Mesh(this.coreFor(template),this.mats.core);visual.add(core);}
  const resultNumerals:THREE.Mesh[]=[],allNumerals:THREE.Mesh[]=[];
  for(const n of template.numerals){const m=new THREE.Mesh(n.geometry,this.mats.gold);m.castShadow=false;visual.add(m);allNumerals.push(m);if(n.label===label)resultNumerals.push(m);}
  const f=template.faces[faceIndex],up=f.up?new THREE.Vector3(...f.up):new THREE.Vector3(0,0,-1);
  this.scene.add(group);
  const d={template,group,visual,resultNumerals,allNumerals,faceIndex,upLocal:up,...meta};this.dice.push(d);return d;
 }

 /** Throws the physical dice for `roll` and resolves once the camera framed the result. */
 async play(roll:VisualRoll,{onContact,signal}:PlayHooks={},reducedMotion=false):Promise<StageDie[]>{
  if(this.disposed||signal?.aborted)return [];
  this.clear();
  const wanted:{model:DieModel;label:string;kept:boolean;value:number;sides:number}[]=[];
  for(const die of roll.dice)for(const f of physicalFaces(die.sides,die.value))if(wanted.length<this.profile.maxDice)wanted.push({model:f.model as DieModel,label:f.label,kept:die.kept,value:die.value,sides:die.sides});
  if(!wanted.length)return [];
  const dice=wanted.map(w=>this.spawn(w.model,w.label,w));
  if(reducedMotion){this.placeAtRest(dice);await this.frameResult(dice,.01,signal);return dice;}
  const track=await simulateThrow(dice.map(d=>({hull:d.template.hull,radius:d.template.radius,axes:d.template.axes})),this.arena);
  if(this.disposed)return dice;
  dice.forEach((d,i)=>{
   const m=symmetryRotation(d.template.axes,d.faceIndex,track.landedAxis[i]);
   const m4=new THREE.Matrix4().set(m[0][0],m[0][1],m[0][2],0,m[1][0],m[1][1],m[1][2],0,m[2][0],m[2][1],m[2][2],0,0,0,0,1);
   d.visual.quaternion.setFromRotationMatrix(m4);
  });
  await this.playTrack(dice,track,onContact,signal);
  await this.frameResult(dice,signal?.aborted?.01:1.05,signal);
  return dice;
 }
 private placeAtRest(dice:StageDie[]){
  const n=dice.length,cols=Math.ceil(Math.sqrt(n)),q=new THREE.Quaternion(),yaw=new THREE.Quaternion();
  dice.forEach((d,i)=>{
   const axis=new THREE.Vector3(...d.template.axes[d.faceIndex]);
   q.setFromUnitVectors(axis,new THREE.Vector3(0,1,0));yaw.setFromAxisAngle(new THREE.Vector3(0,1,0),(i*1.7)%6.28);
   d.visual.quaternion.identity();d.group.quaternion.copy(yaw.multiply(q));
   d.group.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(d.group);
   d.group.position.set(((i%cols)-(cols-1)/2)*2.6,-box.min.y,(Math.floor(i/cols)-(Math.ceil(n/cols)-1)/2)*2.6);
  });
 }
 private playTrack(dice:StageDie[],track:ThrowTrack,onContact?:PlayHooks['onContact'],signal?:AbortSignal){
  const qa=new THREE.Quaternion(),qb=new THREE.Quaternion(),centroid=new THREE.Vector3();let time=0,contact=0;
  const apply=(f:number)=>{
   const i=Math.min(track.frameCount-1,Math.floor(f)),k=Math.min(1,f-i),i2=Math.min(track.frameCount-1,i+1);
   centroid.set(0,0,0);
   dice.forEach((d,n)=>{const a=track.frames[n],o=i*7,o2=i2*7;
    d.group.position.set(a[o]+(a[o2]-a[o])*k,a[o+1]+(a[o2+1]-a[o+1])*k,a[o+2]+(a[o2+2]-a[o+2])*k);
    qa.set(a[o+3],a[o+4],a[o+5],a[o+6]);qb.set(a[o2+3],a[o2+4],a[o2+5],a[o2+6]);d.group.quaternion.slerpQuaternions(qa,qb,k);centroid.add(d.group.position);});
   centroid.multiplyScalar(1/dice.length);
  };
  apply(0);
  return new Promise<void>(resolve=>{
   const end=track.frameCount-1;
   this.run(dt=>{
    if(this.disposed){resolve();return false;}
    if(signal?.aborted){apply(end);resolve();return false;}
    time+=dt;const f=Math.min(end,time*track.hz);apply(f);
    while(contact<track.contacts.length&&track.contacts[contact].frame<=f){const c=track.contacts[contact++];onContact?.(c.strength,c.withDie);}
    this.camTarget.lerp(new THREE.Vector3(centroid.x*.45,0,centroid.z*.35+.4),1-Math.exp(-dt*2.2));
    if(f>=Math.min(end,track.settledFrame+6)){apply(end);resolve();return false;}
   });
  });
 }
 /** World-space "up" of the numeral on the rolled face (for an upright camera). */
 numeralUp(d:StageDie){return d.upLocal.clone().applyQuaternion(d.visual.quaternion).applyQuaternion(d.group.quaternion).setY(0).normalize();}
 private frameResult(dice:StageDie[],seconds:number,signal?:AbortSignal){
  const focus=dice.filter(d=>d.kept).length?dice.filter(d=>d.kept):dice;
  const box=new THREE.Box3();for(const d of dice){d.group.updateMatrixWorld(true);box.expandByObject(d.group);}
  const center=new THREE.Vector3();
  let pos:THREE.Vector3,target:THREE.Vector3,up:THREE.Vector3;
  if(focus.length===1||dice.length<=2&&focus.length<=2&&dice.every(d=>d.template.kind.startsWith('d10'))){
   const fbox=new THREE.Box3();for(const d of focus)fbox.expandByObject(d.group);fbox.getCenter(center);
   const d0=focus[0],faceUp=d0.template.readMode==='vertex'?new THREE.Vector3(0,0,-1):this.numeralUp(d0);
   if(!Number.isFinite(faceUp.x)||faceUp.lengthSq()<.5)faceUp.set(0,0,-1);
   const size=fbox.getSize(new THREE.Vector3()).length(),dist=Math.max(4.4,size*1.75);
   target=center.clone().setY(fbox.max.y*.55).addScaledVector(faceUp,-.55);up=faceUp;
   pos=target.clone().add(new THREE.Vector3(0,dist,0)).addScaledVector(faceUp,-dist*(d0.template.readMode==='vertex'?.7:.26));
  }else{
   box.getCenter(center);const size=box.getSize(new THREE.Vector3()),span=Math.max(size.x,size.z*this.camera.aspect)*.62+1.6;
   const dist=span/Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))/this.camera.aspect*1.05+2;
   target=center.clone().setY(.4).add(new THREE.Vector3(0,0,1.6));up=new THREE.Vector3(0,0,-1);pos=target.clone().add(new THREE.Vector3(0,Math.max(7,dist),Math.max(7,dist)*.38));
  }
  for(const d of dice)if(!d.kept)for(const m of d.allNumerals)m.material=this.mats.gold;
  const p0=this.camPos.clone(),t0=this.camTarget.clone(),u0=this.camUp.clone();
  return this.tween(seconds,k=>{const e=ease(k);this.camPos.lerpVectors(p0,pos,e);this.camTarget.lerpVectors(t0,target,e);this.camUp.lerpVectors(u0,up,e).normalize();},signal);
 }

 /** Phase 1 of a cinematic: the natural 20 / natural 1 reveal on the real die. */
 async omen(kind:OmenKind,die:StageDie|undefined,seconds=1.7,signal?:AbortSignal){
  if(!die)return;this.keepAlive=true;
  const mat=kind==='success'?this.mats.goldGlow:this.mats.crimson;for(const m of die.resultNumerals)m.material=mat;
  const center=die.group.position.clone();this.particles.start(kind,center);this.particlesRate=kind==='success'?.45:.5;
  const p0=this.camPos.clone(),target=this.camTarget.clone(),key0=this.key.intensity,exp0=this.renderer.toneMappingExposure;
  if(kind==='failure')this.runeMat.color.set('#ff2a3a');
  await this.tween(seconds,k=>{
   const e=ease(k);this.camPos.lerpVectors(p0,target.clone().add(p0.clone().sub(target).multiplyScalar(.78)),e);
   if(kind==='success'){mat.emissiveIntensity=1.6*e;this.runeMat.opacity=.055+.3*e;this.key.intensity=key0*(1+.35*e);if(this.bloom)this.bloom.strength=.42+.45*e;}
   else{mat.emissiveIntensity=2.0*e;mat.color.lerpColors(new THREE.Color('#ffc766'),new THREE.Color('#ff3040'),e);this.key.intensity=key0*(1-.82*e);this.hemi.intensity=.6*(1-.8*e);this.rim.intensity=2.4*(1-.7*e);this.red.intensity=55*e;this.runeMat.opacity=.055+.25*e;this.renderer.toneMappingExposure=exp0*(1-.25*e);if(this.bloom)this.bloom.strength=.42+.6*e;}
  },signal);
 }
 stopRendering(){this.keepAlive=false;this.particlesRate=0;this.particles.stop();}
 info(){const i=this.renderer.info;return {geometries:i.memory.geometries,textures:i.memory.textures,programs:i.programs?.length??0,calls:i.render.calls,triangles:i.render.triangles};}
 dispose(){
  if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);
  // Resolve pending animation promises before removing their frame callbacks.
  for(const ticker of this.tickers)ticker(0,performance.now());
  this.tickers.clear();
  for(const d of this.dice)this.scene.remove(d.group);this.dice=[];
  this.particles?.dispose();for(const g of this.cores.values())g.dispose();this.cores.clear();
  this.mats?.dispose();for(const d of this.disposables)d.dispose();this.envRT?.dispose();
  this.composer?.dispose();this.bloom?.dispose();
  this.renderer.dispose();this.renderer.forceContextLoss();
 }
}
