
const {
  onCall,
  onRequest,
  HttpsError,
} = require("firebase-functions/v2/https");

const {
  defineSecret,
  defineString,
} = require("firebase-functions/params");

const {
  setGlobalOptions,
} = require("firebase-functions");

const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");

admin.initializeApp();

const db = admin.firestore();

const razorpaySecret = defineSecret("RAZORPAY_KEY_SECRET");
const razorpayWebhookSecret = defineSecret("RAZORPAY_WEBHOOK_SECRET");
const razorpayKeyId = defineString("RAZORPAY_KEY_ID");

const RAZORPAY_PLAN_ID = "plan_TopYFcnfKAdwKd";

const TRIAL_DAYS = 15;
const AUTHORIZATION_AMOUNT = 100; // ₹1 in paise
const MONTHLY_AMOUNT = 49900; // ₹499 in paise
const CURRENCY = "INR";
const TOTAL_BILLING_CYCLES = 120;

setGlobalOptions({
  maxInstances: 10,
});


// =========================================================
// HELPERS
// =========================================================

function getRazorpay() {
  return new Razorpay({
    key_id: razorpayKeyId.value(),
    key_secret: razorpaySecret.value(),
  });
}

function safeCompareHex(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !/^[a-f0-9]+$/i.test(a) ||
    !/^[a-f0-9]+$/i.test(b)
  ) {
    return false;
  }

  const first = Buffer.from(a, "hex");
  const second = Buffer.from(b, "hex");

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function timestampFromUnix(seconds) {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return null;
  }

  return admin.firestore.Timestamp.fromMillis(seconds * 1000);
}

function isFreeAccount(data) {
  return data?.freeAccess === true;
}

function hasSubscriptionInProgress(data) {
  const id = data?.razorpaySubscriptionId;
  const status = String(data?.subscriptionStatus || "").toLowerCase();

  return Boolean(
    id &&
    [
      "created",
      "authenticated",
      "active",
      "trial",
      "pending",
      "halted",
      "paused",
    ].includes(status)
  );
}

function getSubscriptionState(data) {
  if (isFreeAccount(data)) {
    return "free";
  }

  const paymentStatus = String(data?.paymentStatus || "").toLowerCase();
  const subscriptionStatus = String(
    data?.subscriptionStatus || ""
  ).toLowerCase();

  if (
    paymentStatus === "paid" &&
    ["active", "authenticated"].includes(subscriptionStatus)
  ) {
    return "paid";
  }

  if (
    paymentStatus === "trial" &&
    ["active", "authenticated", "trial"].includes(subscriptionStatus)
  ) {
    return "trial";
  }

  return "restricted";
}


// =========================================================
// CREATE SUBSCRIPTION
// Existing free users are never charged.
// New users receive ₹1 authorization + 15-day trial.
// =========================================================

exports.createRazorpaySubscription = onCall(
  {
    secrets: [razorpaySecret],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Please sign in before subscribing."
      );
    }

    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);

    try {
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        throw new HttpsError(
          "not-found",
          "Your account profile was not found."
        );
      }

      const userData = userSnap.data() || {};

      // Existing free accounts do not need payment.
      if (isFreeAccount(userData)) {
        return {
          success: true,
          freeAccess: true,
          alreadySubscribed: true,
          message: "This account has free access.",
        };
      }

      // Do not create a second subscription for an existing one.
      if (hasSubscriptionInProgress(userData)) {
        return {
          success: false,
          alreadySubscribed: true,
          subscriptionId: userData.razorpaySubscriptionId || null,
          message: "A subscription already exists for this account.",
        };
      }

      const razorpay = getRazorpay();

      // Validate the configured Razorpay plan before creating a subscription.
      const plan = await razorpay.plans.fetch(RAZORPAY_PLAN_ID);

      if (
        plan.id !== RAZORPAY_PLAN_ID ||
        plan.item?.amount !== MONTHLY_AMOUNT ||
        plan.item?.currency !== CURRENCY ||
        plan.period !== "monthly" ||
        plan.interval !== 1
      ) {
        console.error("Configured Razorpay plan did not match expected billing.");

        throw new HttpsError(
          "failed-precondition",
          "The subscription plan configuration is incorrect. Please contact support."
        );
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const trialEndsAt = nowSeconds + TRIAL_DAYS * 24 * 60 * 60;

      /*
       * Reserve the account before contacting Razorpay.
       * This reduces concurrent duplicate creation from repeated clicks.
       */
      const lockRef = db.collection("subscriptionCreationLocks").doc(uid);
      const lockToken = crypto.randomUUID();

      await db.runTransaction(async (transaction) => {
        const freshUserSnap = await transaction.get(userRef);
        const lockSnap = await transaction.get(lockRef);

        if (!freshUserSnap.exists) {
          throw new HttpsError("not-found", "Account profile not found.");
        }

        const freshData = freshUserSnap.data() || {};

        if (isFreeAccount(freshData)) {
          throw new HttpsError(
            "failed-precondition",
            "This account already has free access."
          );
        }

        if (hasSubscriptionInProgress(freshData)) {
          throw new HttpsError(
            "already-exists",
            "A subscription already exists for this account."
          );
        }

        if (lockSnap.exists) {
          const lockData = lockSnap.data() || {};
          const createdAt = lockData.createdAt?.toMillis?.() || 0;
          const lockIsRecent = Date.now() - createdAt < 10 * 60 * 1000;

          if (lockIsRecent) {
            throw new HttpsError(
              "resource-exhausted",
              "Subscription setup is already in progress. Please wait and refresh."
            );
          }
        }

        transaction.set(lockRef, {
          token: lockToken,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      let subscription;

      try {
        subscription = await razorpay.subscriptions.create({
          plan_id: RAZORPAY_PLAN_ID,
          quantity: 1,
          total_count: TOTAL_BILLING_CYCLES,
          customer_notify: false,

          // First recurring monthly charge is scheduled after the trial.
          start_at: trialEndsAt,

          // Customer must complete authorization within 24 hours.
          expire_by: nowSeconds + 24 * 60 * 60,

          // One-time ₹1 charge in paise.
          addons: [
            {
              item: {
                name: "FRALEN CRM Registration Authorization",
                amount: AUTHORIZATION_AMOUNT,
                currency: CURRENCY,
              },
            },
          ],

          notes: {
            firebaseUid: uid,
            product: "FRALEN CRM Monthly Subscription",
            planId: RAZORPAY_PLAN_ID,
            trialDays: String(TRIAL_DAYS),
            monthlyAmount: String(MONTHLY_AMOUNT),
          },
        });
      } catch (error) {
        // Keep no stale lock after a known creation failure.
        await db.runTransaction(async (transaction) => {
          const lockSnap = await transaction.get(lockRef);

          if (lockSnap.exists && lockSnap.data()?.token === lockToken) {
            transaction.delete(lockRef);
          }
        });

        throw error;
      }

      // Save the subscription ID before the browser opens Checkout.
      await userRef.set(
        {
          paymentStatus: "pending",
          subscriptionStatus: "created",
          razorpaySubscriptionId: subscription.id,
          razorpayPlanId: RAZORPAY_PLAN_ID,
          subscriptionAmount: MONTHLY_AMOUNT,
          subscriptionCurrency: CURRENCY,
          authorizationAmount: AUTHORIZATION_AMOUNT,
          trialDays: TRIAL_DAYS,
          trialEndsAt: timestampFromUnix(subscription.start_at || trialEndsAt),
          subscriptionCreatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Release only this request's lock.
      await db.runTransaction(async (transaction) => {
        const lockSnap = await transaction.get(lockRef);

        if (lockSnap.exists && lockSnap.data()?.token === lockToken) {
          transaction.delete(lockRef);
        }
      });

      return {
        success: true,
        subscriptionId: subscription.id,
        keyId: razorpayKeyId.value(),
        planId: RAZORPAY_PLAN_ID,
        authorizationAmount: AUTHORIZATION_AMOUNT,
        monthlyAmount: MONTHLY_AMOUNT,
        trialDays: TRIAL_DAYS,
        trialEndsAt: subscription.start_at || trialEndsAt,
      };
    } catch (error) {
      console.error("Subscription creation failed:", error);

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        "internal",
        "Unable to create a subscription. Please try again or contact support."
      );
    }
  }
);


// =========================================================
// VERIFY FIRST AUTHORIZATION
// Verifies Checkout signature and fetches payment/subscription
// directly from Razorpay before updating the Firebase profile.
// =========================================================

exports.verifyRazorpaySubscription = onCall(
  {
    secrets: [razorpaySecret],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in.");
    }

    const uid = request.auth.uid;

    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
    } = request.data || {};

    if (
      !razorpay_payment_id ||
      !razorpay_subscription_id ||
      !razorpay_signature
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Missing Razorpay payment details."
      );
    }

    try {
      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        throw new HttpsError("not-found", "Account profile not found.");
      }

      const userData = userSnap.data() || {};

      if (isFreeAccount(userData)) {
        throw new HttpsError(
          "failed-precondition",
          "This account already has free access."
        );
      }

      if (
        userData.razorpaySubscriptionId !== razorpay_subscription_id
      ) {
        throw new HttpsError(
          "permission-denied",
          "This subscription does not belong to this account."
        );
      }

      const expectedSignature = crypto
        .createHmac("sha256", razorpaySecret.value())
        .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
        .digest("hex");

      if (!safeCompareHex(expectedSignature, razorpay_signature)) {
        throw new HttpsError(
          "permission-denied",
          "Invalid Razorpay signature."
        );
      }

      const razorpay = getRazorpay();

      const [subscription, payment] = await Promise.all([
        razorpay.subscriptions.fetch(razorpay_subscription_id),
        razorpay.payments.fetch(razorpay_payment_id),
      ]);

      if (
        subscription.id !== razorpay_subscription_id ||
        subscription.plan_id !== RAZORPAY_PLAN_ID
      ) {
        throw new HttpsError(
          "permission-denied",
          "The subscription or plan does not match."
        );
      }

      // Ensure the subscription is in an authorization-compatible state.
      if (
        !["authenticated", "active"].includes(subscription.status)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Razorpay has not confirmed the subscription authorization yet."
        );
      }

      if (
        payment.amount !== AUTHORIZATION_AMOUNT ||
        payment.currency !== CURRENCY ||
        !["authorized", "captured"].includes(payment.status)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "The ₹1 authorization payment has not been verified."
        );
      }

      // If Razorpay supplies the subscription ID on the payment, it must match.
      if (
        payment.subscription_id &&
        payment.subscription_id !== razorpay_subscription_id
      ) {
        throw new HttpsError(
          "permission-denied",
          "The payment is linked to a different subscription."
        );
      }

      const trialEndSeconds =
        subscription.start_at || userData.trialEndsAt?.seconds || null;

      const nextBillingSeconds = subscription.charge_at || null;

      const updates = {
        paymentStatus: "trial",
        subscriptionStatus: subscription.status,
        razorpaySubscriptionId: razorpay_subscription_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpayPlanId: RAZORPAY_PLAN_ID,
        authorizationAmount: payment.amount,
        authorizationCurrency: payment.currency,
        paymentMethod: payment.method || null,
        authorizationVerifiedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      if (trialEndSeconds) {
        updates.trialEndsAt = timestampFromUnix(trialEndSeconds);
      }

      if (nextBillingSeconds) {
        updates.nextBillingAt = timestampFromUnix(nextBillingSeconds);
      }

      await userRef.set(updates, { merge: true });

      return {
        success: true,
        paymentStatus: "trial",
        subscriptionStatus: subscription.status,
        subscriptionId: razorpay_subscription_id,
        trialEndsAt: trialEndSeconds,
        nextBillingAt: nextBillingSeconds,
        message: "Authorization verified. Trial access has been recorded.",
      };
    } catch (error) {
      console.error("Subscription verification failed:", error);

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        "internal",
        "Subscription verification failed. Please contact support if you completed payment."
      );
    }
  }
);


// =========================================================
// RAZORPAY WEBHOOK
// - Validates signature using the raw request body.
// - Deduplicates webhook events.
// - Ignores older out-of-order events.
// - Updates subscription status through the trusted backend.
// =========================================================

exports.razorpayWebhook = onRequest(
  {
    secrets: [razorpayWebhookSecret],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const signature = req.headers["x-razorpay-signature"];

      if (
        typeof signature !== "string" ||
        !Buffer.isBuffer(req.rawBody)
      ) {
        res.status(400).send("Missing signature or raw body");
        return;
      }

      const expectedSignature = crypto
        .createHmac("sha256", razorpayWebhookSecret.value())
        .update(req.rawBody)
        .digest("hex");

      if (!safeCompareHex(expectedSignature, signature)) {
        console.error("Rejected webhook with invalid signature.");
        res.status(401).send("Invalid signature");
        return;
      }

      const event = req.body || {};
      const eventName = event.event;

      const subscriptionEntity =
        event.payload?.subscription?.entity;

      const paymentEntity =
        event.payload?.payment?.entity;

      const subscriptionId = subscriptionEntity?.id;

      // This endpoint is configured for subscription lifecycle events.
      if (!subscriptionId) {
        res.status(200).send("No subscription entity");
        return;
      }

      const supportedEvents = new Set([
        "subscription.authenticated",
        "subscription.activated",
        "subscription.charged",
        "subscription.pending",
        "subscription.halted",
        "subscription.cancelled",
        "subscription.paused",
        "subscription.resumed",
        "subscription.completed",
        "subscription.updated",
      ]);

      if (!supportedEvents.has(eventName)) {
        res.status(200).send("Event ignored");
        return;
      }

      const snapshot = await db
        .collection("users")
        .where("razorpaySubscriptionId", "==", subscriptionId)
        .limit(1)
        .get();

      if (snapshot.empty) {
        console.warn("No Firebase user for subscription:", subscriptionId);
        res.status(200).send("Subscription not found");
        return;
      }

      const userRef = snapshot.docs[0].ref;
      const userData = snapshot.docs[0].data() || {};

      // Existing free accounts must never be downgraded by a stale webhook.
      if (isFreeAccount(userData)) {
        res.status(200).send("Free account ignored");
        return;
      }

      const eventId =
        req.headers["x-razorpay-event-id"] ||
        event.id ||
        crypto.createHash("sha256").update(req.rawBody).digest("hex");

      const eventRef = db
        .collection("razorpayWebhookEvents")
        .doc(String(eventId));

      const eventCreatedAt =
        typeof event.created_at === "number" ? event.created_at : 0;

      const updates = {
        razorpaySubscriptionId: subscriptionId,
        lastRazorpayWebhookEvent: eventName,
        lastRazorpayWebhookAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      if (eventName === "subscription.authenticated") {
        updates.subscriptionStatus = "authenticated";

        if (userData.paymentStatus !== "paid") {
          updates.paymentStatus = "trial";
        }
      }

      if (eventName === "subscription.activated") {
        updates.subscriptionStatus = "active";

        if (userData.paymentStatus !== "paid") {
          updates.paymentStatus = "trial";
        }

        const trialEnd = timestampFromUnix(subscriptionEntity.start_at);

        if (trialEnd) {
          updates.trialEndsAt = trialEnd;
        }

        const nextBilling = timestampFromUnix(subscriptionEntity.charge_at);

        if (nextBilling) {
          updates.nextBillingAt = nextBilling;
        }
      }

      if (eventName === "subscription.charged") {
        updates.subscriptionStatus = "active";
        updates.paymentStatus = "paid";

        if (paymentEntity?.id) {
          updates.lastRazorpayPaymentId = paymentEntity.id;
        }

        if (typeof paymentEntity?.amount === "number") {
          updates.lastPaymentAmount = paymentEntity.amount;
        }

        if (paymentEntity?.currency) {
          updates.lastPaymentCurrency = paymentEntity.currency;
        }

        updates.lastPaymentAt =
          admin.firestore.FieldValue.serverTimestamp();

        const nextBilling = timestampFromUnix(subscriptionEntity.charge_at);

        if (nextBilling) {
          updates.nextBillingAt = nextBilling;
        }
      }

      if (eventName === "subscription.pending") {
        updates.subscriptionStatus = "pending";
        updates.paymentStatus = "payment_pending";
      }

      if (eventName === "subscription.halted") {
        updates.subscriptionStatus = "halted";
        updates.paymentStatus = "suspended";
      }

      if (eventName === "subscription.paused") {
        updates.subscriptionStatus = "paused";
        updates.paymentStatus = "paused";
      }

      if (eventName === "subscription.resumed") {
        updates.subscriptionStatus = "active";

        if (userData.paymentStatus !== "paid") {
          updates.paymentStatus = "trial";
        }
      }

      if (
        eventName === "subscription.cancelled" ||
        eventName === "subscription.completed"
      ) {
        updates.subscriptionStatus =
          eventName === "subscription.completed" ? "completed" : "cancelled";

        updates.paymentStatus = "cancelled";
      }

      if (eventName === "subscription.updated") {
        updates.subscriptionStatus =
          subscriptionEntity.status || userData.subscriptionStatus || "pending";

        const nextBilling = timestampFromUnix(subscriptionEntity.charge_at);

        if (nextBilling) {
          updates.nextBillingAt = nextBilling;
        }
      }

      await db.runTransaction(async (transaction) => {
        const [eventSnap, freshUserSnap] = await Promise.all([
          transaction.get(eventRef),
          transaction.get(userRef),
        ]);

        // Razorpay may retry a webhook; process each event only once.
        if (eventSnap.exists) {
          return;
        }

        if (!freshUserSnap.exists) {
          transaction.set(eventRef, {
            event: eventName,
            result: "user_missing",
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return;
        }

        const freshData = freshUserSnap.data() || {};

        if (isFreeAccount(freshData)) {
          transaction.set(eventRef, {
            event: eventName,
            result: "free_account_ignored",
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return;
        }

        const lastEventCreatedAt =
          freshData.lastRazorpayWebhookCreatedAt || 0;

        // Ignore older webhook events arriving after newer ones.
        if (
          eventCreatedAt > 0 &&
          lastEventCreatedAt > 0 &&
          eventCreatedAt < lastEventCreatedAt
        ) {
          transaction.set(eventRef, {
            event: eventName,
            result: "stale_event_ignored",
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return;
        }

        const finalUpdates = { ...updates };

        if (eventCreatedAt > 0) {
          finalUpdates.lastRazorpayWebhookCreatedAt = eventCreatedAt;
        }

        transaction.set(userRef, finalUpdates, { merge: true });

        transaction.set(eventRef, {
          event: eventName,
          subscriptionId,
          result: "processed",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      res.status(200).send("OK");
    } catch (error) {
      console.error("Razorpay webhook processing failed:", error);
      res.status(500).send("Webhook processing failed");
    }
  }
);
