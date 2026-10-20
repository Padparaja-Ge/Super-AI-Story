import crypto from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {structuredCompletion,parseObject} from './services/structuredCompletion.js';
import {visualTags} from './services/imagePromptService.js';
import {npcActor,placePlayers} from './tactical.mjs';
const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schema=obj({title:{type:'string'},environment:{type:'string',enum:['interior','cave','outdoor']},entrySide:{type:'string',enum:['north','south','east','west']},rooms:{type:'array',minItems:1,maxItems:6,items:{type:'string'}},visualPrompt:{type:'string'},npcs:{type:'array',maxItems:8,items:obj({name:{type:'string'},archetype:{type:'string',enum:['warrior','archer','mage','healer','beast']},hp:{type:'integer',minimum:1,maximum:500},armor:{type:'integer',minimum:1,maximum:19}})}});
export async function describeBattlemap(state,chat,getSecret,signal,extraInstructions=''){
 const descriptor=await structuredCompletion({state,chat,getSecret,signal,schema,name:'battlemap',maxTokens:1000,adaptInstruction:true,instructions:'Design a top-down tactical encounter map based on this CURRENT scene. Return only JSON. Do not move the story to another location. rooms: 1-6 area names; choose interior, cave or outdoor. entrySide: the edge the players arrived from. npcs: only non-player characters present in this scene (never the players). Choose archetype warrior/archer/mage/healer/beast to match their role. visualPrompt: concise English visual tags for an orthographic battle map, without tokens, grid, people, text or perspective. Do not include mechanics in the visual prompt.',context:{scene:chat.scene,history:chat.messages.slice(-6).map(m=>({role:m.role,content:m.content.slice(-1500)})),lore:state.lorebooks.filter(b=>(chat.lorebookIds||[]).includes(b.id)).map(b=>({name:b.name,description:b.description?.slice(0,400)})),rules:extraInstructions.slice(0,1000)},parse:raw=>{const s=parseObject(raw);if(!['interior','cave','outdoor'].includes(s.environment)||!['north','south','east','west'].includes(s.entrySide)||!Array.isArray(s.rooms)||s.rooms.length<1||s.rooms.length>6||!Array.isArray(s.npcs)||s.npcs.length>8||typeof s.title!=='string'||typeof s.visualPrompt!=='string'||s.rooms.some(r=>typeof r!=='string')||s.npcs.some(n=>!n||typeof n.name!=='string'||!Number.isInteger(n.hp)||n.hp<1||n.hp>500||!Number.isInteger(n.armor)||n.armor<1||n.armor>19))throw new Error('Неверное описание карты.');const players=new Set((state.multiplayer?.tactical?.actors||[]).filter(a=>a.player).map(a=>a.name.toLowerCase()));if(s.npcs.some(n=>players.has(n.name.toLowerCase())))throw new Error('NPC must not include player characters.');return s;}});
 try{descriptor.visualPrompt=visualTags(descriptor.visualPrompt);}catch{
  // Repair only the visual field: preserve the accepted scene, NPCs and layout.
  // Combat statistics and dialogue are deliberately absent from this request.
  descriptor.visualPrompt=await structuredCompletion({state,chat,getSecret,signal,name:'battlemap_visual_tags',maxTokens:600,adaptInstruction:true,
   schema:obj({tags:{type:'array',minItems:3,maxItems:40,items:{type:'string'}}}),
   instructions:'Compile an image prompt for the supplied battle map. Return JSON {"tags":["orthographic top-down battlemap","stone courtyard","wet cobblestones",...]}. All tags MUST be short English noun/adjective phrases, separated as array items. Translate the source location into English. Depict terrain, surfaces, architecture, furniture, vegetation and lighting only. No people, tokens, grid, perspective, dialogue, actions, statistics or sentences. Do not continue the roleplay. Preserve the supplied indoor/cave/outdoor environment.',
   context:{title:descriptor.title,environment:descriptor.environment,areas:descriptor.rooms,location:chat.scene?.location,weather:chat.scene?.weather,time:chat.scene?.time},
   parse:raw=>{const value=parseObject(raw);if(!Array.isArray(value.tags)||value.tags.some(t=>typeof t!=='string'))throw new Error('Нужен массив коротких английских тегов tags.');return visualTags(value.tags.join(', '));}});
 }
 return descriptor;
}
export function generateMap({width=24,height=24,descriptor,seed=crypto.randomInt(1,0x7fffffff)}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<12||height<12||width>60||height>60)throw new Error('Размер стола: от 12 до 60 клеток по каждой стороне.');
 let rng=seed>>>0;const random=()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/4294967296),tiles=Array(width*height).fill(1),rooms=[];
 const carve=(x,y)=>{if(x>0&&y>0&&x<width-1&&y<height-1)tiles[y*width+x]=0;};
 const count=Math.max(1,Math.min(6,descriptor.rooms.length)),leaves=[{x:1,y:1,w:width-2,h:height-2}];
 // Split differently for every seed, then connect room centers into one graph.
 while(leaves.length<count){
  const candidates=leaves.map((r,i)=>({r,i})).filter(({r})=>r.w>=8||r.h>=8).sort((a,b)=>b.r.w*b.r.h-a.r.w*a.r.h);if(!candidates.length)break;
  const {r,i}=candidates[0],vertical=r.w>=8&&(r.h<8||r.w>r.h*1.25||r.w>=r.h*.8&&random()<.5),extent=vertical?r.w:r.h,cut=Math.max(4,Math.min(extent-4,Math.floor(extent*(.35+random()*.3))));
  leaves.splice(i,1,...(vertical?[{...r,w:cut},{...r,x:r.x+cut,w:r.w-cut}]:[{...r,h:cut},{...r,y:r.y+cut,h:r.h-cut}]));
 }
 for(const [i,r] of leaves.entries()){
  const insetX=r.w>=6?1+Math.floor(random()*Math.max(1,r.w/6)):1,insetY=r.h>=6?1+Math.floor(random()*Math.max(1,r.h/6)):1;
  const room={name:String(descriptor.rooms[i]||descriptor.rooms[0]).slice(0,80),x:r.x+insetX,y:r.y+insetY,w:Math.max(1,r.w-insetX-2),h:Math.max(1,r.h-insetY-2)};rooms.push(room);
  for(let y=room.y;y<=room.y+room.h;y++)for(let x=room.x;x<=room.x+room.w;x++)carve(x,y);
  if(i){const center=r=>({x:Math.floor(r.x+r.w/2),y:Math.floor(r.y+r.h/2)}),target=center(room),previous=rooms.slice(0,-1).sort((a,b)=>Math.hypot(center(a).x-target.x,center(a).y-target.y)-Math.hypot(center(b).x-target.x,center(b).y-target.y))[0];let {x,y}=center(previous);
   const corridor=()=>{carve(x,y);carve(x+1,y);carve(x,y+1);carve(x+1,y+1);};const horizontal=()=>{while(x!==target.x){corridor();x+=Math.sign(target.x-x);}},vertical=()=>{while(y!==target.y){corridor();y+=Math.sign(target.y-y);}};if(random()<.5){horizontal();vertical();}else{vertical();horizontal();}corridor();
  }
 }
 if(descriptor.environment==='outdoor')tiles.fill(0);
 if(descriptor.environment==='cave')for(let pass=0;pass<3;pass++){
  const grown=[];for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++)if(tiles[y*width+x]===1&&[tiles[y*width+x-1],tiles[y*width+x+1],tiles[(y-1)*width+x],tiles[(y+1)*width+x]].includes(0)&&random()<.3)grown.push([x,y]);for(const [x,y] of grown)carve(x,y);
 }
 const floor=[];for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++)if(tiles[y*width+x]===0)floor.push({x,y});
 const side=descriptor.entrySide,edge=p=>side==='north'?p.y:side==='south'?height-p.y:side==='west'?p.x:width-p.x;floor.sort((a,b)=>edge(a)-edge(b));
 const anchor=floor[0],start=floor.filter(p=>Math.abs(p.x-anchor.x)+Math.abs(p.y-anchor.y)<Math.max(8,Math.floor(width/2))).slice(0,40);
 const doors=[];if(descriptor.environment==='interior')for(const p of floor){
  if(doors.length>=6)break;const {x,y}=p;
  if(start.some(c=>c.x===x&&c.y===y)||rooms.some(r=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h)||doors.some(d=>Math.abs(d.x-x)+Math.abs(d.y-y)<3))continue;
  const at=(dx,dy)=>tiles[(y+dy)*width+x+dx];let span=[];
  if(at(0,-1)===1&&at(0,1)===0&&at(0,2)===1&&[-1,1].every(dx=>at(dx,0)===0&&at(dx,1)===0))span=[{x,y},{x,y:y+1}];
  else if(at(-1,0)===1&&at(1,0)===0&&at(2,0)===1&&[-1,1].every(dy=>at(0,dy)===0&&at(1,dy)===0))span=[{x,y},{x:x+1,y}];
  else if(at(-1,0)===1&&at(1,0)===1&&at(0,-1)===0&&at(0,1)===0||at(0,-1)===1&&at(0,1)===1&&at(-1,0)===0&&at(1,0)===0)span=[{x,y}];
  for(const cell of span)doors.push({id:'door-'+doors.length,...cell,open:false});
 }
 return {id:crypto.randomUUID(),width,height,tiles,rooms,start,doors,entrySide:side,title:String(descriptor.title).slice(0,120),environment:descriptor.environment,visualPrompt:String(descriptor.visualPrompt||'top-down battle map').slice(0,2000),seed,createdAt:new Date().toISOString()};
}
export function populateMap(game,descriptor){
 game.actors=game.actors.filter(a=>a.player);placePlayers(game);const occupied=new Set(game.actors.map(a=>a.x+','+a.y)),start=new Set(game.map.start.map(p=>p.x+','+p.y));
 const floor=[];for(let y=1;y<game.map.height-1;y++)for(let x=1;x<game.map.width-1;x++)if(game.map.tiles[y*game.map.width+x]===0&&!occupied.has(x+','+y)&&!start.has(x+','+y)&&!game.map.doors?.some(d=>d.x===x&&d.y===y&&!d.open))floor.push({x,y});
 descriptor.npcs.slice(0,8).forEach((n,i)=>{if(!floor.length)return;const npc={...npcActor(n,i),archetype:['warrior','archer','mage','healer','beast'].includes(n.archetype)?n.archetype:'warrior',mana:game.rules.mana,maxMana:game.rules.mana,actions:game.rules.actions,bonusActions:game.rules.bonusActions,move:game.rules.move},cell=floor.splice(Math.floor(floor.length/2),1)[0];if(game.version===2){npc.abilities.dexterity={warrior:10,archer:14,mage:12,healer:8,beast:14}[npc.archetype];if(npc.abilities.dexterity===14)npc.abilities.intelligence=9;}Object.assign(npc,cell);game.actors.push(npc);});game.inCombat=false;game.order=[];
}
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function chunk(type,data){const t=Buffer.from(type),body=Buffer.concat([t,data]);let crc=0xffffffff;for(const byte of body)crc=crcTable[(crc^byte)&255]^(crc>>>8);const len=Buffer.alloc(4),end=Buffer.alloc(4);len.writeUInt32BE(data.length);end.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([len,body,end]);}
export function mapPNG(map,kind='layout'){
 if(!['layout','depth','normal','wall_mask'].includes(kind))throw new Error('Неизвестный слой карты.');
 const scale=Math.min(4096/Math.max(map.width,map.height),Math.max(1024/Math.min(map.width,map.height),1024/24));
 const width=Math.ceil(map.width*scale/64)*64,height=Math.ceil(map.height*scale/64)*64,pixels=Buffer.alloc((width*3+1)*height);
 const heights=Uint8Array.from(map.tiles,v=>v?1:0);for(const d of map.doors||[])if(!d.open)heights[d.y*map.width+d.x]=1;
 const h=(x,y)=>{const tx=Math.max(0,Math.min(map.width-1,Math.floor(x/width*map.width))),ty=Math.max(0,Math.min(map.height-1,Math.floor(y/height*map.height)));return heights[ty*map.width+tx];};
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const wall=h(x,y),offset=y*(width*3+1)+1+x*3;let rgb;
  if(kind==='wall_mask')rgb=[wall?255:0,wall?255:0,wall?255:0];
  else if(kind==='depth')rgb=[wall?230:40,wall?230:40,wall?230:40];
  else if(kind==='normal'){const dx=(h(x+2,y)-h(x-2,y))*2,dy=(h(x,y+2)-h(x,y-2))*2,len=Math.hypot(dx,dy,1);rgb=[Math.round((-dx/len*.5+.5)*255),Math.round((dy/len*.5+.5)*255),Math.round((1/len*.5+.5)*255)];}
  else rgb=wall?[38,42,50]:map.environment==='outdoor'?[88,111,73]:map.environment==='cave'?[115,103,88]:[162,146,122];
  pixels[offset]=rgb[0];pixels[offset+1]=rgb[1];pixels[offset+2]=rgb[2];
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
