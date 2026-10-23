import {chunkLorebook,hybridSearch,assemblePromptDetailed,parseLLMResponse,executeAction,responseParseError} from '../server/rag/index.mjs';
import type {SceneState,Message,GameEngine,ChunkMetadata,PromptAssembly,ActionResult} from '../server/rag/index.mjs';

/** Example dependencies are supplied by the existing SAS server, not new models. */
export async function prepareAdventurePrompt(input:{
  roomId:string;
  systemPrompt:string;
  sceneState:SceneState;
  recentMessages:Message[];
  query:string;
  documents:Array<{id:string;name:string;content:string;metadata?:Partial<ChunkMetadata>}>;
  embed?:(texts:string[],signal?:AbortSignal)=>Promise<number[][]>;
  signal?:AbortSignal;
}):Promise<PromptAssembly>{
  const scope='room:'+input.roomId;
  const chunks=input.documents.flatMap(document=>chunkLorebook(document.content,{
    maxTokens:480,overlap:50,scope,source:document.name,documentId:document.id,metadata:document.metadata,
  }));
  const results=await hybridSearch(input.query,input.sceneState,{chunks,scope,embed:input.embed,
    vectorTopK:10,keywordTopK:10,topK:20,signal:input.signal});
  return assemblePromptDetailed({systemPrompt:input.systemPrompt,sceneState:input.sceneState,
    recentMessages:input.recentMessages,ragResults:results,maxContextTokens:8192,responseTokens:1024,
    historyTokens:800,maxRagTokens:1500,maxRagChunks:3});
}

/** engine must be a server-owned adapter with current turn/capability checks. */
export function handleAdventureOutput(raw:string,engine:GameEngine):ActionResult{
  const parsed=parseLLMResponse(raw);
  const error=responseParseError(parsed);
  if(error)return {success:false,error,narrative_text:''};
  // Never publish/persist parsed wholesale: thinking is a private bounded string.
  return executeAction(parsed,engine);
}
