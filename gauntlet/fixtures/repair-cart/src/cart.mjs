export function calculateCart(items, options = {}) {
  const discountPercent = options.discountPercent ?? 0;
  const taxPercent = options.taxPercent ?? 0;

  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  const discounted = subtotal - discountPercent;
  const taxed = discounted * (1 + taxPercent / 100);

  return Math.round(taxed);
}
