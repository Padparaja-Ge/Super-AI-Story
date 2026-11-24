export interface FanficLoreLocale {
  translate<T>(books:T[]|undefined):T[]|undefined;
  restore<T>(edited:T,original:T|undefined):T;
}
export function isFanficStarterLorebook(id:unknown):boolean;
export function loadFanficLoreLocale(books:unknown[]|undefined):Promise<FanficLoreLocale|null>;
export function localizeFanficLorebooks<T>(books:T[]):Promise<T[]>;
