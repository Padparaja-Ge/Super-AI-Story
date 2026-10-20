export async function avatarUpload(file:File):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024)throw new Error('Выберите PNG, JPEG или WebP до 8 МБ.');
  const source=URL.createObjectURL(file);
  try {const img=new Image();img.src=source;await img.decode();const canvas=document.createElement('canvas');canvas.width=192;canvas.height=192;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Не удалось подготовить аватар.');const scale=Math.min(192/img.width,192/img.height),w=img.width*scale,h=img.height*scale;ctx.drawImage(img,(192-w)/2,(192-h)/2,w,h);const result=canvas.toDataURL('image/webp',.8);if(result.length>64000)throw new Error('Не удалось уменьшить аватар. Выберите другое изображение.');return result;}finally{URL.revokeObjectURL(source);}
}
