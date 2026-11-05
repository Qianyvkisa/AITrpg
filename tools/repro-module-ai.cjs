const fs=require('fs'), path=require('path');
const M = require('../electron/materials');
const A = require('../electron/moduleAI');
const cfg = JSON.parse(fs.readFileSync('C:/Users/junyu/AppData/Roaming/coc-keeper/data/config.json','utf8'));

(async()=>{
  const r = await M.readFolder(path.join(__dirname,'..','tests','fixtures','百川前-海面之梦'));
  const txt = M.materialsToPromptText(r);
  console.log('prompt 长度=', txt.length);
  const t0 = Date.now();
  const res = await A.understandMaterials(
    { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    { folderName: '百川前-海面之梦', materialsText: txt, images: [] }
  );
  console.log('耗时=', ((Date.now()-t0)/1000).toFixed(1)+'s');
  console.log('ok=', res.ok, 'error=', res.error);
  if (res.raw) {
    console.log('返回长度=', res.raw.length);
    console.log('--- 返回前 300 字 ---');
    console.log(res.raw.slice(0,300));
    console.log('--- 返回后 300 字 ---');
    console.log(res.raw.slice(-300));
  }
})();

