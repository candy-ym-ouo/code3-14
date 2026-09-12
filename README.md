# 阳台微气候记录

可真实运行的全栈应用：React 前端、Node.js API、后台 Worker、PostgreSQL、Redis 和 S3 兼容对象存储。

## 本地开发

要求 Node.js 22+、npm 10+、Docker。

```bash
cp .env.example .env
docker compose up -d postgres redis minio minio-init
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

打开 `http://localhost:5173`，注册真实账号。系统不会创建演示用户或演示数据。

## 完整容器启动

```bash
SESSION_SECRET="$(openssl rand -hex 32)" docker compose up --build
```

打开 `http://localhost:8080`。MinIO 控制台位于 `http://localhost:9001`。

生产环境必须替换数据库密码、MinIO 凭证、`SESSION_SECRET`、对象存储和 SMTP 配置，并启用 HTTPS 与 `COOKIE_SECURE=true`。

## 功能闭环

- 注册和登录，创建真实阳台、位置与植物。
- 记录温度、光照、风向、植物状态和土壤湿度。
- 记录遮阳、浇水、换盆等操作。
- 上传真实照片，后台生成缩略图并使用短时签名 URL 展示。
- 查看真实曲线，按操作时间进行前后窗口统计。
- 创建周期、单次和阈值提醒，由独立 Worker 触发站内通知。
- 导出个人 JSON/CSV 数据，发起 7 天冷静期账号删除。

## 验证命令

```bash
npm run build
npm run typecheck
npm test
```

## 服务

| 服务 | 说明 |
|---|---|
| `web` | React 构建产物和 Nginx 反向代理 |
| `api` | Fastify REST API |
| `worker` | BullMQ 提醒、邮件、缩略图、导出和清理任务 |
| `postgres` | 业务事实数据 |
| `redis` | 队列与锁 |
| `minio` | 私有照片和导出对象存储 |

## 重要环境变量

完整示例见 `.env.example`。生产必须设置：

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `S3_ENDPOINT`、`S3_INTERNAL_ENDPOINT`、`S3_PUBLIC_ENDPOINT`
- `S3_BUCKET`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`
- `SMTP_HOST` 等邮件配置，若启用邮件提醒
- `COOKIE_SECURE=true`，配合 HTTPS

## 数据与备份

- PostgreSQL 是唯一事实数据源，提醒事件不会只存在 Redis。
- S3 桶保持私有，照片通过 10 分钟短时签名 URL 访问。
- 生产环境应配置 PostgreSQL 每日备份、对象存储版本控制和季度恢复演练。
