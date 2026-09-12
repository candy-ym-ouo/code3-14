import axios from 'axios';

function getCookie(name: string) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  return parts.length === 2 ? parts.pop()?.split(';').shift() ?? '' : '';
}

export const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  timeout: 30_000,
});

api.interceptors.request.use((request) => {
  const method = request.method?.toUpperCase();
  if (method && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = getCookie('balcony_csrf');
    if (csrf) request.headers.set('x-csrf-token', csrf);
  }
  return request;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.message ?? error.message ?? '请求失败';
    error.userMessage = message;
    const status = error.response?.status;
    const url = String(error.config?.url ?? '');
    const isAuthRequest = url.includes('/auth/me') || url.includes('/auth/login') || url.includes('/auth/register') || url.includes('/auth/password/');
    if (status === 401 && !isAuthRequest && window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    return Promise.reject(error);
  },
);

export function errorMessage(error: unknown) {
  return (error as { userMessage?: string })?.userMessage ?? '操作失败，请稍后重试';
}
