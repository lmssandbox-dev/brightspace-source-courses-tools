import {initLanguage, message, text} from './language.mjs';
import '@brightspace-ui/core/components/button/button.js';
import '@brightspace-ui/core/components/alert/alert.js';
import '@brightspace-ui/core/components/loading-spinner/loading-spinner.js';
import './app.css';

// Enhance real HTML buttons: native validation, submitter name/value and signed POSTs remain intact.
for (const native of document.querySelectorAll('button:not([data-sidebar-native]):not([data-org-sync])')) {
 const button=document.createElement('d2l-button');
 button.textContent=native.textContent;button.primary=native.classList.contains('primary');button.disabled=native.disabled;
 button.addEventListener('click',()=>native.click());
 native.after(button);native.hidden=true;
}
for(const input of document.querySelectorAll('[data-csv-target]')){
 const textarea=document.getElementById(input.dataset.csvTarget),statusMessage=document.getElementById(input.id.replace('-file','-message'));
 input.addEventListener('change',async()=>{
  const file=input.files[0];textarea.value='';input.setCustomValidity('');if(!file)return;
  input.setCustomValidity(text('Please wait for the CSV to finish loading.'));
  textarea.value='';
  if(file.size>Number(input.dataset.maxBytes||16384)){message(statusMessage,`This file exceeds ${Number(input.dataset.maxBytes)>16384?'5 MB':'16 KB'}. Choose a smaller CSV.`);input.value='';return;}
  try{const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(input.files[0]!==file)return;textarea.value=text;input.setCustomValidity('');message(statusMessage,`${file.name} loaded.`);}
  catch{message(statusMessage,'Could not read this file. Save it as UTF-8 CSV and try again.');input.value='';}
 });
 // Reveal the editor before native validation tries to focus an empty required textarea.
 textarea.addEventListener('invalid',()=>{const details=textarea.closest('details');if(details)details.open=true;});
}
for(const form of document.querySelectorAll('form')){
 form.addEventListener('submit',()=>{
  // Don't disable native submitters: their name/value must reach the server.
  for(const button of form.querySelectorAll('d2l-button'))button.disabled=true;
 });
}
// Browsers may restore a submitted page through their back/forward cache.
window.addEventListener('pageshow',()=>{for(const button of document.querySelectorAll('d2l-button'))button.disabled=false;});

// Navigation keeps the existing signed forms and entered values in their panels.
for(const link of document.querySelectorAll('[data-section]')){
 link.addEventListener('click',event=>{
  event.preventDefault();
  const section=link.dataset.section;
  for(const item of document.querySelectorAll('[data-section]'))item.removeAttribute('aria-current');
  link.setAttribute('aria-current','page');
  for(const panel of document.querySelectorAll('.workspace-content>section'))panel.hidden=panel.id!=='pane-'+section;
 });
}


// Keep component choices when switching modes, but display them only for selected copy.
for(const form of document.querySelectorAll('form[action="/copy/preview"]')){
 const selection=form.querySelector('[data-copy-selection]');
 const update=()=>{selection.hidden=form.querySelector('input[name="copyMode"]:checked')?.value!=='selected';};
 for(const radio of form.querySelectorAll('input[name="copyMode"]'))radio.addEventListener('change',update);
 update();
}

for(const form of document.querySelectorAll('#bulk-input')){
 const mode=form.querySelector('#schedule-mode'),uniform=form.querySelector('[data-uniform-dates]'),rulesPanel=form.querySelector('[data-rule-schedule]'),list=form.querySelector('[data-rule-list]'),json=form.querySelector('[name="rulesJson"]');
 const syncMode=()=>{const isRules=mode.value==='rules';uniform.hidden=isRules;rulesPanel.hidden=!isRules;for(const input of uniform.querySelectorAll('input')){input.disabled=isRules;input.required=!isRules;}for(const input of list.querySelectorAll('input,select')){input.disabled=!isRules;input.required=isRules&&input.type!=='hidden';}};
 const addRow=()=>{const index=list.children.length+1,section=document.createElement('fieldset');section.className='date-rule';section.dataset.rule='';section.innerHTML=`<legend>${text('Rule {0}').replace('{0}',index)}</legend><div class="date-rule-fields"><label class="field">${text('Rule ID')}<input data-rule-id maxlength="80" value="rule-${crypto.randomUUID()}" required></label><label class="field">${text('Rule label')}<input data-rule-label maxlength="120" required></label><label class="field">${text('Matching method')}<select data-rule-method><option value="contains">${text('Contains')}</option><option value="startsWith">${text('Starts with')}</option></select></label><label class="field">${text('Activity title pattern')}<input data-rule-pattern maxlength="200" required></label>${['start','due','end'].map(key=>`<label class="field">${text(`${key[0].toUpperCase()+key.slice(1)} date and time`)}<input data-rule-${key} type="datetime-local" step="1" required></label>`).join('')}</div><button type="button" class="secondary" data-remove-rule>${text('Remove rule')}</button>`;list.append(section);syncMode();};
 form.addEventListener('click',event=>{if(event.target.closest('[data-add-rule]')){if(list.children.length<20)addRow();return;}if(event.target.closest('[data-remove-rule]')){if(list.children.length>1)event.target.closest('[data-rule]').remove();}});
 mode.addEventListener('change',syncMode);syncMode();
 form.addEventListener('submit',event=>{const selected=[...form.querySelectorAll('[name="activityTypes"]:checked')];if(!selected.length){event.preventDefault();form.querySelector('[name="activityTypes"]').focus();return;}if(mode.value==='rules'){const entries=[...list.querySelectorAll('[data-rule]')].map(row=>({id:row.querySelector('[data-rule-id]').value,label:row.querySelector('[data-rule-label]').value,method:row.querySelector('[data-rule-method]').value,pattern:row.querySelector('[data-rule-pattern]').value,start:row.querySelector('[data-rule-start]').value,due:row.querySelector('[data-rule-due]').value,end:row.querySelector('[data-rule-end]').value}));if(entries.length<1||entries.length>20){event.preventDefault();return;}json.value=JSON.stringify(entries);}});
}

initLanguage();

// Remove the initial, dependency-free launch indicator after enhancement and translation.
document.querySelector('[data-launch-loading]')?.remove();

// Request a durable background refresh without navigating away or losing form inputs.
const orgSync=document.querySelector('[data-org-sync]');
if(orgSync){
 const feedback=document.querySelector('[data-org-sync-feedback]');let timer;
 orgSync.addEventListener('click',async()=>{
  orgSync.disabled=true;orgSync.setAttribute('aria-busy','true');clearTimeout(timer);
  feedback.hidden=false;message(feedback,'Requesting org unit sync…');
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await fetch('/org-directory/sync',{signal:controller.signal,method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ltik:orgSync.dataset.ltik,ticket:orgSync.dataset.ticket})});
   const result=await response.json();
   const labels={queued:'Org unit sync requested. It will run in the background.',running:'An org unit sync is already pending or running.',cooldown:'Please wait a minute before requesting another sync.',expired:'Relaunch through Brightspace to sync org units.',unauthorized:'Relaunch through Brightspace to sync org units.',unavailable:'Could not request the sync. Please try again.'};
   message(feedback,labels[result.state]||labels.unavailable);
  }catch{message(feedback,'Could not request the sync. Please try again.');}
  finally{clearTimeout(timeout);orgSync.disabled=false;orgSync.removeAttribute('aria-busy');timer=setTimeout(()=>{feedback.hidden=true;},8000);}
 });
}
