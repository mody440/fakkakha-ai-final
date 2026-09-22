import http from 'k6/http';
import { check } from 'k6';
export const options = { vus: Number(__ENV.VUS || 5), duration: __ENV.DURATION || '30s' };
export default function () {
  const base = __ENV.BASE_URL || 'http://127.0.0.1:3000';
  const r = http.get(`${base}/api/health`);
  check(r, { 'health responds': (res) => res.status === 200 || res.status === 503 });
}
