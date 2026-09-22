const form = document.getElementById('metricsForm');
const keyInput = document.getElementById('adminKey');
const statusEl = document.getElementById('metricsStatus');
const grid = document.getElementById('metricsGrid');
function esc(value){ const d=document.createElement('div'); d.textContent=String(value ?? ''); return d.innerHTML; }
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = keyInput.value;
  statusEl.innerHTML = '<div class="banner info"><span class="spinner"></span> جارٍ التحميل…</div>';
  grid.innerHTML = '';
  try {
    const response = await fetch('/api/metrics', { headers: { 'x-admin-key': key, Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'تعذر تحميل المقاييس.');
    const endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
    const totalRequests = endpoints.reduce((sum, item) => sum + Number(item.requests || 0), 0);
    const totalErrors = endpoints.reduce((sum, item) => sum + (Number(item.requests || 0) * Number(item.errorRate || 0) / 100), 0);
    const totalDuration = endpoints.reduce((sum, item) => sum + (Number(item.requests || 0) * Number(item.avgDurationMs || 0)), 0);
    const cards = [
      ['إجمالي الطلبات', data.totalRequests ?? data.total ?? totalRequests],
      ['نسبة الأخطاء', data.errorRate ?? data.errors ?? (totalRequests ? `${(totalErrors / totalRequests * 100).toFixed(1)}%` : '0%')],
      ['متوسط الزمن', data.averageDurationMs ?? data.avgDurationMs ?? (totalRequests ? `${Math.round(totalDuration / totalRequests)} ms` : '0 ms')],
      ['آخر تحديث', new Date().toLocaleString()]
    ];
    grid.innerHTML = cards.map(([label,value]) => `<div class="card metric-card"><div class="muted fs-13">${esc(label)}</div><strong>${esc(value)}</strong></div>`).join('');
    statusEl.innerHTML = '<div class="banner info">تم تحميل بيانات المقاييس من الخادم.</div>';
    keyInput.value = '';
  } catch (error) {
    statusEl.innerHTML = `<div class="banner">${esc(error.message)}</div>`;
  }
});
