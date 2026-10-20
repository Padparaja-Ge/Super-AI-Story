export function safeAvatar(value){
  if(typeof value!=='string'||!value)return '✧';
  if(value.startsWith('data:'))return value.length<=64000&&/^data:image\/(png|jpeg|webp);base64,[a-z\d+/]+={0,2}$/i.test(value)?value:'✧';
  if(value.length>32||/^https?:/i.test(value))return '✧';
  return value;
}
