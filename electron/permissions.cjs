// Electron reports origins with a trailing slash ("http://127.0.0.1:3210/")
// while appOrigin has none; compare normalised origins, never raw strings.
function sameOrigin(value, origin) {
  try { return !!value && new URL(value).origin === origin; } catch { return false; }
}
function ownFrame(contents, expected, origin, details) {
  if(!expected||contents!==expected||details?.isMainFrame!==true||!origin)return false;
  // requestingUrl decides; Electron leaves it empty for some checks, then the frame's own origin is used.
  return sameOrigin(details.requestingUrl || details.securityOrigin || details.embeddingOrigin, origin);
}
function requestPermission(contents,permission,details,expected,origin){
  if(!ownFrame(contents,expected,origin,details))return false;
  if(permission==='clipboard-sanitized-write'||permission==='speaker-selection')return true;
  return permission==='media'&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio');
}
// A granted microphone check is also what lets Chromium expose real host ICE
// candidates instead of mDNS names; without it voice fails over VPNs.
function checkPermission(contents,permission,requestingOrigin,details,expected,origin){
  if(!sameOrigin(requestingOrigin,origin)||!ownFrame(contents,expected,origin,details))return false;
  return permission==='clipboard-sanitized-write'||permission==='speaker-selection'||permission==='media'&&details.mediaType==='audio';
}
module.exports={requestPermission,checkPermission,sameOrigin};
