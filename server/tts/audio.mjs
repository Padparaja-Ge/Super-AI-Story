import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {run} from './installer.mjs';
export const MAX_REFERENCE_BYTES=16_000_000;
const fail=message=>Object.assign(new Error(message),{status:400});
export function wavDuration(bytes){
 if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw fail('Аудиофайл не удалось прочитать.');
 let offset=12,rate=0,dataBytes=0,pcm=false;
 while(offset+8<=bytes.length){const tag=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4);if(offset+8+length>bytes.length)throw fail('Повреждённый WAV.');if(tag==='fmt '&&length>=16){const channels=bytes.readUInt16LE(offset+10),sampleRate=bytes.readUInt32LE(offset+12),bits=bytes.readUInt16LE(offset+22);pcm=bytes.readUInt16LE(offset+8)===1;rate=bytes.readUInt32LE(offset+16);if(!channels||channels>8||sampleRate<8000||sampleRate>192000||![8,16,24,32].includes(bits)||rate!==sampleRate*channels*bits/8)throw fail('Повреждённый формат WAV.');}if(tag==='data')dataBytes+=length;offset+=8+length+(length%2);}
 const duration=dataBytes/rate;if(!pcm||!Number.isFinite(duration)||duration<3||duration>30)throw fail('Образец голоса должен длиться 3–30 секунд.');return duration;
}
export async function ffmpegExecutable(runtimes=[]){
 if(process.env.SAS_TTS_FFMPEG)return process.env.SAS_TTS_FFMPEG;
 try{await run('ffmpeg',['-version']);return 'ffmpeg';}catch{}
 for(const runtime of runtimes){try{return (await run(path.join(runtime,process.platform==='win32'?'Scripts/python.exe':'bin/python'),['-c','import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'])).trim();}catch{}}
 throw fail('Декодер аудио не установлен. Нажмите «Установить движок» для XTTS/Fish, затем повторите импорт.');
}
export async function convertReference(bytes,{runtimes=[],ffmpeg}={}){
 if(!bytes.length||bytes.length>MAX_REFERENCE_BYTES)throw fail('Аудиообразец: не более 16 МБ.');
 // Keep existing PCM references usable, including offline migration.
 try{return {bytes,duration:wavDuration(bytes)};}catch{}
 const exe=ffmpeg||await ffmpegExecutable(runtimes),folder=await fs.mkdtemp(path.join(os.tmpdir(),'sas-voice-')),input=path.join(folder,'input'),output=path.join(folder,'voice.wav');
 try{
  await fs.writeFile(input,bytes);
  await new Promise((resolve,reject)=>{const child=spawn(exe,['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',input,'-t','31','-map','0:a:0','-vn','-ac','1','-ar','24000','-c:a','pcm_s16le','-map_metadata','-1',output],{windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>{child.kill();reject(fail('Превышено время обработки аудио.'));},30000);child.once('error',()=>{clearTimeout(timer);reject(fail('Декодер аудио не запустился. Повторите установку движка.'));});child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(fail('Файл не содержит поддерживаемую аудиозапись.'));});});
  const converted=await fs.readFile(output);return {bytes:converted,duration:wavDuration(converted)};
 }finally{await fs.rm(folder,{recursive:true,force:true});}
}
