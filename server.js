const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 存储在线用户
const users = new Map(); // ws -> { username, color, id, ip, isMuted }
const messageHistory = [];
const recalledMessages = new Set(); // 存储已撤回的消息ID
const MAX_HISTORY = 100;

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
        description: '每晚可以杀死一名玩家',
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
        description: '有一瓶解药和一瓶毒药，每晚只能使用一瓶',
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
    NIGHT: 30000,     // 30秒
    DAY: 45000,       // 45秒  
    VOTE: 20000       // 20秒
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

// 日志函数 - 控制台输出使用英文
function logMessage(level, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${level}: ${message}`;
    if (data) {
        console.log(logEntry, data);
    } else {
        console.log(logEntry);
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

// 广播在线用户列表
function broadcastUsers() {
    const userList = Array.from(users.values()).map(user => ({
        username: user.username,
        color: user.color,
        id: user.id,
        online: true,
        isMuted: user.isMuted || false
    }));
    
    broadcastMessage({
        type: 'users',
        users: userList
    });
}

// 广播游戏状态（不包含角色信息）
function broadcastGameState() {
    const players = Array.from(gameState.players.entries()).map(([ws, player]) => ({
        username: player.username,
        userId: player.userId,
        isAlive: player.isAlive !== false,
        hasVoted: player.hasVoted || false,
        hasActed: player.hasActed || false
    }));
    
    broadcastMessage({
        type: 'gameState',
        isPlaying: gameState.isPlaying,
        players: players,
        hostId: gameState.hostId,
        playerCount: gameState.players.size,
        gamePhase: gameState.gamePhase,
        dayCount: gameState.dayCount
    });
}

// ========== 管理员功能 ==========

// 获取所有用户列表
function listUsers() {
    console.log('\n📋 Current online users:');
    console.log('='.repeat(80));
    console.log('ID'.padEnd(10) + 'Username'.padEnd(15) + 'IP'.padEnd(20) + 'Status'.padEnd(15) + 'Game Status');
    console.log('-'.repeat(80));
    
    users.forEach((user, ws) => {
        const isInGame = gameState.players.has(ws);
        const status = [];
        if (user.isMuted) status.push('🔇Muted');
        if (isInGame) status.push('🎮In Game');
        if (status.length === 0) status.push('✅Normal');
        
        const gameStatus = isInGame ? (gameState.players.get(ws).role || 'Not Assigned') : 'Not in Game';
        
        console.log(
            user.id.substring(0, 8).padEnd(10) + 
            user.username.padEnd(15) + 
            user.ip.padEnd(20) + 
            status.join(',').padEnd(15) + 
            gameStatus
        );
    });
    console.log('='.repeat(80) + '\n');
}

// 禁言用户
function muteUser(targetUsername, reason = '管理员操作') {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        console.log(`❌ User ${targetUsername} does not exist`);
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
    
    logMessage('👮 Admin Action', `Muted ${targetUsername}, reason: ${reason}`);
    broadcastUsers();
    
    return true;
}

// 取消禁言
function unmuteUser(targetUsername) {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        console.log(`❌ User ${targetUsername} does not exist`);
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
    
    logMessage('👮 Admin Action', `Unmuted ${targetUsername}`);
    broadcastUsers();
    
    return true;
}

// 撤回消息
function recallMessage(messageId, reason = '管理员操作') {
    if (recalledMessages.has(messageId)) {
        console.log(`❌ Message ${messageId} already recalled`);
        return false;
    }
    
    const messageIndex = messageHistory.findIndex(m => m.id === messageId);
    
    if (messageIndex === -1) {
        console.log(`❌ Message ${messageId} not found`);
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
    
    logMessage('👮 Admin Action', `Recalled message ${messageId} from ${message.username}, reason: ${reason}`);
    
    return true;
}

// 踢出用户
function kickUser(targetUsername, reason = '管理员操作') {
    let targetWs = null;
    let targetUser = null;
    
    users.forEach((user, ws) => {
        if (user.username === targetUsername) {
            targetWs = ws;
            targetUser = user;
        }
    });
    
    if (!targetWs) {
        console.log(`❌ User ${targetUsername} does not exist`);
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
    
    setTimeout(() => {
        targetWs.close();
    }, 1000);
    
    logMessage('👮 Admin Action', `Kicked ${targetUsername}, reason: ${reason}`);
    
    return true;
}

// 显示帮助信息
function showAdminHelp() {
    console.log('\n📚 Admin Commands:');
    console.log('='.repeat(80));
    console.log('list                       - Show all online users');
    console.log('mute <username> [reason]   - Mute a user');
    console.log('unmute <username>          - Unmute a user');
    console.log('recall <messageId> [reason] - Recall a message');
    console.log('kick <username> [reason]   - Kick a user');
    console.log('history                    - View recent 20 messages');
    console.log('help                       - Show this help');
    console.log('clear                      - Clear screen');
    console.log('exit                       - Exit program');
    console.log('='.repeat(80) + '\n');
}

// 清屏函数
function clearScreen() {
    console.clear();
    console.log(`\n${'='.repeat(80)}`);
    console.log(`✨ Werewolf Chat Room Server - Admin Console`);
    console.log(`📡 Listening on port: ${PORT}`);
    console.log(`👥 Online users: ${users.size}`);
    console.log(`🎮 Game in progress: ${gameState.isPlaying ? 'Yes' : 'No'}`);
    console.log(`${'='.repeat(80)}\n`);
}

// 设置终端命令处理
function setupConsoleCommands() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'admin> '
    });

    rl.prompt();

    rl.on('line', (line) => {
        const input = line.trim();
        const parts = input.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (command) {
            case 'list':
                listUsers();
                break;
                
            case 'mute':
                if (args.length < 1) {
                    console.log('❌ Usage: mute <username> [reason]');
                } else {
                    const username = args[0];
                    const reason = args.slice(1).join(' ') || '管理员操作';
                    muteUser(username, reason);
                }
                break;
                
            case 'unmute':
                if (args.length < 1) {
                    console.log('❌ Usage: unmute <username>');
                } else {
                    unmuteUser(args[0]);
                }
                break;
                
            case 'recall':
                if (args.length < 1) {
                    console.log('❌ Usage: recall <messageId> [reason]');
                } else {
                    const messageId = args[0];
                    const reason = args.slice(1).join(' ') || '管理员操作';
                    recallMessage(messageId, reason);
                }
                break;
                
            case 'kick':
                if (args.length < 1) {
                    console.log('❌ Usage: kick <username> [reason]');
                } else {
                    const username = args[0];
                    const reason = args.slice(1).join(' ') || '管理员操作';
                    kickUser(username, reason);
                }
                break;
                
            case 'history':
                console.log('\n📜 Recent messages:');
                console.log('='.repeat(80));
                if (messageHistory.length === 0) {
                    console.log('No messages');
                } else {
                    messageHistory.slice(-20).forEach(msg => {
                        console.log(`[${msg.timestamp}] ${msg.username.padEnd(10)} | ID: ${msg.id} | ${msg.content}`);
                    });
                }
                console.log('='.repeat(80) + '\n');
                break;
                
            case 'help':
                showAdminHelp();
                break;
                
            case 'clear':
                clearScreen();
                break;
                
            case 'exit':
                console.log('👋 Shutting down server...');
                process.exit(0);
                break;
                
            default:
                if (command) {
                    console.log(`❌ Unknown command: ${command}`);
                    showAdminHelp();
                }
        }

        rl.prompt();
    });

    rl.on('close', () => {
        console.log('👋 Admin console closed');
        process.exit(0);
    });
}

// ========== 游戏逻辑函数 ==========

// 开始游戏
function startGame() {
    if (gameState.players.size < 5 || gameState.players.size > 8) {
        return { success: false, message: '游戏需要5-8名玩家' };
    }

    logMessage('🎮 Game Event', 'Game started', { playerCount: gameState.players.size });

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
        
        logMessage('🎭 Role Assignment', `${player.username}(${player.userId}) is: ${player.role}`);
    });
    
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
    
    // 单独通知每个玩家他们的角色
    gameState.players.forEach((player, ws) => {
        ws.send(JSON.stringify({
            type: 'yourRole',
            role: player.role,
            emoji: ROLE_CONFIG[player.role]?.emoji || '🎮',
            description: ROLE_CONFIG[player.role]?.description || ''
        }));
    });
    
    broadcastMessage({
        type: 'gameEvent',
        content: '🌙 天黑请闭眼，请各角色执行技能...'
    });
    
    // 通知狼人行动
    notifyWolfAction();
    
    return { success: true };
}

// 通知狼人行动
function notifyWolfAction() {
    gameState.players.forEach((player, ws) => {
        if (player.role === '狼人' && player.isAlive) {
            const targets = Array.from(gameState.players.entries())
                .filter(([targetWs, targetPlayer]) => 
                    targetPlayer.isAlive && targetPlayer.role !== '狼人'
                )
                .map(([targetWs, targetPlayer]) => ({
                    userId: targetPlayer.userId,
                    username: targetPlayer.username
                }));
            
            ws.send(JSON.stringify({
                type: 'nightActionRequest',
                action: 'kill',
                message: '请选择要击杀的目标',
                targets: targets
            }));
        }
    });
}

// 处理夜间行动
function handleNightAction(userId, action, targetId) {
    const playerEntry = Array.from(gameState.players.entries()).find(
        ([ws, p]) => p.userId === userId
    );
    
    if (!playerEntry) return false;
    
    const [playerWs, player] = playerEntry;
    
    if (!player.isAlive) {
        playerWs.send(JSON.stringify({
            type: 'gameError',
            content: '你已经死亡，无法行动'
        }));
        return false;
    }
    
    const targetPlayer = targetId ? 
        Array.from(gameState.players.values()).find(p => p.userId === targetId) : null;
    
    logMessage('🌙 Night Action', `${player.role} ${player.username} performed ${action} ${targetPlayer ? 'target: ' + targetPlayer.username : ''}`);
    
    gameState.nightActions.set(userId, { action, targetId });
    player.hasActed = true;
    
    playerWs.send(JSON.stringify({
        type: 'actionConfirm',
        content: '✅ 行动已记录'
    }));
    
    switch (player.role) {
        case '狼人':
            if (action === 'kill') {
                gameState.killedTonight = targetId;
                
                gameState.players.forEach((p, ws) => {
                    if (p.role === '狼人' && p.userId !== userId && p.isAlive) {
                        ws.send(JSON.stringify({
                            type: 'wolfAction',
                            content: `狼队友选择了击杀 ${targetPlayer?.username}`
                        }));
                    }
                });
            }
            break;
            
        case '预言家':
            if (action === 'check' && targetPlayer) {
                gameState.checkedTonight = targetId;
                const isWerewolf = targetPlayer.role === '狼人';
                playerWs.send(JSON.stringify({
                    type: 'seerResult',
                    target: targetPlayer.username,
                    isWerewolf: isWerewolf
                }));
            }
            break;
            
        case '女巫':
            if (action === 'save') {
                gameState.savedTonight = targetId;
            } else if (action === 'poison') {
                gameState.poisonedTonight = targetId;
            }
            break;
    }
    
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
    
    if (wolves.length > 0) {
        const wolfActions = Array.from(gameState.nightActions.entries())
            .filter(([id, action]) => {
                const player = Array.from(gameState.players.values()).find(p => p.userId === id);
                return player && player.role === '狼人';
            });
        
        if (wolfActions.length < wolves.length) {
            allActed = false;
        } else {
            const lastWolfAction = wolfActions[wolfActions.length - 1];
            if (lastWolfAction) {
                gameState.killedTonight = lastWolfAction[1].targetId;
            }
        }
    }
    
    if (seer) {
        const seerAction = Array.from(gameState.nightActions.entries())
            .find(([id]) => id === seer.userId);
        if (!seerAction) allActed = false;
    }
    
    if (witch) {
        const witchAction = Array.from(gameState.nightActions.entries())
            .find(([id]) => id === witch.userId);
        if (!witchAction) allActed = false;
    }
    
    if (allActed) {
        setTimeout(() => {
            processNightPhase();
        }, 2000);
    }
    
    return allActed;
}

// 处理夜间阶段结束
function processNightPhase() {
    console.log('\n' + '='.repeat(50));
    logMessage('🌙 Night Phase', 'Processing death results');
    
    let deaths = [];
    let deathMessages = [];
    
    // 处理女巫救人
    if (gameState.savedTonight && gameState.killedTonight === gameState.savedTonight) {
        gameState.killedTonight = null;
        deathMessages.push('💊 女巫使用了解药，有人被救了');
    }
    
    // 处理女巫毒人
    if (gameState.poisonedTonight) {
        const poisonedPlayer = Array.from(gameState.players.values())
            .find(p => p.userId === gameState.poisonedTonight);
        if (poisonedPlayer) {
            poisonedPlayer.isAlive = false;
            deaths.push(poisonedPlayer);
            deathMessages.push(`☠️ ${poisonedPlayer.username} 被女巫毒死了`);
        }
    }
    
    // 处理狼人杀人
    if (gameState.killedTonight) {
        const killedPlayer = Array.from(gameState.players.values())
            .find(p => p.userId === gameState.killedTonight);
        if (killedPlayer) {
            killedPlayer.isAlive = false;
            deaths.push(killedPlayer);
            deathMessages.push(`🔪 ${killedPlayer.username} 被狼人杀死了`);
        }
    }
    
    if (deathMessages.length > 0) {
        deathMessages.forEach(msg => {
            broadcastMessage({
                type: 'gameEvent',
                content: msg
            });
        });
    } else {
        broadcastMessage({
            type: 'gameEvent',
            content: '🌄 昨晚是平安夜，无人死亡'
        });
    }
    
    const gameEnded = checkGameEnd();
    if (gameEnded) return;
    
    gameState.nightActions.clear();
    gameState.killedTonight = null;
    gameState.savedTonight = null;
    gameState.poisonedTonight = null;
    gameState.checkedTonight = null;
    
    gameState.players.forEach(player => {
        player.hasActed = false;
        player.hasVoted = false;
    });
    
    gameState.gamePhase = 'day';
    gameState.phaseEndTime = Date.now() + GAME_TIMES.DAY;
    startPhaseTimer();
    
    broadcastMessage({
        type: 'phaseChange',
        phase: 'day',
        dayCount: gameState.dayCount
    });
    
    broadcastMessage({
        type: 'gameEvent',
        content: '☀️ 天亮了，大家开始讨论吧！'
    });
    
    broadcastGameState();
}

// 处理投票
function handleVote(voterId, targetId) {
    gameState.votes.set(voterId, targetId);
    
    const voter = Array.from(gameState.players.values()).find(p => p.userId === voterId);
    const target = Array.from(gameState.players.values()).find(p => p.userId === targetId);
    
    if (voter && target) {
        logMessage('🗳️ Vote', `${voter.username} voted for ${target.username}`);
        voter.hasVoted = true;
    }
    
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    const votedCount = Array.from(gameState.votes.keys()).length;
    
    if (votedCount >= alivePlayers.length) {
        processVotePhase();
    }
}

// 处理投票阶段
function processVotePhase() {
    const voteCount = new Map();
    
    gameState.votes.forEach((targetId, voterId) => {
        const count = voteCount.get(targetId) || 0;
        voteCount.set(targetId, count + 1);
    });
    
    let maxVotes = 0;
    let eliminatedId = null;
    
    voteCount.forEach((count, userId) => {
        if (count > maxVotes) {
            maxVotes = count;
            eliminatedId = userId;
        } else if (count === maxVotes) {
            eliminatedId = null;
        }
    });
    
    if (eliminatedId) {
        const eliminated = Array.from(gameState.players.values()).find(p => p.userId === eliminatedId);
        if (eliminated) {
            eliminated.isAlive = false;
            broadcastMessage({
                type: 'gameEvent',
                content: `🗳️ ${eliminated.username} 被投票放逐`
            });
            
            if (eliminated.role === '猎人') {
                broadcastMessage({
                    type: 'gameEvent',
                    content: `🏹 猎人 ${eliminated.username} 可以开枪带走一人`
                });
            }
        }
    } else {
        broadcastMessage({
            type: 'gameEvent',
            content: '🗳️ 平票，无人被放逐'
        });
    }
    
    const gameEnded = checkGameEnd();
    if (gameEnded) return;
    
    gameState.votes.clear();
    gameState.players.forEach(player => {
        player.hasVoted = false;
    });
    
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
        content: '🌙 天黑请闭眼，请各角色执行技能...'
    });
    
    notifyWolfAction();
    
    broadcastGameState();
}

// 检查游戏是否结束
function checkGameEnd() {
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    const aliveWolves = alivePlayers.filter(p => p.role === '狼人').length;
    
    if (aliveWolves === 0) {
        endGame('好人阵营');
        return true;
    }
    
    if (aliveWolves >= alivePlayers.length - aliveWolves) {
        endGame('狼人阵营');
        return true;
    }
    
    return false;
}

// 结束游戏
function endGame(winner) {
    gameState.isPlaying = false;
    gameState.gamePhase = 'ended';
    
    if (gameState.phaseTimer) {
        clearInterval(gameState.phaseTimer);
        gameState.phaseTimer = null;
    }
    
    const players = Array.from(gameState.players.values()).map(p => ({
        username: p.username,
        role: p.role,
        isAlive: p.isAlive,
        emoji: ROLE_CONFIG[p.role]?.emoji || '🎮'
    }));
    
    logMessage('🏆 Game Over', `${winner} wins!`);
    console.log('📊 Final roles:');
    players.forEach(p => {
        const status = p.isAlive ? '😊 Alive' : '💀 Dead';
        console.log(`   ${p.emoji} ${p.username}: ${p.role} ${status}`);
    });
    
    broadcastMessage({
        type: 'gameEnd',
        winner: winner,
        players: players
    });
    
    broadcastMessage({
        type: 'gameEvent',
        content: `🎉 游戏结束，${winner}获胜！`
    });
    
    broadcastGameState();
}

// 开始阶段计时器
function startPhaseTimer() {
    if (gameState.phaseTimer) {
        clearInterval(gameState.phaseTimer);
    }
    
    gameState.phaseTimer = setInterval(() => {
        const now = Date.now();
        if (now >= gameState.phaseEndTime) {
            clearInterval(gameState.phaseTimer);
            
            if (gameState.gamePhase === 'night') {
                processNightPhase();
            } else if (gameState.gamePhase === 'day') {
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
                    content: '🗳️ 投票时间到，请选择要放逐的玩家'
                });
                
                broadcastGameState();
            } else if (gameState.gamePhase === 'vote') {
                processVotePhase();
            }
        }
        
        const remaining = Math.max(0, Math.floor((gameState.phaseEndTime - now) / 1000));
        broadcastMessage({
            type: 'phaseTimer',
            remaining: remaining,
            phase: gameState.gamePhase
        });
    }, 1000);
}

// ========== WebSocket连接处理 ==========
wss.on('connection', (ws, req) => {
    const clientIp = getClientIp(req);
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔌 New WebSocket connection from: ${clientIp}`);
    
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
                    
                    userData = {
                        username: message.username,
                        color: getRandomColor(),
                        id: generateUserId(),
                        ip: clientIp,
                        isMuted: false
                    };
                    
                    users.set(ws, userData);
                    
                    logMessage('👋 User Joined', `${message.username} (${userData.id}) from ${clientIp}`);
                    
                    broadcastMessage({
                        type: 'system',
                        content: `${message.username} 加入了聊天室`,
                        timestamp: new Date().toLocaleTimeString()
                    });
                    
                    broadcastUsers();
                    
                    ws.send(JSON.stringify({
                        type: 'welcome',
                        username: message.username,
                        color: userData.color,
                        userId: userData.id
                    }));
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
                    
                    const messageId = generateUserId();
                    
                    logMessage('💬 Message', `[${userData.username}](${userData.id}) from ${clientIp} | ID: ${messageId} | Content: ${message.content.substring(0, 50)}`);
                    
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
                    
                case 'joinGame':
                    if (!userData) return;
                    
                    if (gameState.isPlaying) {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            content: '游戏已经开始，无法加入'
                        }));
                        return;
                    }
                    
                    const alreadyInGame = Array.from(gameState.players.values()).some(
                        p => p.userId === userData.id
                    );
                    
                    if (!alreadyInGame) {
                        gameState.players.set(ws, {
                            username: userData.username,
                            userId: userData.id,
                            role: null,
                            isAlive: true,
                            hasVoted: false,
                            hasActed: false,
                            ip: clientIp
                        });
                        
                        if (gameState.players.size === 1) {
                            gameState.hostId = userData.id;
                        }
                        
                        logMessage('🎮 Joined Game', `${userData.username} joined the game, players: ${gameState.players.size}`);
                        
                        broadcastMessage({
                            type: 'gameJoin',
                            username: userData.username,
                            userId: userData.id,
                            playerCount: gameState.players.size
                        });
                        
                        broadcastGameState();
                    }
                    break;
                    
                case 'leaveGame':
                    if (!userData) return;
                    
                    if (!gameState.isPlaying) {
                        gameState.players.delete(ws);
                        
                        logMessage('🎮 Left Game', `${userData.username} left the game, remaining: ${gameState.players.size}`);
                        
                        if (gameState.hostId === userData.id && gameState.players.size > 0) {
                            const firstPlayer = Array.from(gameState.players.entries())[0];
                            if (firstPlayer) {
                                const playerData = gameState.players.get(firstPlayer[0]);
                                gameState.hostId = playerData.userId;
                                logMessage('👑 Host Transfer', `New host: ${playerData.username}`);
                            }
                        }
                        
                        broadcastMessage({
                            type: 'gameLeave',
                            username: userData.username,
                            userId: userData.id,
                            playerCount: gameState.players.size
                        });
                        
                        broadcastGameState();
                    }
                    break;
                    
                case 'startGame':
                    if (!userData) return;
                    
                    if (userData.id !== gameState.hostId) {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            content: '只有房主可以开始游戏'
                        }));
                        return;
                    }
                    
                    const result = startGame();
                    if (!result.success) {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            content: result.message
                        }));
                    }
                    break;
                    
                case 'nightAction':
                    if (!userData || !gameState.isPlaying || gameState.gamePhase !== 'night') {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            content: '现在不是行动时间'
                        }));
                        return;
                    }
                    
                    handleNightAction(userData.id, message.action, message.targetId);
                    break;
                    
                case 'vote':
                    if (!userData || !gameState.isPlaying || gameState.gamePhase !== 'vote') {
                        ws.send(JSON.stringify({
                            type: 'gameError',
                            content: '现在不是投票时间'
                        }));
                        return;
                    }
                    
                    handleVote(userData.id, message.targetId);
                    
                    ws.send(JSON.stringify({
                        type: 'voteConfirm',
                        content: '🗳️ 投票已记录'
                    }));
                    break;
                    
                case 'getGameState':
                    const players = Array.from(gameState.players.values()).map(p => ({
                        username: p.username,
                        userId: p.userId,
                        isAlive: p.isAlive !== false
                    }));
                    
                    ws.send(JSON.stringify({
                        type: 'gameState',
                        isPlaying: gameState.isPlaying,
                        players: players,
                        hostId: gameState.hostId,
                        playerCount: gameState.players.size,
                        gamePhase: gameState.gamePhase,
                        dayCount: gameState.dayCount
                    }));
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
        console.log(`\n[${new Date().toLocaleTimeString()}] 🔌 WebSocket connection closed from: ${clientIp}`);
        
        if (userData) {
            logMessage('👋 User Left', `${userData.username} (${userData.id})`);
            
            if (gameState.players.has(ws)) {
                gameState.players.delete(ws);
                
                if (gameState.hostId === userData.id && gameState.players.size > 0) {
                    const firstPlayer = Array.from(gameState.players.entries())[0];
                    if (firstPlayer) {
                        const playerData = gameState.players.get(firstPlayer[0]);
                        gameState.hostId = playerData.userId;
                        logMessage('👑 Host Transfer', `New host: ${playerData.username}`);
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
    clearScreen();
    showAdminHelp();
    setupConsoleCommands();
});