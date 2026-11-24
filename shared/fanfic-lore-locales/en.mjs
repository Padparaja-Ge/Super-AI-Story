import worlds from './en-worlds.mjs';
import early from './en-sao-early.mjs';
import late from './en-sao-late.mjs';


import {fanficStarters} from '../fanfic-starter-catalog.mjs';
import {fanficWorldLore} from '../fanfic-lore-worlds.mjs';
import {fanficSupportLore} from '../fanfic-supporting-lore.mjs';

const catalog={...worlds,...early,...late};
for (const world of fanficStarters) for (const start of world.starts) {
  const book=catalog[world.id+'-'+start.id];
  book.entries.push(...[...fanficWorldLore[world.id],...fanficSupportLore[start.id]].map(({name,reference})=>[name,reference.name,reference.content]));
}
export default catalog;

