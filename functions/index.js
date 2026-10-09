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

/* eslint-disable camelcase */

admin.initializeApp();

const db = admin.firestore();

const razorpaySecret = defineSecret("RAZORPAY_KEY_SECRET");
const razorpayKeyId = defineString("RAZORPAY_KEY_ID");

/*
 * IMPORTANT
 * Create this secret later in Firebase:
 *
 * RAZORPAY_WEBHOOK_SECRET
 */
const razorpayWebhookSecret = defineSecret(
  "RAZORPAY_WEBHOOK_SECRET"
);

const RAZORPAY_PLAN_ID = "plan_TlHAyzxo0oEVwg";

const TRIAL_DAYS = 15;
const AUTHORIZATION_AMOUNT = 100; // ₹1
const MONTHLY_AMOUNT = 49900; // ₹499

setGlobalOptions({
  maxInstances: 10,
});

/**
 * Create Razorpay Subscription
 *
 * Flow:
 * User clicks Pay
 * -> Subscription created
 * -> ₹1 authorization/upfront charge
 * -> 15 day trial
 * -> ₹499 monthly recurring
 */
exports.createRazorpaySubscription = onCall(
  {
    secrets: [razorpaySecret],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be logged in to subscribe."
      );
    }

    const uid = request.auth.uid;

    try {
      const razorpay = new Razorpay({
        key_id: razorpayKeyId.value(),
        key_secret: razorpaySecret.value(),
      });

      const userRef = db.collection("users").doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        throw new HttpsError(
          "not-found",
          "User profile not found."
        );
      }

      const userData = userSnap.data();

      /*
       * Prevent duplicate active subscriptions.
       */
      if (
        userData.razorpaySubscriptionId &&
        ["active", "authenticated", "trial"].includes(
          userData.subscriptionStatus
        )
      ) {
        return {
          success: false,
          alreadySubscribed: true,
          subscriptionId:
            userData.razorpaySubscriptionId,
          message: "Subscription already exists.",
        };
      }

      const nowSeconds =
        Math.floor(Date.now() / 1000);

      const trialEndsAt =
        nowSeconds + TRIAL_DAYS * 24 * 60 * 60;

      /*
       * Razorpay requires total_count.
       *
       * 120 = 120 monthly billing cycles.
       * This gives approximately 10 years of recurring
       * billing unless the subscription is cancelled.
       */
      const totalCount = 120;

      const subscription =
        await razorpay.subscriptions.create({
          plan_id: RAZORPAY_PLAN_ID,

          quantity: 1,

          total_count: totalCount,

          customer_notify: false,

          /*
           * First recurring ₹499 charge starts
           * after 15 days.
           */
          start_at: trialEndsAt,

          /*
           * Customer gets time to complete
           * authorization after subscription creation.
           */
          expire_by:
            nowSeconds + 24 * 60 * 60,

          /*
           * ₹1 upfront authorization charge.
           */
          addons: [
            {
              item: {
                name: "FRALEN CRM Registration",
                amount: AUTHORIZATION_AMOUNT,
                currency: "INR",
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

      /*
       * Save subscription information BEFORE
       * opening Checkout.
       */
      await userRef.set(
        {
          paymentStatus: "pending",

          subscriptionStatus: "created",

          razorpaySubscriptionId:
            subscription.id,

          razorpayPlanId:
            RAZORPAY_PLAN_ID,

          subscriptionAmount:
            MONTHLY_AMOUNT,

          subscriptionCurrency: "INR",

          authorizationAmount:
            AUTHORIZATION_AMOUNT,

          trialDays: TRIAL_DAYS,

          trialEndsAt:
            admin.firestore.Timestamp.fromMillis(
              trialEndsAt * 1000
            ),

          subscriptionCreatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      return {
        success: true,

        subscriptionId:
          subscription.id,

        keyId:
          razorpayKeyId.value(),

        planId:
          RAZORPAY_PLAN_ID,

        authorizationAmount:
          AUTHORIZATION_AMOUNT,

        monthlyAmount:
          MONTHLY_AMOUNT,

        trialDays:
          TRIAL_DAYS,

        trialEndsAt,
      };
    } catch (error) {
      console.error(
        "Razorpay subscription creation failed:",
        error
      );

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        "internal",
        "Unable to create Razorpay subscription."
      );
    }
  }
);


/**
 * Verify the first Razorpay Subscription authorization.
 *
 * Razorpay returns:
 * - razorpay_payment_id
 * - razorpay_subscription_id
 * - razorpay_signature
 */
exports.verifyRazorpaySubscription = onCall(
  {
    secrets: [razorpaySecret],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be logged in."
      );
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
        "Missing Razorpay subscription payment details."
      );
    }

    try {
      const userRef =
        db.collection("users").doc(uid);

      const userSnap =
        await userRef.get();

      if (!userSnap.exists) {
        throw new HttpsError(
          "not-found",
          "User profile not found."
        );
      }

      const userData =
        userSnap.data();

      /*
       * Make sure this subscription belongs
       * to the logged-in Firebase user.
       */
      if (
        userData.razorpaySubscriptionId !==
        razorpay_subscription_id
      ) {
        throw new HttpsError(
          "permission-denied",
          "This subscription does not belong to this account."
        );
      }

      /*
       * Razorpay Subscription signature:
       *
       * payment_id + "|" + subscription_id
       */
      const generatedSignature =
        crypto
          .createHmac(
            "sha256",
            razorpaySecret.value()
          )
          .update(
            `${razorpay_payment_id}|${razorpay_subscription_id}`
          )
          .digest("hex");

      if (
        !crypto.timingSafeEqual(
          Buffer.from(generatedSignature),
          Buffer.from(razorpay_signature)
        )
      ) {
        throw new HttpsError(
          "permission-denied",
          "Invalid Razorpay subscription signature."
        );
      }

      const razorpay =
        new Razorpay({
          key_id:
            razorpayKeyId.value(),
          key_secret:
            razorpaySecret.value(),
        });

      /*
       * Fetch subscription from Razorpay
       * instead of trusting frontend data.
       */
      const subscription =
        await razorpay.subscriptions.fetch(
          razorpay_subscription_id
        );

      if (
        subscription.plan_id !==
        RAZORPAY_PLAN_ID
      ) {
        throw new HttpsError(
          "permission-denied",
          "Invalid subscription plan."
        );
      }

      /*
       * Fetch the authorization payment.
       */
      const payment =
        await razorpay.payments.fetch(
          razorpay_payment_id
        );

      if (
        payment.amount !==
        AUTHORIZATION_AMOUNT
      ) {
        throw new HttpsError(
          "invalid-argument",
          "Invalid authorization amount."
        );
      }

      /*
       * First authorization can be
       * authorized/captured depending on
       * Razorpay configuration.
       */
      const validPaymentStatus =
        [
          "authorized",
          "captured",
        ].includes(payment.status);

      if (!validPaymentStatus) {
        throw new HttpsError(
          "failed-precondition",
          "Authorization payment was not successful."
        );
      }

      await userRef.set(
        {
          paymentStatus: "trial",

          subscriptionStatus:
            subscription.status,

          razorpaySubscriptionId:
            razorpay_subscription_id,

          razorpayPaymentId:
            razorpay_payment_id,

          razorpayPlanId:
            RAZORPAY_PLAN_ID,

          authorizationAmount:
            payment.amount,

          authorizationCurrency:
            payment.currency,

          paymentMethod:
            payment.method || null,

          authorizationVerifiedAt:
            admin.firestore.FieldValue.serverTimestamp(),

          trialEndsAt:
            admin.firestore.Timestamp.fromMillis(
              subscription.start_at * 1000
            ),

          nextBillingAt:
            admin.firestore.Timestamp.fromMillis(
              subscription.charge_at * 1000
            ),
        },
        {
          merge: true,
        }
      );

      return {
        success: true,

        paymentStatus: "trial",

        subscriptionStatus:
          subscription.status,

        subscriptionId:
          razorpay_subscription_id,

        trialEndsAt:
          subscription.start_at,

        nextBillingAt:
          subscription.charge_at,

        message:
          "₹1 authorization successful. Your 15-day trial has started.",
      };
    } catch (error) {
      console.error(
        "Razorpay subscription verification failed:",
        error
      );

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        "internal",
        "Subscription verification failed."
      );
    }
  }
);


/**
 * Razorpay Webhook
 *
 * Handles:
 * - subscription.activated
 * - subscription.charged
 * - subscription.pending
 * - subscription.halted
 * - subscription.cancelled
 */
exports.razorpayWebhook = onRequest(
  {
    secrets: [
      razorpayWebhookSecret,
    ],
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res
          .status(405)
          .send("Method Not Allowed");
        return;
      }

      const signature =
        req.headers["x-razorpay-signature"];

      if (!signature) {
        res
          .status(400)
          .send("Missing webhook signature");
        return;
      }

      const rawBody = req.rawBody;

      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            razorpayWebhookSecret.value()
          )
          .update(rawBody)
          .digest("hex");

      if (
        !crypto.timingSafeEqual(
          Buffer.from(expectedSignature),
          Buffer.from(signature)
        )
      ) {
        console.error(
          "Invalid Razorpay webhook signature."
        );

        res
          .status(401)
          .send("Invalid signature");

        return;
      }

      const event = req.body;

      const eventName =
        event.event;

      const subscriptionEntity =
        event.payload?.subscription?.entity;

      const paymentEntity =
        event.payload?.payment?.entity;

      const subscriptionId =
        subscriptionEntity?.id;

      if (!subscriptionId) {
        res.status(200).send("OK");
        return;
      }

      /*
       * Find Firebase user using
       * razorpaySubscriptionId.
       */
      const snapshot =
        await db
          .collection("users")
          .where(
            "razorpaySubscriptionId",
            "==",
            subscriptionId
          )
          .limit(1)
          .get();

      if (snapshot.empty) {
        console.warn(
          "No Firebase user found for subscription:",
          subscriptionId
        );

        res.status(200).send("OK");
        return;
      }

      const userRef =
        snapshot.docs[0].ref;

      const updateData = {
        razorpaySubscriptionId:
          subscriptionId,

        lastRazorpayWebhookEvent:
          eventName,

        lastRazorpayWebhookAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      /*
       * Subscription activated
       */
      if (
        eventName ===
        "subscription.activated"
      ) {
        updateData.subscriptionStatus =
          "active";

        /*
         * During the 15-day trial we still
         * keep paymentStatus as trial.
         */
        updateData.paymentStatus =
          "trial";

        if (
          subscriptionEntity.start_at
        ) {
          updateData.trialEndsAt =
            admin.firestore.Timestamp.fromMillis(
              subscriptionEntity.start_at *
                1000
            );
        }

        if (
          subscriptionEntity.charge_at
        ) {
          updateData.nextBillingAt =
            admin.firestore.Timestamp.fromMillis(
              subscriptionEntity.charge_at *
                1000
            );
        }
      }


      /*
       * Successful recurring payment
       */
      if (
        eventName ===
        "subscription.charged"
      ) {
        updateData.subscriptionStatus =
          "active";

        updateData.paymentStatus =
          "paid";

        if (paymentEntity?.id) {
          updateData.lastRazorpayPaymentId =
            paymentEntity.id;
        }

        if (paymentEntity?.amount) {
          updateData.lastPaymentAmount =
            paymentEntity.amount;
        }

        if (paymentEntity?.currency) {
          updateData.lastPaymentCurrency =
            paymentEntity.currency;
        }

        updateData.lastPaymentAt =
          admin.firestore.FieldValue.serverTimestamp();

        if (
          subscriptionEntity.charge_at
        ) {
          updateData.nextBillingAt =
            admin.firestore.Timestamp.fromMillis(
              subscriptionEntity.charge_at *
                1000
            );
        }
      }


      /*
       * Payment/subscription pending
       */
      if (
        eventName ===
        "subscription.pending"
      ) {
        updateData.subscriptionStatus =
          "pending";

        updateData.paymentStatus =
          "payment_pending";
      }


      /*
       * Subscription halted after retries
       */
      if (
        eventName ===
        "subscription.halted"
      ) {
        updateData.subscriptionStatus =
          "halted";

        updateData.paymentStatus =
          "suspended";
      }


      /*
       * Subscription cancelled
       */
      if (
        eventName ===
        "subscription.cancelled"
      ) {
        updateData.subscriptionStatus =
          "cancelled";

        updateData.paymentStatus =
          "cancelled";
      }


      await userRef.set(
        updateData,
        {
          merge: true,
        }
      );

      res.status(200).send("OK");
    } catch (error) {
      console.error(
        "Razorpay webhook error:",
        error
      );

      res.status(500).send("Webhook error");
    }
  }
);
