/*
 * FRALEN CRM — Shared Firebase Configuration
 *
 * All application pages should import Firebase services from this file.
 * Shop business data lives under:
 * users/{uid}/{collectionName}/{documentId}
 *
 * IMPORTANT:
 * - Never put private API secrets in this file.
 * - freeAccess and subscription status must be controlled by trusted
 *   admin/backend code, never granted by client-side code.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
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


// =========================================================
// FIREBASE CONFIGURATION
// =========================================================

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


// =========================================================
// SUPER ADMIN
// Keep this UID synchronized with firestore.rules.
// This client-side check is for navigation only.
// Firestore Rules enforce actual permissions.
// =========================================================

const ADMIN_UID = "Yh77mpl85MZli95Sd5wmGtPRHrt2";

function isAdminUser(user) {
  return Boolean(user && user.uid === ADMIN_UID);
}


// =========================================================
// MULTI-TENANT DATA HELPERS
// =========================================================

function tenantCollection(uid, collectionName) {
  if (!uid) {
    throw new Error("tenantCollection() called without a uid");
  }

  if (!collectionName) {
    throw new Error("Collection name is required");
  }

  return collection(db, "users", uid, collectionName);
}

function tenantDoc(uid, collectionName, docId) {
  if (!uid) {
    throw new Error("tenantDoc() called without a uid");
  }

  if (!collectionName || !docId) {
    throw new Error("Collection name and document ID are required");
  }

  return doc(db, "users", uid, collectionName, docId);
}

function profileDoc(uid) {
  if (!uid) {
    throw new Error("profileDoc() called without a uid");
  }

  return doc(db, "users", uid);
}


// =========================================================
// CREATE SHOP PROFILE
// Creates ordinary profile fields only.
// Does NOT grant free access or set payment status.
// =========================================================

async function createUserProfile(
  uid,
  { ownerName, shopName, email, phone } = {}
) {
  if (!uid) {
    throw new Error("Cannot create profile without a user UID");
  }

  const data = {
    ownerName: ownerName || "",
    shopName: shopName || "",
    email: email || "",
    phone: phone || "",
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(profileDoc(uid), data, { merge: true });
  } catch (error) {
    // Retry once for a transient network error.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // If retry fails, let the error propagate to the caller.
    await setDoc(profileDoc(uid), data, { merge: true });
  }
}


// =========================================================
// EMAIL VERIFICATION GATE (new signups only)
//
// A user must verify their email only if ALL of these are true:
//   - email not verified
//   - not the admin
//   - no freeAccess (existing/free shops are never blocked)
//   - no Razorpay subscription yet (existing paying shops are never blocked)
// Blocked users are signed out and sent to the login page.
// Returns true if the user was blocked.
// =========================================================

function verificationRequired(user, profile) {
  if (!user || user.emailVerified || isAdminUser(user)) return false;
  const p = profile || {};
  if (p.freeAccess === true) return false;
  if (p.razorpaySubscriptionId) return false;
  return true;
}

async function enforceEmailVerification(user) {
  if (!user || user.emailVerified || isAdminUser(user)) return false;

  let profile = {};
  try {
    const snap = await getDoc(profileDoc(user.uid));
    profile = snap.exists() ? snap.data() || {} : {};
  } catch (e) {
    console.error("Verification check failed:", e);
  }

  if (!verificationRequired(user, profile)) return false;

  try { await signOut(auth); } catch (e) { console.error(e); }
  window.location.replace("index.html?verify=1");
  return true;
}


// =========================================================
// AUTH GUARD FOR PROTECTED SHOP PAGES
//
// - Redirects signed-out users to index.html.
// - Signs out suspended users.
// - Creates a minimal profile if none exists.
// - Stops navigation if the profile check fails.
// - Does NOT itself grant or validate a subscription.
//   Billing access must also be checked by the dashboard
//   and trusted backend.
// =========================================================

function requireAuth(onReady) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("index.html");
      return;
    }

    // Admin pages have a separate requireAdmin() guard.
    // This preserves the previous behavior for admin navigation.
    if (isAdminUser(user)) {
      onReady(user);
      return;
    }

    try {
      const snap = await getDoc(profileDoc(user.uid));

      if (snap.exists()) {
        const profile = snap.data() || {};

        const isSuspended =
          profile.status === "suspended" ||
          profile.suspended === true ||
          profile.isSuspended === true;

        if (isSuspended) {
          await signOut(auth);
          window.location.replace("index.html?suspended=1");
          return;
        }
      } else {
        // Only ordinary profile data is created here.
        // Never set freeAccess, paymentStatus, or subscriptionStatus.
        await setDoc(profileDoc(user.uid), {
          email: user.email || "",
          shopName: "",
          ownerName: "",
          phone: "",
          createdAt: serverTimestamp(),
        });
      }

      if (verificationRequired(user, snap.exists() ? snap.data() : {})) {
        await signOut(auth);
        window.location.replace("index.html?verify=1");
        return;
      }

      onReady(user);
    } catch (error) {
      console.error("Authentication/profile check failed:", error);

      // Fail closed: do not continue into the protected page.
      try {
        await signOut(auth);
      } catch (signOutError) {
        console.error("Sign-out after verification failure failed:",
          signOutError);
      }

      window.location.replace("index.html");
    }
  });
}


// =========================================================
// ADMIN PAGE GUARD
// =========================================================

function requireAdmin(onReady) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.replace("index.html");
      return;
    }

    if (!isAdminUser(user)) {
      window.location.replace("dashboard.html");
      return;
    }

    onReady(user);
  });
}


// =========================================================
// EXPORTS
// =========================================================

export {
  app,
  auth,
  db,

  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,

  tenantCollection,
  tenantDoc,
  profileDoc,

  requireAuth,
  requireAdmin,
  isAdminUser,
  verificationRequired,
  enforceEmailVerification,
  createUserProfile,
};
