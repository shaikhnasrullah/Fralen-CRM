const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const {setGlobalOptions} = require("firebase-functions");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");
/* eslint-disable camelcase*/

admin.initializeApp();

const db = admin.firestore();

// Firebase Secret Manager
const razorpaySecret = defineSecret("RAZORPAY_KEY_SECRET");

// Razorpay Key ID is public and safe to use in frontend,
// but we keep it in Firebase configuration for now.
const razorpayKeyId = defineString("RAZORPAY_KEY_ID");

setGlobalOptions({
  maxInstances: 10,
});

/**
 * Create Razorpay Order
 */
exports.createRazorpayOrder = onCall(
    {
      secrets: [razorpaySecret],
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "You must be logged in to make a payment.",
        );
      }

      const uid = request.auth.uid;

      try {
        const razorpay = new Razorpay({
          key_id: razorpayKeyId.value(),
          key_secret: razorpaySecret.value(),
        });

        // FRALEN CRM subscription amount: ₹999
        const amount = 100;

        const receipt = `fralen_${uid}_${Date.now()}`;

        const order = await razorpay.orders.create({
          amount,
          currency: "INR",
          receipt,
          notes: {
            firebaseUid: uid,
            product: "FRALEN CRM Subscription",
          },
        });

        // Save order against the logged-in user
        await db.collection("users").doc(uid).set(
            {
              paymentStatus: "pending",
              razorpayOrderId: order.id,
              razorpayOrderCreatedAt:
            admin.firestore.FieldValue.serverTimestamp(),
              paymentAmount: amount,
              paymentCurrency: "INR",
            },
            {merge: true},
        );

        return {
          success: true,
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          keyId: razorpayKeyId.value(),
        };
      } catch (error) {
        console.error("Razorpay order creation failed:", error);

        throw new HttpsError(
            "internal",
            "Unable to create Razorpay order.",
        );
      }
    },
);

/**
 * Verify Razorpay Payment
 */
exports.verifyRazorpayPayment = onCall(
    {
      secrets: [razorpaySecret],
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
            "unauthenticated",
            "You must be logged in.",
        );
      }

      const uid = request.auth.uid;

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = request.data || {};

      if (
        !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
      ) {
        throw new HttpsError(
            "invalid-argument",
            "Missing Razorpay payment details.",
        );
      }

      try {
        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
          throw new HttpsError(
              "not-found",
              "User profile not found.",
          );
        }

        const userData = userSnap.data();

        // Make sure this order belongs to the logged-in user.
        if (userData.razorpayOrderId !== razorpay_order_id) {
          throw new HttpsError(
              "permission-denied",
              "This payment order does not belong to this account.",
          );
        }

        // Verify Razorpay signature
        const generatedSignature = crypto
            .createHmac("sha256", razorpaySecret.value())
            .update(
                `${razorpay_order_id}|${razorpay_payment_id}`,
            )
            .digest("hex");

        if (generatedSignature !== razorpay_signature) {
          throw new HttpsError(
              "permission-denied",
              "Invalid Razorpay payment signature.",
          );
        }

        // Fetch payment directly from Razorpay
        const razorpay = new Razorpay({
          key_id: razorpayKeyId.value(),
          key_secret: razorpaySecret.value(),
        });

        const payment = await razorpay.payments.fetch(
            razorpay_payment_id,
        );

        // Additional security checks
        if (payment.order_id !== razorpay_order_id) {
          throw new HttpsError(
              "permission-denied",
              "Payment order mismatch.",
          );
        }

        if (payment.amount !== 100) {
          throw new HttpsError(
              "invalid-argument",
              "Incorrect payment amount.",
          );
        }

        if (payment.status !== "captured") {
          throw new HttpsError(
              "failed-precondition",
              "Payment has not been captured yet.",
          );
        }

        // Payment verified successfully
        await userRef.set(
            {
              paymentStatus: "paid",

              razorpayOrderId: razorpay_order_id,
              razorpayPaymentId: razorpay_payment_id,

              paymentAmount: payment.amount,
              paymentCurrency: payment.currency,
              paymentMethod: payment.method || null,

              paymentVerifiedAt:
            admin.firestore.FieldValue.serverTimestamp(),

              lastPaymentSubmission: {
                transactionId: razorpay_payment_id,
                amount: payment.amount / 100,
              },
            },
            {merge: true},
        );

        return {
          success: true,
          paymentStatus: "paid",
          message: "Payment verified successfully.",
        };
      } catch (error) {
        console.error("Razorpay verification failed:", error);

        if (error instanceof HttpsError) {
          throw error;
        }

        throw new HttpsError(
            "internal",
            "Payment verification failed.",
        );
      }
    },
);
