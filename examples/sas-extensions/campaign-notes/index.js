export function activate(sas) {
  sas.registerPage({id:'notes', title:'Заметки кампании', mount(container) {
    const panel=document.createElement('section');panel.className='campaign-notes-panel';
    const description=document.createElement('p');description.textContent='Заметки этого дополнения не отправляются модели и не меняют память SAS.';
    const selector=document.createElement('select');selector.setAttribute('aria-label','История для заметок');
    const area=document.createElement('textarea');area.rows=12;area.maxLength=12000;area.placeholder='Зацепки, идеи и планы…';area.setAttribute('aria-label','Заметки');
    const save=document.createElement('button');save.className='btn primary';save.textContent='Сохранить заметки';save.disabled=true;
    panel.append(description,selector,area,save);container.append(panel);let disposed=false;
    void (async()=>{
      const [state,room,saved]=await Promise.all([sas.state.read(),sas.request('/multiplayer/status'),sas.storage.read()]);if(disposed)return;
      const choices=[...state.chats.map(c=>({id:'chat:'+c.id,name:'RP · '+c.title})),...state.fanficProjects.map(p=>({id:'fanfic:'+p.id,name:'Фанфик · '+p.title})),...(room.running?[{id:'room:'+room.room.id,name:'Кампания · '+room.room.name}]:[])];
      for(const choice of choices){const option=document.createElement('option');option.value=choice.id;option.textContent=choice.name;selector.append(option);}
      const context=sas.getContext();selector.value=choices.some(c=>c.id==='chat:'+context.chatId)?'chat:'+context.chatId:choices[0]?.id||'';
      const show=async()=>{const current=await sas.storage.read();if(!disposed)area.value=current.value.notes?.[selector.value]||'';};
      area.value=saved.value.notes?.[selector.value]||'';selector.onchange=()=>{void show().catch(e=>sas.notify(e.message,true));};save.disabled=!choices.length;
      save.onclick=async()=>{save.disabled=true;try{const key=selector.value,text=area.value;await sas.storage.update(value=>{value.notes||={};value.notes[key]=text;});sas.notify('Заметки сохранены отдельно от памяти.');}catch(e){sas.notify(e.message,true);}finally{if(!disposed)save.disabled=false;}};
    })().catch(error=>sas.notify(error.message,true));
    return ()=>{disposed=true;save.onclick=null;selector.onchange=null;panel.remove();};
  }});
  sas.registerCommand({id:'open',title:'Заметки',slot:'topbar',run:()=>sas.navigate('extension:campaign-notes/notes')});
}
