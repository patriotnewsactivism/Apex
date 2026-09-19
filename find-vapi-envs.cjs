const fs = require('fs');
const path = require('path');
const roots = ['C:/Apex', 'C:/Users/Matthew Reardon/Desktop', 'C:/Users/Matthew Reardon/Documents'];
const skip = new Set(['node_modules','.git','.next','dist','build','.cache','AppData']);
const wanted = ['VAPI_API_KEY','VAPI_PRIVATE_KEY','VAPI_PUBLIC_KEY','VAPI_TOKEN'];
function walk(dir) {
  let entries; try { entries = fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
  for (const ent of entries) {
    if (ent.isDirectory() && skip.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(p); continue; }
    if (!/^\.env($|\.)/i.test(ent.name)) continue;
    let s; try { s = fs.readFileSync(p,'utf8'); } catch { continue; }
    const names = wanted.filter(k => new RegExp(`^${k}=`, 'm').test(s));
    if (names.length) console.log(`${p}\t${names.join(',')}`);
  }
}
for (const root of roots) walk(root);
