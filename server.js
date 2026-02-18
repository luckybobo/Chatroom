const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 存储在线用户和消息历史
const users = new Map(); // ws -> { username, color, id, lastSeen }
const messageHistory = [];
const MAX_HISTORY = 200;

// 生成随机颜色
function getRandomColor() {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
        '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71',
        '#E74C3C', '#1ABC9C', '#F39C12', '#8E44AD', '#27AE60'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
}

// 生成用户ID
function generateUserId() {
    return crypto.randomBytes(8).toString('hex');
}

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查端点
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', users: users.size });
});

// 广播在线用户列表
function broadcastUsers() {
    const userList = Array.from(users.values()).map(user => ({
        username: user.username,
        color: user.color,
        id: user.id,
        online: true
    }));
    
    const message = JSON.stringify({
        type: 'users',
        users: userList
    });
    
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// 广播消息给所有客户端
function broadcastMessage(message) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

// WebSocket连接处理
wss.on('connection', (ws) => {
    console.log('新连接建立');
    let userData = null;
    let pingInterval = null;

    // 发送消息历史
    ws.send(JSON.stringify({
        type: 'history',
        messages: messageHistory
    }));

    // 心跳检测
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);

    // 接收消息
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'join':
                    // 检查用户名是否已存在
                    const usernameExists = Array.from(users.values()).some(
                        u => u.username === message.username
                    );
                    
                    if (usernameExists) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            content: '用户名已存在，请换一个'
                        }));
                        return;
                    }
                    
                    // 创建新用户
                    userData = {
                        username: message.username,
                        color: getRandomColor(),
                        id: generateUserId(),
                        lastSeen: Date.now()
                    };
                    
                    users.set(ws, userData);
                    console.log(`用户加入: ${message.username}`);
                    
                    // 广播加入消息
                    const joinMessage = {
                        type: 'system',
                        content: `${message.username} 加入了聊天室`,
                        timestamp: new Date().toLocaleTimeString(),
                        id: generateUserId()
                    };
                    
                    messageHistory.push(joinMessage);
                    if (messageHistory.length > MAX_HISTORY) {
                        messageHistory.shift();
                    }
                    
                    broadcastMessage(joinMessage);
                    broadcastUsers();
                    
                    // 发送欢迎消息给新用户
                    ws.send(JSON.stringify({
                        type: 'welcome',
                        username: message.username,
                        color: userData.color
                    }));
                    break;
                    
                case 'message':
                    if (!userData) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            content: '请先加入聊天室'
                        }));
                        return;
                    }
                    
                    if (!message.content || message.content.trim().length === 0) {
                        return;
                    }
                    
                    const chatMessage = {
                        type: 'chat',
                        username: userData.username,
                        content: message.content.substring(0, 500), // 限制长度
                        timestamp: new Date().toLocaleTimeString(),
                        color: userData.color,
                        id: generateUserId(),
                        userId: userData.id
                    };
                    
                    messageHistory.push(chatMessage);
                    if (messageHistory.length > MAX_HISTORY) {
                        messageHistory.shift();
                    }
                    
                    broadcastMessage(chatMessage);
                    break;
                    
                case 'typing':
                    if (!userData) return;
                    
                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'typing',
                                username: userData.username,
                                isTyping: message.isTyping,
                                color: userData.color,
                                userId: userData.id
                            }));
                        }
                    });
                    break;
                    
                case 'pong':
                    // 客户端响应心跳
                    if (userData) {
                        userData.lastSeen = Date.now();
                    }
                    break;
            }
        } catch (error) {
            console.error('消息处理错误:', error);
            ws.send(JSON.stringify({
                type: 'error',
                content: '消息格式错误'
            }));
        }
    });

    // 连接关闭处理
    ws.on('close', () => {
        console.log('连接关闭');
        clearInterval(pingInterval);
        
        if (userData) {
            const leaveMessage = {
                type: 'system',
                content: `${userData.username} 离开了聊天室`,
                timestamp: new Date().toLocaleTimeString(),
                id: generateUserId()
            };
            
            messageHistory.push(leaveMessage);
            if (messageHistory.length > MAX_HISTORY) {
                messageHistory.shift();
            }
            
            users.delete(ws);
            broadcastMessage(leaveMessage);
            broadcastUsers();
            
            console.log(`用户离开: ${userData.username}`);
        }
    });

    // 错误处理
    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
        clearInterval(pingInterval);
        
        if (userData) {
            users.delete(ws);
            broadcastUsers();
        }
    });
});

// 定期清理僵尸连接
setInterval(() => {
    const now = Date.now();
    let hasChanges = false;
    
    wss.clients.forEach((ws) => {
        const userData = users.get(ws);
        if (userData && now - userData.lastSeen > 60000) { // 60秒无响应
            console.log(`清理僵尸连接: ${userData.username}`);
            users.delete(ws);
            hasChanges = true;
            
            if (ws.readyState === WebSocket.OPEN) {
                ws.terminate();
            }
        }
    });
    
    if (hasChanges) {
        broadcastUsers();
    }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✨ 聊天室服务器运行在 http://localhost:${PORT}`);
});