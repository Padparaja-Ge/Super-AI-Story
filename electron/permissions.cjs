function ownFrame(contents, expected, origin, details) {
  if(!expected||contents!==expected||details?.isMainFrame!==true||!origin)return false;
  try{return new URL(details.requestingUrl).origin===origin;}catch{return false;}
}
function requestPermission(contents,permission,details,expected,origin){
  if(!ownFrame(contents,expected,origin,details))return false;
  if(permission==='clipboard-sanitized-write')return true;
  return permission==='media'&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio');
}
function checkPermission(contents,permission,requestingOrigin,details,expected,origin){
  if(requestingOrigin!==origin||!ownFrame(contents,expected,origin,details))return false;
  return permission==='clipboard-sanitized-write'||permission==='media'&&details.mediaType==='audio';
}
module.exports={requestPermission,checkPermission};
