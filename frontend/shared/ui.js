// Presentation only: no requests, actor authority, clinical storage or business transitions.
export function setText(element,value) {element.textContent=String(value ?? '');}
export function clearOnContextChange(client,clear) {return client.onContextClear(()=>clear());}

const paths = {
  person: ['M20 21v-2a7 7 0 0 0-14 0v2Z', 'M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  people: ['M16 21v-2a6 6 0 0 0-12 0v2', 'M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', 'M19 4a4 4 0 0 1 0 8', 'M20 15a5 5 0 0 1 2 4v2'],
  chevron: ['m6 9 6 6 6-6'],
  back: ['M19 12H5', 'm12 19-7-7 7-7'],
  close: ['m6 6 12 12', 'M6 18 18 6'],
  globe: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M3 12h18', 'M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z'],
  help: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2', 'M12 17h.01'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 11v6', 'M12 7h.01'],
  check: ['m5 12 4 4L19 6'],
  warning: ['M10.3 4a2 2 0 0 1 3.4 0l8 14a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3Z', 'M12 9v4', 'M12 17h.01'],
  signOut: ['M9 21H4V3h5', 'M9 12h12', 'm16 7 5 5-5 5'],
  plus: ['M12 5v14', 'M5 12h14'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['m8 5 11 7-11 7Z'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
  phone: ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  print: ['M6 9V3h12v6', 'M6 18H4V9h16v9h-2', 'M6 15h12v6H6Z', 'M17 12h.01'],
};

function element(tag, className, text) {
  const node=document.createElement(tag);
  if(className) node.className=className;
  if(text!==undefined) setText(node,text);
  return node;
}

export function icon(name) {
  if(!Object.hasOwn(paths,name)) throw new RangeError('Unknown UI icon');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',
    'stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round',class:'icon','aria-hidden':'true',focusable:'false'})) svg.setAttribute(key,value);
  for(const d of paths[name]) {
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);
  }
  return svg;
}

export function createNotice({tone='neutral',title,message,action}={}) {
  if(!['neutral','info','success','caution','danger'].includes(tone)) throw new RangeError('Unknown notice tone');
  const notice=element('div',`notice notice--${tone}`),copy=element('div','notice-copy');
  notice.append(icon(tone==='success'?'check':['danger','caution'].includes(tone)?'warning':'info'),copy);
  copy.append(element('p','notice-title',title));
  if(message) copy.append(element('p','notice-message',message));
  if(action) {
    const button=element('button','button button--secondary notice-action',action.label);button.type='button';
    button.addEventListener('click',action.onClick);copy.append(button);
  }
  return notice;
}

export function announce(message,{urgent=false}={}) {
  const id=urgent?'ui-alert':'ui-status';
  let region=document.getElementById(id);
  if(!region) {
    region=element('div','sr-only');region.id=id;region.setAttribute('role',urgent?'alert':'status');
    region.setAttribute('aria-live',urgent?'assertive':'polite');region.setAttribute('aria-atomic','true');document.body.append(region);
  }
  // An unchanged poll/status must not repeat a screen-reader announcement.
  if(region.textContent!==String(message ?? '')) setText(region,message);
}

export function setFieldError(field,errorNode,message) {
  if(!errorNode.id) throw new TypeError('Field error needs a stable ID');
  const descriptions=new Set((field.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean));
  field.setAttribute('aria-invalid',message?'true':'false');
  if(message) descriptions.add(errorNode.id);else descriptions.delete(errorNode.id);
  if(descriptions.size) field.setAttribute('aria-describedby',[...descriptions].join(' '));else field.removeAttribute('aria-describedby');
  setText(errorNode,message);errorNode.hidden=!message;
}

const busyControls=new WeakMap();
export function setBusy(button,busy,label='Working…') {
  const labelNode=button.querySelector('[data-button-label]');
  if(busy && !busyControls.has(button)) busyControls.set(button,{disabled:button.disabled,label:labelNode?.textContent});
  button.setAttribute('aria-busy',String(busy));
  if(busy) {button.disabled=true;if(labelNode) setText(labelNode,label);}
  else {
    const previous=busyControls.get(button);
    if(previous) {button.disabled=previous.disabled;if(labelNode) setText(labelNode,previous.label);busyControls.delete(button);}
  }
}

export function bindDisclosure(trigger,panel,{dismissOutside=false}={}) {
  if(!panel.id) throw new TypeError('Disclosure needs a stable panel ID');
  trigger.setAttribute('aria-controls',panel.id);trigger.setAttribute('aria-expanded',String(!panel.hidden));
  const setOpen=open=>{panel.hidden=!open;trigger.setAttribute('aria-expanded',String(open));};
  const click=()=>setOpen(panel.hidden);
  const key=event=>{if(event.key==='Escape' && !panel.hidden) {event.preventDefault();setOpen(false);trigger.focus();}};
  const outside=event=>{if(dismissOutside && !panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) setOpen(false);};
  trigger.addEventListener('click',click);panel.addEventListener('keydown',key);trigger.addEventListener('keydown',key);
  document.addEventListener('pointerdown',outside);
  return {open:()=>setOpen(true),close:()=>setOpen(false),destroy(){
    trigger.removeEventListener('click',click);panel.removeEventListener('keydown',key);trigger.removeEventListener('keydown',key);
    document.removeEventListener('pointerdown',outside);setOpen(false);
  }};
}

export function bindDialog(dialog,{dismissible=true}={}) {
  let returnFocus;
  const closed=()=>{document.documentElement.classList.remove('has-dialog');if(returnFocus?.isConnected) returnFocus.focus();};
  const cancelled=event=>{if(!dismissible) event.preventDefault();};
  const clicked=event=>{
    if(event.target.closest('[data-dialog-close]') && dismissible) dialog.close();
    else if(event.target===dialog && dismissible) {
      const rect=dialog.getBoundingClientRect();
      if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) dialog.close();
    }
  };
  dialog.addEventListener('close',closed);dialog.addEventListener('cancel',cancelled);dialog.addEventListener('click',clicked);
  return {open(trigger=document.activeElement){
    if(document.querySelector('dialog[open]')) return false;
    returnFocus=trigger;dialog.showModal();document.documentElement.classList.add('has-dialog');
    (dialog.querySelector('[data-initial-focus]') ?? dialog.querySelector('button, input, select, textarea, a[href]'))?.focus();
    return true;
  },close:()=>dialog.close(),destroy(){
    if(dialog.open) {dialog.close();closed();}
    dialog.removeEventListener('close',closed);dialog.removeEventListener('cancel',cancelled);dialog.removeEventListener('click',clicked);
  }};
}

export function bindTabs(root) {
  const list=root.querySelector('[role="tablist"]'),tabs=[...list.querySelectorAll('[role="tab"]')];
  const panels=tabs.map(tab=>document.getElementById(tab.getAttribute('aria-controls')));
  if(panels.some(panel=>!panel || !root.contains(panel))) throw new TypeError('Tabs need local panels');
  const select=tab=>tabs.forEach((item,index)=>{const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;panels[index].hidden=!selected;});
  const click=event=>{const tab=event.target.closest('[role="tab"]');if(tabs.includes(tab)) select(tab);};
  const key=event=>{
    const index=tabs.indexOf(document.activeElement),vertical=list.getAttribute('aria-orientation')==='vertical';
    if(index<0) return;
    const direction=event.key===(vertical?'ArrowDown':'ArrowRight')?1:event.key===(vertical?'ArrowUp':'ArrowLeft')?-1:0;
    const target=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):direction?tabs[(index+direction+tabs.length)%tabs.length]:null;
    if(target) {event.preventDefault();select(target);target.focus();}
  };
  select(tabs.find(tab=>tab.getAttribute('aria-selected')==='true') ?? tabs[0]);
  list.addEventListener('click',click);list.addEventListener('keydown',key);
  return ()=>{list.removeEventListener('click',click);list.removeEventListener('keydown',key);};
}

let nextHeaderId=0;
export function mountHeader(target,{area='provider',page='patients',accountLabel='Account',roleLabel='',onSignOut}={}) {
  const prefix=`header-${++nextHeaderId}`;
  const header=element('header','shell-header'),bar=element('div','shell-bar'),identity=element('div','shell-identity');
  identity.append(element('span','brand','VaultMed'));
  if(area==='provider') {
    const nav=element('nav','shell-navigation'),link=element('a','nav-link',page==='encounter'?'Patient list':'Patients');
    nav.setAttribute('aria-label','Main navigation');link.href='../patients/';link.prepend(icon(page==='encounter'?'back':'people'));
    if(page==='patients') link.setAttribute('aria-current','page');nav.append(link);identity.append(nav);
  }
  const account=element('div','account'),trigger=element('button','account-trigger');trigger.type='button';
  const accountCopy=element('span','account-copy');accountCopy.append(element('span','',accountLabel));
  if(roleLabel) accountCopy.append(element('span','account-role',roleLabel));
  trigger.append(icon('person'),accountCopy,icon('chevron'));
  const menu=element('div','account-menu');menu.id=`${prefix}-account`;menu.hidden=true;
  account.append(trigger,menu);
  const accountRegion=element('div','shell-account');accountRegion.append(element('span','demo-label','Fictional demo'),account);
  bar.append(identity,accountRegion);header.append(bar);target.replaceChildren(header);
  const disclosure=bindDisclosure(trigger,menu,{dismissOutside:true}),cleanups=[()=>disclosure.destroy()];

  function utilityDialog(title,body) {
    const dialog=element('dialog','dialog');dialog.setAttribute('aria-labelledby',`${prefix}-${title.toLowerCase()}-title`);
    const head=element('div','dialog-head'),heading=element('h2','dialog-title',title),close=element('button','dialog-close');
    heading.id=dialog.getAttribute('aria-labelledby');close.type='button';close.setAttribute('aria-label',`Close ${title.toLowerCase()}`);
    close.setAttribute('data-dialog-close','');close.append(icon('close'));head.append(heading,close);
    const content=element('div','dialog-body stack');content.append(...body);dialog.append(head,content);document.body.append(dialog);
    const controller=bindDialog(dialog);cleanups.push(()=>{controller.destroy();dialog.remove();});return controller;
  }
  const language=utilityDialog('Language',[
    element('p','','English is the available interface language.'),
    element('p','muted','Hindi interface translation is not available yet.'),
  ]);
  const help=utilityDialog('Help',[
    element('p','','Ask a member of hospital staff if you need help using this page.'),
    element('p','','For urgent care, speak to qualified staff now.'),
  ]);
  function action(label,name,controller,parent=menu) {
    const button=element('button',parent===menu?'menu-action':'button button--secondary',label);button.type='button';button.prepend(icon(name));
    button.addEventListener('click',()=>{disclosure.close();controller.open(parent===menu?trigger:button);});parent.append(button);
  }
  if(area==='patient') {const utilities=element('div','shell-utilities');header.append(utilities);action('Language: English','globe',language,utilities);action('Help','help',help,utilities);}
  else {action('Language: English','globe',language);action('Help','help',help);menu.append(element('hr','menu-divider'));}
  if(onSignOut) {
    if(area==='patient') menu.append(element('p','field-help account-note','Signing out does not stop sharing. Use Stop sharing on your visit.'));
    const signOut=element('button','menu-action','Sign out');signOut.type='button';signOut.prepend(icon('signOut'));
    signOut.addEventListener('click',()=>{disclosure.close();onSignOut();});menu.append(signOut);
  } else {const signIn=element('a','menu-action','Sign in');signIn.href='../login/';signIn.prepend(icon('person'));menu.append(signIn);}
  return ()=>{for(const cleanup of cleanups) cleanup();target.replaceChildren();};
}
