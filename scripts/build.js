const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, '.build');
fs.rmSync(out,{recursive:true,force:true});
for(const dir of ['api','lib','public','supabase']){
  fs.cpSync(path.join(root,dir),path.join(out,dir),{recursive:true});
}
for(const file of ['package.json','vercel.json','.env.example','capacitor.config.json']){
  fs.copyFileSync(path.join(root,file),path.join(out,file));
}
console.log(`build: static/server artifact prepared at ${out}`);
