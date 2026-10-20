export const abilities:string[];
export const abilityNames:Record<string,string>;
export function defaultAbilities():Record<string,number>;
export function modifier(value:number):number;
export function validateSRP(value:any):{level:number;skills:any[];inventory:any[];spells:any[];kind:'srp';className:string;abilities:Record<string,number>};
