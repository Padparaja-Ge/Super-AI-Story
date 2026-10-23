// A direct grammar avoids llama.cpp's Gemma schema parser allowing a thought
// channel even with enable_thinking=false (upstream issue #30256). Planning is
// confined to the private JSON field; all actions still pass server validation.
// Whitespace is bounded to prevent a constrained model spending its output
// budget on newlines instead of advancing to the next required property.
export const gmJsonGrammar=String.raw`
root ::= "{" ws "\"thinking\"" ws ":" ws thought ws "," ws decision ws "," ws "\"narrative_text\"" ws ":" ws string ws "}" ws
decision ::= none-decision | roll-decision | state-decision
none-decision ::= "\"action_required\"" ws ":" ws "\"none\"" ws "," ws "\"action_params\"" ws ":" ws "{" ws "}"
roll-decision ::= "\"action_required\"" ws ":" ws "\"roll_dice\"" ws "," ws "\"action_params\"" ws ":" ws roll-params
state-decision ::= "\"action_required\"" ws ":" ws "\"update_state\"" ws "," ws "\"action_params\"" ws ":" ws update-params
roll-params ::= "{" ws "\"formula\"" ws ":" ws string target? reason? ws "}"
update-params ::= "{" ws "\"field\"" ws ":" ws string ws "," ws "\"value\"" ws ":" ws value target? reason? ws "}"
target ::= ws "," ws "\"target\"" ws ":" ws string
reason ::= ws "," ws "\"reason\"" ws ":" ws string
value ::= string | number | "true" | "false" | "null"
thought ::= "\"" char{0,160} "\""
string ::= "\"" char* "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
ws ::= [ \t\n\r]{0,4}
`.trim();
export function gmJsonGrammarForActions(actions=[]){
 const choices=['none-decision'];if(actions.includes('roll_dice'))choices.push('roll-decision');if(actions.includes('update_state'))choices.push('state-decision');
 return gmJsonGrammar.replace(/^decision ::= .*$/m,'decision ::= '+choices.join(' | '));
}
