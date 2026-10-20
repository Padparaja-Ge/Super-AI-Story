import fs from 'node:fs/promises';
import path from 'node:path';
import {createWriteStream} from 'node:fs';
import archiver from 'archiver';

const root=path.resolve(import.meta.dirname,'..');
const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const output=path.join(root,'release',metadata.version);await fs.mkdir(output,{recursive:true});
await fs.access(path.join(root,'dist/index.html'));
const filename=path.join(output,'SAS-Web-'+metadata.version+'.zip'),temporary=filename+'.building';
const stream=createWriteStream(temporary,{flags:'wx'}),zip=archiver('zip',{zlib:{level:6}});
const done=new Promise((resolve,reject)=>{stream.once('close',resolve);stream.once('error',reject);zip.once('error',reject);});zip.pipe(stream);
for(const folder of ['dist','server','shared','docs','examples']){
 zip.glob('**/*',{cwd:path.join(root,folder),dot:true,ignore:['**/__pycache__/**','**/*.pyc','**/*.zip','**/*.log']},{prefix:folder});
}
for(const name of ['package.json','package-lock.json','COPYRIGHT.md','LICENSE','NOTICE','THIRD-PARTY.md','.env.example','web-server.json','scripts/check-node.cmd','scripts/package-extension.mjs','Start-SAS-Web.cmd','Start-SAS-Web-Shell.cmd','Start-SAS-Web-Safe.cmd','start-web.sh'])zip.file(path.join(root,name),{name});
zip.append('# SAS Web\n\nNode.js 22+ is required. Run `npm ci --omit=dev`, then `npm run web`. Open http://127.0.0.1:3212. Stop with Ctrl+C.\n\nLocal engine binaries and model weights are not bundled. Configure an API or install the desired components separately. Full source and documentation: https://github.com/Padparaja-Ge/Super-AI-Story\n\nSee LICENSE, COPYRIGHT.md and THIRD-PARTY.md for licensing.\n',{name:'README.md'});
try{await zip.finalize();await done;await fs.rename(temporary,filename);console.log(filename);}
catch(error){stream.destroy();throw error;}
