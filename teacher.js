import {state, initSupabase, demoDb, activities, getActivity, RoleLabels, toast, escapeHtml, csvDownload, config} from './core.js';
const $=s=>document.querySelector(s);
let timer=null; let snapshot=null;

async function boot(){
  await initSupabase();
  $('#teacherCode').value=config().defaultSessionCode||'AI-01';
  $('#teacherLogin').addEventListener('submit',login);
  $('#fullResetConfirm').addEventListener('input',e=>$('#fullResetDo').disabled=e.target.value!=='СБРОСИТЬ');
  $('#fullResetDo').onclick=fullReset;
  $('#fullResetCancel').onclick=()=>$('#resetModal').classList.add('hidden');
}

async function login(e){
  e.preventDefault(); const code=$('#teacherCode').value.trim().toUpperCase(); const token=$('#teacherToken').value.trim();
  try{
    if(state.demo){ state.teacher=true; state.teacherToken=token||'demo'; }
    else { const {data,error}=await state.client.rpc('teacher_authenticate',{p_code:code,p_teacher_token:token}); if(error) throw error; if(!data?.ok) throw new Error('Неверный токен судьи'); state.teacher=true; state.teacherToken=token; }
    state.session={code}; $('#teacherLanding').classList.add('hidden'); $('#teacherApp').classList.remove('hidden'); renderActivityNav(); start();
  }catch(err){ toast(err.message||'Не удалось войти'); }
}

function renderActivityNav(){
  $('#activityNav').innerHTML=activities().map(a=>`<button data-activity="${a.id}"><b>${escapeHtml(a.short)}</b><small>${escapeHtml(a.title)} · слайд ${a.slide||'—'}</small></button>`).join('');
  document.querySelectorAll('[data-activity]').forEach(b=>b.onclick=()=>setActivity(b.dataset.activity));
}
function start(){ refresh(); clearInterval(timer); timer=setInterval(refresh,1200); bindActions(); }
function bindActions(){
  $('#resetActivity').onclick=resetActivity; $('#resetProgress').onclick=resetProgress; $('#fullReset').onclick=()=>{$('#resetModal').classList.remove('hidden');$('#fullResetConfirm').value='';$('#fullResetDo').disabled=true}; $('#exportCsv').onclick=exportCsv; $('#saveGroupSettings').onclick=saveGroupSettings;
}
async function loadSnapshot(){
  if(state.demo){ const db=demoDb(); return {session:db.raw.session,participants:db.raw.participants,responses:db.raw.responses,group_responses:db.raw.groupResponses}; }
  const {data,error}=await state.client.rpc('teacher_snapshot',{p_code:state.session.code,p_teacher_token:state.teacherToken}); if(error) throw error; return data;
}
async function refresh(){ try{ snapshot=await loadSnapshot(); renderDashboard(); }catch(e){console.warn(e);} }
function renderDashboard(){
  const s=snapshot.session; $('#groupCountInput').value=s.group_count||6; $('#groupSizeInput').value=s.max_group_size||4; $('#caseCode').textContent=s.code; $('#currentActivity').textContent=getActivity(s.current_activity).short; $('#joinedCount').textContent=snapshot.participants.length; $('#answeredCount').textContent=snapshot.responses.filter(r=>r.activity_id===s.current_activity).length;
  document.querySelectorAll('[data-activity]').forEach(b=>b.classList.toggle('current',b.dataset.activity===s.current_activity));
  renderGroups(); renderStats(); renderFeed();
}
function renderGroups(){
  const by={}; snapshot.participants.forEach(p=>(by[p.group_no]??=[]).push(p));
  const groupCount=snapshot.session.group_count||Math.max(1,...Object.keys(by).map(Number));
  $('#groupsGrid').innerHTML=Array.from({length:groupCount},(_,i)=>i+1).map(g=>{
    const members=(by[g]||[]).sort((a,b)=>['prosecutor','defender','expert','secretary'].indexOf(a.role)-['prosecutor','defender','expert','secretary'].indexOf(b.role));
    return `<div class="group-card"><h3>Группа ${g} <span style="color:var(--muted);font-size:12px">${members.length}/${snapshot.session.max_group_size}</span></h3>${members.length?members.map(m=>`<div class="member"><b>${escapeHtml(m.nickname)}</b><span>${RoleLabels[m.role]}</span></div>`).join(''):'<div style="color:var(--muted);font-size:12px">Пока пусто</div>'}</div>`;
  }).join('');
}
function renderStats(){
  const a=getActivity(snapshot.session.current_activity); const responses=snapshot.responses.filter(r=>r.activity_id===a.id); const groups=snapshot.group_responses.filter(r=>r.activity_id===a.id); const root=$('#statsRoot');
  if(a.type==='personal_poll'||a.type==='personal_poll_text'){
    const counts=Object.fromEntries((a.options||[]).map(o=>[o,0])); responses.forEach(r=>{const c=r.answer?.choice;if(c in counts)counts[c]++}); const max=Math.max(1,...Object.values(counts)); root.innerHTML=Object.entries(counts).map(([k,v])=>bar(k,v,max)).join('');
  } else if(a.type==='personal_dual_poll'){
    root.innerHTML=a.panels.map(p=>`<h3>${p.label}</h3>${a.options.map(o=>{const v=responses.filter(r=>r.answer?.[p.id]===o).length;return bar(o,v,Math.max(1,responses.length));}).join('')}`).join('');
  } else if(a.type==='court_round'){
    const counts=Object.fromEntries(a.verdictOptions.map(o=>[o,0])); groups.forEach(r=>{const v=r.answer?.verdict;if(v in counts)counts[v]++}); const max=Math.max(1,...Object.values(counts)); root.innerHTML=Object.entries(counts).map(([k,v])=>bar(k,v,max)).join('')+`<div class="notice">Итогов групп: ${groups.length}. Индивидуальных аргументов: ${responses.length}.</div>`;
  } else if(a.type==='commission'){
    root.innerHTML=groups.length?groups.map(r=>`<div class="feed-item"><b>Группа ${r.group_no} · ${escapeHtml(r.answer?.case||'Кейс')}</b><br>${escapeHtml(r.answer?.status||'')} · Контроль: ${escapeHtml(r.answer?.control||'—')}<br>Риск: ${escapeHtml(r.answer?.risk||'—')}</div>`).join(''):'<div class="empty">Ждём итоги команд</div>';
  } else if(a.type==='risk_matrix'){
    root.innerHTML=`<div class="notice">Ответили: ${responses.length}. Детали видны в ленте ответов и экспорте CSV.</div>`;
  } else if(a.type==='personal_text'){
    root.innerHTML=`<div class="notice">Текстовых ответов: ${responses.length}</div>`;
  } else root.innerHTML='<div class="empty">На этом этапе статистика не требуется</div>';
}
function bar(label,v,max){return `<div class="chart-row"><div class="chart-label">${escapeHtml(label)}</div><div class="bar"><i style="width:${Math.round(v/max*100)}%"></i></div><div class="chart-value">${v}</div></div>`}
function renderFeed(){
  const a=getActivity(snapshot.session.current_activity); const rs=snapshot.responses.filter(r=>r.activity_id===a.id).filter(r=>r.answer?.text); $('#feed').innerHTML=rs.length?rs.slice(-12).reverse().map(r=>`<div class="feed-item"><b>Группа ${r.group_no} · ${RoleLabels[r.role]||r.role}</b><br>${escapeHtml(r.answer.text)}</div>`).join(''):'<div class="empty">Короткие ответы появятся здесь</div>';
}
async function setActivity(id){
  try{
    if(state.demo){ const db=demoDb();db.raw.session.current_activity=id;db.save(); }
    else { const {error}=await state.client.rpc('teacher_set_activity',{p_code:state.session.code,p_teacher_token:state.teacherToken,p_activity_id:id});if(error)throw error; }
    await refresh();
  }catch(e){toast(e.message||'Ошибка');}
}
async function resetActivity(){
  const id=snapshot.session.current_activity;if(!confirm(`Очистить ответы только этапа «${getActivity(id).short}»?`))return;
  if(state.demo){const db=demoDb();db.raw.responses=db.raw.responses.filter(r=>r.activity_id!==id);db.raw.groupResponses=db.raw.groupResponses.filter(r=>r.activity_id!==id);db.save();}
  else {const {error}=await state.client.rpc('teacher_reset_activity',{p_code:state.session.code,p_teacher_token:state.teacherToken,p_activity_id:id});if(error)return toast(error.message)} toast('Текущий этап очищен');refresh();
}
async function resetProgress(){
  if(!confirm('Стереть все ответы, но оставить участников, группы и роли?'))return;
  if(state.demo){const db=demoDb();db.raw.responses=[];db.raw.groupResponses=[];db.raw.session.current_activity='lobby';db.save();}
  else {const {error}=await state.client.rpc('teacher_reset_progress',{p_code:state.session.code,p_teacher_token:state.teacherToken});if(error)return toast(error.message)} toast('Прогресс очищен, участники сохранены');refresh();
}
async function fullReset(){
  $('#resetModal').classList.add('hidden');
  if(state.demo){demoDb().reset();}
  else {const {error}=await state.client.rpc('teacher_full_reset',{p_code:state.session.code,p_teacher_token:state.teacherToken});if(error)return toast(error.message)} toast('Заседание полностью сброшено');refresh();
}
function exportCsv(){
  const rows=[["Тип","Группа","Участник","Роль","Этап","Ответ"]];
  snapshot.responses.forEach(r=>{const p=snapshot.participants.find(x=>x.id===r.participant_id);rows.push(["Личный",r.group_no,p?.nickname||'',RoleLabels[r.role]||r.role,r.activity_id,JSON.stringify(r.answer)])});
  snapshot.group_responses.forEach(r=>rows.push(["Групповой",r.group_no,"","",r.activity_id,JSON.stringify(r.answer)]));
  csvDownload(rows,`ai-court-${snapshot.session.code}.csv`);
}
boot();

async function saveGroupSettings(){
  const groupCount=Number($('#groupCountInput').value); const groupSize=Number($('#groupSizeInput').value);
  if(snapshot.participants.length) return toast('Настройки групп можно менять только до входа студентов или после полного сброса');
  if(state.demo){const db=demoDb();db.raw.session.group_count=groupCount;db.raw.session.max_group_size=groupSize;db.save();toast('Настройки групп сохранены');return refresh();}
  const {error}=await state.client.rpc('teacher_update_group_settings',{p_code:state.session.code,p_teacher_token:state.teacherToken,p_group_count:groupCount,p_max_group_size:groupSize});
  if(error)return toast(error.message); toast('Настройки групп сохранены'); refresh();
}
