const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const roots = ['api','lib','tests'];
const files = [];
function walk(dir){
  if(!fs.existsSync(dir)) return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(p);
    else if(p.endsWith('.js')) files.push(p);
  }
}
roots.forEach(walk);
for(const file of files) execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
const forbidden = [/AIza[0-9A-Za-z_-]{20,}/, /sk-[0-9A-Za-z]{20,}/, /service_role\s*[:=]\s*['"][^'"]+/i];
const secretFiles = ['.env', '.env.local', '.env.production'];
for (const file of secretFiles) {
  if (fs.existsSync(file)) throw new Error(`check: forbidden secret file present: ${file}`);
}
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (forbidden.some(pattern => pattern.test(text))) throw new Error(`check: possible secret found in ${file}`);
}
console.log(`check: ${files.length} JavaScript files passed syntax validation`);
