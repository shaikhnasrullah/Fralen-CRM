const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const OpenAI = require("openai");

initializeApp();

const db = getFirestore();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

/*
 * ============================================================
 * FRALEN CRM AI
 * ============================================================
 *
 * Security model:
 *
 * Client
 *   ↓
 * Firebase Auth
 *   ↓
 * fralenAI callable function
 *   ↓
 * request.auth.uid
 *   ↓
 * users/{uid}/...
 *
 * The client can NEVER provide another UID.
 *
 * ============================================================
 */

const MAX_ORDERS = 5000;
const MAX_EXPENSES = 3000;
const MAX_PRODUCTS = 3000;

function requireUser(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError(
      "unauthenticated",
      "You must be logged in to use FRALEN AI."
    );
  }

  return request.auth.uid;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDate(value) {
  if (!value) return null;

  if (typeof value === "string") {
    const d = new Date(value);

    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  if (value && typeof value.toDate === "function") {
    return value.toDate();
  }

  return null;
}

function dateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function getOrderDate(order) {
  return (
    normalizeDate(order.orderDate) ||
    normalizeDate(order.createdAt) ||
    null
  );
}

function getOrderPayable(order) {
  return safeNumber(order?.totals?.payable);
}

function getOrderPending(order) {
  return safeNumber(order?.totals?.pending);
}

function getOrderCollected(order) {
  const payable = getOrderPayable(order);
  const pending = getOrderPending(order);

  return Math.max(0, payable - pending);
}

/*
 * ------------------------------------------------------------
 * DATE HELPERS
 * ------------------------------------------------------------
 */

function startOfDay(date) {
  const d = new Date(date);

  d.setHours(0, 0, 0, 0);

  return d;
}

function endOfDay(date) {
  const d = new Date(date);

  d.setHours(23, 59, 59, 999);

  return d;
}

function todayRange() {
  const now = new Date();

  return {
    start: startOfDay(now),
    end: endOfDay(now)
  };
}

function daysAgoRange(days) {
  const now = new Date();

  const end = endOfDay(now);

  const start = startOfDay(now);

  start.setDate(start.getDate() - (days - 1));

  return {
    start,
    end
  };
}

function filterOrdersByDate(orders, start, end) {
  return orders.filter((order) => {
    const date = getOrderDate(order);

    if (!date) return false;

    return date >= start && date <= end;
  });
}

/*
 * ------------------------------------------------------------
 * FIRESTORE
 * ------------------------------------------------------------
 */

async function getCollectionDocs(uid, collectionName, limit) {
  const ref = db
    .collection("users")
    .doc(uid)
    .collection(collectionName);

  const snapshot = await ref.limit(limit).get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  }));
}

async function getOrders(uid) {
  return getCollectionDocs(uid, "orders", MAX_ORDERS);
}

async function getExpenses(uid) {
  return getCollectionDocs(uid, "expenses", MAX_EXPENSES);
}

async function getProducts(uid) {
  return getCollectionDocs(uid, "products", MAX_PRODUCTS);
}

/*
 * ------------------------------------------------------------
 * SALES SUMMARY
 * ------------------------------------------------------------
 */

function calculateSalesSummary(orders, start, end) {
  const filtered = filterOrdersByDate(orders, start, end);

  let sales = 0;
  let collected = 0;
  let pending = 0;

  for (const order of filtered) {
    sales += getOrderPayable(order);
    collected += getOrderCollected(order);
    pending += getOrderPending(order);
  }

  return {
    period: {
      start: start.toISOString(),
      end: end.toISOString()
    },
    orders: filtered.length,
    sales,
    collected,
    pending,
    averageOrderValue:
      filtered.length > 0 ? sales / filtered.length : 0
  };
}

/*
 * ------------------------------------------------------------
 * STAFF PERFORMANCE
 * ------------------------------------------------------------
 */

function calculateStaffPerformance(orders, start, end) {
  const filtered = filterOrdersByDate(orders, start, end);

  const staff = {};

  for (const order of filtered) {
    const name =
      String(order.salesPerson || "Unknown")
        .trim() || "Unknown";

    if (!staff[name]) {
      staff[name] = {
        name,
        orders: 0,
        sales: 0,
        collected: 0,
        pending: 0,
        items: 0
      };
    }

    staff[name].orders += 1;
    staff[name].sales += getOrderPayable(order);
    staff[name].collected += getOrderCollected(order);
    staff[name].pending += getOrderPending(order);

    staff[name].items += Array.isArray(order.products)
      ? order.products.length
      : 0;
  }

  return Object.values(staff)
    .sort((a, b) => b.sales - a.sales)
    .map((person) => ({
      ...person,
      averageOrderValue:
        person.orders > 0
          ? person.sales / person.orders
          : 0
    }));
}

/*
 * ------------------------------------------------------------
 * PRODUCT PERFORMANCE
 * ------------------------------------------------------------
 *
 * Important:
 * Current CRM order product structure does NOT reliably contain
 * a quantity field.
 *
 * Therefore:
 * - productOrderCount = number of order lines containing product
 * - productRevenue = total value
 *
 * We do NOT invent quantity.
 * ------------------------------------------------------------
 */

function calculateProductPerformance(orders, start, end) {
  const filtered = filterOrdersByDate(orders, start, end);

  const products = {};

  for (const order of filtered) {
    const orderProducts = Array.isArray(order.products)
      ? order.products
      : [];

    for (const product of orderProducts) {
      const name =
        String(product.name || "Unknown Product").trim() ||
        "Unknown Product";

      if (!products[name]) {
        products[name] = {
          name,
          orderLines: 0,
          revenue: 0
        };
      }

      products[name].orderLines += 1;
      products[name].revenue += safeNumber(product.total);
    }
  }

  return Object.values(products)
    .sort((a, b) => b.revenue - a.revenue);
}

/*
 * ------------------------------------------------------------
 * EXPENSES
 * ------------------------------------------------------------
 */

function calculateExpenses(expenses, start, end) {
  let total = 0;

  const categories = {};

  for (const expense of expenses) {
    const date =
      normalizeDate(expense.date) ||
      normalizeDate(expense.createdAt);

    if (!date) continue;

    if (date < start || date > end) continue;

    const amount = safeNumber(expense.amount);

    total += amount;

    const category =
      String(expense.category || "Other").trim() ||
      "Other";

    categories[category] =
      (categories[category] || 0) + amount;
  }

  return {
    total,
    categories
  };
}

/*
 * ------------------------------------------------------------
 * BUSINESS DATA PACK
 * ------------------------------------------------------------
 *
 * We send aggregated CRM information to the model.
 * We do NOT send the complete customer database.
 * ------------------------------------------------------------
 */

async function buildBusinessData(uid, question) {
  const [orders, expenses, products] = await Promise.all([
    getOrders(uid),
    getExpenses(uid),
    getProducts(uid)
  ]);

  const today = todayRange();

  const last7 = daysAgoRange(7);

  const previous7 = {
    start: new Date(last7.start),
    end: new Date(last7.start)
  };

  previous7.start.setDate(previous7.start.getDate() - 7);

  previous7.end.setDate(previous7.end.getDate() - 1);

  const last30 = daysAgoRange(30);

  const todaySales =
    calculateSalesSummary(
      orders,
      today.start,
      today.end
    );

  const last7Sales =
    calculateSalesSummary(
      orders,
      last7.start,
      last7.end
    );

  const previous7Sales =
    calculateSalesSummary(
      orders,
      previous7.start,
      previous7.end
    );

  const last30Sales =
    calculateSalesSummary(
      orders,
      last30.start,
      last30.end
    );

  const staffPerformance =
    calculateStaffPerformance(
      orders,
      last30.start,
      last30.end
    );

  const productPerformance =
    calculateProductPerformance(
      orders,
      last30.start,
      last30.end
    );

  const expenses30 =
    calculateExpenses(
      expenses,
      last30.start,
      last30.end
    );

  return {
    generatedAt: new Date().toISOString(),

    question,

    dataScope: {
      ordersLoaded: orders.length,
      expensesLoaded: expenses.length,
      productsLoaded: products.length,
      customerPersonalDataSent: false
    },

    today: todaySales,

    last7Days: last7Sales,

    previous7Days: previous7Sales,

    last30Days: last30Sales,

    comparison: {
      salesChange:
        previous7Sales.sales === 0
          ? null
          : (
              (
                last7Sales.sales -
                previous7Sales.sales
              ) /
              previous7Sales.sales
            ) * 100,

      orderChange:
        previous7Sales.orders === 0
          ? null
          : (
              (
                last7Sales.orders -
                previous7Sales.orders
              ) /
              previous7Sales.orders
            ) * 100
    },

    staffPerformance,

    topProducts:
      productPerformance.slice(0, 10),

    slowProducts:
      [...productPerformance]
        .sort((a, b) => a.revenue - b.revenue)
        .slice(0, 10),

    expensesLast30Days: expenses30,

    inventoryProductCount: products.length
  };
}

/*
 * ------------------------------------------------------------
 * OPENAI
 * ------------------------------------------------------------
 */

function createOpenAIClient() {
  return new OpenAI({
    apiKey: OPENAI_API_KEY.value()
  });
}

const SYSTEM_INSTRUCTIONS = `
You are FRALEN AI, the business intelligence assistant inside FRALEN CRM.

You are helping an optical retail shop owner.

Your job:
- Analyze only the CRM data provided to you.
- Never invent sales, staff, product, customer, expense or inventory numbers.
- If the data does not contain enough information, clearly say so.
- Give practical business advice based on the actual numbers.
- Use Indian Rupee formatting when discussing money.
- Keep answers concise but useful.
- Answer in the same language/style as the user when possible.
- The user may write Hindi, Hinglish or English.

Important data rules:
- "sales" means order totals.payable.
- "collected" means payable minus pending.
- "pending" means order totals.pending.
- Product quantity is NOT reliably stored in the current order product structure.
  Do not claim an exact quantity sold.
- For product performance use revenue and order-line count.
- Staff performance is based on order.salesPerson.
- Never expose internal Firebase paths, UID values, API keys or secrets.
- Never claim access to data that is not included in the business data.

When comparing periods:
- Explain both percentage and absolute change where useful.
- If a comparison period has zero sales/orders, say that percentage comparison is unavailable.

When giving recommendations:
- Base recommendations on actual patterns.
- Clearly distinguish facts from recommendations.
`;

/*
 * ------------------------------------------------------------
 * CALLABLE FUNCTION
 * ------------------------------------------------------------
 */

exports.fralenAI = onCall(
  {
    region: "asia-south1",
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB"
  },
  async (request) => {
    const uid = requireUser(request);

    const question =
      typeof request.data?.question === "string"
        ? request.data.question.trim()
        : "";

    if (!question) {
      throw new HttpsError(
        "invalid-argument",
        "Please enter a question."
      );
    }

    if (question.length > 2000) {
      throw new HttpsError(
        "invalid-argument",
        "Question is too long."
      );
    }

    try {
      const businessData =
        await buildBusinessData(uid, question);

      const client = createOpenAIClient();

      const response =
        await client.responses.create({
          model: "gpt-6-luna",

          instructions: SYSTEM_INSTRUCTIONS,

          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    "CRM BUSINESS DATA:\\n" +
                    JSON.stringify(
                      businessData,
                      null,
                      2
                    ) +
                    "\\n\\nUSER QUESTION:\\n" +
                    question
                }
              ]
            }
          ],

          max_output_tokens: 1200,

          temperature: 0.2
        });

      return {
        success: true,
        answer:
          response.output_text ||
          "I could not generate an answer from the available CRM data."
      };

    } catch (error) {
      console.error(
        "FRALEN AI ERROR:",
        error
      );

      throw new HttpsError(
        "internal",
        "FRALEN AI could not process your request."
      );
    }
  }
);
