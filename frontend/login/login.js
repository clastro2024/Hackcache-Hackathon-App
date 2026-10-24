import { api } from '../shared/api.js';
import { session } from '../shared/session.js';
import { mountHeader, createNotice, setFieldError, setBusy, setText } from '../shared/ui.js';

mountHeader(document.getElementById('app-header'), { area: 'utility' });
const form=document.getElementById('login-form'),username=form.elements.username,password=form.elements.password;
const submit=document.getElementById('sign-in'),toggle=document.getElementById('password-toggle');
const notice=document.getElementById('login-notice'),checking=document.getElementById('session-check');
let submitting=false;

function continueToAccount(value) {
  if(!value?.authenticated) return false;
  const role=value.actor?.role;
  if(!['PATIENT','STAFF','CLINICIAN'].includes(role)) throw new Error('Unsupported account');
  location.replace(role==='PATIENT'?'../patient-visit/':'../patients/');return true;
}
function message(title,body,tone='caution') {notice.replaceChildren(createNotice({tone,title,message:body}));}
toggle.addEventListener('click',()=>{
  const visible=password.type==='password';password.type=visible?'text':'password';
  toggle.setAttribute('aria-pressed',String(visible));setText(toggle,visible?'Hide':'Show');
});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(submitting)return;
  const missingName=!username.value.trim(),missingPassword=!password.value;
  setFieldError(username,document.getElementById('username-error'),missingName?'Enter your username.':'');
  setFieldError(password,document.getElementById('password-error'),missingPassword?'Enter your password.':'');
  if(missingName || missingPassword) {(missingName?username:password).focus();return;}
  submitting=true;notice.replaceChildren();setBusy(submit,true,'Signing in…');
  username.disabled=true;password.disabled=true;toggle.disabled=true;
  const credential=password.value;password.value='';password.type='password';toggle.setAttribute('aria-pressed','false');setText(toggle,'Show');
  let label='Sign in';
  try {
    const current=await session.signIn(username.value,credential);
    if(!continueToAccount(current)) message('Sign-in not confirmed','Enter your password to try again.');
  } catch(error) {
    if(error.code==='INVALID_CREDENTIALS') message('Check your sign-in details','The username or password was not accepted.','danger');
    else if(error.code==='LOGIN_REAUTH_REQUIRED') message('Sign in again','The earlier sign-in could not be recovered. Enter your password to start a new sign-in.');
    else if(error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY') {
      message('Sign-in not confirmed','Enter your password again to check the same sign-in.');label='Check sign-in';
    } else if(error.code==='RATE_LIMITED' || error.code==='AUTH_BUSY') message('Please wait before signing in again','The server is limiting sign-in attempts. Your password has been cleared.');
    else message('Unable to sign in','Check your connection or ask your setup operator for help. Your password has been cleared.');
  } finally {
    submitting=false;setBusy(submit,false);setText(submit.querySelector('[data-button-label]'),label);
    username.disabled=false;password.disabled=false;toggle.disabled=false;
    if(notice.childElementCount) password.focus();
  }
});
api.onContextClear(reason=>{
  if(reason==='DATASET_CHANGED') {form.reset();message('Session details changed','Enter your assigned account details again.');}
});
try {continueToAccount(await session.recover());}
catch {message('Session could not be checked','You can enter your account details below. Sign-in still requires a response from the server.');}
finally {checking.hidden=true;form.hidden=false;}
