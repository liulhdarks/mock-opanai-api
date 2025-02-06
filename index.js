const Koa = require('koa');
const Router = require('@koa/router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const PassThrough = require('stream').PassThrough;  // 新增流处理

const app = new Koa();
const router = new Router();

app.use(cors({
    origin: 'vscode-file://vscode-app',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

app.use(bodyParser());

router.post('/chat/completions', async (ctx) => {
    try {
        const requestBody = ctx.request.body;
        console.log('收到的请求:', JSON.stringify(requestBody, null, 2));
        const isStream = requestBody.stream || false;

        if (!isStream) {
            // 非流式响应保持不变
            ctx.body = {
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: requestBody.model || 'gpt-3.5-turbo',
                system_fingerprint: "fp_" + Date.now(),
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '这是一个模拟的回复'
                    },
                    finish_reason: 'stop'
                }],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 10,
                    total_tokens: 20
                }
            };
            return;
        }

        // 创建流式响应
        ctx.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'  // 新增必要头
        });

        // 创建可写流
        const stream = new PassThrough();
        ctx.body = stream;
        ctx.status = 200;

        // 生成事件数据
        const generateEvent = (content, finishReason) => {
            return JSON.stringify({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestBody.model || 'gpt-3.5-turbo',
                choices: [{
                    index: 0,
                    delta: content,
                    finish_reason: finishReason
                }]
            });
        };

        // 发送初始数据
        stream.write(`data: ${generateEvent({ role: 'assistant' }, null)}\n\n`);

        // 逐字符发送内容
        const message = '这是一个模拟的回复';
        for (const char of message) {
            await new Promise(resolve => setTimeout(resolve, 20));
            stream.write(`data: ${generateEvent({ content: char }, null)}\n\n`);
        }

        // 发送结束标志
        stream.write(`data: ${generateEvent({}, 'stop')}\n\n`);
        stream.write('data: [DONE]\n\n');
        stream.end();

    } catch (error) {
        console.error('Error:', error);
        ctx.status = 500;
        ctx.body = { error: "Internal server error" };
    }
});

// 设置路由中间件
app.use(router.routes()).use(router.allowedMethods());

const port = 3000;
app.listen(port, () => {
    console.log('Mock OpenAI Start');
});