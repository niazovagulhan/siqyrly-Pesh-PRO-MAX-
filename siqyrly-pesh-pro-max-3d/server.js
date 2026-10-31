'use strict';
// СИҚЫРЛЫ ПЕШ PRO MAX 3D — zero-dependency Node.js classroom server
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'game.json');
fs.mkdirSync(DATA_DIR, {recursive:true});
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(?:"(.*)"|'(.*)')$/,(_,a,b)=>a||b||'');
}
const PORT = Number(process.env.PORT||3000);
const PUBLIC_URL = (process.env.PUBLIC_URL||'').replace(/\/$/,'');
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD||'';
const teacherSessions = new Map();
const loginTries = new Map();
const streams = new Set();
const uid = () => crypto.randomBytes(16).toString('hex');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const gcd = (a,b) => {a=Math.abs(a);b=Math.abs(b);while(b){[a,b]=[b,a%b]}return a||1};
const lcd = (a,b) => a/gcd(a,b)*b;
const simplify = (n,d) => {if(d<0){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g}};
const fraction = q => simplify(q.op==='+' ? q.a*q.d+q.c*q.b : q.a*q.d-q.c*q.b, q.b*q.d);
const fmt = f => f.d===1?String(f.n):`${f.n}/${f.d}`;
const baseQuestions = [
  [1,1,2,'+',1,3],[1,1,2,'-',1,4],[1,1,3,'+',1,4],[1,2,3,'-',1,6],[1,1,4,'+',1,6],
  [1,1,2,'+',1,6],[1,3,4,'-',1,3],[1,1,3,'+',1,6],[1,5,6,'-',1,4],[1,1,2,'+',1,4],
  [2,3,4,'+',2,5],[2,5,6,'-',3,8],[2,1,8,'+',3,10],[2,7,10,'-',1,6],[2,5,12,'+',3,8],
  [2,7,8,'-',1,5],[2,2,3,'+',3,10],[2,11,12,'-',1,8],[2,3,5,'+',1,12],[2,9,10,'-',1,4],
  [3,7,4,'+',5,6],[3,11,6,'-',3,8],[3,9,5,'+',7,12],[3,13,8,'-',2,5],[3,7,6,'+',11,10],
  [3,17,12,'-',5,8],[3,9,4,'+',7,10],[3,19,10,'-',7,12],[3,13,6,'+',5,8],[3,23,12,'-',4,5]
].map((t,i)=>({id:'q'+(i+1),level:t[0],a:t[1],b:t[2],op:t[3],c:t[4],d:t[5],type:['choice','fraction','drag','match','error'][i%5]}));
const initial = () => ({version:2,room:Math.random().toString(36).slice(2,8).toUpperCase(),settings:{enabledLevels:[1,2,3],timeLimitMin:0,ovenImage:'',contactPhone:'87076525807'},questions:baseQuestions,players:[],updatedAt:Date.now()});
let db;
try { db = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
catch { db = initial(); persist(); }
// Older saved games might not yet have the contact field.
if (!db.settings) db.settings = initial().settings;
if (!db.settings.contactPhone) db.settings.contactPhone = '87076525807';
function persist(){
  db.updatedAt=Date.now();
  const f=DATA_FILE+'.tmp';fs.writeFileSync(f,JSON.stringify(db,null,2));fs.renameSync(f,DATA_FILE);
}
function publicPlayer(p){return {id:p.id,name:p.name,className:p.className,level:p.level,score:p.score,correct:p.solved.length,wrong:p.wrong,mistakes:p.mistakes,started:p.started,solved:p.solved,duration:Math.floor((Date.now()-p.started)/1000)};}
function ranking(){return db.players.map(publicPlayer).sort((a,b)=>b.score-a.score||a.duration-b.duration).slice(0,100)}
function broadcastSettings(){const msg=`event: settings\ndata: ${JSON.stringify({settings:db.settings})}\n\n`;for(const res of streams){try{res.write(msg)}catch{streams.delete(res)}}}
function broadcast(){const msg=`event: leaderboard\ndata: ${JSON.stringify({ranking:ranking(),total:db.players.length,updatedAt:Date.now()})}\n\n`;for(const res of streams){try{res.write(msg)}catch{streams.delete(res)}}}
function send(res,status,data,headers={}) {let body=typeof data==='string'?data:JSON.stringify(data);res.writeHead(status,{'Content-Type':typeof data==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(body)}
function error(res,status,message){send(res,status,{error:message})}
async function bodyOf(req){let total=0;let parts=[];for await(const chunk of req){total+=chunk.length;if(total>100_000)throw Error('Сұрау тым үлкен');parts.push(chunk)}return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}')}
function teacher(req){const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const exp=teacherSessions.get(hash(token));return token&&exp&&exp>Date.now()}
function student(req){const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');return token&&db.players.find(p=>p.tokenHash===hash(token))}
function validQ(q){return q&&[1,2,3].includes(Number(q.level))&&[q.a,q.b,q.c,q.d].every(v=>Number.isSafeInteger(Number(v))&&Number(v)>0&&Number(v)<=500)&&['+','-'].includes(q.op)&&!(q.op==='-'&&q.a*q.d<q.c*q.b)}
function cleanQ(q,old={}){return {id:old.id||('q'+uid().slice(0,8)),level:Number(q.level),a:Number(q.a),b:Number(q.b),op:q.op,c:Number(q.c),d:Number(q.d),type:['choice','fraction','drag','match','error'].includes(q.type)?q.type:'fraction'}}
function optionsFor(q){const f=fraction(q), candidates=[f,simplify(f.n+1,f.d),simplify(Math.max(0,f.n-1),f.d),simplify(q.a+q.c,q.b+q.d),simplify(f.n,f.d+1),simplify(f.n+2,f.d)];const seen=new Set();return candidates.filter(x=>{const k=fmt(x);if(seen.has(k))return false;seen.add(k);return true}).slice(0,4).sort((x,y)=>hash(q.id+fmt(x)).localeCompare(hash(q.id+fmt(y)))).map(fmt)}
function matchItems(q){const arr=[q];const used=new Set([fmt(fraction(q))]);for (const other of db.questions) {if(other.id===q.id)continue;const ans=fmt(fraction(other));if(!used.has(ans)){arr.push(other);used.add(ans)}if(arr.length===3)break}return arr.map(x=>({id:x.id,a:x.a,b:x.b,op:x.op,c:x.c,d:x.d}))}
function clientQ(q){return {...q,options:q.type==='choice'?optionsFor(q):undefined,matches:q.type==='match'?matchItems(q):undefined,wrongLine:q.type==='error'?`${q.a+q.c}/${q.b+q.d}`:undefined}}
function timeLeft(p){const limit=db.settings.timeLimitMin;if(!limit)return Infinity;return limit*60_000-(Date.now()-p.started)}
function matchesResult(q,input){const n=Number(input?.n),d=Number(input?.d);if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||d<=0||d>5000||Math.abs(n)>50000)return false;const a=simplify(n,d),b=fraction(q);return a.n===b.n&&a.d===b.d}
function validateSubmission(q, data) {
 if(!matchesResult(q,data.result))return false;
 if(q.type==='match'){
   const expected=matchItems(q);const m=data.matches||{};
   return expected.every(x=>m[x.id]===fmt(fraction(x)));
 }
 return true;
}
// Excel XLSX generator using ZIP/STORED with XML (no external packages)
const escapeXml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const colName = n => {let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s};
function csvLikeSheet(rows){let xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="17"/><sheetData>';rows.forEach((r,i)=>{xml+=`<row r="${i+1}">`;r.forEach((v,j)=>{const ref=colName(j+1)+(i+1);xml+=typeof v==='number'?`<c r="${ref}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t>${escapeXml(v)}</t></is></c>`});xml+='</row>'});return xml+'</sheetData></worksheet>'}
const crcTable=(()=>{const a=[];for(let n=0;n<256;n++){let c=n;for(let j=0;j<8;j++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;a.push(c>>>0)}return a})();
function crc32(buf){let c=0xFFFFFFFF;for(const b of buf)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function zip(entries){let local=[],cent=[],offset=0;for(const [name,data] of Object.entries(entries)){const n=Buffer.from(name),b=Buffer.from(data);const crc=crc32(b);const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);head.writeUInt32LE(crc,14);head.writeUInt32LE(b.length,18);head.writeUInt32LE(b.length,22);head.writeUInt16LE(n.length,26);local.push(head,n,b);const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50,0);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt32LE(crc,16);cd.writeUInt32LE(b.length,20);cd.writeUInt32LE(b.length,24);cd.writeUInt16LE(n.length,28);cd.writeUInt32LE(offset,42);cent.push(cd,n);offset+=head.length+n.length+b.length}const cdLength=cent.reduce((s,b)=>s+b.length,0);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(cdLength,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,...cent,end])}
function excelFile(){const sorted=ranking(), rows=[['Оқушы','Сынып','Деңгей','Ұпай','Дұрыс','Қате әрекет','Бастаған уақыты','Секунд','Қатемен жұмыс (есеп IDs)'],...sorted.map(p=>{const original=db.players.find(x=>x.id===p.id);return [p.name,p.className,p.level,p.score,p.correct,p.wrong,new Date(p.started).toLocaleString('kk-KZ'),p.duration,(original.mistakes||[]).join(', ')]})];return zip({'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>','xl/workbook.xml':'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Нәтижелер" sheetId="1" r:id="rId1"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>','xl/worksheets/sheet1.xml':csvLikeSheet(rows)})}
function safeUrl(req){if(PUBLIC_URL)return PUBLIC_URL;const proto=(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();const host=(req.headers.host||`localhost:${PORT}`).replace(/[^\w.:[\]-]/g,'');return `${proto}://${host}`}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.jpg':'image/jpeg'};
async function handler(req,res){
 try {
  const url=new URL(req.url, `http://${req.headers.host||'localhost'}`), p=url.pathname;
  if(req.method==='GET'&&p==='/api/meta')return send(res,200,{room:db.room,settings:db.settings,publicUrl:safeUrl(req),teacherReady:TEACHER_PASSWORD.length>=10,questions:db.questions.length});
  if(req.method==='GET'&&p==='/api/questions'){const level=Number(url.searchParams.get('level')||1);if(!db.settings.enabledLevels.includes(level))return error(res,403,'Бұл деңгей жабық');return send(res,200,db.questions.filter(q=>q.level===level).map(clientQ))}
  if(req.method==='GET'&&p==='/api/leaderboard')return send(res,200,{ranking:ranking(),total:db.players.length});
  if(req.method==='GET'&&p==='/api/events'){
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','Access-Control-Allow-Origin':'*'});res.write(`event: leaderboard\ndata: ${JSON.stringify({ranking:ranking(),total:db.players.length})}\n\n`);streams.add(res);req.on('close',()=>streams.delete(res));return;
  }
  if(req.method==='POST'&&p==='/api/join'){
   const x=await bodyOf(req);const name=String(x.name||'').trim().slice(0,50),className=String(x.className||'').trim().slice(0,20),level=Number(x.level);
   if(name.length<2||className.length<1||!db.settings.enabledLevels.includes(level)||String(x.room||'').toUpperCase()!==db.room)return error(res,400,'Аты-жөні, сыныбы немесе бөлме коды дұрыс емес');
   const token=uid()+uid(),player={id:uid(),tokenHash:hash(token),name,className,level,score:0,started:Date.now(),solved:[],wrong:0,mistakes:[]};db.players.push(player);persist();broadcast();return send(res,200,{token,player:publicPlayer(player)});
  }
  if(req.method==='GET'&&p==='/api/me'){const me=student(req);return me?send(res,200,{player:publicPlayer(me),timeLeftMs:timeLeft(me)}):error(res,401,'Сессия жоқ')}
  if(req.method==='POST'&&p==='/api/mistake'){
   const me=student(req);if(!me)return error(res,401,'Қайта кіріңіз');
   const x=await bodyOf(req);const q=db.questions.find(t=>t.id===x.id&&t.level===me.level);
   if(!q)return error(res,404,'Есеп табылмады');
   me.wrong++;if(!me.mistakes.includes(q.id))me.mistakes.push(q.id);
   persist();broadcast();return send(res,200,{ok:true});
  }
  if(req.method==='POST'&&p==='/api/answer'){
   const me=student(req);if(!me)return error(res,401,'Қайта кіріңіз');if(timeLeft(me)<=0)return error(res,403,'Уақыт аяқталды');
   const x=await bodyOf(req);const q=db.questions.find(t=>t.id===x.id&&t.level===me.level);if(!q)return error(res,404,'Есеп табылмады');
   if(me.solved.includes(q.id))return send(res,200,{correct:true,already:true,score:me.score,explanation:explain(q)});
   const good=validateSubmission(q,x),points={1:10,2:15,3:20}[me.level];
   if(good){me.solved.push(q.id);me.score+=points;}else{me.wrong++;if(!me.mistakes.includes(q.id))me.mistakes.push(q.id)}
   persist();broadcast();return send(res,200,{correct:good,score:me.score,earned:good?points:0,hint:good?'':`ЕҮОБ арқылы ортақ бөлімді тап: ${q.b} және ${q.d}.`,explanation:good?explain(q):undefined});
  }
  if(req.method==='POST'&&p==='/api/teacher/login'){
   const ip=req.socket.remoteAddress||'?';let obj=loginTries.get(ip)||{n:0,t:0};if(obj.n>=8&&Date.now()-obj.t<15*60_000)return error(res,429,'Кейінірек әрекет жасаңыз');
   const x=await bodyOf(req),pass=String(x.password||'');
   if(TEACHER_PASSWORD.length<10)return error(res,503,'Алдымен .env ішінде TEACHER_PASSWORD (кемінде 10 таңба) орнатыңыз');
   const a=crypto.scryptSync(pass,'siqyrly-pech-v2',32),b=crypto.scryptSync(TEACHER_PASSWORD,'siqyrly-pech-v2',32);
   if(!crypto.timingSafeEqual(a,b)){loginTries.set(ip,{n:obj.n+1,t:Date.now()});return error(res,401,'Құпиясөз қате')}
   loginTries.delete(ip);const token=uid()+uid();teacherSessions.set(hash(token),Date.now()+8*3600_000);return send(res,200,{token});
  }
  if(p.startsWith('/api/teacher/')){
    if(!teacher(req))return error(res,401,'Мұғалімге кіру қажет');
    if(req.method==='GET'&&p==='/api/teacher/dashboard')return send(res,200,{room:db.room,settings:db.settings,questions:db.questions,ranking:ranking(),total:db.players.length,publicUrl:safeUrl(req)});
    if(req.method==='GET'&&p==='/api/teacher/export'){
      const f=excelFile();res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="siqyrly_pesh_natizhe.xlsx"','Content-Length':f.length});return res.end(f)
    }
    if(req.method==='PATCH'&&p==='/api/teacher/settings'){
      const x=await bodyOf(req);
      if(x.enabledLevels!==undefined){const levels=(Array.isArray(x.enabledLevels)?x.enabledLevels:[]).map(Number).filter(n=>[1,2,3].includes(n));if(!levels.length)return error(res,400,'Кемінде бір деңгейді ашыңыз');db.settings.enabledLevels=[...new Set(levels)]}
      if(x.timeLimitMin!==undefined){const n=Number(x.timeLimitMin);if(!Number.isInteger(n)||n<0||n>240)return error(res,400,'Уақыт 0–240 минут болуы керек');db.settings.timeLimitMin=n}
      if(x.contactPhone!==undefined){const phone=String(x.contactPhone).trim().replace(/[ \t().-]/g,'');if(!/^\+?[0-9]{10,15}$/.test(phone))return error(res,400,'Телефон нөмірі 10–15 цифрдан тұруы керек');db.settings.contactPhone=phone}
      if(x.ovenImage!==undefined){const image=String(x.ovenImage);if(image&&(!/^https:\/\//.test(image)||image.length>400))return error(res,400,'Сурет HTTPS мекенжайы болуы керек');db.settings.ovenImage=image}
      persist();broadcastSettings();broadcast();return send(res,200,{ok:true,settings:db.settings});
    }
    if(req.method==='POST'&&p==='/api/teacher/questions'){
      const x=await bodyOf(req);if(!validQ(x))return error(res,400,'Бөлшек дұрыс емес немесе азайту нәтижесі теріс');const q=cleanQ(x);db.questions.push(q);persist();return send(res,200,{ok:true,question:q});
    }
    const m=p.match(/^\/api\/teacher\/questions\/([a-zA-Z0-9]+)$/);
    if(m&&req.method==='PATCH'){const x=await bodyOf(req);const i=db.questions.findIndex(q=>q.id===m[1]);if(i<0)return error(res,404,'Табылмады');if(!validQ(x))return error(res,400,'Есеп дұрыс емес');db.questions[i]=cleanQ(x,db.questions[i]);persist();return send(res,200,{ok:true})}
    if(m&&req.method==='DELETE'){const len=db.questions.length;db.questions=db.questions.filter(q=>q.id!==m[1]);if(db.questions.length===len)return error(res,404,'Табылмады');persist();return send(res,200,{ok:true})}
    if(req.method==='POST'&&p==='/api/teacher/reset'){
      const x=await bodyOf(req);if(x.confirm!=='RESET')return error(res,400,'Растау қажет');db.players=[];db.room=Math.random().toString(36).slice(2,8).toUpperCase();persist();broadcast();return send(res,200,{ok:true,room:db.room})
    }
  }
  if(req.method==='GET'&&(p==='/'||p==='/index.html'||p==='/styles.css'||p==='/app.js'||p==='/pizza-magic.jpg')){
   const file=path.join(ROOT,'public',p==='/'?'index.html':p.substring(1));const buf=fs.readFileSync(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':p.includes('.js')?'no-cache':'public, max-age=120'});return res.end(buf)
  }
  error(res,404,'Мекенжай табылмады');
 }catch(e){console.error('SERVER ERROR',e);error(res,500,e.message==='Сұрау тым үлкен'?e.message:'Сервер қатесі')}
}
function explain(q){const l=lcd(q.b,q.d),x=q.a*l/q.b,y=q.c*l/q.d,f=fraction(q);return `${q.a}/${q.b} ${q.op} ${q.c}/${q.d} = ${x}/${l} ${q.op} ${y}/${l} = ${q.op==='+'?x+y:x-y}/${l} = ${fmt(f)}`}
const server=http.createServer(handler);
const heartbeat=setInterval(()=>{for(const res of streams){try{res.write(': ping\n\n')}catch{streams.delete(res)}}},20000);
server.listen(PORT,'0.0.0.0',()=>console.log(`\n🍕 СИҚЫРЛЫ ПЕШ PRO MAX 3D: http://localhost:${PORT}\n🔑 Мұғалім панелі: ${TEACHER_PASSWORD.length>=10?'дайын':'.env TEACHER_PASSWORD орнатыңыз'}\n📱 Бөлме коды: ${db.room}\n`));
process.on('SIGTERM',()=>{clearInterval(heartbeat);server.close(()=>process.exit(0))});
