(function () {
  const CART_KEY = "mall_cart_v1";
  const USER_KEY = "mall_user_id";

  function escapeHtml(input) {
    return String(input ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function money(value) {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
    }).format(Number(value || 0));
  }

  function nowText() {
    return new Date().toLocaleString("zh-CN", { hour12: false });
  }

  function getParam(name) {
    return new URL(window.location.href).searchParams.get(name);
  }

  function parseNumberParam(name, defaultValue) {
    const n = Number(getParam(name));
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
  }

  function navigateToSearch(rawKeyword) {
    const keyword = String(rawKeyword || "").trim();
    if (!keyword) return;
    window.location.href = `/search.html?q=${encodeURIComponent(keyword)}`;
  }

  function navigateToDetail(productId) {
    window.location.href = `/detail.html?id=${Number(productId)}`;
  }

  function getUserId() {
    const raw = localStorage.getItem(USER_KEY);
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) return id;
    const fallback = 10001;
    localStorage.setItem(USER_KEY, String(fallback));
    return fallback;
  }

  function setUserId(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("用户ID必须是正整数");
    }
    localStorage.setItem(USER_KEY, String(id));
    return id;
  }

  function readCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const data = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(data)) return [];
      return data
        .filter((item) => Number.isInteger(Number(item.productId)) && Number(item.productId) > 0)
        .map((item) => ({
          productId: Number(item.productId),
          name: String(item.name || ""),
          price: Number(item.price || 0),
          qty: Math.max(1, Number(item.qty || 1)),
          stock: Math.max(0, Number(item.stock || 0)),
          updatedAt: item.updatedAt || nowText(),
        }));
    } catch (_) {
      return [];
    }
  }

  function writeCart(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  }

  function getCartItems() {
    return readCart();
  }

  function getCartCount() {
    return readCart().reduce((sum, item) => sum + Number(item.qty || 0), 0);
  }

  function getCartTotalAmount() {
    return readCart().reduce(
      (sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0),
      0
    );
  }

  function addToCart(product, qty = 1) {
    const count = Math.max(1, Number(qty || 1));
    const items = readCart();
    const pid = Number(product.id || product.productId);
    const idx = items.findIndex((item) => Number(item.productId) === pid);
    if (idx >= 0) {
      items[idx].qty += count;
      items[idx].price = Number(product.price || items[idx].price);
      items[idx].name = String(product.name || items[idx].name);
      items[idx].stock = Number(product.stock ?? items[idx].stock);
      items[idx].updatedAt = nowText();
    } else {
      items.push({
        productId: pid,
        name: String(product.name || ""),
        price: Number(product.price || 0),
        qty: count,
        stock: Number(product.stock || 0),
        updatedAt: nowText(),
      });
    }
    writeCart(items);
    return items;
  }

  function updateCartQty(productId, qty) {
    const pid = Number(productId);
    const nextQty = Number(qty);
    const items = readCart();
    const idx = items.findIndex((item) => Number(item.productId) === pid);
    if (idx < 0) return items;
    if (!Number.isFinite(nextQty) || nextQty <= 0) {
      items.splice(idx, 1);
    } else {
      items[idx].qty = Math.floor(nextQty);
      items[idx].updatedAt = nowText();
    }
    writeCart(items);
    return items;
  }

  function removeFromCart(productId) {
    const pid = Number(productId);
    const items = readCart().filter((item) => Number(item.productId) !== pid);
    writeCart(items);
    return items;
  }

  function clearCart() {
    writeCart([]);
  }

  function setHeaderCartCount(target) {
    const node =
      typeof target === "string" ? document.querySelector(target) : target || document.getElementById("cart-count");
    if (!node) return;
    node.textContent = String(getCartCount());
  }

  function setHeaderUserValue(target) {
    const node =
      typeof target === "string" ? document.querySelector(target) : target || document.getElementById("user-id-input");
    if (!node) return;
    node.value = String(getUserId());
  }

  function bindHeaderUserSave(inputSelector = "#user-id-input", btnSelector = "#save-user-id-btn") {
    const input = document.querySelector(inputSelector);
    const btn = document.querySelector(btnSelector);
    if (!input || !btn) return;
    setHeaderUserValue(input);
    btn.addEventListener("click", () => {
      try {
        const id = setUserId(input.value);
        showToast(`用户ID已保存：${id}`);
      } catch (err) {
        showToast(err.message || "用户ID保存失败", "error");
      }
    });
  }

  function showToast(text, type = "success") {
    const root = document.getElementById("toast-root");
    if (!root) return;
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = text;
    root.appendChild(item);
    setTimeout(() => {
      item.classList.add("hide");
      setTimeout(() => item.remove(), 250);
    }, 2300);
  }

  async function requestJson(url, options) {
    const resp = await fetch(url, options);
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload || payload.code !== 0) {
      const message = payload?.msg || `请求失败 (${resp.status})`;
      throw new Error(message);
    }
    return payload.data;
  }

  async function requestJsonAllowError(url, options) {
    const resp = await fetch(url, options);
    const payload = await resp.json().catch(() => null);
    return {
      ok: resp.ok && payload && payload.code === 0,
      status: resp.status,
      payload,
    };
  }

  const api = {
    getProduct(id) {
      return requestJson(`/api/products/${Number(id)}`);
    },
    searchProducts(keyword, limit) {
      return requestJson(
        `/api/products/search?q=${encodeURIComponent(keyword)}&limit=${Number(limit || 10)}`
      );
    },
    placeSeckillOrder(userId, productId) {
      return requestJson("/api/seckill/place-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: Number(userId), productId: Number(productId) }),
      });
    },
    async placeSeckillOrderSafe(userId, productId) {
      return requestJsonAllowError("/api/seckill/place-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: Number(userId), productId: Number(productId) }),
      });
    },
    getSeckillResultByOrder(orderId) {
      return requestJson(`/api/seckill/result?orderId=${encodeURIComponent(orderId)}`);
    },
    getSeckillResultByUserProduct(userId, productId) {
      return requestJson(
        `/api/seckill/result?userId=${Number(userId)}&productId=${Number(productId)}`
      );
    },
    getOrderById(orderId) {
      return requestJson(`/api/orders/${encodeURIComponent(orderId)}`);
    },
    listOrdersByUser(userId, limit = 30) {
      return requestJson(`/api/users/${Number(userId)}/orders?limit=${Number(limit)}`);
    },
  };

  function stockLabel(stock) {
    const qty = Number(stock || 0);
    if (qty <= 0) return '<span class="stock-chip low">已售罄</span>';
    if (qty < 30) return `<span class="stock-chip low">库存紧张 ${qty}</span>`;
    return `<span class="stock-chip">库存 ${qty}</span>`;
  }

  function renderCard(product, opts = {}) {
    const showActions = opts.showActions !== false;
    return `
      <article class="product-card" data-product-id="${Number(product.id)}">
        <div class="card-top">
          <span class="id-chip">ID ${Number(product.id)}</span>
          ${stockLabel(product.stock)}
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="price">${money(product.price)}</p>
        <div class="card-foot">稳定缓存 · 秒杀可用</div>
        ${
          showActions
            ? `
          <div class="card-actions">
            <button class="tiny ghost btn-open-detail" data-id="${Number(product.id)}">查看详情</button>
            <button class="tiny ghost btn-add-cart" data-id="${Number(product.id)}">加入购物车</button>
            <button class="tiny btn-seckill" data-id="${Number(product.id)}">秒杀下单</button>
          </div>
        `
            : ""
        }
      </article>
    `;
  }

  function formatOrderResult(result) {
    if (!result) return "暂无结果";
    if (result.status) return `${result.status}`;
    return JSON.stringify(result);
  }

  window.StoreUI = {
    api,
    ui: {
      escapeHtml,
      money,
      renderCard,
      formatOrderResult,
    },
    getParam,
    parseNumberParam,
    navigateToSearch,
    navigateToDetail,
    getUserId,
    setUserId,
    getCartItems,
    getCartCount,
    getCartTotalAmount,
    addToCart,
    updateCartQty,
    removeFromCart,
    clearCart,
    setHeaderCartCount,
    setHeaderUserValue,
    bindHeaderUserSave,
    showToast,
  };
})();
