(() => {
  const CFG = window.AICourtConfig;
  const ACTIVITIES = window.AICourtActivities;
  const activityMap = Object.fromEntries(ACTIVITIES.map(a => [a.id, a]));

  const RoleLabels = {
    prosecutor: "Обвинитель",
    defender: "Защитник",
    expert: "Эксперт",
    secretary: "Секретарь"
  };

  const RoleClass = {
    prosecutor: "role-prosecutor",
    defender: "role-defender",
    expert: "role-expert",
    secretary: "role-secretary"
  };

  const state = {
    client: null,
    demo: false,
    authUser: null,
    participant: null,
    session: null,
    teacher: false,
    teacherToken: null,
    timer: null
  };

  function getActivity(id){ return activityMap[id] || activityMap.lobby; }
  function activities(){ return ACTIVITIES; }
  function config(){ return CFG; }

  function toast(message){
    const el=document.createElement('div');
    el.className='toast';
    el.textContent=message;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),3200);
  }

  function escapeHtml(s=''){
    return String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':'&quot;'}[c]));
  }

  function rolePrompt(activity, role){
    return activity[role] || activity.expert || "Обсудите ситуацию внутри группы.";
  }

  async function initSupabase(){
    if(!CFG.supabaseUrl || !CFG.supabaseAnonKey){
      state.demo=!!CFG.demoModeWhenUnconfigured;
      return null;
    }
    const mod = await import('https://esm.sh/@supabase/supabase-js@2');
    state.client=mod.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth:{persistSession:true,autoRefreshToken:true}
    });
    const {data:{session}}=await state.client.auth.getSession();
    if(!session){
      const {data,error}=await state.client.auth.signInAnonymously();
      if(error) throw error;
      state.authUser=data.user;
    } else {
      state.authUser=session.user;
    }
    return state.client;
  }

  function demoDb(){
    const KEY='ai-court-demo-v4';
    const raw=JSON.parse(localStorage.getItem(KEY)||'null') || {
      session:{
        id:'demo-session',code:'AI-01',status:'open',current_activity:'lobby',
        show_results:false,group_count:6,max_group_size:4,title:'Человек против ИИ'
      },
      participants:[],responses:[],groupResponses:[]
    };
    const save=()=>localStorage.setItem(KEY,JSON.stringify(raw));
    return {raw,save,reset:()=>localStorage.removeItem(KEY)};
  }

  function csvDownload(rows, filename='ai-court-export.csv'){
    const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';
    const csv='\ufeff'+rows.map(r=>r.map(esc).join(';')).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=filename;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),0);
  }

  window.AICourtCore = {
    RoleLabels, RoleClass, state, getActivity, activities, config,
    toast, escapeHtml, rolePrompt, initSupabase, demoDb, csvDownload
  };
})();
