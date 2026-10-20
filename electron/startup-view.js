window.sasStartup.subscribe(status=>{
 document.querySelector('#phase').textContent=status.error||status.phase;
 document.querySelector('#fill').style.width=status.progress+'%';
 document.querySelector('#percent').textContent=status.progress+'%';
 document.querySelector('#bar').setAttribute('aria-valuenow',String(status.progress));
 document.body.classList.toggle('error',!!status.error);
});
document.querySelector('#close').addEventListener('click',()=>window.sasStartup.close());
