import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, getDoc, serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------------- 狀態 ---------------- */
const DEFAULT_CATEGORIES = ["郵資","社會局方案","中心活動","設施設備","建築物養護","志工津貼","生日禮金","水電費","每月固定支出","拜拜","電信","中心文具","其他"];
let categories = DEFAULT_CATEGORIES.slice();
let expenses = [];      // 從 Firestore 即時同步
let allUsers = [];      // users 集合（僅 admin 會用到）
let currentUser = null; // { uid, email, name, role }
let editingId = null;
let catChart = null, trendChart = null;
let unsubExpenses = null, unsubUsers = null;

const ROLE_LABEL = { staff:"登打者", director:"理事長", admin:"主任", pending:"待設定" };
const CHART_COLORS = ["#2c6e64","#c98a2c","#6a8caf","#b14e4e","#7a9b5c","#a17fb5","#cf9b5c","#4a8b8b","#8d6a4f","#5c7fa8","#a85c7f","#7f8d4f","#967fa8"];

/* ---------------- 工具 ---------------- */
function todayISO(){ return new Date().toISOString().slice(0,10); }
function rocFromISO(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-").map(Number);
  return `民國${y-1911}年${m}月${d}日`;
}
function fmtMoney(n){ return "NT$" + Math.round(n||0).toLocaleString("zh-TW"); }
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), 2300);
}
function $(id){ return document.getElementById(id); }

/* ---------------- 登入 / 登出 ---------------- */
$('loginBtn').addEventListener('click', async ()=>{
  const email = $('loginEmail').value.trim();
  const pw = $('loginPassword').value;
  $('loginError').textContent = "";
  if(!email || !pw){ $('loginError').textContent = "請輸入電子郵件與密碼"; return; }
  try{
    await signInWithEmailAndPassword(auth, email, pw);
  }catch(e){
    $('loginError').textContent = "登入失敗：帳號或密碼錯誤，請聯絡主任確認帳號。";
  }
});
$('loginForgot').addEventListener('click', async ()=>{
  const email = $('loginEmail').value.trim();
  if(!email){ $('loginError').textContent = "請先輸入電子郵件，再點選忘記密碼"; return; }
  try{
    await sendPasswordResetEmail(auth, email);
    $('loginError').style.color = 'var(--teal-deep)';
    $('loginError').textContent = "已寄出重設密碼信件，請至信箱查看。";
  }catch(e){
    $('loginError').textContent = "寄送失敗，請確認電子郵件是否正確。";
  }
});
$('logoutBtn').addEventListener('click', ()=>signOut(auth));
$('pendingLogoutBtn').addEventListener('click', ()=>signOut(auth));

onAuthStateChanged(auth, async (user)=>{
  if(unsubExpenses){ unsubExpenses(); unsubExpenses=null; }
  if(unsubUsers){ unsubUsers(); unsubUsers=null; }

  if(!user){
    $('loginScreen').classList.remove('hidden');
    $('pendingScreen').classList.add('hidden');
    $('appRoot').classList.add('hidden');
    return;
  }

  // 取得 / 建立使用者角色文件
  const userRef = doc(db, 'users', user.uid);
  let snap = await getDoc(userRef);
  if(!snap.exists()){
    await setDoc(userRef, {
      email: user.email,
      name: user.displayName || user.email.split('@')[0],
      role: 'pending',
      createdAt: serverTimestamp()
    });
    snap = await getDoc(userRef);
  }
  const data = snap.data();
  currentUser = { uid: user.uid, email: user.email, name: data.name || user.email, role: data.role || 'pending' };

  $('loginScreen').classList.add('hidden');

  if(currentUser.role === 'pending'){
    $('pendingScreen').classList.remove('hidden');
    $('appRoot').classList.add('hidden');
    return;
  }
  $('pendingScreen').classList.add('hidden');
  $('appRoot').classList.remove('hidden');

  applyRoleUI();
  startListeners();
});

function applyRoleUI(){
  $('userName').textContent = currentUser.name + "（" + currentUser.email + "）";
  const badge = $('userRoleBadge');
  badge.textContent = ROLE_LABEL[currentUser.role] || currentUser.role;
  badge.className = 'role-badge role-' + (currentUser.role === 'admin' ? 'admin' : currentUser.role === 'director' ? 'director' : 'staff');

  $('f_recorder').value = currentUser.name;

  const isAdmin = currentUser.role === 'admin';
  const isStaffOrAdmin = isAdmin || currentUser.role === 'staff';
  const isDirector = currentUser.role === 'director';

  // 登打分頁：理事長唯讀，看不到登打表單，只看分頁切到分析
  $('entryFormCard').classList.toggle('hidden', !isStaffOrAdmin);
  document.querySelector('[data-tab="entry"]').classList.toggle('hidden', isDirector);
  if(isDirector){
    // 理事長預設直接看分析頁
    switchTab('analysis');
  }
  $('usersTabBtn').classList.toggle('hidden', !isAdmin);
}

/* ---------------- Tab 切換 ---------------- */
function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const btn = document.querySelector(`[data-tab="${tab}"]`);
  if(btn) btn.classList.add('active');
  $('panel-'+tab).classList.add('active');
  if(tab === 'analysis') runAnalysis();
}
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>switchTab(btn.dataset.tab));
});

/* ---------------- Firestore 監聽（即時同步） ---------------- */
function startListeners(){
  // 類別設定
  const catRef = doc(db, 'config', 'categories');
  getDoc(catRef).then(async snap=>{
    if(snap.exists() && Array.isArray(snap.data().list)){
      categories = snap.data().list;
    }else{
      await setDoc(catRef, { list: DEFAULT_CATEGORIES });
      categories = DEFAULT_CATEGORIES.slice();
    }
    renderCategoryOptions();
  });

  // 支出紀錄（即時）
  const q = query(collection(db, 'expenses'), orderBy('date', 'desc'));
  unsubExpenses = onSnapshot(q, (snap)=>{
    expenses = snap.docs.map(d=>({ id: d.id, ...d.data() }));
    renderRecent();
    if($('panel-analysis').classList.contains('active')) runAnalysis();
  }, (err)=>{
    showToast("⚠ 資料同步失敗：" + err.message);
  });

  // 使用者清單（僅 admin 監聽）
  if(currentUser.role === 'admin'){
    unsubUsers = onSnapshot(collection(db, 'users'), (snap)=>{
      allUsers = snap.docs.map(d=>({ id:d.id, ...d.data() }));
      renderUsers();
    });
  }
}

/* ---------------- 類別下拉 ---------------- */
function renderCategoryOptions(){
  $('f_category').innerHTML = categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  $('r_category').innerHTML = `<option value="">全部類別</option>` + categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}
$('f_category').addEventListener('change', e=>{
  $('f_customCatWrap').style.display = e.target.value === "其他" ? "block" : "none";
});
$('addCatBtn').addEventListener('click', async ()=>{
  const name = prompt("請輸入新的支出類別名稱：");
  if(name && name.trim() && !categories.includes(name.trim())){
    categories.push(name.trim());
    await setDoc(doc(db,'config','categories'), { list: categories });
    renderCategoryOptions();
    $('f_category').value = name.trim();
    showToast("已新增類別「"+name.trim()+"」");
  }
});

/* ---------------- 新增 / 編輯表單 ---------------- */
$('entryForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  let category = $('f_category').value;
  if(category === "其他"){
    const custom = $('f_customCat').value.trim();
    if(custom) category = custom;
  }
  const rec = {
    date: $('f_date').value,
    category,
    desc: $('f_desc').value.trim(),
    amount: Number($('f_amount').value) || 0,
    type: document.querySelector('input[name=f_type]:checked').value,
    recorder: currentUser.name,
    recorderUid: currentUser.uid,
    note: $('f_note').value.trim(),
  };
  try{
    if(editingId){
      await updateDoc(doc(db,'expenses', editingId), { ...rec, updatedAt: serverTimestamp() });
      showToast("已更新該筆紀錄");
    }else{
      await addDoc(collection(db,'expenses'), { ...rec, status:'待核', createdAt: serverTimestamp() });
      showToast("已新增一筆支出紀錄");
    }
    if(!categories.includes(category)){
      categories.push(category);
      await setDoc(doc(db,'config','categories'), { list: categories });
      renderCategoryOptions();
    }
    resetForm();
  }catch(err){
    showToast("⚠ 儲存失敗：" + err.message);
  }
});

function resetForm(){
  editingId = null;
  $('entryForm').reset();
  $('f_date').value = todayISO();
  $('f_recorder').value = currentUser.name;
  $('f_customCatWrap').style.display='none';
  $('formTitle').innerHTML = '新增一筆支出紀錄 <span class="tag">登打</span>';
  $('submitBtn').textContent = '儲存紀錄';
  $('cancelEditBtn').style.display='none';
  $('editBannerHolder').innerHTML='';
}
$('cancelEditBtn').addEventListener('click', resetForm);

window.startEdit = function(id){
  const rec = expenses.find(x=>x.id===id);
  if(!rec) return;
  editingId = id;
  $('f_date').value = rec.date;
  if(!categories.includes(rec.category)){ categories.push(rec.category); renderCategoryOptions(); }
  $('f_category').value = categories.includes(rec.category) ? rec.category : "其他";
  if($('f_category').value === "其他"){
    $('f_customCatWrap').style.display='block';
    $('f_customCat').value = rec.category;
  }
  $('f_amount').value = rec.amount;
  document.querySelector(`input[name=f_type][value="${rec.type}"]`).checked = true;
  $('f_desc').value = rec.desc;
  $('f_note').value = rec.note || "";
  $('formTitle').innerHTML = '編輯支出紀錄 <span class="tag">編輯中</span>';
  $('submitBtn').textContent = '儲存變更';
  $('cancelEditBtn').style.display='inline-block';
  $('editBannerHolder').innerHTML =
    `<div class="edit-banner"><span>正在編輯 ${rec.date}「${escapeHtml(rec.desc)}」</span><button class="small-link" onclick="document.getElementById('cancelEditBtn').click()">取消</button></div>`;
  switchTab('entry');
  window.scrollTo({top:0,behavior:'smooth'});
};

window.deleteEntry = async function(id){
  if(!confirm("確定要刪除這筆支出紀錄嗎？此操作無法復原。")) return;
  try{
    await deleteDoc(doc(db,'expenses', id));
    showToast("已刪除");
  }catch(err){
    showToast("⚠ 刪除失敗：" + err.message);
  }
};

window.setStatus = async function(id, status){
  try{
    await updateDoc(doc(db,'expenses', id), {
      status, statusBy: currentUser.name, statusAt: serverTimestamp()
    });
    showToast(status === '已核可' ? "已核可" : "已退件");
  }catch(err){
    showToast("⚠ 操作失敗：" + err.message);
  }
};

function statusBadge(status){
  if(status==="已核可") return `<span class="badge badge-approved">已核可</span>`;
  if(status==="已退件") return `<span class="badge badge-rejected">已退件</span>`;
  return `<span class="badge badge-pending">待核</span>`;
}
function approveButtons(r){
  const canApprove = currentUser.role === 'director' || currentUser.role === 'admin';
  if(!canApprove) return '';
  return `<button class="btn btn-ghost btn-sm" onclick="setStatus('${r.id}','已核可')">核可</button>
          <button class="btn btn-amber btn-sm" onclick="setStatus('${r.id}','已退件')">退件</button>`;
}
function editButtons(r){
  const canEdit = currentUser.role === 'staff' || currentUser.role === 'admin';
  if(!canEdit) return '';
  return `<button class="btn btn-ghost btn-sm" onclick="startEdit('${r.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteEntry('${r.id}')">刪除</button>`;
}

/* ---------------- 近期紀錄表 (Tab1) ---------------- */
function renderRecent(){
  const sorted = expenses.slice().sort((a,b)=> b.date.localeCompare(a.date));
  const recent = sorted.slice(0,15);
  $('recentCount').textContent = expenses.length + " 筆（共）";
  $('recentEmpty').style.display = recent.length ? 'none':'block';
  $('recentBody').innerHTML = recent.map(r=>`
    <tr>
      <td>${r.date}</td>
      <td><span class="pill">${escapeHtml(r.category)}</span></td>
      <td>${escapeHtml(r.desc)}</td>
      <td class="amt">${fmtMoney(r.amount)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${escapeHtml(r.recorder||"")}</td>
      <td class="actions-cell">${editButtons(r)}${approveButtons(r)}</td>
    </tr>`).join("");
}

/* ---------------- 區間篩選 (Tab2) ---------------- */
function setQuickRange(kind){
  const today = new Date();
  let start, end;
  const fmt = d => d.toISOString().slice(0,10);
  if(kind === 'thisWeek'){
    const day = (today.getDay()+6)%7;
    start = new Date(today); start.setDate(today.getDate()-day);
    end = new Date(start); end.setDate(start.getDate()+6);
  }else if(kind === 'thisMonth'){
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth()+1, 0);
  }else if(kind === 'lastMonth'){
    start = new Date(today.getFullYear(), today.getMonth()-1, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 0);
  }else if(kind === 'thisYear'){
    start = new Date(today.getFullYear(),0,1);
    end = new Date(today.getFullYear(),11,31);
  }else{
    $('r_start').value = ""; $('r_end').value = ""; return;
  }
  $('r_start').value = fmt(start);
  $('r_end').value = fmt(end);
}
document.querySelectorAll('#quickRange button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#quickRange button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    setQuickRange(btn.dataset.range);
    runAnalysis();
  });
});
$('applyFilterBtn').addEventListener('click', ()=>{
  document.querySelectorAll('#quickRange button').forEach(b=>b.classList.remove('active'));
  runAnalysis();
});

function getFiltered(){
  const start = $('r_start').value;
  const end = $('r_end').value;
  const cat = $('r_category').value;
  const type = $('r_type').value;
  const status = $('r_status').value;
  return expenses.filter(r=>{
    if(start && r.date < start) return false;
    if(end && r.date > end) return false;
    if(cat && r.category !== cat) return false;
    if(type && r.type !== type) return false;
    if(status && (r.status||'待核') !== status) return false;
    return true;
  }).sort((a,b)=> a.date.localeCompare(b.date));
}
function dayDiff(a,b){ return Math.round((new Date(b) - new Date(a)) / 86400000) + 1; }
function weekKey(dateStr){
  const d = new Date(dateStr);
  const day = (d.getDay()+6)%7;
  const monday = new Date(d); monday.setDate(d.getDate()-day);
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  const f = x => `${x.getMonth()+1}/${x.getDate()}`;
  return `${f(monday)}~${f(sunday)}`;
}
function monthKey(dateStr){ const [y,m] = dateStr.split("-"); return `${y}/${m}`; }

function runAnalysis(){
  const rows = getFiltered();
  const start = $('r_start').value, end = $('r_end').value;

  $('rangeLabel').textContent = (start||end)
    ? `區間：${start || "最早"} ～ ${end || "最新"}　（${rocFromISO(start)||''} ${start?'～':''} ${rocFromISO(end)||''}）`
    : "目前顯示：全部紀錄";

  const total = rows.reduce((s,r)=>s+r.amount,0);
  const count = rows.length;
  const pending = rows.filter(r=>!r.status || r.status==="待核").length;
  let days = 1;
  if(rows.length) days = Math.max(1, dayDiff(rows[0].date, rows[rows.length-1].date));

  $('statTotal').textContent = fmtMoney(total);
  $('statCount').textContent = count;
  $('statAvgDay').textContent = fmtMoney(total/days);
  $('statPending').textContent = pending;

  const catMap = {};
  rows.forEach(r=>{
    if(!catMap[r.category]) catMap[r.category] = {amount:0,count:0};
    catMap[r.category].amount += r.amount;
    catMap[r.category].count += 1;
  });
  const catEntries = Object.entries(catMap).sort((a,b)=>b[1].amount-a[1].amount);
  $('catTableBody').innerHTML = catEntries.length ? catEntries.map(([cat,v],i)=>`
    <tr>
      <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${CHART_COLORS[i%CHART_COLORS.length]};margin-right:6px;"></span>${escapeHtml(cat)}</td>
      <td class="amt">${fmtMoney(v.amount)}</td>
      <td class="amt">${total? (v.amount/total*100).toFixed(1):'0.0'}%</td>
      <td class="amt">${v.count}</td>
    </tr>`).join("") : `<tr><td colspan="4" class="empty">無資料</td></tr>`;

  if(catChart) catChart.destroy();
  catChart = new Chart($('catChart'), {
    type: 'bar',
    data: { labels: catEntries.map(e=>e[0]), datasets: [{ label:'支出金額', data: catEntries.map(e=>e[1].amount), backgroundColor: catEntries.map((_,i)=>CHART_COLORS[i%CHART_COLORS.length]), borderRadius:4 }] },
    options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{callbacks:{label:ctx=>fmtMoney(ctx.raw)}} },
      scales:{ x:{ ticks:{ callback:v=>'$'+v.toLocaleString() } } } }
  });

  let groupFn, unitLabel;
  if(days <= 16){ groupFn = r=>r.date; unitLabel = "依日"; }
  else if(days <= 130){ groupFn = r=>weekKey(r.date); unitLabel = "依週"; }
  else { groupFn = r=>monthKey(r.date); unitLabel = "依月"; }
  $('trendUnit').textContent = unitLabel;

  const trendMap = {};
  rows.forEach(r=>{ const k = groupFn(r); trendMap[k] = (trendMap[k]||0) + r.amount; });
  const trendKeys = Object.keys(trendMap).sort((a,b)=> rows.findIndex(r=>groupFn(r)===a) - rows.findIndex(r=>groupFn(r)===b));

  if(trendChart) trendChart.destroy();
  trendChart = new Chart($('trendChart'), {
    type:'bar',
    data:{ labels: trendKeys, datasets:[{ label:'支出金額', data: trendKeys.map(k=>trendMap[k]), backgroundColor:'#2c6e64', borderRadius:4 }] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{callbacks:{label:ctx=>fmtMoney(ctx.raw)}} },
      scales:{ y:{ ticks:{ callback:v=>'$'+v.toLocaleString() } } } }
  });

  $('detailCount').textContent = count + " 筆";
  $('detailEmpty').style.display = count ? 'none':'block';
  $('detailBody').innerHTML = rows.slice().reverse().map(r=>`
    <tr>
      <td>${r.date}</td>
      <td><span class="pill">${escapeHtml(r.category)}</span></td>
      <td>${escapeHtml(r.desc)}</td>
      <td class="amt">${fmtMoney(r.amount)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${escapeHtml(r.recorder||"")}</td>
      <td>${escapeHtml(r.note||"")}</td>
      <td class="actions-cell">${editButtons(r)}${approveButtons(r)}</td>
    </tr>`).join("");
}

/* ---------------- CSV 匯出 ---------------- */
$('exportCsvBtn').addEventListener('click', ()=>{
  const rows = getFiltered();
  if(!rows.length){ showToast("此區間沒有資料可匯出"); return; }
  const header = ["日期","民國日期","支出類別","摘要","支出金額","實支/預支","主管核示","登打人","備註"];
  const lines = [header.join(",")];
  rows.forEach(r=>{
    const vals = [r.date, rocFromISO(r.date), r.category, r.desc, r.amount, r.type, r.status||'待核', r.recorder||"", (r.note||"").replace(/\n/g," ")]
      .map(v => `"${String(v).replace(/"/g,'""')}"`);
    lines.push(vals.join(","));
  });
  const total = rows.reduce((s,r)=>s+r.amount,0);
  lines.push(`"小計","","","",${total},"","","",""`);
  const blob = new Blob(["\uFEFF"+lines.join("\n")], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const s = $('r_start').value || "全部";
  const e = $('r_end').value || "全部";
  a.href = url;
  a.download = `大同發展中心支出_${s}_${e}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast("CSV 已匯出，可提供理事長審核");
});

/* ---------------- 使用者管理（僅 admin） ---------------- */
function renderUsers(){
  const sorted = allUsers.slice().sort((a,b)=>(a.email||'').localeCompare(b.email||''));
  $('usersBody').innerHTML = sorted.map(u=>{
    const created = u.createdAt && u.createdAt.toDate ? u.createdAt.toDate().toLocaleString('zh-TW') : '—';
    return `
    <tr>
      <td>${escapeHtml(u.name||'')}<br><span class="note">${escapeHtml(u.email||'')}</span></td>
      <td><span class="role-badge role-${u.role==='admin'?'admin':u.role==='director'?'director':'staff'}">${ROLE_LABEL[u.role]||u.role}</span></td>
      <td>
        <select class="role-select" onchange="changeRole('${u.id}', this.value)">
          <option value="pending" ${u.role==='pending'?'selected':''}>待設定</option>
          <option value="staff" ${u.role==='staff'?'selected':''}>登打者</option>
          <option value="director" ${u.role==='director'?'selected':''}>理事長</option>
          <option value="admin" ${u.role==='admin'?'selected':''}>主任</option>
        </select>
      </td>
      <td>${created}</td>
    </tr>`;
  }).join("");
}
window.changeRole = async function(uid, role){
  try{
    await updateDoc(doc(db,'users', uid), { role });
    showToast("已更新角色");
  }catch(err){
    showToast("⚠ 更新失敗：" + err.message);
  }
};

/* ---------------- 初始化 ---------------- */
$('rocToday').textContent = `今日：${rocFromISO(todayISO())}（西元 ${todayISO()}）`;
$('f_date').value = todayISO();
