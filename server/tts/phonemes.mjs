// SPDX-License-Identifier: GPL-3.0-or-later
// Independent eSpeak utility; communicates with SAS exclusively through JSON stdin/stdout.
import ESpeakNg from 'espeak-ng';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {text,language}=JSON.parse(input);
const m=await ESpeakNg({arguments:['--phonout','ipa.txt','--ipa=3','-q','-v',language,text]});
process.stdout.write(JSON.stringify(m.FS.readFile('ipa.txt',{encoding:'utf8'})));
