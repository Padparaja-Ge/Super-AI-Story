// DiceModels: loads the Blender-built dice set (GLB + face map JSON) once and
// produces per-stage materials for the selected quality tier.
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import type {QualityProfile} from './settings';

export const DICE_ASSET_BASE='/dnd-visuals/dice/';
export type DieModel='d4'|'d6'|'d8'|'d10'|'d10t'|'d12'|'d20';
export interface FaceInfo{value:number;label:string;axis:number[];up?:number[]}
export interface DieTemplate{
 kind:DieModel;radius:number;readMode:'face'|'vertex';faces:FaceInfo[];axes:number[][];
 body:THREE.BufferGeometry;hull:Float32Array;
 numerals:{geometry:THREE.BufferGeometry;label:string;value:number}[];
}
export interface DiceSet{templates:Record<DieModel,DieTemplate>;dispose():void}

let loading:Promise<DiceSet>|null=null;
export function loadDiceSet():Promise<DiceSet>{
 return loading??=(async()=>{
  const [gltf,meta]=await Promise.all([
   new GLTFLoader().loadAsync(DICE_ASSET_BASE+'dice-set.glb'),
   fetch(DICE_ASSET_BASE+'dice-faces.json').then(r=>{if(!r.ok)throw new Error('dice-faces.json: '+r.status);return r.json();}),
  ]);
  const templates={} as Record<DieModel,DieTemplate>,owned:THREE.BufferGeometry[]=[];
  for(const kind of Object.keys(meta.dice) as DieModel[]){
   const info=meta.dice[kind],root=gltf.scene.getObjectByName('die_'+kind);
   if(!root)throw new Error('GLB has no die_'+kind);
   root.updateMatrixWorld(true);
   let body:THREE.BufferGeometry|null=null;const numerals:DieTemplate['numerals']=[];
   root.traverse(o=>{
    const mesh=o as THREE.Mesh;if(!mesh.isMesh)return;
    const g=mesh.geometry.clone();g.applyMatrix4(mesh.matrixWorld);owned.push(g);
    if(mesh.name===kind+'_body'){body=g;return;}
    const value=Number(mesh.userData?.dieValue),label=kind==='d4'?String(value):mesh.name.slice((kind+'_num_').length);
    numerals.push({geometry:g,label,value});
   });
   if(!body)throw new Error('GLB has no body for '+kind);
   const pos=(body as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
   templates[kind]={kind,radius:info.radius,readMode:info.readMode,faces:info.faces,axes:info.faces.map((f:FaceInfo)=>f.axis),body,hull:Float32Array.from(pos.array as ArrayLike<number>),numerals};
  }
  gltf.scene.traverse(o=>{const m=o as THREE.Mesh;if(m.isMesh){m.geometry.dispose();for(const mat of ([] as THREE.Material[]).concat(m.material))mat.dispose();}});
  return {templates,dispose(){for(const g of owned)g.dispose();loading=null;}};
 })().catch(error=>{loading=null;throw error;});
}
export function releaseDiceSet(){const p=loading;if(!p)return;p.then(set=>set.dispose()).catch(()=>{});}

export interface DiceMaterials{resin:THREE.Material;core:THREE.Material|null;gold:THREE.MeshStandardMaterial;goldGlow:THREE.MeshStandardMaterial;crimson:THREE.MeshStandardMaterial;dispose():void}
export function createDiceMaterials(profile:QualityProfile):DiceMaterials{
 const resin=profile.transmission?new THREE.MeshPhysicalMaterial({
  color:new THREE.Color('#8af0ee'),transmission:1,thickness:1.0,ior:1.54,roughness:.045,metalness:0,
  attenuationColor:new THREE.Color('#2a8fb5'),attenuationDistance:2.2,clearcoat:1,clearcoatRoughness:.03,
  specularIntensity:1,specularColor:new THREE.Color('#e9fbff'),envMapIntensity:1.9,emissive:new THREE.Color('#06333d'),emissiveIntensity:.55,
 }):new THREE.MeshPhysicalMaterial({color:new THREE.Color('#13707e'),roughness:.08,metalness:.05,clearcoat:1,clearcoatRoughness:.04,transparent:true,opacity:.9,envMapIntensity:1.6});
 // A deeper sapphire core gives the resin its two-tone depth through the transmission pass.
 const core=profile.transmission?new THREE.MeshPhysicalMaterial({color:new THREE.Color('#1752a8'),roughness:.3,transmission:.35,thickness:.6,attenuationColor:new THREE.Color('#0b3a78'),attenuationDistance:.8,emissive:new THREE.Color('#0b5f82'),emissiveIntensity:.65}):null;
 const gold=new THREE.MeshStandardMaterial({color:new THREE.Color('#ffc766'),metalness:1,roughness:.26,envMapIntensity:1.5});
 const goldGlow=new THREE.MeshStandardMaterial({color:new THREE.Color('#ffd27a'),metalness:.6,roughness:.2,emissive:new THREE.Color('#ffb340'),emissiveIntensity:0,envMapIntensity:1.5});
 const crimson=new THREE.MeshStandardMaterial({color:new THREE.Color('#ffc766'),metalness:.7,roughness:.3,emissive:new THREE.Color('#ff1f2e'),emissiveIntensity:0});
 return {resin,core,gold,goldGlow,crimson,dispose(){for(const m of [resin,core,gold,goldGlow,crimson])m?.dispose();}};
}
