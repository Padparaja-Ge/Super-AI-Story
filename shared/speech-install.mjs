export function pipProgress(job){
  let pending='';
  return chunk=>{
    pending=(pending+chunk).slice(-32000);
    const lines=pending.split(/[\r\n]+/);pending=lines.pop()||'';
    for(const line of lines){
      const file=line.match(/(?:Downloading|Using cached)\s+([A-Za-z0-9_.%+-]+\.(?:whl|tar\.gz|zip))(?:\s|$)/);
      if(file){try{job.runtimeFile=decodeURIComponent(file[1]).slice(0,160);}catch{job.runtimeFile=file[1].slice(0,160);}job.runtimeDownloaded=0;job.runtimeTotal=0;}
      const progress=line.match(/^Progress (\d+) of (\d+)\s*$/);
      if(progress){const current=Number(progress[1]),total=Number(progress[2]);if(Number.isSafeInteger(current)&&Number.isSafeInteger(total)&&current>=0&&total>0&&current<=total){job.runtimeDownloaded=current;job.runtimeTotal=total;}}
      if(/^Installing collected packages:|^Successfully installed|^Requirement already satisfied/.test(line.trim())){job.runtimeDownloaded=0;job.runtimeTotal=0;job.runtimeFile='';}
    }
  };
}

export function installationProgress(job){
  if(job.phase==='runtime'||job.phase==='presets'||job.phase==='verify')return {downloaded:job.runtimeDownloaded||0,total:job.runtimeTotal||0,label:job.runtimeFile||'Подготовка и проверка библиотек',weightsComplete:true};
  return {downloaded:job.downloaded||0,total:job.total||0,label:'Файлы модели',weightsComplete:false};
}
