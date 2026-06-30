import { firebaseConfig } from './firebase-config.js';
import { emailjsConfig } from './emailjs-config.js';

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, getDoc, serverTimestamp, query, orderBy, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const emailEnabled = !!(emailjsConfig.publicKey && emailjsConfig.serviceId);
if(emailEnabled && window.emailjs){
  try{ window.emailjs.init({ publicKey: emailjsConfig.publicKey }); }catch(e){ console.warn('EmailJS 初始化失敗', e); }
}

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
let expenses = [];      // 從 Firestore 即時同步（不含已軟刪除）
let trashedExpenses = []; // 垃圾桶（軟刪除的紀錄）
let allUsers = [];      // users 集合（僅 admin 會用到）
let currentUser = null; // { uid, email, name, role }
let editingId = null;
let lastRecorderName = '';
let showAllRecent = false;
let trendDrillSnapshot = null;
let catChart = null, trendChart = null;
let unsubExpenses = null, unsubUsers = null;
let highlightRecordId = null;  // 剛新增的那一筆，用來在列表閃一下＋自動捲動過去
let highlightTimer = null;

const ROLE_LABEL = { staff:"登打者", director:"理事長", admin:"主任", pending:"待設定" };
const CHART_COLORS = ["#2c6e64","#c98a2c","#6a8caf","#b14e4e","#7a9b5c","#a17fb5","#cf9b5c","#4a8b8b","#8d6a4f","#5c7fa8","#a85c7f","#7f8d4f","#967fa8"];
// 正式網址（Email通知連結固定用這個，不要用 location.href，避免在分頁/子路徑下產生錯誤連結）
const SITE_URL = "https://renotzeng300-lang.github.io/datong-expense/";

/* ---------------- 工具 ---------------- */
function fmtLocalDate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayISO(){ return fmtLocalDate(new Date()); }
function rocFromISO(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-").map(Number);
  return `民國${y-1911}年${m}月${d}日`;
}
function fmtMoney(n){ return "NT$" + Math.round(n||0).toLocaleString("zh-TW"); }
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toMillis(ts){
  if(!ts) return 0;
  if(typeof ts.toMillis === 'function') return ts.toMillis();
  if(typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
}
function matchesKeyword(r, keyword){
  if(!keyword) return true;
  const kw = keyword.trim().toLowerCase();
  if(!kw) return true;
  const haystack = [
    r.date, r.category, r.desc, r.note, r.recorder, r.type,
    r.status || '待核', r.amount != null ? String(r.amount) : '',
    rocFromISO(r.date)
  ].join(' ').toLowerCase();
  return haystack.includes(kw);
}
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), 2300);
}
function $(id){ return document.getElementById(id); }

/* ---------------- Email 通知 ---------------- */
async function getNotifyAdminEmails(){
  try{
    const snap = await getDoc(doc(db,'config','notifyEmails'));
    if(snap.exists() && Array.isArray(snap.data().adminEmails)) return snap.data().adminEmails.filter(Boolean);
  }catch(e){ /* 沒設定過也沒關係 */ }
  return [];
}
async function getUserEmailByUid(uid){
  if(!uid) return null;
  try{
    const snap = await getDoc(doc(db,'users', uid));
    if(snap.exists()) return snap.data().email || null;
  }catch(e){ /* 沒有讀取權限或查無資料，安靜失敗 */ }
  return null;
}
async function sendNotifyEmail(templateId, params){
  if(!emailEnabled || !window.emailjs || !templateId) return;
  try{
    await window.emailjs.send(emailjsConfig.serviceId, templateId, params);
  }catch(err){
    console.warn('Email 通知寄送失敗：', err);
  }
}
async function notifyAdminsNewEntry(rec){
  if(!emailEnabled) return;
  const emails = await getNotifyAdminEmails();
  for(const email of emails){
    await sendNotifyEmail(emailjsConfig.templateNewEntry, {
      to_email: email,
      recorder_name: rec.recorder || '',
      date: rec.date,
      category: rec.category,
      amount: fmtMoney(rec.amount),
      type: rec.type,
      desc: rec.desc,
      note: rec.note || '（無）',
      link: SITE_URL,
      view_hint: '請登入後點選「統計分析」分頁查看明細並進行核可／退件'
    });
  }
}
async function notifyRecorderReview(rec, statusText, noteText){
  if(!emailEnabled) return;
  if(!rec.recorderUid || rec.recorderUid === currentUser.uid) return; // 沒有登打人資料，或審核者就是登打人本人，不需通知
  const email = await getUserEmailByUid(rec.recorderUid);
  if(!email) return;
  await sendNotifyEmail(emailjsConfig.templateReview, {
    to_email: email,
    recorder_name: rec.recorder || '',
    date: rec.date,
    category: rec.category,
    amount: fmtMoney(rec.amount),
    desc: rec.desc,
    status: statusText || '（僅留言，未變更核示狀態）',
    note: noteText || '（無留言）',
    reviewer_name: currentUser.name,
    reviewer_role: ROLE_LABEL[currentUser.role] || '',
    link: SITE_URL,
    view_hint: '請登入後點選「每日登打」分頁查看完整紀錄'
  });
}

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
  currentUser = { uid: user.uid, email: user.email, name: data.name || user.email, role: data.role || 'pending', onboardedRoles: data.onboardedRoles || {} };

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

  if(!currentUser.onboardedRoles[currentUser.role]){
    setTimeout(()=>openOnboarding(currentUser.role), 500);
  }
});

function getPendingCount(){
  return expenses.filter(r => !r.status || r.status === '待核').length;
}
function updatePendingReviewUI(){
  const canApprove = currentUser && (currentUser.role === 'director' || currentUser.role === 'admin');
  const banner = $('pendingReviewBanner');
  const entryBadge = $('entryTabBadge');
  const analysisBadge = $('analysisTabBadge');
  if(!canApprove){
    banner.classList.add('hidden');
    entryBadge.classList.add('hidden');
    analysisBadge.classList.add('hidden');
    return;
  }
  const n = getPendingCount();
  banner.classList.toggle('hidden', n === 0);
  $('pendingReviewCount').textContent = n;
  // 理事長看不到「每日登打」分頁，角標只給能看到該分頁的人
  const entryTabVisible = !document.querySelector('[data-tab="entry"]').classList.contains('hidden');
  entryBadge.classList.toggle('hidden', n === 0 || !entryTabVisible);
  entryBadge.textContent = n;
  analysisBadge.classList.toggle('hidden', n === 0);
  analysisBadge.textContent = n;
}
$('pendingReviewBtn').addEventListener('click', ()=>{
  $('r_start').value = '';
  $('r_end').value = '';
  $('r_type').value = '';
  $('r_status').value = '待核';
  $('r_search').value = '';
  document.querySelectorAll('#quickRange button').forEach(b=>b.classList.remove('active'));
  toggleAllChecks('r_categoryChecks', false);
  trendDrillSnapshot = null;
  $('trendBackBtn').classList.add('hidden');
  switchTab('analysis');
  showToast(`已篩選出 ${getPendingCount()} 筆待審核紀錄`);
  setTimeout(()=>{
    $('detailTable').closest('.card')?.scrollIntoView({behavior:'smooth', block:'start'});
  }, 80);
});

function applyRoleUI(){
  $('userName').textContent = currentUser.name + "（" + currentUser.email + "）";
  const badge = $('userRoleBadge');
  badge.textContent = ROLE_LABEL[currentUser.role] || currentUser.role;
  badge.className = 'role-badge role-' + (currentUser.role === 'admin' ? 'admin' : currentUser.role === 'director' ? 'director' : 'staff');

  lastRecorderName = currentUser.name;
  $('f_recorder').value = lastRecorderName;

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
  $('categoriesTabBtn').classList.toggle('hidden', !isStaffOrAdmin);
  $('importTabBtn').classList.toggle('hidden', !isStaffOrAdmin);
  $('trashTabBtn').classList.toggle('hidden', !isStaffOrAdmin);

  updatePendingReviewUI();
  renderTrash();
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
    const all = snap.docs.map(d=>({ id: d.id, ...d.data() }));
    expenses = all.filter(r => !r.deletedAt);
    trashedExpenses = all.filter(r => r.deletedAt);
    renderRecent();
    renderCategoryOptions();
    renderTrash();
    updatePendingReviewUI();
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
    getDoc(doc(db,'config','notifyEmails')).then(snap=>{
      if(snap.exists() && Array.isArray(snap.data().adminEmails)){
        $('notifyAdminEmailsInput').value = snap.data().adminEmails.join(', ');
      }
    }).catch(()=>{});
  }
}

/* ---------------- 類別下拉 / 核取方塊 / 管理 ---------------- */
function getCategoryUsageCounts(){
  const usage = {};
  expenses.forEach(r=>{ usage[r.category] = (usage[r.category]||0) + 1; });
  return usage;
}
function renderCategoryOptions(){
  const prevValue = $('f_category').value;
  const usage = getCategoryUsageCounts();
  const base = categories.filter(c => c !== '其他');
  const used = base.filter(c => usage[c]).sort((a,b)=> (usage[b]||0) - (usage[a]||0));
  const top = used.slice(0, 8);
  const topSet = new Set(top);
  const rest = base.filter(c => !topSet.has(c));
  const hasOther = categories.includes('其他');

  let html = '';
  if(top.length){
    html += `<optgroup label="常用類別">` + top.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') + `</optgroup>`;
    html += `<optgroup label="其他類別">` + rest.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') + `</optgroup>`;
  }else{
    html += rest.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }
  if(hasOther) html += `<option value="其他">其他</option>`;
  $('f_category').innerHTML = html;
  if(categories.includes(prevValue)) $('f_category').value = prevValue;

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

const TRASH_RETENTION_DAYS = 30;
const purgeAttempted = new Set(); // 避免同一筆重複觸發永久刪除
function renderTrash(){
  const canSeeTrash = currentUser && (currentUser.role === 'staff' || currentUser.role === 'admin');
  const badge = $('trashTabBadge');
  if(!canSeeTrash){
    if(badge) badge.classList.add('hidden');
    return;
  }
  const n = trashedExpenses.length;
  if(badge){
    badge.classList.toggle('hidden', n === 0);
    badge.textContent = n;
  }
  // 超過保留天數的紀錄，自動永久清除（盡力而為，僅在有人開啟本系統時觸發）
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  trashedExpenses.forEach(r=>{
    const delAt = toMillis(r.deletedAt);
    if(delAt && delAt < cutoff && !purgeAttempted.has(r.id)){
      purgeAttempted.add(r.id);
      deleteDoc(doc(db,'expenses', r.id)).catch(()=>{});
    }
  });
  const el = $('trashBody');
  if(!el) return;
  $('trashCount').textContent = n ? `共 ${n} 筆` : '';
  $('trashEmpty').style.display = n ? 'none' : 'block';
  const sorted = trashedExpenses.slice().sort((a,b)=> toMillis(b.deletedAt) - toMillis(a.deletedAt));
  el.innerHTML = sorted.map(r=>{
    const delAt = toMillis(r.deletedAt);
    const daysLeft = delAt ? Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now()-delAt)/86400000)) : null;
    const expiryHint = daysLeft !== null ? `<div class="note" style="margin-top:2px;">${daysLeft>0 ? `${daysLeft} 天後自動清除` : '即將自動清除'}</div>` : '';
    return `
    <tr>
      <td>${r.date}</td>
      <td><span class="pill">${escapeHtml(r.category)}</span></td>
      <td>${escapeHtml(r.desc)}${expiryHint}</td>
      <td class="amt">${fmtMoney(r.amount)}</td>
      <td>${escapeHtml(r.deletedBy||"")}</td>
      <td class="actions-cell">
        <div class="action-row">
          <button class="btn btn-primary btn-sm" onclick="restoreEntry('${r.id}')">復原</button>
          <button class="btn btn-danger btn-sm" onclick="permanentlyDeleteEntry('${r.id}')">永久刪除</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}
$('emptyTrashBtn').addEventListener('click', ()=>emptyTrash());

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
    if(!custom){
      showToast("⚠ 請填寫自訂類別名稱");
      $('f_customCat').focus();
      return;
    }
    category = custom;
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
      const docRef = await addDoc(collection(db,'expenses'), { ...rec, status:'待核', createdAt: serverTimestamp() });
      showToast("已新增一筆支出紀錄，請於下方列表確認內容無誤");
      highlightRecordId = docRef.id;
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(()=>{ highlightRecordId = null; renderRecent(); }, 5000);
      if(currentUser.role === 'staff') notifyAdminsNewEntry(rec);
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
  if(!confirm("確定要刪除這筆支出紀錄嗎？\n刪除後會移到垃圾桶，30天內隨時可以復原。")) return;
  try{
    await updateDoc(doc(db,'expenses', id), {
      deletedAt: serverTimestamp(),
      deletedBy: currentUser.name,
      deletedByUid: currentUser.uid
    });
    showToast("已移至垃圾桶，30天內可復原");
  }catch(err){
    showToast("⚠ 刪除失敗：" + err.message);
  }
};
window.restoreEntry = async function(id){
  try{
    await updateDoc(doc(db,'expenses', id), {
      deletedAt: null, deletedBy: null, deletedByUid: null
    });
    showToast("已復原該筆紀錄");
  }catch(err){
    showToast("⚠ 復原失敗：" + err.message);
  }
};
window.permanentlyDeleteEntry = async function(id){
  const rec = trashedExpenses.find(x=>x.id===id);
  const label = rec ? `${rec.date}「${rec.desc}」` : '這筆紀錄';
  if(!confirm(`確定要永久刪除${label}嗎？\n此操作無法復原，請特別小心。`)) return;
  try{
    await deleteDoc(doc(db,'expenses', id));
    showToast("已永久刪除");
  }catch(err){
    showToast("⚠ 刪除失敗：" + err.message);
  }
};
window.emptyTrash = async function(){
  if(!trashedExpenses.length){ showToast("垃圾桶目前是空的"); return; }
  if(!confirm(`垃圾桶內共有 ${trashedExpenses.length} 筆紀錄，確定要全部永久刪除嗎？\n此操作無法復原，請特別小心。`)) return;
  try{
    for(const r of trashedExpenses){
      await deleteDoc(doc(db,'expenses', r.id));
    }
    showToast("垃圾桶已清空");
  }catch(err){
    showToast("⚠ 清空失敗：" + err.message);
  }
};

window.setStatus = async function(id, status){
  const rec = expenses.find(x=>x.id===id);
  try{
    await updateDoc(doc(db,'expenses', id), {
      status, statusBy: currentUser.name, statusAt: serverTimestamp()
    });
    showToast(status === '已核可' ? "已核可" : "已退件");
    if(rec) notifyRecorderReview(rec, status, null);
  }catch(err){
    showToast("⚠ 操作失敗：" + err.message);
  }
};

function statusBadge(status){
  if(status==="已核可") return `<span class="badge badge-approved">✓ 已核可</span>`;
  if(status==="已退件") return `<span class="badge badge-rejected">✕ 已退件</span>`;
  return `<span class="badge badge-pending">⏳ 待核</span>`;
}
function approveButtons(r){
  const canApprove = currentUser.role === 'director' || currentUser.role === 'admin';
  if(!canApprove) return '';
  return `<div class="action-row">
            <button class="btn btn-ghost btn-sm" onclick="setStatus('${r.id}','已核可')">核可</button>
            <button class="btn btn-amber btn-sm" onclick="setStatus('${r.id}','已退件')">退件</button>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="addDirectorNote('${r.id}')">＋審核備註</button>`;
}
function fmtNoteTime(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function directorNoteDisplay(r){
  let notes = Array.isArray(r.directorNotes) ? r.directorNotes.slice() : [];
  // 相容舊版單筆備註資料（升級前寫入的紀錄）
  if(r.directorNote && !notes.some(n=>n.text===r.directorNote)){
    notes.push({ by: r.directorNoteBy, role: r.directorNoteRole, text: r.directorNote, at: null });
  }
  if(!notes.length) return '';
  notes.sort((a,b)=>(a.at||0)-(b.at||0));
  return notes.map(n=>{
    const roleLabel = ROLE_LABEL[n.role] || '';
    const who = n.by ? `${roleLabel}${roleLabel?' ':''}${n.by}` : roleLabel;
    const timeTxt = fmtNoteTime(n.at);
    return `<div class="director-note">📝 <b>審核備註${who?`（${escapeHtml(who)}）`:''}</b>${timeTxt?` <span style="opacity:.75;">· ${timeTxt}</span>`:''}<br>${escapeHtml(n.text)}</div>`;
  }).join('');
}
window.addDirectorNote = async function(id){
  const rec = expenses.find(x=>x.id===id);
  if(!rec) return;
  const note = prompt("請輸入審核備註（會新增一筆，不會覆蓋之前的留言）：", "");
  if(note === null || !note.trim()) return; // 取消或空白不送出
  try{
    await updateDoc(doc(db,'expenses', id), {
      directorNotes: arrayUnion({
        by: currentUser.name, role: currentUser.role, text: note.trim(), at: Date.now()
      }),
      statusBy: currentUser.name, statusAt: serverTimestamp()
    });
    showToast("已新增審核備註");
    notifyRecorderReview(rec, null, note.trim());
  }catch(err){
    showToast("⚠ 儲存失敗：" + err.message);
  }
};
function editButtons(r){
  const canEdit = currentUser.role === 'staff' || currentUser.role === 'admin';
  if(!canEdit) return '';
  return `<div class="action-row">
            <button class="btn btn-ghost btn-sm" onclick="startEdit('${r.id}')">編輯</button>
            <button class="btn btn-danger btn-sm" onclick="deleteEntry('${r.id}')">刪除</button>
          </div>`;
}

/* ---------------- 近期紀錄表 (Tab1) ---------------- */
function renderRecent(){
  const start = $('rec_start').value;
  const end = $('rec_end').value;
  const keyword = $('rec_search').value;
  let filtered = expenses.slice();
  if(start) filtered = filtered.filter(r=>r.date >= start);
  if(end) filtered = filtered.filter(r=>r.date <= end);
  if(keyword.trim()) filtered = filtered.filter(r=>matchesKeyword(r, keyword));
  const sorted = filtered.sort((a,b)=> b.date.localeCompare(a.date) || (toMillis(b.createdAt) - toMillis(a.createdAt)));
  const recent = showAllRecent ? sorted : sorted.slice(0,15);
  const isFiltered = start || end || keyword.trim();
  $('recentCount').textContent = isFiltered ? `${sorted.length} 筆（篩選結果，共 ${expenses.length} 筆）` : `${expenses.length} 筆（共）`;
  $('toggleRecentBtn').textContent = showAllRecent ? `只看最新 15 筆` : `顯示全部（共 ${sorted.length} 筆）`;
  $('recentEmpty').style.display = recent.length ? 'none':'block';
  $('recentEmpty').textContent = keyword.trim() ? '查無符合關鍵字的紀錄。' : '尚無登打紀錄。';
  $('recentBody').innerHTML = recent.map(r=>`
    <tr data-id="${r.id}" class="${r.id===highlightRecordId?'just-added':''}">
      <td>${r.date}</td>
      <td><span class="pill">${escapeHtml(r.category)}</span></td>
      <td>${escapeHtml(r.desc)}${directorNoteDisplay(r)}</td>
      <td class="amt">${fmtMoney(r.amount)}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${escapeHtml(r.recorder||"")}</td>
      <td class="actions-cell">${editButtons(r)}${approveButtons(r)}</td>
    </tr>`).join("");
  if(highlightRecordId){
    const row = $('recentBody').querySelector(`tr[data-id="${highlightRecordId}"]`);
    if(row) row.scrollIntoView({behavior:'smooth', block:'center'});
  }
}

$('toggleRecentBtn').addEventListener('click', ()=>{
  showAllRecent = !showAllRecent;
  renderRecent();
});
$('recFilterBtn').addEventListener('click', ()=>{ showAllRecent = true; renderRecent(); });
$('recClearBtn').addEventListener('click', ()=>{
  $('rec_start').value = ''; $('rec_end').value = ''; $('rec_search').value = '';
  showAllRecent = false;
  renderRecent();
});
$('rec_search').addEventListener('input', ()=>{
  showAllRecent = $('rec_search').value.trim().length > 0;
  renderRecent();
});

/* ---------------- 區間篩選 (Tab2) ---------------- */
function setQuickRange(kind){
  const today = new Date();
  let start, end;
  const fmt = d => fmtLocalDate(d);
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
    trendDrillSnapshot = null;
    $('trendBackBtn').classList.add('hidden');
    runAnalysis();
  });
});
$('applyFilterBtn').addEventListener('click', ()=>{
  document.querySelectorAll('#quickRange button').forEach(b=>b.classList.remove('active'));
  trendDrillSnapshot = null;
  $('trendBackBtn').classList.add('hidden');
  runAnalysis();
});
$('clearAllFilterBtn').addEventListener('click', ()=>{
  $('r_start').value = '';
  $('r_end').value = '';
  $('r_type').value = '';
  $('r_status').value = '';
  $('r_search').value = '';
  toggleAllChecks('r_categoryChecks', false);
  document.querySelectorAll('#quickRange button').forEach(b=>b.classList.remove('active'));
  document.querySelector('#quickRange [data-range="all"]').classList.add('active');
  trendDrillSnapshot = null;
  $('trendBackBtn').classList.add('hidden');
  runAnalysis();
  showToast("已清除全部篩選條件");
});
let searchDebounceTimer = null;
$('r_search').addEventListener('input', ()=>{
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(()=>{
    if($('panel-analysis').classList.contains('active')) runAnalysis();
  }, 350);
});
$('trendBackBtn').addEventListener('click', ()=>{
  if(trendDrillSnapshot){
    $('r_start').value = trendDrillSnapshot.start;
    $('r_end').value = trendDrillSnapshot.end;
  }
  trendDrillSnapshot = null;
  $('trendBackBtn').classList.add('hidden');
  runAnalysis();
  showToast("已返回上一個篩選範圍");
});

function getFiltered(){
  const start = $('r_start').value;
  const end = $('r_end').value;
  const cats = getCheckedCats('r_categoryChecks');
  const type = $('r_type').value;
  const status = $('r_status').value;
  const keyword = $('r_search').value;
  return expenses.filter(r=>{
    if(start && r.date < start) return false;
    if(end && r.date > end) return false;
    if(cats.length && !cats.includes(r.category)) return false;
    if(type && r.type !== type) return false;
    if(status && (r.status||'待核') !== status) return false;
    if(keyword.trim() && !matchesKeyword(r, keyword)) return false;
    return true;
  }).sort((a,b)=> a.date.localeCompare(b.date));
}
function dayDiff(a,b){ return Math.round((new Date(b) - new Date(a)) / 86400000) + 1; }
function dayBucket(dateStr){ return { key:dateStr, label:dateStr, start:dateStr, end:dateStr }; }
function weekBucket(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  const dow = (d.getDay()+6)%7;
  const monday = new Date(d); monday.setDate(d.getDate()-dow);
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  const start = fmtLocalDate(monday), end = fmtLocalDate(sunday);
  const label = `${monday.getMonth()+1}/${monday.getDate()}~${sunday.getMonth()+1}/${sunday.getDate()}`;
  return { key:start, label, start, end };
}
function monthBucket(dateStr){
  const [y,m] = dateStr.split("-");
  const start = `${y}-${m}-01`;
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const end = `${y}-${m}-${String(lastDay).padStart(2,'0')}`;
  return { key:`${y}-${m}`, label:`${y}/${m}`, start, end };
}

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
  try{
    catChart = new Chart($('catChart'), {
      type: 'doughnut',
      data: { labels: catEntries.map(e=>e[0]), datasets: [{ data: catEntries.map(e=>e[1].amount), backgroundColor: catEntries.map((_,i)=>CHART_COLORS[i%CHART_COLORS.length]), borderWidth:2, borderColor:'#fff' }] },
      options: { responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position: window.innerWidth < 640 ? 'bottom' : 'right', labels:{ boxWidth:12, font:{size:11} } }, tooltip:{callbacks:{label:ctx=>ctx.label+'：'+fmtMoney(ctx.raw)+'（'+(total?(ctx.raw/total*100).toFixed(1):'0.0')+'%）'}} } }
    });
  }catch(err){
    $('catChart').closest('.chart-box').innerHTML = '<p class="empty">圖表載入失敗，但下方表格資料完整無誤。</p>';
  }

  let bucketFn, unitLabel;
  if(days <= 16){ bucketFn = dayBucket; unitLabel = "依日（點擊長條可篩選當天）"; }
  else if(days <= 130){ bucketFn = weekBucket; unitLabel = "依週（點擊長條可篩選該週）"; }
  else { bucketFn = monthBucket; unitLabel = "依月（點擊長條可篩選該月）"; }
  $('trendUnit').textContent = unitLabel;

  const trendMap = {};
  rows.forEach(r=>{
    const b = bucketFn(r.date);
    if(!trendMap[b.key]) trendMap[b.key] = { ...b, amount: 0 };
    trendMap[b.key].amount += r.amount;
  });
  const trendBuckets = Object.values(trendMap).sort((a,b)=> a.start.localeCompare(b.start));

  if(trendChart) trendChart.destroy();
  try{
    $('trendChart').style.cursor = 'pointer';
    trendChart = new Chart($('trendChart'), {
      type:'bar',
      data:{ labels: trendBuckets.map(b=>b.label), datasets:[{ label:'支出金額', data: trendBuckets.map(b=>b.amount), backgroundColor:'#2c6e64', borderRadius:4 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{callbacks:{label:ctx=>fmtMoney(ctx.raw)+'（點擊可篩選此區間）'}} },
        scales:{ y:{ ticks:{ callback:v=>'$'+v.toLocaleString() } } },
        onClick: (evt, elements) => {
          if(!elements.length) return;
          const b = trendBuckets[elements[0].index];
          if(!b) return;
          trendDrillSnapshot = { start: $('r_start').value, end: $('r_end').value };
          $('r_start').value = b.start;
          $('r_end').value = b.end;
          document.querySelectorAll('#quickRange button').forEach(btn=>btn.classList.remove('active'));
          runAnalysis();
          $('trendBackBtn').classList.remove('hidden');
          showToast(`已篩選區間：${b.label}（${b.start}~${b.end}）`);
          $('catChart').closest('.card')?.scrollIntoView({behavior:'smooth', block:'start'});
        }
      }
    });
  }catch(err){
    $('trendChart').closest('.chart-box').innerHTML = '<p class="empty">圖表載入失敗，請稍後重新整理頁面再試。</p>';
  }

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
$('saveNotifyEmailsBtn').addEventListener('click', async ()=>{
  const emails = $('notifyAdminEmailsInput').value.split(',').map(s=>s.trim()).filter(Boolean);
  try{
    await setDoc(doc(db,'config','notifyEmails'), { adminEmails: emails });
    showToast("已儲存通知信箱");
  }catch(err){
    showToast("⚠ 儲存失敗：" + err.message);
  }
});

$('createUserBtn').addEventListener('click', async ()=>{
  const name = $('newUserName').value.trim();
  const email = $('newUserEmail').value.trim();
  const password = $('newUserPassword').value;
  const role = $('newUserRole').value;
  if(!name || !email || !password){ showToast("請填寫姓名、Email 與密碼"); return; }
  if(password.length < 6){ showToast("密碼至少需要 6 個字元"); return; }

  $('createUserBtn').disabled = true;
  let secondaryApp = null;
  try{
    // 用「次要 App 實例」建立新帳號，避免影響目前主任自己的登入狀態
    secondaryApp = initializeApp(firebaseConfig, 'Secondary-' + Date.now());
    const secondaryAuth = getAuth(secondaryApp);
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const newUid = cred.user.uid;
    await signOut(secondaryAuth);

    await setDoc(doc(db,'users', newUid), {
      email, name, role, createdAt: serverTimestamp()
    });

    showToast(`已建立使用者「${name}」，請告知對方帳密登入`);
    $('newUserName').value = ''; $('newUserEmail').value=''; $('newUserPassword').value='';
  }catch(err){
    let msg = err.message;
    if(err.code === 'auth/email-already-in-use') msg = '這個 Email 已經有帳號了';
    else if(err.code === 'auth/invalid-email') msg = 'Email 格式不正確';
    else if(err.code === 'auth/weak-password') msg = '密碼太簡單，至少需要 6 個字元';
    showToast("⚠ 建立失敗：" + msg);
  }finally{
    if(secondaryApp){ try{ await deleteApp(secondaryApp); }catch(e){} }
    $('createUserBtn').disabled = false;
  }
});

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

  // 表格：列=類別，欄=各區間金額 + 區間之間的差異
  const table = cats.map(cat=>{
    const cells = ranges.map(r=>{
      const sum = expenses.filter(e=> e.category===cat && e.date>=r.start && e.date<=r.end).reduce((s,e)=>s+e.amount,0);
      return sum;
    });
    const diffs = [];
    for(let i=1;i<cells.length;i++) diffs.push(cells[i] - cells[i-1]);
    return { cat, cells, diffs };
  });

  function fmtDiff(diff){
    const abs = Math.abs(Math.round(diff));
    const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
    return sign + 'NT$' + abs.toLocaleString('zh-TW');
  }
  function diffCellHtml(diff, base){
    const pct = base !== 0 ? (diff/base*100) : (diff!==0 ? null : 0);
    const color = diff > 0 ? 'var(--rose)' : diff < 0 ? 'var(--teal-deep)' : 'var(--ink-soft)';
    const pctTxt = pct === null ? '（新增）' : `（${diff>0?'+':''}${pct.toFixed(1)}%）`;
    return `<td class="amt" style="color:${color};font-weight:600;">${fmtDiff(diff)}<br><span class="note">${pctTxt}</span></td>`;
  }

  let theadHtml = `<th>類別 ＼ 區間</th>` + ranges.map(r=>`<th class="amt">${escapeHtml(r.label)}<br><span class="note">${r.start}~${r.end}</span></th>`).join("");
  for(let i=1;i<ranges.length;i++){
    theadHtml += `<th class="amt">差異<br><span class="note">${escapeHtml(ranges[i].label)} − ${escapeHtml(ranges[i-1].label)}</span></th>`;
  }
  $('compareResultHead').innerHTML = `<tr>${theadHtml}</tr>`;
  $('compareResultBody').innerHTML = table.map(row=>`
    <tr>
      <td>${escapeHtml(row.cat)}</td>
      ${row.cells.map(v=>`<td class="amt">${fmtMoney(v)}</td>`).join("")}
      ${row.diffs.map((d,i)=>diffCellHtml(d, row.cells[i])).join("")}
    </tr>`).join("") +
    (()=>{
      const colTotals = ranges.map((_,i)=>table.reduce((s,row)=>s+row.cells[i],0));
      const colDiffs = [];
      for(let i=1;i<colTotals.length;i++) colDiffs.push(colTotals[i]-colTotals[i-1]);
      return `<tr><td><b>各區間合計</b></td>${colTotals.map(v=>`<td class="amt"><b>${fmtMoney(v)}</b></td>`).join("")}${colDiffs.map((d,i)=>diffCellHtml(d, colTotals[i])).join("")}</tr>`;
    })();

  if(compareChart) compareChart.destroy();
  $('compareResultWrap').classList.remove('hidden');
  try{
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
  }catch(err){
    $('compareChart').closest('.chart-box').innerHTML = '<p class="empty">圖表載入失敗，但下方比較表格資料完整無誤。</p>';
  }
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

/* ================= 新手導覽 ================= */
const ESC = s => (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function svgWrap(tabs, activeIdx, body){
  const tabW = 516 / tabs.length;
  let tabsHtml = '';
  tabs.forEach((label,i)=>{
    const x = 2 + i*tabW;
    const active = i===activeIdx;
    tabsHtml += `<rect x="${x+2}" y="34" width="${tabW-4}" height="24" rx="5" fill="${active?'#e3eee9':'#ffffff'}" stroke="${active?'#2c6e64':'#dde3dc'}" stroke-width="1.4"/>
      <text x="${x+tabW/2}" y="50" text-anchor="middle" font-size="10.5" font-weight="${active?'700':'500'}" fill="${active?'#1d4f48':'#8a948f'}" font-family="sans-serif">${ESC(label)}</text>`;
  });
  return `<svg viewBox="0 0 520 300" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="520" height="300" rx="10" fill="#f4f6f3"/>
    <rect x="0" y="0" width="520" height="30" rx="10" fill="#1d4f48"/>
    <rect x="0" y="14" width="520" height="16" fill="#1d4f48"/>
    <circle cx="18" cy="15" r="7" fill="#ffffff" opacity="0.3"/>
    <text x="32" y="19" fill="#fff" font-size="11.5" font-weight="700" font-family="sans-serif">大同發展中心 經費支出管理平台</text>
    ${tabsHtml}
    <rect x="2" y="62" width="516" height="232" rx="6" fill="#ffffff" stroke="#dde3dc"/>
    ${body}
  </svg>`;
}
function bubble(x, y, text, w){
  w = w || (text.length*7.4 + 22);
  return `<g>
    <rect x="${x}" y="${y-30}" width="${w}" height="26" rx="13" fill="#faecd6" stroke="#c98a2c"/>
    <text x="${x+w/2}" y="${y-12}" text-anchor="middle" font-size="11" font-weight="700" fill="#8a5d1c" font-family="sans-serif">${ESC(text)}</text>
    <polygon points="${x+16},${y-4} ${x+30},${y-4} ${x+20},${y+6}" fill="#faecd6" stroke="#c98a2c"/>
  </g>`;
}
function fieldMock(x,y,w,label){
  return `<rect x="${x}" y="${y+12}" width="${w}" height="20" rx="5" fill="#fff" stroke="#dde3dc"/>
    <text x="${x}" y="${y+6}" font-size="9.5" fill="#8a948f" font-family="sans-serif">${ESC(label)}</text>`;
}
function btnMock(x,y,w,h,label,style){
  const fill = style==='primary' ? '#2c6e64' : style==='amber' ? '#fff' : '#fff';
  const stroke = style==='amber' ? '#c98a2c' : style==='danger' ? '#b14e4e' : '#2c6e64';
  const textColor = style==='primary' ? '#fff' : style==='amber' ? '#8a5d1c' : style==='danger' ? '#b14e4e' : '#1d4f48';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>
    <text x="${x+w/2}" y="${y+h/2+4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${textColor}" font-family="sans-serif">${ESC(label)}</text>`;
}

const BODIES = {
  'entry-form': () => `
    ${fieldMock(20,78,230,'支出日期')}${fieldMock(270,78,230,'支出類別')}
    ${fieldMock(20,124,230,'支出金額')}${fieldMock(270,124,230,'登打人員（可自行輸入姓名）')}
    ${fieldMock(20,170,480,'摘要說明')}
    ${btnMock(20,212,110,28,'儲存紀錄','primary')}
    ${bubble(140,210,'填好就按這裡！')}
  `,
  'recent-list': () => `
    ${fieldMock(20,80,150,'起始日期')}${fieldMock(190,80,150,'結束日期')}
    ${btnMock(360,104,140,24,'套用日期篩選','primary')}
    ${[0,1,2].map(i=>`<rect x="20" y="${146+i*30}" width="480" height="24" rx="4" fill="${i%2?'#fbfcfa':'#fff'}" stroke="#eef1ed"/>`).join('')}
    ${bubble(330,100,'依日期找紀錄')}
  `,
  'analysis-filter': () => `
    ${['本週','本月','上月','全部'].map((l,i)=>`<rect x="${20+i*70}" y="76" width="60" height="22" rx="11" fill="${i===1?'#2c6e64':'#fff'}" stroke="${i===1?'#2c6e64':'#dde3dc'}"/><text x="${50+i*70}" y="91" text-anchor="middle" font-size="9.5" fill="${i===1?'#fff':'#7d8b86'}" font-family="sans-serif">${l}</text>`).join('')}
    ${fieldMock(20,116,230,'起始日期')}${fieldMock(270,116,230,'結束日期')}
    ${[0,1,2,3,4,5].map(i=>`<rect x="${20+(i%3)*165}" y="${168+Math.floor(i/3)*26}" width="14" height="14" rx="3" fill="#2c6e64"/><text x="${38+(i%3)*165}" y="${179+Math.floor(i/3)*26}" font-size="9.5" fill="#52615e" font-family="sans-serif">類別${i+1}</text>`).join('')}
    ${btnMock(20,228,110,26,'套用篩選','primary')}
    ${bubble(140,226,'可複選類別！')}
  `,
  'analysis-pie': () => `
    <circle cx="120" cy="175" r="62" fill="none" stroke="#2c6e64" stroke-width="32" stroke-dasharray="120 270" transform="rotate(-90 120 175)"/>
    <circle cx="120" cy="175" r="62" fill="none" stroke="#c98a2c" stroke-width="32" stroke-dasharray="80 310" stroke-dashoffset="-120" transform="rotate(-90 120 175)"/>
    <circle cx="120" cy="175" r="62" fill="none" stroke="#6a8caf" stroke-width="32" stroke-dasharray="190 200" stroke-dashoffset="-200" transform="rotate(-90 120 175)"/>
    ${['郵資 38.7%','社會局方案 25%','中心活動 其他'].map((l,i)=>`<rect x="240" y="${140+i*26}" width="11" height="11" fill="${['#2c6e64','#c98a2c','#6a8caf'][i]}"/><text x="258" y="${149+i*26}" font-size="10" fill="#52615e" font-family="sans-serif">${l}</text>`).join('')}
    ${bubble(210,120,'滑鼠移上去看金額')}
  `,
  'analysis-trend': () => `
    ${[40,70,50,90,65,75].map((h,i)=>`<rect x="${30+i*75}" y="${250-h}" width="46" height="${h}" rx="3" fill="${i===3?'#c98a2c':'#2c6e64'}"/>`).join('')}
    <rect x="${30+3*75-4}" y="${250-90-4}" width="54" height="98" rx="6" fill="none" stroke="#c98a2c" stroke-width="2" stroke-dasharray="4 3"/>
    ${bubble(300,150,'點長條可篩選該週')}
    ${btnMock(360,68,140,22,'↩ 返回上一個篩選','ghost')}
  `,
  'analysis-compare': () => `
    ${[0,1,2,3].map(i=>`<rect x="${20+i*60}" y="76" width="14" height="14" rx="3" fill="#2c6e64"/>`).join('')}
    <text x="100" y="87" font-size="9.5" fill="#52615e" font-family="sans-serif">勾選想比較的類別</text>
    ${fieldMock(20,110,140,'上月')}${fieldMock(170,110,140,'本月')}
    ${btnMock(330,128,150,24,'產生跨期比較','primary')}
    <rect x="20" y="172" width="480" height="60" rx="6" fill="#fbfcfa" stroke="#eef1ed"/>
    <text x="32" y="195" font-size="10.5" fill="#1d4f48" font-family="sans-serif" font-weight="700">郵資</text>
    <text x="120" y="195" font-size="10.5" fill="#52615e" font-family="sans-serif">NT$8,200</text>
    <text x="230" y="195" font-size="10.5" fill="#52615e" font-family="sans-serif">NT$5,100</text>
    <text x="340" y="195" font-size="11" fill="#b14e4e" font-weight="700" font-family="sans-serif">+3,100（+60.8%）</text>
    ${bubble(330,168,'看差異不是合計')}
  `,
  'analysis-detail-approve': () => `
    <rect x="20" y="78" width="480" height="86" rx="6" fill="#fbfcfa" stroke="#eef1ed"/>
    <text x="32" y="98" font-size="10.5" fill="#1d4f48" font-family="sans-serif">2026-06-24　社會局方案　NT$4,000</text>
    <rect x="32" y="106" width="50" height="18" rx="9" fill="#e3eee9"/><text x="57" y="118" text-anchor="middle" font-size="9" fill="#1d4f48" font-family="sans-serif">已核可</text>
    <rect x="32" y="132" width="220" height="26" rx="6" fill="#faecd6" stroke="#c98a2c"/>
    <text x="40" y="148" font-size="9" fill="#8a5d1c" font-family="sans-serif">📝審核備註（理事長 王理事長）</text>
    ${btnMock(330,100,60,24,'核可','ghost')}${btnMock(396,100,60,24,'退件','amber')}
    ${btnMock(330,130,126,24,'＋審核備註','ghost')}
    ${bubble(280,96,'核可／退件／留言')}
  `,
  'categories-manage': () => `
    ${fieldMock(20,82,300,'新類別名稱')}
    ${btnMock(336,94,90,28,'新增類別','primary')}
    ${[0,1,2].map(i=>`<rect x="20" y="${140+i*30}" width="400" height="24" rx="4" fill="${i%2?'#fbfcfa':'#fff'}" stroke="#eef1ed"/><rect x="430" y="${144+i*30}" width="50" height="18" rx="4" fill="#fff" stroke="#b14e4e"/><text x="455" y="${156+i*30}" text-anchor="middle" font-size="9" fill="#b14e4e" font-family="sans-serif">刪除</text>`).join('')}
    ${bubble(360,90,'隨時可以新增')}
  `,
  'import-csv': () => `
    <rect x="20" y="80" width="480" height="48" rx="6" fill="#fbfcfa" stroke="#dde3dc" stroke-dasharray="5 4"/>
    <text x="40" y="108" font-size="10.5" fill="#7d8b86" font-family="sans-serif">📄 選擇 CSV 檔案...</text>
    ${fieldMock(20,140,140,'民國年度')}
    ${btnMock(190,152,130,26,'解析並預覽','primary')}
    ${btnMock(340,152,140,26,'確認匯入到資料庫','ghost')}
    ${bubble(190,148,'先預覽再確認')}
  `,
  'users-manage': () => `
    ${[0,1,2].map(i=>`<rect x="20" y="${82+i*36}" width="480" height="28" rx="4" fill="${i%2?'#fbfcfa':'#fff'}" stroke="#eef1ed"/><text x="32" y="${100+i*36}" font-size="10" fill="#1d4f48" font-family="sans-serif">${['王小姐 / wang@gmail.com','陳先生 / chen@gmail.com','李理事長 / li@gmail.com'][i]}</text>`).join('')}
    ${btnMock(340,82,150,28,'設定為「登打者」','primary')}
    ${bubble(330,78,'指派角色')}
  `,
};

const ROLE_TABS = {
  staff: ["每日登打","統計分析","類別管理","資料匯入"],
  director: ["統計分析"],
  admin: ["每日登打","統計分析","類別管理","資料匯入","使用者管理"]
};

const TOURS = {
  staff: [
    { tab:0, body:'entry-form', title:'每日登打：新增一筆支出', desc:'選日期、選支出類別、輸入金額與摘要，「登打人員」欄位可以自己打上您的姓名（不會綁死帳號名字）。填好按「儲存紀錄」就完成這一筆登打。' },
    { tab:0, body:'recent-list', title:'近期登打紀錄', desc:'下方會列出最近登打的紀錄，預設只顯示 15 筆，可以用上面的日期區間篩選，或按「顯示全部紀錄」看完整清單。每一筆都可以「編輯」或「刪除」。' },
    { tab:1, body:'analysis-filter', title:'統計分析：選擇想看的區間', desc:'可以用「本週／本月／上月」快速按鈕，或自己選起訖日期。下面的支出類別可以「複選」打勾，只看您想分析的幾個類別。' },
    { tab:1, body:'analysis-pie', title:'支出類別圓餅圖', desc:'依篩選結果自動畫出圓餅圖，滑鼠移上去會顯示金額跟占比，旁邊也有完整的金額表格可以對照。' },
    { tab:1, body:'analysis-trend', title:'支出趨勢圖', desc:'可以直接點擊任一根長條，會自動篩選成那一週（或那一天/那一月）的資料；點錯了可以按右上角「↩ 返回上一個篩選範圍」復原。' },
    { tab:2, body:'categories-manage', title:'類別管理：隨時新增類別', desc:'如果遇到沒有的支出類別，可以在這裡直接新增，所有人會立即看到新選項；不再使用的類別也可以刪除（不會動到舊紀錄）。' },
    { tab:3, body:'import-csv', title:'資料匯入（進階功能）', desc:'如果主任請您協助把舊試算表資料整批匯入，可以在這裡上傳 CSV 檔案，系統會先讓您預覽解析結果，確認沒問題才會真正寫進資料庫。' },
  ],
  director: [
    { tab:0, body:'analysis-filter', title:'歡迎，理事長！', desc:'您登入後會直接看到「統計分析」，可以查看中心所有支出紀錄。用上面的快速按鈕或自訂日期，挑選想檢視的區間，也能複選支出類別。' },
    { tab:0, body:'analysis-pie', title:'支出類別一目了然', desc:'圓餅圖會顯示各類別支出占比，旁邊表格列出詳細金額，方便快速掌握整體支出結構。' },
    { tab:0, body:'analysis-trend', title:'支出趨勢圖可以點擊', desc:'直接點長條圖就能篩選看那一週/那一天的明細，不需要自己手動選日期；點錯了按「↩ 返回上一個篩選範圍」就能回去。' },
    { tab:0, body:'analysis-compare', title:'類別跨期比較', desc:'勾選想比較的類別，新增兩個以上的時間區間（例如本月 vs 上月），系統會直接告訴您「差異」跟「漲跌幅」，不只是看合計數字。' },
    { tab:0, body:'analysis-detail-approve', title:'核可、退件與審核備註', desc:'在「明細清單」每一筆紀錄旁邊，可以直接按「核可」或「退件」。也可以按「＋審核備註」留言給登打人員，您留的每一筆備註都會標明您的角色與時間，不會被覆蓋掉。' },
  ],
  admin: [
    { tab:0, body:'entry-form', title:'每日登打：新增一筆支出', desc:'跟登打者一樣，您也可以直接登打支出。「登打人員」欄位可自行輸入姓名，方便辨識實際經手人。' },
    { tab:0, body:'recent-list', title:'近期登打紀錄', desc:'可用日期區間篩選，或按「顯示全部紀錄」看完整清單，每一筆都能編輯或刪除。' },
    { tab:1, body:'analysis-filter', title:'統計分析：彈性篩選', desc:'快速區間按鈕＋自訂日期＋複選類別，篩選條件可以自由組合。' },
    { tab:1, body:'analysis-trend', title:'點擊趨勢圖快速篩選', desc:'點長條圖直接篩選該週/該月，按「↩ 返回上一個篩選範圍」可以回到上一步。' },
    { tab:1, body:'analysis-compare', title:'類別跨期比較看差異', desc:'勾選類別＋新增多個時間區間，系統直接算出差異金額跟漲跌幅，方便您快速抓出異常變化。' },
    { tab:1, body:'analysis-detail-approve', title:'核可、退件與審核備註', desc:'您跟理事長一樣可以核可/退件，也可以留審核備註，每一筆都會記錄角色、姓名跟時間。' },
    { tab:2, body:'categories-manage', title:'類別管理', desc:'隨時新增或刪除支出類別，全部人即時同步看到。' },
    { tab:3, body:'import-csv', title:'資料匯入', desc:'要批量匯入舊試算表資料時，在這裡上傳 CSV，先預覽再確認匯入，避免匯錯資料。' },
    { tab:4, body:'users-manage', title:'使用者管理（只有主任能看到）', desc:'新使用者第一次登入後會出現在這裡，角色預設「待設定」，請在這裡指派「登打者」「理事長」或「主任」。要新增全新帳號，仍需要到 Firebase 後台手動建立。' },
  ],
};

let onboardSteps = [], onboardIdx = 0, onboardRole = null;

function renderOnboardStep(){
  const step = onboardSteps[onboardIdx];
  const tabs = ROLE_TABS[onboardRole];
  $('onboardIllustration').innerHTML = svgWrap(tabs, step.tab, BODIES[step.body]());
  $('onboardTitle').textContent = `${onboardIdx+1}/${onboardSteps.length}　${step.title}`;
  $('onboardDesc').textContent = step.desc;
  $('onboardDots').innerHTML = onboardSteps.map((_,i)=>`<span class="${i===onboardIdx?'active':''}"></span>`).join('');
  $('onboardPrevBtn').style.visibility = onboardIdx===0 ? 'hidden' : 'visible';
  $('onboardNextBtn').textContent = onboardIdx===onboardSteps.length-1 ? '完成，開始使用 →' : '下一步 →';
}
function openOnboarding(role){
  onboardRole = role;
  onboardSteps = TOURS[role] || [];
  if(!onboardSteps.length) return;
  onboardIdx = 0;
  renderOnboardStep();
  $('onboardOverlay').classList.remove('hidden');
}
async function closeOnboarding(markSeen){
  $('onboardOverlay').classList.add('hidden');
  if(markSeen && currentUser){
    const updated = { ...currentUser.onboardedRoles, [onboardRole]: true };
    currentUser.onboardedRoles = updated;
    try{ await updateDoc(doc(db,'users', currentUser.uid), { onboardedRoles: updated }); }catch(err){ /* 不影響操作，安靜失敗即可 */ }
  }
}
$('onboardNextBtn').addEventListener('click', ()=>{
  if(onboardIdx < onboardSteps.length-1){ onboardIdx++; renderOnboardStep(); }
  else closeOnboarding(true);
});
$('onboardPrevBtn').addEventListener('click', ()=>{
  if(onboardIdx>0){ onboardIdx--; renderOnboardStep(); }
});
$('onboardSkipBtn').addEventListener('click', ()=>closeOnboarding(true));
$('onboardCloseBtn').addEventListener('click', ()=>closeOnboarding(true));
$('onboardingReopenBtn').addEventListener('click', ()=>openOnboarding(currentUser.role));

/* ---------------- 初始化 ---------------- */
$('rocToday').textContent = `今日：${rocFromISO(todayISO())}（西元 ${todayISO()}）`;
$('f_date').value = todayISO();
