// Russian orthoepy follows zaakirio/kokoro-ru's Apache-2.0 G2P frontend.
// https://huggingface.co/zaakirio/kokoro-ru/blob/d649c57b239b18c4c384378127cbf01dba039bc1/ru_g2p.py
export function russianText(text){
 return text.normalize('NFC').replace(/[\[{]/g,'(').replace(/[\]}]/g,')').replace(/[а-яё]+/gi,word=>{
  let w=word.toLowerCase();const exceptions={конечно:'конешно',скучно:'скушно',нарочно:'нарошно',яичница:'яишница',дорого:'дорога',недорого:'недорога'};
  if(exceptions[w])return exceptions[w];
  if(!['много','немного','намного','ненамного','строго','нестрого','настрого','полого','убого','лего','диего','ого','огого'].includes(w))w=w.replace(/([ое])го$/,'$1во');
  return w.replace(/здравств/g,'здраств').replace(/чувств/g,'чуств').replace(/солнц/g,'сонц').replace(/([сз])частлив/g,'$1часлив');
 });
}
export function normalizePhonemes(ipa,language){
 let ps=ipa.replace(/t[\u200c\u200d]s/g,'ʦ').replace(/[\u200c\u200d]/g,'').replace(/dʒ/g,'ʤ').replace(/tʃ/g,'ʧ').replace(/\s+/g,' ').trim();
 if(!language.startsWith('ru'))return ps;
 // eSpeak I^ is a silent vowel that palatalizes the preceding consonant
 // (phsource/ph_russian). In IPA output it leaks as ɪ^, e.g. дверь.
 ps=ps.replace(/ɪ\^/g,'ʲ').replace(/u"/g,'u').replace(/ɭ/g,'l').replace(/ɵ/g,'o').replace(/[ʑʐ]/g,'ʒ').replace(/ʧʲ/g,'ʧ');
 return ps.split(' ').map(word=>{
  const chars=[...word],vowels=chars.flatMap((c,i)=>'aɑoeiuyʌəɪɐɛɨ'.includes(c)?[i]:[]),primary=chars.indexOf('ˈ'),stresses=new Set();
  chars.forEach((c,i)=>{if(c==='ˈ'||c==='ˌ'&&(primary<0||i<primary)){const next=vowels.find(j=>j>i);if(next!==undefined)stresses.add(next);}});
  vowels.forEach((i,ordinal)=>{if(stresses.has(i)||!'aɑoʌə'.includes(chars[i]))return;const next=vowels.find(j=>j>i&&stresses.has(j));chars[i]=i>0&&'ʲj'.includes(chars[i-1])?'ɪ':next===vowels[ordinal+1]&&next!==undefined||i===0?'ɐ':'ə';});
  return chars.filter((c,i)=>!(c==='ˌ'&&primary>=0&&i>primary)).join('').replace(/ɕ(?!ː)/g,'ɕː');
 }).join(' ');
}
export function phonemeIds(ipa,vocab){
 const unknown=[...new Set([...ipa].filter(c=>!Object.hasOwn(vocab,c)&&!/[\s,.;:!?()“”"—–-]/u.test(c)))];
 if(unknown.length)throw new Error('Неподдерживаемые фонемы: '+unknown.join(' ')+'. Измените произношение слова в расширении «Голоса персонажа».');
 return [...ipa].filter(c=>Object.hasOwn(vocab,c)).map(c=>vocab[c]);
}
