// Page-specific clinical rendering remains unimplemented.
export function setText(element,value) {element.textContent=String(value ?? '');}
export function clearOnContextChange(client,clear) {return client.onContextClear(()=>clear());}
