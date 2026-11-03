import fs from 'node:fs/promises';
import ts from 'typescript';
for(const file of ['server/room-client.js','server/room-game.js','server/room-sheet.js','server/room-media-client.js']){
 const code=await fs.readFile(file,'utf8'),ast=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];
 const wrap=node=>edits.push({start:node.getStart(ast),end:node.end,text:`uiText(${node.getText(ast)})`});
 function display(node){
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='uiText')return;
  if(ts.isStringLiteralLike(node)){if(/[А-Яа-яЁё]/u.test(node.text))wrap(node);return;}
  if(ts.isTemplateExpression(node)&&/[А-Яа-яЁё]/u.test(node.getText(ast))){const key=node.head.text+node.templateSpans.map((s,i)=>`{${i}}`+s.literal.text).join('');edits.push({start:node.getStart(ast),end:node.end,text:`uiText(${JSON.stringify(key)},[${node.templateSpans.map(s=>s.expression.getText(ast)).join(',')}])`});return;}
  if(ts.isConditionalExpression(node)){display(node.whenTrue);display(node.whenFalse);return;}
  if(ts.isBinaryExpression(node)){display(node.left);display(node.right);return;}
  if(ts.isIdentifier(node)&&['label','n'].includes(node.text)||ts.isElementAccessExpression(node)&&['names','abilityNames','damageNames','armorNames','armorSlots','weightNames'].includes(node.expression.getText(ast)))wrap(node);
 }
 function visit(node){
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&['textContent','placeholder','title'].includes(node.left.name.text))display(node.right);
  if(ts.isCallExpression(node)&&['el','node','input'].includes(node.expression.getText(ast))&&node.arguments[1])display(node.arguments[1]);
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='error'&&node.arguments[0])display(node.arguments[0]);
  if(ts.isNewExpression(node)&&['Option','Error'].includes(node.expression.getText(ast))&&node.arguments?.[0])display(node.arguments[0]);
  ts.forEachChild(node,visit);
 }visit(ast);
 let result=code,last=code.length;for(const edit of edits.sort((a,b)=>b.start-a.start)){if(edit.end>last)continue;result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);last=edit.start;}
 const parsed=ts.createSourceFile(file,result,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);if(parsed.parseDiagnostics.length)throw Error('Invalid guest syntax: '+file);
 await fs.writeFile(file,result);console.log(file+': '+edits.length+' UI expressions');
}
