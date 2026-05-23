/* =====================================================================
   KFSHRC Overtime Availability System — Frontend logic
   - Uses Supabase JS v2 with the public anon key.
   - All security rules are enforced server-side via RLS + triggers.
===================================================================== */

// ---------- 1) CONFIG: REPLACE THESE TWO VALUES ----------
const SUPABASE_URL      = "https://vuwnwtzhvahiluxnxawd.supabase.co"; // <-- replace
const SUPABASE_ANON_KEY = "sb_publishable_m5jmbwes_7PzVeoR6t3Xgw_lWqRaN8J";                 // <-- replace
// ---------------------------------------------------------

const ALLOWED_DOMAIN = "@kfshrc.edu.sa";
const LEADERSHIP_ROLES = ["head_nurse", "assistant_head_nurse", "supervisor", "admin"];

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

// Cached state
let currentUser = null;
let currentProfile = null;
let stagedDates = [];
let leadershipRecords = [];

// =====================================================================
// Utilities
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }

function toast(msg, ms = 2400){
  const t = $("#toast");
  t.textContent = msg;
  show(t);
  clearTimeout(toast._h);
  toast._h = setTimeout(() => hide(t), ms);
}

function setMsg(el, text, type){
  el.textContent = text || "";
  el.className = "msg" + (type ? " " + type : "");
}

function esc(s){
  if(s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function isHospitalEmail(email){
  return typeof email === "string" && email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

function formatDate(d){
  if(!d) return "";
  const dt = (d instanceof Date) ? d : new Date(d);
  if(isNaN(dt)) return String(d);
  return dt.toISOString().slice(0, 10);
}

function formatDateTime(d){
  if(!d) return "";
  const dt = new Date(d);
  if(isNaN(dt)) return String(d);
  return dt.toLocaleString();
}

// =====================================================================
// Auth flows
// =====================================================================
async function handleLogin(e){
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const pwd = $("#loginPassword").value;
  const msg = $("#loginMsg");
  setMsg(msg, "");

  if(!isHospitalEmail(email)){
    return setMsg(msg, `Only ${ALLOWED_DOMAIN} email addresses are allowed.`, "error");
  }

  const { error } = await sb.auth.signInWithPassword({ email, password: pwd });
  if(error) return setMsg(msg, error.message, "error");
  await bootstrapSession();
}

async function handleSignup(e){
  e.preventDefault();
  const email = $("#suEmail").value.trim();
  const pwd = $("#suPassword").value;
  const full = $("#suName").value.trim();
  const dept = $("#suDept").value.trim();
  const job = $("#suJob").value.trim();
  const msg = $("#signupMsg");
  setMsg(msg, "");

  if(!isHospitalEmail(email)){
    return setMsg(msg, `Only ${ALLOWED_DOMAIN} email addresses are allowed.`, "error");
  }
  if(pwd.length < 8){
    return setMsg(msg, "Password must be at least 8 characters.", "error");
  }

  const { error } = await sb.auth.signUp({
    email,
    password: pwd,
    options: { data: { full_name: full, department: dept, job_title: job } }
  });

  if(error) return setMsg(msg, error.message, "error");
  setMsg(msg, "Account created. If email confirmation is enabled, please verify before signing in.", "success");
}

async function handleLogout(){
  await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  renderAuthState();
}

function bindAuthTabs(){
  $$(".tab").forEach(t => t.addEventListener("click", () => {
    $$(".tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    const which = t.dataset.tab;
    $("#loginForm").classList.toggle("hidden", which !== "login");
    $("#signupForm").classList.toggle("hidden", which !== "signup");
  }));
}

// =====================================================================
// Profile + session bootstrap
// =====================================================================
async function bootstrapSession(){
  const { data: { user } } = await sb.auth.getUser();
  currentUser = user || null;
  if(!currentUser){
    renderAuthState();
    return;
  }

  const { data: prof, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .maybeSingle();

  if(error){
    console.error(error);
    toast("Could not load your profile.");
    await sb.auth.signOut();
    renderAuthState();
    return;
  }
  if(!prof){
    toast("Profile not found. Contact administrator.");
    await sb.auth.signOut();
    renderAuthState();
    return;
  }
  if(!prof.is_active){
    toast("Your account is inactive. Contact administrator.");
    await sb.auth.signOut();
    renderAuthState();
    return;
  }

  currentProfile = prof;

  try { await sb.rpc("expire_past_availability"); } catch(_) {}

  renderAuthState();
}

function renderAuthState(){
  if(currentUser && currentProfile){
    hide($("#authView"));
    show($("#appView"));
    show($("#userBar"));

    $("#userLabel").textContent =
      `${currentProfile.full_name || currentProfile.hospital_email} · ${prettyRole(currentProfile.role)}`;

    const isLead = LEADERSHIP_ROLES.includes(currentProfile.role);
    const isAdmin = currentProfile.role === "admin";

    $("#navLeadership").classList.toggle("hidden", !isLead);
    $("#navAdmin").classList.toggle("hidden", !isAdmin);

    switchView("staff");
    loadMyAvailability();
  } else {
    show($("#authView"));
    hide($("#appView"));
    hide($("#userBar"));
  }
}

function prettyRole(r){
  return ({
    staff: "Staff",
    head_nurse: "Head Nurse",
    assistant_head_nurse: "Assistant Head Nurse",
    supervisor: "Supervisor",
    admin: "Administrator"
  })[r] || r;
}

// =====================================================================
// View switching
// =====================================================================
function switchView(view){
  $$(".navtab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#staffView").classList.toggle("hidden", view !== "staff");
  $("#leadershipView").classList.toggle("hidden", view !== "leadership");
  $("#adminView").classList.toggle("hidden", view !== "admin");

  if(view === "leadership") loadLeadership();
  if(view === "admin"){
    loadUsers();
    loadAllAvailability();
  }
}

function bindNav(){
  $$(".navtab").forEach(b => b.addEventListener("click", () => {
    if(b.classList.contains("hidden")) return;
    switchView(b.dataset.view);
  }));
}

// =====================================================================
// STAFF: submit / list / cancel own availability
// =====================================================================
function bindStaffForm(){
  $("#btnAddDate").addEventListener("click", () => {
    const v = $("#afDate").value;
    if(!v) return;
    if(stagedDates.includes(v)){
      $("#afDate").value = "";
      return;
    }
    stagedDates.push(v);
    $("#afDate").value = "";
    renderDateChips();
  });

  $("#availForm").addEventListener("submit", submitAvailability);
  $("#btnRefreshMine").addEventListener("click", loadMyAvailability);
}

function renderDateChips(){
  const ul = $("#dateList");
  ul.innerHTML = stagedDates
    .sort()
    .map(d => `<li class="chip">${esc(d)} <button type="button" data-d="${esc(d)}" aria-label="Remove">×</button></li>`)
    .join("");

  $$("#dateList button").forEach(b => b.addEventListener("click", e => {
    stagedDates = stagedDates.filter(x => x !== e.target.dataset.d);
    renderDateChips();
  }));
}

async function submitAvailability(e){
  e.preventDefault();
  const msg = $("#availMsg");
  setMsg(msg, "");

  if(stagedDates.length === 0){
    return setMsg(msg, "Please add at least one available date.", "error");
  }

  const today = new Date().toISOString().slice(0, 10);
  if(stagedDates.some(d => d < today)){
    return setMsg(msg, "Dates cannot be in the past.", "error");
  }

  const base = {
    user_id: currentProfile.id,
    shift_preference: $("#afShift").value,
    can_float: $("#afFloat").value === "true",
    preferred_departments: $("#afPref").value.trim() || null,
    notes: $("#afNotes").value.trim() || null
  };

  const rows = stagedDates.map(d => ({ ...base, available_date: d }));

  const { error } = await sb.from("overtime_availability").insert(rows);
  if(error){
    return setMsg(msg, error.message, "error");
  }

  stagedDates = [];
  renderDateChips();
  $("#availForm").reset();
  setMsg(msg, `Submitted ${rows.length} availability record(s).`, "success");
  loadMyAvailability();
}

async function loadMyAvailability(){
  if(!currentProfile) return;

  const { data, error } = await sb
    .from("overtime_availability")
    .select("*")
    .eq("user_id", currentProfile.id)
    .order("available_date", { ascending: true });

  if(error){
    toast(error.message);
    return;
  }

  const body = $("#myAvailBody");
  if(!data || data.length === 0){
    body.innerHTML = `<tr><td colspan="7" class="muted">No submissions yet.</td></tr>`;
    return;
  }

  body.innerHTML = data.map(r => `
    <tr class="${rowClassForStatus(r.status)}">
      <td>${esc(formatDate(r.available_date))}</td>
      <td>${esc(r.shift_preference)}</td>
      <td>${r.can_float ? "Yes" : "No"}</td>
      <td>${esc(r.preferred_departments || "")}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${esc(formatDateTime(r.updated_at))}</td>
      <td>
        ${(r.status === "Available" || r.status === "Contacted")
          ? `<button class="btn btn-small btn-danger" data-cancel="${r.id}">Cancel</button>`
          : ""}
      </td>
    </tr>
  `).join("");

  $$("#myAvailBody [data-cancel]").forEach(b => {
    b.addEventListener("click", () => cancelMine(b.dataset.cancel));
  });
}

async function cancelMine(id){
  if(!confirm("Cancel this availability?")) return;

  const { error } = await sb
    .from("overtime_availability")
    .update({ status: "Cancelled" })
    .eq("id", id);

  if(error) return toast(error.message);
  toast("Cancelled.");
  loadMyAvailability();
}

function rowClassForStatus(s){
  if(s === "Assigned") return "assigned";
  if(s === "Expired") return "expired";
  if(s === "Cancelled") return "cancelled";
  return "";
}

function statusBadge(s){
  return `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
}

// =====================================================================
// LEADERSHIP: list, filter, status actions, message
// =====================================================================
function bindLeadership(){
  $("#btnApplyFilters").addEventListener("click", loadLeadership);
  $("#btnResetFilters").addEventListener("click", () => {
    $("#flDate").value = "";
    $("#flShift").value = "";
    $("#flDept").value = "";
    $("#flFloat").value = "";
    $("#flStatus").value = "Available";
    loadLeadership();
  });
}

async function loadLeadership(){
  if(!currentProfile || !LEADERSHIP_ROLES.includes(currentProfile.role)) return;

  try { await sb.rpc("expire_past_availability"); } catch(_) {}

  let q = sb
    .from("overtime_availability")
    .select("*")
    .order("available_date", { ascending: true });

  const date = $("#flDate").value;
  const shift = $("#flShift").value;
  const dept = $("#flDept").value.trim();
  const flo = $("#flFloat").value;
  const status = $("#flStatus").value;

  if(date) q = q.eq("available_date", date);
  if(shift) q = q.eq("shift_preference", shift);
  if(dept) q = q.ilike("current_department", `%${dept}%`);
  if(flo === "true") q = q.eq("can_float", true);
  if(flo === "false") q = q.eq("can_float", false);
  if(status) q = q.eq("status", status);

  const { data, error } = await q;
  if(error){
    toast(error.message);
    return;
  }

  leadershipRecords = data || [];

  const body = $("#leadBody");
  if(!data || data.length === 0){
    body.innerHTML = `<tr><td colspan="11" class="muted">No matching records.</td></tr>`;
    return;
  }

  body.innerHTML = data.map(r => `
    <tr class="${rowClassForStatus(r.status)}">
      <td>${esc(r.full_name || "")}</td>
      <td>${esc(r.hospital_email || "")}</td>
      <td>${esc(r.current_department || "")}</td>
      <td>${esc(r.job_title || "")}</td>
      <td>${esc(formatDate(r.available_date))}</td>
      <td>${esc(r.shift_preference)}</td>
      <td>${r.can_float ? "Yes" : "No"}</td>
      <td>${esc(r.preferred_departments || "")}</td>
      <td>${esc(r.notes || "")}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="actions">
        ${messageButton(r)}
        ${statusButton(r, "Contacted", "Mark Contacted")}
        ${statusButton(r, "Assigned", "Mark Assigned")}
        ${returnAvailableButton(r)}
      </td>
    </tr>
  `).join("");

  $$("#leadBody [data-send-message]").forEach(b => {
    b.addEventListener("click", () => sendMessage(b.dataset.sendMessage));
  });

  $$("#leadBody [data-set-status]").forEach(b => {
    b.addEventListener("click", () => updateStatus(b.dataset.id, b.dataset.setStatus));
  });
}

function messageButton(r){
  if(r.status === "Expired" || r.status === "Cancelled") return "";
  return `<button class="btn btn-small btn-ghost" data-send-message="${r.id}">Send Message</button>`;
}

function statusButton(r, target, label){
  if(r.status === target) return "";
  if(r.status === "Expired" || r.status === "Cancelled") return "";
  if(target === "Contacted" && r.status !== "Available") return "";
  if(target === "Assigned" && !["Available", "Contacted"].includes(r.status)) return "";

  const cls = target === "Assigned" ? "btn-primary" : "btn-ghost";
  return `<button class="btn btn-small ${cls}" data-id="${r.id}" data-set-status="${target}">${label}</button>`;
}

function returnAvailableButton(r){
  if(!["Contacted", "Assigned"].includes(r.status)) return "";
  return `<button class="btn btn-small btn-ghost" data-id="${r.id}" data-set-status="Available">Return to Available</button>`;
}

function sendMessage(id){
  const record = leadershipRecords.find(r => r.id === id);
  if(!record) return toast("Record not found. Refresh and try again.");

  const subject = record.status === "Assigned"
    ? `Overtime Assigned - ${formatDate(record.available_date)}`
    : `Overtime Confirmation - ${formatDate(record.available_date)}`;

  const body = record.status === "Assigned"
    ? assignedEmailBody(record)
    : confirmationEmailBody(record);

  window.location.href =
    `mailto:${encodeURIComponent(record.hospital_email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function senderLine(){
  const name = currentProfile?.full_name || currentProfile?.hospital_email || "Leadership";
  const role = prettyRole(currentProfile?.role || "");
  const deptJob = [currentProfile?.department, currentProfile?.job_title].filter(Boolean).join(" / ");
  return `${name}\n${role}${deptJob ? "\n" + deptJob : ""}`;
}

function confirmationEmailBody(r){
  return `Dear ${r.full_name || "colleague"},

I hope you are doing well.

You are listed as available for overtime on ${formatDate(r.available_date)} for the ${r.shift_preference} shift.

Please confirm if you are still available and willing to cover the overtime shift.

Once confirmed, your status will be updated in the overtime availability system.

Regards,
${senderLine()}`;
}

function assignedEmailBody(r){
  return `Dear ${r.full_name || "colleague"},

This is to confirm that you have been assigned for overtime on ${formatDate(r.available_date)} for the ${r.shift_preference} shift.

Please make sure to follow the department instructions and confirm any additional details with the requesting leadership team.

Regards,
${senderLine()}`;
}

async function updateStatus(id, status){
  const { error } = await sb
    .from("overtime_availability")
    .update({ status })
    .eq("id", id);

  if(error) return toast(error.message);
  toast(`Status updated to ${status}.`);
  loadLeadership();
  if(currentProfile.role === "admin") loadAllAvailability();
}

// =====================================================================
// ADMIN: users + all availability + CSV export
// =====================================================================
function bindAdmin(){
  $("#btnRefreshUsers").addEventListener("click", loadUsers);
  $("#btnRefreshAllAvail").addEventListener("click", loadAllAvailability);
  $("#btnExportCsv").addEventListener("click", exportCsv);
}

async function loadUsers(){
  if(currentProfile.role !== "admin") return;

  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if(error){
    toast(error.message);
    return;
  }

  const body = $("#usersBody");
  if(!data || data.length === 0){
    body.innerHTML = `<tr><td colspan="7" class="muted">No users.</td></tr>`;
    return;
  }

  const roleOpts = ["staff", "head_nurse", "assistant_head_nurse", "supervisor", "admin"];

  body.innerHTML = data.map(u => `
    <tr>
      <td>${esc(u.full_name || "")}</td>
      <td>${esc(u.hospital_email)}</td>
      <td>${esc(u.department || "")}</td>
      <td>${esc(u.job_title || "")}</td>
      <td>
        <select data-role-id="${u.id}">
          ${roleOpts.map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${prettyRole(r)}</option>`).join("")}
        </select>
      </td>
      <td>
        <select data-active-id="${u.id}">
          <option value="true" ${u.is_active ? "selected" : ""}>Active</option>
          <option value="false" ${!u.is_active ? "selected" : ""}>Inactive</option>
        </select>
      </td>
      <td><button class="btn btn-small btn-primary" data-save-id="${u.id}">Save</button></td>
    </tr>
  `).join("");

  $$("#usersBody [data-save-id]").forEach(b => {
    b.addEventListener("click", () => saveUser(b.dataset.saveId));
  });
}

async function saveUser(id){
  const role = $(`[data-role-id="${id}"]`).value;
  const isActive = $(`[data-active-id="${id}"]`).value === "true";

  const { error } = await sb
    .from("profiles")
    .update({ role, is_active: isActive })
    .eq("id", id);

  if(error) return toast(error.message);
  toast("User updated.");
  loadUsers();
}

async function loadAllAvailability(){
  if(currentProfile.role !== "admin") return;

  try { await sb.rpc("expire_past_availability"); } catch(_) {}

  const { data, error } = await sb
    .from("overtime_availability")
    .select("*")
    .order("available_date", { ascending: false });

  if(error){
    toast(error.message);
    return;
  }

  const body = $("#allAvailBody");
  if(!data || data.length === 0){
    body.innerHTML = `<tr><td colspan="12" class="muted">No records.</td></tr>`;
    return;
  }

  body.innerHTML = data.map(r => `
    <tr class="${rowClassForStatus(r.status)}">
      <td>${esc(r.full_name || "")}</td>
      <td>${esc(r.hospital_email)}</td>
      <td>${esc(r.current_department || "")}</td>
      <td>${esc(r.job_title || "")}</td>
      <td>${esc(formatDate(r.available_date))}</td>
      <td>${esc(r.shift_preference)}</td>
      <td>${r.can_float ? "Yes" : "No"}</td>
      <td>${esc(r.preferred_departments || "")}</td>
      <td>${esc(r.notes || "")}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${esc(formatDateTime(r.created_at))}</td>
      <td><button class="btn btn-small btn-danger" data-admin-del="${r.id}">Delete</button></td>
    </tr>
  `).join("");

  $$("#allAvailBody [data-admin-del]").forEach(b => b.addEventListener("click", async () => {
    if(!confirm("Delete this record permanently?")) return;

    const { error } = await sb
      .from("overtime_availability")
      .delete()
      .eq("id", b.dataset.adminDel);

    if(error) return toast(error.message);
    toast("Deleted.");
    loadAllAvailability();
  }));
}

async function exportCsv(){
  if(currentProfile.role !== "admin") return;

  const { data, error } = await sb
    .from("overtime_availability")
    .select("*")
    .order("available_date", { ascending: false });

  if(error){
    toast(error.message);
    return;
  }
  if(!data || data.length === 0){
    toast("Nothing to export.");
    return;
  }

  const headers = [
    "id",
    "user_id",
    "full_name",
    "hospital_email",
    "current_department",
    "job_title",
    "available_date",
    "shift_preference",
    "can_float",
    "preferred_departments",
    "notes",
    "status",
    "created_at",
    "updated_at"
  ];

  const lines = [headers.join(",")];

  for(const r of data){
    lines.push(headers.map(h => csvCell(r[h])).join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `overtime_availability_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v){
  if(v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

// =====================================================================
// Wire up + initial boot
// =====================================================================
document.addEventListener("DOMContentLoaded", async () => {
  bindAuthTabs();
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#signupForm").addEventListener("submit", handleSignup);
  $("#btnLogout").addEventListener("click", handleLogout);
  bindNav();
  bindStaffForm();
  bindLeadership();
  bindAdmin();

  sb.auth.onAuthStateChange((_event, _session) => { bootstrapSession(); });
  await bootstrapSession();
});
