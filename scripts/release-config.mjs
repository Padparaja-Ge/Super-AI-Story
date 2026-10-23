import fs from 'node:fs/promises';
import {validateNetwork} from '../server/network.mjs';

// Never package the mutable web-server.json (it can contain a user's key).
export async function releaseNetworkConfig(){
 const text=await fs.readFile(new URL('../web-server.example.json',import.meta.url),'utf8');
 const value=validateNetwork(JSON.parse(text));
 if(value.accessKey!==''||value.host!=='127.0.0.1'||value.mode!=='allowlist'||value.allowlist.some(ip=>!['localhost','127.0.0.1','::1'].includes(ip)))throw new Error('Release network template must be key-free and loopback-only.');
 return JSON.stringify(value,null,2)+'\n';
}
