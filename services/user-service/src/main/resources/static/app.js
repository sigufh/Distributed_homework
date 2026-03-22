const output = document.getElementById("output");

function baseUrl(service) {
  return document.getElementById(service + "Base").value.trim().replace(/\/$/, "");
}

function token() {
  return document.getElementById("token").value.trim();
}

function show(data) {
  output.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

async function callApi(service, path, options = {}) {
  const url = baseUrl(service) + path;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (options.auth !== false && token()) {
    headers.Authorization = `Bearer ${token()}`;
  }

  const resp = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await resp.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  if (!resp.ok) {
    show({ status: resp.status, error: payload });
    return null;
  }

  show(payload);
  return payload;
}

function val(id) {
  return document.getElementById(id).value.trim();
}

function num(id) {
  return Number(val(id));
}

document.getElementById("registerBtn").onclick = async () => {
  const r = await callApi("user", "/api/v1/users/register", {
    method: "POST",
    auth: false,
    body: {
      username: val("regUsername"),
      password: val("regPassword"),
      phone: val("regPhone"),
      email: val("regEmail"),
    },
  });
  if (r?.data?.token) {
    document.getElementById("token").value = r.data.token;
  }
};

document.getElementById("loginBtn").onclick = async () => {
  const r = await callApi("user", "/api/v1/users/login", {
    method: "POST",
    auth: false,
    body: {
      username: val("regUsername"),
      password: val("regPassword"),
    },
  });
  if (r?.data?.token) {
    document.getElementById("token").value = r.data.token;
  }
};

document.getElementById("meBtn").onclick = () => callApi("user", "/api/v1/users/me");

document.getElementById("createProductBtn").onclick = () =>
  callApi("product", "/api/v1/products", {
    method: "POST",
    body: {
      title: val("productTitle"),
      skuCode: val("productSku"),
      price: Number(val("productPrice")),
      status: num("productStatus"),
    },
  });

document.getElementById("listProductBtn").onclick = () => {
  const keyword = encodeURIComponent(val("productKeyword"));
  return callApi("product", `/api/v1/products?keyword=${keyword}&page=1&size=20`);
};

document.getElementById("getProductBtn").onclick = () =>
  callApi("product", `/api/v1/products/${num("productId")}`);

document.getElementById("getInventoryBtn").onclick = () =>
  callApi("inventory", `/api/v1/inventories/${num("skuId")}`);

document.getElementById("reserveBtn").onclick = () =>
  callApi("inventory", `/api/v1/inventories/${num("skuId")}/reserve`, {
    method: "POST",
    body: { quantity: num("invQty") },
  });

document.getElementById("commitBtn").onclick = () =>
  callApi("inventory", `/api/v1/inventories/${num("skuId")}/commit`, {
    method: "POST",
    body: { quantity: num("invQty") },
  });

document.getElementById("releaseBtn").onclick = () =>
  callApi("inventory", `/api/v1/inventories/${num("skuId")}/release`, {
    method: "POST",
    body: { quantity: num("invQty") },
  });

document.getElementById("createOrderBtn").onclick = () =>
  callApi("order", "/api/v1/orders", {
    method: "POST",
    headers: {
      "Idempotency-Key": val("idempotencyKey"),
    },
    body: {
      productId: num("orderProductId"),
      quantity: num("orderQty"),
      amount: Number(val("orderAmount")),
    },
  });

document.getElementById("listOrderBtn").onclick = () => callApi("order", "/api/v1/orders");

document.getElementById("getOrderBtn").onclick = () => callApi("order", `/api/v1/orders/${num("orderId")}`);

document.getElementById("cancelOrderBtn").onclick = () =>
  callApi("order", `/api/v1/orders/${num("orderId")}/cancel`, {
    method: "POST",
  });