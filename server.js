'use strict';

const path = require('path');
const express = require('express');
const { initDb } = require('./src/db');
const routes = require('./src/routes');

const PORT = Number(process.env.PORT || 3000);

const db = initDb();
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', routes(db));

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// JSON 解析错误与兜底错误处理
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`舞台提示编排台已启动: http://localhost:${PORT}`);
});
