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
  const languageChoices=element('div','stack');
  const language=utilityDialog('Language',[element('p','','Choose the interface language. Clinical records keep their original wording.'),languageChoices]);
  for(const [code,label] of [['en','English'],['hi','हिन्दी']]) {
    const choice=element('button','button button--secondary',label);choice.type='button';choice.lang=code;choice.translate=false;
    choice.addEventListener('click',()=>{setInterfaceLanguage(code);for(const item of languageChoices.children) item.setAttribute('aria-pressed',String(item===choice));language.close();});
    choice.setAttribute('aria-pressed',String(code===interfaceLanguage()));languageChoices.append(choice);
  }
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
    else if(roleLabel==='Clinician') menu.append(element('p','field-help account-note','Signing out cancels this clinician session’s pending sharing requests and ends its shared access.'));
    const signOut=element('button','menu-action','Sign out');signOut.type='button';signOut.prepend(icon('signOut'));
    signOut.addEventListener('click',()=>{disclosure.close();onSignOut();});menu.append(signOut);
  } else {const signIn=element('a','menu-action','Sign in');signIn.href='../login/';signIn.prepend(icon('person'));menu.append(signIn);}
  initializeLanguage();
  return ()=>{for(const cleanup of cleanups) cleanup();target.replaceChildren();};
}

// Only an interface-language preference is stored. Patient, session and clinical
// data never enter browser storage. Record/source regions are excluded below.
let languageCode='en',languageObserver;
try {if(sessionStorage.getItem('vaultmed-interface-language')==='hi') languageCode='hi';} catch {}
export function interfaceLanguage() {return languageCode;}
const hindiUI={
  'Account':'खाता','Main navigation':'मुख्य नेविगेशन','Patients':'मरीज़','Patient list':'मरीज़ों की सूची','Your visit':'आपकी मुलाक़ात','Fictional demo':'काल्पनिक डेमो','Fictional demo facility':'काल्पनिक डेमो सुविधा',
  'Language':'भाषा','Language: English':'भाषा: हिन्दी','Help':'सहायता','Sign out':'साइन आउट','Sign in':'साइन इन','Go to sign in':'साइन इन करें','Sign in to continue':'आगे बढ़ने के लिए साइन इन करें',
  'Choose the interface language. Clinical records keep their original wording.':'इंटरफ़ेस की भाषा चुनें। चिकित्सा रिकॉर्ड अपने मूल शब्दों में रहेंगे।',
  'Ask a member of hospital staff if you need help using this page.':'इस पेज का उपयोग करने में सहायता के लिए अस्पताल के कर्मचारी से पूछें।','For urgent care, speak to qualified staff now.':'तत्काल देखभाल के लिए अभी योग्य कर्मचारी से बात करें।',
  'Signing out does not stop sharing. Use Stop sharing on your visit.':'साइन आउट करने से रिकॉर्ड साझा करना बंद नहीं होता। अपनी मुलाक़ात में साझा करना बंद करें चुनें।',
  'Signing out cancels this clinician session’s pending sharing requests and ends its shared access.':'साइन आउट करने से इस चिकित्सक सत्र के लंबित साझाकरण अनुरोध रद्द हो जाते हैं और इसकी साझा पहुँच समाप्त हो जाती है।',
  'The request lasts up to five minutes and ends if you sign out. The patient can respond on their device, or permitted staff can assist. New care can continue.':'अनुरोध अधिकतम पाँच मिनट तक रहता है और आपके साइन आउट करने पर समाप्त हो जाता है। मरीज़ अपने उपकरण पर उत्तर दे सकता है या अनुमति प्राप्त कर्मचारी सहायता कर सकते हैं। नई देखभाल जारी रह सकती है।',
  'Skip to content':'मुख्य सामग्री पर जाएँ','Username':'यूज़रनेम','Password':'पासवर्ड','Show':'दिखाएँ','Hide':'छिपाएँ','Checking your session…':'आपका सत्र जाँचा जा रहा है…','Signing in…':'साइन इन हो रहा है…',
  'Room staff':'कक्ष कर्मचारी','Clinician':'चिकित्सक','Room':'कक्ष','Active':'सक्रिय','On break':'विराम पर','Pause queue':'कतार रोकें','Resume queue':'कतार फिर चालू करें','Register patient':'मरीज़ का पंजीकरण',
  'Position':'स्थान','Token':'टोकन','Patient':'मरीज़','Status':'स्थिति','Actions':'कार्रवाइयाँ','Current':'वर्तमान','Returned':'वापस आए','Transferred':'स्थानांतरित','More actions':'अन्य कार्रवाइयाँ',
  'Current patient, position 0':'वर्तमान मरीज़, स्थान 0',
  'Awaiting arrival':'आने की प्रतीक्षा','In consultation':'परामर्श जारी','Confirm arrival':'आगमन की पुष्टि','Call again':'फिर बुलाएँ','Mark absent':'अनुपस्थित दर्ज करें','Open encounter':'परामर्श खोलें',
  'Complete visit':'मुलाक़ात पूरी करें','Withdraw visit':'मुलाक़ात हटाएँ','Confirm return':'वापसी की पुष्टि','Confirm patient return':'मरीज़ की वापसी की पुष्टि','Call next patient':'अगले मरीज़ को बुलाएँ',
  'Print token':'टोकन प्रिंट करें','Preparing token…':'टोकन तैयार हो रहा है…','Loading sample guidance for the printed slip.':'पर्ची के लिए नमूना मार्गदर्शन लोड हो रहा है।','Sample step-free directions from entrance':'प्रवेश से बिना सीढ़ियों का नमूना मार्ग',
  'Patient details':'मरीज़ का विवरण','New local patient':'नया स्थानीय मरीज़','Existing local patient reference':'मौजूदा स्थानीय मरीज़ का संदर्भ','Local patient reference':'स्थानीय मरीज़ का संदर्भ',
  'Use the hospital’s existing reference after checking it with the patient. Name search is not available.':'मरीज़ से जाँच करने के बाद अस्पताल का मौजूदा संदर्भ उपयोग करें। नाम से खोज उपलब्ध नहीं है।',
  'Patient name':'मरीज़ का नाम','Date of birth':'जन्म तिथि','(optional)':'(वैकल्पिक)','Preferred language':'पसंदीदा भाषा','Issue token':'टोकन जारी करें','Enter the patient’s name.':'मरीज़ का नाम लिखें।',
  'Create a local visit. This does not create a patient account. Use fictional details only.':'स्थानीय मुलाक़ात बनाएँ। इससे मरीज़ का खाता नहीं बनता। केवल काल्पनिक विवरण दें।',
  'Enter the existing local patient reference.':'मौजूदा स्थानीय मरीज़ का संदर्भ लिखें।','Interface language can be changed from the Language menu.':'इंटरफ़ेस की भाषा भाषा मेनू से बदलें।',
  'Discard these details?':'क्या ये विवरण हटाएँ?','A token has not been requested.':'टोकन का अनुरोध नहीं किया गया है।','Keep editing':'संपादन जारी रखें','Discard details':'विवरण हटाएँ','Cancel':'रद्द करें','Confirm':'पुष्टि करें',
  'No patients are waiting in this room.':'इस कक्ष में कोई मरीज़ प्रतीक्षा में नहीं है।','Help with sharing choice':'साझा करने के निर्णय में सहायता','Confirm the assistance':'सहायता की पुष्टि करें',
  'The patient is present':'मरीज़ उपस्थित है','I checked the patient’s visit details':'मैंने मरीज़ की मुलाक़ात का विवरण जाँचा है','I will record the patient’s actual choice':'मैं मरीज़ का वास्तविक निर्णय दर्ज करूँगा/करूँगी',
  'Explain the request to the patient and record their actual choice. A printed reference or QR does not establish identity or consent.':'मरीज़ को अनुरोध समझाएँ और उनका वास्तविक निर्णय दर्ज करें। प्रिंट किया संदर्भ या QR पहचान या सहमति का प्रमाण नहीं है।',
  'No sharing request or active grant for this encounter. The clinician must request access first.':'इस परामर्श के लिए कोई अनुरोध या सक्रिय अनुमति नहीं है। पहले चिकित्सक को पहुँच का अनुरोध करना होगा।',
  'Sharing is active':'रिकॉर्ड साझा करना जारी है','Question for the clinician (required for Ask why)':'चिकित्सक के लिए प्रश्न (कारण पूछने के लिए आवश्यक)','Enter the patient’s question':'मरीज़ का प्रश्न लिखें','Ask the patient what they would like explained.':'मरीज़ से पूछें कि वे क्या समझना चाहते हैं।',
  'Share records for this visit?':'इस मुलाक़ात के लिए रिकॉर्ड साझा करें?','Another request to share records':'रिकॉर्ड साझा करने का एक और अनुरोध','Why?':'क्यों?','What is shared?':'क्या साझा होगा?','How long?':'कितनी देर?',
  'Recorded history':'दर्ज चिकित्सा इतिहास','Detailed recorded history':'विस्तृत दर्ज इतिहास','Visit questions':'मुलाक़ात के प्रश्न','Optional checks':'वैकल्पिक जाँच','A copy of your reviewed summary':'समीक्षित सारांश की एक प्रति','Reviewed summary':'समीक्षित सारांश',
  'Up to 15 minutes for this visit.':'इस मुलाक़ात के लिए अधिकतम 15 मिनट।','Allow':'अनुमति दें','Deny':'अनुमति न दें','Ask why':'कारण पूछें','Stop sharing':'साझा करना बंद करें',
  'What would you like explained?':'आप क्या समझना चाहते हैं?','Send question':'प्रश्न भेजें','Enter what you would like explained.':'आप क्या समझना चाहते हैं, लिखें।','You asked for an explanation. You can decide after reading the clinician’s reply.':'आपने स्पष्टीकरण माँगा है। चिकित्सक का उत्तर पढ़कर निर्णय ले सकते हैं।',
  'No sharing request right now':'अभी साझा करने का कोई अनुरोध नहीं','You chose not to share':'आपने साझा न करने का निर्णय लिया','Sharing stopped':'रिकॉर्ड साझा करना बंद है','Sharing has ended':'साझा करने की अवधि समाप्त',
  'There is no active sharing permission for this visit. If your clinician requests access, you can Allow, Deny or Ask why here.':'इस मुलाक़ात के लिए अभी साझा करने की अनुमति नहीं है। चिकित्सक अनुरोध करें तो यहाँ अनुमति दे सकते हैं, मना कर सकते हैं या कारण पूछ सकते हैं।',
  'No visit is linked to this account yet. Ask hospital staff for help.':'इस खाते से अभी कोई मुलाक़ात जुड़ी नहीं है। अस्पताल के कर्मचारी से सहायता लें।',
  'Visit summary':'मुलाक़ात का सारांश','Visit note':'मुलाक़ात का नोट','Next step':'अगला कदम','Your reviewed summary will appear here.':'आपका समीक्षित सारांश यहाँ दिखाई देगा।',
  'After your clinician reviews and saves this visit, you can view your summary here.':'चिकित्सक इस मुलाक़ात की समीक्षा करके सहेज दें, तब आप यहाँ सारांश देख सकते हैं।',
  'View reviewed summary':'समीक्षित सारांश देखें','Check for reviewed summary':'समीक्षित सारांश जाँचें','Refresh summary':'सारांश फिर जाँचें','Print summary':'सारांश प्रिंट करें','Source and limits':'स्रोत और सीमाएँ','Your summary stays available when sharing ends.':'साझा करना समाप्त होने पर भी आपका सारांश उपलब्ध रहता है।',
  'Your record and access history':'आपका रिकॉर्ड और पहुँच का इतिहास','View access history':'पहुँच का इतिहास देखें','Check record integrity':'रिकॉर्ड की कड़ियाँ जाँचें','Download access history':'पहुँच का इतिहास डाउनलोड करें','Download visit record (JSON)':'मुलाक़ात का रिकॉर्ड डाउनलोड करें (JSON)','Show more history':'और इतिहास देखें',
  'See recorded access and choices for your own fictional patient record.':'अपने काल्पनिक मरीज़ रिकॉर्ड की दर्ज पहुँच और निर्णय देखें।','The visit-record download uses a limited local FHIR mapping. Official validation has not been run.':'डाउनलोड में सीमित स्थानीय FHIR मैपिंग है। आधिकारिक सत्यापन नहीं हुआ है।',
  'Record links verified':'रिकॉर्ड की कड़ियाँ सत्यापित','Record verification failed':'रिकॉर्ड सत्यापन असफल','History unavailable':'इतिहास उपलब्ध नहीं','Record unavailable':'रिकॉर्ड उपलब्ध नहीं','No recorded access in this snapshot.':'इस स्नैपशॉट में कोई दर्ज पहुँच नहीं।',
  'Choice not yet confirmed':'निर्णय की पुष्टि अभी नहीं हुई','Check my choice':'मेरा निर्णय जाँचें','Saving your choice…':'आपका निर्णय सहेजा जा रहा है…','Choice recorded':'निर्णय दर्ज हुआ','Your choice was saved. Checking the current sharing status…':'आपका निर्णय सहेजा गया। साझा करने की वर्तमान स्थिति जाँची जा रही है…','Choice not saved':'निर्णय नहीं सहेजा गया',
  'Connection interrupted':'कनेक्शन बाधित','Visit unavailable':'मुलाक़ात उपलब्ध नहीं','Loading…':'लोड हो रहा है…','Please wait a moment':'कृपया थोड़ी देर रुकें','Waiting for the server.':'सर्वर की प्रतीक्षा है।','Waiting for confirmation from the server.':'सर्वर की पुष्टि की प्रतीक्षा है।',
  'Your clinician has not saved a final reviewed summary for this visit yet.':'चिकित्सक ने इस मुलाक़ात का अंतिम समीक्षित सारांश अभी नहीं सहेजा है।',
  'Today’s notes':'आज के नोट','Summary':'सारांश','Ask record':'रिकॉर्ड से पूछें','New note':'नया नोट','Simulated scribe':'सिमुलेटेड स्क्राइब','More tools':'अन्य साधन','Add clinical statement':'चिकित्सा कथन जोड़ें','Optional check':'वैकल्पिक जाँच','Original source':'मूल स्रोत','Load current draft':'वर्तमान मसौदा लोड करें','Emergency access':'आपातकालीन पहुँच','New note language':'नए नोट की भाषा',
  'Visit note and assessment':'मुलाक़ात का नोट और आकलन','Assessment':'आकलन','New prescription':'नया प्रिस्क्रिप्शन','No new medicine added':'कोई नई दवा नहीं जोड़ी गई','Add medicine':'दवा जोड़ें','Save draft':'मसौदा सहेजें','Review visit':'मुलाक़ात की समीक्षा','Confirm review':'समीक्षा की पुष्टि','Save reviewed record':'समीक्षित रिकॉर्ड सहेजें','Review before saving':'सहेजने से पहले समीक्षा करें',
  'Not saved to hospital server':'अस्पताल के सर्वर पर नहीं सहेजा गया','Not added to the clinical record':'चिकित्सा रिकॉर्ड में नहीं जोड़ा गया','Draft saved to hospital server':'मसौदा अस्पताल के सर्वर पर सहेजा गया','Unsaved changes':'बिना सहेजे बदलाव','Reviewed record saved':'समीक्षित रिकॉर्ड सहेजा गया','Clinical statement':'चिकित्सा कथन','Statement type':'कथन का प्रकार','Record action':'रिकॉर्ड में कार्रवाई','Source and dates':'स्रोत और तिथियाँ','Source':'स्रोत','Keep in draft':'मसौदे में रखें',
  'New statement':'नया कथन','Update a recorded statement':'दर्ज कथन अपडेट करें','Correct a recorded statement':'दर्ज कथन सुधारें','Retract a recorded statement':'दर्ज कथन वापस लें','Recorded statement':'दर्ज कथन','Reason for change':'बदलाव का कारण','Reason':'कारण','Clinician assessment':'चिकित्सक का आकलन','Patient report':'मरीज़ द्वारा बताया गया','Document reference':'दस्तावेज़ का संदर्भ','Document/reference ID (when applicable)':'दस्तावेज़/संदर्भ आईडी (यदि लागू हो)','Original source author (if recorded)':'मूल स्रोत का लेखक (यदि दर्ज हो)','Source date (if recorded)':'स्रोत की तिथि (यदि दर्ज हो)','Occurrence date (if known)':'घटना की तिथि (यदि ज्ञात हो)','Occurrence description (if date is unknown)':'घटना का विवरण (तिथि अज्ञात हो तो)','Supporting quote (optional)':'सहायक उद्धरण (वैकल्पिक)',
  'Print reviewed summary':'समीक्षित सारांश प्रिंट करें','Download reviewed record':'समीक्षित रिकॉर्ड डाउनलोड करें','Apply to note':'नोट में लागू करें','Refresh':'फिर जाँचें','Check outcome':'परिणाम जाँचें','Try again':'फिर प्रयास करें','Close':'बंद करें','English':'अंग्रेज़ी','Hindi':'हिन्दी','I confirmed the patient’s choice':'मैंने मरीज़ के निर्णय की पुष्टि की है',
  'Use optional text interpretation (six topics only)':'वैकल्पिक पाठ व्याख्या उपयोग करें (केवल छह विषय)','Consultation brief proposal':'परामर्श सार का प्रस्ताव','Use proposal as visit note':'प्रस्ताव को मुलाक़ात के नोट में उपयोग करें',
};
const originalUI=new WeakMap();
const originalAttributes=new WeakMap(),translatedAttributes=['aria-label','placeholder','title'];
const clinicalRegions='[translate="no"],script,style,textarea,#allergies,#answer,#history-groups,#medication-items,#other-items,#review-content,#source-content,#summary-content,#print-content,#encounter-print,#token-print,.patient-name,#patient-name,#assisted-patient';
function uiTranslation(text) {
  if(languageCode==='en') return text;
  if(hindiUI[text]) return hindiUI[text];
  if(text.includes(' · ')) return text.split(' · ').map(part=>hindiUI[part] || part).join(' · ');
  const patterns=[[/^Sharing with (.+)$/u,'इनके साथ साझा: $1'],[/^Reviewed by (.+)$/u,'समीक्षा: $1'],[/^Calls made: (\d+) of (\d+)$/u,'कॉल: $2 में से $1'],[/^Absent patients \((\d+)\)$/u,'अनुपस्थित मरीज़ ($1)'],[/^More actions for token (.+)$/u,'टोकन $1 के लिए अन्य कार्रवाइयाँ'],[/^Close (.+)$/u,'बंद करें: $1'],[/^Ends at (.+)$/u,'समाप्ति: $1'],[/^Visit (.+)$/u,'मुलाक़ात $1']];
  for(const [pattern,replacement] of patterns) if(pattern.test(text)) return text.replace(pattern,replacement);
  return text;
}
function translateTree(root) {
  const attributes=element=>{
    if(element.closest(clinicalRegions)) return;
    let originals=originalAttributes.get(element);
    if(!originals) {originals={};originalAttributes.set(element,originals);}
    for(const name of translatedAttributes) {
      if(!element.hasAttribute(name)) {delete originals[name];continue;}
      const text=element.getAttribute(name),prior=originals[name],original=prior && text===prior.translated?prior.original:text;
      const translated=uiTranslation(original);originals[name]={original,translated};
      if(text!==translated) element.setAttribute(name,translated);
    }
  };
  const visit=textNode=>{
    if(textNode.parentElement?.closest(clinicalRegions)) return;
    const text=textNode.nodeValue,prior=originalUI.get(textNode),original=prior && text===prior.translated?prior.original:text;
    const trimmed=original.trim(),translated=original.replace(trimmed,uiTranslation(trimmed));
    originalUI.set(textNode,{original,translated});if(text!==translated) textNode.nodeValue=translated;
  };
  if(root.nodeType===Node.TEXT_NODE) visit(root);
  else if(root.nodeType===Node.ELEMENT_NODE || root.nodeType===Node.DOCUMENT_FRAGMENT_NODE) {
    if(root.nodeType===Node.ELEMENT_NODE && root.closest(clinicalRegions)) return;
    if(root.nodeType===Node.ELEMENT_NODE) attributes(root);
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {if(walker.currentNode.nodeType===Node.TEXT_NODE) visit(walker.currentNode);else attributes(walker.currentNode);}
  }
}
function initializeLanguage() {
  if(!languageObserver) {
    languageObserver=new MutationObserver(records=>{for(const record of records) {if(record.type==='characterData' || record.type==='attributes') translateTree(record.target);else for(const child of record.addedNodes) translateTree(child);}});
    languageObserver.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:translatedAttributes});
  }
  document.documentElement.lang=languageCode;translateTree(document.body);
}
export function setInterfaceLanguage(code) {
  if(!['en','hi'].includes(code)) return;languageCode=code;try{sessionStorage.setItem('vaultmed-interface-language',code);}catch{}
  initializeLanguage();
}
