export interface GuidePreferences {version:1;enabled:boolean;welcomed:boolean;completed:boolean;step:number}
export interface GuideStep {id:string;label:string;title:string;view:string;action:string;description:string;points:string[];tip:string}
export const GUIDE_STORAGE_KEY:string;
export const GUIDE_STEPS:ReadonlyArray<GuideStep>;
export function guidePreferences(input?:unknown):GuidePreferences;
export function readGuidePreferences(storage:Pick<Storage,'getItem'>):GuidePreferences;
export function writeGuidePreferences(storage:Pick<Storage,'setItem'>,value:unknown):GuidePreferences;
