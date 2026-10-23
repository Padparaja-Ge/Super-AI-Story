import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root=path.resolve(import.meta.dirname,'..'),check=process.argv.includes('--check');
const format={getCanonicalFileName:file=>file,getCurrentDirectory:()=>root,getNewLine:()=> '\n'};
const config=ts.readConfigFile(path.join(root,'tsconfig.rag.json'),ts.sys.readFile);
if(config.error)throw new Error(ts.formatDiagnosticsWithColorAndContext([config.error],format));
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const program=ts.createProgram(parsed.fileNames,parsed.options),diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length){process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics,format));process.exit(1);}
const stale=[];
const emitted=program.emit(undefined,check?(filename,text)=>{
  const actual=fs.existsSync(filename)?fs.readFileSync(filename,'utf8'):'';
  if(actual.replace(/\r\n/g,'\n')!==text.replace(/\r\n/g,'\n'))stale.push(path.relative(root,filename));
}:undefined);
if(emitted.emitSkipped)throw new Error('RAG TypeScript compilation failed.');
if(stale.length)throw new Error('RAG runtime differs from TypeScript sources; run npm run build:server: '+stale.join(', '));
console.log(check?'RAG TypeScript/runtime match.':'RAG TypeScript compiled.');
