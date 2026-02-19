const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 管理员密码配置
const ADMIN_PASSWORD = 'admin123';

// 存储在线用户
const users = new Map(); // ws -> { username, color, id, ip, isMuted, isAdmin }
const bannedIPs = new Set(); // 存储被封禁的IP地址
const messageHistory = [];
const recalledMessages = new Set(); // 存储已撤回的消息ID
const MAX_HISTORY = 200;
const systemLogs = []; // 存储系统日志，供前端终端显示

// 游戏状态
const gameState = {
    isPlaying: false,
    players: new Map(), // ws -> { username, userId, role, isAlive, hasVoted, hasActed, ip }
    hostId: null,
    gamePhase: 'waiting', // waiting, night, day, vote
    dayCount: 1,
    votes: new Map(), // voterId -> targetId
    nightActions: new Map(), // userId -> { action, targetId }
    killedTonight: null,
    savedTonight: null,
    poisonedTonight: null,
    checkedTonight: null,
    phaseEndTime: null,
    phaseTimer: null
};

// 角色配置
const ROLE_CONFIG = {
    '狼人': { 
        count: 2, 
        description: '每晚可以杀死一名玩家，可以和狼队友私聊',
        emoji: '🐺',
        nightAction: true,
        team: 'werewolf'
    },
    '预言家': { 
        count: 1, 
        description: '每晚可以查验一名玩家的身份',
        emoji: '🔮',
        nightAction: true,
        team: 'villager'
    },
    '女巫': { 
        count: 1, 
        description: '有一瓶解药和一瓶毒药',
        emoji: '🧪',
        nightAction: true,
        team: 'villager'
    },
    '猎人': { 
        count: 1, 
        description: '死亡时可以开枪带走一人',
        emoji: '🏹',
        nightAction: false,
        team: 'villager'
    },
    '平民': { 
        count: 3, 
        description: '白天参与投票，找出狼人',
        emoji: '👨',
        nightAction: false,
        team: 'villager'
    }
};

// 游戏时间配置
const GAME_TIMES = {
    NIGHT: 60000,     // 60秒
    DAY: 90000,       // 90秒  
    VOTE: 60000       // 60秒
};

// 生成随机颜色
function getRandomColor() {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEEAD',
        '#D4A5A5', '#9B59B6', '#3498DB', '#E67E22', '#2ECC71'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
}

// 生成用户ID
function generateUserId() {
    return crypto.randomBytes(8).toString('hex');
}

// 获取客户端IP
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(/, /)[0] : req.connection.remoteAddress;
    return ip.replace('::ffff:', '');
}

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 添加系统日志
function addSystemLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    systemLogs.push(`[${timestamp}] ${message}`);
    if (systemLogs.length > 200) {
        systemLogs.shift();
    }
}

// 广播消息给所有客户端
function broadcastMessage(message, excludeWs = null) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            client.send(messageStr);
        }
    });
}

// 广播消息给特定角色的玩家
function broadcastToRole(role, message, excludeWs = null) {
    const messageStr = JSON.stringify(message);
    gameState.players.forEach((player, ws) => {
        if (player.role === role && ws.readyState === WebSocket.OPEN && ws !== excludeWs) {
            ws.send(messageStr);
        }
    });
}

// 广播消息给狼人阵营
function broadcastToWolves(message, excludeWs = null) {
    const messageStr = JSON.stringify(message);
    gameState.players.forEach((player, ws) => {
        if (player.role === '狼人' && player.isAlive && ws.readyState === WebSocket.OPEN && ws !== excludeWs) {
            ws.send(messageStr);
        }
    });
}

// 广播在线用户列表
function broadcastUsers() {
    const userList = Array.from(users.values()).map(user => ({
        username: user.username,
        color: user.color,
        id: user.id,
        online: true,
        isMuted: user.isMuted || false,
        isAdmin: user.isAdmin || false
    }));
    
    broadcastMessage({
        type: 'users',
        users: userList
    });
}

// 广播游戏状态
function broadcastGameState() {
    const players = Array.from(gameState.players.entries()).map(([ws, player]) => ({
        username: player.username,
        userId: player.userId,
        isAlive: player.isAlive !== false,
        hasVoted: player.hasVoted || false,
        hasActed: player.hasActed || false,
        role: player.role || null
    }));
    
    broadcastMessage({
        type: 'gameState',
        isPlaying: gameState.isPlaying,
        players: players,
        hostId: gameState.hostId,
        playerCount: gameState.players.size,
        gamePhase: gameState.gamePhase,
        dayCount: gameState.dayCount,
        phaseEndTime: gameState.phaseEndTime
    });
}

// 发送系统消息到聊天
function sendGameMessage(content, type = 'system') {
    broadcastMessage({
        type: 'system',
        content: `🎮 ${content}`,
        timestamp: new Date().toLocaleTimeString()
    });
}

// ========== 游戏逻辑函数 ==========

// 解析指令
function parseCommand(message) {
    if (!message.startsWith('/')) return null;
    
    const parts = message.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    
    return { cmd, args };
}

// 提取@用户名
function extractMention(text) {
    const match = text.match(/@(\S+)/);
    return match ? match[1] : null;
}

// 根据用户名查找玩家
function findPlayerByUsername(username) {
    for (const [ws, player] of gameState.players.entries()) {
        if (player.username === username) {
            return { ws, player };
        }
    }
    return null;
}

// 处理游戏指令
function handleGameCommand(ws, userData, cmd, args) {
    if (!gameState.isPlaying && cmd !== 'join' && cmd !== 'leave' && cmd !== 'start' && cmd !== 'players' && cmd !== 'wolf') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 游戏尚未开始'
        }));
        return;
    }

    const player = gameState.players.get(ws);
    
    switch(cmd) {
        case 'join':
            handleJoinGame(ws, userData);
            break;
            
        case 'leave':
            handleLeaveGame(ws, userData);
            break;
            
        case 'start':
            handleStartGame(ws, userData);
            break;
            
        case 'wolf':
            handleWolfChat(ws, player, args);
            break;
            
        case 'kill':
            handleKill(ws, player, args);
            break;
            
        case 'check':
            handleCheck(ws, player, args);
            break;
            
        case 'save':
            handleSave(ws, player, args);
            break;
            
        case 'poison':
            handlePoison(ws, player, args);
            break;
            
        case 'skip':
            handleSkip(ws, player);
            break;
            
        case 'shoot':
            handleShoot(ws, player, args);
            break;
            
        case 'vote':
            handleVote(ws, player, args);
            break;
            
        case 'players':
            showAlivePlayers(ws);
            break;
            
        case 'roles':
            showRemainingRoles(ws);
            break;
            
        case 'help':
            showGameHelp(ws);
            break;
            
        default:
            ws.send(JSON.stringify({
                type: 'system',
                content: `❌ 未知指令: /${cmd}，输入 /help 查看可用指令`
            }));
    }
}

// 狼人私聊
function handleWolfChat(ws, player, args) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法发送狼人私聊'
        }));
        return;
    }
    
    if (player.role !== '狼人') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有狼人可以使用狼人私聊'
        }));
        return;
    }
    
    const message = args.join(' ');
    if (!message) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请输入消息内容'
        }));
        return;
    }
    
    // 广播给所有存活的狼人
    broadcastToWolves({
        type: 'wolfChat',
        username: player.username,
        content: message,
        timestamp: new Date().toLocaleTimeString()
    }, ws);
    
    // 给自己也发一份（确认消息）
    ws.send(JSON.stringify({
        type: 'wolfChat',
        username: player.username,
        content: message,
        timestamp: new Date().toLocaleTimeString(),
        isOwn: true
    }));
    
    addSystemLog(`WOLF CHAT: ${player.username}: ${message}`);
}

// 加入游戏
function handleJoinGame(ws, userData) {
    if (gameState.isPlaying) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 游戏已经开始，无法加入'
        }));
        return;
    }
    
    if (gameState.players.has(ws)) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经在游戏中'
        }));
        return;
    }
    
    if (gameState.players.size >= 8) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 游戏人数已满（最多8人）'
        }));
        return;
    }
    
    gameState.players.set(ws, {
        username: userData.username,
        userId: userData.id,
        role: null,
        isAlive: true,
        hasVoted: false,
        hasActed: false,
        ip: userData.ip
    });
    
    if (gameState.players.size === 1) {
        gameState.hostId = userData.id;
    }
    
    sendGameMessage(`👤 ${userData.username} 加入了游戏 (${gameState.players.size}/8)`);
    addSystemLog(`GAME: ${userData.username} joined the game`);
    
    broadcastGameState();
}

// 离开游戏
function handleLeaveGame(ws, userData) {
    if (gameState.isPlaying) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 游戏进行中，无法离开'
        }));
        return;
    }
    
    if (!gameState.players.has(ws)) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你不在游戏中'
        }));
        return;
    }
    
    gameState.players.delete(ws);
    
    if (gameState.hostId === userData.id && gameState.players.size > 0) {
        const firstPlayer = Array.from(gameState.players.entries())[0];
        if (firstPlayer) {
            const playerData = gameState.players.get(firstPlayer[0]);
            gameState.hostId = playerData.userId;
            sendGameMessage(`👑 房主转移给 ${playerData.username}`);
        }
    }
    
    sendGameMessage(`👤 ${userData.username} 离开了游戏 (${gameState.players.size}/8)`);
    addSystemLog(`GAME: ${userData.username} left the game`);
    
    broadcastGameState();
}

// 开始游戏
function handleStartGame(ws, userData) {
    if (gameState.isPlaying) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 游戏已经开始'
        }));
        return;
    }
    
    if (userData.id !== gameState.hostId) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有房主可以开始游戏'
        }));
        return;
    }
    
    if (gameState.players.size < 5) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 至少需要5名玩家才能开始游戏'
        }));
        return;
    }
    
    startGame();
}

// 开始游戏
function startGame() {
    if (gameState.players.size < 5 || gameState.players.size > 8) {
        sendGameMessage('❌ 游戏需要5-8名玩家');
        return;
    }

    addSystemLog(`GAME: Game started with ${gameState.players.size} players`);

    // 根据玩家数量分配角色
    const roles = [];
    const playerCount = gameState.players.size;
    
    // 基础角色（总是存在）
    roles.push('狼人', '狼人', '预言家', '女巫', '猎人');
    
    // 根据人数添加平民
    const civilianCount = playerCount - 5;
    for (let i = 0; i < civilianCount; i++) {
        roles.push('平民');
    }
    
    // 随机打乱角色
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    
    // 分配角色给玩家
    const players = Array.from(gameState.players.entries());
    players.forEach(([ws, player], index) => {
        player.role = roles[index];
        player.isAlive = true;
        player.hasVoted = false;
        player.hasActed = false;
        
        // 私聊发送角色信息
        ws.send(JSON.stringify({
            type: 'private',
            content: `🎭 你的角色是：${player.role}\n${ROLE_CONFIG[player.role].description}`
        }));
        
        addSystemLog(`GAME: ${player.username} assigned role: ${player.role}`);
    });
    
    // 告诉狼人他们的队友是谁
    const wolves = Array.from(gameState.players.entries())
        .filter(([ws, p]) => p.role === '狼人')
        .map(([ws, p]) => p.username);
    
    if (wolves.length > 0) {
        gameState.players.forEach((player, ws) => {
            if (player.role === '狼人') {
                ws.send(JSON.stringify({
                    type: 'private',
                    content: `🐺 你的狼队友是：${wolves.filter(name => name !== player.username).join(', ')}`
                }));
                ws.send(JSON.stringify({
                    type: 'private',
                    content: `💬 狼人之间可以使用 /wolf 消息 进行私聊`
                }));
            }
        });
    }
    
    gameState.isPlaying = true;
    gameState.gamePhase = 'night';
    gameState.dayCount = 1;
    gameState.nightActions.clear();
    gameState.votes.clear();
    gameState.killedTonight = null;
    gameState.savedTonight = null;
    gameState.poisonedTonight = null;
    gameState.checkedTonight = null;
    
    // 设置夜间阶段时间
    gameState.phaseEndTime = Date.now() + GAME_TIMES.NIGHT;
    startPhaseTimer();
    
    // 广播游戏开始
    broadcastGameState();
    sendGameMessage('🌙 天黑请闭眼，请各角色使用指令行动');
    sendGameMessage('💡 输入 /help 查看可用指令');
    
    // 私聊通知各角色可用指令
    gameState.players.forEach((player, ws) => {
        let instruction = '';
        switch(player.role) {
            case '狼人':
                instruction = '🐺 你可以使用 /kill @用户名 杀死一名玩家，或使用 /wolf 消息 和狼队友私聊';
                break;
            case '预言家':
                instruction = '🔮 你可以使用 /check @用户名 查验一名玩家的身份';
                break;
            case '女巫':
                instruction = '🧪 你可以使用 /save @用户名 救人，/poison @用户名 毒人，或 /skip 跳过';
                break;
        }
        if (instruction) {
            ws.send(JSON.stringify({
                type: 'private',
                content: instruction
            }));
        }
    });
    
    addSystemLog(`GAME: Game started`);
}

// 狼人杀人
function handleKill(ws, player, args) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法行动'
        }));
        return;
    }
    
    if (player.role !== '狼人') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有狼人可以杀人'
        }));
        return;
    }
    
    if (gameState.gamePhase !== 'night') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只能在夜晚杀人'
        }));
        return;
    }
    
    if (player.hasActed) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经行动过了'
        }));
        return;
    }
    
    const targetName = args.join(' ').replace('@', '');
    if (!targetName) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请指定要击杀的目标，例如: /kill @张三'
        }));
        return;
    }
    
    const target = findPlayerByUsername(targetName);
    if (!target) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ 找不到玩家: ${targetName}`
        }));
        return;
    }
    
    if (!target.player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ ${targetName} 已经死亡`
        }));
        return;
    }
    
    if (target.player.role === '狼人') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 不能杀死狼人队友'
        }));
        return;
    }
    
    handleNightAction(player.userId, 'kill', target.player.userId);
}

// 预言家查验
function handleCheck(ws, player, args) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法行动'
        }));
        return;
    }
    
    if (player.role !== '预言家') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有预言家可以查验'
        }));
        return;
    }
    
    if (gameState.gamePhase !== 'night') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只能在夜晚查验'
        }));
        return;
    }
    
    if (player.hasActed) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经行动过了'
        }));
        return;
    }
    
    const targetName = args.join(' ').replace('@', '');
    if (!targetName) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请指定要查验的目标，例如: /check @张三'
        }));
        return;
    }
    
    const target = findPlayerByUsername(targetName);
    if (!target) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ 找不到玩家: ${targetName}`
        }));
        return;
    }
    
    if (!target.player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ ${targetName} 已经死亡`
        }));
        return;
    }
    
    handleNightAction(player.userId, 'check', target.player.userId);
}

// 女巫救人
function handleSave(ws, player, args) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法行动'
        }));
        return;
    }
    
    if (player.role !== '女巫') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有女巫可以使用解药'
        }));
        return;
    }
    
    if (gameState.gamePhase !== 'night') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只能在夜晚使用解药'
        }));
        return;
    }
    
    if (player.hasActed) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经行动过了'
        }));
        return;
    }
    
    if (!gameState.killedTonight) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 今晚无人被杀，无法使用解药'
        }));
        return;
    }
    
    const targetName = args.join(' ').replace('@', '');
    if (!targetName) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请指定要救的人，例如: /save @张三'
        }));
        return;
    }
    
    const target = findPlayerByUsername(targetName);
    if (!target) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ 找不到玩家: ${targetName}`
        }));
        return;
    }
    
    if (target.player.userId !== gameState.killedTonight) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ ${targetName} 今晚没有被杀`
        }));
        return;
    }
    
    handleNightAction(player.userId, 'save', target.player.userId);
}

// 女巫毒人
function handlePoison(ws, player, args) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法行动'
        }));
        return;
    }
    
    if (player.role !== '女巫') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有女巫可以使用毒药'
        }));
        return;
    }
    
    if (gameState.gamePhase !== 'night') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只能在夜晚使用毒药'
        }));
        return;
    }
    
    if (player.hasActed) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经行动过了'
        }));
        return;
    }
    
    const targetName = args.join(' ').replace('@', '');
    if (!targetName) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请指定要毒死的人，例如: /poison @张三'
        }));
        return;
    }
    
    const target = findPlayerByUsername(targetName);
    if (!target) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ 找不到玩家: ${targetName}`
        }));
        return;
    }
    
    if (!target.player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ ${targetName} 已经死亡`
        }));
        return;
    }
    
    handleNightAction(player.userId, 'poison', target.player.userId);
}

// 女巫跳过
function handleSkip(ws, player) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法行动'
        }));
        return;
    }
    
    if (player.role !== '女巫') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有女巫可以跳过'
        }));
        return;
    }
    
    if (gameState.gamePhase !== 'night') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只能在夜晚跳过'
        }));
        return;
    }
    
    if (player.hasActed) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经行动过了'
        }));
        return;
    }
    
    handleNightAction(player.userId, 'skip', null);
}

// 猎人开枪
function handleShoot(ws, player, args) {
    if (!player || player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有死亡的猎人才能开枪'
        }));
        return;
    }
    
    if (player.role !== '猎人') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 只有猎人能开枪'
        }));
        return;
    }
    
    const targetName = args.join(' ').replace('@', '');
    if (!targetName) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请指定要开枪的目标，例如: /shoot @张三'
        }));
        return;
    }
    
    const target = findPlayerByUsername(targetName);
    if (!target) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ 找不到玩家: ${targetName}`
        }));
        return;
    }
    
    if (!target.player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ ${targetName} 已经死亡`
        }));
        return;
    }
    
    target.player.isAlive = false;
    sendGameMessage(`🏹 猎人 ${player.username} 开枪带走了 ${targetName}`);
    addSystemLog(`HUNTER: ${player.username} shot ${targetName}`);
    
    checkGameEnd();
    broadcastGameState();
}

// 投票
function handleVote(ws, player, args) {
    if (!player || !player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经死亡，无法投票'
        }));
        return;
    }
    
    if (gameState.gamePhase !== 'vote') {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 现在不是投票时间'
        }));
        return;
    }
    
    if (player.hasVoted) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 你已经投过票了'
        }));
        return;
    }
    
    const targetName = args.join(' ').replace('@', '');
    if (!targetName) {
        ws.send(JSON.stringify({
            type: 'system',
            content: '❌ 请指定要投票的目标，例如: /vote @张三'
        }));
        return;
    }
    
    const target = findPlayerByUsername(targetName);
    if (!target) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ 找不到玩家: ${targetName}`
        }));
        return;
    }
    
    if (!target.player.isAlive) {
        ws.send(JSON.stringify({
            type: 'system',
            content: `❌ ${targetName} 已经死亡`
        }));
        return;
    }
    
    gameState.votes.set(player.userId, target.player.userId);
    player.hasVoted = true;
    
    sendGameMessage(`🗳️ ${player.username} 投票给了 ${targetName}`);
    
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    const votedCount = Array.from(gameState.votes.keys()).length;
    
    if (votedCount >= alivePlayers.length) {
        processVotePhase();
    }
}

// 显示存活玩家
function showAlivePlayers(ws) {
    const alivePlayers = Array.from(gameState.players.values())
        .filter(p => p.isAlive)
        .map(p => p.username)
        .join(', ');
    
    ws.send(JSON.stringify({
        type: 'system',
        content: `👥 存活玩家: ${alivePlayers || '无'}`
    }));
}

// 显示剩余角色
function showRemainingRoles(ws) {
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    const roles = {};
    
    alivePlayers.forEach(p => {
        roles[p.role] = (roles[p.role] || 0) + 1;
    });
    
    const roleList = Object.entries(roles)
        .map(([role, count]) => `${role} x${count}`)
        .join(', ');
    
    ws.send(JSON.stringify({
        type: 'system',
        content: `📊 剩余角色: ${roleList}`
    }));
}

// 显示游戏帮助
function showGameHelp(ws) {
    const helpText = [
        '/join - 加入游戏',
        '/leave - 离开游戏',
        '/start - 开始游戏（房主）',
        '/players - 查看存活玩家',
        '/roles - 查看剩余角色',
        '/wolf 消息 - 狼人私聊（仅狼人可用）',
        '/kill @用户名 - 狼人杀人（仅夜晚）',
        '/check @用户名 - 预言家查验（仅夜晚）',
        '/save @用户名 - 女巫救人（仅夜晚）',
        '/poison @用户名 - 女巫毒人（仅夜晚）',
        '/skip - 女巫跳过（仅夜晚）',
        '/shoot @用户名 - 猎人开枪（死亡时）',
        '/vote @用户名 - 投票放逐（仅投票阶段）',
        '/help - 显示此帮助'
    ];
    
    ws.send(JSON.stringify({
        type: 'private',
        content: `📚 游戏指令:\n${helpText.join('\n')}`
    }));
}

// 处理夜间行动
function handleNightAction(userId, action, targetId) {
    const playerEntry = Array.from(gameState.players.entries()).find(
        ([ws, p]) => p.userId === userId
    );
    
    if (!playerEntry) return false;
    
    const [playerWs, player] = playerEntry;
    
    addSystemLog(`NIGHT: ${player.role} ${player.username} performed ${action} ${targetId ? 'on ' + targetId : ''}`);
    
    // 记录行动
    gameState.nightActions.set(userId, { action, targetId });
    player.hasActed = true;
    
    // 根据不同角色处理
    switch (player.role) {
        case '狼人':
            if (action === 'kill') {
                gameState.killedTonight = targetId;
                const targetPlayer = Array.from(gameState.players.values()).find(p => p.userId === targetId);
                
                // 通知其他狼人
                broadcastToWolves({
                    type: 'wolfAction',
                    content: `🐺 狼队友 ${player.username} 选择了击杀 ${targetPlayer?.username}`
                }, playerWs);
                
                addSystemLog(`WEREWOLF: ${player.username} chose to kill ${targetPlayer?.username}`);
            }
            break;
            
        case '预言家':
            if (action === 'check' && targetId) {
                gameState.checkedTonight = targetId;
                const targetPlayer = Array.from(gameState.players.values()).find(p => p.userId === targetId);
                const isWerewolf = targetPlayer.role === '狼人';
                playerWs.send(JSON.stringify({
                    type: 'seerResult',
                    target: targetPlayer.username,
                    isWerewolf: isWerewolf
                }));
                addSystemLog(`SEER: ${player.username} checked ${targetPlayer.username} - Result: ${isWerewolf ? 'Werewolf' : 'Not Werewolf'}`);
            }
            break;
            
        case '女巫':
            if (action === 'save' && targetId) {
                gameState.savedTonight = targetId;
                const targetPlayer = Array.from(gameState.players.values()).find(p => p.userId === targetId);
                addSystemLog(`WITCH: ${player.username} used SAVE potion on ${targetPlayer?.username}`);
            } else if (action === 'poison' && targetId) {
                gameState.poisonedTonight = targetId;
                const targetPlayer = Array.from(gameState.players.values()).find(p => p.userId === targetId);
                addSystemLog(`WITCH: ${player.username} used POISON potion on ${targetPlayer?.username}`);
            } else if (action === 'skip') {
                addSystemLog(`WITCH: ${player.username} chose to skip`);
            }
            break;
    }
    
    // 检查是否所有需要行动的玩家都已行动
    checkAllNightActions();
    
    return true;
}

// 检查夜间行动是否全部完成
function checkAllNightActions() {
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    
    const wolves = alivePlayers.filter(p => p.role === '狼人');
    const seer = alivePlayers.find(p => p.role === '预言家');
    const witch = alivePlayers.find(p => p.role === '女巫');
    
    let allActed = true;
    let actionsNeeded = [];
    
    // 检查狼人
    if (wolves.length > 0) {
        const wolfActions = Array.from(gameState.nightActions.entries())
            .filter(([id, action]) => {
                const player = Array.from(gameState.players.values()).find(p => p.userId === id);
                return player && player.role === '狼人';
            });
        
        if (wolfActions.length < wolves.length) {
            allActed = false;
            const remaining = wolves.length - wolfActions.length;
            actionsNeeded.push(`${remaining}个狼人`);
        } else {
            const lastWolfAction = wolfActions[wolfActions.length - 1];
            if (lastWolfAction) {
                gameState.killedTonight = lastWolfAction[1].targetId;
            }
        }
    }
    
    // 检查预言家
    if (seer) {
        const seerAction = Array.from(gameState.nightActions.entries())
            .find(([id]) => id === seer.userId);
        if (!seerAction) {
            allActed = false;
            actionsNeeded.push('预言家');
        }
    }
    
    // 检查女巫
    if (witch) {
        const witchAction = Array.from(gameState.nightActions.entries())
            .find(([id]) => id === witch.userId);
        if (!witchAction) {
            allActed = false;
            actionsNeeded.push('女巫');
        }
    }
    
    if (allActed) {
        addSystemLog(`NIGHT: All night actions completed, processing results...`);
        setTimeout(() => {
            processNightPhase();
        }, 2000);
    } else {
        // 不广播剩余时间，避免刷屏
    }
    
    return allActed;
}

// 处理夜间阶段结束
function processNightPhase() {
    try {
        addSystemLog(`NIGHT PHASE: Processing death results`);
        
        let deaths = [];
        let deathMessages = [];
        let savedByWitch = false;
        
        // 安全检查：确保游戏状态有效
        if (!gameState || !gameState.players) {
            addSystemLog(`ERROR: Invalid game state in night phase`);
            return;
        }
        
        // 处理女巫救人
        if (gameState.savedTonight && gameState.killedTonight === gameState.savedTonight) {
            gameState.killedTonight = null;
            savedByWitch = true;
            deathMessages.push('💊 女巫使用了解药，有人被救了');
            addSystemLog(`WITCH: Saved the victim`);
        }
        
        // 处理女巫毒人
        if (gameState.poisonedTonight) {
            const poisonedPlayer = Array.from(gameState.players.values())
                .find(p => p && p.userId === gameState.poisonedTonight);
            if (poisonedPlayer) {
                poisonedPlayer.isAlive = false;
                deaths.push(poisonedPlayer);
                deathMessages.push(`☠️ ${poisonedPlayer.username} 被女巫毒死了`);
                addSystemLog(`DEATH: ${poisonedPlayer.username} (${poisonedPlayer.role}) was poisoned by witch`);
            }
        }
        
        // 处理狼人杀人
        if (gameState.killedTonight) {
            const killedPlayer = Array.from(gameState.players.values())
                .find(p => p && p.userId === gameState.killedTonight);
            if (killedPlayer) {
                killedPlayer.isAlive = false;
                deaths.push(killedPlayer);
                deathMessages.push(`🔪 ${killedPlayer.username} 被狼人杀死了`);
                addSystemLog(`DEATH: ${killedPlayer.username} (${killedPlayer.role}) was killed by werewolves`);
            }
        }
        
        // 广播死亡信息
        if (deathMessages.length > 0) {
            deathMessages.forEach(msg => {
                if (msg) {
                    broadcastMessage({
                        type: 'gameEvent',
                        content: msg
                    });
                }
            });
        } else {
            broadcastMessage({
                type: 'gameEvent',
                content: '🌄 昨晚是平安夜，无人死亡'
            });
            addSystemLog(`NIGHT: Peaceful night, no one died`);
        }
        
        // 检查游戏是否结束
        const gameEnded = checkGameEnd();
        if (gameEnded) {
            addSystemLog(`GAME: Game ended after night phase`);
            return;
        }
        
        // 重置夜间行动记录
        gameState.nightActions.clear();
        gameState.killedTonight = null;
        gameState.savedTonight = null;
        gameState.poisonedTonight = null;
        gameState.checkedTonight = null;
        
        // 重置玩家行动状态（只处理仍然存在的玩家）
        if (gameState.players && gameState.players.size > 0) {
            gameState.players.forEach((player, ws) => {
                if (player) {
                    player.hasActed = false;
                    player.hasVoted = false;
                }
            });
        }
        
        // 进入白天阶段
        gameState.gamePhase = 'day';
        gameState.phaseEndTime = Date.now() + GAME_TIMES.DAY;
        startPhaseTimer();
        
        // 广播阶段变化
        broadcastMessage({
            type: 'phaseChange',
            phase: 'day',
            dayCount: gameState.dayCount
        });
        
        broadcastMessage({
            type: 'gameEvent',
            content: '☀️ 天亮了，大家开始讨论吧！'
        });
        
        addSystemLog(`PHASE: Day ${gameState.dayCount} started`);
        
        // 更新游戏状态
        if (gameState.players && gameState.players.size > 0) {
            broadcastGameState();
        }
        
    } catch (error) {
        addSystemLog(`ERROR in processNightPhase: ${error.message}`);
        console.error('Night phase error:', error);
        
        // 错误恢复：尝试重置游戏状态
        try {
            gameState.gamePhase = 'day';
            gameState.phaseEndTime = Date.now() + GAME_TIMES.DAY;
            startPhaseTimer();
            broadcastMessage({
                type: 'gameEvent',
                content: '⚠️ 游戏出现错误，已自动恢复'
            });
        } catch (e) {
            addSystemLog(`CRITICAL: Cannot recover from night phase error`);
        }
    }
}

// 处理投票阶段
function processVotePhase() {
    try {
        addSystemLog(`VOTE PHASE: Processing vote results`);
        
        // 安全检查
        if (!gameState || !gameState.players || gameState.players.size === 0) {
            addSystemLog(`ERROR: Invalid game state in vote phase`);
            return;
        }
        
        const voteCount = new Map();
        
        gameState.votes.forEach((targetId, voterId) => {
            if (targetId && voterId) {
                const count = voteCount.get(targetId) || 0;
                voteCount.set(targetId, count + 1);
            }
        });
        
        let maxVotes = 0;
        let eliminatedId = null;
        let tie = false;
        
        voteCount.forEach((count, userId) => {
            if (count > maxVotes) {
                maxVotes = count;
                eliminatedId = userId;
                tie = false;
            } else if (count === maxVotes) {
                tie = true;
                eliminatedId = null;
            }
        });
        
        if (eliminatedId && !tie) {
            const eliminated = Array.from(gameState.players.values())
                .find(p => p && p.userId === eliminatedId);
            if (eliminated) {
                eliminated.isAlive = false;
                broadcastMessage({
                    type: 'gameEvent',
                    content: `🗳️ ${eliminated.username} 被投票放逐 (${maxVotes}票)`
                });
                addSystemLog(`VOTE RESULT: ${eliminated.username} (${eliminated.role}) was eliminated by vote (${maxVotes} votes)`);
                
                // 猎人死亡可以开枪
                if (eliminated.role === '猎人') {
                    broadcastMessage({
                        type: 'gameEvent',
                        content: `🏹 猎人 ${eliminated.username} 死亡，可以使用 /shoot @用户名 开枪带走一人`
                    });
                }
            }
        } else {
            broadcastMessage({
                type: 'gameEvent',
                content: '🗳️ 平票，无人被放逐'
            });
            addSystemLog(`VOTE RESULT: Tie vote, no one eliminated`);
        }
        
        // 检查游戏是否结束
        const gameEnded = checkGameEnd();
        if (gameEnded) {
            addSystemLog(`GAME: Game ended after vote phase`);
            return;
        }
        
        // 重置投票记录
        gameState.votes.clear();
        
        // 重置玩家投票状态
        if (gameState.players && gameState.players.size > 0) {
            gameState.players.forEach((player, ws) => {
                if (player) {
                    player.hasVoted = false;
                }
            });
        }
        
        // 进入下一夜
        gameState.dayCount++;
        gameState.gamePhase = 'night';
        gameState.phaseEndTime = Date.now() + GAME_TIMES.NIGHT;
        startPhaseTimer();
        
        broadcastMessage({
            type: 'phaseChange',
            phase: 'night',
            dayCount: gameState.dayCount
        });
        
        broadcastMessage({
            type: 'gameEvent',
            content: '🌙 天黑请闭眼，第 ' + gameState.dayCount + ' 天夜晚'
        });
        
        addSystemLog(`PHASE: Night ${gameState.dayCount} started`);
        
        // 私聊通知各角色（只通知存活的玩家）
        if (gameState.players && gameState.players.size > 0) {
            gameState.players.forEach((player, ws) => {
                if (player && player.isAlive && ws && ws.readyState === WebSocket.OPEN) {
                    let instruction = '';
                    switch(player.role) {
                        case '狼人':
                            instruction = '🐺 你可以使用 /kill @用户名 杀死一名玩家，或使用 /wolf 消息 和狼队友私聊';
                            break;
                        case '预言家':
                            instruction = '🔮 你可以使用 /check @用户名 查验一名玩家的身份';
                            break;
                        case '女巫':
                            instruction = '🧪 你可以使用 /save @用户名 救人，/poison @用户名 毒人，或 /skip 跳过';
                            break;
                    }
                    if (instruction) {
                        try {
                            ws.send(JSON.stringify({
                                type: 'private',
                                content: instruction
                            }));
                        } catch (e) {
                            addSystemLog(`ERROR: Failed to send private message to ${player.username}`);
                        }
                    }
                }
            });
        }
        
        broadcastGameState();
        
    } catch (error) {
        addSystemLog(`ERROR in processVotePhase: ${error.message}`);
        console.error('Vote phase error:', error);
        
        // 错误恢复
        try {
            gameState.gamePhase = 'night';
            gameState.phaseEndTime = Date.now() + GAME_TIMES.NIGHT;
            startPhaseTimer();
            broadcastMessage({
                type: 'gameEvent',
                content: '⚠️ 投票阶段出现错误，已自动进入夜晚'
            });
        } catch (e) {
            addSystemLog(`CRITICAL: Cannot recover from vote phase error`);
        }
    }
}

// 检查游戏是否结束
function checkGameEnd() {
    try {
        if (!gameState || !gameState.players || gameState.players.size === 0) {
            return false;
        }
        
        const alivePlayers = Array.from(gameState.players.values()).filter(p => p && p.isAlive);
        
        if (alivePlayers.length === 0) {
            endGame('无人存活');
            return true;
        }
        
        const aliveWolves = alivePlayers.filter(p => p && p.role === '狼人').length;
        
        if (aliveWolves === 0) {
            endGame('好人阵营');
            return true;
        }
        
        if (aliveWolves >= alivePlayers.length - aliveWolves) {
            endGame('狼人阵营');
            return true;
        }
        
        return false;
        
    } catch (error) {
        addSystemLog(`ERROR in checkGameEnd: ${error.message}`);
        return false;
    }
}

// 结束游戏
function endGame(winner) {
    try {
        gameState.isPlaying = false;
        gameState.gamePhase = 'ended';
        
        if (gameState.phaseTimer) {
            clearInterval(gameState.phaseTimer);
            gameState.phaseTimer = null;
        }
        
        // 收集所有玩家信息
        const players = [];
        if (gameState.players && gameState.players.size > 0) {
            gameState.players.forEach((p, ws) => {
                if (p) {
                    players.push({
                        username: p.username,
                        role: p.role || '未知',
                        isAlive: p.isAlive || false
                    });
                }
            });
        }
        
        addSystemLog(`GAME OVER: ${winner} wins!`);
        
        broadcastMessage({
            type: 'gameEnd',
            winner: winner,
            players: players
        });
        
        broadcastMessage({
            type: 'gameEvent',
            content: `🎉 游戏结束，${winner}获胜！`
        });
        
        // 延迟一点再广播游戏状态，确保消息顺序
        setTimeout(() => {
            try {
                broadcastGameState();
            } catch (e) {
                addSystemLog(`ERROR: Failed to broadcast final game state`);
            }
        }, 1000);
        
    } catch (error) {
        addSystemLog(`ERROR in endGame: ${error.message}`);
        console.error('End game error:', error);
    }
}

// 开始阶段计时器
function startPhaseTimer() {
    try {
        if (gameState.phaseTimer) {
            clearInterval(gameState.phaseTimer);
            gameState.phaseTimer = null;
        }
        
        gameState.phaseTimer = setInterval(() => {
            try {
                const now = Date.now();
                const remaining = Math.max(0, Math.floor((gameState.phaseEndTime - now) / 1000));
                
                // 广播剩余时间（不显示在聊天，只用于计时器）
                broadcastMessage({
                    type: 'phaseTimer',
                    remaining: remaining,
                    phase: gameState.gamePhase
                });
                
                if (now >= gameState.phaseEndTime) {
                    // 清除当前定时器
                    if (gameState.phaseTimer) {
                        clearInterval(gameState.phaseTimer);
                        gameState.phaseTimer = null;
                    }
                    
                    if (gameState.gamePhase === 'night') {
                        addSystemLog(`PHASE: Night time expired`);
                        
                        // 标记所有未行动的角色为已行动
                        if (gameState.players && gameState.players.size > 0) {
                            gameState.players.forEach((player, ws) => {
                                if (player && player.isAlive && !player.hasActed && 
                                    (player.role === '狼人' || player.role === '预言家' || player.role === '女巫')) {
                                    player.hasActed = true;
                                }
                            });
                        }
                        
                        processNightPhase();
                        
                    } else if (gameState.gamePhase === 'day') {
                        addSystemLog(`PHASE: Day time expired`);
                        gameState.gamePhase = 'vote';
                        gameState.phaseEndTime = Date.now() + GAME_TIMES.VOTE;
                        startPhaseTimer();
                        
                        broadcastMessage({
                            type: 'phaseChange',
                            phase: 'vote',
                            dayCount: gameState.dayCount
                        });
                        
                        broadcastMessage({
                            type: 'gameEvent',
                            content: '🗳️ 讨论时间到，进入投票阶段'
                        });
                        
                        broadcastMessage({
                            type: 'gameEvent',
                            content: '💡 使用 /vote @用户名 进行投票'
                        });
                        
                        broadcastGameState();
                        addSystemLog(`PHASE: Vote started (Day ${gameState.dayCount})`);
                        
                    } else if (gameState.gamePhase === 'vote') {
                        addSystemLog(`PHASE: Vote time expired`);
                        
                        if (gameState.players && gameState.players.size > 0) {
                            const alivePlayers = Array.from(gameState.players.values()).filter(p => p && p.isAlive);
                            alivePlayers.forEach(player => {
                                if (player && !player.hasVoted) {
                                    player.hasVoted = true;
                                }
                            });
                        }
                        
                        processVotePhase();
                    }
                }
            } catch (timerError) {
                addSystemLog(`ERROR in timer interval: ${timerError.message}`);
                console.error('Timer interval error:', timerError);
            }
        }, 1000);
        
    } catch (error) {
        addSystemLog(`ERROR in startPhaseTimer: ${error.message}`);
        console.error('Timer error:', error);
    }
}

// ========== 管理员功能 ==========

// 禁言用户
function muteUser(targetUsername, reason = 'Admin action', adminWs = null) {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `User ${targetUsername} does not exist`
            }));
        }
        return false;
    }
    
    targetUser.isMuted = true;
    
    targetWs.send(JSON.stringify({
        type: 'system',
        content: `🔇 你已被管理员禁言，原因: ${reason}`
    }));
    
    broadcastMessage({
        type: 'system',
        content: `🔇 管理员将 ${targetUsername} 禁言，原因: ${reason}`
    });
    
    addSystemLog(`ADMIN: Muted user ${targetUsername} (${targetUser.ip}) - Reason: ${reason}`);
    broadcastUsers();
    
    return true;
}

// 取消禁言
function unmuteUser(targetUsername, adminWs = null) {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `User ${targetUsername} does not exist`
            }));
        }
        return false;
    }
    
    targetUser.isMuted = false;
    
    targetWs.send(JSON.stringify({
        type: 'system',
        content: `🔊 你已被管理员取消禁言`
    }));
    
    broadcastMessage({
        type: 'system',
        content: `🔊 管理员取消了 ${targetUsername} 的禁言`
    });
    
    addSystemLog(`ADMIN: Unmuted user ${targetUsername}`);
    broadcastUsers();
    
    return true;
}

// 封禁IP
function banIP(ip, reason = 'Admin action', adminWs = null) {
    if (bannedIPs.has(ip)) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `IP ${ip} is already banned`
            }));
        }
        return false;
    }
    
    bannedIPs.add(ip);
    
    users.forEach((user, ws) => {
        if (user.ip === ip) {
            ws.send(JSON.stringify({
                type: 'kicked',
                content: `你的IP已被封禁，原因: ${reason}`
            }));
            setTimeout(() => {
                ws.close();
            }, 1000);
            users.delete(ws);
        }
    });
    
    addSystemLog(`ADMIN: Banned IP ${ip} - Reason: ${reason}`);
    
    if (adminWs) {
        adminWs.send(JSON.stringify({
            type: 'adminSuccess',
            content: `IP ${ip} has been banned`
        }));
    }
    
    broadcastUsers();
    return true;
}

// 解封IP
function unbanIP(ip, adminWs = null) {
    if (!bannedIPs.has(ip)) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `IP ${ip} is not banned`
            }));
        }
        return false;
    }
    
    bannedIPs.delete(ip);
    addSystemLog(`ADMIN: Unbanned IP ${ip}`);
    
    if (adminWs) {
        adminWs.send(JSON.stringify({
            type: 'adminSuccess',
            content: `IP ${ip} has been unbanned`
        }));
    }
    
    return true;
}

// 封禁用户
function banUser(targetUsername, reason = 'Admin action', adminWs = null) {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `User ${targetUsername} does not exist`
            }));
        }
        return false;
    }
    
    return banIP(targetUser.ip, reason, adminWs);
}

// 撤回消息
function recallMessage(messageId, reason = 'Admin action', adminWs = null) {
    if (recalledMessages.has(messageId)) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `Message ${messageId} already recalled`
            }));
        }
        return false;
    }
    
    const messageIndex = messageHistory.findIndex(m => m.id === messageId);
    
    if (messageIndex === -1) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `Message ${messageId} not found`
            }));
        }
        return false;
    }
    
    const message = messageHistory[messageIndex];
    recalledMessages.add(messageId);
    messageHistory.splice(messageIndex, 1);
    
    broadcastMessage({
        type: 'messageRecalled',
        messageId: messageId,
        username: message.username,
        content: `⚠️ 管理员撤回了一条消息: ${reason}`
    });
    
    addSystemLog(`ADMIN: Recalled message from ${message.username} - ID: ${messageId} - Reason: ${reason}`);
    
    return true;
}

// 踢出用户
function kickUser(targetUsername, reason = 'Admin action', adminWs = null) {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        if (adminWs) {
            adminWs.send(JSON.stringify({
                type: 'adminError',
                content: `User ${targetUsername} does not exist`
            }));
        }
        return false;
    }
    
    targetWs.send(JSON.stringify({
        type: 'kicked',
        content: `你已被管理员踢出聊天室，原因: ${reason}`
    }));
    
    broadcastMessage({
        type: 'system',
        content: `👢 管理员将 ${targetUsername} 踢出聊天室，原因: ${reason}`
    });
    
    addSystemLog(`ADMIN: Kicked user ${targetUsername} (${targetUser.ip}) - Reason: ${reason}`);
    
    setTimeout(() => {
        targetWs.close();
    }, 1000);
    
    return true;
}

// 获取消息历史
function getMessageHistory(adminWs) {
    const messages = messageHistory.slice(-50).map(msg => ({
        id: msg.id,
        username: msg.username,
        content: msg.content,
        timestamp: msg.timestamp
    }));
    
    adminWs.send(JSON.stringify({
        type: 'adminHistory',
        messages: messages
    }));
}

// 获取系统日志
function getSystemLogs(adminWs) {
    adminWs.send(JSON.stringify({
        type: 'systemLogs',
        logs: systemLogs
    }));
}

// 获取被封禁的IP列表
function getBannedIPs(adminWs) {
    const ips = Array.from(bannedIPs);
    adminWs.send(JSON.stringify({
        type: 'bannedIPs',
        ips: ips
    }));
}

// 全局错误处理
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    addSystemLog(`CRITICAL: Uncaught exception - ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    addSystemLog(`CRITICAL: Unhandled rejection - ${reason}`);
});

// ========== WebSocket连接处理 ==========
wss.on('connection', (ws, req) => {
    const clientIp = getClientIp(req);
    
    if (bannedIPs.has(clientIp)) {
        ws.send(JSON.stringify({
            type: 'error',
            content: '你的IP已被封禁，无法连接'
        }));
        ws.close();
        return;
    }
    
    addSystemLog(`CONNECTION: New connection from ${clientIp}`);
    
    let userData = null;

    // 发送消息历史
    const filteredHistory = messageHistory.filter(msg => !recalledMessages.has(msg.id));
    ws.send(JSON.stringify({
        type: 'history',
        messages: filteredHistory
    }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'join':
                    // 检查是否是管理员登录
                    let username = message.username;
                    let isAdmin = false;
                    
                    if (username.includes(':')) {
                        const parts = username.split(':');
                        const inputUsername = parts[0];
                        const inputPassword = parts[1];
                        
                        if (inputPassword === ADMIN_PASSWORD) {
                            username = inputUsername;
                            isAdmin = true;
                            addSystemLog(`ADMIN LOGIN: ${username} from ${clientIp}`);
                        }
                    }
                    
                    const usernameExists = Array.from(users.values()).some(
                        u => u.username === username
                    );
                    
                    if (usernameExists) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            content: '用户名已存在，请换一个'
                        }));
                        return;
                    }
                    
                    userData = {
                        username: username,
                        color: getRandomColor(),
                        id: generateUserId(),
                        ip: clientIp,
                        isMuted: false,
                        isAdmin: isAdmin
                    };
                    
                    users.set(ws, userData);
                    
                    addSystemLog(`USER JOIN: ${username} (${userData.id}) from ${clientIp} ${isAdmin ? '[ADMIN]' : ''}`);
                    
                    broadcastMessage({
                        type: 'system',
                        content: `${username} 加入了聊天室`,
                        timestamp: new Date().toLocaleTimeString()
                    });
                    
                    broadcastUsers();
                    
                    ws.send(JSON.stringify({
                        type: 'welcome',
                        username: username,
                        color: userData.color,
                        userId: userData.id,
                        ip: clientIp,
                        isAdmin: isAdmin
                    }));
                    
                    // 发送游戏帮助
                    if (gameState.isPlaying) {
                        ws.send(JSON.stringify({
                            type: 'system',
                            content: '🎮 游戏进行中，输入 /help 查看游戏指令'
                        }));
                    }
                    break;
                    
                case 'message':
                    if (!userData) return;
                    
                    if (userData.isMuted) {
                        ws.send(JSON.stringify({
                            type: 'system',
                            content: '🔇 你已被禁言，无法发送消息'
                        }));
                        return;
                    }
                    
                    // 检查是否是游戏指令
                    if (message.content.startsWith('/')) {
                        const parsed = parseCommand(message.content);
                        if (parsed) {
                            handleGameCommand(ws, userData, parsed.cmd, parsed.args);
                            return;
                        }
                    }
                    
                    const messageId = generateUserId();
                    
                    addSystemLog(`MESSAGE: ${userData.username}: ${message.content.substring(0, 50)}`);
                    
                    const chatMessage = {
                        type: 'chat',
                        id: messageId,
                        username: userData.username,
                        content: message.content,
                        timestamp: new Date().toLocaleTimeString(),
                        color: userData.color,
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
                    
                    broadcastMessage({
                        type: 'typing',
                        username: userData.username,
                        isTyping: message.isTyping,
                        color: userData.color,
                        userId: userData.id
                    }, ws);
                    break;
                    
                case 'getGameState':
                    broadcastGameState();
                    break;
                    
                // 管理员操作
                case 'adminGetUsers':
                    if (!userData || !userData.isAdmin) return;
                    
                    const userList = Array.from(users.values()).map(u => ({
                        username: u.username,
                        id: u.id,
                        ip: u.ip,
                        isMuted: u.isMuted,
                        isAdmin: u.isAdmin
                    }));
                    
                    ws.send(JSON.stringify({
                        type: 'adminUsers',
                        users: userList
                    }));
                    break;
                    
                case 'adminGetHistory':
                    if (!userData || !userData.isAdmin) return;
                    getMessageHistory(ws);
                    break;
                    
                case 'adminGetLogs':
                    if (!userData || !userData.isAdmin) return;
                    getSystemLogs(ws);
                    break;
                    
                case 'adminGetBanned':
                    if (!userData || !userData.isAdmin) return;
                    getBannedIPs(ws);
                    break;
                    
                case 'adminMute':
                    if (!userData || !userData.isAdmin) return;
                    muteUser(message.username, message.reason || 'Admin action', ws);
                    break;
                    
                case 'adminUnmute':
                    if (!userData || !userData.isAdmin) return;
                    unmuteUser(message.username, ws);
                    break;
                    
                case 'adminBan':
                    if (!userData || !userData.isAdmin) return;
                    if (message.ip) {
                        banIP(message.ip, message.reason || 'Admin action', ws);
                    } else if (message.username) {
                        banUser(message.username, message.reason || 'Admin action', ws);
                    }
                    break;
                    
                case 'adminUnban':
                    if (!userData || !userData.isAdmin) return;
                    if (message.ip) {
                        unbanIP(message.ip, ws);
                    }
                    break;
                    
                case 'adminRecall':
                    if (!userData || !userData.isAdmin) return;
                    recallMessage(message.messageId, message.reason || 'Admin action', ws);
                    break;
                    
                case 'adminKick':
                    if (!userData || !userData.isAdmin) return;
                    kickUser(message.username, message.reason || 'Admin action', ws);
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (error) {
            console.error('Message processing error:', error);
        }
    });

    ws.on('close', () => {
        addSystemLog(`CONNECTION: Connection closed from ${clientIp}`);
        
        if (userData) {
            addSystemLog(`USER LEFT: ${userData.username} (userData.id)`);
            
            if (gameState.players.has(ws)) {
                gameState.players.delete(ws);
                
                if (gameState.hostId === userData.id && gameState.players.size > 0) {
                    const firstPlayer = Array.from(gameState.players.entries())[0];
                    if (firstPlayer) {
                        const playerData = gameState.players.get(firstPlayer[0]);
                        gameState.hostId = playerData.userId;
                        sendGameMessage(`👑 房主转移给 ${playerData.username}`);
                    }
                }
                
                broadcastGameState();
            }
            
            users.delete(ws);
            
            broadcastMessage({
                type: 'system',
                content: `${userData.username} 离开了聊天室`,
                timestamp: new Date().toLocaleTimeString()
            });
            
            broadcastUsers();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    addSystemLog(`SERVER: Started on port ${PORT}`);
    addSystemLog(`SERVER: Admin password: ${ADMIN_PASSWORD}`);
    addSystemLog(`SERVER: Waiting for connections...`);
    
    console.log(`✅ Server started on port ${PORT}`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`📝 Login format: username:${ADMIN_PASSWORD}`);
    console.log(`🌐 Open http://localhost:${PORT} in your browser`);
});