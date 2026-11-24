import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {speechBundleDirectory,speechStorageDirectory} from '../server/tts/storage.mjs';

test('Developer Electron finds bundled speech in the source tree when its resources directory has no speech folder',()=>{
 const resourcesPath=path.resolve('runtime/desktop-shell/version/resources'),sourceRoot=path.resolve('runtime/speech');
 assert.equal(speechBundleDirectory({environment:{},resourcesPath,sourceRoot,exists:directory=>directory===sourceRoot}),sourceRoot);
});

test('Portable speech bundle is found beside app and explicit bundle configuration keeps priority',()=>{
 const resourcesPath=path.resolve('portable/app/resources'),portable=path.resolve('portable/engines/speech'),sourceRoot=path.resolve('missing');
 assert.equal(speechBundleDirectory({environment:{},resourcesPath,sourceRoot,exists:directory=>directory===portable}),portable);
 const configured=path.resolve('custom-speech');assert.equal(speechBundleDirectory({environment:{SAS_SPEECH_BUNDLE_DIR:configured},resourcesPath,sourceRoot,exists:()=>false}),configured);
});

test('Disconnected model drives return an actionable error before recursive mkdir sees a Windows namespace root',async()=>{
 const directory=path.win32.join('Z:'+path.win32.sep,'AI модели');let checked;
 await assert.rejects(speechStorageDirectory(directory,{platform:'win32',access:async volume=>{checked=volume;throw Object.assign(Error('ENOENT'),{code:'ENOENT'});}}),error=>error.status===409&&error.code==='SPEECH_STORAGE_UNAVAILABLE'&&error.message.includes(directory)&&error.message.includes('Модели и API')&&!error.message.includes('mkdir'));
 assert.equal(checked,'Z:'+path.win32.sep);
 assert.equal(await speechStorageDirectory(directory,{platform:'win32',access:async()=>{}}),path.win32.join(directory,'sas-tts'));
});
