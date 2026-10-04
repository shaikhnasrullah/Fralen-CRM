// FRALEN CRM - Reports (Excel + PDF export)

import { getDocs, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { requireAuth, tenantCollection, profileDoc } from "./firebase-config.js";

let currentUid = null;
let shopName = 'FRALEN Shop';

// Raw data pulled once; date filtering happens client-side on each export
// so switching ranges doesn't need a fresh Firestore read every time.
let allOrders = [];
let allProducts = [];
let allPurchases = [];
let allReturns = [];

let rangeFrom = null; // Date or null (null = no lower bound)
let rangeTo = null;   // Date or null (null = no upper bound)

requireAuth(async (user) => {
  currentUid = user.uid;
  try {
    const pSnap = await getDoc(profileDoc(currentUid));
    if (pSnap.exists() && pSnap.data().shopName) shopName = pSnap.data().shopName;
  } catch (e) { /* shop name is only for the PDF heading */ }
  await loadAllData();
  window.setQuickRange('month');
});

async function loadAllData() {
  try {
    const [orderSnap, productSnap, purchaseSnap, returnSnap] = await Promise.all([
      getDocs(tenantCollection(currentUid, "orders")),
      getDocs(tenantCollection(currentUid, "products")),
      getDocs(tenantCollection(currentUid, "purchases")),
      getDocs(tenantCollection(currentUid, "returns")),
    ]);
    allOrders = orderSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    allProducts = productSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    allPurchases = purchaseSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    allReturns = returnSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderReportCards();
  } catch (err) {
    document.getElementById('report-body').innerHTML = `<div class="loading-note">Error loading data: ${err.message}</div>`;
  }
}

/* ---------------- DATE RANGE ---------------- */
window.setQuickRange = function (range) {
  document.querySelectorAll('.qr-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  document.getElementById('custom-range-fields').style.display = range === 'custom' ? 'flex' : 'none';

  const now = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
  const endOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

  if (range === 'today') {
    rangeFrom = startOfDay(now); rangeTo = endOfDay(now);
    setRangeLabel('Today');
  } else if (range === 'week') {
    const day = now.getDay(); // 0 = Sunday
    const monday = new Date(now); monday.setDate(now.getDate() - ((day + 6) % 7));
    rangeFrom = startOfDay(monday); rangeTo = endOfDay(now);
    setRangeLabel('This Week (' + monday.toLocaleDateString('en-IN') + ' – ' + now.toLocaleDateString('en-IN') + ')');
  } else if (range === 'month') {
    rangeFrom = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    rangeTo = endOfDay(now);
    setRangeLabel('This Month (' + now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) + ')');
  } else if (range === 'year') {
    rangeFrom = startOfDay(new Date(now.getFullYear(), 0, 1));
    rangeTo = endOfDay(now);
    setRangeLabel('This Year (' + now.getFullYear() + ')');
  } else if (range === 'all') {
    rangeFrom = null; rangeTo = null;
    setRangeLabel('All Time');
  } else if (range === 'custom') {
    // Wait for user to pick dates and hit Apply.
    return;
  }
  renderReportCards();
};

window.applyCustomRange = function () {
  const fromVal = document.getElementById('range-from').value;
  const toVal = document.getElementById('range-to').value;
  if (!fromVal || !toVal) { alert('From aur To dono date select karo.'); return; }
  const from = new Date(fromVal + 'T00:00:00');
  const to = new Date(toVal + 'T23:59:59');
  if (from > to) { alert('From date, To date se pehle honi chahiye.'); return; }
  rangeFrom = from; rangeTo = to;
  setRangeLabel('Custom (' + from.toLocaleDateString('en-IN') + ' – ' + to.toLocaleDateString('en-IN') + ')');
  renderReportCards();
};

function setRangeLabel(text) {
  document.getElementById('range-label').innerHTML = 'Showing: <b>' + text + '</b>';
}

function inRange(dateStr) {
  if (!rangeFrom && !rangeTo) return true; // All Time
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d)) return false;
  if (rangeFrom && d < rangeFrom) return false;
  if (rangeTo && d > rangeTo) return false;
  return true;
}

/* ---------------- FILTERED DATASETS ---------------- */
function getFilteredOrders() { return allOrders.filter(o => inRange(o.createdAt)); }
function getFilteredPurchases() { return allPurchases.filter(p => inRange(p.createdAt)); }
function getFilteredReturns() { return allReturns.filter(r => inRange(r.createdAt)); }
function getFilteredProducts() {
  // Products aren't really "dated" transactions, but honor the range if
  // the product was added within it; fall back to all products if a
  // product has no createdAt (e.g. was added before this field existed).
  return allProducts.filter(p => !p.createdAt || inRange(p.createdAt));
}
function getFilteredCustomers() {
  // Derived from filtered orders, same grouping logic as customers.html.
  const map = {};
  getFilteredOrders().forEach(o => {
    const key = (o.mobile || 'unknown').trim() || 'unknown';
    if (!map[key]) {
      map[key] = { mobile: key, name: o.customerName || '(No name)', orders: 0, totalSpent: 0, totalPending: 0, lastOrder: o.createdAt || '' };
    }
    map[key].orders += 1;
    map[key].totalSpent += (o.totals?.payable || 0);
    map[key].totalPending += (o.totals?.pending || 0);
    if ((o.createdAt || '') > (map[key].lastOrder || '')) {
      map[key].lastOrder = o.createdAt || '';
      if (o.customerName) map[key].name = o.customerName;
    }
  });
  return Object.values(map);
}

/* ---------------- REPORT CARDS ---------------- */
function renderReportCards() {
  const orders = getFilteredOrders();
  const customers = getFilteredCustomers();
  const products = getFilteredProducts();
  const purchases = getFilteredPurchases();
  const returns = getFilteredReturns();

  document.getElementById('report-body').innerHTML = `
    <div class="report-grid">
      <div class="all-card">
        <div class="txt">
          <h3>📦 Download Everything</h3>
          <p>One Excel file (one sheet per report) or one PDF, for the selected date range.</p>
        </div>
        <div class="all-btns">
          <button class="all-download" onclick="window.downloadAll()">⬇ Download All (.xlsx)</button>
          <button class="all-download pdf" onclick="window.downloadAllPdf()">⬇ Download All (.pdf)</button>
        </div>
      </div>

      <div class="report-card">
        <div class="rc-top"><div class="rc-icon orders">🧾</div><div><div class="rc-title">Orders / Sales</div><div class="rc-count">${orders.length} orders</div></div></div>
        <div class="rc-btns">
          <button class="rc-download" ${orders.length ? '' : 'disabled'} onclick="window.downloadOrders()">⬇ Excel</button>
          <button class="rc-download pdf" ${orders.length ? '' : 'disabled'} onclick="window.downloadOrdersPdf()">⬇ PDF</button>
        </div>
      </div>

      <div class="report-card">
        <div class="rc-top"><div class="rc-icon customers">👥</div><div><div class="rc-title">Customers</div><div class="rc-count">${customers.length} customers</div></div></div>
        <div class="rc-btns">
          <button class="rc-download" ${customers.length ? '' : 'disabled'} onclick="window.downloadCustomers()">⬇ Excel</button>
          <button class="rc-download pdf" ${customers.length ? '' : 'disabled'} onclick="window.downloadCustomersPdf()">⬇ PDF</button>
        </div>
      </div>

      <div class="report-card">
        <div class="rc-top"><div class="rc-icon products">🕶️</div><div><div class="rc-title">Products</div><div class="rc-count">${products.length} products</div></div></div>
        <div class="rc-btns">
          <button class="rc-download" ${products.length ? '' : 'disabled'} onclick="window.downloadProducts()">⬇ Excel</button>
          <button class="rc-download pdf" ${products.length ? '' : 'disabled'} onclick="window.downloadProductsPdf()">⬇ PDF</button>
        </div>
      </div>

      <div class="report-card">
        <div class="rc-top"><div class="rc-icon purchases">📥</div><div><div class="rc-title">Purchases</div><div class="rc-count">${purchases.length} purchases</div></div></div>
        <div class="rc-btns">
          <button class="rc-download" ${purchases.length ? '' : 'disabled'} onclick="window.downloadPurchases()">⬇ Excel</button>
          <button class="rc-download pdf" ${purchases.length ? '' : 'disabled'} onclick="window.downloadPurchasesPdf()">⬇ PDF</button>
        </div>
      </div>

      <div class="report-card">
        <div class="rc-top"><div class="rc-icon returns">↩️</div><div><div class="rc-title">Returns / Defects</div><div class="rc-count">${returns.length} records</div></div></div>
        <div class="rc-btns">
          <button class="rc-download" ${returns.length ? '' : 'disabled'} onclick="window.downloadReturns()">⬇ Excel</button>
          <button class="rc-download pdf" ${returns.length ? '' : 'disabled'} onclick="window.downloadReturnsPdf()">⬇ PDF</button>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- SHEET BUILDERS ---------------- */
function ordersToRows(orders) {
  return orders.map(o => ({
    'Order No.': o.orderNo || '',
    'Date': o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN') : '',
    'Customer Name': o.customerName || '',
    'Mobile': o.mobile || '',
    'Branch': o.branch || '',
    'Sales Person': o.salesPerson || '',
    'Items': (o.products || []).length,
    'Basic Amount': o.totals?.basic || 0,
    'GST': o.totals?.gst || 0,
    'Item Discount': o.totals?.itemDiscount || 0,
    'Coupon Discount': o.totals?.couponDiscount || 0,
    'Loyalty Discount': o.totals?.loyaltyDiscount || 0,
    'Payable Amount': o.totals?.payable || 0,
    'Advance Paid': o.totals?.advance || 0,
    'Pending Balance': o.totals?.pending || 0,
    'Cash Received': (o.payments || []).filter(p => p.mode === 'Cash').reduce((s, p) => s + (p.amount || 0), 0),
    'Online Received': (o.payments || []).filter(p => p.mode === 'Online').reduce((s, p) => s + (p.amount || 0), 0),
    'Status': o.status || '',
  }));
}
function customersToRows(customers) {
  return customers.map(c => ({
    'Customer Name': c.name, 'Mobile': c.mobile === 'unknown' ? '' : c.mobile,
    'Total Orders': c.orders, 'Total Spent (Rs)': c.totalSpent.toFixed(2),
    'Pending Balance (Rs)': c.totalPending.toFixed(2),
    'Last Order Date': c.lastOrder ? new Date(c.lastOrder).toLocaleDateString('en-IN') : '',
  }));
}
function productsToRows(products) {
  return products.map(p => ({
    'Product Name': p.name || '', 'Category': p.category || '', 'Brand': p.brand || '',
    'SKU': p.sku || '', 'Purchase Price': p.purchasePrice || 0, 'Retail Price': p.retailPrice || 0,
    'Stock': p.stock || 0, 'Reorder Level': p.reorderLevel || 0, 'Notes': p.notes || '',
  }));
}
function purchasesToRows(purchases) {
  const rows = [];
  purchases.forEach(p => {
    const items = p.items && p.items.length ? p.items : [{}];
    items.forEach(it => {
      rows.push({
        'Date': p.date || (p.createdAt ? new Date(p.createdAt).toLocaleDateString('en-IN') : ''),
        'Supplier': p.supplier || '', 'Bill No.': p.billNo || '',
        'Product': it.product || '', 'Description': it.description || '',
        'Qty': it.qty || '', 'Price': it.price || '', 'Retail Price': it.retailPrice || '',
        'Item Total': it.total || '', 'Purchase Total Amount': p.totalAmount || 0,
        'Notes': p.notes || '',
      });
    });
  });
  return rows;
}
function returnsToRows(returns) {
  return returns.map(r => ({
    'Date': r.date || (r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN') : ''),
    'Supplier': r.supplier || '', 'Bill No.': r.billNo || '', 'Product': r.product || '',
    'Qty': r.qty || 0, 'Type': r.type || '', 'Amount': r.amount || 0, 'Reason': r.reason || '',
  }));
}

/* ---------------- DOWNLOAD HANDLERS ---------------- */
function fileSuffix() {
  const rangeText = document.getElementById('range-label').textContent.replace('Showing: ', '');
  return rangeText.replace(/[^\w]+/g, '_').slice(0, 40);
}

function downloadSheet(rows, sheetName, filenamePrefix) {
  if (!rows.length) { alert('Is date range mein koi data nahi mila.'); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filenamePrefix}_${fileSuffix()}.xlsx`);
}

/* ---------------- PDF ---------------- */
// Turns the same rows used for Excel into a table inside a PDF.
function rangeText() {
  return document.getElementById('range-label').textContent.replace('Showing: ', '');
}

function addTableToPdf(pdf, rows, title, startY) {
  const headers = Object.keys(rows[0]);
  const body = rows.map(r => headers.map(h => String(r[h] == null ? '' : r[h])));
  const wide = headers.length > 9;
  pdf.setFontSize(13);
  pdf.setTextColor(27, 42, 107);
  pdf.text(title, 14, startY);
  pdf.setFontSize(9);
  pdf.setTextColor(107, 114, 128);
  pdf.text(shopName + '  |  ' + rangeText() + '  |  ' + rows.length + ' rows', 14, startY + 6);
  pdf.autoTable({
    head: [headers],
    body: body,
    startY: startY + 10,
    styles: { fontSize: wide ? 6 : 8, cellPadding: wide ? 1.2 : 2 },
    headStyles: { fillColor: [27, 42, 107], textColor: 255 },
    alternateRowStyles: { fillColor: [243, 247, 250] },
    margin: { left: 10, right: 10 },
  });
}

function newPdf(rows) {
  // many columns need landscape so the table fits the page
  const landscape = Object.keys(rows[0]).length > 6;
  return new window.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
}

function downloadPdf(rows, title, filenamePrefix) {
  if (!rows.length) { alert('Is date range mein koi data nahi mila.'); return; }
  const pdf = newPdf(rows);
  addTableToPdf(pdf, rows, title, 14);
  pdf.save(`${filenamePrefix}_${fileSuffix()}.pdf`);
}

window.downloadOrdersPdf = () => downloadPdf(ordersToRows(getFilteredOrders()), 'Orders / Sales Report', 'FRALEN_Orders');
window.downloadCustomersPdf = () => downloadPdf(customersToRows(getFilteredCustomers()), 'Customers Report', 'FRALEN_Customers');
window.downloadProductsPdf = () => downloadPdf(productsToRows(getFilteredProducts()), 'Products Report', 'FRALEN_Products');
window.downloadPurchasesPdf = () => downloadPdf(purchasesToRows(getFilteredPurchases()), 'Purchases Report', 'FRALEN_Purchases');
window.downloadReturnsPdf = () => downloadPdf(returnsToRows(getFilteredReturns()), 'Returns / Defects Report', 'FRALEN_Returns');

window.downloadAllPdf = function () {
  const sections = [
    ['Orders / Sales Report', ordersToRows(getFilteredOrders())],
    ['Customers Report', customersToRows(getFilteredCustomers())],
    ['Products Report', productsToRows(getFilteredProducts())],
    ['Purchases Report', purchasesToRows(getFilteredPurchases())],
    ['Returns / Defects Report', returnsToRows(getFilteredReturns())],
  ].filter(sec => sec[1].length);

  if (!sections.length) { alert('Is date range mein koi data nahi mila.'); return; }

  // one PDF, each report starts on a new page
  const pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  sections.forEach((sec, i) => {
    if (i > 0) pdf.addPage();
    addTableToPdf(pdf, sec[1], sec[0], 14);
  });
  pdf.save(`FRALEN_Report_${fileSuffix()}.pdf`);
};

window.downloadOrders = () => downloadSheet(ordersToRows(getFilteredOrders()), 'Orders', 'FRALEN_Orders');
window.downloadCustomers = () => downloadSheet(customersToRows(getFilteredCustomers()), 'Customers', 'FRALEN_Customers');
window.downloadProducts = () => downloadSheet(productsToRows(getFilteredProducts()), 'Products', 'FRALEN_Products');
window.downloadPurchases = () => downloadSheet(purchasesToRows(getFilteredPurchases()), 'Purchases', 'FRALEN_Purchases');
window.downloadReturns = () => downloadSheet(returnsToRows(getFilteredReturns()), 'Returns', 'FRALEN_Returns');

window.downloadAll = function () {
  const orders = ordersToRows(getFilteredOrders());
  const customers = customersToRows(getFilteredCustomers());
  const products = productsToRows(getFilteredProducts());
  const purchases = purchasesToRows(getFilteredPurchases());
  const returns = returnsToRows(getFilteredReturns());

  if (!orders.length && !customers.length && !products.length && !purchases.length && !returns.length) {
    alert('Is date range mein koi data nahi mila.');
    return;
  }

  const wb = XLSX.utils.book_new();
  if (orders.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), 'Orders');
  if (customers.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(customers), 'Customers');
  if (products.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(products), 'Products');
  if (purchases.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(purchases), 'Purchases');
  if (returns.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(returns), 'Returns');
  XLSX.writeFile(wb, `FRALEN_Report_${fileSuffix()}.xlsx`);
};
