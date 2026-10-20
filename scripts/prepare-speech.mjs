import fs from 'node:fs/promises';
import path from 'node:path';
import {downloadFile} from '../server/tts/installer.mjs';
import {prepareSilero} from './prepare-silero.mjs';

// Build-time preparation only. Optional TTS weights are never downloaded here.
const root=path.resolve(import.meta.dirname,'..');
const catalog=JSON.parse(await fs.readFile(path.join(root,'server/tts/catalog.json'),'utf8'));
for(const model of catalog.filter(model=>model.id.startsWith('kokoro'))){
  for(const file of model.files){
    await downloadFile(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`,path.join(root,'runtime/speech/models',model.id,...file.path.split('/')),file);
  }
  await fs.writeFile(path.join(root,'runtime/speech/models',model.id,'sas-installed.json'),JSON.stringify({provider:model.id,revision:model.revision,bytes:model.bytes}));
  console.log(model.id+': verified');
}
await downloadFile('https://codeload.github.com/ianmarmour/espeak-ng.js/zip/eec88dbcc1482b1a03a76cf9d2025a0acde8982e',path.join(root,'server/third-party/espeak-ng.js-source-1.0.2.zip'),{
  size:9226260,sha256:'8610667fe02c798ba1544bb82fc22bab62d3c7447784245da48f8c74b36dc63d'
});
console.log('eSpeak upstream source: verified');

await prepareSilero();
