import { api } from '../shared/api.js';
import { session } from '../shared/session.js';
import { mountHeader, createNotice, setText, icon } from '../shared/ui.js';

mountHeader(document.getElementById('app-header'),{area:'utility'});
const panel=document.getElementById('demo-account-panel'),accounts=document.getElementById('demo-accounts');
const notice=document.getElementById('login-notice'),checking=document.getElementById('session-check');
let submitting=false;
function continueToAccount(value) {
  if(!value?.authenticated)return false;
  if(!['PATIENT','STAFF','CLINICIAN'].includes(value.actor?.role))throw new Error('Unsupported account');
  location.replace(value.actor.role==='PATIENT'?'../patient-visit/':'../patients/');return true;
}
function message(title,body,tone='caution',action) {notice.replaceChildren(createNotice({tone,title,message:body,action}));}
async function chooseAccount(account,button) {
  if(submitting)return;submitting=true;notice.replaceChildren();
  for(const item of accounts.querySelectorAll('button'))item.disabled=true;
  button.setAttribute('aria-busy','true');checking.hidden=false;setText(checking,'Signing in…');
  try {if(!continueToAccount(await session.signInDemo(account.username)))throw new Error('Unconfirmed sign-in');}
  catch(error) {
    const uncertain=error.commit_state==='UNKNOWN'||error.retry_strategy==='SAME_KEY';
    message(uncertain?'Sign-in not confirmed':'Unable to sign in',uncertain?'Choose the same account again to check this sign-in.':'Try again or ask hospital staff for help.');
  } finally {
    submitting=false;checking.hidden=true;button.removeAttribute('aria-busy');
    for(const item of accounts.querySelectorAll('button'))item.disabled=false;
  }
}
async function loadAccounts() {
  panel.hidden=true;accounts.replaceChildren();checking.hidden=false;setText(checking,'Loading demo accounts…');
  try {
    const value=await api.read('/auth/demo/accounts');
    if(value.simulation!==true||!Array.isArray(value.accounts)||!value.accounts.length)throw new Error('No demo accounts');
    for(const [role,title] of [['CLINICIAN','Clinicians'],['STAFF','Room staff'],['PATIENT','Patients']]) {
      const group=document.createElement('div');group.className='demo-account-group';
      const heading=document.createElement('h2');heading.className='section-label';setText(heading,title);group.append(heading);
      for(const account of value.accounts.filter(item=>item.role===role)) {
        const button=document.createElement('button');button.type='button';button.className='demo-account-button';button.dataset.username=account.username;
        const copy=document.createElement('span');copy.className='demo-account-copy';
        const name=document.createElement('span');name.className=role==='PATIENT'?'patient-name':'demo-account-name';
        setText(name,role==='CLINICIAN'?'Clinician':role==='STAFF'?'Room staff':account.display_name);
        const detail=document.createElement('span');detail.className='muted';
        setText(detail,role==='PATIENT'?'Patient account':account.room_ids.map(id=>`Room ${id.replace('room_','')}`).join(' · '));
        copy.append(name,detail);button.append(icon(role==='PATIENT'?'person':'people'),copy,icon('chevron'));
        button.addEventListener('click',()=>void chooseAccount(account,button));group.append(button);
      }
      if(group.childElementCount>1)accounts.append(group);
    }
    panel.hidden=false;
  } catch {message('Demo accounts unavailable','Check your connection and reload the account list.','caution',{label:'Reload accounts',onClick:loadAccounts});}
  finally {checking.hidden=true;}
}
api.onContextClear(reason=>{if(reason==='DATASET_CHANGED'){panel.hidden=true;accounts.replaceChildren();message('Session details changed','Reload the account list before continuing.','caution',{label:'Reload accounts',onClick:loadAccounts});}});
try {if(!continueToAccount(await session.recover()))await loadAccounts();}
catch {await loadAccounts();}
