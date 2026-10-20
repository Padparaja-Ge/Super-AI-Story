import * as ort from 'onnxruntime-node';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {normalizePhonemes,phonemeIds,russianText} from './phoneme-normalize.mjs';
let loaded,session,vocab;
function phonemes(text,language){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(import.meta.dirname,'phonemes.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});let output='';child.stdout.on('data',d=>output+=d);child.stderr.resume();child.once('error',reject);child.once('exit',code=>{try{if(code)throw new Error('eSpeak не смог обработать текст.');resolve(JSON.parse(output));}catch(e){reject(e);}});child.stdin.on('error',reject);child.stdin.end(JSON.stringify({text,language}));});}
function wav(samples){const b=Buffer.alloc(44+samples.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples.length*2,40);for(let i=0;i<samples.length;i++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);return b;}
let chain=Promise.resolve();process.on('message',r=>{chain=chain.then(async()=>{try{
 const stem=r.provider==='kokoro-ru'&&r.voice==='dima'?'model_dima':'model',full=path.join(r.folder,'onnx',stem+'.onnx'),quantized=path.join(r.folder,'onnx',stem+'_quantized.onnx'),file=r.device==='gpu'?full:await fs.access(quantized).then(()=>quantized,()=>full),key=JSON.stringify([file,r.device,r.threads]);
 if(loaded!==key){await session?.release();const available=ort.listSupportedBackends().filter(b=>b.bundled).map(b=>b.name),ep=r.device==='gpu'?(process.platform==='win32'?'dml':'cuda'):'cpu';if(!available.includes(ep))throw new Error('GPU для Kokoro недоступен в этой сборке. Выберите CPU.');session=await ort.InferenceSession.create(file,{executionProviders:[ep],intraOpNumThreads:r.threads,interOpNumThreads:1,executionMode:'sequential',enableMemPattern:ep!=='dml'});loaded=key;
 if(r.provider==='kokoro-ru')vocab=JSON.parse(await fs.readFile(path.join(r.folder,'config.json'),'utf8')).vocab;else {const tokenizer=JSON.parse(await fs.readFile(path.join(r.folder,'tokenizer.json'),'utf8'));vocab=tokenizer.model.vocab;}
 }
 const ipa=normalizePhonemes(await phonemes(r.language.startsWith('ru')?russianText(r.text):r.text,r.language),r.language),ids=phonemeIds(ipa,vocab);if(!ids.length)throw new Error('Нет произносимого текста.');
 const voice=await fs.readFile(path.join(r.folder,'voices',r.voice+'.bin')),pack=new Float32Array(voice.buffer.slice(voice.byteOffset,voice.byteOffset+voice.byteLength)),parts=[];
 // Phoneme expansion can exceed the model window even after sentence splitting.
 // Split at word boundaries and synthesize bounded parts in this child process.
 for(let start=0;start<ids.length;){let end=Math.min(start+508,ids.length);if(end<ids.length){const space=ids.lastIndexOf(vocab[' '],end-1);if(space>start+254)end=space+1;}const tokens=ids.slice(start,end),row=pack.slice((tokens.length-1)*256,tokens.length*256);if(row.length!==256)throw new Error('Повреждён файл голоса.');const result=await session.run({input_ids:new ort.Tensor('int64',BigInt64Array.from([0,...tokens,0].map(BigInt)),[1,tokens.length+2]),style:new ort.Tensor('float32',row,[1,256]),speed:new ort.Tensor('float32',Float32Array.of(r.speed),[1])});parts.push(Object.values(result)[0].data);start=end;}
 const audio=new Float32Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){audio.set(p,at);at+=p.length;}process.send({id:r.id,audio:wav(audio).toString('base64'),duration:audio.length/24000});
 }catch(e){process.send({id:r.id,error:e.message});}});});
