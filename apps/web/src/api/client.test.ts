import { describe, expect, it } from 'vitest';
import { errorMessage } from './client';

describe('errorMessage', () => {
  it('returns normalized request errors', () => {
    expect(errorMessage({ userMessage: '邮箱或密码错误' })).toBe('邮箱或密码错误');
  });

  it('returns a safe fallback', () => {
    expect(errorMessage(new Error('raw internal error'))).toBe('操作失败，请稍后重试');
  });
});
