// Stateless stream joining: preserve literal suffixes and repair only a bounded
// newline-prefixed replay of a word fragment. No story or room data is stored.
const boundaryWords=new Set('на но не ни за до от по ко из во об без над под при про для как что это где кто чем нам вам нас вас его её ему их она они оно был была были есть уже тут там так in no on at of to by as an is it be we he me my so if or do am up us was for the and but you she him her our has had are can did how who why not yes'.split(' '));
export function createTextContinuationJoiner(before,{capitalBoundary=false}={}){
  const fragment=String(before||'').match(/[\p{L}\p{M}]+$/u)?.[0]||'',eligible=fragment.length>=2&&fragment.length<=64&&!boundaryWords.has(fragment.toLocaleLowerCase());
  const capitalEligible=capitalBoundary&&fragment.length>=2&&/[\p{Ll}]/u.test(fragment);
  let pending='',decided=!eligible&&!capitalEligible;
  const decide=final=>{
    if(!pending)return '';
    const word=pending.match(/^(\s*)([\p{L}\p{M}]+)/u);
    if(word){
      if(capitalEligible&&!word[1]&&/^[\p{Lu}]/u.test(word[2])){const output=' '+pending;pending='';decided=true;return output;}
      const prefix=fragment.toLocaleLowerCase(),first=word[2].toLocaleLowerCase();
      if(eligible&&/[\r\n]/u.test(word[1])&&first.length>prefix.length&&first.startsWith(prefix)){
        const output=pending.slice(word[1].length+fragment.length);pending='';decided=true;return output;
      }
      const stillPossible=eligible&&prefix.startsWith(first)&&word[0].length===pending.length;
      if(!final&&stillPossible&&pending.length<256)return '';
    }else if(!final&&/^\s*$/u.test(pending)&&pending.length<256)return '';
    const output=pending;pending='';decided=true;return output;
  };
  return {
    push(chunk){const text=String(chunk||'');if(decided)return text;pending+=text;return decide(false);},
    flush(){return decide(true);},
  };
}
