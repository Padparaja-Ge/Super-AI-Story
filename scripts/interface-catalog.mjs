// Offline maintenance: extract UI keys or import hand-authored TSV translations.
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
const languages=['en','ja','zh-CN','ko'];
if(process.argv[2]==='import'){
 const keys=JSON.parse(await fs.readFile('shared/locales/source.json','utf8'));
 const catalogs=await Promise.all(languages.map(async language=>JSON.parse(await fs.readFile(`shared/locales/${language}.json`,'utf8').catch(()=>'{}'))));
 const rows=(await fs.readFile(process.argv[3],'utf8')).trim().split(/\r?\n/);
 for(const row of rows){if(!row.trim())continue;const [id,...values]=row.split('\t'),key=keys[Number(id)];if(!key||values.length!==4||values.some(value=>!value.trim()))throw Error('Invalid translation row: '+id);for(let i=0;i<4;i++)catalogs[i][key]=values[i];}
 for(let i=0;i<4;i++)await fs.writeFile(`shared/locales/${languages[i]}.json`,JSON.stringify(catalogs[i],null,2)+'\n');
 console.log('Imported '+rows.length+' rows. Total '+Object.keys(catalogs[0]).length);process.exit(0);
}
if(process.argv[2]==='list'){
 const keys=JSON.parse(await fs.readFile('shared/locales/source.json','utf8')),start=Number(process.argv[3])||0,count=Number(process.argv[4])||100;
 const known=JSON.parse(await fs.readFile('shared/locales/en.json','utf8'));
 for(let i=start;i<Math.min(keys.length,start+count);i++)console.log(i+'\t'+keys[i]+(known[keys[i]]?' [DONE]':''));process.exit(0);
}
const keys=new Set(),add=value=>{value=value.trim();if(value&&/[А-Яа-яЁё]/u.test(value))keys.add(value);};
for(const file of await fs.readdir('src'))if(/\.(?:ts|tsx)$/.test(file)){
 const ast=ts.createSourceFile(file,await fs.readFile(path.join('src',file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function visit(node){
  if(ts.isCallExpression(node)&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])&&(['t','notify','Error'].includes(node.expression.getText(ast))))add(node.arguments[0].text);
  if(ts.isStringLiteralLike(node)&&ts.isArrayLiteralExpression(node.parent))add(node.text);
  if(ts.isStringLiteralLike(node)&&ts.isPropertyAssignment(node.parent)&&['label','hint'].includes(node.parent.name.getText(ast)))add(node.text);
  ts.forEachChild(node,visit);
 }visit(ast);
}
for(const file of ['shared/onboarding.mjs','shared/local-options.mjs','shared/model-profiles.mjs','shared/srp.mjs','shared/equipment.mjs','shared/rpg-rules.mjs','server/gguf-compat.mjs']){
 const ast=ts.createSourceFile(file,await fs.readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 function visit(node){if(ts.isStringLiteralLike(node)){
  if(ts.isPropertyAssignment(node.parent)&&['label','hint','title','description','action','tip'].includes(node.parent.name.getText(ast))||file.includes('onboarding')&&ts.isArrayLiteralExpression(node.parent)||file.includes('model-profiles')&&ts.isPropertyAssignment(node.parent)&&['name','note'].includes(node.parent.name.getText(ast)))add(node.text);
  if(['shared/srp.mjs','shared/equipment.mjs','shared/rpg-rules.mjs'].includes(file)){
   let parent=node.parent;while(parent&&!ts.isVariableDeclaration(parent))parent=parent.parent;
   if(parent&&/Names$|Slots$|Help$|checkSkills/.test(parent.name.getText(ast)))add(node.text);
  }
  if(file.includes('gguf-compat'))add(node.text);
 }ts.forEachChild(node,visit);}visit(ast);
}
for(const item of JSON.parse(await fs.readFile('src/palette.json','utf8')))add(item.label.split(' · ')[0]);
for(const file of ['server/room-client.js','server/room-game.js','server/room-sheet.js','server/room-media-client.js','src/fanficWorkbench.ts']){
 const ast=ts.createSourceFile(file,await fs.readFile(file,'utf8'),ts.ScriptTarget.Latest,true);
 function visit(node){if(ts.isStringLiteralLike(node)&&!node.text.includes('<'))add(node.text);ts.forEachChild(node,visit);}visit(ast);
 const code=await fs.readFile(file,'utf8');if(file.includes('room-media-client'))for(const match of code.matchAll(/>([^<>]+)</g))add(match[1]);
}
const page=await fs.readFile('server/room-page.html','utf8');for(const match of page.replace(/<style[\s\S]*?<\/style>/g,'').matchAll(/>([^<>]+)</g))if(!match[1].includes(' / Language'))add(match[1]);for(const match of page.matchAll(/(?:aria-label|placeholder)="([^"]+)"/g))add(match[1]);
const existing=JSON.parse(await fs.readFile('shared/locales/source.json','utf8').catch(()=>'[]'));
const sorted=[...existing,...[...keys].filter(key=>!existing.includes(key)).sort((a,b)=>a.length-b.length||a.localeCompare(b,'ru'))];
await fs.writeFile('shared/locales/source.json',JSON.stringify(sorted,null,2)+'\n');console.log(JSON.stringify({keys:sorted.length,characters:sorted.join('').length}));
