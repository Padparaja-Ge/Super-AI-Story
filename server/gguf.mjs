import fs from 'node:fs/promises';

// Read only GGUF metadata and tensor descriptors; never load the model weights.
const widths={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};
const cached=new Map();
export async function readGguf(file){
  const stat=await fs.stat(file),signature=stat.size+':'+stat.mtimeMs;
  if(cached.get(file)?.signature===signature)return cached.get(file).info;
  const handle=await fs.open(file,'r');let position=0,start=-1,buffer=Buffer.alloc(0);
  const take=async n=>{
    if(!Number.isSafeInteger(n)||n<0||position+n>stat.size||position+n>128*1024*1024)throw new Error('Некорректный или слишком большой заголовок GGUF.');
    if(position<start||position+n>start+buffer.length){const block=Buffer.alloc(Math.max(n,1024*1024));const {bytesRead}=await handle.read(block,0,block.length,position);buffer=block.subarray(0,bytesRead);start=position;}
    if(position+n>start+buffer.length)throw new Error('Неполный заголовок GGUF.');
    const value=buffer.subarray(position-start,position-start+n);position+=n;return value;
  };
  const skip=n=>{if(!Number.isSafeInteger(n)||n<0||position+n>stat.size||position+n>128*1024*1024)throw new Error('Некорректный размер GGUF.');position+=n;};
  const u32=async()=>(await take(4)).readUInt32LE();
  const u64=async()=>{const n=Number((await take(8)).readBigUInt64LE());if(!Number.isSafeInteger(n))throw new Error('Некорректный размер GGUF.');return n;};
  const string=async keep=>{const n=await u64();if(n>16*1024*1024)throw new Error('Слишком длинное поле GGUF.');if(!keep){skip(n);return;}return (await take(n)).toString('utf8');};
  async function value(type,keep,depth=0){
    if(type===8)return string(keep);
    if(type===9){if(depth>2)throw new Error('Некорректный массив GGUF.');const item=await u32(),count=await u64();if(count>2000000)throw new Error('Слишком большой массив GGUF.');if(widths[item]){skip(widths[item]*count);return;}for(let i=0;i<count;i++)await value(item,false,depth+1);return;}
    const width=widths[type];if(!width)throw new Error('Неизвестный тип поля GGUF.');
    if(!keep){skip(width);return;}const b=await take(width);
    return type===0?b.readUInt8():type===1?b.readInt8():type===2?b.readUInt16LE():type===3?b.readInt16LE():type===4?b.readUInt32LE():type===5?b.readInt32LE():type===6?b.readFloatLE():type===7?!!b[0]:type===10?Number(b.readBigUInt64LE()):type===11?Number(b.readBigInt64LE()):b.readDoubleLE();
  }
  try{
    if((await take(4)).toString()!=='GGUF')throw new Error('Файл не содержит GGUF.');
    const version=await u32();if(![2,3].includes(version))throw new Error('Поддерживаются GGUF v2 и v3.');
    const tensorCount=await u64(),keyCount=await u64();if(tensorCount>200000||keyCount>100000)throw new Error('Слишком большой заголовок GGUF.');
    const meta={},arrayKeys=new Set();
    for(let i=0;i<keyCount;i++){const key=await string(true),type=await u32(),keep=(!key.startsWith('tokenizer.')||key==='tokenizer.chat_template')&&type!==9;if(type===9)arrayKeys.add(key);const result=await value(type,keep);if(keep)meta[key]=result;}
    const tensors=[];
    for(let i=0;i<tensorCount;i++){const name=await string(true),dimensions=await u32();if(dimensions>8)throw new Error('Некорректный тензор GGUF.');let parameters=1;for(let j=0;j<dimensions;j++)parameters*=await u64();const type=await u32(),offset=await u64();tensors.push({name,parameters,type,offset});}
    const alignment=Number(meta['general.alignment'])||32,dataStart=Math.ceil(position/alignment)*alignment;
    const ordered=[...tensors].sort((a,b)=>a.offset-b.offset),layerBytes=new Map();let expertBytes=0,parameterCount=0,expertParameters=0;
    for(let i=0;i<ordered.length;i++){const t=ordered[i],end=i+1<ordered.length?ordered[i+1].offset:stat.size-dataStart;if(t.offset<0||end<t.offset||end>stat.size-dataStart)throw new Error('Некорректные смещения тензоров GGUF.');t.bytes=end-t.offset;parameterCount+=t.parameters;if(/ffn_(?:up|down|gate|gate_up)_exps/.test(t.name)){expertBytes+=t.bytes;expertParameters+=t.parameters;const layer=t.name.match(/^blk\.(\d+)\./);if(layer)layerBytes.set(Number(layer[1]),(layerBytes.get(Number(layer[1]))||0)+t.bytes);}}
    const architecture=String(meta['general.architecture']||''),get=k=>Number(meta[architecture+'.'+k])||0;
    const experts=get('expert_count'),activeExperts=get('expert_used_count'),layers=get('block_count'),embeddingLength=get('embedding_length'),heads=get('attention.head_count'),kvHeads=get('attention.head_count_kv')||heads;
    if(layers>4096)throw new Error('Некорректное число слоёв GGUF.');
    const info={version,architecture,name:String(meta['general.name']||''),chatTemplate:String(meta['tokenizer.chat_template']||''),size:stat.size,parameterCount,contextLength:get('context_length'),layers,embeddingLength,heads,kvHeads,keyLength:get('attention.key_length')||(heads?embeddingLength/heads:0),valueLength:get('attention.value_length')||(heads?embeddingLength/heads:0),experts,activeExperts,isMoe:experts>0,expertBytes,expertLayerBytes:Array.from({length:layers},(_,i)=>layerBytes.get(i)||0),nonExpertBytes:stat.size-expertBytes,activeParameters:experts&&activeExperts?parameterCount-expertParameters+expertParameters*activeExperts/experts:parameterCount,splitCount:Number(meta['split.count'])||1,kvLoraRank:get('attention.kv_lora_rank'),sharedExperts:get('expert_shared_count'),layerwiseAttention:['attention.head_count','attention.head_count_kv','attention.key_length','attention.value_length'].some(k=>arrayKeys.has(architecture+'.'+k)),hasRecurrentState:Object.keys(meta).some(k=>k.startsWith(architecture+'.ssm.'))};
    if(cached.size>100)cached.delete(cached.keys().next().value);cached.set(file,{signature,info});return info;
  }finally{await handle.close();}
}
