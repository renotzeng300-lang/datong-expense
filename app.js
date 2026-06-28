import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, getDoc, serverTimestamp, query, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------------- 狀態 ---------------- */
const DEFAULT_CATEGORIES = [
  "郵資","社會局方案","感恩聖仁方案","中心活動","中心活動-預支",
  "設施設備-社會局","設施設備-自籌","建築物養護-社會局","建築物養護-自籌",
  "志工津貼","生日禮金","水電費","每月固定支出-預支","拜拜","電信",
  "文具用品","台電","影印","日用品","膳食費","服務對象獎勵金",
  "水質檢測","印花","治療師公會費","日間照顧費用溢繳退費","其他"
];
let compareRanges = []; // 跨期比較用的自訂時間區間清單
let categories = DEFAULT_CATEGORIES.slice();
let expenses = [];      // 從 Firestore 即時同步
let allUsers = [];      // users 集合（僅 admin 會用到）
let currentUser = null; // { uid, email, name, role }
let editingId = null;
let lastRecorderName = '';
let showAllRecent = false;
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

  lastRecorderName = currentUser.name;
  $('f_recorder').value = lastRecorderName; = currentUser.role === 'admin';
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
  $('categoriesTabBtn').classList.toggle('hidden', !isStaffOrAdmin);
  $('importTabBtn').classList.toggle('hidden', !isStaffOrAdmin);
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
    renderCategoryManager();
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

/* ---------------- 類別下拉 / 核取方塊 / 管理 ---------------- */
function renderCategoryOptions(){
  $('f_category').innerHTML = categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  renderCategoryChecks('r_categoryChecks');
  renderCategoryChecks('cmp_categoryChecks');
  renderCategoryManager();
}
function renderCategoryChecks(containerId){
  const el = $(containerId);
  if(!el) return;
  const prevChecked = new Set(Array.from(el.querySelectorAll('input:checked')).map(i=>i.value));
  el.innerHTML = categories.map(c=>`
    <label class="cat-check"><input type="checkbox" value="${escapeHtml(c)}" ${prevChecked.has(c)?'checked':''}> ${escapeHtml(c)}</label>
  `).join("");
}
function getCheckedCats(containerId){
  return Array.from($(containerId).querySelectorAll('input:checked')).map(i=>i.value);
}
window.toggleAllChecks = function(containerId, state){
  $(containerId).querySelectorAll('input[type=checkbox]').forEach(i=>{ i.checked = state; });
};
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

function renderCategoryManager(){
  const el = $('categoriesManagerBody');
  if(!el) return;
  if($('catManagerCount')) $('catManagerCount').textContent = categories.length + ' 個類別';
  const usage = {};
  expenses.forEach(r=>{ usage[r.category] = (usage[r.category]||0) + 1; });
  el.innerHTML = categories.map(c=>`
    <tr>
      <td>${escapeHtml(c)}</td>
      <td class="amt">${usage[c]||0} 筆</td>
      <td class="actions-cell">
        <button class="btn btn-danger btn-sm" onclick="deleteCategory('${encodeURIComponent(c)}')">刪除</button>
      </td>
    </tr>`).join("");
}
$('addCatBtn2').addEventListener('click', async ()=>{
  const name = $('newCatInput').value.trim();
  if(!name){ showToast("請先輸入類別名稱"); return; }
  if(categories.includes(name)){ showToast("這個類別已經存在"); return; }
  categories.push(name);
  await setDoc(doc(db,'config','categories'), { list: categories });
  renderCategoryOptions();
  $('newCatInput').value = "";
  showToast("已新增類別「"+name+"」");
});
window.deleteCategory = async function(encoded){
  const name = decodeURIComponent(encoded);
  const inUse = expenses.some(r=>r.category === name);
  if(inUse && !confirm(`「${name}」已有支出紀錄使用此類別，刪除後舊紀錄仍會保留原類別名稱，但下拉選單將不再顯示此選項。確定要刪除嗎？`)) return;
  if(!inUse && !confirm(`確定要刪除類別「${name}」嗎？`)) return;
  categories = categories.filter(c=>c!==name);
  await setDoc(doc(db,'config','categories'), { list: categories });
  renderCategoryOptions();
  showToast("已刪除類別「"+name+"」");
};

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
    recorder: $('f_recorder').value.trim() || currentUser.name,
    recorderUid: currentUser.uid,
    note: $('f_note').value.trim(),
  };
  lastRecorderName = rec.recorder;
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
  $('f_recorder').value = lastRecorderName || currentUser.name;
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
          <button class="btn btn-amber btn-sm" onclick="setStatus('${r.id}','已退件')">退件</button>
          <button class="btn btn-ghost btn-sm" onclick="editDirectorNote('${r.id}')">${r.directorNote ? '編輯備註' : '＋審核備註'}</button>`;
}
function directorNoteDisplay(r){
  if(!r.directorNote) return '';
  return `<div class="note" style="margin-top:4px;">📝 ${escapeHtml(r.directorNote)}</div>`;
}
window.editDirectorNote = async function(id){
  const rec = expenses.find(x=>x.id===id);
  if(!rec) return;
  const note = prompt("請輸入審核備註（理事長/主任填寫，登打者也會看到）：", rec.directorNote || "");
  if(note === null) return; // 取消
  try{
    await updateDoc(doc(db,'expenses', id), {
      directorNote: note.trim(), statusBy: currentUser.name, statusAt: serverTimestamp()
    });
    showToast("已儲存審核備註");
  }catch(err){
    showToast("⚠ 儲存失敗：" + err.message);
  }
};
function editButtons(r){
  const canEdit = currentUser.role === 'staff' || currentUser.role === 'admin';
  if(!canEdit) return '';
  return `<button class="btn btn-ghost btn-sm" onclick="startEdit('${r.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteEntry('${r.id}')">刪除</button>`;
}

/* ---------------- 近期紀錄表 (Tab1) ---------------- */
function renderRecent(){
  const sorted = expenses.slice().sort((a,b)=> b.date.localeCompare(a.date));
  const recent = showAllRecent ? sorted : sorted.slice(0,15);
  $('recentCount').textContent = expenses.length + " 筆（共）";
  $('toggleRecentBtn').textContent = showAllRecent ? `只看最新 15 筆` : `顯示全部紀錄（共 ${expenses.length} 筆）`;
  $('recentEmpty').style.display = recent.length ? 'none':'block';
  $('recentBody').innerHTML = recent.map(r=>`
    <tr>
      <td>${r.date}</td>
      <td><span class="pill">${escapeHtml(r.category)}</span></td>
      <td>${escapeHtml(r.desc)}${directorNoteDisplay(r)}</td>
      <td class="amt">${fmtMoney(r.amount)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${escapeHtml(r.recorder||"")}</td>
      <td class="actions-cell">${editButtons(r)}${approveButtons(r)}</td>
    </tr>`).join("");
}

$('toggleRecentBtn').addEventListener('click', ()=>{
  showAllRecent = !showAllRecent;
  renderRecent();
});

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
  const cats = getCheckedCats('r_categoryChecks');
  const type = $('r_type').value;
  const status = $('r_status').value;
  return expenses.filter(r=>{
    if(start && r.date < start) return false;
    if(end && r.date > end) return false;
    if(cats.length && !cats.includes(r.category)) return false;
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
      <td>${escapeHtml(r.note||"")}${directorNoteDisplay(r)}</td>
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

/* ---------------- 類別跨期比較（可複選類別 + 可複選時間區間） ---------------- */
function addCompareRangeRow(prefill){
  const id = 'cr_' + Math.random().toString(36).slice(2,8);
  compareRanges.push({ id, label: prefill?.label || `區間${compareRanges.length+1}`, start: prefill?.start || '', end: prefill?.end || '' });
  renderCompareRangeRows();
}
function renderCompareRangeRows(){
  $('compareRangesBody').innerHTML = compareRanges.map(r=>`
    <tr>
      <td><input type="text" value="${escapeHtml(r.label)}" onchange="updateCompareRange('${r.id}','label',this.value)" style="min-width:90px;"></td>
      <td><input type="date" value="${r.start}" onchange="updateCompareRange('${r.id}','start',this.value)"></td>
      <td><input type="date" value="${r.end}" onchange="updateCompareRange('${r.id}','end',this.value)"></td>
      <td><button class="btn btn-danger btn-sm" onclick="removeCompareRange('${r.id}')">移除</button></td>
    </tr>`).join("") || `<tr><td colspan="4" class="empty">尚未新增比較區間，請點下方「＋新增比較區間」。</td></tr>`;
}
window.updateCompareRange = function(id, field, value){
  const r = compareRanges.find(x=>x.id===id);
  if(r) r[field] = value;
};
window.removeCompareRange = function(id){
  compareRanges = compareRanges.filter(x=>x.id!==id);
  renderCompareRangeRows();
};
$('addCompareRangeBtn').addEventListener('click', ()=>addCompareRangeRow());
$('cmpThisWeekBtn').addEventListener('click', ()=>{
  setQuickRange('thisWeek');
  addCompareRangeRow({ label:'本週', start: $('r_start').value, end: $('r_end').value });
});
$('cmpThisMonthBtn').addEventListener('click', ()=>{
  setQuickRange('thisMonth');
  addCompareRangeRow({ label:'本月', start: $('r_start').value, end: $('r_end').value });
});
$('cmpLastMonthBtn').addEventListener('click', ()=>{
  setQuickRange('lastMonth');
  addCompareRangeRow({ label:'上月', start: $('r_start').value, end: $('r_end').value });
});

let compareChart = null;
$('runCompareBtn').addEventListener('click', ()=>{
  const cats = getCheckedCats('cmp_categoryChecks');
  const ranges = compareRanges.filter(r=>r.start && r.end);
  if(!cats.length){ showToast("請至少勾選一個支出類別"); return; }
  if(!ranges.length){ showToast("請至少新增一個有效的時間區間（起訖日都要填）"); return; }

  // 表格：列=類別，欄=區間
  const table = cats.map(cat=>{
    const cells = ranges.map(r=>{
      const sum = expenses.filter(e=> e.category===cat && e.date>=r.start && e.date<=r.end).reduce((s,e)=>s+e.amount,0);
      return sum;
    });
    return { cat, cells, total: cells.reduce((a,b)=>a+b,0) };
  });

  let theadHtml = `<th>類別 ＼ 區間</th>` + ranges.map(r=>`<th class="amt">${escapeHtml(r.label)}<br><span class="note">${r.start}~${r.end}</span></th>`).join("") + `<th class="amt">合計</th>`;
  $('compareResultHead').innerHTML = `<tr>${theadHtml}</tr>`;
  $('compareResultBody').innerHTML = table.map(row=>`
    <tr>
      <td>${escapeHtml(row.cat)}</td>
      ${row.cells.map(v=>`<td class="amt">${fmtMoney(v)}</td>`).join("")}
      <td class="amt"><b>${fmtMoney(row.total)}</b></td>
    </tr>`).join("") +
    `<tr><td><b>合計</b></td>${ranges.map((_,i)=>`<td class="amt"><b>${fmtMoney(table.reduce((s,row)=>s+row.cells[i],0))}</b></td>`).join("")}<td class="amt"><b>${fmtMoney(table.reduce((s,row)=>s+row.total,0))}</b></td></tr>`;

  if(compareChart) compareChart.destroy();
  compareChart = new Chart($('compareChart'), {
    type:'bar',
    data:{
      labels: cats,
      datasets: ranges.map((r,i)=>({
        label: r.label,
        data: table.map(row=>row.cells[i]),
        backgroundColor: CHART_COLORS[i%CHART_COLORS.length],
        borderRadius:4
      }))
    },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ tooltip:{callbacks:{label:ctx=>ctx.dataset.label+'：'+fmtMoney(ctx.raw)}} },
      scales:{ y:{ ticks:{ callback:v=>'$'+v.toLocaleString() } } } }
  });
  $('compareResultWrap').classList.remove('hidden');
  showToast("已產生跨期比較");
});

/* ---------------- CSV 批量匯入 ---------------- */
let importParsedRows = [];
function parseCsvText(text){
  // 簡單 CSV 解析器，支援雙引號包住的欄位與欄位內逗號/換行
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      }else field += c;
    }else{
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field=''; }
      else if(c === '\n'){ row.push(field); rows.push(row); row=[]; field=''; }
      else if(c === '\r'){ /* skip */ }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=> r.some(c=>c && c.trim() !== ''));
}
function findCol(headers, keywords){
  for(let i=0;i<headers.length;i++){
    const h = (headers[i]||'').replace(/\s/g,'');
    if(keywords.some(k=>h.includes(k))) return i;
  }
  return -1;
}
$('importParseBtn').addEventListener('click', async ()=>{
  const file = $('importFile').files[0];
  if(!file){ showToast("請先選擇要匯入的 CSV 檔案"); return; }
  const rocYear = Number($('importRocYear').value) || 115;
  const gregYear = rocYear + 1911;
  const text = await file.text();
  const rows = parseCsvText(text);
  if(!rows.length){ showToast("檔案讀取失敗或沒有內容"); return; }

  const headers = rows[0];
  const idxMonth = findCol(headers, ['月']);
  const idxDay = findCol(headers, ['日']);
  const idxCat = findCol(headers, ['類別']);
  const idxDesc = findCol(headers, ['摘要']);
  const idxAmount = findCol(headers, ['金額']);
  const idxType = findCol(headers, ['實支','預支申請']);
  const idxNote = findCol(headers, ['備註']);
  const idxStatus = findCol(headers, ['核示','核可','主管']);

  if(idxMonth<0 || idxDay<0 || idxCat<0 || idxAmount<0){
    showToast("⚠ 找不到「月」「日」「支出類別」「支出金額」其中欄位，請確認 CSV 表頭與範例一致");
    return;
  }

  importParsedRows = [];
  for(let r=1; r<rows.length; r++){
    const row = rows[r];
    const monthStr = (row[idxMonth]||'').trim();
    const dayStr = (row[idxDay]||'').trim();
    const cat = (row[idxCat]||'').trim();
    const desc = (row[idxDesc]||'').trim();
    let amountStr = (row[idxAmount]||'').trim();
    if(!monthStr || !dayStr || !cat) continue;
    if(desc === '小計' || cat === '小計') continue;
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    if(!month || !day) continue;
    amountStr = amountStr.replace(/[^\d.]/g, '');
    const amount = parseFloat(amountStr);
    if(!amount || isNaN(amount)) continue;
    const typeRaw = idxType>=0 ? (row[idxType]||'') : '';
    const type = typeRaw.includes('預支') ? '預支' : '實支';
    const statusRaw = idxStatus>=0 ? (row[idxStatus]||'').trim() : '';
    let status = '待核';
    if(statusRaw){ status = statusRaw.includes('退') ? '已退件' : '已核可'; }
    const date = `${gregYear}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    importParsedRows.push({
      date, category: cat, desc: desc || '(無摘要)', amount,
      type, status, note: idxNote>=0 ? (row[idxNote]||'').trim() : '',
      recorder: currentUser.name, recorderUid: currentUser.uid
    });
  }

  $('importPreviewCount').textContent = importParsedRows.length + " 筆可匯入";
  $('importPreviewBody').innerHTML = importParsedRows.slice(0,8).map(r=>`
    <tr><td>${r.date}</td><td>${escapeHtml(r.category)}</td><td>${escapeHtml(r.desc)}</td><td class="amt">${fmtMoney(r.amount)}</td><td>${r.type}</td><td>${r.status}</td></tr>
  `).join("") || `<tr><td colspan="6" class="empty">沒有解析出任何可匯入的資料列</td></tr>`;
  $('importPreviewWrap').classList.remove('hidden');
  $('importConfirmBtn').disabled = importParsedRows.length === 0;
  showToast(`已解析 ${importParsedRows.length} 筆，請確認預覽後按下「確認匯入」`);
});

$('importConfirmBtn').addEventListener('click', async ()=>{
  if(!importParsedRows.length){ showToast("沒有可匯入的資料"); return; }
  if(!confirm(`即將寫入 ${importParsedRows.length} 筆支出紀錄到資料庫，此動作無法一次性撤銷（需逐筆刪除），確定要匯入嗎？`)) return;
  $('importConfirmBtn').disabled = true;
  try{
    const newCats = importParsedRows.map(r=>r.category).filter(c=>!categories.includes(c));
    if(newCats.length){
      categories = categories.concat([...new Set(newCats)]);
      await setDoc(doc(db,'config','categories'), { list: categories });
      renderCategoryOptions();
    }
    let i = 0;
    while(i < importParsedRows.length){
      const batch = writeBatch(db);
      const chunk = importParsedRows.slice(i, i+400);
      chunk.forEach(r=>{
        const ref = doc(collection(db,'expenses'));
        batch.set(ref, { ...r, note: (r.note ? r.note + ' ' : '') + '（批量匯入）', createdAt: serverTimestamp() });
      });
      await batch.commit();
      i += 400;
    }
    showToast(`匯入完成，共新增 ${importParsedRows.length} 筆紀錄`);
    importParsedRows = [];
    $('importPreviewWrap').classList.add('hidden');
    $('importFile').value = '';
  }catch(err){
    showToast("⚠ 匯入失敗：" + err.message);
  }finally{
    $('importConfirmBtn').disabled = false;
  }
});

/* ---------------- 初始化 ---------------- */
$('rocToday').textContent = `今日：${rocFromISO(todayISO())}（西元 ${todayISO()}）`;
$('f_date').value = todayISO();
