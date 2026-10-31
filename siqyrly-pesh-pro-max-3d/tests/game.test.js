'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const PORT_AVAILABLE=()=>new Promise(resolve=>{let s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('30 есеп, 55 оқушы, баға, мұғалім, Excel, редактор',async t=>{
 const port=await PORT_AVAILABLE(),data=fs.mkdtempSync(path.join(os.tmpdir(),'pizza-game-'));
 const child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),DATA_DIR:data,TEACHER_PASSWORD:'TeacherTestPassword2026'},stdio:'ignore'});
 t.after(()=>{child.kill();fs.rmSync(data,{recursive:true,force:true})});
 const url=`http://127.0.0.1:${port}`;
 async function req(p,method='GET',body=null,token=''){
  const r=await fetch(url+p,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json()};
 }
 let meta;for(let i=0;i<40;i++){try{meta=(await req('/api/meta')).data;break}catch{await pause(100)}}
 assert.equal(meta.questions,30);
 assert.equal(meta.teacherReady,true);
 assert.equal(meta.settings.contactPhone,'87076525807');
 const questions=[1,2,3].map(()=>null);for(let l=1;l<=3;l++){questions[l-1]=(await req('/api/questions?level='+l)).data;assert.equal(questions[l-1].length,10)}
 const users=await Promise.all(Array.from({length:55},(_,i)=>req('/api/join','POST',{name:`Оқушы ${i+1}`,className:'5А',room:meta.room,level:1})));
 assert.ok(users.every(x=>x.status===200));
 const tk=users[0].data.token;
 let bad=await req('/api/answer','POST',{id:'q1',result:{n:1,d:99}},tk);assert.equal(bad.data.correct,false);
 let good=await req('/api/answer','POST',{id:'q1',result:{n:5,d:6}},tk);assert.equal(good.data.score,10);
 let duplicate=await req('/api/answer','POST',{id:'q1',result:{n:5,d:6}},tk);assert.equal(duplicate.data.score,10);
 const rank=(await req('/api/leaderboard')).data;assert.equal(rank.total,55);assert.equal(rank.ranking[0].score,10);
 const wrongPass=await req('/api/teacher/login','POST',{password:'wrongpassword999'});assert.equal(wrongPass.status,401);
 const admin=(await req('/api/teacher/login','POST',{password:'TeacherTestPassword2026'})).data.token;
 assert.ok(admin);
 const settings=await req('/api/teacher/settings','PATCH',{enabledLevels:[1,2],timeLimitMin:35,contactPhone:'+77071234567'},admin);assert.equal(settings.status,200);
 assert.equal(settings.data.settings.contactPhone,'+77071234567');
 assert.equal((await req('/api/meta')).data.settings.contactPhone,'+77071234567');
 const badNumber=await req('/api/teacher/settings','PATCH',{contactPhone:'not a phone'},admin);assert.equal(badNumber.status,400);
 assert.equal((await req('/api/meta')).data.settings.contactPhone,'+77071234567');
 const added=await req('/api/teacher/questions','POST',{level:3,a:3,b:4,c:1,d:3,op:'+',type:'fraction'},admin);assert.equal(added.status,200);
 const qId=added.data.question.id;
 const edited=await req('/api/teacher/questions/'+qId,'PATCH',{level:3,a:4,b:5,c:1,d:2,op:'-',type:'error'},admin);assert.equal(edited.status,200);
 const deleted=await req('/api/teacher/questions/'+qId,'DELETE',null,admin);assert.equal(deleted.status,200);
 const response=await fetch(url+'/api/teacher/export',{headers:{authorization:'Bearer '+admin}});
 assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength>2000,true);
 const reset=await req('/api/teacher/reset','POST',{confirm:'RESET'},admin);assert.equal(reset.status,200);
 assert.equal((await req('/api/leaderboard')).data.total,0);
});
