export interface FanficStarterCard {id?:string;name:string;subtitle:string;personality:string;appearance:string;exampleDialogue?:string;aliases?:string[]}
export interface FanficStart {id:string;label:string;setup:string;pivot:string;cast:string[];support:Record<string,string>;season:number;source?:string}
export interface FanficStarter {id:string;title:string;tone:string;label:string;source:string;world:string;cast:Record<string,FanficStarterCard>;starts:FanficStart[]}
export const fanficStarters:FanficStarter[];
export function buildFanficStarter(starterId:string,startId:string,options?:{originalPersona?:unknown;canonCharacter?:string;loreLanguage?:'ru'|'en'}):unknown;
