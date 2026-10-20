import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import path from 'node:path';
import express from 'express';
const allowed=new Set(['status','method','route','kind','code','durationMs','provider','port','version','count','name']);
export function safeDiagnostic(event,fields={}){
 const data={time:new Date().toISOString(),event:String(event).replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80)};
 for(const [key,value] of Object.entries(fields))if(allowed.has(key)&&['string','number','boolean'].includes(typeof value))data[key]=typeof value==='string'?value.replace(/https?:\/\/\S+|Bearer\s+\S+|(?:api[_-]?key|token|password|code)=\S+/gi,'[redacted]').slice(0,160):value;
 return data;
}
export function createDiagnostics({dataDir,maxBytes=2*1024*1024,retained=3}={}){
 const directory=path.resolve(dataDir,'logs'),file=path.join(directory,'sas.jsonl');let bytes=0,serial=Promise.resolve(),queued=0,dropped=0,closed=false,lastError='';
 const ready=fs.mkdir(directory,{recursive:true}).then(async()=>{bytes=(await fs.stat(file).catch(()=>({size:0}))).size;});ready.catch(()=>{});
 const record=(event,fields)=>{
  if(closed)return;if(queued>=512){dropped++;return;}const line=JSON.stringify(safeDiagnostic(event,fields))+'\n';queued++;
  serial=serial.catch(()=>{}).then(async()=>{await ready;if(bytes+Buffer.byteLength(line)>maxBytes){await fs.unlink(file+'.'+retained).catch(()=>{});for(let n=retained-1;n>=1;n--)await fs.rename(file+'.'+n,file+'.'+(n+1)).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rename(file,file+'.1').catch(e=>{if(e.code!=='ENOENT')throw e;});bytes=0;}await fs.appendFile(file,line,{mode:0o600});bytes+=Buffer.byteLength(line);}).catch(e=>{lastError=e.code||'LOG_WRITE_FAILED';}).finally(()=>{queued--;});
 };
 const fatal=error=>{try{appendFileSync(file,JSON.stringify(safeDiagnostic('process_fatal',{name:error?.name||'Error',code:error?.code||'UNCAUGHT'}))+'\n',{mode:0o600});}catch{}};
 const router=express.Router();
 router.get('/',async(_req,res)=>{await ready;res.json({directory,file,maxBytes,retained,dropped,error:lastError});});
 router.get('/entries',async(_req,res)=>{await ready;await serial;const raw=await fs.readFile(file,'utf8').catch(()=>''),entries=raw.trim().split('\n').slice(-200).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);res.set('Cache-Control','no-store').json({entries,dropped});});
 router.get('/export',async(_req,res)=>{await ready;await serial;res.set({'Content-Type':'application/x-ndjson; charset=utf-8','Content-Disposition':'attachment; filename="SAS-diagnostics.jsonl"','Cache-Control':'no-store'});for(let n=retained;n>=0;n--){const raw=await fs.readFile(file+(n?'.'+n:''),'utf8').catch(()=>null);if(raw)res.write(raw);}res.end();});
 router.post('/frontend',(req,res)=>{record('frontend_error',{name:['Error','TypeError','ReferenceError','UnhandledRejection','RenderError'].includes(req.body?.name)?req.body.name:'Error',code:'FRONTEND'});res.sendStatus(204);});
 record('session_start');
 return {ready,router,record,fatal,flush:()=>serial,close:async()=>{record('session_stop');closed=true;await serial;}};
}
