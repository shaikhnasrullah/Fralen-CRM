// auth.js
// This replaces the old app.js. It only runs on index.html (the login/signup page).
// It never touches Firestore data collections directly — all of that
// happens through firebase-config.js on the other pages.
// auth.js
// This replaces the old app.js. It only runs on index.html (the login/signup page).
// It never touches Firestore data collections directly — all of that
// happens through firebase-config.js on the other pages.

import {
auth,
onAuthStateChanged,
signInWithEmailAndPassword,
createUserWithEmailAndPassword,
sendPasswordResetEmail,
sendEmailVerification,
createUserProfile,
isAdminUser,
verificationRequired,
profileDoc,
signOut,
} from "./firebase-config.js";
import { getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Bounced here because the email is not verified yet.
if (new URLSearchParams(window.location.search).get('verify') === '1') {
window.addEventListener('DOMContentLoaded', () => {
window.showLoginError("Please verify your email first. Check your inbox (and Spam) for the verification link, then sign in.");
showResendLink();
});
}

// Show a message if we just bounced a suspended shop back here.
if (new URLSearchParams(window.location.search).get('suspended') === '1') {
window.addEventListener('DOMContentLoaded', () => {
window.showLoginError("This account has been suspended. Please contact support");
});
}

// IMPORTANT: this is set to true while our OWN signup/login handlers are
// running, so the auto-redirect listener below doesn't race them. Without
// this guard, createUserWithEmailAndPassword() signs the user in
// internally, which fires onAuthStateChanged and could redirect to
// dashboard.html BEFORE the signup handler's own createUserProfile() call
// runs — leaving a real account with a blank shop profile.
let authActionInProgress = false;

// If someone is already logged in and lands on index.html (e.g. they
// bookmarked this page while still signed in), skip straight to the
// dashboard — or to the admin panel, if this is the admin account.
onAuthStateChanged(auth, async (user) => {
if (user && !authActionInProgress) {
if (!isAdminUser(user) && !user.emailVerified) {
// Unverified: only continue if this is an existing free/paying shop.
try {
const snap = await getDoc(profileDoc(user.uid));
if (verificationRequired(user, snap.exists() ? snap.data() : {})) {
await signOut(auth);
return;
}
} catch (e) { console.error(e); return; }
}
window.location.href = isAdminUser(user) ? "admin.html" : "dashboard.html";
}
});

// ---------- LOGIN ----------
const loginForm = document.getElementById("loginForm");
loginForm.addEventListener("submit", async () => {
const email = document.getElementById("login-email").value.trim();
const password = document.getElementById("login-password").value;
const btn = document.getElementById("signin-btn");

btn.textContent = "Signing in...";
btn.classList.add("loading");
authActionInProgress = true;

try {
const cred = await signInWithEmailAndPassword(auth, email, password);
if (!isAdminUser(cred.user)) {
const snap = await getDoc(profileDoc(cred.user.uid));
if (snap.exists() && snap.data().status === "suspended") {
await signOut(auth);
window.showLoginError("This account has been suspended. Please contact support.");
btn.textContent = "Sign In";
btn.classList.remove("loading");
authActionInProgress = false;
return;
}
}
if (!isAdminUser(cred.user) && !cred.user.emailVerified) {
const snap2 = await getDoc(profileDoc(cred.user.uid));
if (verificationRequired(cred.user, snap2.exists() ? snap2.data() : {})) {
await signOut(auth);
window.showLoginError("Your email is not verified yet. Please click the link we sent to " + email + " (check Spam too), then sign in again.");
showResendLink();
btn.textContent = "Sign In";
btn.classList.remove("loading");
authActionInProgress = false;
return;
}
}
window.location.href = isAdminUser(cred.user) ? "admin.html" : "dashboard.html";
} catch (err) {
window.showLoginError(friendlyAuthError(err));
btn.textContent = "Sign In";
btn.classList.remove("loading");
authActionInProgress = false;
}
});

// ---------- SIGN UP ----------
// Every signup = a brand new, fully isolated shop account (users/{uid}).
const signupForm = document.getElementById("signupForm");
signupForm.addEventListener("submit", async () => {
const shopName = document.getElementById("su-shop").value.trim();
const ownerName = document.getElementById("su-owner").value.trim();
const phone = document.getElementById("su-phone").value.trim();
const email = document.getElementById("su-email").value.trim();
const password = document.getElementById("su-password").value;
const btn = document.getElementById("signup-btn");

btn.textContent = "Creating account...";
btn.classList.add("loading");
authActionInProgress = true;

try {
const cred = await createUserWithEmailAndPassword(auth, email, password);
// Create the users/{uid} profile document right away, so every
// subsequent page has a shop profile to read (owner name, shop name, etc).
// The authActionInProgress guard above stops the auto-redirect listener
// from firing early and cutting this off before it finishes.
try {
await createUserProfile(cred.user.uid, { ownerName, shopName, email, phone });
} catch (profileErr) {
console.error("Profile creation failed, will self-heal on next page load:", profileErr);
}
// Send the "Verify your email" mail. A failure here (e.g. too many
// requests) must never block signup, so it is caught separately.
try {
await sendEmailVerification(cred.user);
} catch (verifyErr) {
console.error("Verification email failed:", verifyErr);
}
// Do NOT continue until the email is verified: sign out and ask the
// user to verify, then sign in.
await signOut(auth);
document.getElementById("login-email").value = email;
document.getElementById("signupForm").reset();
window.showTab("login");
window.showLoginSuccess("Account created! We sent a verification link to " + email + ". Verify it (check Spam too), then sign in.");
showResendLink();
btn.textContent = "Create Account";
btn.classList.remove("loading");
authActionInProgress = false;
} catch (err) {
window.showLoginError(friendlyAuthError(err));
btn.textContent = "Create Account";
btn.classList.remove("loading");
authActionInProgress = false;
}
});

// ---------- RESEND VERIFICATION EMAIL ----------
function showResendLink() {
let a = document.getElementById("resend-verify");
if (!a) {
a = document.createElement("a");
a.id = "resend-verify";
a.textContent = "Resend verification email";
a.style.cssText = "display:block;text-align:center;margin:10px 0;color:#4F6BF0;font-weight:600;cursor:pointer;font-size:13px";
a.onclick = () => window.handleResendVerification();
document.getElementById("success-msg").insertAdjacentElement("afterend", a);
}
a.style.display = "block";
}

window.handleResendVerification = async function () {
const email = document.getElementById("login-email").value.trim();
const password = document.getElementById("login-password").value;
if (!email || !password) {
window.showLoginError("Enter your email and password above, then click Resend.");
return;
}
authActionInProgress = true;
try {
const cred = await signInWithEmailAndPassword(auth, email, password);
if (cred.user.emailVerified) {
await signOut(auth);
window.showLoginSuccess("Your email is already verified. Please sign in.");
} else {
await sendEmailVerification(cred.user);
await signOut(auth);
window.showLoginSuccess("Verification link sent again to " + email + ". Check Spam too.");
}
} catch (err) {
window.showLoginError(friendlyAuthError(err));
}
authActionInProgress = false;
};

// ---------- FORGOT PASSWORD ----------
window.handleForgotPassword = async function () {
const email = document.getElementById("login-email").value.trim();
if (!email) {
window.showLoginError("Enter your email address first, then click “Forgot password?");
return;
}
try {
await sendPasswordResetEmail(auth, email);
window.showLoginSuccess("Password reset link has been sent to your email. " + email + " par.");
} catch (err) {
window.showLoginError(friendlyAuthError(err));
}
};

function friendlyAuthError(err) {
const code = err && err.code ? err.code : "";
switch (code) {
case "auth/invalid-email": return "Invalid email format.";
case "auth/user-not-found": return "No account found with this email";
case "auth/wrong-password":
case "auth/invalid-credential": return "Incorrect email or password.";
case "auth/email-already-in-use": return "An account already exists with this email. Please log in.";
case "auth/too-many-requests": return "Too many attempts. Please wait a few minutes and try again.";
case "auth/weak-password": return "Password must be at least 6 characters..";
default: return (err && err.message) ? err.message : "Something went wrong. Please try again..";
}
}
