import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranslator} from '../shared/ui-language.mjs';
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
const english=JSON.parse(await fs.readFile(new URL('../shared/locales/en.json',import.meta.url),'utf8'));
function fixture(language='ru'){
 const nodes=new Map([['messages',new Element('div')],['code',new Element('input')]]);nodes.get('code').value='qa-code';
 const document={createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)};
 const context=vm.createContext({document,uiText:createTranslator({en:english},()=>language),room:{avatars:{player:'✦'}},messages:new Map(),archive:new Map(),boxes:new Map(),$:id=>nodes.get(id)});
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


test('Browser big-room messages keep the speaking character avatar through streaming and edits',()=>{
 const ui=fixture();ui.room.cast=[{id:'iris',name:'Ирис',avatar:'☾'},{id:'atlas',name:'Атлас',avatar:'♜'}];
 ui.addMessage({id:'first',role:'assistant',userId:'narrator',characterId:'iris',name:'Ирис',content:'Первая реплика.'});
 ui.addMessage({id:'second',role:'assistant',userId:'narrator',characterId:'atlas',name:'Атлас',content:'Ответ.'});
 ui.addMessage({id:'first',role:'assistant',userId:'narrator',characterId:'iris',name:'Ирис',content:'Уточнённая реплика.',editedAt:'2026-11-17'});
 assert.equal(ui.boxes.get('first').querySelector('.persona-avatar').textContent,'☾');
 assert.equal(ui.boxes.get('second').querySelector('.persona-avatar').textContent,'♜');
});


test('Browser big-room recovery exports public cast IDs and cards without hidden prompt fields',()=>{
 const recovery=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='recoveryBundle').getText(ast);
 const context=vm.createContext({structuredClone,Date,archiveComplete:true,archive:new Map([['message',{id:'message',role:'assistant',characterId:'iris',content:'Добрый вечер.'}]]),participants:[],room:{id:'room',mode:'bigroom',cast:[{id:'iris',name:'Ирис',avatar:'☾',blocks:[{content:'PRIVATE_CARD_BLOCK'}],privateNote:'PRIVATE_NOTE'}],media:{},aiSettings:{secret:'HOST_SETTINGS'},connectionId:'PRIVATE_CONNECTION'}});
 vm.runInContext(recovery,context);const result=JSON.parse(JSON.stringify(context.recoveryBundle()));
 assert.deepEqual(result.room.cast,['iris']);assert.equal(result.characters[0].id,'iris');assert.deepEqual(result.characters[0].blocks,[]);assert.deepEqual(result.characters[0].lorebookIds,[]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CARD_BLOCK|PRIVATE_NOTE|HOST_SETTINGS|PRIVATE_CONNECTION/);
});
