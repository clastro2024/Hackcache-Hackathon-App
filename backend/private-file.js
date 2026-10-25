import path from 'node:path';
import {constants,lstatSync,statSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';

const renderNames=['vellum-passwords.json','vaultmed-passwords.json','sarvam-free-access.json'];
class PrivateFileError extends Error {
  constructor(reason){super('Private input unavailable');this.code=`PRIVATE_FILE_${reason}`;}
}

// Render owns these fixed mount entries. Local inputs retain no-follow semantics.
// The directory option is a constructor-only seam for Linux filesystem tests.
export function readPrivateFile(filename,limit,{renderSecretDirectory='/etc/secrets'}={}) {
  let fd,bytes;
  const projected=renderNames.some(name=>path.resolve(filename)===path.resolve(renderSecretDirectory,name));
  try {
    const entry=lstatSync(filename);
    if(entry.isSymbolicLink()&&!projected)throw new PrivateFileError('NOT_REGULAR');
    const expected=projected?statSync(filename):entry;
    if(!expected.isFile())throw new PrivateFileError('NOT_REGULAR');
    if(expected.size>limit)throw new PrivateFileError('TOO_LARGE');
    fd=openSync(filename,constants.O_RDONLY|(projected?0:(constants.O_NOFOLLOW??0))|(constants.O_NONBLOCK??0));
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.dev!==expected.dev||opened.ino!==expected.ino)throw new PrivateFileError('CHANGED');
    bytes=Buffer.alloc(limit+1);let length=0;
    while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,length);if(!count)break;length+=count;}
    if(length>limit)throw new PrivateFileError('TOO_LARGE');
    return bytes.subarray(0,length);
  }catch(error){
    bytes?.fill(0);
    if(error instanceof PrivateFileError)throw error;
    throw new PrivateFileError(error.code==='ENOENT'?'MISSING':'UNREADABLE');
  }finally{if(fd!==undefined)closeSync(fd);}
}
