// Apply explicit translation calls only to UI text. Data, prompts, option values,
// event handlers and comparisons are deliberately left untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import os from 'node:os';

export function localizeSource(code,file){
 const ast=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const textAttributes=new Set(['label','hint','title','placeholder','aria-label','aria-description','alt','description','eyebrow']);
 const add=(node,text)=>edits.push({start:node.getStart(ast),end:node.end,text});
 const wrap=node=>add(node,`t(${code.slice(node.getStart(ast),node.end)})`);
 function display(node){
  if(ts.isStringLiteralLike(node)){if(/[А-Яа-яЁё]/u.test(node.text))wrap(node);return;}
  if(ts.isTemplateExpression(node)&&/[А-Яа-яЁё]/u.test(node.getText(ast))){
   const key=node.head.text+node.templateSpans.map((s,i)=>`{${i}}`+s.literal.text).join('');
   add(node,`t(${JSON.stringify(key)},[${node.templateSpans.map(s=>s.expression.getText(ast)).join(',')}])`);return;
  }
  if(ts.isConditionalExpression(node)){display(node.whenTrue);display(node.whenFalse);return;}
  if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)){display(node.right);return;}
  if(ts.isIdentifier(node)&&['label','hint','error','loadError','saveStatus'].includes(node.text)||ts.isPropertyAccessExpression(node)&&['label','hint','error','stage','message'].includes(node.name.text))wrap(node);
 }
 function visit(node){
  if(ts.isJsxText(node)&&/[А-Яа-яЁё]/u.test(node.text)){
   // React collapses source whitespace in JSX text. Keep the same rendering.
   const lines=node.text.replace(/\r/g,'').split('\n');let value='';
   for(let i=0;i<lines.length;i++){let line=lines[i].replace(/\t/g,' ');if(i>0)line=line.replace(/^ +/,'');if(i<lines.length-1)line=line.replace(/ +$/,'');if(line)value+=line+(i<lines.length-1?' ':'');}
   const literal=ts.transpileModule(`const x=<span>${value}</span>`,{compilerOptions:{jsx:ts.JsxEmit.React}}).outputText.match(/React\.createElement\("span", null, ("(?:[^"\\]|\\.)*")\)/)?.[1];
   value=literal?JSON.stringify(JSON.parse(literal)):JSON.stringify(value);
   edits.push({start:node.pos,end:node.end,text:`{t(${value})}`});return;
  }
  if(ts.isJsxAttribute(node)){
   if(textAttributes.has(node.name.getText(ast))&&node.initializer){const value=node.initializer;if(ts.isStringLiteral(value)&&/[А-Яа-яЁё]/u.test(value.text))add(value,`{t(${JSON.stringify(value.text)})}`);else if(ts.isJsxExpression(value)&&value.expression)display(value.expression);}
   return; // Never translate a form's stored value or callback body.
  }
  if(ts.isJsxExpression(node)&&node.expression){display(node.expression);}
  ts.forEachChild(node,visit);
 }
 visit(ast);
 if(!edits.length)return code;
 const ordered=edits.sort((a,b)=>b.start-a.start);let result=code,last=code.length;
 for(const edit of ordered){if(edit.end>last)throw new Error('Overlapping localization edits: '+file);result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);last=edit.start;}
 if(!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"]\.\/i18n['"]/.test(result))result="import {t} from './i18n';\n"+result;
 return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const changes=[];
 for(const file of await fs.readdir('src'))if(file.endsWith('.tsx')&&file!=='InterfaceLanguage.tsx'){
  const name=path.join('src',file),code=await fs.readFile(name,'utf8'),translated=localizeSource(code,file);
  if(code!==translated){const parsed=ts.createSourceFile(file,translated,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);if(parsed.parseDiagnostics.length)throw new Error('Invalid generated JSX: '+file);changes.push({name,code,translated});}
 }
 console.log(JSON.stringify({changedFiles:changes.length,mode:process.argv.includes('--apply')?'apply':'preview',translationCalls:changes.reduce((n,c)=>n+(c.translated.match(/\bt\(/g)||[]).length,0)}));
 if(process.argv.includes('--apply')){
  const backup=await fs.mkdtemp(path.join(os.tmpdir(),'sas-ui-source-backup-'));console.log('Original UI source backup: '+backup);
  for(const change of changes)await fs.writeFile(path.join(backup,path.basename(change.name)),change.code);
  for(const change of changes)await fs.writeFile(change.name,change.translated);
 }
}
