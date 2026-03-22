CREATE TABLE IF NOT EXISTS inventories (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  product_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  total INT NOT NULL,
  available INT NOT NULL,
  reserved INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_inventories_sku_id (sku_id),
  KEY idx_inventories_product_id (product_id)
);
