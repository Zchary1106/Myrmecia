import { describe, it, expect } from 'vitest';
import { IntentClassifier } from '../src/agents/intent-classifier.js';

// Create a standalone instance for testing (doesn't need DB)
const classifier = new IntentClassifier();

describe('IntentClassifier', () => {
  it('should classify bug reports as bugfix', async () => {
    const result = await classifier.classify('登录页面有个bug，点击按钮没反应');
    expect(result.type).toBe('bugfix');
    expect(result.suggestedMode).toBe('pipeline');
  });

  it('should classify "fix" tasks as bugfix', async () => {
    const result = await classifier.classify('fix the login error');
    expect(result.type).toBe('bugfix');
  });

  it('should classify review requests as direct to review agent', async () => {
    const result = await classifier.classify('review this PR');
    expect(result.type).toBe('direct');
    expect(result.suggestedAgent).toBe('review');
  });

  it('should classify deploy requests as direct to ops agent', async () => {
    const result = await classifier.classify('部署到生产环境');
    expect(result.type).toBe('direct');
    expect(result.suggestedAgent).toBe('ops');
  });

  it('should classify test requests as direct to qa agent', async () => {
    const result = await classifier.classify('测试一下这个功能');
    expect(result.type).toBe('direct');
    expect(result.suggestedAgent).toBe('qa');
  });

  it('should classify wechat content as direct to wechat-writer', async () => {
    const result = await classifier.classify('写一篇公众号文章关于AI');
    expect(result.type).toBe('content');
    expect(result.suggestedAgent).toBe('wechat-writer');
  });

  it('should classify xiaohongshu content as direct to xiaohongshu-writer', async () => {
    const result = await classifier.classify('写一个小红书种草笔记');
    expect(result.type).toBe('content');
    expect(result.suggestedAgent).toBe('xiaohongshu-writer');
  });

  it('should classify translation as direct to i18n agent', async () => {
    const result = await classifier.classify('翻译这个页面到英文');
    expect(result.type).toBe('direct');
    expect(result.suggestedAgent).toBe('i18n');
  });

  it('should classify new product requests as pipeline/master', async () => {
    const result = await classifier.classify('做一个天气App，要好看');
    expect(result.type).toBe('new_product');
    expect(['pipeline', 'master']).toContain(result.suggestedMode);
    expect(result.complexity).toBe('high');
  });

  it('should classify feature requests as feature', async () => {
    const result = await classifier.classify('加个暗黑模式');
    expect(result.type).toBe('feature');
  });

  it('should handle ambiguous input gracefully', async () => {
    const result = await classifier.classify('hello');
    expect(result).toBeDefined();
    expect(result.suggestedMode).toBeDefined();
  });
});
