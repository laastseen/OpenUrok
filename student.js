import {state, initSupabase, demoDb, getActivity, activities, RoleLabels, RoleClass, toast, escapeHtml, rolePrompt, config} from './core.js';

const $=s=>document.querySelector(s);
let refreshTimer=null;

async function boot(){
  await initSupabase();
  bindLanding();
  const saved=localStorage.getItem('ai-court-participant');
  if(saved){ try{ await restoreParticipant(JSON.parse(saved)); }catch(e){ console.warn(e); } }
}

function bindLanding(){
  $('#joinForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const code=$('#sessionCode').value.trim().toUpperCase();
    const nickname=$('#nickname').value.trim();
    const requestedGroup=$('#groupNo').value ? Number($('#groupNo').value) : null;
    if(!nickname) return toast('Введите имя или псевдоним');
    try{ await joinSession(code,nickname,requestedGroup); }
    catch(err){ console.error(err); toast(err.message || 'Не удалось подключиться'); }
  });
  $('#sessionCode').value=config().defaultSessionCode||'AI-01';
}

async function joinSession(code,nickname,requestedGroup){
  let participant, session;
  if(state.demo){
    const db=demoDb(); session=db.raw.session;
    if(code!==session.code) throw new Error('В демо-режиме код AI-01');
    const id='demo-'+Math.random().toString(36).slice(2,10);
    const groups=Array.from({length:session.group_count},(_,i)=>i+1);
    let group=requestedGroup && groups.includes(requestedGroup)?requestedGroup:null;
    if(!group){ group=groups.sort((a,b)=>db.raw.participants.filter(p=>p.group_no===a).length-db.raw.participants.filter(p=>p.group_no===b).length)[0]; }
    const count=db.raw.participants.filter(p=>p.group_no===group).length;
    if(count>=session.max_group_size) throw new Error('В выбранной группе уже нет мест');
    const roles=['prosecutor','defender','expert','secretary'];
    participant={id,user_id:id,session_id:session.id,nickname,group_no:group,role:roles[count],joined_at:new Date().toISOString()};
    db.raw.participants.push(participant); db.save();
  }else{
    const {data,error}=await state.client.rpc('join_session',{p_code:code,p_nickname:nickname,p_requested_group:requestedGroup});
    if(error) throw error; participant=data.participant; session=data.session;
  }
  state.participant=participant; state.session=session;
  localStorage.setItem('ai-court-participant',JSON.stringify({code,nickname,participantId:participant.id}));
  showWorkspace();
  startRefresh();
}

async function restoreParticipant(saved){
  if(state.demo){
    const db=demoDb(); const p=db.raw.participants.find(x=>x.id===saved.participantId);
    if(!p) return; state.participant=p; state.session=db.raw.session;
  } else {
    const {data,error}=await state.client.rpc('get_my_participant',{p_code:saved.code});
    if(error || !data?.participant) return; state.participant=data.participant; state.session=data.session;
  }
  showWorkspace(); startRefresh();
}

function showWorkspace(){
  $('#landing').classList.add('hidden'); $('#studentApp').classList.remove('hidden');
  $('#profileName').textContent=state.participant.nickname;
  $('#groupTag').textContent=`Группа ${state.participant.group_no}`;
  const rt=$('#roleTag'); rt.textContent=RoleLabels[state.participant.role]; rt.className=`tag ${RoleClass[state.participant.role]}`;
  $('#roleExplain').textContent=roleExplanation(state.participant.role);
  renderSteps();
}

function roleExplanation(role){
  return ({prosecutor:'Ищите риск и слабое место решения ИИ.',defender:'Ищите пользу и сильную сторону ИИ.',expert:'Оценивайте аргументы и последствия.',secretary:'Фиксируйте общий итог команды.'})[role];
}

function renderSteps(){
  $('#steps').innerHTML=activities().filter(a=>a.type!=='lobby').map(a=>`<div class="step" data-act="${a.id}"><b>${a.short}</b><br><span>слайд ${a.slide}</span></div>`).join('');
}

function startRefresh(){ clearInterval(refreshTimer); refresh(); refreshTimer=setInterval(refresh,1400); }

async function refresh(){
  try{
    if(state.demo){ state.session=demoDb().raw.session; }
    else { const {data,error}=await state.client.rpc('get_session_state',{p_code:state.session.code}); if(error) throw error; state.session=data; }
    renderActivity(getActivity(state.session.current_activity));
  }catch(e){ console.warn(e); }
}

async function myResponse(activityId){
  if(state.demo){ return demoDb().raw.responses.find(r=>r.participant_id===state.participant.id&&r.activity_id===activityId)||null; }
  const {data,error}=await state.client.rpc('get_my_response',{p_activity_id:activityId}); if(error) return null; return data;
}

async function groupData(activityId){
  if(state.demo){
    const db=demoDb();
    return {
      roleResponses:db.raw.responses.filter(r=>r.group_no===state.participant.group_no&&r.activity_id===activityId),
      groupResponse:db.raw.groupResponses.find(r=>r.group_no===state.participant.group_no&&r.activity_id===activityId)||null
    };
  }
  const {data,error}=await state.client.rpc('get_group_activity',{p_activity_id:activityId}); if(error) return {roleResponses:[],groupResponse:null}; return data;
}

let lastRendered=null;
async function renderActivity(a){
  document.querySelectorAll('.step').forEach(x=>x.classList.toggle('active',x.dataset.act===a.id));
  $('#connectionStatus').textContent=state.demo?'DEMO MODE':`CASE ${state.session.code}`;
  $('#connectionStatus').classList.toggle('live',!state.demo);
  const response=await myResponse(a.id);
  const signature=`${a.id}-${JSON.stringify(response)}-${state.session.show_results}`;
  if(signature===lastRendered && !['court_round','commission'].includes(a.type)) return;
  lastRendered=signature;
  const root=$('#activityRoot');
  root.innerHTML=`<div class="activity-kicker">${escapeHtml(a.short)} · слайд ${a.slide||'—'}</div><h1 class="activity-title">${escapeHtml(a.title)}</h1><p class="activity-sub">${escapeHtml(a.subtitle||'')}</p><div id="activityBody"></div>`;
  const body=$('#activityBody');
  if(a.type==='lobby') return renderLobby(body);
  if(a.type==='personal_poll') return renderPoll(body,a,response);
  if(a.type==='personal_poll_text') return renderPollText(body,a,response);
  if(a.type==='personal_text') return renderText(body,a,response);
  if(a.type==='personal_dual_poll') return renderDual(body,a,response);
  if(a.type==='court_round') return renderCourt(body,a);
  if(a.type==='commission') return renderCommission(body,a);
  if(a.type==='risk_matrix') return renderRisk(body,a,response);
}

function renderLobby(body){
  body.innerHTML=`<div class="waiting-orb"></div><div class="success-panel"><b>Вы подключены</b><div style="color:var(--muted);margin-top:8px">Группа ${state.participant.group_no} · ${RoleLabels[state.participant.role]}<br>Судья откроет задание автоматически.</div></div><div class="gif-strip"><div class="gif-card"><img src="assets/hero-loop.gif"><span>Human × AI</span></div><div class="gif-card"><img src="assets/training-loop.gif"><span>Reward / feedback</span></div></div>`;
}

function renderPoll(body,a,response){
  const selected=response?.answer?.choice;
  body.innerHTML=`<div class="answer-grid">${a.options.map(o=>`<button class="answer-btn ${selected===o?'selected':''}" data-choice="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>${selected?'<div class="success-panel">Ответ сохранён. Можно изменить его, пока задание открыто.</div>':''}`;
  body.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>submitResponse(a.id,{choice:b.dataset.choice}));
}

function renderPollText(body,a,response){
  const selected=response?.answer?.choice||''; const detail=response?.answer?.text||'';
  body.innerHTML=`<div class="answer-grid">${a.options.map(o=>`<button class="answer-btn ${selected===o?'selected':''}" data-choice="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div><div class="role-prompt"><label style="display:block;color:var(--muted);font-size:13px;margin-bottom:8px">${escapeHtml(a.prompt)}</label><textarea id="detailText" class="textarea" placeholder="Коротко">${escapeHtml(detail)}</textarea><button id="saveDetail" class="btn btn-primary" style="margin-top:10px">Сохранить ответ</button></div>`;
  body.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>submitResponse(a.id,{choice:b.dataset.choice,text:$('#detailText').value}));
  $('#saveDetail').onclick=()=>submitResponse(a.id,{choice:selected||'Проверить',text:$('#detailText').value});
}

function renderText(body,a,response){
  body.innerHTML=`<div class="role-prompt"><textarea id="textAnswer" class="textarea" placeholder="${escapeHtml(a.placeholder||'Ваш ответ')}">${escapeHtml(response?.answer?.text||'')}</textarea><button id="saveText" class="btn btn-primary" style="margin-top:10px">Отправить</button></div>${response?'<div class="success-panel">Ответ сохранён.</div>':''}`;
  $('#saveText').onclick=()=>submitResponse(a.id,{text:$('#textAnswer').value.trim()});
}

function renderDual(body,a,response){
  const ans=response?.answer||{};
  body.innerHTML=`<div class="code-grid">${a.panels.map(p=>`<div class="code-panel"><h3>${p.label}</h3><pre>${escapeHtml(p.code)}</pre><div class="answer-grid" style="grid-template-columns:1fr 1fr">${a.options.map(o=>`<button class="answer-btn ${ans[p.id]===o?'selected':''}" data-panel="${p.id}" data-choice="${o}" style="min-height:60px">${o}</button>`).join('')}</div></div>`).join('')}</div><div class="success-panel">Подсказка: это упражнение не является детектором авторства. После голосования обсудим, можно ли вообще надёжно определить автора по стилю.</div>`;
  body.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>submitResponse(a.id,{...ans,[b.dataset.panel]:b.dataset.choice}));
}

async function renderCourt(body,a){
  const gd=await groupData(a.id); const role=state.participant.role; const mine=gd.roleResponses.find(r=>r.participant_id===state.participant.id);
  const canFinalize=role==='secretary'||(role==='expert'&&state.session.max_group_size===3);
  body.innerHTML=`<div class="role-prompt"><span class="tag ${RoleClass[role]}">${RoleLabels[role]}</span><h3 style="font-size:22px;margin-bottom:8px">Ваша задача</h3><p>${escapeHtml(rolePrompt(a,role))}</p>${role!=='secretary'?`<textarea id="roleArgument" class="textarea" placeholder="Один короткий аргумент">${escapeHtml(mine?.answer?.text||'')}</textarea><button id="saveArgument" class="btn btn-primary" style="margin-top:10px">Зафиксировать аргумент</button>`:''}</div><div class="court-layout">${gd.roleResponses.filter(r=>r.answer?.text).map(r=>`<div class="argument-card"><div class="who">${RoleLabels[r.role]||r.role}</div><p>${escapeHtml(r.answer.text)}</p></div>`).join('')||'<div class="empty">Аргументы группы появятся здесь</div>'}</div>${canFinalize?`<div class="role-prompt"><strong>Итог группы</strong><div class="answer-grid">${a.verdictOptions.map(o=>`<button class="answer-btn ${gd.groupResponse?.answer?.verdict===o?'selected':''}" data-verdict="${o}">${o}</button>`).join('')}</div><textarea id="groupComment" class="textarea" placeholder="Короткий итог команды">${escapeHtml(gd.groupResponse?.answer?.comment||'')}</textarea></div>`:'<div class="notice">Итог команды фиксирует секретарь. В группе из 3 человек — эксперт.</div>'}`;
  if($('#saveArgument')) $('#saveArgument').onclick=()=>submitResponse(a.id,{text:$('#roleArgument').value.trim()});
  body.querySelectorAll('[data-verdict]').forEach(b=>b.onclick=()=>submitGroup(a.id,{verdict:b.dataset.verdict,comment:$('#groupComment')?.value||''}));
}

async function renderCommission(body,a){
  const gd=await groupData(a.id); const idx=(state.participant.group_no-1)%a.cases.length; const c=a.cases[idx]; const role=state.participant.role;
  const canFinalize=role==='secretary'||(role==='expert'&&state.session.max_group_size===3);
  body.innerHTML=`<div class="role-prompt"><span class="tag">Кейс группы ${state.participant.group_no}</span><h2>${escapeHtml(c.name)}</h2><p style="font-size:18px;color:#fff">${escapeHtml(c.text)}</p></div>${canFinalize?`<div class="role-prompt"><strong>Итог экспертной комиссии</strong><label style="display:block;margin:15px 0 8px;color:var(--muted)">Статус</label><select id="caseStatus" class="select">${a.statusOptions.map(o=>`<option ${gd.groupResponse?.answer?.status===o?'selected':''}>${o}</option>`).join('')}</select><label style="display:block;margin:15px 0 8px;color:var(--muted)">Что должен проверить программист?</label><textarea id="caseControl" class="textarea">${escapeHtml(gd.groupResponse?.answer?.control||'')}</textarea><label style="display:block;margin:15px 0 8px;color:var(--muted)">Что произойдёт при ошибке?</label><textarea id="caseRisk" class="textarea">${escapeHtml(gd.groupResponse?.answer?.risk||'')}</textarea><button id="saveCase" class="btn btn-primary" style="margin-top:12px">Сохранить вердикт группы</button></div>`:`<div class="notice">Обсудите кейс. Итог фиксирует секретарь, а в тройке — эксперт.</div>`}`;
  if($('#saveCase')) $('#saveCase').onclick=()=>submitGroup(a.id,{status:$('#caseStatus').value,control:$('#caseControl').value.trim(),risk:$('#caseRisk').value.trim(),case:c.name});
}

function renderRisk(body,a,response){
  const ans=response?.answer||{};
  body.innerHTML=`<div style="display:grid;gap:13px;margin-top:22px">${a.items.map((it,i)=>`<div class="argument-card"><b>${escapeHtml(it)}</b><select class="select riskSelect" data-index="${i}" style="margin-top:10px">${['— выберите —',...a.options].map(o=>`<option ${ans[i]===o?'selected':''}>${o}</option>`).join('')}</select></div>`).join('')}</div><button id="saveRisk" class="btn btn-primary" style="margin-top:14px">Сохранить</button>`;
  $('#saveRisk').onclick=()=>{ const obj={}; document.querySelectorAll('.riskSelect').forEach(x=>obj[x.dataset.index]=x.value); submitResponse(a.id,obj); };
}

async function submitResponse(activityId,answer){
  try{
    if(state.demo){
      const db=demoDb(); const arr=db.raw.responses; const idx=arr.findIndex(r=>r.participant_id===state.participant.id&&r.activity_id===activityId);
      const row={participant_id:state.participant.id,session_id:state.session.id,activity_id:activityId,group_no:state.participant.group_no,role:state.participant.role,answer,updated_at:new Date().toISOString()};
      if(idx>=0) arr[idx]=row; else arr.push(row); db.save();
    } else { const {error}=await state.client.rpc('submit_response',{p_activity_id:activityId,p_answer:answer}); if(error) throw error; }
    lastRendered=null; await refresh();
  }catch(e){toast(e.message||'Ошибка сохранения');}
}

async function submitGroup(activityId,answer){
  try{
    if(state.demo){
      const db=demoDb(); const arr=db.raw.groupResponses; const idx=arr.findIndex(r=>r.group_no===state.participant.group_no&&r.activity_id===activityId);
      const row={session_id:state.session.id,activity_id:activityId,group_no:state.participant.group_no,answer,updated_at:new Date().toISOString()};
      if(idx>=0) arr[idx]=row; else arr.push(row); db.save();
    } else { const {error}=await state.client.rpc('submit_group_response',{p_activity_id:activityId,p_answer:answer}); if(error) throw error; }
    toast('Итог группы сохранён'); lastRendered=null; await refresh();
  }catch(e){toast(e.message||'Ошибка сохранения');}
}

boot();
