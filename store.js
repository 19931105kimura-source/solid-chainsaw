// src/store.js
const db = require("./db");
const fs = require("fs");
const path = require("path");

const { nextOrderId, nextOrderItemId } = require("./ids");
const { TABLE_STATUS, nowIso } = require("./domain");

function saveOrderToDb({ order, orderItems, tableId }) {
  const insertOrder = db.prepare(`
    INSERT INTO orders (id, table_id, created_at, status)
    VALUES (?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO order_items (
      id, order_id, item_type, item_id, name_snapshot, unit_price, qty, meta_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertOrder.run(
      order.orderId,
      String(tableId),
      order.orderedAt || nowIso(),
      order.printed ? "printed" : "open",
    );

    for (const it of orderItems) {
      insertItem.run(
        it.orderItemId,
        order.orderId,
        "product",
        it.productId,
        it.name || null,
        Number(it.price || 0),
        Number(it.quantity || 1),
        null,
        order.orderedAt || nowIso(),
      );
    }
  });

  tx();
}

class Store {
  constructor() {
    this.products = new Map();
    this.tables = new Map();
    this.orders = new Map();
    this.orderItems = new Map();

    this.ordersByTable = new Map();      // tableId -> orderId[]
    this.orderItemsByOrder = new Map();  // orderId -> orderItemId[]

    // ★ RT / UI 用：席注文 snapshot
    this.tableOrders = new Map();        // tableId -> TableOrder

    // ----- menu.json から商品ロード -----
  const nestedMenuPath = path.join(__dirname, "..", "data", "menu.json");
    const rootMenuPath = path.join(__dirname, "menu.json");
    const menuPath = fs.existsSync(nestedMenuPath) ? nestedMenuPath : rootMenuPath;
    const raw = fs.readFileSync(menuPath, "utf-8");
    const menu = JSON.parse(raw);

    for (const item of menu.items) {
      this.products.set(item.productId, item);
    }
  }

  // ---------- Product ----------
  listActiveProducts() {
    return Array.from(this.products.values()).filter(p => p.isActive);
  }

  getProduct(productId) {
    return this.products.get(productId) || null;
  }

  // ---------- Menu Raw (for editor) ----------
  getMenuRawItems() {
    return Array.from(this.products.values());
  }

  // ---------- Table ----------
  openTable(tableId) {
    const existing = this.tables.get(tableId);
    if (existing && existing.status !== TABLE_STATUS.closed) {
      return existing;
    }

    const table = {
      tableId,
      status: TABLE_STATUS.ordering,
      openedAt: nowIso(),
      closedAt: null,
    };

    this.tables.set(tableId, table);
    if (!this.ordersByTable.has(tableId)) {
      this.ordersByTable.set(tableId, []);
    }
    return table;
  }

  getTable(tableId) {
    return this.tables.get(tableId) || null;
  }

  closeTable(tableId) {
    const table = this.tables.get(tableId);
    if (!table) {
      throw new Error(`Table not found: ${tableId}`);
    }
    table.status = TABLE_STATUS.closed;
    table.closedAt = nowIso();
    return table;
  }

  // ---------- Order（確定・印刷用：既存） ----------
  createOrder({ tableId, orderedBy, items }) {
    const table = this.getTable(tableId) || this.openTable(tableId);
    if (table.status === TABLE_STATUS.closed) {
      throw new Error(`Table is closed: ${tableId}`);
    }

    const orderId = nextOrderId();
    const order = {
      orderId,
      tableId,
      orderedAt: nowIso(),
      orderedBy,
      printed: false,
    };

    this.orders.set(orderId, order);

    const orderIds = this.ordersByTable.get(tableId);
    orderIds.push(orderId);

    const orderItemIds = [];

    for (const req of items) {
      const product = this.getProduct(req.productId);
      if (!product || !product.isActive) {
        throw new Error(`Invalid productId: ${req.productId}`);
      }

      const quantity = Number(req.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for productId=${req.productId}`);
      }
        this.addTableItem(tableId, {
    productId: product.productId,
    qty: quantity,
    addedBy: orderedBy,
  });
      const orderItemId = nextOrderItemId();
      const orderItem = {
        orderItemId,
        orderId,
        productId: product.productId,
        name: product.name,
        price: product.price,
        quantity,
        printTarget: product.printTarget || "none",
        printed: {
          drink: false,
          food: false,
        },
      };

      this.orderItems.set(orderItemId, orderItem);
      orderItemIds.push(orderItemId);
   }

    this.orderItemsByOrder.set(orderId, orderItemIds);
    const createdOrderItems = orderItemIds
      .map((id) => this.orderItems.get(id))
      .filter(Boolean);

    saveOrderToDb({
      order,
      orderItems: createdOrderItems,
      tableId,
    });

    return {
      order,
      orderItems: createdOrderItems,
    };
  }

  markOrderPrinted(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }
   order.printed = true;
    return order;
  }

  // API側で正規化済みの注文データをSQLiteへ保存（段階移行用）
  persistNormalizedOrderToDb({ orderId, tableId, orderedBy, orderedAt, items }) {
    const order = {
      orderId: String(orderId),
      tableId: String(tableId),
      orderedBy: orderedBy ?? "guest",
      orderedAt: orderedAt || nowIso(),
      printed: false,
    };

    const orderItems = (Array.isArray(items) ? items : []).map((it, idx) => ({
      orderItemId: String(it.orderItemId ?? it.id ?? `${order.orderId}_${idx}`),
      productId: it.productId ?? null,
      name: it.name ?? it.label ?? "",
      price: Number(it.price ?? 0),
      quantity: Number(it.quantity ?? it.qty ?? 1),
    }));

     saveOrderToDb({
      order,
      orderItems,
      tableId: order.tableId,
    });
  }

  // テーブル現在状態をDB正本として置き換える（sync-table用）
  replaceTableItemsInDb({ tableId, orderId, orderedBy, orderedAt, items }) {
    const normalizedTableId = String(tableId);
    const normalizedOrderId = String(orderId);
    const timestamp = orderedAt || nowIso();

    const insertOrder = db.prepare(`
      INSERT INTO orders (id, table_id, created_at, status)
      VALUES (?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO order_items (
        id, order_id, item_type, item_id, name_snapshot, unit_price, qty, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteOrdersByTable = db.prepare(`
      DELETE FROM orders
      WHERE table_id = ?
    `);

    const tx = db.transaction(() => {
      // 既存の同一テーブル注文を全削除（order_itemsはFK CASCADE）
      deleteOrdersByTable.run(normalizedTableId);

      insertOrder.run(
        normalizedOrderId,
        normalizedTableId,
        timestamp,
        "open",
      );

      const sourceItems = Array.isArray(items) ? items : [];
      sourceItems.forEach((it, idx) => {
        const qty = Number(it.quantity ?? it.qty ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) return;

        const price = Number(it.price ?? 0);
        const itemName = String(it.name ?? it.label ?? "").trim();
        const orderItemId = String(it.id ?? it.orderItemId ?? `${normalizedOrderId}_${idx}`);
        const meta = {
          label: it.label ?? "",
          brand: it.brand ?? "",
          category: it.category ?? "",
          section: it.section ?? null,
          subCategory: it.subCategory ?? "",
          printGroup: it.printGroup ?? null,
          shouldPrint: it.shouldPrint !== false,
          orderedBy: it.orderedBy ?? orderedBy ?? "owner",
        };

        insertItem.run(
          orderItemId,
          normalizedOrderId,
          "product",
          it.productId ?? null,
          itemName,
          Number.isFinite(price) ? price : 0,
          qty,
          JSON.stringify(meta),
          timestamp,
        );
      });
    });

    tx();
  }

  // ---------- Snapshot（既存・会計用） ----------
  getTableSnapshot(tableId) {
    const table = this.getTable(tableId);
    if (!table) return null;

    const orderIds = this.ordersByTable.get(tableId) || [];
    const orders = orderIds.map(id => this.orders.get(id)).filter(Boolean);

    const orderItems = [];
    for (const order of orders) {
      const itemIds = this.orderItemsByOrder.get(order.orderId) || [];
      for (const itemId of itemIds) {
        const item = this.orderItems.get(itemId);
        if (item) orderItems.push(item);
      }
    }

    return { table, orders, orderItems };
  
  }
    getTableItemsFromDb(tableId) {
    const rows = db.prepare(`
      SELECT
        oi.id            AS orderItemId,
        oi.order_id      AS orderId,
        oi.item_id       AS productId,
        oi.name_snapshot AS name,
        oi.unit_price    AS price,
        oi.qty           AS quantity,
        oi.meta_json     AS metaJson
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.table_id = ?
      ORDER BY o.created_at ASC, oi.created_at ASC
    `).all(String(tableId));

    return rows.map((r) => ({
      ...(safeParseJsonObject(r.metaJson)),
      orderItemId: r.orderItemId,
      orderId: r.orderId,
      productId: r.productId,
      name: r.name,
      label: r.name,
      price: Number(r.price ?? 0),
      quantity: Number(r.quantity ?? 0),
      qty: Number(r.quantity ?? 0),
    }));
  }
getTableItems(tableId) {
    const orderIds = this.ordersByTable.get(tableId) || [];
    const items = [];

    for (const orderId of orderIds) {
      const itemIds = this.orderItemsByOrder.get(orderId) || [];

      for (const itemId of itemIds) {
        const item = this.orderItems.get(itemId);
        if (!item) continue;

        items.push({
          ...item,
          quantity: Number(item.quantity ?? item.qty ?? 0),
          qty: Number(item.qty ?? item.quantity ?? 0),
        });
      }
    }

    return items;
  }

  // ---------- Checkout ----------
  calcCheckout(tableId) {
    const snap = this.getTableSnapshot(tableId);
    if (!snap) {
      throw new Error(`Table not found: ${tableId}`);
    }

    const lines = new Map();

    for (const item of snap.orderItems) {
      const cur = lines.get(item.productId) || {
        productId: item.productId,
        name: item.name,
        price: item.price,
        quantity: 0,
        amount: 0,
      };
      cur.quantity += item.quantity;
      cur.amount += item.price * item.quantity;
      lines.set(item.productId, cur);
    }

    const details = Array.from(lines.values());
    const total = details.reduce((sum, d) => sum + d.amount, 0);

    return {
      tableId,
      openedAt: snap.table.openedAt,
      details,
      total,
    };
  }

  // ---------- Print Data Builder ----------
  buildPrintJobs(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const itemIds = this.orderItemsByOrder.get(orderId) || [];
    const items = itemIds
      .map(id => this.orderItems.get(id))
      .filter(Boolean);

    const jobs = {
      drink: [],
      food: [],
    };

    for (const item of items) {
      if (item.printTarget === "drink") {
        jobs.drink.push(item);
      } else if (item.printTarget === "food") {
        jobs.food.push(item);
      }
    }

    return {
      orderId,
      tableId: order.tableId,
      orderedAt: order.orderedAt,
      jobs,
    };
  }

  // ==================================================
  // ===== Table Order Snapshot（RT / UI 用・新規）=====
  // ==================================================
  _makeLineId() {
    return "l_" + Math.random().toString(36).slice(2, 10);
  }

  _normalizeActor(addedBy) {
    return addedBy === "owner" ? "owner" : "guest";
  }

  _snapshotMergeKey(item) {
    const section = item.section == null ? "" : String(item.section);
    return [
      item.productId ?? "",
      item.name ?? "",
      item.label ?? "",
      item.brand ?? "",
      item.category ?? "",
      section,
      item.subCategory ?? "",
      item.printGroup ?? "kitchen",
      Number(item.price ?? 0),
    ].join("|");
  }

  _mergeContributors(target, src) {
    if (!target.contributors || typeof target.contributors !== "object") {
      target.contributors = {};
    }
    if (!src || typeof src !== "object") return;
    for (const [actor, qty] of Object.entries(src)) {
      const n = Number(qty ?? 0);
      if (!Number.isFinite(n) || n <= 0) continue;
      target.contributors[actor] = Number(target.contributors[actor] ?? 0) + n;
    }
  }
 

  getTableOrderSnapshot(tableId) {
    const key = String(tableId);
    let snap = this.tableOrders.get(key);

    if (!snap) {
      snap = {
        tableId: key,
        openedAt: nowIso(),
        items: [],
      };
      this.tableOrders.set(key, snap);
    }
    return snap;
  }

    addTableItem(tableId, { productId, qty, addedBy }){
    const product = this.getProduct(productId);
    if (!product || !product.isActive) {
      throw new Error(`Invalid productId: ${productId}`);
    }

    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Invalid qty");
    }

    const snap = this.getTableOrderSnapshot(tableId);

   const actor = this._normalizeActor(addedBy);
    const candidate = {
      productId: product.productId,
      name: product.name,
      label: product.variantLabel ?? "",
      brand: product.name ?? "",
      category: product.category ?? "",
      section: null,
      subCategory: "",
      printGroup: product.printGroup ?? product.printTarget ?? "kitchen",
      price: Number(product.price ?? 0),
    };
    const key = this._snapshotMergeKey(candidate);

    const existing = snap.items.find(
      (item) => this._snapshotMergeKey(item) === key,
    );
    if (existing) {
      existing.qty = Number(existing.qty ?? 0) + quantity;
      existing.addedBy = actor;
      this._mergeContributors(existing, { [actor]: quantity });
      return existing;
    }

    const line = {
      lineId: this._makeLineId(),
      ...candidate,
      qty: quantity,
      addedBy: actor,
      contributors: { [actor]: quantity },
    };

    snap.items.push(line);
    return line;
  }

 addTableItemSnapshot(tableId, { name, label, brand, category, section, subCategory, printGroup, price, qty, addedBy }) {
    const quantity = Number(qty);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Invalid qty");
    }

    const snap = this.getTableOrderSnapshot(tableId);
   const actor = this._normalizeActor(addedBy);
    const normalized = {
      productId: null,
      name: name ?? "",
      label: label ?? "",
      brand: brand ?? "",
      category: category ?? "",
      section: section ?? null,
      subCategory: subCategory ?? "",
      printGroup: printGroup ?? "kitchen",
      price: Number(price) || 0,
      addedBy: actor,
    };

    const key = this._snapshotMergeKey(normalized);
    const existing = snap.items.find((item) => this._snapshotMergeKey(item) === key);

    if (existing) {
      existing.qty = Number(existing.qty ?? 0) + quantity;
      existing.addedBy = actor;
      this._mergeContributors(existing, { [actor]: quantity });
      return existing;
    }

    const line = {
      lineId: this._makeLineId(),
      ...normalized,
      qty: quantity,
      contributors: { [actor]: quantity },
    };


    snap.items.push(line);
    return line;
  }

  

  updateTableItemQty(tableId, lineId, qty) {
    const snap = this.getTableOrderSnapshot(tableId);
    const q = Number(qty);

    if (!Number.isInteger(q) || q <= 0) {
      throw new Error("Invalid qty");
    }

    const item = snap.items.find(i => i.lineId === String(lineId));
    if (!item) {
      throw new Error("Line not found");
    }

    item.qty = q;
    return item;
  }

  removeTableItem(tableId, lineId) {
    const snap = this.getTableOrderSnapshot(tableId);
    const before = snap.items.length;

    snap.items = snap.items.filter(i => i.lineId !== String(lineId));

    if (before === snap.items.length) {
      throw new Error("Line not found");
    }
  }

 removeTableItemsByNamePrice(tableId, name, price) {
    const snap = this.getTableOrderSnapshot(tableId);
    const targetName = String(name ?? "");
    const targetPrice = Number(price ?? 0);
    const before = snap.items.length;

    snap.items = snap.items.filter(
      i =>
        String(i.name ?? "") !== targetName ||
        Number(i.price ?? 0) !== targetPrice,
    );

    if (before === snap.items.length) {
      throw new Error("Line not found");
    }

    
   return before - snap.items.length;
  }

  _mergeSnapshotItems(baseItems, addItems) {
    const merged = [...baseItems.map(item => ({ ...item }))];
    for (const item of addItems) {
      const key = this._snapshotMergeKey(item);
      const target = merged.find(
        m => this._snapshotMergeKey(m) === key,
      );
      if (target) {
        target.qty += item.qty ?? 0;
        this._mergeContributors(target, item.contributors);
        target.addedBy = item.addedBy ?? target.addedBy ?? "guest";
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  }

  moveTableOrderSnapshot(from, to) {
    const fromKey = String(from);
    const toKey = String(to);
    if (fromKey === toKey) return;

    const fromTable = this.tables.get(fromKey);
    if (!fromTable) {
      throw new Error(`Table not found: ${fromKey}`);
    }

    const toSnap = this.tableOrders.get(toKey);
    if (toSnap && toSnap.items && toSnap.items.length > 0) {
      throw new Error(`Target table already has items: ${toKey}`);
    }

    const toOrderIds = this.ordersByTable.get(toKey);
    if (toOrderIds && toOrderIds.length > 0) {
      throw new Error(`Target table already has orders: ${toKey}`);
    }

    const fromSnap = this.getTableOrderSnapshot(fromKey);
    this.tableOrders.set(toKey, {
      tableId: toKey,
      openedAt: fromSnap.openedAt,
      items: [...fromSnap.items],
    });
    this.tableOrders.delete(fromKey);

    const fromOrderIds = this.ordersByTable.get(fromKey);
    if (fromOrderIds && fromOrderIds.length > 0) {
      this.ordersByTable.set(toKey, [...fromOrderIds]);
      this.ordersByTable.delete(fromKey);
      for (const orderId of fromOrderIds) {
        const order = this.orders.get(orderId);
        if (order) order.tableId = toKey;
      }
    } else if (!this.ordersByTable.has(toKey)) {
      this.ordersByTable.set(toKey, []);
    }

    this.tables.set(toKey, {
      tableId: toKey,
      status: TABLE_STATUS.ordering,
      openedAt: fromTable.openedAt,
      closedAt: null,
    });
    fromTable.status = TABLE_STATUS.closed;
    fromTable.closedAt = nowIso();
  }

  mergeTableOrderSnapshot(from, to) {
    const fromKey = String(from);
    const toKey = String(to);
    if (fromKey === toKey) return;

    const fromTable = this.tables.get(fromKey);
    if (!fromTable) {
      throw new Error(`Table not found: ${fromKey}`);
    }

    const fromSnap = this.getTableOrderSnapshot(fromKey);
    const toSnap = this.getTableOrderSnapshot(toKey);
    toSnap.items = this._mergeSnapshotItems(toSnap.items, fromSnap.items);

    const fromOrderIds = this.ordersByTable.get(fromKey) ?? [];
    const toOrderIds = this.ordersByTable.get(toKey) ?? [];
    if (fromOrderIds.length > 0) {
      const mergedIds = [...toOrderIds, ...fromOrderIds];
      this.ordersByTable.set(toKey, mergedIds);
      this.ordersByTable.delete(fromKey);
      for (const orderId of fromOrderIds) {
        const order = this.orders.get(orderId);
        if (order) order.tableId = toKey;
      }
    } else if (!this.ordersByTable.has(toKey)) {
      this.ordersByTable.set(toKey, [...toOrderIds]);
    }

    const toTable = this.tables.get(toKey);
    if (toTable) {
      toTable.status = TABLE_STATUS.ordering;
      toTable.closedAt = null;
    } else {
      this.tables.set(toKey, {
        tableId: toKey,
        status: TABLE_STATUS.ordering,
        openedAt: fromTable.openedAt,
        closedAt: null,
      });
    }

    this.tableOrders.delete(fromKey);
    fromTable.status = TABLE_STATUS.closed;
    fromTable.closedAt = nowIso();
  }
  buildRealtimeSnapshot() {
    const tables = {};
    const ordersByTable = {};
    const orderItems = {};

    // ★ 追加：tables（使用中/closed 等）を正本として全席を流す
    for (const [tableId, table] of this.tables.entries()) {
       const fallbackOrder = this.tableOrders.get(tableId) ?? {
        tableId,
        openedAt: table.openedAt,
        items: [],
      };
      const dbItems = this.getTableItemsFromDb(tableId);
      const itemsForSnapshot = dbItems.length > 0
        ? dbItems.map((item) => ({
            lineId: item.lineId ?? item.orderItemId,
            category: item.category ?? "",
            brand: item.brand ?? "",
            name: item.name ?? item.label ?? "",
            label: item.label ?? item.name ?? "",
            price: Number(item.price ?? 0),
            qty: Number(item.qty ?? item.quantity ?? 0),
            section: item.section ?? null,
            subCategory: item.subCategory ?? "",
            contributors: item.contributors ?? null,
            shouldPrint: item.shouldPrint !== false,
            printGroup: item.printGroup ?? "kitchen",
          }))
        : (fallbackOrder.items || []);

      tables[tableId] = {
        tableId,
        status: table.status, // ★ ordering / closed
        openedAt: table.openedAt,
        order: {
          tableId,
          openedAt: table.openedAt,
          items: itemsForSnapshot,
        }, // ★ 注文スナップショット（items）
      };

      const rtOrderId = `rt_${tableId}`;
      ordersByTable[tableId] = [rtOrderId];
      orderItems[rtOrderId] = itemsForSnapshot.map((item) => ({
        lineId: item.lineId,
       category: item.category ?? "",
        brand: item.brand ?? "",
        name: item.name ?? "",
         label: item.label ?? item.name ?? "",
        price: item.price ?? 0,
        qty: item.qty ?? 0,
        quantity: item.qty ?? 0,
          section: item.section ?? null,
        subCategory: item.subCategory ?? "",
        contributors: item.contributors ?? null,
        shouldPrint: true,
        printGroup: item.printGroup ?? "kitchen",
      }));
    }

    return {
      tables,
      ordersByTable,
      orderItems,
      at: nowIso(),
    };
  }
}

function safeParseJsonObject(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

const store = new Store();
module.exports = { store };