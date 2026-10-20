import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// A tiny DOM surface makes the real message renderer testable without adding
// a second browser automation runtime. Descendant selectors follow DOM order,
// so the historical avatar/content collision is reproduced by these tests.
class Element{
 constructor(tag,text=''){this.tagName=tag;this.children=[];this.parent=null;this.className='';this.value='';this.scrollHeight=1000;this.scrollTop=900;this.clientHeight=100;this._text=text;}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
 get textContent(){return this._text+this.children.map(item=>item.textContent).join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 querySelector(selector){
  const match=node=>selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tagName===selector;
  if(selector===':scope > img')return this.children.find(node=>node.tagName==='img')||null;
  for(const node of this.children){if(match(node))return node;const found=node.querySelector(selector);if(found)return found;}
  return null;
 }
}
const source=await fs.readFile(new URL('../server/room-client.js',import.meta.url),'utf8');
const ast=ts.createSourceFile('room-client.js',source,ts.ScriptTarget.ES2022,true);
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&['avatarElement','addMessage'].includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');
function fixture(){
 const nodes=new Map([['messages',new Element('div')],['code',new Element('input')]]);nodes.get('code').value='qa-code';
 const document={createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)};
 const context=vm.createContext({document,room:{avatars:{player:'✦'}},messages:new Map(),archive:new Map(),boxes:new Map(),$:id=>nodes.get(id)});
 vm.runInContext(functions,context);return {...context,container:nodes.get('messages')};
}

test('Guest text survives nested avatar spans, editing and a preceding generated image',()=>{
 const ui=fixture();
 ui.addMessage({id:'picture',role:'assistant',kind:'image',imageId:'scene',imageCount:1,name:'Хост',content:'Изображение сцены'});
 ui.addMessage({id:'player',role:'user',userId:'player',name:'Алина',content:'Я открываю дверь.'});
 const post=ui.boxes.get('player');
 assert.equal(post.querySelector('.persona-avatar').textContent,'✦');
 assert.equal(post.querySelector('.message-content').textContent,'Я открываю дверь.');
 ui.addMessage({id:'player',role:'user',userId:'player',name:'Алина',content:'Я осторожно открываю дверь.',editedAt:'2026-10-08'});
 assert.equal(post.querySelector('.persona-avatar').textContent,'✦');
 assert.equal(post.querySelector('.message-content').textContent,'Я осторожно открываю дверь.');
 assert.equal(ui.container.children.length,2);
 assert.equal(ui.boxes.get('picture').querySelector(':scope > img').src,'/media/scene/0?code=qa-code');
});

test('Assistant streaming updates one message and never overwrites its byline avatar',()=>{
 const ui=fixture();
 for(const content of ['Герои входят','Герои входят в таверну.'])ui.addMessage({id:'gm',role:'assistant',name:'AI Game Master',content});
 assert.equal(ui.container.children.length,1);
 assert.equal(ui.boxes.get('gm').querySelector('.message-content').textContent,'Герои входят в таверну.');
 assert.equal(ui.boxes.get('gm').querySelector('.persona-avatar').textContent,'✧');
});

test('New text does not drag a reader away from earlier chat messages',()=>{
 const ui=fixture();ui.container.scrollTop=100;
 ui.addMessage({id:'gm',role:'assistant',name:'Ведущий',content:'Новый ответ'});
 assert.equal(ui.container.scrollTop,100);
 ui.container.scrollTop=850;ui.addMessage({id:'next',role:'assistant',name:'Ведущий',content:'Следующий ответ'});
 assert.equal(ui.container.scrollTop,1000);
});
