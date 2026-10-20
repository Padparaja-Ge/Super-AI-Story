import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),url=value=>'data:text/javascript;base64,'+Buffer.from(value).toString('base64');
const helperSource=await fs.readFile(new URL('../src/fanficWorkbench.ts',import.meta.url),'utf8');
const transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const helperCode=transpile(helperSource).replaceAll('../shared/fanfic-profiles.mjs',new URL('../shared/fanfic-profiles.mjs',import.meta.url).href);
const helperURL=url(helperCode),helpers=await import(helperURL);
const {proposalState,episodeFactRecords,editableFact,factSavePayload,reviewIsCurrent,stageDisplay,profileUpdatePayload,rebaseMetadataDraft,resumableEpisode}=helpers;
const bare=code=>code.replace(/from ["'](react(?:\/jsx-runtime)?|lucide-react)["']/g,(_,name)=>'from '+JSON.stringify(pathToFileURL(require.resolve(name)).href));
const moduleURL=async name=>url(bare(transpile(await fs.readFile(new URL('../src/'+name,import.meta.url),'utf8'))));
const draftURL=await moduleURL('fanficDrafts.ts'),apiURL=await moduleURL('api.ts'),uiURL=await moduleURL('UI.tsx');
const playerURL=url(bare(transpile(await fs.readFile(new URL('../src/speechPlayer.ts',import.meta.url),'utf8'))).replaceAll('../shared/speech.mjs',new URL('../shared/speech.mjs',import.meta.url).href));
const speechURL=url(bare(transpile(await fs.readFile(new URL('../src/SpeechButton.tsx',import.meta.url),'utf8'))).replaceAll('./UI',uiURL).replaceAll('./speechPlayer',playerURL));
let component=await fs.readFile(new URL('../src/Fanfic.tsx',import.meta.url),'utf8');
component+='\nexport {FactEditor, ContextInspector, ProjectSettings, FramePassportEditor, ProposalWarnings};';
let compiled=bare(transpile(component)).replace(/import ["']\.\/fanfic\.css["'];?/,'');
for(const [name,address] of Object.entries({'../shared/speech.mjs':new URL('../shared/speech.mjs',import.meta.url).href,'./SpeechButton':speechURL,'./api':apiURL,'./UI':uiURL,'./fanficDrafts':draftURL,'./fanficWorkbench':helperURL}))compiled=compiled.replaceAll(JSON.stringify(name),JSON.stringify(address)).replaceAll("'"+name+"'",JSON.stringify(address));
const {FanficView,FactEditor,ContextInspector,ProjectSettings,FramePassportEditor,ProposalWarnings}=await import(url(compiled));
const proposal={id:'edit',sourceRevision:7,selectionStart:7,selectionEnd:12,original:'вошёл',replacement:'тихо вошёл'};
const episode={id:'episode',projectId:'work',revision:7,season:1,number:2,title:'Встреча',content:'Он уже вошёл в дом.',status:'approved',brief:'',editProposal:proposal};
const fact={id:'fact',type:'promise',subject:'Ирис',predicate:'Обещала',value:'Вернуть серебряный ключ',aliases:['Ира'],projectId:'work',episodeId:'early',evidence:[{index:1,quote:'Ирис обещала вернуть серебряный ключ.',start:0,end:39}]};

test('Rewrite preview accepts only the exact saved selection and revision',()=>{
 assert.equal(proposalState(episode,episode.content).canApply,true);
 for(const patch of [{selectionStart:-1},{selectionStart:.5},{selectionEnd:100},{selectionEnd:7},{original:'другой текст'},{replacement:null},{replacement:'  '},{sourceRevision:6}])assert.equal(proposalState({...episode,editProposal:{...proposal,...patch}},episode.content).canApply,false);
 assert.equal(proposalState(episode,episode.content,true).canApply,false);
 assert.equal(proposalState(episode,'Он уже ушёл в дом.').canApply,false);
 assert.equal(proposalState({...episode,editProposal:null},episode.content).proposal,null);
});

test('Fact timeline excludes future seasons and facts bound to another work',()=>{
 const prior={id:'early',season:1,number:1,title:'Начало',status:'approved',memory:{chunks:[{facts:[fact,{...fact,id:'foreign',projectId:'elsewhere'}]}]}};
 const future={...prior,id:'future',season:2,memory:{facts:[{...fact,id:'future-fact'}]}};
 const current={...episode,memory:{facts:[{...fact,id:'current',episodeId:'episode'}]}};
 const records=episodeFactRecords([future,current,prior],current);
 assert.deepEqual(records.map(r=>r.fact.id),['fact','current']);assert.deepEqual(records.map(r=>r.eligible),[true,false]);
 assert.equal(episodeFactRecords([prior],null).length,0);
});

test('Draft or invalidated source facts remain inspectable without becoming eligible',()=>{
 const prior={id:'early',season:1,number:1,memory:{facts:[fact]}};
 for(const patch of [{status:'draft'},{status:'approved',needsReview:true}])assert.equal(episodeFactRecords([{...prior,...patch}],episode)[0].eligible,false);
});

test('Manual fact editing copies aliases and preserves source evidence',()=>{
 const draft=editableFact(fact);draft.aliases.push('Ирина');assert.deepEqual(fact.aliases,['Ира']);
 const [payload]=factSavePayload([{...draft,aliases:'Ира\n  Ирина  \n\n'}]);assert.deepEqual(payload.aliases,['Ира','Ирина']);assert.deepEqual(payload.evidence,fact.evidence);
});

test('Review warnings are stale after unsaved or revised prose',()=>{
 const reviewed={...episode,continuityReview:{sourceRevision:7,status:'ready',issues:[]}};
 assert.equal(reviewIsCurrent(reviewed),true);assert.equal(reviewIsCurrent(reviewed,true),false);assert.equal(reviewIsCurrent({...reviewed,revision:8}),false);assert.equal(reviewIsCurrent({...reviewed,continuityReview:{}}),false);
});

test('Displayed stage settings come from the same resolver as the backend',()=>{
 assert.equal(stageDisplay({maxTokens:1400,temperature:.85},'writing').maxTokens,1400);
 assert.equal(stageDisplay({generationProfiles:{modelKind:'moe',stages:{}}},'writing').maxTokens,1024);
 assert.equal(stageDisplay({generationProfiles:{modelKind:'moe',stages:{memory:{temperature:.2,maxTokens:1700}}}},'memory',3000).maxTokens,1000);
 assert.equal(stageDisplay({generationProfiles:{modelKind:'moe',stages:{memory:{temperature:.2,maxTokens:1700}}}},'memory',3000).temperature,.2);
});

const state={fanficProjects:[],connections:[],activeConnectionId:'',images:[],settings:{comfy:{model:'test',width:512,height:512}},characters:[],personas:[],lorebooks:[]};
const oldStorage=globalThis.localStorage;globalThis.localStorage={getItem:()=>null,setItem(){}};
test.after(()=>{if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;});
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));

test('The actual workbench renders all three mounted panels and only its own source materials',()=>{
 const work={id:'work',title:'Наше произведение',settings:{vectorMemory:true,maxTokens:1200,temperature:.8},characters:[{id:'iris',name:'Ирис',avatar:'✦'}],personas:[],lorebooks:[],episodes:[{...episode,editProposal:undefined,memory:{summary:'Обещание Ирис',facts:[{...fact,episodeId:'episode'}]},continuityReview:{sourceRevision:7,status:'ready',issues:[{severity:'warning',message:'Проверить обещание',evidence:['Ключ остался у Ирис.'],suggestion:'Сверьте владельца ключа.'}]}}]};
 const html=render(FanficView,{state:{...state,fanficProjects:[work,{...work,id:'other',title:'FOREIGN-FANFIC',episodes:[]}]},flush:async()=>{},refresh:async()=>{},notify(){},task:null});
 assert.match(html,/id="fanfic-panel-series"/);assert.match(html,/id="fanfic-panel-text"/);assert.match(html,/id="fanfic-panel-canon"/);assert.match(html,/aria-label="Разделы мастерской"/);assert.match(html,/data-panel="text"/);
 assert.match(html,/Перепровер|Проверить обещание/);assert.match(html,/Ирис обещала вернуть серебряный ключ/);assert.match(html,/Утвердить эпизод|События сохранены/);
 // Other projects can appear in the selector; their prose/materials cannot appear in the canvas.
 assert.doesNotMatch(html,/ЧУЖОЙ-СЕКРЕТ/);
});

test('The real context inspector shows why facts were retrieved and their evidence',()=>{
 const html=render(ContextInspector,{preview:{projectTitle:'Наше произведение',season:1,number:2,messages:[],report:{selectedMemory:[],selectedLore:[],selectedFacts:[{...fact,reason:'participant',reasons:['participant','lexical'],included:true,sourceEvidence:fact.evidence}],queryPlan:{participants:[{name:'Ирис'}],queries:['Кому принадлежит серебряный ключ?']}}}});
 assert.match(html,/Участник сцены/);assert.match(html,/Совпадение слов/);assert.match(html,/Ирис обещала вернуть серебряный ключ/);assert.match(html,/Кому принадлежит серебряный ключ/);
});

test('The fact editor exposes manual fields while source quotations stay read only',()=>{
 const html=render(FactEditor,{episode:{...episode,memory:{facts:[fact]}},locked:false,onClose(){},onSave(){}});
 assert.match(html,/Добавить факт автора/);assert.match(html,/Установленный факт/);assert.match(html,/<blockquote>Ирис обещала вернуть серебряный ключ/);assert.doesNotMatch(html,/<textarea[^>]*>Ирис обещала вернуть серебряный ключ/);assert.match(html,/maxLength="800"/);
});

test('Project settings provide all five generation stages and opt-in family profiles',()=>{
 const fresh=render(ProjectSettings,{project:null,state,locked:false,onClose(){},onSave(){}});
 for(const label of ['Художественный текст','Планирование','Память','Проверка связности','Редактура'])assert.ok(fresh.includes(label));
 assert.match(fresh,/value="moe"/);assert.match(fresh,/aria-label="Проверять связность фанфика"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="Проверять связность фанфика"/);
 const legacy=render(ProjectSettings,{project:{id:'work',title:'Старый',settings:{}},state,locked:false,onClose(){},onSave(){}});
 assert.match(legacy,/aria-checked="false"/);
});

test('The frame editor keeps visual identity editable and respects backend field limits',()=>{
 const html=render(FramePassportEditor,{passport:{subjects:[{name:'Ирис',characterId:'iris',appearance:'Серебряные волосы',outfit:'Плащ'}]},locked:false,onChange(){}});
 assert.match(html,/Серебряные волосы/);assert.match(html,/Ракурс и крупность/);assert.match(html,/maxLength="120"/);assert.match(html,/maxLength="1000"/);
});

test('The saved model evaluation remains explicit and recommendations require an author action',()=>{
 const modelEvaluation={model:'Local MoE QA',contextWindow:8192,createdAt:'2026-10-08T12:00:00Z',stages:[{stage:'memory',status:'failed',elapsedMs:2500,checks:{factsPreserved:false},outputPreview:'Wrong password'}],recommendation:{generationProfiles:{modelKind:'moe',stages:{}},reason:'Снизить температуру работы с фактами.'}};
 const html=render(ProjectSettings,{project:{id:'work',title:'Мир',settings:{},modelEvaluation},state,locked:false,onClose(){},onSave(){},onCalibrate(){},onApplyProfile(){}});
 assert.match(html,/Проверить модель для фанфика/);assert.match(html,/Последняя проверка: Local MoE QA/);assert.match(html,/Не пройдено/);assert.match(html,/Сохранены факты: не выполнено/);assert.match(html,/Использовать предложенные профили/);
});

test('Real edit-review warnings accept normalized issue objects without crashing the preview',()=>{
 const html=render(ProposalWarnings,{warnings:['Проверьте имя.',{severity:'error',message:'Изменён пароль',evidence:['Пароль САПФИР-731'],suggestion:'Сохраните исходный пароль.'}]});
 assert.match(html,/Проверьте имя/);assert.match(html,/Изменён пароль/);assert.match(html,/САПФИР-731/);assert.match(html,/Сохраните исходный пароль/);
});

test('Applying a recommended profile changes saved stage parameters only',()=>{
 const saved={id:'work',title:'Saved title',world:'Saved world',settings:{connectionId:'saved-api',temperature:.8,vectorMemory:true,custom:'preserved'}};
 const profile={modelKind:'moe',stages:{memory:{temperature:.05}}};
 const payload=profileUpdatePayload(saved,profile);
 assert.deepEqual(Object.keys(payload),['settings']);assert.equal(payload.settings.connectionId,'saved-api');assert.equal(payload.settings.vectorMemory,true);assert.equal(payload.settings.custom,'preserved');assert.equal(payload.settings.generationProfiles,profile);
 assert.equal(saved.settings.generationProfiles,undefined);assert.equal(saved.title,'Saved title');
});

test('Rejecting a proposal does not create a false conflict or erase a local prose draft',()=>{
 const draft={...episode,projectId:'work',content:'My unsaved prose',dirty:true};const after={...episode,revision:8,editProposal:null};
 const rebased=rebaseMetadataDraft(draft,'work',episode,after);
 assert.equal(rebased.revision,8);assert.equal(rebased.content,'My unsaved prose');assert.equal(rebased.dirty,true);assert.equal(draft.revision,7);
 assert.equal(rebaseMetadataDraft(draft,'other',episode,after),draft);
 assert.equal(rebaseMetadataDraft(draft,'work',episode,{...after,content:'Changed in another window'}),draft);
 assert.equal(rebaseMetadataDraft({...draft,revision:6},'work',episode,after).revision,6);
});

test('Stopped preview/review tasks remain resumable while preserving the original canonical status',()=>{
 assert.equal(resumableEpisode({status:'approved',generation:{action:'rewrite',preview:true}}),true);
 assert.equal(resumableEpisode({status:'draft',generation:{action:'review'}}),true);
 assert.equal(resumableEpisode({status:'stopped',generation:{action:'write'}}),true);
 assert.equal(resumableEpisode({status:'error',generation:{action:'approve'}}),true);
 assert.equal(resumableEpisode({status:'running',generation:{action:'rewrite',preview:true}}),false);
 assert.equal(resumableEpisode({status:'approved',generation:null}),false);
 assert.equal(resumableEpisode({status:'approved',generation:{action:'write'}}),false);
});

test('A stopped preview is accessible in the real workbench without presenting model relations as author-confirmed facts',()=>{
 const current={...episode,editProposal:null,status:'approved',generation:{action:'rewrite',preview:true},memory:{summary:'Событие',facts:[{...fact,episodeId:'episode',predicate:'UNCONFIRMED-PREDICATE'}]}};
 const work={id:'work',title:'Произведение',settings:{},characters:[],personas:[],lorebooks:[],episodes:[current]};
 const html=render(FanficView,{state:{...state,fanficProjects:[work]},flush:async()=>{},refresh:async()=>{},notify(){},task:null});
 assert.match(html,/Продолжить подготовку правки/);assert.match(html,/Извлечено моделью; сверено с цитатой/);assert.doesNotMatch(html,/UNCONFIRMED-PREDICATE/);
});

test('Weighted fact relevance is not presented as a fake cosine percentage',()=>{
 const html=render(ContextInspector,{preview:{projectTitle:'Мир',season:1,number:2,messages:[],report:{selectedMemory:[],selectedLore:[],selectedFacts:[{...fact,reasons:['intent'],score:12.7,semanticScore:.66,sourceEvidence:fact.evidence}]}}});
 assert.match(html,/векторное сходство 66%/);assert.match(html,/Тема запроса/);assert.doesNotMatch(html,/1270%/);
});
