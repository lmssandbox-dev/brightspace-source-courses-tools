import i18n from './i18n.js';
const {translate,normalizeLanguage}=i18n;
let language=normalizeLanguage(document.documentElement.dataset.uiLanguage);
try{language=normalizeLanguage(localStorage.getItem('brightspace-tools-language')||language);}catch{}
const texts=new WeakMap(),attributes=new WeakMap();
export function message(element,english){texts.delete(element);element.textContent=english;applyLanguage();}
export function text(english){return translate(english,language);}
export function applyLanguage(){
 document.documentElement.lang=language;
 for(const node of document.querySelectorAll('form')){
  if(node.method==='dialog')continue;
  let input=node.querySelector('input[name="uiLanguage"]');
  if(!input){input=document.createElement('input');input.type='hidden';input.name='uiLanguage';node.append(input);}input.value=language;
 }
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()){
  const node=walker.currentNode;
  if(node.parentElement?.closest('script,style,textarea,code,pre,[translate="no"],[data-language-selector]'))continue;
  if(!texts.has(node))texts.set(node,node.nodeValue);
  node.nodeValue=translate(texts.get(node),language);
 }
 for(const el of document.querySelectorAll('[aria-label],[title]')){
  if(el.closest('[translate="no"],[data-language-selector]'))continue;
  if(!attributes.has(el))attributes.set(el,{label:el.getAttribute('aria-label'),title:el.getAttribute('title')});
  const original=attributes.get(el);
  if(original.label)el.setAttribute('aria-label',translate(original.label,language));
  if(original.title)el.setAttribute('title',translate(original.title,language));
 }
 document.title=translate('Brightspace Source Courses Tools',language);
 const selector=document.querySelector('[data-language-selector]');if(selector)selector.value=language;
}
export function initLanguage(){
 applyLanguage();
 document.querySelector('[data-language-selector]')?.addEventListener('change',event=>{
  language=normalizeLanguage(event.target.value);
  try{localStorage.setItem('brightspace-tools-language',language);}catch{}
  applyLanguage();
 });
}
