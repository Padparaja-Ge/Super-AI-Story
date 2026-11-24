import {fanficStarters as starterCatalog} from './fanfic-starter-catalog.mjs';

const starterBooks = new Set(starterCatalog.flatMap(starter=>starter.starts.map(start=>starter.id+'-'+start.id)));
export const isFanficStarterLorebook = id => starterBooks.has(id);
const canonicalBooks = new Map();
let canonicalReady;

function buildCanonicalBooks() {
  return canonicalReady ??= import('./fanfic-starters.mjs').then(({fanficStarters,buildFanficStarter}) => {
    for (const starter of fanficStarters) for (const start of starter.starts) {
      const [book] = buildFanficStarter(starter.id,start.id).lorebooks;
      canonicalBooks.set(book.id,book);
    }
  });
}

export async function loadFanficLoreLocale(books) {
  if (!books?.some(book=>book.language==='en'&&isFanficStarterLorebook(book.id))) return null;
  const [{default:catalog}] = await Promise.all([import('./fanfic-lore-locales/en.mjs'),buildCanonicalBooks()]);

  function translation(book) {
    const base = canonicalBooks.get(book.id);
    const local = catalog[book.id];
    if (book.language!=='en' || !base || !local) return book;
    const entries = new Map(base.entries.map((entry,index)=>[entry.id,{entry,local:local.entries[index]}]));
    return {...book,name:book.name===base.name?local.name:book.name,entries:book.entries.map(entry=>{
      const reference=entries.get(entry.id);
      if (!reference?.local) return entry;
      const [sourceName,name,content]=reference.local;
      if (reference.entry.name!==sourceName) return entry;
      return {...entry,
        name:entry.name===sourceName?name:entry.name,
        content:entry.content===reference.entry.content?content:entry.content
      };
    })};
  }

  function restore(edited,original) {
    if (!original) return edited;
    const shown=translation(original);
    const originals=new Map(original.entries.map(entry=>[entry.id,entry]));
    const visible=new Map(shown.entries.map(entry=>[entry.id,entry]));
    return {...edited,name:edited.name===shown.name?original.name:edited.name,entries:edited.entries.map(entry=>{
      const before=originals.get(entry.id),rendered=visible.get(entry.id);
      if (!before||!rendered) return entry;
      return {...entry,name:entry.name===rendered.name?before.name:entry.name,content:entry.content===rendered.content?before.content:entry.content};
    })};
  }

  return {translate:books=>books?.map(translation),restore};
}

export async function localizeFanficLorebooks(books) {
  const locale=await loadFanficLoreLocale(books);
  return locale?locale.translate(books):books;
}
