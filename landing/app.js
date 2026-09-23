const root=document.documentElement;
const configuredTelegramUrl=(root.dataset.telegramUrl||'').trim();
const telegramCtas=[...document.querySelectorAll('[data-telegram-cta]')];
const toast=document.querySelector('[data-telegram-toast]');
const header=document.querySelector('[data-header]');

function isSafeTelegramUrl(value){
  if(!value)return false;
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&(url.hostname==='t.me'||url.hostname.endsWith('.t.me'));
  }catch{return false}
}
for(const cta of telegramCtas){
  if(isSafeTelegramUrl(configuredTelegramUrl)){
    cta.href=configuredTelegramUrl;cta.target='_blank';cta.rel='noopener noreferrer';
  }else{
    cta.addEventListener('click',event=>{
      event.preventDefault();
      if(toast){toast.hidden=false;window.setTimeout(()=>{toast.hidden=true},6000)}
    });
  }
}
toast?.querySelector('button')?.addEventListener('click',()=>{toast.hidden=true});
function syncHeader(){header?.classList.toggle('is-scrolled',window.scrollY>24)}
window.addEventListener('scroll',syncHeader,{passive:true});syncHeader();
for(const details of document.querySelectorAll('[data-faq] details')){
  details.addEventListener('toggle',()=>{
    if(!details.open)return;
    for(const other of document.querySelectorAll('[data-faq] details'))if(other!==details)other.open=false;
  });
}
