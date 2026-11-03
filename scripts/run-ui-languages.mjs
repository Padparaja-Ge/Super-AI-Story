import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const code=await new Promise((resolve,reject)=>{const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'scripts/qa-interface-languages.cjs')],{env,cwd:root,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',resolve);});
// Chromium holds profile databases until exit. Remove only this test's exact
// temporary directory after the child releases it, never from inside Electron.
const receipt=path.join(root,'qa-artifacts/interface-languages/test-data-path.txt');
try{const dir=path.resolve(await fs.readFile(receipt,'utf8'));if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('sas-languages-ui-'))throw Error('Unexpected UI test cleanup path');const stat=await fs.lstat(dir);if(stat.isSymbolicLink())throw Error('Test directory is a link');await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});await fs.unlink(receipt);}catch(error){if(error.code!=='ENOENT')throw error;}
process.exitCode=code||0;
