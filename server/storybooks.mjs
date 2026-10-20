import crypto from 'node:crypto';
import {structuredCompletion} from './services/structuredCompletion.js';
export const playerCounts=['2','2-4','4-8','8-12'];
export function validateStorybook(value){
 if(!value||typeof value!=='object'||!playerCounts.includes(value.playerCount))throw new Error('Выберите число игроков Story book.');
 const book={id:String(value.id||crypto.randomUUID()),playerCount:value.playerCount};
 for(const field of ['name','world','start','goal','details']){if(typeof value[field]!=='string'||value[field].length>(field==='name'?120:8000))throw new Error('Неверный блок Story book: '+field);book[field]=value[field].trim();}
 if(!book.name||!book.world||!book.start||!book.goal)throw new Error('Заполните название, мир, стартовую локацию и цель.');return book;
}
export async function quickAdventure(state,options,getSecret,signal){
 const genres=['fantasy','sci-fi','detective','horror','comedy','romance','dark-18','romance-18','horror-18'],worlds=['kingdoms','wasteland','zombies','space','cyberpunk','pirates','modern','underwater','steampunk'],openings=['dynamic','calm','tense'];
 if(!genres.includes(options.genre)||!worlds.includes(options.world)||!openings.includes(options.opening)||!playerCounts.includes(options.playerCount))throw new Error('Проверьте параметры быстрого приключения.');
 const properties=Object.fromEntries(['name','world','start','goal','details'].map(k=>[k,{type:'string'}]));
 const result=await structuredCompletion({state,chat:{connectionId:options.connectionId},getSecret,signal,maxTokens:1800,schema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false},name:'story_book',instructions:'Создай связный Story book на русском для совместной настольной игры. JSON: name — название; world — описание мира; start — конкретная стартовая локация и ситуация для героев; goal — достижимая общая цель; details — зацепки, важные NPC и дополнительные условия. Не решай за игроков. Учитывай выбранное число игроков. Жанры с 18 означают взрослую аудиторию, все персонажи в романтических сюжетах совершеннолетние; не добавляй графические сексуальные сцены. Динамический старт — немедленное событие, спокойный — встреча, напряжённый — конфликт с выбором.',context:options,parse:raw=>validateStorybook({...JSON.parse(raw.replace(/^```json\s*|\s*```$/g,'')),playerCount:options.playerCount})});return result;
}
export function storyContext(book){return book?`STORY BOOK — постоянная основа приключения\nНазвание: ${book.name}\nИгроков: ${book.playerCount}\nМир: ${book.world}\nСтартовая локация: ${book.start}\nЦель героев: ${book.goal}\nДополнительно: ${book.details}\nСохраняй цель приключения; текущее положение героев определяется последующей историей, не возвращай их в стартовую локацию без причины.`:'';}
