export type DiceCinematic='divine-blessing'|'deaths-judgment';
export interface VisualDie{sides:number;value:number;kept:boolean}
export interface VisualRoll{
 id:string;eventId:string;kind:string;actorId:string;targetId:string;attackId:string;title:string;mode:string;text:string;
 dc:number|null;outcome:string|null;success:boolean|null;critical:'success'|'failure'|null;naturalCritical:string|null;
 cinematic:DiceCinematic|null;dice:VisualDie[];modifier:number;total:number|null;applied?:number|null;damageType?:string;raw?:number|null;
}
export type Mat3=number[][];
export const VISUAL_DICE_SIDES:ReadonlyArray<number>;
export const ROLL_EVENT_KINDS:ReadonlyArray<string>;
export function parseDiceExpression(expression:unknown):{count:number;sides:number}|null;
export function physicalFaces(sides:number,value:number):{model:string;label:string}[];
export function hasPhysicalDie(sides:number):boolean;
export function valueFromFaces(sides:number,faces:{label:string}[]):number;
export function visualRollFromEvent(event:any):VisualRoll|null;
export function collectNewRolls(log:any[],seen:Set<string>):VisualRoll[];
export function applyMatrix(m:Mat3,v:number[]):number[];
export function symmetryRotation(axes:number[][],from:number,to:number,tolerance?:number):Mat3;
