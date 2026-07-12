export function applyTransactions(initialBalances, transactions) {
  const balances = initialBalances;
  for (const transaction of transactions) {
    if (transaction.type === "deposit") {
      balances[transaction.account] += transaction.amount;
    } else if (transaction.type === "withdraw") {
      balances[transaction.account] -= transaction.amount;
    } else if (transaction.type === "transfer") {
      balances[transaction.from] -= transaction.amount;
      balances[transaction.to] += transaction.amount;
    }
  }
  return balances;
}
