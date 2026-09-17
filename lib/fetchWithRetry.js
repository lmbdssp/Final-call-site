export async function fetchWithRetry(url, options = {}, retries = 2, backoffMs = 500) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || attempt === retries) return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) throw lastErr;
    }
    await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
  }
}
