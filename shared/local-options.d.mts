export type OptionField={key:string;label:string;default:number|string;min?:number;max?:number;step?:number;options?:string[];hint?:string};
export const runtimeFields:OptionField[];
export const samplingFields:OptionField[];
export const runtimeDefaults:Record<string,any>;
export const samplingDefaults:Record<string,any>;
export function normalizeOptions(input?:Record<string,any>,fields?:OptionField[]):Record<string,any>;
export function samplingBody(input?:Record<string,any>):Record<string,number>;
