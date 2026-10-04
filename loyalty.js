// FRALEN CRM - Smart Loyalty & Rewards

// ----- Mobile sidebar menu -----
(function () {
  const toggle = document.getElementById("menu-toggle");
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  function closeMenu() {
    sidebar.classList.remove("open"); overlay.classList.remove("show"); toggle.classList.remove("active");
    toggle.setAttribute("aria-expanded", "false");
  }
  function openMenu() {
    sidebar.classList.add("open"); overlay.classList.add("show"); toggle.classList.add("active");
    toggle.setAttribute("aria-expanded", "true");
  }
  toggle.addEventListener("click", function () { sidebar.classList.contains("open") ? closeMenu() : openMenu(); });
  overlay.addEventListener("click", closeMenu);
  sidebar.querySelectorAll("a").forEach(function (l) { l.addEventListener("click", closeMenu); });
})();

// ----- Loyalty logic (Firebase) -----
import { getDocs, getDoc, setDoc, doc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, signOut, requireAuth, tenantCollection, profileDoc } from "./firebase-config.js";

var currentUid = null;
var shopName = "our shop";
var config = {
  enabled: true,
  visitsRequired: 5,
  rewardType: "Discount",
  rewardText: "10% discount on your next purchase",
  message: "Hi {name}! 🎉 Thank you for visiting {shop} {visits} times. You have unlocked a reward: {reward}. Show this message at the shop to claim it."
};
var customers = [];   // built from orders
var claims = {};      // mobile -> number of rewards already given

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function cleanMobile(m) { return String(m || "").replace(/\D/g, "").slice(-10); }
function dayKey(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

document.getElementById("logout-btn").addEventListener("click", async function () {
  await signOut(auth);
  window.location.href = "index.html";
});

requireAuth(async function (user) {
  currentUid = user.uid;
  try {
    var snap = await getDoc(profileDoc(currentUid));
    if (snap.exists()) {
      var p = snap.data();
      if (p.shopName) shopName = p.shopName;
      if (p.loyalty) {
        for (var k in p.loyalty) config[k] = p.loyalty[k];
      }
    }
  } catch (e) { console.log("Profile load error", e); }
  fillForm();
  await loadData();
});

function fillForm() {
  document.getElementById("cfg-enabled").checked = config.enabled !== false;
  document.getElementById("cfg-visits").value = config.visitsRequired;
  document.getElementById("cfg-type").value = config.rewardType;
  document.getElementById("cfg-text").value = config.rewardText;
  document.getElementById("cfg-message").value = config.message;
}

document.getElementById("cfg-save").addEventListener("click", async function () {
  var btn = this, msg = document.getElementById("cfg-msg");
  var visits = parseInt(document.getElementById("cfg-visits").value, 10);
  var text = document.getElementById("cfg-text").value.trim();
  msg.className = "msg";
  if (!visits || visits < 2 || visits > 30) { msg.textContent = "Visits 2 se 30 ke beech daalo."; msg.classList.add("err"); return; }
  if (!text) { msg.textContent = "Reward details likho."; msg.classList.add("err"); return; }
  btn.disabled = true; btn.textContent = "Saving...";
  var newCfg = {
    enabled: document.getElementById("cfg-enabled").checked,
    visitsRequired: visits,
    rewardType: document.getElementById("cfg-type").value,
    rewardText: text,
    message: document.getElementById("cfg-message").value.trim() || config.message
  };
  try {
    // merge so no other profile field is touched
    await setDoc(profileDoc(currentUid), { loyalty: newCfg, updatedAt: serverTimestamp() }, { merge: true });
    config = newCfg;
    msg.textContent = "✅ Reward setup saved!";
    msg.classList.add("ok");
    render();
  } catch (e) {
    msg.textContent = "Error: " + e.message;
    msg.classList.add("err");
  }
  btn.disabled = false; btn.textContent = "Save Reward Setup";
});

async function loadData() {
  var byMobile = {};
  try {
    var oSnap = await getDocs(tenantCollection(currentUid, "orders"));
    oSnap.forEach(function (d) {
      var o = d.data();
      var m = cleanMobile(o.mobile);
      if (!m) return;   // customer without a mobile number cannot be tracked
      var c = byMobile[m] || (byMobile[m] = { mobile: m, name: "", days: {}, last: "", spent: 0 });
      if (o.customerName) c.name = o.customerName;
      var k = dayKey(o.createdAt);
      if (k) c.days[k] = true;
      if (o.createdAt && o.createdAt > c.last) c.last = o.createdAt;
      c.spent += Number(o.totals && o.totals.payable) || 0;
    });
  } catch (e) { console.log("Orders load error", e); }

  claims = {};
  try {
    var cSnap = await getDocs(tenantCollection(currentUid, "loyaltyClaims"));
    cSnap.forEach(function (d) {
      var c = d.data();
      claims[c.mobile] = (claims[c.mobile] || 0) + 1;
    });
  } catch (e) { console.log("Claims load error", e); }

  customers = Object.keys(byMobile).map(function (m) {
    var c = byMobile[m];
    c.visits = Object.keys(c.days).length;
    return c;
  });
  render();
}

// How far each customer is, from visits + rewards already given
function stateOf(c) {
  var n = config.visitsRequired;
  var earned = Math.floor(c.visits / n);
  var given = claims[c.mobile] || 0;
  var ready = Math.max(0, earned - given);
  var into = c.visits - given * n;               // visits counted towards the current card
  var shown = ready > 0 ? n : (into % n);        // ticks to fill on the card
  return { earned: earned, given: given, ready: ready, shown: shown };
}

function render() {
  var n = config.visitsRequired;
  var list = document.getElementById("cust-list");

  var ready = 0, given = 0, repeat = 0;
  customers.forEach(function (c) {
    var s = stateOf(c);
    if (s.ready > 0) ready++;
    given += s.given;
    if (c.visits >= 2) repeat++;
  });
  document.getElementById("s-customers").textContent = customers.length;
  document.getElementById("s-ready").textContent = config.enabled === false ? 0 : ready;
  document.getElementById("s-given").textContent = given;
  document.getElementById("s-repeat").textContent = repeat;

  if (config.enabled === false) {
    list.innerHTML = '<div class="empty">Loyalty program abhi OFF hai. Upar se ON karke save karo.</div>';
    return;
  }

  var q = document.getElementById("search").value.trim().toLowerCase();
  var f = document.getElementById("filter").value;
  var rows = customers.filter(function (c) {
    var s = stateOf(c);
    if (q && c.name.toLowerCase().indexOf(q) === -1 && c.mobile.indexOf(q) === -1) return false;
    if (f === "ready" && s.ready === 0) return false;
    if (f === "progress" && (s.ready > 0 || c.visits === 0)) return false;
    if (f === "repeat" && c.visits < 2) return false;
    return true;
  });
  // reward-ready customers first, then most visits
  rows.sort(function (a, b) {
    var sa = stateOf(a), sb = stateOf(b);
    if ((sb.ready > 0) !== (sa.ready > 0)) return sb.ready > 0 ? 1 : -1;
    return b.visits - a.visits;
  });

  if (!rows.length) { list.innerHTML = '<div class="empty">Koi customer nahi mila.</div>'; return; }

  list.innerHTML = rows.map(function (c) {
    var s = stateOf(c);
    var ticks = "";
    for (var i = 1; i <= n; i++) {
      if (i === n) ticks += '<div class="tick gift' + (s.shown >= n ? " on" : "") + '">🎁</div>';
      else ticks += '<div class="tick' + (i <= s.shown ? " on" : "") + '">' + (i <= s.shown ? "✓" : "") + '</div>';
    }
    var badge = s.ready > 0
      ? '<span class="badge gold">🎁 Reward unlocked' + (s.ready > 1 ? " x" + s.ready : "") + '</span>'
      : '<span class="badge blue">' + s.shown + ' / ' + n + ' visits</span>';
    var left = n - s.shown;
    var line = s.ready > 0
      ? esc(config.rewardType) + ": " + esc(config.rewardText)
      : left + (left === 1 ? " visit" : " visits") + " more for " + esc(config.rewardType);
    var actions = "";
    if (s.ready > 0) {
      actions += '<button class="wa" data-act="wa" data-m="' + c.mobile + '">📲 Send WhatsApp</button>';
      actions += '<button class="claim" data-act="claim" data-m="' + c.mobile + '">✔ Mark reward given</button>';
    }
    return '<div class="lcard' + (s.ready > 0 ? " unlocked" : "") + '">' +
      '<div class="lc-head"><div><div class="lc-name">' + esc(c.name || "Customer") + '</div>' +
      '<div class="lc-mobile">' + esc(c.mobile) + '</div></div>' + badge + '</div>' +
      '<div class="ticks">' + ticks + '</div>' +
      '<div class="lc-line">' + line + '</div>' +
      '<div class="lc-line" style="color:#6B7280;margin-top:4px">Total visits: ' + c.visits +
      (s.given ? ' · Rewards given: ' + s.given : '') + '</div>' +
      (actions ? '<div class="lc-actions">' + actions + '</div>' : '') +
      '</div>';
  }).join("");
}

document.getElementById("search").addEventListener("input", render);
document.getElementById("filter").addEventListener("change", render);

document.getElementById("cust-list").addEventListener("click", async function (e) {
  var btn = e.target.closest("button");
  if (!btn) return;
  var m = btn.getAttribute("data-m");
  var c = customers.find(function (x) { return x.mobile === m; });
  if (!c) return;

  if (btn.getAttribute("data-act") === "wa") {
    var text = config.message
      .replace(/\{name\}/g, c.name || "Customer")
      .replace(/\{shop\}/g, shopName)
      .replace(/\{reward\}/g, config.rewardText)
      .replace(/\{visits\}/g, config.visitsRequired);
    window.open("https://wa.me/91" + c.mobile + "?text=" + encodeURIComponent(text), "_blank");
    return;
  }

  if (btn.getAttribute("data-act") === "claim") {
    if (!confirm("Mark reward as given to " + (c.name || c.mobile) + "?")) return;
    btn.disabled = true;
    try {
      var number = (claims[m] || 0) + 1;
      await setDoc(doc(tenantCollection(currentUid, "loyaltyClaims"), m + "_" + number), {
        mobile: m,
        customerName: c.name || "",
        reward: config.rewardType + ": " + config.rewardText,
        visitsAtClaim: c.visits,
        claimedAt: new Date().toISOString()
      });
      claims[m] = number;
      render();
    } catch (err) {
      alert("Could not save: " + err.message);
      btn.disabled = false;
    }
  }
});
