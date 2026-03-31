(function () {
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

  function getParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
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

  async function requestJson(url, options) {
    const resp = await fetch(url, options);
    const payload = await resp.json().catch(() => null);
    if (!resp.ok || !payload || payload.code !== 0) {
      const message =
        payload?.msg || `请求失败 (${resp.status})，请稍后重试或检查服务状态`;
      throw new Error(message);
    }
    return payload.data;
  }

  const api = {
    getProduct(id) {
      return requestJson(`/api/products/${Number(id)}`);
    },
    searchProducts(keyword, limit) {
      return requestJson(
        `/api/products/search?q=${encodeURIComponent(keyword)}&limit=${Number(
          limit || 10
        )}`
      );
    },
  };

  function stockLabel(stock) {
    const qty = Number(stock || 0);
    if (qty <= 0) {
      return '<span class="stock-chip low">缺货</span>';
    }
    if (qty < 50) {
      return `<span class="stock-chip low">库存紧张 ${qty}</span>`;
    }
    return `<span class="stock-chip">库存 ${qty}</span>`;
  }

  function renderCard(product) {
    return `
      <a class="product-card" href="/detail.html?id=${Number(product.id)}">
        <div class="card-top">
          <span class="id-chip">ID ${Number(product.id)}</span>
          ${stockLabel(product.stock)}
        </div>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="price">${money(product.price)}</p>
        <div class="card-foot">查看详情</div>
      </a>
    `;
  }

  window.StoreUI = {
    api,
    ui: {
      escapeHtml,
      money,
      renderCard,
    },
    getParam,
    parseNumberParam,
    navigateToSearch,
  };
})();
