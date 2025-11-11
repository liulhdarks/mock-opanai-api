const Koa = require('koa');
const Router = require('@koa/router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const PassThrough = require('stream').PassThrough;
const fetch = require('node-fetch');
const fs = require('fs');  // 添加文件系统模块
const path = require('path');  // 添加路径模块

// 创建日志目录（如果不存在）
const logDir = path.join(__dirname, 'log');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// 获取下一个日志文件编号
function getNextLogNumber() {
    try {
        const files = fs.readdirSync(logDir);
        // 匹配 request-数字.log、sendTomodel-数字.log、response-数字.log 格式的文件
        const logFiles = files.filter(file => file.match(/^(request|sendTomodel|response)-(\d+)\.log$/));
        if (logFiles.length === 0) {
            return 1;
        }
        // 提取所有编号
        const numbers = logFiles.map(file => {
            const match = file.match(/^(request|sendTomodel|response)-(\d+)\.log$/);
            return match ? parseInt(match[2]) : 0;
        }).filter(num => num > 0);
        
        if (numbers.length === 0) {
            return 1;
        }
        
        return Math.max(...numbers) + 1;
    } catch (error) {
        console.error('获取日志编号时出错:', error);
        return 1;
    }
}

// 创建日志写入流
const logFile = path.join(__dirname, 'a.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

// 重写console.log函数，同时输出到控制台和文件
const originalConsoleLog = console.log;
console.log = function(...args) {
    const timestamp = new Date().toISOString();
    const message = args.join(' ');
    const logMessage = `[${timestamp}] ${message}\n`;
    
    // 输出到控制台
    originalConsoleLog(...args);
    
    // 输出到文件
    logStream.write(logMessage);
};

// 重写console.error函数
const originalConsoleError = console.error;
console.error = function(...args) {
    const timestamp = new Date().toISOString();
    const message = args.join(' ');
    const logMessage = `[${timestamp}] ERROR: ${message}\n`;
    
    // 输出到控制台
    originalConsoleError(...args);
    
    // 输出到文件
    logStream.write(logMessage);
};

const app = new Koa();
const router = new Router();

app.use(cors({
    origin: 'vscode-file://vscode-app',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));

app.use(bodyParser());

// DeepSeek API 配置
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1';
const DEEPSEEK_API_KEY = '';
const DEEPSEEK_MODEL = 'deepseek-chat';

// 工具调用追踪
let currentToolCalls = new Map(); // 存储当前正在进行的工具调用
const toolDetailFile = path.join(__dirname, 'tooldetail.json');

// 确保 tooldetail.json 文件存在
function ensureToolDetailFile() {
    if (!fs.existsSync(toolDetailFile)) {
        fs.writeFileSync(toolDetailFile, JSON.stringify([], null, 2));
    }
}

// 写入工具调用详情到 tooldetail.json
function writeToolCallDetail(toolCall) {
    try {
        ensureToolDetailFile();
        let toolDetails = [];
        
        // 读取现有数据
        try {
            const existingData = fs.readFileSync(toolDetailFile, 'utf8');
            toolDetails = JSON.parse(existingData);
        } catch (error) {
            console.error('读取 tooldetail.json 失败，创建新数组:', error);
            toolDetails = [];
        }
        
        // 添加新的工具调用记录
        toolDetails.push({
            timestamp: new Date().toISOString(),
            toolName: toolCall.function?.name || toolCall.name || 'unknown',
            arguments: toolCall.function?.arguments || toolCall.arguments || '{}',
            result: toolCall.result || '',
            resultCharCount: (toolCall.result || '').length,
            id: toolCall.id || ''
        });
        
        // 写入文件
        fs.writeFileSync(toolDetailFile, JSON.stringify(toolDetails, null, 2));
        console.log('🔧 工具调用记录已保存到 tooldetail.json');
        
    } catch (error) {
        console.error('写入工具调用详情失败:', error);
    }
}

router.post('/chat/completions', async (ctx) => {
    // 获取当前请求的日志编号
    const logNumber = getNextLogNumber();
    const requestLogFile = path.join(logDir, `request-${logNumber}.log`);
    const sendToModelLogFile = path.join(logDir, `sendTomodel-${logNumber}.log`);
    const responseLogFile = path.join(logDir, `response-${logNumber}.log`);
    
    console.log(`📝 处理请求 #${logNumber}，日志文件: request-${logNumber}.log, sendTomodel-${logNumber}.log, response-${logNumber}.log`);
    
    try {
        const requestBody = ctx.request.body;
        console.log('收到的请求:', JSON.stringify(requestBody, null, 2));
        
        // 写入请求日志（只写数据）
        fs.writeFileSync(requestLogFile, JSON.stringify(requestBody, null, 2));
        
        // 构造发送给 DeepSeek 的请求体
        const deepseekRequestBody = {
            ...requestBody,
            model: DEEPSEEK_MODEL  // 使用 deepseek-chat 模型
        };
        
        console.log('发送给 DeepSeek 的请求:', JSON.stringify(deepseekRequestBody, null, 2));
        
        // 写入发送给模型的日志（只写数据）
        fs.writeFileSync(sendToModelLogFile, JSON.stringify(deepseekRequestBody, null, 2));
        
        const isStream = requestBody.stream || false;

        if (!isStream) {
            // 非流式响应
            const response = await fetch(`${DEEPSEEK_API_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify(deepseekRequestBody)
            });
            
            if (!response.ok) {
                const errorMessage = `DeepSeek API 请求失败: ${response.status} ${response.statusText}`;
                // 记录错误到响应日志
                fs.writeFileSync(responseLogFile, JSON.stringify({error: errorMessage}, null, 2));
                throw new Error(errorMessage);
            }
            
            const result = await response.json();
            console.log('DeepSeek 返回的响应:', JSON.stringify(result, null, 2));
            
            // 检查非流式响应中的工具调用
            if (result.choices && result.choices[0] && result.choices[0].message) {
                const message = result.choices[0].message;
                
                // 处理工具调用
                if (message.tool_calls) {
                    message.tool_calls.forEach(toolCall => {
                        // 对于非流式响应，我们可能没有工具结果，先记录工具调用信息
                        console.log('🔧 非流式响应中的工具调用:', JSON.stringify(toolCall, null, 2));
                        
                        // 如果有结果，直接记录；否则只记录调用信息
                        const toolCallRecord = {
                            id: toolCall.id,
                            function: toolCall.function,
                            result: '', // 非流式响应通常不包含工具结果
                            type: toolCall.type
                        };
                        
                        writeToolCallDetail(toolCallRecord);
                    });
                }
                
                // 处理函数调用（旧格式兼容）
                if (message.function_call) {
                    console.log('🔧 非流式响应中的函数调用:', JSON.stringify(message.function_call, null, 2));
                    
                    const functionCallRecord = {
                        id: 'function_call_' + Date.now(),
                        function: message.function_call,
                        result: '',
                        type: 'function'
                    };
                    
                    writeToolCallDetail(functionCallRecord);
                }
            }
            
            // 记录响应到日志（只写数据）
            fs.writeFileSync(responseLogFile, JSON.stringify(result, null, 2));
            
            ctx.body = result;
            return;
        }

        // 流式响应
        ctx.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        const stream = new PassThrough();
        ctx.body = stream;
        ctx.status = 200;

        // 请求 DeepSeek 流式 API
        const response = await fetch(`${DEEPSEEK_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify(deepseekRequestBody)
        });
        
        if (!response.ok) {
            const errorMessage = `DeepSeek API 请求失败: ${response.status} ${response.statusText}`;
            // 记录错误到响应日志
            fs.writeFileSync(responseLogFile, JSON.stringify({error: errorMessage}, null, 2));
            throw new Error(errorMessage);
        }
        
        console.log('开始接收 DeepSeek 流式响应');
        
        // 初始化响应日志文件（流式响应会逐步追加）
        fs.writeFileSync(responseLogFile, '');
        
        // 处理流式响应
        response.body.on('data', (chunk) => {
            const chunkStr = chunk.toString();
            
            // 将流式数据记录到响应日志（只写数据）
            fs.appendFileSync(responseLogFile, chunkStr);
            
            // 解析并检查是否包含工具调用信息
            const lines = chunkStr.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const jsonData = line.substring(6); // 移除 'data: ' 前缀
                        if (jsonData.trim()) {
                            const parsed = JSON.parse(jsonData);
                            
                            // 检查是否包含工具调用
                            if (parsed.choices && parsed.choices[0]) {
                                const choice = parsed.choices[0];
                                
                                // 处理 delta 中的工具调用信息（流式构建）
                                if (choice.delta && choice.delta.tool_calls) {
                                    choice.delta.tool_calls.forEach(toolCall => {
                                        const toolId = toolCall.id;
                                        if (!currentToolCalls.has(toolId)) {
                                            currentToolCalls.set(toolId, {
                                                id: toolId,
                                                type: toolCall.type,
                                                function: {
                                                    name: '',
                                                    arguments: ''
                                                }
                                            });
                                        }
                                        
                                        const existing = currentToolCalls.get(toolId);
                                        if (toolCall.function) {
                                            if (toolCall.function.name) {
                                                existing.function.name = toolCall.function.name;
                                            }
                                            if (toolCall.function.arguments) {
                                                existing.function.arguments += toolCall.function.arguments;
                                            }
                                        }
                                    });
                                    console.log('🔧 工具调用信息:', JSON.stringify(choice.delta.tool_calls, null, 2));
                                }
                                
                                // 处理完整的工具调用信息（非流式）
                                if (choice.message && choice.message.tool_calls) {
                                    choice.message.tool_calls.forEach(toolCall => {
                                        currentToolCalls.set(toolCall.id, toolCall);
                                    });
                                    console.log('🔧 消息中的工具调用:', JSON.stringify(choice.message.tool_calls, null, 2));
                                }
                                
                                // 检查 finish_reason 是否为工具调用相关
                                if (choice.finish_reason === 'tool_calls') {
                                    console.log('🔧 检测到工具调用完成:', JSON.stringify(parsed, null, 2));
                                    // 工具调用完成，等待工具结果
                                }
                                
                                // 检查是否有工具调用结果
                                if (choice.delta && choice.delta.content && currentToolCalls.size > 0) {
                                    // 这可能是工具调用的结果
                                    const content = choice.delta.content;
                                    console.log('🔧 可能的工具调用结果:', content);
                                }
                                
                                // 检查 delta 中是否包含函数调用信息（旧格式兼容）
                                if (choice.delta && choice.delta.function_call) {
                                    console.log('🔧 函数调用信息:', JSON.stringify(choice.delta.function_call, null, 2));
                                }
                                
                                // 检查 message 中是否包含函数调用信息（旧格式兼容）
                                if (choice.message && choice.message.function_call) {
                                    console.log('🔧 消息中的函数调用:', JSON.stringify(choice.message.function_call, null, 2));
                                }
                            }
                            
                            // 检查是否是工具调用结果的消息
                            if (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.role === 'tool') {
                                const toolMessage = parsed.choices[0].message;
                                const toolCallId = toolMessage.tool_call_id;
                                
                                if (toolCallId && currentToolCalls.has(toolCallId)) {
                                    const toolCall = currentToolCalls.get(toolCallId);
                                    toolCall.result = toolMessage.content || '';
                                    
                                    // 记录完整的工具调用信息
                                    writeToolCallDetail(toolCall);
                                    
                                    // 清理已完成的工具调用
                                    currentToolCalls.delete(toolCallId);
                                }
                            }
                        }
                    } catch (parseError) {
                        // 忽略解析错误，继续处理下一行
                    }
                }
            }
            
            // 将数据直接转发给客户端
            stream.write(chunkStr);
        });
        
        response.body.on('end', () => {
            console.log('DeepSeek 流式响应结束');
            
            // 处理未完成的工具调用（如果有的话）
            if (currentToolCalls.size > 0) {
                console.log('🔧 处理未完成的工具调用:', currentToolCalls.size);
                currentToolCalls.forEach((toolCall, toolId) => {
                    // 记录未完成的工具调用
                    writeToolCallDetail({
                        ...toolCall,
                        result: '[工具调用未完成或结果未接收]'
                    });
                });
                currentToolCalls.clear();
            }
            
            stream.end();
        });
        
        response.body.on('error', (error) => {
            console.error('DeepSeek 流式响应错误:', error);
            // 记录流式响应错误到响应日志
            fs.appendFileSync(responseLogFile, JSON.stringify({error: error.message}, null, 2));
            stream.destroy(error);
        });

    } catch (error) {
        console.error('代理请求错误:', error);
        // 记录错误到响应日志（如果日志文件已创建）
        try {
            if (fs.existsSync(responseLogFile)) {
                fs.appendFileSync(responseLogFile, JSON.stringify({error: error.message, stack: error.stack}, null, 2));
            }
        } catch (logError) {
            console.error('记录错误日志失败:', logError);
        }
        ctx.status = 500;
        ctx.body = { error: error.message || "Internal server error" };
    }
});

// 设置路由中间件
app.use(router.routes()).use(router.allowedMethods());

const port = 3000;
app.listen(port, () => {
    console.log(`Mock OpenAI API 代理服务启动，监听端口 ${port}`);
});
