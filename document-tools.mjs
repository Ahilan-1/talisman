import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const xlsxPython = `import sys, zipfile, xml.etree.ElementTree as E
p=sys.argv[1]
n={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(p) as z:
  strings=[]
  if 'xl/sharedStrings.xml' in z.namelist():
    root=E.fromstring(z.read('xl/sharedStrings.xml'))
    strings=[''.join(x.itertext()) for x in root.findall('m:si',n)]
  sheets=[x for x in z.namelist() if x.startswith('xl/worksheets/sheet') and x.endswith('.xml')][:5]
  for name in sheets:
    print('SHEET',name)
    root=E.fromstring(z.read(name))
    for row in root.findall('.//m:sheetData/m:row',n)[:100]:
      values=[]
      for cell in row.findall('m:c',n)[:30]:
        value=cell.find('m:v',n)
        inline=cell.find('m:is',n)
        text=value.text if value is not None else ''.join(inline.itertext()) if inline is not None else ''
        if cell.attrib.get('t')=='s' and text:
          try:text=strings[int(text)]
          except (ValueError,IndexError):pass
        values.append((text or '').replace('\\t',' ').replace('\\n',' '))
      print('\\t'.join(values))
`;

export function extractDocument(filename, bytes) {
  const name=path.basename(String(filename||'document')).slice(0,120);
  const ext=path.extname(name).toLowerCase();
  if(!['.pdf','.xlsx','.csv','.tsv','.txt','.md'].includes(ext)) throw Error('Supported files: PDF, XLSX, CSV, TSV, TXT, and Markdown.');
  if(bytes.length>10*1024*1024) throw Error('File exceeds the 10 MB limit.');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'talisman-document-'));
  const source=path.join(directory,`source${ext}`);
  try{
    fs.writeFileSync(source,bytes,{mode:0o600});
    let text;
    if(ext==='.pdf') text=execFileSync('pdftotext',['-layout',source,'-'],{timeout:30_000,maxBuffer:2*1024*1024}).toString('utf8');
    else if(ext==='.xlsx') text=execFileSync('python3',['-c',xlsxPython,source],{timeout:30_000,maxBuffer:2*1024*1024}).toString('utf8');
    else text=bytes.toString('utf8');
    text=text.replace(/\u0000/g,'').trim().slice(0,100_000);
    if(!text) throw Error('No readable text was found in this file.');
    return {name,text};
  }finally{fs.rmSync(directory,{recursive:true,force:true})}
}
