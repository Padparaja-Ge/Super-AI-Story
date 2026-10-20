import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createStartup}=require('../electron/startup.cjs');
test('Public edition migrates removed voices and unsupported languages without altering developer settings',async()=>{
 const source=(await fs.readFile(new URL('../shared/speech-edition.mjs',import.meta.url),'utf8')).replace("defaultProvider:'kokoro-ru',disabledProviders:[]","defaultProvider:'silero',disabledProviders:['kokoro','kokoro-ru']");
 const {normalizeSpeechEdition}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const old={provider:'kokoro',language:'fr',customAdapter:'kokoro',silero:{modelRu:'v3_1_ru',modelEn:'v3_en',voice:'kseniya',englishVoice:'en_0'},characterVoices:{hero:{provider:'kokoro',voice:'af_heart'}},gmVoice:{provider:'kokoro-ru',voice:'dima'}};
 const migrated=normalizeSpeechEdition(old);assert.equal(migrated.provider,'silero');assert.equal(migrated.language,'auto');assert.equal(migrated.customAdapter,'endpoint');assert.equal(migrated.characterVoices.hero.language,'en');assert.equal(migrated.gmVoice.language,'ru');assert.equal(old.provider,'kokoro');assert.equal(old.characterVoices.hero.provider,'kokoro');
});
test('Startup progress is monotonic and stays complete after background core requests',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sas-startup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));
 const old=process.env.SAS_STARTUP_FILE;process.env.SAS_STARTUP_FILE=path.join(dir,'status.json');t.after(()=>{if(old===undefined)delete process.env.SAS_STARTUP_FILE;else process.env.SAS_STARTUP_FILE=old;});
 const startup=createStartup({web:true});startup.report(50,'core');startup.report(25,'old phase');assert.equal(startup.state.progress,50);
 startup.finish({url:'http://127.0.0.1:3212'});const complete=await fs.readFile(process.env.SAS_STARTUP_FILE,'utf8');startup.report(65,'background heartbeat');
 assert.equal(await fs.readFile(process.env.SAS_STARTUP_FILE,'utf8'),complete);assert.equal(startup.state.complete,true);assert.equal(startup.state.progress,100);
 startup.fail(new Error('Interface load failed'));assert.equal(startup.state.error,'Interface load failed');assert.equal(startup.state.complete,true);
});
