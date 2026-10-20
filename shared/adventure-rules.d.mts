export const adventureRuleFields:ReadonlyArray<{key:string;label:string;group:string;defaultValue:number|boolean;min?:number;max?:number;type:string}>;
export const adventureRulesDefaults:Record<string,any>;
export function normalizeAdventureRules(mode:string,value?:any):any;
