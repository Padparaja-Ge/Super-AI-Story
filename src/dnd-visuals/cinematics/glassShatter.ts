// Screen-glass fracture for DEATH'S JUDGMENT. Purely an in-app overlay: a
// transparent WebGL canvas over the cinematic, never the OS window.
import * as THREE from 'three';

interface Shard{mesh:THREE.Mesh;edge:THREE.LineSegments;vel:THREE.Vector3;spin:THREE.Vector3;delay:number}
export interface CrackPath{d:string;length:number;delay:number;width:number}

function rand(seed:number){return()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};}

/** Shared fracture layout: radial rays + jittered rings around the impact point. */
export function fracture(aspect:number,impact:{x:number;y:number},seed=7){
 const r=rand(seed),rays=15,angles=Array.from({length:rays},(_,i)=>(i+.25+r()*.5)/rays*Math.PI*2);
 const rings=[0,.05,.13,.25,.42,.66,1.0,1.5,2.4];
 const pt=(ray:number,ring:number)=>{const a=angles[ray%rays]+(ring?(r()-.5)*.08:0),rad=rings[ring]*(ring?(.85+r()*.3):1);return new THREE.Vector2(impact.x+Math.cos(a)*rad,impact.y+Math.sin(a)*rad);};
 const grid=angles.map((_,i)=>rings.map((_,j)=>pt(i,j)));
 const cells:THREE.Vector2[][]=[];
 for(let i=0;i<rays;i++)for(let j=0;j<rings.length-1;j++){
  const a=grid[i][j],b=grid[i][j+1],c=grid[(i+1)%rays][j+1],d=grid[(i+1)%rays][j];
  const poly=j===0?[a,b,c]:[a,b,c,d];
  if(poly.every(p=>Math.abs(p.x)>aspect+.3||Math.abs(p.y)>1.3))continue;
  cells.push(poly);
 }
 // SVG crack paths in a viewBox of (-aspect..aspect, -1..1), y up -> flip in caller.
 const cracks:CrackPath[]=[];
 for(let i=0;i<rays;i++){const pts=grid[i].slice(0,rings.length);const d='M'+pts.map(p=>`${p.x.toFixed(3)} ${(-p.y).toFixed(3)}`).join(' L');cracks.push({d,length:4,delay:0,width:.006});}
 for(let j=1;j<5;j++){const pts=grid.map(row=>row[j]);const d='M'+pts.map(p=>`${p.x.toFixed(3)} ${(-p.y).toFixed(3)}`).join(' L')+' Z';cracks.push({d,length:rings[j]*7,delay:.06*j,width:.0035});}
 return {cells,cracks};
}

export class GlassShatter{
 private renderer:THREE.WebGLRenderer;private scene=new THREE.Scene();private camera:THREE.PerspectiveCamera;private shards:Shard[]=[];
 private texture:THREE.Texture|null=null;private disposed=false;private raf=0;private t=0;private last=0;private aspect=16/9;
 private light=new THREE.PointLight('#ffd0e0',30,10,1.2);
 constructor(private canvas:HTMLCanvasElement,pixelRatio:number){
  this.renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,premultipliedAlpha:true});
  this.renderer.setPixelRatio(pixelRatio);this.renderer.setClearColor(0x000000,0);
  this.camera=new THREE.PerspectiveCamera(50,1,.05,50);this.camera.position.z=1/Math.tan(THREE.MathUtils.degToRad(25));
  this.scene.add(new THREE.AmbientLight('#ffffff',.3),this.light);this.light.position.set(.4,.6,1.2);
  this.resize();
 }
 resize(){const w=Math.max(1,this.canvas.clientWidth),h=Math.max(1,this.canvas.clientHeight);this.aspect=w/h;this.renderer.setSize(w,h,false);this.camera.aspect=this.aspect;this.camera.updateProjectionMatrix();}
 /** source: the frame to break (video or canvas); drawn with the crack lines baked in. */
 shatter(source:CanvasImageSource|null,impact:{x:number;y:number},quality:{shards:boolean}){
  if(this.disposed)return;
  const W=1280,H=Math.round(1280/this.aspect),snap=document.createElement('canvas');snap.width=W;snap.height=H;const g=snap.getContext('2d')!;
  if(source){try{g.drawImage(source,0,0,W,H);}catch{g.fillStyle='#0a0508';g.fillRect(0,0,W,H);}}else{g.fillStyle='rgba(12,6,14,.55)';g.fillRect(0,0,W,H);}
  const {cells}=fracture(this.aspect,impact);
  g.strokeStyle='rgba(255,235,245,.45)';g.lineWidth=1.25;
  const toPx=(p:THREE.Vector2)=>[(p.x+this.aspect)/(2*this.aspect)*W,(1-(p.y+1)/2)*H];
  for(const c of cells){g.beginPath();c.forEach((p,i)=>{const [x,y]=toPx(p);i?g.lineTo(x,y):g.moveTo(x,y);});g.closePath();g.stroke();}
  this.texture=new THREE.CanvasTexture(snap);this.texture.colorSpace=THREE.SRGBColorSpace;
  if(!quality.shards)return;
  const lineMat=new THREE.LineBasicMaterial({color:'#ffd6ea',transparent:true,opacity:.38,blending:THREE.AdditiveBlending});
  for(const cell of cells){
   const centroid=cell.reduce((a,p)=>a.add(p),new THREE.Vector2()).multiplyScalar(1/cell.length);
   const shape=new THREE.Shape(cell.map(p=>p.clone().sub(centroid)));const geo=new THREE.ShapeGeometry(shape);
   const pos=geo.getAttribute('position'),uv=geo.getAttribute('uv');
   for(let i=0;i<pos.count;i++){uv.setXY(i,(pos.getX(i)+centroid.x+this.aspect)/(2*this.aspect),(pos.getY(i)+centroid.y+1)/2);}
   const mat=new THREE.MeshStandardMaterial({map:this.texture,emissiveMap:this.texture,emissive:'#ffffff',emissiveIntensity:.92,color:'#202020',roughness:.12,metalness:.1,transparent:true,side:THREE.DoubleSide});
   const mesh=new THREE.Mesh(geo,mat);mesh.position.set(centroid.x,centroid.y,0);
   const edge=new THREE.LineSegments(new THREE.EdgesGeometry(geo),lineMat);mesh.add(edge);
   const out=centroid.clone().sub(new THREE.Vector2(impact.x,impact.y)),dist=out.length();out.normalize();
   const power=Math.max(.25,1.6-dist*.9);
   this.shards.push({mesh,edge,delay:dist*.09,vel:new THREE.Vector3(out.x*power*(.6+Math.random()*.9),out.y*power*(.6+Math.random()*.9)+.2,(1.2+Math.random()*2.6)*power),spin:new THREE.Vector3((Math.random()-.5)*7,(Math.random()-.5)*7,(Math.random()-.5)*4)});
   this.scene.add(mesh);
  }
  this.t=0;this.last=0;this.raf=requestAnimationFrame(this.loop);
 }
 private loop=(now:number)=>{
  if(this.disposed)return;const dt=Math.min(.05,this.last?(now-this.last)/1000:1/60);this.last=now;this.t+=dt;
  for(const s of this.shards){const k=this.t-s.delay;if(k<0)continue;
   s.vel.y-=3.2*dt;s.mesh.position.addScaledVector(s.vel,dt);s.mesh.rotation.x+=s.spin.x*dt;s.mesh.rotation.y+=s.spin.y*dt;s.mesh.rotation.z+=s.spin.z*dt;
   const fade=Math.max(0,1-Math.max(0,k-.7)/.8);(s.mesh.material as THREE.MeshStandardMaterial).opacity=fade;(s.edge.material as THREE.LineBasicMaterial).opacity=.38*fade;}
  this.renderer.render(this.scene,this.camera);
  this.raf=this.t<2.2?requestAnimationFrame(this.loop):0;if(!this.raf)this.clearShards();
 };
 private clearShards(){
  const lines=new Set<THREE.Material>();
  for(const s of this.shards){this.scene.remove(s.mesh);s.mesh.geometry.dispose();(s.mesh.material as THREE.Material).dispose();s.edge.geometry.dispose();lines.add(s.edge.material as THREE.Material);}
  for(const m of lines)m.dispose();this.shards=[];this.texture?.dispose();this.texture=null;this.renderer.clear();
 }
 dispose(){if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.raf);this.clearShards();this.renderer.dispose();this.renderer.forceContextLoss();}
}
