const fs=require('fs'), path=require('path');
const M = require('../electron/materials');
const A = require('../electron/moduleAI');
const { buildEndpoint } = require('../electron/defaults');
const cfg = JSON.parse(fs.readFileSync('C:/Users/junyu/AppData/Roaming/coc-keeper/data/config.json','utf8'));

(async()=>{
  const r = await M.readFolder(path.join(__dirname,'..','tests','fixtures','百川前-海面之梦'));
  const txt = M.materialsToPromptText(r);
  const { sys, user } = A.buildUnderstandPrompt({ folderName:'百川前-海面之梦', materialsText: txt, imageCount:0 });

  // 直接调用，看 finish_reason
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{role:'system',content:sys},{role:'user',content:user}],
    temperature: 0.3, max_tokens: 4096, stream: false
  });
  const res = await fetch(buildEndpoint(cfg.baseUrl), {
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey},
    body
  });
  const data = await res.json();
  const ch = data.choices[0];
  console.log('finish_reason=', ch.finish_reason);
  console.log('content长度=', ch.message.content.length);
  console.log('usage=', JSON.stringify(data.usage));
  console.log('是否以 } 结尾=', ch.message.content.trim().endsWith('}'));
})();

