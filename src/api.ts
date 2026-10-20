export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {method: method || (body === undefined ? 'GET' : 'POST'), headers: {'Content-Type': 'application/json', 'X-SAS-Client': 'desktop'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Ошибка ${response.status}`);
  if((path==='/generations'||path.startsWith('/wizard/')||path.startsWith('/fanfic/'))&&data.status==='running'&&data.id)window.dispatchEvent(new CustomEvent('sas-task',{detail:data}));
  return data;
}
export function downloadJSON(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
export async function copyText(text:string){
  if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);return;}catch{}}
  const previous=document.activeElement as HTMLElement|null,area=document.createElement('textarea');
  area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();
  try{if(!document.execCommand('copy'))throw new Error('Браузер не разрешил копирование.');}finally{area.remove();previous?.focus();}
}
export async function readImport(file: File) {
  if (file.size > 15 * 1024 * 1024) throw new Error('Файл должен быть меньше 15 МБ.');
  if (file.name.toLowerCase().endsWith('.png')) return await new Promise<string>((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);});
  try {return JSON.parse(await file.text());} catch {throw new Error('Не удалось прочитать JSON. Проверьте формат файла.');}
}
