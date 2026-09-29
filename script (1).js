const ENABLE_SEMAPHORE_SMS = false;

/* ---------------- FIREBASE AUTHENTICATION ---------------- */
const APP_API_CONFIG = (() => {
  const runtimeConfig = typeof window !== 'undefined' ? (window.__APP_API_CONFIG__ || {}) : {};
  return {
    firebase: {
      apiKey: runtimeConfig.firebase?.apiKey || 'AIzaSyBBuFx3jMH46BLrKY0Lx_7YmeCtg_na92g',
      authDomain: runtimeConfig.firebase?.authDomain || 'automated-school-violation-rec.firebaseapp.com',
      projectId: runtimeConfig.firebase?.projectId || 'automated-school-violation-rec',
      storageBucket: runtimeConfig.firebase?.storageBucket || 'automated-school-violation-rec.firebasestorage.app',
      messagingSenderId: runtimeConfig.firebase?.messagingSenderId || '453921337704',
      appId: runtimeConfig.firebase?.appId || '1:453921337704:web:e53735c9f72c2f3222a6dd',
    },
    notifications: {
      resendEndpoint: runtimeConfig.notifications?.resendEndpoint || 'https://api.resend.com/emails',
    },
    resend: {
      apiKey: runtimeConfig.resend?.apiKey || '',
      from: runtimeConfig.resend?.from || '',
    }
  };
})();
const firebaseConfig = APP_API_CONFIG.firebase;
const firebaseAuthApi = Promise.all([
  import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
  import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'),
  import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'),
]).then(([firebaseApp, firebaseAuth, firebaseFirestore]) => {
  const app = firebaseApp.initializeApp(firebaseConfig, 'auth-app');
  const auth = firebaseAuth.getAuth(app);
  const db = firebaseFirestore.getFirestore(app);
  return {
    auth,
    db,
    getAuth: firebaseAuth.getAuth,
    signInWithEmailAndPassword: firebaseAuth.signInWithEmailAndPassword,
    signOut: firebaseAuth.signOut,
    onAuthStateChanged: firebaseAuth.onAuthStateChanged,
    getFirestore: firebaseFirestore.getFirestore,
    collection: firebaseFirestore.collection,
    onSnapshot: firebaseFirestore.onSnapshot,
    addDoc: firebaseFirestore.addDoc,
    setDoc: firebaseFirestore.setDoc,
    updateDoc: firebaseFirestore.updateDoc,
    doc: firebaseFirestore.doc,
    getDoc: firebaseFirestore.getDoc,
  };
});
firebaseAuthApi.then(api=>{
  window.db = api.db;
  window.fs = api;
  subscribeToFirestore();
}).catch(error=>console.error('Firebase initialization failed:', error));

/* ---------------- DATA MODEL (starts fully empty) ---------------- */
let students = []; // { uid, studentId, firstName, lastName, gender, course, yearLevel, section, phone, address, parentName, parentPhone, guardianEmail, parentMessage, status, voidedDate, violations:[{date,occurredAt,category,action,notes}] }
let uidCounter = 1;
let editingUid = null; // null = add mode, otherwise editing this uid
let violationMode = 'existing'; // 'existing' or 'new'
const WARNING_LIMIT = 4;   // student & parent/guardian get an automated warning notification
const emailJsReady = new Promise(resolve=>{
  const initializeEmailJs = ()=>{
    try{
      window.emailjs.init('I2Mb3rIA5Q_owv9ry');
      resolve(window.emailjs);
    }catch(error){
      console.error('EmailJS initialization failed:', error);
      resolve(null);
    }
  };
  if(window.emailjs){
    initializeEmailJs();
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@3/dist/email.min.js';
  script.onload = initializeEmailJs;
  script.onerror = ()=>{
    console.error('EmailJS SDK failed to load.');
    resolve(null);
  };
  document.head.appendChild(script);
});
const VIOLATION_LIMIT = 5; // reaching this count auto-voids the scholarship + sends a void notification
let notifications = []; // {id, uid, student, studentId, type, date, recipients, channel, status}
let recommendations = []; // {id, uid, student, subject, facultyName, reason, date, status}
let urlStateRestored = false;
const readNotificationIds = new Set();
document.addEventListener('alpine:init', ()=>{
  if(!window.Alpine.store('violation')){
    window.Alpine.store('violation', {mode:'existing', nextCount:0});
  }
});
function notificationReadStorageKey(){
  return `readNotifications:${currentUser?.uid || normalizeRole(currentRole) || 'guest'}`;
}
function loadReadNotificationIds(){
  readNotificationIds.clear();
  try{
    const savedIds = JSON.parse(localStorage.getItem(notificationReadStorageKey()) || '[]');
    savedIds.forEach(id=>readNotificationIds.add(String(id)));
  }catch(error){
    console.warn('Could not restore notification read state:', error);
  }
}
function persistReadNotificationIds(){
  localStorage.setItem(notificationReadStorageKey(), JSON.stringify([...readNotificationIds]));
}

function ensureDialogRoot(){
  let root = document.getElementById('appDialogRoot');
  if(!root){
    root = document.createElement('div');
    root.id = 'appDialogRoot';
    root.setAttribute('aria-live', 'assertive');
    document.body.appendChild(root);
  }
  return root;
}
function closeDialog(result){
  const root = document.getElementById('appDialogRoot');
  if(root) root.innerHTML = '';
  return result;
}
function showNotice(message, title='Notice'){
  const root = ensureDialogRoot();
  root.innerHTML = `<div class="app-dialog-backdrop"><section class="app-dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="appDialogTitle"><h2 id="appDialogTitle">${title}</h2><p>${message}</p><div class="app-dialog-actions"><button type="button" class="app-dialog-ok" data-dialog-ok>OK</button></div></section></div>`;
  root.querySelector('[data-dialog-ok]').focus();
  root.querySelector('[data-dialog-ok]').addEventListener('click', () => closeDialog(true));
  return new Promise(resolve => root.querySelector('[data-dialog-ok]').addEventListener('click', () => resolve(true), {once:true}));
}
function showActionHistoryModal(student, actionSummary){
  const root = ensureDialogRoot();
  root.innerHTML = `<div class="app-dialog-backdrop"><section class="app-dialog-card custom-action-modal" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle"><div class="custom-action-modal-header"><h2 id="appDialogTitle">Student Violation History - ${fullName(student)}</h2></div><div class="custom-action-modal-body"><div class="student-action-summary"><div><span class="detail-label">Student ID:</span> <span class="detail-value">${student.studentId||'-'}</span></div><div><span class="detail-label">Course/Year:</span> <span class="detail-value">${courseYear(student)}</span></div><div><span class="detail-label">Status:</span> <span class="detail-value">${studentStatusLabel(student)}</span></div></div>${actionSummary.history}</div><div class="app-dialog-actions custom-action-modal-footer"><button type="button" class="app-dialog-ok" data-dialog-ok>OK</button></div></section></div>`;
  const okButton = root.querySelector('[data-dialog-ok]');
  okButton.focus();
  return new Promise(resolve => okButton.addEventListener('click', () => resolve(closeDialog(true)), {once:true}));
}
function confirmAction(message, title='Confirm Action', onConfirm=null){
  const root = ensureDialogRoot();
  root.innerHTML = `<div class="app-dialog-backdrop"><section class="app-dialog-card" role="alertdialog" aria-modal="true" aria-labelledby="appDialogTitle"><h2 id="appDialogTitle">${title}</h2><p>${message}</p><div class="app-dialog-actions"><button type="button" class="app-dialog-cancel" data-dialog-cancel>Cancel</button><button type="button" class="app-dialog-ok" data-dialog-ok>OK</button></div></section></div>`;
  const resolveDialog = result => { closeDialog(result); return result; };
  return new Promise(resolve => {
    root.querySelector('[data-dialog-cancel]').addEventListener('click', () => resolve(resolveDialog(false)), {once:true});
    root.querySelector('[data-dialog-ok]').addEventListener('click', async () => {
      try{
        if(typeof onConfirm === 'function') await onConfirm();
      }catch(error){
        console.error('Confirmation action failed:', error);
      }
      resolve(resolveDialog(true));
    }, {once:true});
    root.querySelector('[data-dialog-cancel]').focus();
  });
}
function requestText(message, title='Enter Information', initialValue=''){
  const root = ensureDialogRoot();
  root.innerHTML = `<div class="app-dialog-backdrop"><section class="app-dialog-card" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle"><h2 id="appDialogTitle">${title}</h2><p>${message}</p><input class="app-dialog-input" data-dialog-input value="${String(initialValue).replace(/"/g, '&quot;')}"><div class="app-dialog-actions"><button type="button" class="app-dialog-cancel" data-dialog-cancel>Cancel</button><button type="button" class="app-dialog-ok" data-dialog-ok>Save</button></div></section></div>`;
  const input = root.querySelector('[data-dialog-input]');
  input.focus();
  return new Promise(resolve => {
    root.querySelector('[data-dialog-cancel]').addEventListener('click', () => resolve(closeDialog(null)), {once:true});
    root.querySelector('[data-dialog-ok]').addEventListener('click', () => resolve(closeDialog(input.value)), {once:true});
  });
}

/* ---------------- ROLES / ACCESS CONTROL ---------------- */
const ROLES = {
  guidance:  {label:'GUIDANCE COUNSELOR', pages:['dashboard','students','recommendations','droplist','discipline'], canEdit:true, canRecord:true, canVoid:true, canSubmitRecommendation:false, canReview:true, canFinalize:false, canVerify:false},
  academic:  {label:'ACADEMIC HEAD', pages:['dashboard','students','recommendations','droplist','discipline'], canEdit:false, canRecord:false, canVoid:false, canSubmitRecommendation:false, canReview:false, canFinalize:false, canVerify:false},
  faculty:   {label:'FACULTY MEMBER', pages:['dashboard','students','recommendations','discipline'], canEdit:false, canRecord:false, canVoid:false, canSubmitRecommendation:true, canReview:false, canFinalize:false, canVerify:false},
  admin:     {label:'SCHOOL ADMINISTRATOR', pages:['dashboard','students','droplist','discipline'], canEdit:false, canRecord:false, canVoid:false, canSubmitRecommendation:false, canReview:false, canFinalize:false, canVerify:false},
  registrar: {label:'REGISTRAR', pages:['dashboard','students','droplist','recommendations','certifications','discipline'], canEdit:false, canRecord:false, canVoid:false, canSubmitRecommendation:false, canReview:false, canFinalize:true, canVerify:true},
};
const READ_ONLY_ROLE = {label:'AUTHENTICATED USER', pages:[], canEdit:false, canRecord:false, canVoid:false, canSubmitRecommendation:false, canReview:false, canFinalize:false, canVerify:false};
let currentRole = null;
let currentUser = null;
let isSessionInitialized = false;

function normalizeRole(userRole){
  const value = String(userRole || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    counselor:'guidance', guidance_counselor:'guidance', guidance_office:'guidance',
    academic_head:'academic', faculty_member:'faculty', school_admin:'admin',
    school_administrator:'admin', registrar_office:'registrar',
  };
  return aliases[value] || value;
}

function rolePermissions(userRole){
  return ROLES[normalizeRole(userRole)] || READ_ONLY_ROLE;
}

function canAccessCurrentPage(roleKey, pageFile){
  const role = rolePermissions(roleKey);
  const normalizedFile = pageFile.toLowerCase();
  if(normalizedFile === 'notifications.html') return true;
  if(normalizedFile === 'violation.html') return role.canRecord;
  if(normalizedFile === 'addstudent.html') return role.canEdit;
  const pageKey = Object.keys(pageRoutes).find(key => pageRoutes[key].toLowerCase() === normalizedFile && key !== 'stats' && key !== 'page-addstudent');
  return Boolean(pageKey && role.pages.includes(pageKey));
}

function applyRolePermissions(userRole){
  const roleKey = normalizeRole(userRole);
  const role = rolePermissions(roleKey);
  const setVisible = (selector, visible) => {
    document.querySelectorAll(selector).forEach(element => {
      element.style.display = visible ? '' : 'none';
    });
  };
  const setReadOnly = (selector, readOnly) => {
    document.querySelectorAll(selector).forEach(element => {
      element.disabled = readOnly;
      element.setAttribute('aria-disabled', String(readOnly));
    });
  };

  setVisible('#addStudentBtn, #addStudentSaveBtn, #studentsAddBtnRow, .add-student-btn', role.canEdit);
  setVisible('#dashBtnViolation, #recordViolationBtn, .record-violation-btn, .violation-record-section', role.canRecord);
  setVisible('#dashBtnVoided, #voidedScholarshipBtn, .voided-scholarship-section', role.canVoid);
  setVisible('#recommendFormCard, .dropout-section, .dropout-recommendation-form', role.canSubmitRecommendation);
  setVisible('.finalize-drop-btn, .finalize-dropout-btn', role.canFinalize);
  setVisible('.certification-verify-btn, .scholarship-verification', role.canVerify);
  setReadOnly('.role-protected-write', !role.canEdit && !role.canRecord && !role.canSubmitRecommendation && !role.canFinalize);

  document.querySelectorAll('.role-badge, [data-role-badge]').forEach(badge => {
    badge.textContent = role.label;
  });
  document.querySelectorAll('.sidebar').forEach(sidebar => {
    const activePage = document.querySelector('.page.active')?.id.replace(/^page-/, '') || '';
    buildSidebar(sidebar, activePage);
  });
  document.querySelectorAll('.topbar').forEach(topbar => buildTopbar(topbar));
  document.querySelectorAll('[data-role-only]').forEach(element => {
    element.style.display = element.dataset.roleOnly.split(',').map(normalizeRole).includes(roleKey) ? '' : 'none';
  });
}
const pageRoutes = {
  dashboard: 'stats.html',
  stats: 'stats.html',
  students: 'students.html',
  discipline: 'discipline.html',
  violation: 'violation.html',
  addstudent: 'addstudent.html',
  'page-addstudent': 'addstudent.html',
  droplist: 'droplist.html',
  recommendations: 'recommendations.html',
  notifications: 'notifications.html',
  certifications: 'certifications.html',
  verifications: 'verifications.html',
};
const protectedPageFiles = [
  'stats.html',
  'students.html',
  'discipline.html',
  'violation.html',
  'addstudent.html',
  'droplist.html',
  'recommendations.html',
  'notifications.html',
  'certifications.html',
  'verifications.html',
];

function currentPageFile(){
  return window.location.pathname.split('/').pop() || 'index.html';
}

function redirectIfNeeded(fileName){
  if(currentPageFile().toLowerCase() !== fileName.toLowerCase()){
    window.location.href = fileName;
    return true;
  }
  return false;
}

async function loginUser(event){
  if(event && event.preventDefault) event.preventDefault();

  const email = document.getElementById('loginUsername')?.value.trim();
  const password = document.getElementById('loginPassword')?.value;
  if(!email || !password){
    console.error('Login failed: email and password are required.');
    await showNotice('Enter your email and password.', 'Login Required');
    return;
  }

  try{
    const {auth, signInWithEmailAndPassword} = await firebaseAuthApi;
    await signInWithEmailAndPassword(auth, email, password);
    console.log('Login attempt started; waiting for auth state observer.');
  }catch(error){
    console.error('Login failed:', error);
    if(error.code === 'auth/quota-exceeded'){
      await showNotice('Firebase rate limit reached. Switch to a mobile hotspot or wait a few minutes.', 'Login Unavailable');
    }else{
      await showNotice('Login failed: ' + error.message, 'Login Failed');
    }
  }
}

async function logoutUser(event){
  if(event && typeof event.preventDefault === 'function') event.preventDefault();

  try{
    const {auth, signOut} = await firebaseAuthApi;
    await signOut(auth);
    console.log('Logout successful.');
  }catch(error){
    console.error('Logout failed:', error);
  }
}
window.logout = logoutUser;

async function initializeAuthStateListener(){
  const {auth, db, onAuthStateChanged, doc, getDoc} = await firebaseAuthApi;

  onAuthStateChanged(auth, async (user) => {
    const pageFile = currentPageFile();
    const onLoginPage = pageFile === 'index.html' || document.getElementById('page-login');
    const onProtectedPage = protectedPageFiles.includes(pageFile.toLowerCase());

    if(!user){
      currentUser = null;
      currentRole = null;
      isSessionInitialized = false;
      sessionStorage.removeItem('activePage');
      ['loginUsername', 'loginPassword'].forEach(id => {
        const field = document.getElementById(id);
        if(field) field.value = '';
      });
      if(onProtectedPage){
        redirectIfNeeded('index.html');
      }else if(document.getElementById('page-login')){
        showPage('login');
      }
      return;
    }

    if(user && !isSessionInitialized){
      currentUser = user;
      try{
        const userDoc = await getDoc(doc(db, 'users', user.uid));
        if(!userDoc.exists()){
          console.error('Auth state changed: no user document found for', user.uid);
          currentRole = null;
          isSessionInitialized = false;
          sessionStorage.removeItem('activePage');
          if(onLoginPage && document.getElementById('page-login')){
            showPage('login');
          }else{
            redirectIfNeeded('index.html');
          }
          return;
        }

        currentRole = normalizeRole(userDoc.data().role);
        loadReadNotificationIds();
        sessionStorage.setItem('currentRole', currentRole);
        applyRolePermissions(currentRole);
        if(!onLoginPage && !canAccessCurrentPage(currentRole, pageFile)){
          redirectIfNeeded('stats.html');
          return;
        }
        const savedPage = sessionStorage.getItem('activePage') || 'dashboard';
        console.log('Auth state changed: user logged in with role', currentRole, 'restoring page', savedPage);
        isSessionInitialized = true;
        if(onLoginPage){
          sessionStorage.setItem('activePage', 'dashboard');
          redirectIfNeeded('stats.html');
        }
      }catch(error){
        console.error('Auth state changed: failed to load user role.', error);
        currentRole = null;
        isSessionInitialized = false;
        sessionStorage.removeItem('activePage');
        if(onLoginPage && document.getElementById('page-login')){
          showPage('login');
        }else{
          redirectIfNeeded('index.html');
        }
      }
      return;
    }

    if(user && isSessionInitialized){
      return;
    }
  });
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', () => {
    initializeAuthStateListener();
  }, {once:true});
}else{
  initializeAuthStateListener();
}

/* ---------------- FIRESTORE DATA ---------------- */
function firestoreApi(){
  return window.db && window.fs ? window.fs : null;
}
function firestorePayload(record){
  const payload = Object.assign({}, record);
  delete payload.firestoreId;
  return payload;
}

function sendViolationEmail(student, violation, violationCount){
  if(violationCount !== WARNING_LIMIT) return Promise.resolve(true);

  const guardianEmail = String(student.guardianEmail || student.parentEmail || '').trim();
  if(!guardianEmail) return Promise.resolve(true);

  const templateParams = {
    to_email: guardianEmail,
    student_name: fullName(student),
    student_id: String(student.studentId || ''),
    latest_violation: violation?.category || violation?.description || String(violation || ''),
    date_logged: new Date().toLocaleDateString(),
  };

  return fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      service_id: 'service_l85mxv9',
      template_id: 'template_t3zh2eo',
      user_id: 'I2Mb3rIA5Q_owv9ry',
      template_params: templateParams
    })
  }).then(async response=>{
    if(!response.ok) throw new Error(await response.text());
    console.log('EmailJS violation warning sent to guardian.');
    return true;
  }).catch(error=>{
    console.error('Violation email request failed:', error);
    return false;
  });
}

async function dispatchViolationNotifications(student, violationType, currentCount){
  if(currentCount !== WARNING_LIMIT) return {emailSent:true, skipped:true};

  const guardianEmail = String(student.guardianEmail || student.parentEmail || '').trim();
  if(!guardianEmail) return {emailSent:true, skipped:true};

  const violation = {category: violationType};
  const emailSent = await sendViolationEmail(student, violation, currentCount);
  return {emailSent, skipped:false};
}

async function addFirestoreRecord(collectionName, record){
  const fs = firestoreApi();
  if(!fs) throw new Error('Firestore is not ready yet.');
  const ref = await fs.addDoc(fs.collection(window.db, collectionName), firestorePayload(record));
  record.firestoreId = ref.id;
  return ref;
}
async function updateFirestoreRecord(collectionName, record){
  const fs = firestoreApi();
  if(!fs) throw new Error('Firestore is not ready yet.');
  if(!record.firestoreId) return addFirestoreRecord(collectionName, record);
  await fs.setDoc(fs.doc(window.db, collectionName, record.firestoreId), firestorePayload(record), {merge:true});
}
function refreshCurrentPageData(){
  const activePage = document.querySelector('.page.active');
  if(!activePage) return;
  const page = activePage.id.replace('page-','');
  if(page==='students') renderStudentTable();
  if(page==='droplist') renderDropTable();
  if(page==='dashboard' || page==='stats') renderStats();
  if(page==='notifications') renderNotifications();
  if(page==='recommendations') renderRecommendationsTable();
  if(page==='certifications') renderCertTable();
}
function refreshFirestoreUI(){
  document.querySelectorAll('.topbar').forEach(tb=>buildTopbar(tb));
  refreshCurrentPageData();
  restoreUrlState();
}
function restoreUrlState(){
  if(urlStateRestored) return;
  const params = new URLSearchParams(window.location.search);
  const selectedUid = params.get('uid');
  if(!selectedUid){
    urlStateRestored = true;
    return;
  }
  const page = document.querySelector('.page.active')?.id;
  const student = students.find(item=>item.uid===Number(selectedUid));
  if(!student) return;
  if(page === 'page-violation'){
    setViolationMode('existing');
    populateViolationStudentSelect(Number(selectedUid));
  }
  if(page === 'page-recommendations'){
    setRecommendMode('existing');
    pickRecommendStudent(Number(selectedUid));
  }
  if(page === 'page-certifications'){
    const certSearch = document.getElementById('certSearch');
    if(certSearch){ certSearch.value = fullName(student); renderCertTable(); }
  }
  if(page === 'page-addstudent' && params.get('mode') === 'edit') startEditStudent(Number(selectedUid));
  urlStateRestored = true;
}
function subscribeToFirestore(){
  const fs = firestoreApi();
  if(!fs) return;
  fs.onSnapshot(fs.collection(window.db, 'students'), snapshot=>{
    students = snapshot.docs.map(item=>{
      const data = item.data();
      return Object.assign({firestoreId:item.id, violations:[]}, data, {firestoreId:item.id});
    });
    uidCounter = students.reduce((max, student)=>Math.max(max, Number(student.uid)||0), 0) + 1;
    refreshFirestoreUI();
  }, error=>console.error('Could not subscribe to students:', error));
    fs.onSnapshot(fs.collection(window.db, 'dropout_recommendations'), snapshot=>{
    recommendations = snapshot.docs.map(item=>Object.assign({firestoreId:item.id}, item.data(), {firestoreId:item.id, id:item.id}));
      void cleanupInvalidRecommendations(snapshot.docs);
    refreshFirestoreUI();
  }, error=>console.error('Could not subscribe to recommendations:', error));
  fs.onSnapshot(fs.collection(window.db, 'notifications'), snapshot=>{
    notifications = snapshot.docs.map(item=>Object.assign({firestoreId:item.id}, item.data(), {firestoreId:item.id}));
    refreshFirestoreUI();
  }, error=>console.error('Could not subscribe to notifications:', error));
}

async function cleanupInvalidRecommendations(records){
  const fs = firestoreApi();
  if(!fs?.deleteDoc || !fs?.doc) return;
  const placeholderReason = /^(test|testing|sample|dummy|asdf|blah|lorem|none|n\/a|na)$/i;
  const invalidRecords = records.filter(record=>{
    const data = record.data() || {};
    const subject = String(data.subject || '').trim();
    const reason = String(data.reason || '').trim();
    return !subject || reason.length < 10 || placeholderReason.test(reason);
  });
  await Promise.all(invalidRecords.map(async record=>{
    try{
      await fs.deleteDoc(fs.doc(window.db, 'dropout_recommendations', record.id));
    }catch(error){
      console.error('Could not remove invalid recommendation:', error);
    }
  }));
}

/* ---------------- NAV / SHELL ---------------- */
const allNavItems = [
  {label:'DASHBOARD', page:'dashboard', href:'stats.html'},
  {label:'Student', page:'students', href:'students.html'},
  {label:'Student Status', page:'droplist', href:'droplist.html'},
  {label:'Dropout Recommendations', page:'recommendations', href:'recommendations.html'},
  {label:'Certifications', page:'certifications', href:'certifications.html'},
  {label:'Rules and Regulations', page:'discipline', href:'discipline.html'},
];
function navigateTo(e, pageId, presetFilter){
  if(e && typeof e.preventDefault === 'function') e.preventDefault();
  if(typeof pageId === 'string') showPage(pageId, e, presetFilter);
}

function currentNavItems(){
  const role = rolePermissions(currentRole);
  return allNavItems.filter(i=>role.pages.includes(i.page));
}

function buildSidebar(container, activePage){
  const activeFile = currentPageFile().toLowerCase();
  container.innerHTML = `
    <div class="logo"><div class="mark">STI</div><div><div class="name">Admin Panel</div><div class="badge">v1.0</div></div></div>
    <nav>${currentNavItems().map(i=>`<a class="nav-item${i.page===activePage || activeFile===i.href?' active':''}" href="${i.href}">${i.label}</a>`).join('')}</nav>
  `;
}
function buildTopbar(container){
  const role = rolePermissions(currentRole);
  const notificationCount = getVisibleNotificationCount();
  container.innerHTML = `
    <div class="titlewrap"><button type="button" class="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu">&#9776;</button><div class="mark2">STI</div><h1>Automated School <span>Violation</span> Record Management System</h1></div>
    <div class="topright"><button type="button" class="notification-bell" onclick="toggleNotificationPanel(event)" aria-label="Open notifications" aria-expanded="false">&#128276;<span class="notification-count"${notificationCount===0?' style="display:none"':''}>${notificationCount}</span></button><span class="role-badge">${role.label}</span><div class="dot" onclick="window.showPage('discipline', event)">?</div><div onclick="window.logoutUser(event)" style="cursor:pointer;">Logout</div></div>
  `;
}
function getVisibleNotificationCount(){
  return notifications.filter(n=>(!n.recipientRoles || n.recipientRoles.includes(currentRole)) && !readNotificationIds.has(n.firestoreId || n.id)).length;
}
function refreshNotificationIndicators(){
  const count = getVisibleNotificationCount();
  document.querySelectorAll('.notification-count').forEach(badge=>{
    badge.textContent = count;
    badge.style.display = count === 0 ? 'none' : '';
  });
}
async function markAllAsRead(){
  const visibleNotifications = notifications.filter(n=>!n.recipientRoles || n.recipientRoles.includes(currentRole));
  visibleNotifications.forEach(notification=>{
    const notificationId = notification.firestoreId || notification.id;
    if(notificationId) readNotificationIds.add(String(notificationId));
    notification.isRead = true;
  });
  persistReadNotificationIds();
  refreshNotificationIndicators();
  document.querySelectorAll('.topbar').forEach(topbar=>buildTopbar(topbar));

  const fs = firestoreApi();
  if(fs?.updateDoc && fs?.doc){
    await Promise.all(visibleNotifications.filter(n=>n.firestoreId).map(async notification=>{
      try{
        await fs.updateDoc(fs.doc(window.db, 'notifications', notification.firestoreId), {isRead:true});
      }catch(error){
        console.error('Could not persist notification read state:', error);
      }
    }));
  }
}
function notificationMessage(notification){
  const info = notifTypeInfo(notification.type);
  return `${info.label} for ${notification.student || 'student'}`;
}
function toggleNotificationPanel(event){
  if(event) event.stopPropagation();
  let panel = document.getElementById('notificationPanel');
  if(panel){
    panel.remove();
    document.querySelectorAll('.notification-bell').forEach(button=>button.setAttribute('aria-expanded','false'));
    return;
  }
  const visible = sortNotificationsByNewest(notifications.filter(n=>!n.recipientRoles || n.recipientRoles.includes(currentRole))).slice(0,8);
  panel = document.createElement('div');
  panel.id = 'notificationPanel';
  panel.className = 'notification-panel';
  panel.innerHTML = `<div class="notification-panel-head"><strong>Notifications</strong><button type="button" data-mark-notifications>Mark all read</button></div>${visible.length ? visible.map(n=>`<button type="button" class="notification-item" data-notification-id="${n.firestoreId || n.id}"><span class="notification-avatar">${(n.student || 'S').slice(0,1).toUpperCase()}</span><span><b>${notificationMessage(n)}</b><small>${n.date || 'Recently'} · ${n.status || 'Sent'}</small></span></button>`).join('') : '<div class="notification-empty">No notifications yet.</div>'}<button type="button" class="notification-see-all" data-see-notifications>View notification center</button>`;
  document.body.appendChild(panel);
  document.querySelectorAll('.notification-bell').forEach(button=>button.setAttribute('aria-expanded','true'));
  panel.querySelector('[data-mark-notifications]').addEventListener('click', ()=>{
    void markAllAsRead();
    panel.remove();
    document.querySelectorAll('.notification-bell').forEach(button=>button.setAttribute('aria-expanded','false'));
  });
  panel.querySelectorAll('[data-notification-id]').forEach(item=>item.addEventListener('click', ()=>{
    readNotificationIds.add(item.dataset.notificationId);
    persistReadNotificationIds();
    refreshNotificationIndicators();
    item.classList.add('read');
  }));
  panel.querySelector('[data-see-notifications]').addEventListener('click', ()=>{
    panel.remove();
    showPage('notifications');
  });
}
['dashboard','stats','discipline','students','addstudent','violation','droplist','notifications','recommendations','certifications'].forEach(p=>{
  const sb = document.getElementById('sidebar-'+p);
  const tb = document.getElementById('topbar-'+p);
  if(sb) buildSidebar(sb, p);
  if(tb) buildTopbar(tb);
});

/* ---------------- MOBILE SIDEBAR (off-canvas) ---------------- */
function toggleSidebar(){
  const activeSidebar = document.querySelector('.page.active .sidebar');
  if(activeSidebar) activeSidebar.classList.toggle('open');
  const backdrop = document.getElementById('sidebarBackdrop');
  if(backdrop) backdrop.classList.toggle('show');
}
function closeSidebar(){
  document.querySelectorAll('.sidebar').forEach(sb=>sb.classList.remove('open'));
  const backdrop = document.getElementById('sidebarBackdrop');
  if(backdrop) backdrop.classList.remove('show');
}

/* ---------------- ROLE-BASED UI VISIBILITY ---------------- */
function applyRoleUI(){
  const role = rolePermissions(currentRole);
  const vis = (id, show) => { const el = document.getElementById(id); if(el) el.style.display = show ? '' : 'none'; };
  vis('dashBtnVoided', role.canVoid);
  vis('dashBtnStudents', role.pages.includes('students'));
  vis('dashBtnViolation', role.canRecord);
  vis('recordViolationBtn', role.canRecord);
  vis('voidedScholarshipBtn', role.canVoid);
  vis('studentsAddBtnRow', role.canEdit);
  vis('recommendFormCard', role.canSubmitRecommendation);
  applyRolePermissions(currentRole);
}

function showPage(pageId, e, presetFilter){
  if(e && e.preventDefault) e.preventDefault();

  const routeKey = pageId.replace(/^page-/, '');
  const role = rolePermissions(currentRole);
  const openPages = ['login','reset'];
  const editOnlyPages = {addstudent:true, violation:true};
  const pagePermissionKey = routeKey === 'violation' ? 'discipline' : routeKey;
  if(!openPages.includes(routeKey)){
    if(routeKey === 'violation' && !role.canRecord){
      showNotice('You do not have permission to record violations.', 'Access Denied');
      return;
    }
    if(editOnlyPages[routeKey] && routeKey !== 'violation' && !role.canEdit){
      showNotice('You do not have permission to access this page.', 'Access Denied');
      return;
    }
    if(routeKey !== 'notifications' && !editOnlyPages[routeKey] && !role.pages.includes(pagePermissionKey)){
      showNotice('You do not have permission to access this page.', 'Access Denied');
      return;
    }
  }

  const targetPage = document.getElementById(pageId) || document.getElementById('page-' + routeKey);
  if(!targetPage){
    const pageFile = pageRoutes[pageId] || pageRoutes[routeKey];
    if(pageFile){
      redirectIfNeeded(pageFile);
    }else{
      console.warn('Page not found in current document:', pageId);
    }
    return;
  }

  document.querySelectorAll('section, .page-content, .view-section, .page').forEach((p) => {
    p.classList.remove('active');
    p.style.display = 'none';
  });

  targetPage.classList.add('active');
  targetPage.style.display = 'block';

  if(routeKey !== 'login') sessionStorage.setItem('activePage', routeKey);

  document.querySelectorAll('.sidebar').forEach(sb=>buildSidebar(sb, pageId));
  document.querySelectorAll('.topbar').forEach(tb=>buildTopbar(tb));
  closeSidebar();
  applyRoleUI();

  if(pageId==='students') renderStudentTable();
  if(pageId==='droplist'){
    if(presetFilter){ document.getElementById('dropStatusFilter').value = isVoidStatus(presetFilter) ? 'Voided' : presetFilter; }
    renderDropTable();
  }
  if(pageId==='violation'){ setViolationMode('existing'); populateViolationStudentSelect(); }
  if(pageId==='dashboard' || pageId==='stats'){ renderStats(); }
  if(pageId==='notifications'){ renderNotifications(); }
  if(pageId==='recommendations'){ setRecommendMode('existing'); renderRecommendationsTable(); }
  if(pageId==='certifications'){ renderCertTable(); }
}

/* ---------------- HELPERS ---------------- */
function fullName(s){ return (s.firstName+' '+s.lastName).trim() || '(unnamed)'; }
function courseYear(s){ return [s.course, s.yearLevel, s.section].filter(Boolean).join(' '); }
function violationCount(s){ return s.violations.length; }
function isVoidStatus(status){ return status === 'VOID' || status === 'Voided'; }
function statusLabel(status){
  if(status === 'Dropped') return 'Dropped Out';
  if(isVoidStatus(status)) return 'Voided';
  return status || '-';
}
function studentStatusLabel(student){
  if(student?.status === 'Dropped' && student.droppedSubject){
    return `Dropped - ${student.droppedSubject}`;
  }
  return statusLabel(student?.status);
}
function setCurrentAcademicYear(){
  const yearElement = document.getElementById('currentAcademicYear');
  if(!yearElement) return;
  const currentYear = new Date().getFullYear();
  yearElement.textContent = `Academic Year: ${currentYear} - ${currentYear + 1}`;
}
// Dropped students are excluded from the active roster, all violation counts/stats, and search results.
function activeStudents(){ return students.filter(s=>s.status!=='Dropped' && s.status!=='Archived'); }
function statusDotClass(status){
  switch(status){
    case 'Active': return 'active';
    case 'Dropped': return 'dropped';
    case 'Suspended': return 'suspended';
    case 'For Dropout Review': return 'review';
    case 'Archived': return 'inactive';
    default: return 'inactive'; // Voided
  }
}
function matchesSearch(s, q){
  if(!q) return true;
  q = q.toLowerCase();
  return fullName(s).toLowerCase().includes(q) || (s.studentId||'').toLowerCase().includes(q);
}

/* ---------------- STUDENT LIST ---------------- */
function studentRowActions(s){
  const role = rolePermissions(currentRole);
  const normalizedRole = normalizeRole(currentRole);
  let btns = '';

  if(normalizedRole === 'guidance'){
    btns += `<button class="pill-btn blue small role-protected-write" onclick="startEditStudent(${s.uid})">edit</button>`;
    btns += `<button class="pill-btn gold small record-violation-btn" onclick="openViolationFor(${s.uid})">record violation</button>`;
  }else if(normalizedRole === 'faculty'){
    btns += `<button class="pill-btn gray small dropout-section" onclick="openRecommendFor(${s.uid})">recommend Dropout</button>`;
  }
  if(['guidance','faculty','academic','admin','registrar'].includes(normalizedRole)){
    btns += `<button class="pill-btn blue small" type="button" onclick="viewStudentInformation(${s.uid})">View Actions</button>`;
  }
  if(role.canVerify){
    btns += `<button class="pill-btn blue small certification-verify-btn" onclick="openCertificationFor(${s.uid})">Verify</button>`;
  }
  return btns || `<button class="pill-btn blue small" type="button" onclick="viewStudentInformation(${s.uid})">View Actions</button>`;
}

async function archiveStudent(uid){
  if(!rolePermissions(currentRole).canEdit){
    await showNotice('You do not have permission to archive student records.', 'Access Denied');
    return;
  }
  const student = students.find(item=>item.uid===uid);
  if(!student) return;
  if(!await confirmAction(`Archive the violation record for ${fullName(student)}?`, 'Archive Student Record')) return;
  student.status = 'Archived';
  student.archivedAt = new Date().toISOString();
  student.archivedBy = currentUser?.uid || currentRole;
  try{
    await updateFirestoreRecord('students', student);
    renderStudentTable();
    renderDropTable();
  }catch(error){
    console.error('Could not archive student:', error);
    await showNotice('The student record could not be archived. Please try again.', 'Archive Failed');
  }
}

function getStudentActionSummary(student){
  if(!student) return { timestamp:'-', actionTaken:'No guidance action recorded', date:'-', day:'-', history:'- No violations recorded.' };
  const timestamp = student.actionTakenAt ? new Date(student.actionTakenAt) : null;
  const dateText = timestamp ? timestamp.toISOString().slice(0,10) : '-';
  const dayText = timestamp ? new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(timestamp) : '-';
  const history = student.violations?.length
    ? student.violations.map(v=>{
        const occurredAtValue = v.occurredAt || v.timestamp || v.dateTime || '';
        const occurredAt = occurredAtValue ? new Date(occurredAtValue) : null;
        const occurredDate = v.date || (occurredAt ? occurredAt.toISOString().slice(0,10) : '-');
        const occurredTime = occurredAt ? occurredAt.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true}) : 'Time not recorded';
        const occurredDay = occurredAt ? new Intl.DateTimeFormat('en-US', {weekday:'long'}).format(occurredAt) : '-';
        return `<div class="violation-card"><div><span class="detail-label">Violation:</span><span class="detail-value">${v.category || 'Violation'}</span></div><div><span class="detail-label">Action:</span><span class="detail-value">${v.action || 'No action recorded'}</span></div><div><span class="detail-label">Date:</span><span class="detail-value">${occurredDate}</span></div><div><span class="detail-label">Time:</span><span class="detail-value">${occurredTime}</span></div><div><span class="detail-label">Day:</span><span class="detail-value">${occurredDay}</span></div></div>`;
      }).join('<br>')
    : '<div class="violation-card"><span class="detail-value">No violations recorded.</span></div>';
  return {
    timestamp: timestamp ? timestamp.toLocaleString() : 'Not available',
    actionTaken: student.actionTaken || 'No guidance action recorded',
    date: dateText,
    day: dayText,
    history,
  };
}

function viewStudentInformation(uid){
  const student = students.find(item=>item.uid===uid);
  if(!student) return;

  if(['guidance','faculty','academic','admin','registrar'].includes(normalizeRole(currentRole))){
    const actionSummary = getStudentActionSummary(student);
    showActionHistoryModal(student, actionSummary);
    return;
  }

  showNotice(`Name: ${fullName(student)}<br>Student ID: ${student.studentId||'-'}<br>Course/Year: ${courseYear(student)}<br>Status: ${studentStatusLabel(student)}<br>Violations: ${student.violations.length}`, 'Student Information');
}

async function markStudentViewed(uid){
  const student = students.find(item=>item.uid===uid);
  if(!student || normalizeRole(currentRole)!=='guidance') return;
  if(!await confirmAction(`Mark ${fullName(student)} as viewed?`, 'Confirm Student Review')) return;
  student.viewedAt = new Date().toISOString();
  student.viewedBy = currentUser?.uid || 'guidance';
  try{
    await updateFirestoreRecord('students', student);
    renderStudentTable();
  }catch(error){
    console.error('Could not mark student as viewed:', error);
    showNotice('The student could not be marked as viewed. Please try again.', 'Update Failed');
  }
}

async function recordActionTaken(uid){
  const student = students.find(item=>item.uid===uid);
  if(!student || normalizeRole(currentRole)!=='guidance') return;
  const action = await requestText('Enter the action taken for this student:', 'Action Taken', student.actionTaken || '');
  if(action === null) return;
  if(!await confirmAction(`Save this action for ${fullName(student)}?`, 'Confirm Action Taken')) return;
  student.actionTaken = action.trim();
  student.actionTakenAt = new Date().toISOString();
  try{
    await updateFirestoreRecord('students', student);
    renderStudentTable();
  }catch(error){
    console.error('Could not save action taken:', error);
    showNotice('The action taken could not be saved. Please try again.', 'Update Failed');
  }
}

function renderStudentTable(){
  const table = document.getElementById('studentTableWrap');
  const emptyNote = document.getElementById('studentEmptyNote');
  if(!table || !emptyNote) return;
  const q = document.getElementById('studentSearch').value;
  const sectionFilter = document.getElementById('studentSectionFilter').value;
  const yearLevelFilter = document.getElementById('studentYearLevelFilter').value;
  const courseFilter = document.getElementById('studentCourseFilter')?.value || '';

  let rows = activeStudents().filter(s=>matchesSearch(s,q) && (!sectionFilter || s.section===sectionFilter) && (!yearLevelFilter || s.yearLevel===yearLevelFilter) && (!courseFilter || s.course===courseFilter));

  table.innerHTML = '<tr><th>Name</th><th>School ID</th><th>Course/Year</th><th>Gender</th><th>Violation count</th><th>Actions</th></tr>';
  rows.forEach(s=>{
    const cnt = violationCount(s);
    const tone = cnt===0?'green':(cnt<3?'orange':'red');
    table.innerHTML += `<tr>
      <td>${fullName(s)}</td>
      <td>${s.studentId||'-'}</td>
      <td>${courseYear(s)}</td>
      <td>${s.gender||'-'}</td>
      <td><span class="tag ${tone}">${cnt}</span></td>
      <td class="row-actions">${studentRowActions(s)}</td>
    </tr>`;
  });
  emptyNote.style.display = rows.length===0 ? 'block' : 'none';
}

/* ---------------- ADD / EDIT STUDENT FORM ---------------- */
function clearStudentForm(){
  ['f_studentId','f_firstName','f_lastName','f_address','f_phone','f_parentName','f_parentPhone','guardianEmail','f_parentMessage'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('f_gender').value='';
  document.getElementById('f_course').value='BSIT';
  document.getElementById('f_yearLevel').value='1st Year';
  document.getElementById('f_section').value='A';
  document.getElementById('f_status').value='Active';
  document.querySelectorAll('#f_violationChecks input').forEach(c=>c.checked=false);
  document.getElementById('f_violationDate').value='';
  document.getElementById('f_violationAction').value='';
  document.getElementById('f_violationNotes').value='';
}
function startAddStudent(){
  if(!rolePermissions(currentRole).canEdit){
    showNotice('You do not have permission to add students.', 'Access Denied');
    return;
  }
  sessionStorage.removeItem('violationMode');
  editingUid = null;
  clearStudentForm();
  document.getElementById('addStudentTitle').textContent = 'ADD STUDENT';
  document.getElementById('addStudentSaveBtn').textContent = 'Add Student ✓';
  document.getElementById('printStudentBtn').style.display = 'none';
  document.getElementById('f_violationSection').style.display = 'block';
  document.getElementById('f_violationSectionLabel').style.display = 'block';
  showPage('addstudent');
}
function startEditStudent(uid){
  const s = students.find(x=>x.uid===uid);
  if(!s) return;
  if(!document.getElementById('page-addstudent')){
    window.location.href = 'addstudent.html?uid='+encodeURIComponent(uid)+'&mode=edit';
    return;
  }
  editingUid = uid;
  document.getElementById('f_studentId').value = s.studentId||'';
  document.getElementById('f_gender').value = s.gender||'';
  document.getElementById('f_firstName').value = s.firstName||'';
  document.getElementById('f_lastName').value = s.lastName||'';
  document.getElementById('f_address').value = s.address||'';
  document.getElementById('f_course').value = s.course||'BSIT';
  document.getElementById('f_yearLevel').value = s.yearLevel||'1st Year';
  document.getElementById('f_section').value = s.section||'A';
  document.getElementById('f_status').value = s.status||'Active';
  document.getElementById('f_phone').value = s.phone||'';
  document.getElementById('f_parentName').value = s.parentName||'';
  document.getElementById('f_parentPhone').value = s.parentPhone||'';
  document.getElementById('guardianEmail').value = s.guardianEmail||'';
  document.getElementById('f_parentMessage').value = s.parentMessage||'';
  document.querySelectorAll('#f_violationChecks input').forEach(c=>c.checked=false);
  document.getElementById('f_violationDate').value='';
  document.getElementById('f_violationAction').value='';
  document.getElementById('f_violationNotes').value='';
  document.getElementById('addStudentTitle').textContent = 'EDIT STUDENT';
  document.getElementById('addStudentSaveBtn').textContent = 'Save Changes ✓';
  document.getElementById('printStudentBtn').style.display = 'inline-block';
  // editing existing info should never add a violation — hide that section here
  document.getElementById('f_violationSection').style.display = 'none';
  document.getElementById('f_violationSectionLabel').style.display = 'none';
  showPage('addstudent');
}
async function saveStudentForm(){
  if(!rolePermissions(currentRole).canEdit){
    await showNotice('You do not have permission to edit students.', 'Access Denied');
    return;
  }
  const isEditing = !!editingUid;
  const data = {
    studentId: document.getElementById('f_studentId').value.trim(),
    gender: document.getElementById('f_gender').value,
    firstName: document.getElementById('f_firstName').value.trim(),
    lastName: document.getElementById('f_lastName').value.trim(),
    address: document.getElementById('f_address').value.trim(),
    course: document.getElementById('f_course').value,
    yearLevel: document.getElementById('f_yearLevel').value,
    section: document.getElementById('f_section').value,
    status: document.getElementById('f_status').value,
    phone: document.getElementById('f_phone').value.trim(),
    parentName: document.getElementById('f_parentName').value.trim(),
    parentPhone: document.getElementById('f_parentPhone').value.trim(),
    guardianEmail: document.getElementById('guardianEmail').value.trim(),
    parentMessage: document.getElementById('f_parentMessage').value.trim(),
  };
  if(!data.firstName || !data.lastName){
    await showNotice('Please enter at least a first and last name.', 'Missing Information');
    return;
  }
  if(!await confirmAction(`${isEditing ? 'Save changes to' : 'Add'} student ${data.firstName} ${data.lastName}?`, isEditing ? 'Confirm Student Update' : 'Confirm Student Creation')) return;
  let s;
  let savedViolationCount = 0;
  let savedViolationType = '';
  let previousStatus = '';
  if(isEditing){
    s = students.find(x=>x.uid===editingUid);
    previousStatus = s.status;
    Object.assign(s, data);
  } else {
    s = Object.assign({
      uid: uidCounter++,
      status: 'Active',
      voidedDate: '',
      violations: []
    }, data);
    students.push(s);
  }

  // optional initial violation on this form — only applies when creating a NEW student,
  // never when editing an existing student's info (edits must not change violation count)
  if(!isEditing){
    const checked = [...document.querySelectorAll('#f_violationChecks input:checked')].map(c=>c.value);
    if(checked.length){
      const date = document.getElementById('f_violationDate').value || new Date().toISOString().slice(0,10);
      const today = new Date().toISOString().slice(0,10);
      if(date > today){
        await showNotice('The violation date cannot be later than today.', 'Invalid Date');
        return;
      }
      const action = document.getElementById('f_violationAction').value;
      const notes = document.getElementById('f_violationNotes').value.trim();
      savedViolationType = checked.join(', ');
      // multiple violations chosen together still count as ONE violation record
      s.violations.push({date, occurredAt: new Date().toISOString(), category: checked.join(', '), action, notes});
      savedViolationCount = Math.min(s.violations.length, VIOLATION_LIMIT);
      if(action === 'Scholarship Voided'){ await voidScholarship(s, date); }
      await checkViolationThresholds(s, date);
    }
  }

  try{
    if(isEditing) await updateFirestoreRecord('students', s);
    else await addFirestoreRecord('students', s);
  }catch(error){
    console.error('Could not save student:', error);
    await showNotice('The student could not be saved to Firestore. Please try again.', 'Save Failed');
    return;
  }
  if(data.status !== previousStatus && ['Dropped','Suspended','VOID','Voided','Dropped Out'].includes(data.status)){
    await notifyAdminOnStatusChange(s, data.status, 'Action Needed');
  }
  if(savedViolationType){
    await dispatchViolationNotifications(s, savedViolationType, savedViolationCount);
  }
  editingUid = null;
  showPage('students');
}
async function notifyAdminOnStatusChange(student, newStatus, label='Status Update'){
  if(!student) return;
  const normalizedStatus = String(newStatus).trim().toLowerCase();
  if(!['dropped','dropped out','suspended','void','voided'].includes(normalizedStatus)) return;
  const typeLabel = normalizedStatus === 'dropped' || normalizedStatus === 'dropped out'
    ? 'Dropped Out'
    : normalizedStatus === 'suspended' ? 'Suspended' : 'Voided';
  await logNotification({
    uid: student.uid,
    student: fullName(student),
    studentId: student.studentId || '-',
    type: typeLabel,
    date: new Date().toISOString().slice(0,10),
    recipients: 'School Administrator',
    recipientRoles: ['admin'],
    channel: 'In-app',
    status: label
  });
}

async function voidScholarship(s, date){
  if(isVoidStatus(s.status)) return; // already voided — avoid duplicate notifications
  s.status = 'VOID';
  s.voidedDate = date || new Date().toISOString().slice(0,10);
  await logViolationNotification(s, 'VOID', s.voidedDate);
  await notifyAdminOnStatusChange(s, 'VOID', 'Action Needed');
}
async function checkViolationThresholds(s, date){
  const count = s.violations.length;
  if(count === WARNING_LIMIT){
    await logViolationNotification(s, 'Warning', date);
  }
  if(count >= VIOLATION_LIMIT){
    await voidScholarship(s, date);
  }
}

/* ---------------- RECORD VIOLATION ---------------- */
async function handleViolationSubmit(event){
  event.preventDefault();
  await handleViolationSave(event);
}

async function handleViolationSave(event){
  event.preventDefault();
  const shouldPrint = event.submitter?.dataset.print === 'true';
  await saveViolation(shouldPrint);
}

function setViolationMode(mode){
  violationMode = mode;
  if(window.Alpine?.store('violation')){
    window.Alpine.store('violation').mode = mode;
    window.Alpine.store('violation').nextCount = 0;
  }
  if(mode==='new'){
    ['v_new_studentId','v_new_firstName','v_new_lastName','v_new_phone','v_new_parentName','v_new_parentPhone','guardianEmail','v_new_address','v_existing_guardianEmail'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('v_new_gender').value='';
    document.getElementById('v_new_course').value='BSIT';
    document.getElementById('v_new_yearLevel').value='1st Year';
    document.getElementById('v_new_section').value='A';
  } else {
    document.getElementById('v_studentSearch').value='';
    document.getElementById('v_studentSelect').value='';
    document.getElementById('v_studentResults').innerHTML='';
    fillViolationReadonly();
  }
}
window.setViolationMode = setViolationMode;
function populateViolationStudentSelect(preselectUid){
  document.getElementById('v_studentSearch').value='';
  document.getElementById('v_studentSelect').value = preselectUid || '';
  document.getElementById('v_studentResults').innerHTML='';
  if(preselectUid){
    const s = students.find(x=>x.uid===Number(preselectUid));
    if(s) document.getElementById('v_studentSearch').value = fullName(s)+' ('+(s.studentId||'no ID')+')';
  }
  if(window.Alpine?.store('violation')){
    const selected = students.find(x=>x.uid===Number(preselectUid));
    window.Alpine.store('violation').nextCount = selected ? selected.violations.length + 1 : 0;
  }
  fillViolationReadonly();
}
function renderViolationSearchResults(){
  const q = document.getElementById('v_studentSearch').value.trim();
  const box = document.getElementById('v_studentResults');
  if(!q){ box.innerHTML=''; return; }
  const matches = activeStudents().filter(s=>matchesSearch(s,q)).slice(0,8);
  if(matches.length===0){
    box.innerHTML = '<div class="empty-note">No matching students.</div>';
    return;
  }
  box.innerHTML = matches.map(s=>`
    <div style="padding:7px 8px;border-bottom:1px solid #f0f3f8;cursor:pointer;font-size:12.5px;" onclick="pickViolationStudent(${s.uid})">
      <b>${fullName(s)}</b> — ${s.studentId||'no ID'} · ${courseYear(s)}
    </div>`).join('');
}
function pickViolationStudent(uid){
  const s = students.find(x=>x.uid===uid);
  if(!s) return;
  document.getElementById('v_studentSelect').value = uid;
  document.getElementById('v_studentSearch').value = fullName(s)+' ('+(s.studentId||'no ID')+')';
  document.getElementById('v_studentResults').innerHTML='';
  if(window.Alpine?.store('violation')) window.Alpine.store('violation').nextCount = s.violations.length + 1;
  fillViolationReadonly();
}
window.nextViolationCount = function(){
  const uid = Number(document.getElementById('v_studentSelect')?.value);
  const student = students.find(item => item.uid === uid);
  return student ? student.violations.length + 1 : 0;
};
function openViolationFor(uid){
  if(!document.getElementById('page-violation')){
    window.location.href = 'violation.html?uid='+encodeURIComponent(uid);
    return;
  }
  showPage('violation');
  setViolationMode('existing');
  populateViolationStudentSelect(uid);
}
function fillViolationReadonly(){
  const uid = Number(document.getElementById('v_studentSelect').value);
  const box = document.getElementById('violationReadonly');
  const s = students.find(x=>x.uid===uid);
  const emailField = document.getElementById('v_existing_guardianEmail');
  if(!s){
    box.innerHTML = '<div class="empty-note">Search and select a student above to see their details.</div>';
    if(emailField) emailField.value = '';
    return;
  }
  if(emailField) emailField.value = s.guardianEmail || '';
  box.innerHTML = `
    <div class="ro-field"><div class="l">Name</div><div class="v">${fullName(s)}</div></div>
    <div class="ro-field"><div class="l">Parent/Guardian's name</div><div class="v">${s.parentName||'-'}</div></div>
    <div class="ro-field"><div class="l">Course/Year</div><div class="v">${courseYear(s)}</div></div>
    <div class="ro-field"><div class="l">Phone</div><div class="v">${s.phone||'-'}</div></div>
    <div class="ro-field"><div class="l">Address</div><div class="v">${s.address||'-'}</div></div>
    <div class="ro-field"><div class="l">Parent/Guardian Phone</div><div class="v">${s.parentPhone||'-'}</div></div>
  `;
}
async function saveViolation(andPrint){
  if(!rolePermissions(currentRole).canRecord){
    await showNotice('You do not have permission to record violations.', 'Access Denied');
    return;
  }
  let s;
  let isNewStudent = violationMode === 'new';
  if(violationMode==='new'){
    const firstName = document.getElementById('v_new_firstName').value.trim();
    const lastName = document.getElementById('v_new_lastName').value.trim();
    if(!firstName || !lastName){
      await showNotice('Please enter at least a first and last name for the new student.', 'Missing Information');
      return;
    }
    s = {
      uid: uidCounter++,
      studentId: document.getElementById('v_new_studentId').value.trim(),
      gender: document.getElementById('v_new_gender').value,
      firstName, lastName,
      course: document.getElementById('v_new_course').value,
      yearLevel: document.getElementById('v_new_yearLevel').value,
      section: document.getElementById('v_new_section').value,
      phone: document.getElementById('v_new_phone').value.trim(),
      address: document.getElementById('v_new_address').value.trim(),
      parentName: document.getElementById('v_new_parentName').value.trim(),
      parentPhone: document.getElementById('v_new_parentPhone').value.trim(),
      guardianEmail: document.getElementById('guardianEmail').value.trim(),
      parentMessage: '',
      status: 'Active',
      voidedDate: '',
      violations: []
    };
    const enteredStudentId = String(s.studentId || '').trim();
    if(enteredStudentId){
      const matchingStudent = students
        .filter(student=>String(student.studentId || '').trim() === enteredStudentId)
        .sort((left,right)=>(right.violations?.length || 0) - (left.violations?.length || 0))[0];
      if(matchingStudent){
        const enteredGuardianEmail = s.guardianEmail;
        s = matchingStudent;
        s.guardianEmail = enteredGuardianEmail || s.guardianEmail || s.parentEmail || '';
        isNewStudent = false;
        console.log('Student ID already exists; using the saved student violation history.');
      }
    }
  } else {
    const uid = Number(document.getElementById('v_studentSelect').value);
    s = students.find(x=>x.uid===uid);
    if(!s){ await showNotice('Please search and select a student first.', 'Missing Student'); return; }
    s.guardianEmail = document.getElementById('v_existing_guardianEmail')?.value.trim() || s.guardianEmail || '';
  }

  const studentId = String(s.studentId || '').trim();
  const fs = firestoreApi();
  let storedViolationCount = Array.isArray(s.violations) ? s.violations.length : 0;
  const studentDocumentId = s.firestoreId || studentId;
  if(studentDocumentId && fs?.getDoc && fs?.doc){
    try{
      const studentSnapshot = await fs.getDoc(fs.doc(window.db, 'students', studentDocumentId));
      if(studentSnapshot.exists()){
        const storedStudent = studentSnapshot.data() || {};
        if(Array.isArray(storedStudent.violations)){
          s.violations = storedStudent.violations;
          storedViolationCount = storedStudent.violations.length;
        }else{
          storedViolationCount = Number(storedStudent.violationCount || 0);
        }
        if(storedViolationCount >= VIOLATION_LIMIT){
          await showNotice('Student has reached the maximum cap of 5 violations.', 'Violation Limit Reached');
          return;
        }
      }
    }catch(error){
      console.error('Could not verify the student violation count:', error);
    }
  }

  if(storedViolationCount >= VIOLATION_LIMIT || (s.violations || []).length >= VIOLATION_LIMIT){
    await showNotice('Student has reached the maximum cap of 5 violations.', 'Violation Limit Reached');
    return;
  }

  const categories = [...document.querySelectorAll('#v_categoryChecks input:checked')].map(c=>c.value);
  if(categories.length===0){
    await showNotice('Please choose at least one violation.', 'Missing Violation');
    return;
  }
  const date = document.getElementById('v_date').value || new Date().toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  if(date > today){
    await showNotice('The violation date cannot be later than today.', 'Invalid Date');
    return;
  }
  const action = document.getElementById('v_action').value;
  const notes = document.getElementById('v_notes').value.trim();
  const concern = document.getElementById('v_parentConcern')?.value.trim() || '';
  const existingViolations = s.violations || [];
  const updatedViolationCount = Math.max(existingViolations.length, storedViolationCount) + 1;
  console.log('=== RECORDING VIOLATION ===');
  console.log('Student:', fullName(s));
  console.log('Calculated New Count:', updatedViolationCount);
  console.log('Guardian Email Found:', s.guardianEmail || s.parentEmail);
  if(updatedViolationCount === 4 && !concern){
    await showNotice('Please enter the concern that should be sent to the parent or guardian.', 'Concern Required');
    return;
  }
  if(!await confirmAction(`Record ${categories.join(', ')} for ${fullName(s)}?`, 'Confirm Violation', async ()=>{
    const currentViolations = s.violations || [];
    const newCount = Math.max(currentViolations.length, storedViolationCount) + 1;
    const recipient = String(s.guardianEmail || s.parentEmail || '').trim();
    if(newCount !== 4) return;
    if(!recipient){
      console.warn('Fourth violation reached without a guardian email; email was not sent.');
      return;
    }

    const targetEmail = recipient;
    const payload = {
      user_id: 'I2Mb3rIA5Q_owv9ry',
      service_id: 'service_l85mxv9',
      template_id: 'template_t3zh2eo',
      template_params: {
        to_email: targetEmail,
        email: targetEmail,
        guardian_email: targetEmail,
        student_name: s.name || fullName(s) || 'Student',
        student_id: s.studentId || 'N/A',
        message: '4th School Violation Warning: Student has accumulated 4 school violations.',
        date_logged: new Date().toLocaleDateString()
      }
    };

    console.log('--> SENDING EMAILJS VIA FETCH TO:', targetEmail);
    try{
      console.log('--> EXECUTING EMAILJS FETCH NOW...');
      const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const text = await response.text();
      if(response.ok){
        console.log('--> EMAILJS SUCCESS:', text);
        alert('SUCCESS! 4th Violation Email delivered to: ' + targetEmail);
      }else{
        console.error('--> EMAILJS FAILED:', response.status, text);
        alert('EmailJS Delivery Failed (' + response.status + '): ' + text);
      }
    }catch(error){
      console.error('--> FETCH ERROR:', error);
      alert('Network Error: ' + error.message);
    }
  })) return;
  if(isNewStudent) students.push(s);
  // multiple violations chosen together still count as ONE violation record
  const newViolation = {date, occurredAt: new Date().toISOString(), category: categories.join(', '), action, notes, concern};
  s.violations.push(newViolation);
  const currentCount = Math.min(s.violations.length, VIOLATION_LIMIT);
  s.status = action === 'Suspension' ? 'Suspended' : 'Active';
  if(action === 'Suspension'){
    await notifyAdminOnStatusChange(s, 'Suspended', 'Action Needed');
  }
  document.getElementById('studentId').value = s.studentId || '';
  document.getElementById('studentName').value = fullName(s);
  document.getElementById('violationType').value = newViolation.category;
  document.getElementById('guardianPhone').value = s.parentPhone || '';
  if(action === 'Scholarship Voided'){
    await voidScholarship(s, date);
  }
  await checkViolationThresholds(s, date);

  document.getElementById('v_date').value='';
  document.getElementById('v_notes').value='';
  if(document.getElementById('v_parentConcern')) document.getElementById('v_parentConcern').value='';
  document.querySelectorAll('#v_categoryChecks input').forEach(c=>c.checked=false);

  if(andPrint) printViolationSlip(s.uid, [newViolation]);
  try{
    if(s.firestoreId) await updateFirestoreRecord('students', s);
    else await addFirestoreRecord('students', s);
  }catch(error){
    console.error('Could not save violation:', error);
    await showNotice('The violation could not be saved to Firestore. Please try again.', 'Save Failed');
    return;
  }
  showPage('students');
}

function bindViolationForm(){
  // Alpine owns the violation form submit event on the standalone page.
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', bindViolationForm, {once:true});
}else{
  bindViolationForm();
}
/* ---------------- STUDENT STATUS LIST ---------------- */
function renderDropTable(){
  const table = document.getElementById('dropTableWrap');
  const emptyNote = document.getElementById('dropEmptyNote');
  if(!table || !emptyNote) return;
  const q = document.getElementById('dropSearch').value;
  const statusFilter = document.getElementById('dropStatusFilter').value;
  const matchesStatus = student => !statusFilter
    || (statusFilter === 'Voided' ? isVoidStatus(student.status) : student.status === statusFilter);
  let rows = students.filter(s=>matchesSearch(s,q) && matchesStatus(s));
  table.innerHTML = '<tr><th>Student ID</th><th>Student Name</th><th>Course/Year</th><th>Gender</th><th>Status</th></tr>';
  rows.forEach(s=>{
    const dotClass = statusDotClass(s.status);
    table.innerHTML += `<tr><td>${s.studentId||'-'}</td><td>${fullName(s)}</td><td>${courseYear(s)}</td><td>${s.gender||'-'}</td><td><span class="status-dot ${dotClass}"></span>${studentStatusLabel(s)}</td></tr>`;
  });
  emptyNote.style.display = rows.length===0 ? 'block' : 'none';
}

/* ---------------- DASHBOARD ---------------- */
function renderDashboard(){
  const chartBox = document.getElementById('dashLineChart');
  if(!chartBox) return;
  const totalViolations = activeStudents().reduce((a,s)=>a+s.violations.length,0);
  if(totalViolations===0){
    chartBox.innerHTML = '<div class="empty-note">No violations recorded yet. Once you record violations, trends will appear here.</div>';
  } else {
    chartBox.innerHTML = buildMonthlyLineSVG();
  }
  const top = document.getElementById('dashTopOffenders');
  const ranked = activeStudents().filter(s=>s.violations.length>0).sort((a,b)=>b.violations.length-a.violations.length).slice(0,5);
  if(ranked.length===0){
    top.innerHTML = '<div class="empty-note">No violators yet.</div>';
  } else {
    const max = ranked[0].violations.length;
    top.innerHTML = ranked.map(s=>{
      const initials = ((s.firstName[0]||'')+(s.lastName[0]||'')).toUpperCase();
      const pct = Math.round((s.violations.length/max)*100);
      return `<div class="off-row"><div class="avatar">${initials}</div><div style="width:110px">${fullName(s)}</div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div><b>${s.violations.length}</b></div>`;
    }).join('');
  }
}

/* ---------------- STATS PAGE ---------------- */
function allViolationsFlat(list){
  let out = [];
  (list||activeStudents()).forEach(s=>{
    s.violations.forEach(v=>out.push(Object.assign({student:s}, v)));
  });
  return out.sort((a,b)=> new Date(b.date) - new Date(a.date));
}
function buildMonthlyLineSVG(list){
  const flat = allViolationsFlat(list);
  const counts = new Array(12).fill(0);
  flat.forEach(v=>{
    const d = new Date(v.date);
    if(!isNaN(d)) counts[d.getMonth()]++;
  });
  const max = Math.max(...counts,1);
  const pts = counts.map((c,i)=>{
    const x = (i/11)*380+10;
    const y = 100 - (c/max)*80;
    return x+','+y;
  }).join(' ');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `<svg viewBox="0 0 400 115" width="100%" height="115">
    <polyline fill="none" stroke="#1560c4" stroke-width="2.5" points="${pts}"/>
    <text x="0" y="112" font-size="8" fill="#9aa4bb">${months[0]}</text>
    <text x="365" y="112" font-size="8" fill="#9aa4bb">${months[11]}</text>
  </svg>`;
}
function renderStats(){
  if(!document.getElementById('statsDeptFilter')) return;
  const deptFilter = document.getElementById('statsDeptFilter').value;
  const scoped = activeStudents().filter(s=>!deptFilter || s.course===deptFilter);

  const totalViolations = scoped.reduce((a,s)=>a+s.violations.length,0);
  const repeatOffenders = scoped.filter(s=>s.violations.length>1).length;
  const voided = students.filter(s=>isVoidStatus(s.status) && (!deptFilter || s.course===deptFilter)).length;
  const actionsTaken = scoped.reduce((a,s)=>a + s.violations.filter(v=>v.action).length, 0);

  document.getElementById('kpiTotal').textContent = totalViolations;
  document.getElementById('kpiRepeat').textContent = repeatOffenders;
  document.getElementById('kpiVoided').textContent = voided;
  document.getElementById('kpiActions').textContent = actionsTaken;

  // donut of categories
  const donutBox = document.getElementById('donutWrap');
  const flat = allViolationsFlat(scoped);
  if(flat.length===0){
    donutBox.innerHTML = '<div class="empty-note">No violations recorded yet — the breakdown will appear once you record some.</div>';
  } else {
    const byCat = {};
    flat.forEach(v=>{ byCat[v.category] = (byCat[v.category]||0)+1; });
    const colors = ['#1560c4','#ff9d2e','#ff5a9e','#2fb35b','#8a63d2','#e6483c'];
    const cats = Object.keys(byCat);
    let offset = 0;
    const total = flat.length;
    let circles = '';
    let legend = '';
    cats.forEach((cat,i)=>{
      const pct = (byCat[cat]/total)*100;
      circles += `<circle cx="18" cy="18" r="15.9" fill="none" stroke="${colors[i%colors.length]}" stroke-width="4" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="${-offset}"></circle>`;
      offset += pct;
      legend += `<div class="li"><span class="sw" style="background:${colors[i%colors.length]}"></span>${cat} — ${Math.round(pct)}%</div>`;
    });
    donutBox.innerHTML = `<div class="donut-wrap">
      <svg width="120" height="120" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#eef2f7" stroke-width="4"></circle>
        ${circles}
      </svg>
      <div class="legend">${legend}</div>
    </div>`;
  }

  // line chart
  document.getElementById('statsLineChart').innerHTML = totalViolations===0
    ? '<div class="empty-note">No data yet.</div>'
    : buildMonthlyLineSVG(scoped);

  // recent violations
  const recentBox = document.getElementById('recentViolations');
  if(flat.length===0){
    recentBox.innerHTML = '<div class="empty-note">No violations recorded yet.</div>';
  } else {
    let rows = '<table><tr><th>ID</th><th>Student Name</th><th>Category</th><th>Date</th></tr>';
    flat.slice(0,6).forEach(v=>{
      rows += `<tr><td>${v.student.studentId||'-'}</td><td>${fullName(v.student)}</td><td>${v.category}</td><td>${v.date}</td></tr>`;
    });
    rows += '</table>';
    recentBox.innerHTML = rows;
  }

  // top offenders
  const topBox = document.getElementById('statsTopOffenders');
  const ranked = scoped.filter(s=>s.violations.length>0).sort((a,b)=>b.violations.length-a.violations.length).slice(0,5);
  if(ranked.length===0){
    topBox.innerHTML = '<div class="empty-note">No offenders yet.</div>';
  } else {
    const max = ranked[0].violations.length;
    topBox.innerHTML = ranked.map(s=>{
      const initials = ((s.firstName[0]||'')+(s.lastName[0]||'')).toUpperCase();
      const pct = Math.round((s.violations.length/max)*100);
      return `<div class="off-row"><div class="avatar">${initials}</div><div style="width:110px">${fullName(s)}</div><div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div><b>${s.violations.length}</b></div>`;
    }).join('');
  }
}

/* ---------------- NOTIFICATIONS (simulated SMS / Email) ---------------- */
async function logNotification(opts){
  const notification = {
    uid: opts.uid,
    student: opts.student,
    studentId: opts.studentId || '-',
    type: opts.type,
    date: opts.date || new Date().toISOString().slice(0,10),
    recipients: opts.recipients,
    recipientRoles: opts.recipientRoles || null,
    channel: opts.channel,
    status: opts.status || 'Sent'
  };
  notifications.unshift(notification);
  try{
    await addFirestoreRecord('notifications', notification);
  }catch(error){
    console.error('Could not save notification:', error);
  }
  refreshNotificationIndicators();
  renderNotifications();
}
async function logViolationNotification(s, type, date){
  await logNotification({
    uid: s.uid,
    student: fullName(s),
    studentId: s.studentId || '-',
    type,
    date,
    recipients: 'Student & Parent/Guardian',
    channel: s.parentPhone ? 'SMS + Email (if on file)' : 'SMS',
    status: 'Sent'
  });
}
function notifTypeInfo(type){
  switch(type){
    case 'VOID':
      return {tone:'red', label:'Void Status (5 violations)'};
    case 'Warning': return {tone:'orange', label:'Warning (4 violations)'};
    case 'Recommendation Submitted':
    case 'Dropout Recommendation Submitted': return {tone:'blue', label:'Dropout Recommendation Submitted'};
    case 'Recommendation Approved': return {tone:'red', label:'Dropout Recommendation Approved'};
    case 'Dropout Finalized': return {tone:'red', label:'Dropout Finalized'};
    case 'Dropped Out': return {tone:'red', label:'Dropped Out'};
    case 'Suspended': return {tone:'orange', label:'Suspended'};
    case 'Voided': return {tone:'red', label:'Voided'};
    case 'Dropout Recommendation Rejected': return {tone:'red', label:'Dropout Recommendation Rejected'};
    default: return {tone:'gray', label:type};
  }
}
function sortNotificationsByNewest(items){
  return [...items].sort((a,b)=>{
    const aTime = new Date(a.createdAt || a.date || 0).getTime();
    const bTime = new Date(b.createdAt || b.date || 0).getTime();
    return Number.isFinite(bTime) && Number.isFinite(aTime) ? bTime - aTime : 0;
  });
}
function renderNotifications(){
  const table = document.getElementById('notificationsTableWrap');
  if(!table) return;
  const emptyNote = document.getElementById('notificationsEmptyNote');
  table.innerHTML = '<tr><th>Date</th><th>Student</th><th>Type</th><th>Recipients</th><th>Channel</th><th>Status</th></tr>';
  const visibleNotifications = sortNotificationsByNewest(notifications.filter(n=>{
    return !n.recipientRoles || n.recipientRoles.includes(currentRole);
  }));
  visibleNotifications.forEach(n=>{
    const info = notifTypeInfo(n.type);
    table.innerHTML += `<tr>
      <td>${n.date}</td>
      <td>${n.student} <span style="color:var(--muted);font-size:10.5px;">(${n.studentId})</span></td>
      <td><span class="tag ${info.tone}">${info.label}</span></td>
      <td>${n.recipients}</td>
      <td>${n.channel}</td>
      <td><span class="tag green">${n.status}</span></td>
    </tr>`;
  });
  if(emptyNote) emptyNote.style.display = visibleNotifications.length===0 ? 'block' : 'none';
}

/* ---------------- DROPOUT RECOMMENDATIONS (Faculty -> Guidance/Registrar) ---------------- */
let recommendMode = 'existing'; // 'existing' or 'new' (student with no record yet)
function setRecommendMode(mode){
  recommendMode = mode;
  document.getElementById('recModeBtnExisting').classList.toggle('active', mode==='existing');
  document.getElementById('recModeBtnNew').classList.toggle('active', mode==='new');
  document.getElementById('recExistingBlock').style.display = mode==='existing' ? 'block' : 'none';
  document.getElementById('recNewBlock').style.display = mode==='new' ? 'block' : 'none';
  document.getElementById('rec_studentSearch').value='';
  document.getElementById('rec_studentSelect').value='';
  document.getElementById('rec_studentResults').innerHTML='';
  document.getElementById('recommendReadonly').innerHTML='';
  document.getElementById('rec_new_name').value='';
  document.getElementById('rec_new_course').value='BSIT';
  document.getElementById('rec_new_yearLevel').value='1st Year';
  document.getElementById('rec_new_section').value='A';
}
function openRecommendFor(uid){
  if(!document.getElementById('page-recommendations')){
    window.location.href = 'recommendations.html?uid='+encodeURIComponent(uid);
    return;
  }
  showPage('recommendations');
  setRecommendMode('existing');
  pickRecommendStudent(uid);
}
function renderRecommendSearchResults(){
  const q = document.getElementById('rec_studentSearch').value.trim();
  const box = document.getElementById('rec_studentResults');
  if(!q){ box.innerHTML=''; return; }
  const matches = activeStudents().filter(s=>matchesSearch(s,q)).slice(0,8);
  if(matches.length===0){
    box.innerHTML = '<div class="empty-note">No matching students.</div>';
    return;
  }
  box.innerHTML = matches.map(s=>`
    <div style="padding:7px 8px;border-bottom:1px solid #f0f3f8;cursor:pointer;font-size:12.5px;" onclick="pickRecommendStudent(${s.uid})">
      <b>${fullName(s)}</b> — ${s.studentId||'no ID'} · ${courseYear(s)}
    </div>`).join('');
}
function pickRecommendStudent(uid){
  const s = students.find(x=>x.uid===uid);
  if(!s) return;
  document.getElementById('rec_studentSelect').value = uid;
  document.getElementById('rec_studentSearch').value = fullName(s)+' ('+(s.studentId||'no ID')+')';
  document.getElementById('rec_studentResults').innerHTML='';
  document.getElementById('recommendReadonly').innerHTML = `
    <div class="ro-field"><div class="l">Name</div><div class="v">${fullName(s)}</div></div>
    <div class="ro-field"><div class="l">Course/Year</div><div class="v">${courseYear(s)}</div></div>
    <div class="ro-field"><div class="l">Violation Count</div><div class="v">${s.violations.length}</div></div>
    <div class="ro-field"><div class="l">Status</div><div class="v">${s.status}</div></div>
  `;
}
async function recommendationExistsForStudent(student){
  const matchesStudent = recommendation => {
    const sameUid = Number(recommendation.uid) === Number(student.uid);
    const sameStudentId = student.studentId && recommendation.studentId
      && String(recommendation.studentId).trim() === String(student.studentId).trim();
    return sameUid || sameStudentId;
  };
  if(recommendations.some(matchesStudent)) return true;

  const fs = firestoreApi();
  if(!fs?.getDocs || !fs?.collection) return false;
  try{
    const snapshot = await fs.getDocs(fs.collection(window.db, 'dropout_recommendations'));
    return snapshot.docs.some(record => matchesStudent(record.data() || {}));
  }catch(error){
    console.error('Could not verify existing recommendations:', error);
    throw new Error('The existing recommendation could not be verified. Please try again.');
  }
}
async function submitRecommendation(){
  if(!rolePermissions(currentRole).canSubmitRecommendation){
    await showNotice('You do not have permission to submit dropout recommendations.', 'Access Denied');
    return;
  }
  const facultyName = document.getElementById('rec_facultyName').value.trim();
  const subject = document.getElementById('rec_subject').value.trim();
  const reason = document.getElementById('rec_reason').value.trim();
  let s;

  if(recommendMode === 'new'){
    const name = document.getElementById('rec_new_name').value.trim();
    const course = document.getElementById('rec_new_course').value;
    const yearLevel = document.getElementById('rec_new_yearLevel').value;
    const section = document.getElementById('rec_new_section').value;
    if(!name){ await showNotice("Please enter the student's name.", 'Missing Information'); return; }
    const parts = name.split(' ');
    const firstName = parts.shift();
    const lastName = parts.join(' ');
    s = {
      uid: uidCounter++, studentId:'', gender:'', firstName, lastName,
      course, yearLevel, section, phone:'', address:'',
      parentName:'', parentPhone:'', parentMessage:'',
      status:'Active', voidedDate:'', violations:[]
    };
  } else {
    const uid = Number(document.getElementById('rec_studentSelect').value);
    s = students.find(x=>x.uid===uid);
    if(!s){ await showNotice('Please search and select a student first.', 'Missing Student'); return; }
  }

  if(!facultyName || !subject || !reason || reason.length < 10){ await showNotice('Please enter the faculty name, affected subject, and a specific reason of at least 10 characters.', 'Missing Information'); return; }
  try{
    if(await recommendationExistsForStudent(s)){
      await showNotice('A dropout recommendation already exists for this student. A second recommendation cannot be added.', 'Recommendation Already Exists');
      return;
    }
  }catch(error){
    await showNotice(error.message, 'Verification Failed');
    return;
  }
  if(!await confirmAction(`Submit a dropout recommendation for ${fullName(s)}?`, 'Confirm Recommendation')) return;
  if(recommendMode === 'new'){
    try{
      await addFirestoreRecord('students', s);
    }catch(error){
      console.error('Could not save recommendation student:', error);
      await showNotice('The student could not be saved to Firestore. Please try again.', 'Save Failed');
      return;
    }
  }
  const recommendation = {
    uid: s.uid,
    student: fullName(s),
    studentId: s.studentId || '',
    subject,
    facultyName,
    reason,
    date: new Date().toISOString().slice(0,10),
    status: 'Pending Review',
    submittedByRole: normalizeRole(currentRole),
  };
  try{
    await addFirestoreRecord('dropout_recommendations', recommendation);
  }catch(error){
    console.error('Could not save recommendation:', error);
    await showNotice('The recommendation could not be saved to Firestore. Please try again.', 'Save Failed');
    return;
  }
  await logNotification({
    uid: s.uid,
    student: fullName(s),
    studentId: s.studentId || '-',
    type: 'Dropout Recommendation Submitted',
    date: new Date().toISOString().slice(0,10),
    recipients: 'Guidance Counselor & Academic Head',
    recipientRoles: ['guidance','academic'],
    channel: 'In-app',
    status: 'New'
  });
  setRecommendMode('existing');
  document.getElementById('rec_facultyName').value='';
  document.getElementById('rec_subject').value='';
  document.getElementById('rec_reason').value='';
  renderRecommendationsTable();
  renderStudentTable();
  await showNotice('Recommendation submitted for review.', 'Recommendation Submitted');
}
function renderRecommendationsTable(){
  const table = document.getElementById('recommendationsTableWrap');
  if(!table) return;
  const emptyNote = document.getElementById('recommendationsEmptyNote');
  const normalizedRole = normalizeRole(currentRole);
  const yearFilter = document.getElementById('recommendationYearFilter')?.value || '';
  const courseFilter = document.getElementById('recommendationCourseFilter')?.value || '';
  const rows = recommendations.filter(recommendation=>{
    const student = students.find(item=>Number(item.uid)===Number(recommendation.uid));
    const isGuidanceView = normalizedRole === 'guidance';
    const allowedGuidanceStatuses = ['Pending Review', 'Approved', 'Rejected'];
    const isAllowedStatus = !isGuidanceView || allowedGuidanceStatuses.includes(recommendation.status);
    return isAllowedStatus && (!yearFilter || student?.yearLevel===yearFilter) && (!courseFilter || student?.course===courseFilter);
  });
  const finalActionHeader = normalizedRole === 'registrar' ? '<th>Final Action</th>' : '';
  table.innerHTML = `<tr><th>Date</th><th>Student</th><th>Subject</th><th>Submitted By</th><th>Reason</th><th>Status</th><th>Actions</th>${finalActionHeader}</tr>`;
  rows.forEach(r=>{
    const tone = r.status==='Approved' ? 'green' : (r.status==='Rejected' ? 'red' : (r.status==='Finalized' ? 'red' : 'orange'));
    const student = students.find(item=>Number(item.uid)===Number(r.uid));
    let actions = `<button class="pill-btn blue small" onclick="viewRecommendation('${r.id}')">View Details</button>`;
    if(normalizeRole(currentRole)==='guidance' && r.status==='Pending Review'){
      actions = `<div class="row-actions">
        <button class="pill-btn blue small" onclick="viewRecommendation('${r.id}')">View Details</button>
        <button type="button" class="btn btn-approve-forward" onclick="updateRecommendationStatus('${r.id}','Approved')">Approve &amp; Forward</button>
        <button class="pill-btn red small" onclick="updateRecommendationStatus('${r.id}','Rejected')">Reject</button>
      </div>`;
    }
    const finalAction = normalizedRole === 'registrar'
      ? `<td>${r.status==='Approved' && student && student.status !== 'Dropped' ? `<button class="pill-btn red small" onclick="finalizeDropout('${r.id}')">Finalize</button>` : ''}</td>`
      : '';
    table.innerHTML += `<tr>
      <td>${r.date}</td>
      <td>${r.student}</td>
      <td>${r.subject || '-'}</td>
      <td>${r.facultyName}</td>
      <td>${r.reason}</td>
      <td><span class="tag ${tone}">${r.status}</span></td>
      <td>${actions}</td>
      ${finalAction}
    </tr>`;
  });
  if(emptyNote) emptyNote.style.display = rows.length===0 ? 'block' : 'none';
}
async function markRecommendationReviewed(id){
  const r = recommendations.find(x=>x.id===id);
  if(!r) return;
  if(!rolePermissions(currentRole).canReview){
    await showNotice('You do not have permission to review dropout recommendations.', 'Access Denied');
    return;
  }
  const student = students.find(item => item.uid === r.uid);
  const violations = student && student.violations && student.violations.length
    ? student.violations.map(v => `• ${v.date || '-'} — ${v.category || 'Violation'} — ${v.action || 'No action recorded'}`).join('<br>')
    : '• No violations recorded yet.';

  if(!await confirmAction(`Mark recommendation for ${r.student} as reviewed?`, 'Confirm Review')) return;
  r.status = 'Reviewed';
  try{
    await updateFirestoreRecord('dropout_recommendations', r);
  }catch(error){
    console.error('Could not mark recommendation as reviewed:', error);
    await showNotice('The recommendation could not be updated in Firestore. Please try again.', 'Update Failed');
    return;
  }
  showNotice(`Student: ${r.student}<br>Student ID: ${student?.studentId || '-'}<br>Subject: ${r.subject || '-'}<br>Course/Year: ${student ? courseYear(student) : '-'}<br>Status: ${student?.status || '-'}<br><strong>Recorded Violations</strong><br>${violations}<br><br>Submitted by: ${r.facultyName}<br>Reason: ${r.reason}`, 'Reviewed Recommendation');
  renderRecommendationsTable();
}
async function viewRecommendation(id){
  const recommendation = recommendations.find(item=>item.id===id);
  if(!recommendation) return;
  const wasPending = recommendation.status === 'Pending Review';
  if(wasPending && normalizeRole(currentRole)==='guidance'){
    recommendation.status = 'Reviewed';
    try{
      await updateFirestoreRecord('dropout_recommendations', recommendation);
    }catch(error){
      console.error('Could not mark recommendation as reviewed:', error);
      recommendation.status = 'Pending Review';
      await showNotice('The recommendation could not be marked as reviewed.', 'Review Failed');
      return;
    }
  }
  const student = students.find(item => item.uid === recommendation.uid);
  const violations = student && student.violations && student.violations.length
    ? student.violations.map(v => `• ${v.date || '-'} — ${v.category || 'Violation'} — ${v.action || 'No action recorded'}`).join('<br>')
    : '• No violations recorded yet.';
  const root = ensureDialogRoot();
  root.innerHTML = `<div class="app-dialog-backdrop"><section class="app-dialog-card" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle"><h2 id="appDialogTitle">Dropout Recommendation</h2><p><strong>Student:</strong> ${recommendation.student}<br><strong>Student ID:</strong> ${student?.studentId || '-'}<br><strong>Subject:</strong> ${recommendation.subject || '-'}<br><strong>Course/Year:</strong> ${student ? courseYear(student) : '-'}<br><strong>Status:</strong> ${student?.status || '-'}<br><br><strong>Recorded Violations</strong><br>${violations}<br><br><strong>Submitted by:</strong> ${recommendation.facultyName}<br><strong>Reason:</strong> ${recommendation.reason}<br><strong>Recommendation Status:</strong> ${recommendation.status}</p><div class="app-dialog-actions"><button type="button" class="app-dialog-cancel" data-dialog-ok>OK</button>${normalizeRole(currentRole)==='guidance' && recommendation.status!=='Approved' && recommendation.status!=='Rejected' ? `<button type="button" class="app-dialog-approve" data-dialog-approve>Approve</button>` : ''}</div></section></div>`;
  root.querySelector('[data-dialog-ok]').focus();
  root.querySelector('[data-dialog-ok]').addEventListener('click', () => closeDialog(true), {once:true});
  const approveButton = root.querySelector('[data-dialog-approve]');
  if(approveButton){
    approveButton.addEventListener('click', async () => {
      closeDialog(true);
      await updateRecommendationStatus(recommendation.id, 'Approved');
    }, {once:true});
  }
  renderRecommendationsTable();
}
async function updateRecommendationStatus(id, status){
  const r = recommendations.find(x=>x.id===id);
  if(!r) return;
  if(!rolePermissions(currentRole).canReview){
    await showNotice('You do not have permission to review dropout recommendations.', 'Access Denied');
    return;
  }
  if(!await confirmAction(`${status} dropout recommendation for ${r.student}?`, `Confirm ${status}`)) return;
  r.status = status;
  if(status==='Approved'){
    const s = students.find(x=>x.uid===r.uid);
    if(s && s.status!=='Dropped' && !isVoidStatus(s.status)){
      s.status = 'For Dropout Review';
      s.dropoutSubject = r.subject;
      await logNotification({
        uid: s.uid,
        student: fullName(s),
        studentId: s.studentId || '-',
        type: 'Dropout Recommendation Approved',
        date: new Date().toISOString().slice(0,10),
        recipients: 'Registrar',
        recipientRoles: ['registrar'],
        channel: 'In-app',
        status: 'Action Needed'
      });
    }
  }else if(status==='Rejected'){
    await logNotification({
      uid: r.uid,
      student: r.student,
      studentId: r.studentId || '-',
      type: 'Dropout Recommendation Rejected',
      date: new Date().toISOString().slice(0,10),
      recipients: 'Faculty, Guidance Counselor & Registrar',
      recipientRoles: ['faculty','guidance','registrar'],
      channel: 'In-app',
      status: 'Action Needed'
    });
  }
  try{
    await updateFirestoreRecord('dropout_recommendations', r);
    if(status==='Approved'){
      const s = students.find(x=>x.uid===r.uid);
      if(s && s.status==='For Dropout Review') await updateFirestoreRecord('students', s);
    }
  }catch(error){
    console.error('Could not update recommendation:', error);
    await showNotice('The recommendation could not be updated in Firestore. Please try again.', 'Update Failed');
    return;
  }
  renderRecommendationsTable();
  renderStudentTable();
  renderDropTable();
}

/* ---------------- CERTIFICATIONS / SCHOLARSHIP & GOOD MORAL VERIFICATION (Registrar) ---------------- */
function scholarshipEligible(s){ return s.status==='Active' && s.violations.length < WARNING_LIMIT; }
function goodMoralEligible(s){ return s.status==='Active' && s.violations.length < WARNING_LIMIT; }
function hasApprovedDropoutRecommendation(s){
  return recommendations.some(recommendation =>
    Number(recommendation.uid) === Number(s.uid) && recommendation.status === 'Approved'
  );
}
function openCertificationFor(uid){
  if(!document.getElementById('page-certifications')){
    window.location.href = 'certifications.html?uid='+encodeURIComponent(uid);
    return;
  }
  showPage('certifications');
  const s = students.find(x=>x.uid===uid);
  if(s){ document.getElementById('certSearch').value = fullName(s); renderCertTable(); }
}
function renderCertTable(){
  const table = document.getElementById('certTableWrap');
  if(!table) return;
  const emptyNote = document.getElementById('certEmptyNote');
  const q = document.getElementById('certSearch').value;
  const yearFilter = document.getElementById('certYearFilter')?.value || '';
  const courseFilter = document.getElementById('certCourseFilter')?.value || '';
  const rows = students.filter(s => matchesSearch(s,q) && (!yearFilter || s.yearLevel===yearFilter) && (!courseFilter || s.course===courseFilter));
  const canFinalize = rolePermissions(currentRole).canFinalize;
  table.innerHTML = '<tr><th>Student</th><th>ID</th><th>Course/Year</th><th>Violations</th><th>Status</th><th>Scholarship</th><th>Good Moral</th><th>Actions</th></tr>';
  rows.forEach(s=>{
    const dotClass = statusDotClass(s.status);
    const schOk = scholarshipEligible(s);
    const gmOk = goodMoralEligible(s);
    let action = `<button class="pill-btn blue small" type="button" onclick="viewStudentInformation(${s.uid})">View Actions</button>`;
    if(canFinalize){
      action += ` <button class="pill-btn green small" onclick="issueCertificate(${s.uid}, 'Good Moral')">Issue Certificate</button>`;
    }
    table.innerHTML += `<tr>
      <td>${fullName(s)}</td>
      <td>${s.studentId||'-'}</td>
      <td>${courseYear(s)}</td>
      <td>${s.violations.length}</td>
      <td><span class="status-dot ${dotClass}"></span>${studentStatusLabel(s)}</td>
      <td><span class="tag ${schOk?'green':'red'}">${schOk?'Eligible':'Not Eligible'}</span></td>
      <td><span class="tag ${gmOk?'green':'red'}">${gmOk?'Eligible':'Not Eligible'}</span></td>
      <td>${action}</td>
    </tr>`;
  });
  if(emptyNote) emptyNote.style.display = rows.length===0 ? 'block' : 'none';
}
async function issueCertificate(uid, certificateType){
  if(!rolePermissions(currentRole).canVerify){
    await showNotice('You do not have permission to issue certificates.', 'Access Denied');
    return;
  }
  const student = students.find(item=>item.uid===uid);
  if(!student) return;
  const eligible = certificateType === 'Good Moral' ? goodMoralEligible(student) : scholarshipEligible(student);
  if(!eligible){
    await showNotice(`${certificateType} certification is not available because this student has ${student.violations.length} violation(s).`, 'Certificate Unavailable');
    return;
  }
  if(!await confirmAction(`Issue ${certificateType} certification for ${fullName(student)}?`, 'Confirm Certificate')) return;
  doPrint(`<div style="text-align:center;padding:40px;font-family:Arial,sans-serif;"><h1>STI COLLEGE DAGUPAN</h1><h2>${certificateType} Certificate</h2><p>This certifies that</p><h2>${fullName(student)}</h2><p>Student ID: ${student.studentId || '-'}</p><p>Course/Year: ${courseYear(student)}</p><p>is eligible for ${certificateType} certification.</p><p>Date Issued: ${new Date().toLocaleDateString()}</p></div>`);
}
async function finalizeDropout(recommendationId){
  if(!rolePermissions(currentRole).canFinalize){
    await showNotice('You do not have permission to finalize dropouts.', 'Access Denied');
    return;
  }
  const recommendation = recommendations.find(item=>item.id===recommendationId);
  if(!recommendation || recommendation.status!=='Approved'){
    await showNotice('Only approved dropout recommendations can be finalized.', 'Finalization Blocked');
    return;
  }
  const s = students.find(x=>Number(x.uid)===Number(recommendation.uid));
  if(!s) return;
  if(s.status==='Dropped'){
    await showNotice('This dropout recommendation has already been finalized.', 'Already Finalized');
    return;
  }
  if(!hasApprovedDropoutRecommendation(s)){
    await showNotice('Only approved dropout recommendations can be finalized.', 'Finalization Blocked');
    return;
  }
  if(!await confirmAction(`Finalize ${recommendation.subject} dropout for ${fullName(s)}? This marks the subject as Dropped and removes them from the active roster.`, 'Finalize Dropout')) return;
  s.status = 'Dropped';
  s.droppedSubject = recommendation.subject;
  recommendation.status = 'Finalized';
  recommendation.finalizedAt = new Date().toISOString();
  try{
    await updateFirestoreRecord('students', s);
    await updateFirestoreRecord('dropout_recommendations', recommendation);
  }catch(error){
    console.error('Could not finalize dropout:', error);
    await showNotice('The student status could not be updated in Firestore. Please try again.', 'Update Failed');
    return;
  }
  await notifyAdminOnStatusChange(s, 'Dropped', 'Action Needed');
  renderCertTable();
  renderDropTable();
}

/* ---------------- PRINTING ---------------- */
function doPrint(html){
  const area = document.getElementById('printArea');
  area.innerHTML = html;
  area.style.display = 'block';
  window.print();
  setTimeout(()=>{ area.style.display='none'; }, 300);
}
function printHeader(subtitle){
  return `
    <div style="text-align:center;margin-bottom:18px;border-bottom:2px solid #0c3f8f;padding-bottom:10px;">
      <div style="font-weight:800;font-size:18px;color:#0c3f8f;">STI COLLEGE DAGUPAN</div>
      <div style="font-size:12px;color:#555;">Campus Registrar — Automated School Violation Record Management System</div>
      <div style="font-weight:700;font-size:14px;margin-top:8px;">${subtitle}</div>
    </div>`;
}
function printViolationSlip(uid, violations){
  const s = students.find(x=>x.uid===uid);
  if(!s) return;
  const rows = (violations||[]).map(v=>`
    <tr><td style="padding:6px;border:1px solid #ccc;">${v.date}</td><td style="padding:6px;border:1px solid #ccc;">${v.category}</td><td style="padding:6px;border:1px solid #ccc;">${v.action||'-'}</td><td style="padding:6px;border:1px solid #ccc;">${v.notes||'-'}</td></tr>
  `).join('');
  const html = `
    ${printHeader('Violation Record Slip')}
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:16px;">
      <tr><td style="padding:4px;width:140px;color:#555;">Student Name</td><td style="padding:4px;font-weight:700;">${fullName(s)}</td></tr>
      <tr><td style="padding:4px;color:#555;">Student ID</td><td style="padding:4px;">${s.studentId||'-'}</td></tr>
      <tr><td style="padding:4px;color:#555;">Course/Year/Section</td><td style="padding:4px;">${courseYear(s)}</td></tr>
      <tr><td style="padding:4px;color:#555;">Parent/Guardian</td><td style="padding:4px;">${s.parentName||'-'} (${s.parentPhone||'-'})</td></tr>
      <tr><td style="padding:4px;color:#555;">Total Violations on File</td><td style="padding:4px;font-weight:700;">${s.violations.length}${s.violations.length>=VIOLATION_LIMIT?' — SCHOLARSHIP VOIDED':''}</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Date</th><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Violation</th><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Action Taken</th><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Notes</th></tr>
      ${rows}
    </table>
    <div style="display:flex;justify-content:space-between;margin-top:60px;font-size:12px;">
      <div style="text-align:center;width:220px;border-top:1px solid #333;padding-top:6px;">Student Signature</div>
      <div style="text-align:center;width:220px;border-top:1px solid #333;padding-top:6px;">Discipline Officer Signature</div>
    </div>`;
  doPrint(html);
}
function printStudentRecord(uid){
  const s = students.find(x=>x.uid===uid);
  if(!s) return;
  const rows = s.violations.map(v=>`
    <tr><td style="padding:6px;border:1px solid #ccc;">${v.date}</td><td style="padding:6px;border:1px solid #ccc;">${v.category}</td><td style="padding:6px;border:1px solid #ccc;">${v.action||'-'}</td><td style="padding:6px;border:1px solid #ccc;">${v.notes||'-'}</td></tr>
  `).join('') || `<tr><td colspan="4" style="padding:8px;text-align:center;color:#777;border:1px solid #ccc;">No violations recorded.</td></tr>`;
  const html = `
    ${printHeader('Student Discipline Record')}
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:16px;">
      <tr><td style="padding:4px;width:160px;color:#555;">Student Name</td><td style="padding:4px;font-weight:700;">${fullName(s)}</td>
          <td style="padding:4px;width:120px;color:#555;">Student ID</td><td style="padding:4px;">${s.studentId||'-'}</td></tr>
      <tr><td style="padding:4px;color:#555;">Course/Year/Section</td><td style="padding:4px;">${courseYear(s)}</td>
          <td style="padding:4px;color:#555;">Gender</td><td style="padding:4px;">${s.gender||'-'}</td></tr>
      <tr><td style="padding:4px;color:#555;">Address</td><td style="padding:4px;">${s.address||'-'}</td>
          <td style="padding:4px;color:#555;">Phone</td><td style="padding:4px;">${s.phone||'-'}</td></tr>
      <tr><td style="padding:4px;color:#555;">Parent/Guardian</td><td style="padding:4px;">${s.parentName||'-'}</td>
          <td style="padding:4px;color:#555;">Parent Phone</td><td style="padding:4px;">${s.parentPhone||'-'}</td></tr>
      <tr><td style="padding:4px;color:#555;">Status</td><td style="padding:4px;font-weight:700;">${s.status}</td>
          <td style="padding:4px;color:#555;">Total Violations</td><td style="padding:4px;font-weight:700;">${s.violations.length}</td></tr>
    </table>
    <div style="font-weight:700;font-size:12.5px;margin-bottom:6px;">Violation History</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Date</th><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Violation</th><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Action Taken</th><th style="padding:6px;border:1px solid #ccc;background:#f0f3f8;">Notes</th></tr>
      ${rows}
    </table>`;
  doPrint(html);
}

/* ---------------- INITIAL RENDER ---------------- */
document.querySelectorAll('.topbar').forEach(tb=>buildTopbar(tb));
setCurrentAcademicYear();
refreshCurrentPageData();
applyRoleUI();

const dropStatusFromUrl = new URLSearchParams(window.location.search).get('status');
if(document.getElementById('dropStatusFilter') && dropStatusFromUrl){
  document.getElementById('dropStatusFilter').value = isVoidStatus(dropStatusFromUrl) ? 'Voided' : dropStatusFromUrl;
  renderDropTable();
}
restoreUrlState();

window.loginUser = loginUser;
window.logoutUser = logoutUser;
window.showPage = showPage;
window.confirmAction = confirmAction;
window.showNotice = showNotice;
window.requestText = requestText;
window.toggleNotificationPanel = toggleNotificationPanel;
