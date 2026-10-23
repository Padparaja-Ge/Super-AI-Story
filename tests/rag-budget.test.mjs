import test from 'node:test';
import assert from 'node:assert/strict';
import {assemblePrompt,assemblePromptDetailed,budgetGameMessages,selectRagChunks,formatRag} from '../server/rag/budget.mjs';
import {calculateTokenBudget} from '../server/rag/tokens.mjs';

const chunk=(id,content)=>({id,content,metadata:{type:'lore',source:'Мир',tags:[]}});
const result=(id,content)=>({chunk:chunk(id,content),vectorScore:.5,keywordScore:.5,finalScore:.5});
const scene={currentLocation:'Лавка Арвина',presentNPCs:['Арвин'],activeQuests:[]};
test('Separate lore and memory budgets are enforced together with the overall RAG cap',()=>{
 const lore=result('lore','Пароль лорбука.'),memory=result('memory','Память о договоре.'),source=result('source','Исходное событие.');
 lore.chunk.metadata.kind='lore';memory.chunk.metadata.kind='memory';source.chunk.metadata.kind='source';
 assert.deepEqual(selectRagChunks([lore,memory,source],{maxLoreTokens:0}).chunks.map(c=>c.id),['memory','source']);
 assert.deepEqual(selectRagChunks([lore,memory,source],{maxMemoryTokens:0}).chunks.map(c=>c.id),['lore']);
 const cap=calculateTokenBudget(formatRag([memory.chunk]));
 assert.deepEqual(selectRagChunks([memory,source,lore],{maxMemoryTokens:cap}).chunks.map(c=>c.id),['memory','lore']);
 const game=budgetGameMessages({systemMessages:[],requiredMessages:[{role:'user',content:'Текущий пост.'}],ragResults:[lore,memory,source],maxInputTokens:2000,maxLoreTokens:0,maxMemoryTokens:0});
 assert.equal(game.selectedChunks.length,0);
});
test('Assembly preserves original system and full JSON state, then history and max three excerpts',()=>{
 const system='Действующий системный промпт.\n  Без исправлений!';
 const ctx={systemPrompt:system,sceneState:scene,recentMessages:[{role:'assistant',content:'Цена десять монет.'},{role:'user',content:'Банка пуста. Прошу скидку.'}],ragResults:Array.from({length:8},(_,i)=>result(String(i),'Архивное сведение '+i)),maxContextTokens:2048,responseTokens:256};
 const out=assemblePromptDetailed(ctx);
 assert.equal(out.messages[0].content,system);
 assert.equal(out.selectedChunks.length,3);
 assert.ok(out.prompt.indexOf('[SAS_SCENE_STATE]')<out.prompt.indexOf('[SAS_RECENT_MESSAGES]'));
 assert.ok(out.prompt.indexOf('[SAS_RECENT_MESSAGES]')<out.prompt.indexOf('[SAS_RAG_SOURCES]'));
 assert.ok(out.prompt.includes('Банка пуста.'));
 assert.equal(assemblePrompt(ctx),out.prompt);
 assert.ok(out.ragTokens<=1500);
 assert.ok(out.tokens+256+128<=2048);
});
test('RAG counts metadata wrapper and can skip an oversized match for smaller later matches',()=>{
 const huge=result('huge','архив '.repeat(1800)),small=result('small','Нужный пароль: абрикос.');
 const out=selectRagChunks([huge,small],{maxTokens:120});
 assert.deepEqual(out.chunks.map(c=>c.id),['small']);
 assert.equal(out.tokens,calculateTokenBudget(formatRag(out.chunks)));
 assert.equal(selectRagChunks([small],{maxTokens:0}).chunks.length,0);
 assert.equal(selectRagChunks([small],{maxChunks:0}).chunks.length,0);
});
test('RAG deduplicates id and content while retaining ranked order',()=>{
 const out=selectRagChunks([result('a','Ключ один.'),result('a','Другой текст.'),result('b','Ключ один.'),result('c','Ключ два.')]);
 assert.deepEqual(out.chunks.map(c=>c.id),['a','c']);
});
test('Mandatory state and latest message cannot be silently truncated',()=>{
 assert.throws(()=>assemblePrompt({systemPrompt:'инструкция '.repeat(500),sceneState:scene,recentMessages:[],ragResults:[],maxContextTokens:512,responseTokens:128}),{code:'RAG_CONTEXT_REQUIRED'});
 assert.throws(()=>assemblePrompt({systemPrompt:'Веди игру.',sceneState:scene,recentMessages:[{role:'user',content:'неразрывная заявка '.repeat(1000)}],ragResults:[],maxContextTokens:512,responseTokens:128}),{code:'RAG_CONTEXT_REQUIRED'});
});
test('Oldest complete messages leave before recent actions; no partial JSON or narrative slicing',()=>{
 const out=assemblePromptDetailed({systemPrompt:'Веди игру.',sceneState:scene,recentMessages:[{role:'assistant',content:'старое '.repeat(200)},{role:'assistant',content:'Цена десять.'},{role:'user',content:'Не покупаю меч.'}],ragResults:[result('a','давнее '.repeat(100))],historyTokens:80,maxContextTokens:512,responseTokens:128});
 assert.equal(out.omittedMessages,1);
 assert.ok(out.prompt.includes('Не покупаю меч.'));
 assert.ok(!out.prompt.includes('старое'));
 assert.ok(out.tokens+128+32<=512);
});
test('Game budget protects all players and engine values, drops RAG first and never changes system text',()=>{
 const system=[{role:'system',content:'Правила неизменны: critical берёт движок.'}],required=[{role:'user',content:'Игрок1: торгуюсь. Игрок2: банка пуста. Игрок3: молчу. d20=2, DC15, failure.'}];
 const base=budgetGameMessages({systemMessages:system,requiredMessages:required,ragResults:[],maxInputTokens:512});
 const out=budgetGameMessages({systemMessages:system,requiredMessages:required,ragResults:[result('x','длинный '.repeat(1000))],maxInputTokens:base.tokens});
 assert.deepEqual(out.messages,[...system,...required]);
 assert.equal(out.selectedChunks.length,0);
 assert.equal(out.tokens,base.tokens);
 assert.throws(()=>budgetGameMessages({systemMessages:system,requiredMessages:required,ragResults:[],maxInputTokens:base.tokens-1}),{code:'RAG_CONTEXT_REQUIRED'});
});
test('Nonfinite or invalid context budgets cannot silently remove the cap',()=>{
 for(const limit of [NaN,Infinity,-1,0,1.5,2_000_001])assert.throws(()=>budgetGameMessages({systemMessages:[],requiredMessages:[],ragResults:[],maxInputTokens:limit}),RangeError);
});
