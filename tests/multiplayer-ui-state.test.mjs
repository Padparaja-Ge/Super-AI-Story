import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source=await fs.readFile(new URL('../src/multiplayerUi.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {isAdventureRoom,unfinishedNarration,roomModeLabel,narrationReason}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('Room panels separate D&D and custom tabletop modes from ordinary roleplay',()=>{
 assert.equal(isAdventureRoom({mode:'roleplay'}),false);
 assert.equal(roomModeLabel({mode:'roleplay'}),'Role Play с персонажем');
 assert.equal(isAdventureRoom({mode:'dnd'}),true);
 assert.equal(roomModeLabel({mode:'dnd'}),'D&D · упрощённая');
 assert.equal(roomModeLabel({mode:'custom'}),'НРИ · свои правила');
 assert.equal(isAdventureRoom({tactical:{version:1}}),true);
});

test('Interrupted narration continues an existing assistant message, never a player post or image',()=>{
 const messages=[{id:'player',role:'user',interrupted:true},{id:'gm',role:'assistant',content:'Герои вошли в'},{id:'image',role:'assistant',kind:'image'}];
 assert.deepEqual(unfinishedNarration({narration:{messageId:'gm',canContinue:true,reason:'length'}},messages),{messageId:'gm',reason:'length',canContinue:true});
 assert.equal(unfinishedNarration({narration:{messageId:'player',canContinue:true}},messages),null);
 assert.equal(unfinishedNarration({},messages),null);
 assert.equal(unfinishedNarration({narration:{messageId:'image',canContinue:true}},messages),null);
});

test('A changed context retains unfinished-state blocking while offering manual acceptance only',()=>{
 const messages=[{id:'gm',role:'assistant',content:'Недописанный ответ'}];
 assert.deepEqual(unfinishedNarration({narration:{messageId:'gm',status:'incomplete',canContinue:false,reason:'network'}},messages),{messageId:'gm',reason:'network',canContinue:false});
 assert.equal(narrationReason('network'),'Соединение с моделью прервалось.');
});

test('Completed later narration hides continuation for an older interrupted message',()=>{
 const old={id:'old',role:'assistant',interrupted:true},newer={id:'new',role:'assistant'};
 assert.equal(unfinishedNarration({},[old,newer]),null);
 assert.deepEqual(unfinishedNarration({},[old]),{messageId:'old',reason:'length',canContinue:true});
 assert.equal(unfinishedNarration({narration:{messageId:'new',status:'complete',canContinue:false}},[old,newer]),null);
});
