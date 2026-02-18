const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 存储在线用户和消息历史
const users = new Map();
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

// WebSocket连接处理
wss.on('connection', (ws) => {
    const userId = generateUserId();
    let username = null;
    let userColor = getRandomColor();

    // 发送消息历史
    ws.send(JSON.stringify({
        type: 'history',
        messages: messageHistory
    }));

    // 广播在线用户列表
    const broadcastUsers = () => {
        const userList = Array.from(users.values()).map(user => ({
            username: user.username,
            color: user.color,
            id: user.id
        }));
        
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'users',
                    users: userList
                }));
            }
        });
    };

    // 接收消息
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'join':
                    username = message.username;
                    users.set(ws, {
                        username,
                        color: userColor,
                        id: userId
                    });
                    
                    // 广播加入消息
                    const joinMessage = {
                        type: 'system',
                        content: `${username} 加入了聊天室`,
                        timestamp: new Date().toLocaleTimeString(),
                        id: generateUserId()
                    };
                    
                    messageHistory.push(joinMessage);
                    if (messageHistory.length > MAX_HISTORY) {
                        messageHistory.shift();
                    }
                    
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(joinMessage));
                        }
                    });
                    
                    broadcastUsers();
                    break;
                    
                case 'message':
                    if (username) {
                        const chatMessage = {
                            type: 'chat',
                            username: username,
                            content: message.content,
                            timestamp: new Date().toLocaleTimeString(),
                            color: userColor,
                            id: generateUserId()
                        };
                        
                        messageHistory.push(chatMessage);
                        if (messageHistory.length > MAX_HISTORY) {
                            messageHistory.shift();
                        }
                        
                        // 广播消息给所有客户端
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify(chatMessage));
                            }
                        });
                    }
                    break;
                    
                case 'typing':
                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'typing',
                                username: username,
                                isTyping: message.isTyping,
                                color: userColor
                            }));
                        }
                    });
                    break;
                    
                case 'reaction':
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'reaction',
                                username: username,
                                reaction: message.reaction,
                                messageId: message.messageId,
                                color: userColor
                            }));
                        }
                    });
                    break;
            }
        } catch (error) {
            console.error('消息处理错误:', error);
        }
    });

    // 连接关闭处理
    ws.on('close', () => {
        if (username) {
            users.delete(ws);
            
            const leaveMessage = {
                type: 'system',
                content: `${username} 离开了聊天室`,
                timestamp: new Date().toLocaleTimeString(),
                id: generateUserId()
            };
            
            messageHistory.push(leaveMessage);
            if (messageHistory.length > MAX_HISTORY) {
                messageHistory.shift();
            }
            
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(leaveMessage));
                }
            });
            
            broadcastUsers();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✨ 聊天室服务器运行在 http://localhost:${PORT}`);
});