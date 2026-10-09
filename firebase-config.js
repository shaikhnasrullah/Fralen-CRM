// // Every page imports ONLY from this
// firebase-config.js
// Single shared Firebase setup for the whole FRALEN CRM.
// Every page imports ONLY from this file — never re-initializes Firebase itself.
// This is what makes the app multi-tenant: every read/write goes through
// tenantCollection()/tenantDoc(), which forces the path under users/{uid}/...

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBHSFdvPAI1kz91whHbTj0rgUefVhPthLc",
  authDomain: "loginpage1-16430.firebaseapp.com",
  projectId: "loginpage1-16430",
  storageBucket: "loginpage1-16430.firebasestorage.app",
  messagingSenderId: "438297643443",
  appId: "1:438297643443:web:a2a75a2873d2746613e3c6",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Super-admin: same UID must ALSO be pasted into firestore.rules
// (the isAdmin() function there) — that's what actually enforces
// read-only cross-shop access. This constant is only used here to
// decide where a signed-in admin gets redirected after login.
const ADMIN_UID ="Yh77mpl85MZli95Sd5wmGtPRHrt2";

function isAdminUser(user) {
  return !!user && user.uid === ADMIN_UID;
}

/**
 * Every logged-in shop's data lives under users/{uid}/<collectionName>.
 * Use this instead of collection(db, "orders") etc.
 *   tenantCollection(uid, "orders")  ->  users/{uid}/orders
 */
function tenantCollection(uid, collectionName) {
  if (!uid) throw new Error("tenantCollection() called without a uid");
  return collection(db, "users", uid, collectionName);
}

/**
 * users/{uid}/<collectionName>/<docId>
 */
function tenantDoc(uid, collectionName, docId) {
  if (!uid) throw new Error("tenantDoc() called without a uid");
  return doc(db, "users", uid, collectionName, docId);
}

/**
 * The profile document itself: users/{uid}
 */
function profileDoc(uid) {
  return doc(db, "users", uid);
}

/**
 * Guard for every "inside app" page (dashboard, customers, create-order, etc).
 * Call this at the top of the page's script. It:
 *  - redirects to index.html if nobody is logged in
 *  - signs out + redirects a SUSPENDED shop back to index.html with a message
 *  - self-heals a missing profile doc (e.g. if signup's write failed) so
 *    every shop always has SOMETHING in users/{uid} — this is also what
 *    makes every shop visible to the admin panel, even brand-new ones with
 *    zero orders yet (the admin panel can't find those via orders alone).
 *  - otherwise calls onReady(user) with the Firebase user object
 */
function requireAuth(onReady) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    // Admin account never gets suspended and doesn't have a "shop" — skip the check.
    if (!isAdminUser(user)) {
      try {
        const snap = await getDoc(profileDoc(user.uid));
        if (snap.exists()) {
          if (snap.data().status === "suspended") {
            await signOut(auth);
            window.location.href = "index.html?suspended=1";
            return;
          }
        } else {
          // No profile doc at all — signup's write must have failed or
          // never ran. Create a minimal one now so this shop isn't invisible.
          await setDoc(profileDoc(user.uid), {
            email: user.email || "",
            shopName: "",
            ownerName: "",
            phone: "",
            createdAt: serverTimestamp(),
          }, { merge: true });
        }
      } catch (e) { /* if the check itself fails, fail open rather than lock everyone out */ }
    }
    onReady(user);
  });
}

/** Create the users/{uid} profile document right after signup. Retries once
 * on failure (transient network blips are common right after signup) so the
 * real entered data survives instead of falling back to a blank self-healed
 * profile later. */
async function createUserProfile(uid, { ownerName, shopName, email, phone }) {
  const data = {
    ownerName: ownerName || "",
    shopName: shopName || "",
    email: email || "",
    phone: phone || "",
    createdAt: serverTimestamp(),
  };
  try {
    await setDoc(profileDoc(uid), data, { merge: true });
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1200));
    await setDoc(profileDoc(uid), data, { merge: true }); // let this one throw if it fails again
  }
}

/**
 * Guard for admin.html only. It:
 *  - redirects to index.html if nobody is logged in
 *  - redirects a logged-in NON-admin back to dashboard.html
 *  - otherwise calls onReady(user) for the admin account
 */
function requireAdmin(onReady) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    if (!isAdminUser(user)) {
      window.location.href = "dashboard.html";
      return;
    }
    onReady(user);
  });
}

export {
  app,
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  tenantCollection,
  tenantDoc,
  profileDoc,
  requireAuth,
  requireAdmin,
  isAdminUser,
  createUserProfile,
};
