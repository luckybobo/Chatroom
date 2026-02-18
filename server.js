// server.js
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os'); // 新增：用于获取本机IP

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile('./client.html', (err, data) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    }
});

const wss = new WebSocket.Server({ server });

// 存储所有连接的客户端
const clients = new Map();

// ========== 新增：获取本机网络IP的函数 ==========
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // 跳过内部IP（回环地址）和非IPv4地址
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

wss.on('connection', (ws) => {
    const id = generateId();
    clients.set(id, ws);
    
    console.log(`Client ${id} connected (总连接数: ${clients.size})`);
    
    // 广播在线人数
    broadcastUserCount();

    // 处理收到的消息
    ws.on('message', (data) => {
        const message = JSON.parse(data);
        
        switch(message.type) {
            case 'message':
                broadcastMessage({
                    type: 'message',
                    userId: message.userId,
                    username: message.username,
                    content: message.content,
                    timestamp: new Date().toLocaleTimeString()
                });
                break;
                
            case 'setUsername':
                ws.username = message.username;
                broadcastSystemMessage(`${message.username} 加入了聊天室`);
                break;
        }
    });

    // 处理断开连接
    ws.on('close', () => {
        console.log(`Client ${id} disconnected`);
        if (ws.username) {
            broadcastSystemMessage(`${ws.username} 离开了聊天室`);
        }
        clients.delete(id);
        broadcastUserCount();
    });

    // 发送欢迎消息
    ws.send(JSON.stringify({
        type: 'system',
        content: '欢迎来到聊天室！请设置你的昵称。',
        userId: 'system'
    }));
});

// 广播消息给所有客户端
function broadcastMessage(message) {
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// 广播系统消息
function broadcastSystemMessage(content) {
    broadcastMessage({
        type: 'system',
        content: content,
        timestamp: new Date().toLocaleTimeString()
    });
}

// 广播在线人数
function broadcastUserCount() {
    broadcastMessage({
        type: 'userCount',
        count: clients.size
    });
}

// 生成唯一ID
function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

// ========== 修改：监听所有网络接口 ==========
const PORT = process.env.PORT || 3000;  // 优先使用环境变量，如果没有则用3000

// 监听 '0.0.0.0' 而不是 'localhost'，这样就能接受来自任何网络接口的连接
server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('\n🚀 聊天室启动成功！');
    console.log('📡 访问地址：');
    console.log(`   ➜ 本地:   http://localhost:${PORT}`);
    console.log(`   ➜ 局域网: http://${localIP}:${PORT}`);
    console.log(`   ➜ 公网:   需要配合端口转发或内网穿透\n`);
    console.log('📊 当前在线: 0 人');
    console.log('💡 提示: 确保防火墙已开放端口 ' + PORT);
});
