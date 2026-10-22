/**
 * 验证外部 LLM API Key 是否可用。
 * 用与云函数相同的请求方式（http/https 模块，OpenAI 兼容格式）。
 *
 * 用法：node tools/verify-llm-key.js <baseUrl> <model> <apiKey>
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const baseUrl = process.argv[2] || '';
const model = process.argv[3] || '';
const apiKey = process.argv[4] || '';

if (!baseUrl || !model || !apiKey) {
  console.log('用法: node tools/verify-llm-key.js <baseUrl> <model> <apiKey>');
  process.exit(1);
}

function postJson(urlStr, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效 URL: ' + urlStr)); }
    const lib = u.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }, headers || {}),
      timeout: timeoutMs || 15000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error('HTTP ' + res.statusCode);
          e.statusCode = res.statusCode;
          e.body = text;
          return reject(e);
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('返回非 JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let url = String(baseUrl).replace(/\/+$/, '');
if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';

console.log('请求地址: ' + url);
console.log('模型: ' + model);
console.log('Key: ' + apiKey.slice(0, 8) + '…' + apiKey.slice(-6) + '  (长度 ' + apiKey.length + ')');
console.log('');

const t0 = Date.now();
postJson(url, {
  model,
  messages: [
    { role: 'system', content: '你是科贸小鱼平台的AI客服小校助手，回答简洁。' },
    { role: 'user', content: '用一句话介绍你能帮我做什么。' }
  ],
  temperature: 0.7,
  max_tokens: 200
}, { Authorization: 'Bearer ' + apiKey }, 15000)
  .then((data) => {
    const ms = Date.now() - t0;
    const c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (c) {
      console.log('✅ 调用成功（' + ms + ' ms）');
      console.log('');
      console.log('模型回复:');
      console.log('  ' + String(c).trim().replace(/\n/g, '\n  '));
      if (data.usage) console.log('\nToken 用量: ' + JSON.stringify(data.usage));
    } else {
      console.log('⚠ 返回 200 但没取到内容');
      console.log(JSON.stringify(data).slice(0, 400));
    }
  })
  .catch((e) => {
    const ms = Date.now() - t0;
    console.log('❌ 调用失败（' + ms + ' ms）: ' + e.message);
    if (e.body) {
      console.log('响应体: ' + String(e.body).slice(0, 500));
    }
    process.exit(1);
  });
